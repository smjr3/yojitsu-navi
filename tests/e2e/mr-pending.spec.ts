/**
 * マージ待ちの変更が溜まっても編集の邪魔にならない（SPEC §126）
 * - 3 件以上は畳んで見出しの 1 段だけ。対応が必要なもの（競合あり・検証の失敗）は畳んでも出す
 * - 並びは 対応が必要 → 自分の分 → その他
 * - 開閉はこのブラウザに覚える
 * - 広い画面では 1 件を見出しとボタンの 1 段に並べる。390px・ダークでもはみ出さない
 * - 競合ありの MR の「マージ」: 本体の今の内容に載せ直して新しい MR を作り、そのままマージする（§126.2）。
 *   同じ行の重なりがあれば、どちらを残すか選んでから載せ直してマージする
 * - 編集画面: マージ待ちの変更がある対象（台帳の対象・リソース計画の人）に「マージ待ち」の印（§126.3）
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";

const BASE = buildMastersPayload(ROOT_DIR).files.rates.text;
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");

const GITLAB = "https://gitlab.test/api/v4";
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "content-type": "application/json" };
const CFG = { mode: "gitlab", gitlab: { apiBaseUrl: GITLAB, projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } };

interface Mr {
  iid: number;
  title: string;
  author: string;
  conflict?: boolean;
  failed?: boolean;
}
const PEOPLE: Record<string, string> = { sato: "佐藤", suzuki: "鈴木", tanaka: "田中" };

/** 新しい順（GitLab の並び）で n 件。11 番は競合あり（他の人）、9 番は検証の失敗（自分）、自分の分は 12・9・7 */
function makeMrs(n: number): Mr[] {
  const all: Mr[] = [
    { iid: 12, title: "マスタ更新: data/assignments.csv", author: "sato" },
    { iid: 11, title: "マスタ更新: data/assignments.csv", author: "suzuki", conflict: true },
    { iid: 10, title: "マスタ更新: data/masters/members.csv", author: "tanaka" },
    { iid: 9, title: "マスタ更新: data/masters/rates.csv", author: "sato", failed: true },
    { iid: 8, title: "マスタ更新: data/assignments.csv", author: "tanaka" },
    { iid: 7, title: "マスタ更新: data/targets.csv", author: "sato" },
  ];
  return all.slice(0, n);
}

async function open(page: Page, mrs: Mr[]): Promise<void> {
  await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
    try {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit: CFG, headCommit: null }), headers: { ...res.headers(), "content-type": "application/json" } });
    } catch (e) {
      if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  });
  await page.route(`${GITLAB}/**`, async (route: Route) => {
    const req = route.request();
    if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
    const url = req.url();
    const json = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
    const summary = (m: Mr) => ({ iid: m.iid, title: m.title, source_branch: `masters/20261116-${m.iid}-${m.author}`, target_branch: "main", state: "opened", author: { username: m.author, name: PEOPLE[m.author] }, created_at: `2026-11-${String(m.iid).padStart(2, "0")}T01:00:00Z` });
    if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
    if (url.includes("/merge_requests?")) return json(200, mrs.map(summary));
    if (url.includes("/diffs?")) return json(200, []);
    const hit = /\/merge_requests\/(\d+)$/.exec(url);
    const m = hit ? mrs.find((x) => x.iid === Number(hit[1])) : null;
    if (m) return json(200, { ...summary(m), user: { can_merge: true }, diff_refs: { base_sha: "b0", head_sha: `h${m.iid}` }, head_pipeline: { status: m.failed ? "failed" : "success" }, has_conflicts: !!m.conflict, detailed_merge_status: m.conflict ? "conflict" : "mergeable" });
    return json(404, { message: "404" });
  });
  await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
  await gotoPage(page, "/masters");
  await settled(page);
}

/** 一覧と各 MR の内容を読み終わるまで待つ（読み終わると描き直す） */
const settled = (page: Page) => expect(page.locator('.yn-mr[aria-busy="false"]')).toHaveCount(1);

const panel = (page: Page) => page.locator(".yn-mr");
const items = (page: Page) => page.locator(".yn-mr-item");

test.describe("申請中の一覧を畳む", () => {
  test("3 件以上は畳み、対応が必要なものだけ出す。開くと 対応が必要 → 自分の分 → その他 の順。開閉は覚える", async ({ page }) => {
    await open(page, makeMrs(6));
    await expect(panel(page)).toContainText("6 件");
    await expect(panel(page).locator(".yn-mr-tally")).toContainText("対応が必要 2 件");
    await expect(panel(page).locator(".yn-mr-tally")).toContainText("自分の分 3 件");
    const toggle = page.getByRole("button", { name: "一覧を見る（6 件）" });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    // 畳んでいても、競合あり（11）と検証の失敗（9）は出す
    await expect(items(page)).toHaveCount(2);
    await expect(items(page).nth(0)).toContainText("番号 11");
    await expect(items(page).nth(0)).toContainText("競合あり");
    await expect(items(page).nth(1)).toContainText("番号 9");

    await toggle.click();
    await expect(page.getByRole("button", { name: "一覧を閉じる" })).toBeFocused();
    await expect(items(page)).toHaveCount(6);
    const order = await items(page).evaluateAll((els) => els.map((e) => Number(e.getAttribute("data-iid"))));
    expect(order).toEqual([11, 9, 12, 7, 10, 8]);

    // 開いたままを覚える
    await page.reload();
    await expect(items(page)).toHaveCount(6);
    await page.getByRole("button", { name: "一覧を閉じる" }).click();
    await page.reload();
    await expect(page.getByRole("button", { name: "一覧を見る（6 件）" })).toBeVisible();
    await expect(items(page)).toHaveCount(2);
  });

  test("2 件までは最初から開いて出す", async ({ page }) => {
    await open(page, makeMrs(6).filter((m) => !m.conflict && !m.failed).slice(0, 2));
    await expect(items(page)).toHaveCount(2);
    await expect(page.getByRole("button", { name: "一覧を閉じる" })).toHaveAttribute("aria-expanded", "true");
    await expect(panel(page).locator(".yn-mr-tally")).not.toContainText("対応が必要");
  });

  test("畳んで対応が必要なものも無ければ見出しの 1 段だけ", async ({ page }) => {
    await open(page, makeMrs(6).map((m) => ({ ...m, conflict: false, failed: false })));
    await expect(page.getByRole("button", { name: "一覧を見る（6 件）" })).toBeVisible();
    await expect(items(page)).toHaveCount(0);
    const box = await panel(page).boundingBox();
    expect(box!.height).toBeLessThan(80);
  });

  test("1280px: 1 件は見出しとボタンの 1 段（高さを抑える）", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await open(page, makeMrs(6));
    const item = items(page).first();
    const head = await item.locator(".yn-mr-head").boundingBox();
    const actions = await item.locator(".yn-mr-actions").boundingBox();
    expect(actions!.x).toBeGreaterThan(head!.x + head!.width - 1);
    expect(Math.abs(actions!.y + actions!.height / 2 - (head!.y + head!.height / 2))).toBeLessThan(head!.height);
  });

  for (const [w, dark] of [[390, false], [390, true], [768, true], [1024, false]] as const) {
    test(`${w}px${dark ? " ダーク" : ""}: 開いても畳んでも横にはみ出さない`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      await page.setViewportSize({ width: w, height: 800 });
      await open(page, makeMrs(6));
      for (const step of ["folded", "open"]) {
        if (step === "open") await page.getByRole("button", { name: "一覧を見る（6 件）" }).click();
        await expect(items(page)).toHaveCount(step === "open" ? 6 : 2);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, step).toBeLessThanOrEqual(0);
        const p = await panel(page).boundingBox();
        expect(p!.x + p!.width).toBeLessThanOrEqual(w);
      }
    });
  }
});

test.describe("競合ありの MR を承認すると載せ直して承認する（§126.2）", () => {
  /** MR 8（鈴木さん・競合あり）: 部長 12000→12500 と 課長の行を足す。main = latest。載せ直した MR 9 は mergeable */
  async function openConflict(page: Page, latest: string, mr9: Record<string, unknown> = { detailed_merge_status: "mergeable", head_pipeline: { status: "success" } }) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let done = false;
    await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
      try {
        const res = await route.fetch();
        const json = await res.json();
        await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit: CFG, headCommit: null }), headers: { ...res.headers(), "content-type": "application/json" } });
      } catch (e) {
        if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    });
    await page.route(`${GITLAB}/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      const body = req.postData() ? JSON.parse(req.postData()!) : undefined;
      calls.push({ method: req.method(), url, body });
      const json = (status: number, b: unknown) => route.fulfill({ status, headers: CORS, body: JSON.stringify(b) });
      const mr = { iid: 8, title: "マスタ更新: data/masters/rates.csv", description: "", source_branch: "masters/20261110-1-suzuki", target_branch: "main", state: "opened", author: { username: "suzuki", name: "鈴木" }, created_at: "2026-11-10T01:00:00Z" };
      if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
      if (url.includes("/merge_requests?")) return json(200, done ? [] : [mr]);
      if (url.includes("/diffs?")) return json(200, [{ new_path: "data/masters/rates.csv", old_path: "data/masters/rates.csv" }]);
      if (url.endsWith("/merge_requests/8") && req.method() === "GET") return json(200, { ...mr, user: { can_merge: true }, diff_refs: { base_sha: "b0", head_sha: "h1" }, has_conflicts: true, detailed_merge_status: "conflict" });
      if (url.endsWith("/merge_requests/8") && req.method() === "PUT") return json(200, { ...mr, state: "closed" });
      if (url.endsWith("/merge_requests/8/merge")) return json(406, { message: "Branch cannot be merged" });
      if (url.endsWith("/repository/commits")) return json(201, { id: "c2" });
      if (url.endsWith("/merge_requests") && req.method() === "POST") return json(201, { iid: 9, web_url: "https://gitlab.test/grp/yn/-/merge_requests/9" });
      if (url.endsWith("/merge_requests/9") && req.method() === "GET") return json(200, { ...mr, iid: 9, user: { can_merge: true }, diff_refs: { base_sha: "L9", head_sha: "h9" }, has_conflicts: false, ...mr9 });
      if (url.endsWith("/merge_requests/9/merge")) {
        done = true;
        return json(200, {});
      }
      if (url.includes("/raw?ref=")) {
        const ref = new URL(url).searchParams.get("ref");
        const text = url.includes("rates.csv") ? (ref === "h1" ? BASE.replace("部長,12000,2025-04", "部長,12500,2025-04") + "課長,11000,2026-11\n" : BASE) : "same\n";
        return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/plain" }, body: text });
      }
      if (/\/repository\/files\/[^/]+\?ref=main$/.test(url)) {
        if (url.includes("rates.csv")) return json(200, { encoding: "base64", content: b64(latest), last_commit_id: "L9" });
        return json(200, { encoding: "base64", content: b64("same\n"), last_commit_id: "L0" });
      }
      return json(404, { message: "404" });
    });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters");
    await expect(items(page)).toContainText("競合あり");
    await items(page).getByRole("button", { name: "マスタ更新: 単価（番号 8）を承認" }).click();
    const confirm = page.locator("dialog[open]");
    await expect(confirm).toContainText("他の変更と重なっているため、本体の今の内容に載せ直してから");
    await confirm.getByRole("button", { name: "承認する" }).click();
    return calls;
  }

  test("別の行どうしなら、確認 1 回で載せ直してそのまま承認する（元の MR は取り下げ）", async ({ page }) => {
    const calls = await openConflict(page, BASE + "主任,9500,2026-11\n");
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("最新に載せ直して承認しました");
    const content = (calls.find((c) => c.url.endsWith("/repository/commits"))!.body as { actions: Array<{ content: string }> }).actions[0]!.content;
    expect(content).toContain("部長,12500,2025-04");
    expect(content).toContain("主任,9500,2026-11");
    expect(calls.some((c) => c.method === "PUT" && c.url.endsWith("/merge_requests/8") && (c.body as { state_event?: string }).state_event === "close")).toBe(true);
    expect(calls.some((c) => c.url.endsWith("/merge_requests/8/merge"))).toBe(false);
    const merge = calls.find((c) => c.url.endsWith("/merge_requests/9/merge"))!;
    expect(merge.body).toMatchObject({ sha: "h9" });
    await expect(items(page)).toHaveCount(0);
  });

  test("検証の途中なら、検証が通ったら自動で承認する予約をする", async ({ page }) => {
    const calls = await openConflict(page, BASE + "主任,9500,2026-11\n", { detailed_merge_status: "ci_still_running", head_pipeline: { status: "running" } });
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("検証が通ると自動で承認されます");
    expect(calls.find((c) => c.url.endsWith("/merge_requests/9/merge"))!.body).toMatchObject({ merge_when_pipeline_succeeds: true, auto_merge: true });
  });

  test("同じ行の重なりは、どちらを残すか選んでから載せ直して承認する", async ({ page }) => {
    const calls = await openConflict(page, BASE.replace("部長,12000,2025-04", "部長,13000,2025-04"));
    const dialog = page.locator("dialog[open]");
    await expect(dialog.locator("h2")).toHaveText("載せ直して承認");
    await expect(dialog).toContainText("どちらを残すか選んでください（1 件）");
    await dialog.getByRole("radio", { name: /この変更を残す/ }).check();
    await dialog.getByRole("button", { name: "載せ直して承認する" }).click();
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("最新に載せ直して承認しました");
    const content = (calls.find((c) => c.url.endsWith("/repository/commits"))!.body as { actions: Array<{ content: string }> }).actions[0]!.content;
    expect(content).toContain("部長,12500,2025-04");
    expect(content).not.toContain("部長,13000,2025-04");
  });
});

test.describe("申請中の変更がある対象の印（§126.3）", () => {
  const DEMO = { mode: "demo", gitlab: { apiBaseUrl: "https://gitlab.demo.invalid/api/v4", projectId: "demo/yojitsu-navi", targetBranch: "main", commitMode: "mr" } };
  async function useDemo(page: Page) {
    await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
      try {
        const res = await route.fetch();
        const json = await res.json();
        await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit: DEMO, headCommit: null }), headers: { ...res.headers(), "content-type": "application/json" } });
      } catch (e) {
        if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    });
    await page.addInitScript(() => {
      try {
        if (!sessionStorage.getItem("__init")) {
          sessionStorage.setItem("__init", "1");
          localStorage.setItem("yojitsu-navi:gitlab-demo-role", "leader");
          sessionStorage.setItem("yojitsu-navi:gitlab-token", "demo");
        }
      } catch {}
    });
  }

  test("単価を保存すると、その対象（部長）に印。title に作成者とタイトル。承認すると消える", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/masters?view=rates");
    await page.getByRole("button", { name: "CSV で編集" }).click();
    const area = page.getByRole("textbox", { name: "単価 の CSV" });
    await area.fill((await area.inputValue()) + "部長,14000,2026-11\n");
    await page.getByRole("button", { name: "反映", exact: true }).click();
    await page.getByRole("button", { name: "変更を申請する" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("変更を申請しました");
    // 表で見る（CSV の編集欄を閉じる）
    await gotoPage(page, "/masters?view=rates");
    const chips = page.locator(".yn-me-panel-slot .yn-chip-pending");
    await expect(chips).toHaveCount(1);
    await expect(page.locator("tr.yn-me-group", { has: page.locator(".yn-chip-pending") })).toContainText("部長");
    await expect(chips.first()).toHaveText("申請中");
    await expect(chips.first()).toHaveAttribute("title", "デモ利用者 さん: マスタ更新: 単価");
    await items(page).first().getByRole("button", { name: /を承認$/ }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "承認する" }).click();
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toBeVisible();
    await expect(chips).toHaveCount(0);
  });

  test("リソース計画: アサインを変える MR があれば、その人の行に印", async ({ page }) => {
    const assign = buildMastersPayload(ROOT_DIR).files.assignments.text;
    await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
      try {
        const res = await route.fetch();
        const json = await res.json();
        await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit: CFG, headCommit: null }), headers: { ...res.headers(), "content-type": "application/json" } });
      } catch (e) {
        if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
      }
    });
    await page.route(`${GITLAB}/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      const json = (status: number, b: unknown) => route.fulfill({ status, headers: CORS, body: JSON.stringify(b) });
      const mr = { iid: 5, title: "マスタ更新: data/assignments.csv", source_branch: "masters/x", target_branch: "main", state: "opened", author: { username: "suzuki", name: "鈴木" }, created_at: "2026-11-10T01:00:00Z" };
      if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
      if (url.includes("/merge_requests?")) return json(200, [mr]);
      if (url.endsWith("/merge_requests/5")) return json(200, { ...mr, user: { can_merge: true }, diff_refs: { base_sha: "b0", head_sha: "h5" }, detailed_merge_status: "mergeable" });
      if (url.includes("/merge_requests/5/diffs")) return json(200, [{ new_path: "data/assignments.csv", old_path: "data/assignments.csv" }]);
      if (url.includes("/raw?ref=")) {
        const ref = new URL(url).searchParams.get("ref");
        expect(url).toContain("assignments.csv");
        return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/plain" }, body: ref === "h5" ? assign + "M010,C001,2026-12,2027-03,0.2\n" : assign });
      }
      return json(404, { message: "404" });
    });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/plan");
    await expect(page.locator('tr.yn-me-plan-row[data-member="M010"] .yn-chip-pending')).toHaveText("申請中");
    await expect(page.locator(".yn-me-plan-row .yn-chip-pending")).toHaveCount(1);
  });
});
