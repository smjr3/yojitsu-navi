/**
 * 画面側のヘルパ: エラー監視フィクスチャ、ページ遷移の待ち、表のセル取得、数値の読み取り
 */
import { test as base, expect, type Locator, type Page } from "@playwright/test";

export { expect };

export interface ErrorLog {
  console: string[];
  pageErrors: string[];
  failedRequests: string[];
  /** 既知の無害なものを無視するか（モンキーテストでは遷移で中断された fetch を無視する） */
  ignoreAborted: boolean;
}

/** console.error / 未捕捉例外 / 失敗したリクエスト（4xx・5xx・ネットワークエラー）を記録する */
export function watchErrors(page: Page, { ignoreAborted = false }: { ignoreAborted?: boolean } = {}): ErrorLog {
  const log: ErrorLog = { console: [], pageErrors: [], failedRequests: [], ignoreAborted };
  page.on("console", (msg) => {
    if (msg.type() === "error") log.console.push(`${msg.text()} @ ${msg.location().url}:${msg.location().lineNumber}`);
  });
  page.on("pageerror", (err) => log.pageErrors.push(`${err.name}: ${err.message}\n${err.stack ?? ""}`));
  page.on("requestfailed", (req) => {
    const text = req.failure()?.errorText ?? "";
    if (ignoreAborted && /ERR_ABORTED/.test(text)) return;
    log.failedRequests.push(`${req.method()} ${req.url()} → ${text}`);
  });
  page.on("response", (res) => {
    if (res.status() >= 400) log.failedRequests.push(`${res.request().method()} ${res.url()} → HTTP ${res.status()}`);
  });
  return log;
}

export function assertNoErrors(log: ErrorLog, context = ""): void {
  const where = context ? `（${context}）` : "";
  expect(log.pageErrors, `未捕捉の例外${where}`).toEqual([]);
  expect(log.console, `console.error${where}`).toEqual([]);
  expect(log.failedRequests, `失敗したリクエスト${where}`).toEqual([]);
}

/** 全テスト共通: テスト終了時にエラーが 0 件であることを確認する（auto フィクスチャ） */
export const test = base.extend<{ errors: ErrorLog }>({
  errors: [
    async ({ page }, use) => {
      const log = watchErrors(page);
      await use(log);
      assertNoErrors(log, "テスト終了時");
    },
    { auto: true },
  ],
});

/** ページを開き、ヘッダ（モデル読み込み後に描画）と h1 が出るまで待つ */
export async function gotoPage(page: Page, path: string): Promise<void> {
  await page.goto(path);
  await waitForPage(page);
}

export async function waitForPage(page: Page): Promise<void> {
  await page.locator("#page-skeleton").waitFor({ state: "detached", timeout: 20_000 }).catch(() => {});
  await expect(page.locator(".yn-page-header").first()).toBeVisible({ timeout: 20_000 });
  await expect(page.locator("h1").first()).toBeVisible();
}

/** "1,234,567円" / "-1,234円" / "▲ 103.4%" / "12.5h" → 数値。"—" は null */
export function parseNumber(text: string): number | null {
  const t = text
    .replace(/[▲▼△]/g, "")
    .replace(/[−–]/g, "-")
    .replace(/[^\d.\-]/g, "")
    .trim();
  if (t === "" || t === "-") return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

/** 表の見出し → 列番号（並べ替えアイコンを除いた文字列で引く） */
export async function headerIndex(table: Locator): Promise<Map<string, number>> {
  const ths = table.locator("thead th");
  const n = await ths.count();
  const map = new Map<string, number>();
  for (let i = 0; i < n; i++) {
    const text = (await ths.nth(i).textContent()) ?? "";
    map.set(text.replace(/[⇅▲▼]/g, "").replace(/\s+/g, " ").trim(), i);
  }
  return map;
}

/** 見出しから列番号。完全一致 → 「ラベル（補足）」の前方一致 の順で引く（補足の言い換えに強くする） */
export function col(map: Map<string, number>, label: string): number {
  const exact = map.get(label);
  if (exact !== undefined) return exact;
  const prefixed = [...map.entries()].filter(([k]) => k.startsWith(`${label}（`) || k.startsWith(`${label} (`));
  if (prefixed.length === 1) return prefixed[0]![1];
  throw new Error(`列「${label}」が見つかりません。見出し: ${[...map.keys()].join(" | ")}`);
}

/** 表の本体行の data-key を、表が描画されるのを待ってから読む */
export async function rowKeys(table: Locator): Promise<string[]> {
  await expect(table).toBeVisible();
  return (await dataRows(table).evaluateAll((trs) => trs.map((tr) => tr.getAttribute("data-key") ?? ""))) as string[];
}

/** 行の i 番目のセル（th scope=row も含む） */
export function cell(row: Locator, index: number): Locator {
  return row.locator("th, td").nth(index);
}

export async function cellText(row: Locator, index: number): Promise<string> {
  return ((await cell(row, index).textContent()) ?? "").replace(/\s+/g, " ").trim();
}

/** caption（visually-hidden）で表を探す */
export function tableByCaption(page: Page, caption: string): Locator {
  return page.locator("table.yn-table").filter({ has: page.locator("caption", { hasText: caption }) });
}

/** 表の本体行（空行・合計行を除く） */
export function dataRows(table: Locator): Locator {
  return table.locator("tbody tr[data-key]");
}

/** KPI タイル i の値ボタン */
export function kpiValue(page: Page, index: number): Locator {
  return page.locator(".yn-kpi-grid").first().locator(".yn-kpi").nth(index).locator(".yn-kpi-value");
}

export function dialog(page: Page): Locator {
  return page.locator("dialog.yn-dialog[open]");
}

/** 内訳パネルの「ラベル → 値」（dl.yn-bd-rows） */
export async function dialogRow(page: Page, label: string): Promise<string> {
  const d = dialog(page);
  const row = d.locator(".yn-bd-rows > div").filter({ has: page.locator("dt", { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) });
  await expect(row, `内訳の行「${label}」`).toHaveCount(1);
  return ((await row.locator("dd .num").textContent()) ?? "").trim();
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** URL のクエリを読む */
export function query(page: Page): URLSearchParams {
  return new URL(page.url()).searchParams;
}
