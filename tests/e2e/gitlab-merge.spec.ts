/**
 * GitLab へのマージ方式（SPEC §24〜§29）
 * - デモ（masterEdit.mode = "demo"。masters.json を page.route で書き換え）で、CSV 編集 → 保存（MR）→ マージ待ち一覧・ヘッダーの件数 → 内容 → マージ／取り下げ
 * - リーダーでない人にはマージボタンを出さない
 * - 本物の API 形式（page.route のモック）で、can_merge の出し分け・マージの要求・失敗の案内
 * - 設定画面: トークンの登録・記憶・接続の確認・テーマ。ヘッダーのアイコンボタン
 * - 390px・ダークではみ出さない
 */
import type { Page, Route } from "@playwright/test";
import { test, expect, gotoPage, useDarkTheme } from "./helpers/app.js";
import { ROOT_DIR } from "./constants.js";
import { buildMastersPayload } from "../../src/data/_masters.js";

const PAYLOAD = buildMastersPayload(ROOT_DIR);
const GITLAB = "https://gitlab.test/api/v4";
const BADGE_LABEL = "マージ待ち {n} 件";

async function patchMasters(page: Page, masterEdit: unknown): Promise<void> {
  await page.route(/\/_file\/data\/masters\.[^/]*json/, async (route) => {
    try {
      const res = await route.fetch();
      const json = await res.json();
      await route.fulfill({ response: res, body: JSON.stringify({ ...json, masterEdit }), headers: { ...res.headers(), "content-type": "application/json" } });
    } catch (e) {
      // 読み込み中に別のページへ移ると、前のページの要求は破棄される（応答は使われない）。それ以外は失敗にする
      if (!/disposed|Target closed|has been closed/i.test(String((e as Error)?.message ?? e))) throw e;
    }
  });
}

const DEMO = { mode: "demo", gitlab: { apiBaseUrl: "https://gitlab.demo.invalid/api/v4", projectId: "demo/yojitsu-navi", targetBranch: "main", commitMode: "mr" } };

async function useDemo(page: Page, { leader = true, token = "demo" }: { leader?: boolean; token?: string | null } = {}): Promise<void> {
  await patchMasters(page, DEMO);
  await page.addInitScript(
    ([label, leader, token]) => {
      (window as unknown as { __YN_BADGE_CONFIG__: unknown }).__YN_BADGE_CONFIG__ = { enabled: true, demo: true, api: "", projectId: "", targetBranch: "main", label };
      try {
        if (!sessionStorage.getItem("__init")) {
          sessionStorage.setItem("__init", "1");
          localStorage.setItem("yojitsu-navi:gitlab-demo-role", leader ? "leader" : "member");
          if (token) sessionStorage.setItem("yojitsu-navi:gitlab-token", token);
        }
      } catch {}
    },
    [BADGE_LABEL, leader, token] as const,
  );
}

// 件数は「⋯」の右上に出る（メニューの中のマスタ編集にも同じ数。§52）
const badge = (page: Page) => page.locator(".yn-tools .yn-more-badge");

/** 単価の CSV に 1 行足して反映し、保存する（MR ができる） */
async function saveRateViaCsv(page: Page, line = "部長,14000,2026-11"): Promise<void> {
  await gotoPage(page, "/masters?view=rates");
  await page.getByRole("button", { name: "CSV で編集" }).click();
  const area = page.getByRole("textbox", { name: "単価 の CSV" });
  await expect(area).toBeFocused();
  await area.fill((await area.inputValue()) + line + "\n");
  await expect(page.locator(".yn-me-csv")).toContainText("反映していない書き換えがあります");
  await page.getByRole("button", { name: "反映", exact: true }).click();
  await expect(page.locator(".yn-me-csv-result")).toContainText("追加 1・変更 0・削除 0");
  await expect(page.locator(".yn-me-diff-table")).toContainText("14000");
  await page.getByRole("button", { name: "GitLab に保存（マージリクエストを作成）" }).click();
  await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("マージリクエストを作成しました");
}

test.describe("デモ: 保存 → マージ待ち → マージ", () => {
  test("内容は ID ではなく氏名で出す（個人単価の行 = 氏名 / 適用開始月）", async ({ page }) => {
    await useDemo(page);
    await saveRateViaCsv(page, "M002,14000,2026-11");
    const item = page.locator(".yn-mr-item").first();
    await item.getByRole("button", { name: "内容を見る" }).click();
    const changes = item.locator(".yn-mr-changes");
    await expect(changes).toContainText("鈴木 美咲 / 2026-11");
    await expect(changes).not.toContainText("M002");
  });

  test("CSV で編集して保存すると MR になり、一覧とヘッダーの件数に出る。内容を見てマージすると消える", { tag: "@smoke" }, async ({ page }) => {
    await useDemo(page);
    await saveRateViaCsv(page);
    const mr = page.locator(".yn-mr");
    await expect(mr.locator(".yn-mr-item")).toHaveCount(1);
    await expect(mr).toContainText("1 件");
    await expect(mr).toContainText("マスタ更新: 単価");
    await expect(mr).toContainText("検証: 成功");
    await expect(badge(page)).toBeVisible();
    await expect(badge(page)).toContainText("1");
    await page.getByRole("button", { name: "その他" }).click();
    await expect(page.getByRole("link", { name: /マスタ編集.*マージ待ち 1 件/ })).toBeVisible();
    await page.keyboard.press("Escape");
    // 別のページでも件数が出る
    await gotoPage(page, "/teams");
    await expect(badge(page)).toContainText("1");
    await gotoPage(page, "/masters");
    const item = page.locator(".yn-mr-item").first();
    await item.getByRole("button", { name: "内容を見る" }).click();
    await expect(item.locator(".yn-mr-changes")).toContainText("単価: 追加 1・変更 0・削除 0");
    await expect(item.locator(".yn-mr-changes")).toContainText("部長 / 2026-11");
    await expect(item.locator(".yn-mr-changes")).toContainText("時間単価");
    await item.getByRole("button", { name: /をマージ$/ }).click();
    const dlg = page.locator("dialog[open]");
    await expect(dlg).toContainText("この変更をマージしますか？");
    await expect(dlg).toContainText("単価: 追加 1・変更 0・削除 0");
    await dlg.getByRole("button", { name: "キャンセル" }).click();
    await expect(item.getByRole("button", { name: /をマージ$/ })).toBeFocused();
    await item.getByRole("button", { name: /をマージ$/ }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "マージする" }).click();
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("「マスタ更新: 単価」をマージしました");
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toBeFocused();
    await expect(page.locator(".yn-mr")).toContainText("マージ待ちの変更はありません");
    await expect(badge(page)).toBeHidden();
  });

  test("リソース計画の保存: 変えた行に変更者（GitLab のユーザー名）と変更日を書く（§56）", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/plan?team=T111");
    const toggle = page.locator('[data-fk="plan:toggle:M011"]');
    await toggle.click();
    const out = page.locator('tr.yn-me-plan-sub[data-member="M011"].is-outside[data-target="o:提案"]');
    await out.getByRole("button", { name: /人月を、ある月から変える/ }).click();
    const d = page.locator("dialog.yn-me-dialog[open]");
    await d.locator("#yn-me-f-__value").fill("0.3");
    await d.getByLabel("この月だけ").check();
    await d.getByRole("button", { name: "反映" }).click();
    await page.getByRole("button", { name: "GitLab に保存（マージリクエストを作成）" }).click();
    await expect(page.locator(".yn-me-outcome.is-ok")).toContainText("マージリクエストを作成しました");
    const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Tokyo" }).format(new Date());
    const saved = await page.evaluate(() => {
      const s = JSON.parse(localStorage.getItem("yojitsu-navi:gitlab-demo:v1") ?? "{}") as { branches: Record<string, { files: Record<string, string> }> };
      return Object.values(s.branches).map((b) => b.files["data/outside-plans.csv"] ?? "").join("");
    });
    expect(saved).toContain(`M011,提案,2026-11,2026-11,0.3,,demo-user,${today}\n`);
    // 変えていない行の記録はそのまま
    expect(saved).toContain("M010,提案,2026-11,2027-01,0.2,次期更改の提案,sato.k,2026-10-25\n");
  });

  test("取り下げ: 確認して閉じると一覧から消える", async ({ page }) => {
    await useDemo(page);
    await saveRateViaCsv(page);
    await page.locator(".yn-mr-item").first().getByRole("button", { name: /を取り下げ$/ }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "取り下げる" }).click();
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("「マスタ更新: 単価」を取り下げました");
    await expect(page.locator(".yn-mr-item")).toHaveCount(0);
  });

  test("リーダーでない人: マージボタンは出ず「マージはリーダーが行います」。自分の MR は取り下げられる", async ({ page }) => {
    await useDemo(page, { leader: false });
    await saveRateViaCsv(page);
    const item = page.locator(".yn-mr-item").first();
    await expect(item.getByRole("button", { name: /をマージ$/ })).toHaveCount(0);
    await expect(item).toContainText("マージはリーダーが行います");
    await expect(item.getByRole("button", { name: /を取り下げ$/ })).toBeVisible();
  });

  test("トークンが無ければ一覧の代わりに設定画面への案内。件数バッジも出ない", async ({ page }) => {
    await useDemo(page, { token: null });
    await gotoPage(page, "/masters");
    await expect(page.locator(".yn-mr")).toContainText("トークンが未登録");
    await page.locator(".yn-mr").getByRole("link", { name: "設定へ" }).click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(badge(page)).toBeHidden();
  });
});

test.describe("CSV で直接編集", () => {
  test("見出しの誤り・閉じない引用符は反映しない（理由と行番号）。今の内容に戻せる", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/masters?view=rates");
    await page.getByRole("button", { name: "CSV で編集" }).click();
    const area = page.getByRole("textbox", { name: "単価 の CSV" });
    const original = await area.inputValue();
    await area.fill(original.replace("hourly_rate", "rate"));
    await page.getByRole("button", { name: "反映", exact: true }).click();
    const err = page.locator(".yn-me-csv-result .yn-me-outcome.is-error");
    await expect(err).toBeFocused();
    await expect(err).toContainText("このファイルに無い列があります（rate）");
    await expect(err).toContainText("足りない列があります（hourly_rate）");
    await expect(page.locator(".yn-me-diff-slot")).toContainText("変更はありません");
    await expect(area).toHaveValue(original.replace("hourly_rate", "rate"));
    await area.fill(original + '"部長,1,2026-11\n');
    await page.getByRole("button", { name: "反映", exact: true }).click();
    await expect(err).toContainText(/\d+ 行目: 引用符/);
    await page.getByRole("button", { name: "今の内容に戻す" }).click();
    await expect(area).toHaveValue(original);
  });

  test("Excel から貼り付け（タブ区切り）・Ctrl+Enter で反映。表に戻すと追加した行が見える", async ({ page }) => {
    await useDemo(page);
    await gotoPage(page, "/masters?view=rates");
    await page.getByRole("button", { name: "CSV で編集" }).click();
    const area = page.getByRole("textbox", { name: "単価 の CSV" });
    const tsv = (await area.inputValue()).trimEnd().split("\n").map((l) => l.split(",").join("\t")).join("\n") + "\n課長\t11000\t2026-11\n";
    await area.fill(tsv);
    await area.press("Control+Enter");
    await expect(page.locator(".yn-me-csv-result")).toContainText("タブ区切り");
    await expect(page.locator(".yn-me-csv-result")).toContainText("追加 1・変更 0・削除 0");
    await expect(area).toHaveValue(/課長,11000,2026-11\n$/);
    await page.getByRole("button", { name: "表で編集" }).click();
    await expect(page.locator('tr.yn-me-group[data-group="課長"]')).toContainText("11000");
  });
});

test.describe("本物の GitLab API の形（モック）", () => {
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "content-type": "application/json" };
  const cfg = { mode: "gitlab", gitlab: { apiBaseUrl: GITLAB, projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } };

  async function mock(page: Page, { canMerge, mergeStatus = 200 }: { canMerge: boolean; mergeStatus?: number }) {
    const calls: Array<{ method: string; url: string; body: unknown }> = [];
    let merged = false;
    await page.route(`${GITLAB}/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      calls.push({ method: req.method(), url, body: req.postData() ? JSON.parse(req.postData()!) : undefined });
      const json = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
      if (url.endsWith("/user")) return json(200, { username: "sato", name: "佐藤" });
      if (url.includes("/merge_requests?")) return json(200, merged ? [] : [{ iid: 7, title: "単価改定", source_branch: "masters/20261028-1-sato", target_branch: "main", state: "opened", author: { username: "suzuki", name: "鈴木" }, created_at: "2026-10-28T01:00:00Z", web_url: "https://gitlab.test/grp/yn/-/merge_requests/7" }]);
      if (url.endsWith("/merge_requests/7")) return json(200, { iid: 7, title: "単価改定", source_branch: "masters/20261028-1-sato", target_branch: "main", author: { username: "suzuki", name: "鈴木" }, web_url: "https://gitlab.test/grp/yn/-/merge_requests/7", user: { can_merge: canMerge }, diff_refs: { base_sha: "b0", head_sha: "h1" }, head_pipeline: { status: "running" }, has_conflicts: false });
      if (url.endsWith("/merge_requests/7/merge")) {
        if (mergeStatus === 200) merged = true;
        return json(mergeStatus, mergeStatus === 200 ? {} : { message: "405 Method Not Allowed" });
      }
      if (url.includes("/raw?ref=")) {
        const ref = new URL(url).searchParams.get("ref");
        if (url.includes("rates.csv")) return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/plain" }, body: PAYLOAD.files.rates.text + (ref === "h1" ? "部長,14000,2026-11\n" : "") });
        return route.fulfill({ status: 200, headers: { ...CORS, "content-type": "text/plain" }, body: "same\n" });
      }
      return json(404, { message: "404" });
    });
    return calls;
  }

  test("マージできる人: 他の人の MR を GitLab へのリンク付きで出し、sha を付けてマージする", async ({ page }) => {
    await patchMasters(page, cfg);
    const calls = await mock(page, { canMerge: true });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters");
    const item = page.locator(".yn-mr-item");
    await expect(item).toContainText("鈴木 さん");
    await expect(item).toContainText("検証: 実行中");
    await expect(item.getByRole("link", { name: "GitLab で開く" })).toHaveAttribute("href", "https://gitlab.test/grp/yn/-/merge_requests/7");
    await item.getByRole("button", { name: "内容を見る" }).click();
    await expect(item.locator(".yn-mr-changes")).toContainText("単価: 追加 1");
    expect(calls.some((c) => c.url.includes("/repository/files/data%2Fmasters%2Frates.csv/raw?ref=b0"))).toBe(true);
    await item.getByRole("button", { name: "!7 単価改定 をマージ" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "マージする" }).click();
    await expect(page.locator(".yn-mr .yn-me-outcome.is-ok")).toContainText("CI が画面を作り直したあと");
    const merge = calls.find((c) => c.method === "PUT")!;
    expect(merge.url).toBe(`${GITLAB}/projects/grp%2Fyn/merge_requests/7/merge`);
    expect(merge.body).toEqual({ should_remove_source_branch: true, sha: "h1" });
  });

  test("マージできない人（can_merge = false）: マージ・取り下げのボタンを出さない", async ({ page }) => {
    await patchMasters(page, cfg);
    await mock(page, { canMerge: false });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters");
    const item = page.locator(".yn-mr-item");
    await expect(item).toContainText("マージはリーダーが行います");
    await expect(item.getByRole("button", { name: /マージ$/ })).toHaveCount(0);
    await expect(item.getByRole("button", { name: /取り下げ$/ })).toHaveCount(0);
  });

  test("マージできない状態（405）: 理由を案内し、一覧は残る", async ({ page, errors }) => {
    await patchMasters(page, cfg);
    await mock(page, { canMerge: true, mergeStatus: 405 });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/masters");
    await page.getByRole("button", { name: "!7 単価改定 をマージ" }).click();
    await page.locator("dialog[open]").getByRole("button", { name: "マージする" }).click();
    const err = page.locator(".yn-mr .yn-me-outcome.is-error");
    await expect(err).toContainText("今はマージできません");
    await expect(err).toBeFocused();
    await expect(page.locator(".yn-mr-item")).toHaveCount(1);
    errors.failedRequests.splice(0, errors.failedRequests.length, ...errors.failedRequests.filter((s) => !s.includes("gitlab.test")));
    errors.console.splice(0, errors.console.length, ...errors.console.filter((s) => !s.includes("gitlab.test") && !s.includes("405")));
  });
});

test.describe("設定画面とヘッダー", () => {
  const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "*", "access-control-allow-methods": "GET, POST, PUT, OPTIONS", "content-type": "application/json" };
  const cfg = { mode: "gitlab", gitlab: { apiBaseUrl: GITLAB, projectId: "grp/yn", targetBranch: "main", commitMode: "mr" } };
  test("ヘッダー: 設定はアイコンのボタン（他のリンクと形が違う）。テーマ切替はヘッダーに置かない", async ({ page }) => {
    await gotoPage(page, "/");
    const toggle = page.locator(".yn-settings-link");
    const tool = page.locator(".yn-tool").first();
    await expect(page.locator(".yn-theme-toggle")).toHaveCount(0);
    const [tb, lb] = await Promise.all([toggle.evaluate((e) => getComputedStyle(e).borderTopWidth + "/" + getComputedStyle(e).borderRadius), tool.evaluate((e) => getComputedStyle(e).borderTopWidth)]);
    expect(tb).toBe("0px/50%");
    expect(lb).toBe("1px");
    await expect(page.locator(".yn-settings-link")).toHaveAccessibleName("設定");
    await page.locator(".yn-settings-link").click();
    await expect(page).toHaveURL(/\/settings/);
    await expect(page.getByRole("heading", { level: 1, name: "設定" })).toBeVisible();
    await expect(page.locator(".yn-settings-link")).toHaveAttribute("aria-current", "page");
  });

  test("接続の確認で本番の設定の不足を警告する（scope・公開範囲・保護ブランチ）。390px でもはみ出さない", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 800 });
    await patchMasters(page, cfg);
    await page.route(`${GITLAB}/**`, async (route: Route) => {
      const req = route.request();
      if (req.method() === "OPTIONS") return route.fulfill({ status: 204, headers: CORS });
      const url = req.url();
      const json = (status: number, body: unknown) => route.fulfill({ status, headers: CORS, body: JSON.stringify(body) });
      // 区切りの無い長いユーザー名でも枠からはみ出さない
      if (url.endsWith("/user")) return json(200, { username: "a.very.long.username.without.any.breaks.xxxxxxxxxxxx", name: "佐藤" });
      if (url.endsWith("/personal_access_tokens/self")) return json(200, { scopes: ["read_api"] });
      if (url.endsWith("/projects/grp%2Fyn")) return json(200, { visibility: "internal", pages_access_level: "public", permissions: { project_access: { access_level: 40 } } });
      if (url.endsWith("/protected_branches/main")) return json(200, { push_access_levels: [{ access_level: 40 }], merge_access_levels: [{ access_level: 30 }] });
      return json(404, { message: "404" });
    });
    await page.addInitScript(() => sessionStorage.setItem("yojitsu-navi:gitlab-token", "glpat-x"));
    await gotoPage(page, "/settings");
    await page.getByRole("button", { name: "接続を確認" }).click();
    const res = page.locator('[data-role="check-result"]');
    await expect(res).toContainText("接続できました");
    await expect(res).toHaveClass(/is-warn/);
    await expect(res).toContainText("GitLab の設定に 5 件の不足があります");
    await expect(res.locator("[data-warning]")).toHaveText([
      "トークンに scope「api」がありません（保存・マージができません）",
      "プロジェクトが Private ではありません",
      "Pages を誰でも見られる設定です",
      "main に直接プッシュできる人がいます",
      "Developer も main にマージできます",
    ]);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("接続先が未設定（既定の config.json）: 案内だけ出し、トークン欄は出さない", async ({ page }) => {
    await gotoPage(page, "/settings");
    await expect(page.locator('[data-role="not-configured"]')).toContainText("接続先が未設定");
    await expect(page.locator("#yn-set-token")).toHaveCount(0);
    await expect(page.locator('[data-role="token-create"]')).toHaveCount(0);
  });

  test("トークンを作成: GitLab の作成画面（名前・scope 入り）を新しいタブで開く。登録後も出す。プロジェクトは GitLab へのリンク", async ({ page }) => {
    await patchMasters(page, cfg);
    await gotoPage(page, "/settings");
    const link = page.getByRole("link", { name: "トークンを作成" });
    await expect(link).toHaveAttribute("href", "https://gitlab.test/-/user_settings/personal_access_tokens?name=yojitsu-navi&scopes=api");
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", /noopener/);
    // 入力欄・登録ボタンと同じ行
    const [inputBox, linkBox] = await Promise.all([page.locator("#yn-set-token").boundingBox(), link.boundingBox()]);
    expect(Math.abs((inputBox?.y ?? 0) + (inputBox?.height ?? 0) / 2 - ((linkBox?.y ?? 0) + (linkBox?.height ?? 0) / 2))).toBeLessThan(4);
    const project = page.locator('[data-role="project-link"]');
    await expect(project).toHaveAttribute("href", "https://gitlab.test/grp/yn");
    await expect(project).toHaveAttribute("target", "_blank");
    await expect(project).toContainText("grp/yn");
    // 登録済み: 作り直し用に「削除」の右にも出す
    await page.route(`${GITLAB}/**`, (route: Route) => {
      const url = route.request().url();
      const body = url.endsWith("/user") ? { username: "u", name: "u" } : url.endsWith("/personal_access_tokens/self") ? { scopes: ["api"] } : { visibility: "private", pages_access_level: "private", permissions: { project_access: { access_level: 30 } } };
      return route.fulfill({ status: 200, headers: CORS, body: JSON.stringify(body) });
    });
    await page.locator("#yn-set-token").fill("glpat-x");
    await page.getByRole("button", { name: "登録" }).click();
    await expect(page.locator('[data-role="check-result"]')).toContainText("接続できました");
    await expect(page.getByRole("link", { name: "トークンを作成" })).toHaveAttribute("href", /\/-\/user_settings\/personal_access_tokens\?/);
  });

  test("トークンを作成: 開く先は config の tokenUrl で変えられる（GitLab 上のパス）", async ({ page }) => {
    await patchMasters(page, { ...cfg, gitlab: { ...cfg.gitlab, projectId: "123", tokenUrl: "/-/profile/personal_access_tokens" } });
    await gotoPage(page, "/settings");
    await expect(page.getByRole("link", { name: "トークンを作成" })).toHaveAttribute("href", "https://gitlab.test/-/profile/personal_access_tokens?name=yojitsu-navi&scopes=api");
    // 数値 ID のプロジェクトはリンクにしない
    await expect(page.locator('[data-role="project-link"]')).toHaveCount(0);
  });

  test("デモ: トークン登録で接続を自動確認（権限 Maintainer）。記憶する／削除、デモの立場の切替", async ({ page }) => {
    await useDemo(page, { token: null });
    await gotoPage(page, "/settings");
    // デモは開く先が無いので押せない形だけ
    await expect(page.getByRole("button", { name: "トークンを作成" })).toBeDisabled();
    await expect(page.getByRole("link", { name: "トークンを作成" })).toHaveCount(0);
    await page.locator("#yn-set-token").fill("demo-token");
    await page.getByLabel("このブラウザに記憶する").check();
    await page.locator("#yn-set-token").press("Enter");
    const res = page.locator('[data-role="check-result"]');
    await expect(res).toContainText("接続できました");
    await expect(res).toContainText("Maintainer");
    await expect(res).toContainText("マージできる立場");
    await expect(res.locator("[data-warning]")).toHaveCount(0);
    expect(await page.evaluate(() => [localStorage.getItem("yojitsu-navi:gitlab-token"), sessionStorage.getItem("yojitsu-navi:gitlab-token")])).toEqual(["demo-token", null]);
    expect(await page.content()).not.toContain("demo-token");
    await expect(page.locator(".yn-settings")).toContainText("このブラウザに記憶しています");
    await page.getByLabel(/リーダーとして操作する/).uncheck();
    await page.getByRole("button", { name: "接続を確認" }).click();
    await expect(res).toContainText("Developer");
    await expect(res).toContainText("マージはリーダー（Maintainer）が行います");
    await page.getByRole("button", { name: "削除" }).click();
    await expect(page.locator("#yn-set-token")).toBeFocused();
    expect(await page.evaluate(() => localStorage.getItem("yojitsu-navi:gitlab-token"))).toBeNull();
  });

  test("配色: GitLab に接続するとそのテーマのテーマカラー（デモは Indigo）、削除すると既定のブルーに戻る", async ({ page }) => {
    await useDemo(page, { token: null });
    await gotoPage(page, "/settings");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
    await expect(page.locator('input[name="yn-set-accent"][value="auto"]')).toBeChecked();
    await page.locator("#yn-set-token").fill("demo-token");
    await page.locator("#yn-set-token").press("Enter");
    await expect(page.locator('[data-role="check-result"]')).toContainText("接続できました");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "indigo");
    await expect(page.locator('input[name="yn-set-accent"][value="auto"]')).toBeChecked();
    // 設定画面で選んだ色は GitLab より優先
    await page.getByRole("radio", { name: "グレー" }).check();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "gray");
    await gotoPage(page, "/teams");
    await expect(page.locator("html")).toHaveAttribute("data-accent", "gray");
    await gotoPage(page, "/settings");
    await page.locator('input[name="yn-set-accent"][value="auto"]').check();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "indigo");
    await page.getByRole("button", { name: "削除" }).click();
    await expect(page.locator("html")).toHaveAttribute("data-accent", "blue");
  });

  test("テーマ: 設定画面のラジオで切り替え、再読み込みしても保たれる", async ({ page }) => {
    await gotoPage(page, "/settings");
    await page.getByRole("radio", { name: "ダーク", exact: true }).check();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await expect(page.getByRole("radio", { name: "ダーク", exact: true })).toBeChecked();
    await page.getByRole("radio", { name: "ライト", exact: true }).check();
    await page.reload();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });
});

test.describe("画面幅・ダーク", () => {
  for (const [w, dark] of [[390, false], [390, true], [768, false], [1024, true], [1280, false]] as const) {
    test(`${w}px${dark ? " ダーク" : ""}: マージ待ち・設定・ヘッダーが横にはみ出さない`, async ({ page }) => {
      if (dark) await useDarkTheme(page);
      await page.setViewportSize({ width: w, height: 800 });
      await useDemo(page);
      await saveRateViaCsv(page);
      await page.locator(".yn-mr-item").first().getByRole("button", { name: "内容を見る" }).click();
      await expect(page.locator(".yn-mr-changes")).toContainText("追加 1");
      for (const path of ["/masters", "/settings"]) {
        if (path !== "/masters") await gotoPage(page, path);
        const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(over, `${path} の横はみ出し`).toBeLessThanOrEqual(0);
        const badgeBox = await badge(page).boundingBox();
        expect(badgeBox && badgeBox.x + badgeBox.width).toBeLessThanOrEqual(w);
        const icons = await page.locator(".yn-icon-tools").boundingBox();
        expect(icons && icons.x + icons.width).toBeLessThanOrEqual(w);
      }
    });
  }
});
