/**
 * 承認済みでまだ公開されていない変更を、リソース計画・マスタ編集で先に出す（SPEC §149）
 * - デモ: 申請 → 承認でその画面に反映し、「承認済み」の印。再読み込みしても本体の今の中身を土台にする（続けて保存しても競合しない）
 * - 本物の API 形式: 先頭がビルドと同じなら問い合わせ 1 回だけ。違えば変わったファイルだけ読む。読めなければビルドの中身のまま
 * - 検証の途中で承認を押すと、通ったら自動で承認する予約になり、承認されたら画面に反映する
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, gotoPage } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);
const DEMO = { mode: "demo", gitlab: { apiBaseUrl: "https://gitlab.demo.invalid/api/v4", projectId: "demo/yojitsu-navi", targetBranch: "main", commitMode: "mr" } };
const GITLAB = "https://gitlab.test/api/v4";
const CFG = { mode: "gitlab", gitlab: { apiBaseUrl: GITLAB, projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } };
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "content-type": "application/json" };
const b64 = (t: string) => Buffer.from(t, "utf8").toString("base64");
/** 問い合わせの URL のファイル → id */
const idOf = (url: string) => Object.entries(PAYLOAD.files).find(([, f]) => url.includes(encodeURIComponent(f.repoPath)))?.[0] ?? "?";

/** ビルドのコミット・各ファイルの最終コミット（git の履歴の有無に関係なく同じにする） */
const BUILT_HEAD = "a".repeat(40);
const lastOf = (id: string) => `c-${id}`;

async function patchMasters(page: Page, masterEdit: unknown, { pinCommits = false }: { pinCommits?: boolean } = {}): Promise<void> {
  await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
    try {
      const res = await route.fetch();
      const json = await res.json();
      const commits = pinCommits ? { headCommit: BUILT_HEAD, files: Object.fromEntries(Object.entries(json.files as Record<string, object>).map(([id, f]) => [id, { ...f, lastCommitId: lastOf(id) }])) } : {};
      await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit, ...commits }), headers: { ...res.headers(), "content-type": "application/json" } });
    } catch (e) {
      if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  });
}

async function useDemo(page: Page): Promise<void> {
  await patchMasters(page, DEMO);
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

async function approveFirst(page: Page): Promise<void> {
  const item = page.locator(".yn-mr-item").first();
  await item.getByRole("button", { name: /を承認$/ }).click();
  await page.locator("dialog[open]").getByRole("button", { name: "承認する" }).click();
}

test.describe("デモ: 承認した変更をその画面にすぐ出す（§149）", () => {
  test("単価: 承認するとその行が「承認済み」になり、再読み込みしても残る。続けて直して保存できる", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/masters?view=rates");
    await page.getByRole("button", { name: "CSV で編集" }).click();
    const area = page.getByRole("textbox", { name: "単価 の CSV" });
    await area.fill((await area.inputValue()) + "部長,14000,2026-11\n");
    await page.getByRole("button", { name: "反映", exact: true }).click();
    await page.getByRole("button", { name: "変更を申請する" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("変更を申請しました");
    await approveFirst(page);
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("この画面には反映しました");
    // 保存の結果は消え、承認済みの中身が土台（変更なし）になる
    await expect(page.locator(".yn-me-outcome.is-ok")).toHaveCount(1);
    await expect(page.getByRole("button", { name: "変更を申請する" })).toHaveCount(0);
    await page.getByRole("button", { name: "表で編集" }).click();
    const chip = page.locator(".yn-chip-approved");
    await expect(chip.first()).toBeVisible();
    await expect(chip.first()).toHaveAttribute("title", /ほかの画面の数値は/);
    await page.reload();
    await expect(page.locator(".yn-chip-approved").first()).toBeVisible();
    await page.getByRole("button", { name: "CSV で編集" }).click();
    await expect(page.getByRole("textbox", { name: "単価 の CSV" })).toHaveValue(/部長,14000,2026-11/);
    // 本体の今の中身が土台なので、続けて直して申請しても競合しない
    const area2 = page.getByRole("textbox", { name: "単価 の CSV" });
    await area2.fill((await area2.inputValue()) + "課長,11000,2026-11\n");
    await page.getByRole("button", { name: "反映", exact: true }).click();
    await expect(page.locator(".yn-me-csv-result")).toContainText("追加 1・変更 0・削除 0");
    await page.getByRole("button", { name: "変更を申請する" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("変更を申請しました");
  });

  test("リソース計画: 承認するとその人の行に「承認済み」。再読み込みしても入れた計画のまま", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/plan?team=T111");
    await page.locator('[data-fk="plan:toggle:M011"]').click();
    const out = page.locator('tr.yn-me-plan-sub[data-member="M011"].is-outside[data-target="o:提案"]');
    await out.getByRole("button", { name: /人月を、ある月から変える/ }).click();
    const d = page.locator("dialog.yn-me-dialog[open]");
    await d.locator("#yn-me-f-__value").fill("0.3");
    await d.getByLabel("この月だけ").check();
    await d.getByRole("button", { name: "反映" }).click();
    await page.getByRole("button", { name: "変更を申請する" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("変更を申請しました");
    await approveFirst(page);
    const row = page.locator('tr.yn-me-plan-row[data-member="M011"]');
    await expect(row.locator(".yn-chip-approved")).toBeVisible();
    await expect(page.locator('tr.yn-me-plan-row[data-member="M010"] .yn-chip-approved')).toHaveCount(0);
    await page.reload();
    await expect(page.locator('tr.yn-me-plan-row[data-member="M011"] .yn-chip-approved')).toBeVisible();
    await expect(page.getByRole("button", { name: "変更を申請する" })).toHaveCount(0);
  });
});

test.describe("本物の API 形式（§149）", () => {
  function route(page: Page, { head, rates, gate }: { head: string | null; rates?: string; gate?: Promise<void> }) {
    const calls: string[] = [];
    void page.route(`${GITLAB}/**`, async (r: Route) => {
      const req = r.request();
      if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      if (gate && url.includes("/repository/branches/")) await gate;
      calls.push(`${req.method()} ${url.replace(GITLAB, "")}`);
      const json = (status: number, b: unknown) => r.fulfill({ status, headers: CORS, body: JSON.stringify(b) });
      if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
      if (url.includes("/merge_requests?")) return json(200, []);
      if (url.includes("/repository/branches/main")) return head ? json(200, { commit: { id: head } }) : json(500, { message: "500" });
      if (url.includes("/repository/commits?")) return json(200, [{ id: url.includes("rates.csv") ? "new-rates" : lastOf(idOf(url)) }]);
      if (url.includes("/repository/files/") && url.includes("rates.csv")) return json(200, { encoding: "base64", content: b64(rates ?? ""), last_commit_id: "new-rates" });
      return json(404, { message: "404" });
    });
    return calls;
  }

  test("先頭がビルドと同じなら問い合わせは 1 回だけで、画面はビルドの中身", async ({ page }) => {
    await patchMasters(page, CFG, { pinCommits: true });
    const calls = route(page, { head: BUILT_HEAD });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters?view=rates");
    await expect(page.locator(".yn-mr")).toContainText("申請中の変更はありません");
    await expect.poll(() => calls.filter((c) => c.includes("/repository/")).length).toBe(1);
    await page.waitForTimeout(300);
    expect(calls.filter((c) => c.includes("/repository/"))).toEqual([`GET /projects/grp%2Fyn/repository/branches/main`]);
    await expect(page.locator(".yn-chip-approved")).toHaveCount(0);
  });

  test("先頭が進んでいれば、変わったファイルだけ読んで差し替え、変わった行に「承認済み」", async ({ page }) => {
    await patchMasters(page, CFG, { pinCommits: true });
    const calls = route(page, { head: "f".repeat(40), rates: PAYLOAD.files.rates.text + "部長,15500,2026-11\n" });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters?view=rates");
    await expect(page.locator(".yn-chip-approved").first()).toBeVisible();
    expect(calls.filter((c) => c.includes("/repository/files/"))).toHaveLength(1);
    await page.getByRole("button", { name: "CSV で編集" }).click();
    await expect(page.getByRole("textbox", { name: "単価 の CSV" })).toHaveValue(/部長,15500,2026-11/);
    await expect(page.getByRole("button", { name: "変更を申請する" })).toHaveCount(0);
  });

  test("ダイアログを開いているあいだは差し替えず、閉じてから差し替える（開いた行・値のまま別の行を書かない）", async ({ page }) => {
    await patchMasters(page, CFG, { pinCommits: true });
    let release = () => {};
    const gate = new Promise<void>((r) => (release = r));
    route(page, { head: "f".repeat(40), rates: PAYLOAD.files.rates.text + "部長,15500,2026-11\n", gate });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters?view=rates");
    await page.locator('[data-fk="add:rates"]').click();
    const d = page.locator("dialog.yn-me-dialog[open]");
    await expect(d).toBeVisible();
    release();
    await page.waitForTimeout(800);
    await expect(d).toBeVisible();
    await expect(page.locator(".yn-chip-approved")).toHaveCount(0);
    await page.keyboard.press("Escape");
    await expect(page.locator(".yn-chip-approved").first()).toBeVisible();
  });

  test("読めないときはビルドの中身のまま（画面にエラーも出さない）", async ({ page, errors }) => {
    await patchMasters(page, CFG, { pinCommits: true });
    route(page, { head: null });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters?view=rates");
    await expect(page.locator(".yn-mr")).toContainText("申請中の変更はありません");
    await page.waitForTimeout(300);
    await expect(page.locator(".yn-chip-approved")).toHaveCount(0);
    await expect(page.locator(".yn-me-outcome.is-error, .yn-note-warn")).toHaveCount(0);
    // 想定どおりに失敗させた問い合わせはエラー監視から外す
    for (const list of [errors.failedRequests, errors.console]) list.splice(0, list.length, ...list.filter((x) => !x.includes("/repository/branches/")));
  });

  test("検証の途中で承認すると予約になり、承認されたら画面に反映する", async ({ page }) => {
    await patchMasters(page, CFG, { pinCommits: true });
    const latest = PAYLOAD.files.rates.text + "部長,16000,2026-11\n";
    let merged = false;
    const bodies: unknown[] = [];
    const mr = { iid: 5, title: "マスタ更新: data/masters/rates.csv", description: "", source_branch: "masters/x", target_branch: "main", state: "opened", author: { username: "sato", name: "佐藤" }, created_at: "2026-11-10T01:00:00Z" };
    await page.route(`${GITLAB}/**`, async (r: Route) => {
      const req = r.request();
      if (req.method() === "OPTIONS") return r.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      const json = (status: number, b: unknown) => r.fulfill({ status, headers: CORS, body: JSON.stringify(b) });
      if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
      if (url.includes("/merge_requests?")) return json(200, merged ? [] : [mr]);
      if (url.includes("/diffs?")) return json(200, [{ new_path: "data/masters/rates.csv", old_path: "data/masters/rates.csv" }]);
      if (url.endsWith("/merge_requests/5") && req.method() === "GET")
        return json(200, { ...mr, state: merged ? "merged" : "opened", user: { can_merge: true }, diff_refs: { base_sha: "b0", head_sha: "h5" }, has_conflicts: false, detailed_merge_status: "ci_still_running", head_pipeline: { status: "running" } });
      if (url.endsWith("/merge_requests/5/merge")) {
        bodies.push(JSON.parse(req.postData() ?? "{}"));
        return json(200, { ...mr, merge_when_pipeline_succeeds: true });
      }
      if (url.includes("/raw?ref=")) return r.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/plain" }, body: url.includes("ref=h5") && url.includes("rates.csv") ? latest : PAYLOAD.files.rates.text });
      if (url.includes("/repository/branches/main")) return json(200, { commit: { id: merged ? "f".repeat(40) : BUILT_HEAD } });
      if (url.includes("/repository/commits?")) return json(200, [{ id: url.includes("rates.csv") ? "new-rates" : lastOf(idOf(url)) }]);
      if (url.includes("/repository/files/") && url.includes("rates.csv")) return json(200, { encoding: "base64", content: b64(latest), last_commit_id: "new-rates" });
      return json(404, { message: "404" });
    });
    await page.clock.install();
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters?view=rates");
    await expect(page.locator(".yn-mr")).toContainText("検証: 実行中");
    await approveFirst(page);
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("通ったら自動で承認されるように予約しました");
    expect(bodies[0]).toMatchObject({ merge_when_pipeline_succeeds: true, auto_merge: true, sha: "h5" });
    await expect(page.locator(".yn-chip-approved")).toHaveCount(0);
    merged = true;
    await page.clock.runFor(16_000);
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("この画面には反映しました");
    await expect(page.locator(".yn-chip-approved").first()).toBeVisible();
  });
});
