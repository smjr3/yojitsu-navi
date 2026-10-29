/**
 * モンキーテスト: シード付きの乱数でページ内を乱打し、毎回「壊れていない」ことを確かめる。
 *   MONKEY_SEEDS=1,2,3   シードの一覧（または "5" のように個数）
 *   MONKEY_ACTIONS=150   1 ページあたりの操作回数
 * 失敗時は操作の履歴（trace）をエラーメッセージと添付ファイルに出す。再現は同じシードで -g "seed=N" を付けて実行。
 */
import { test as base, expect, type ElementHandle, type Page } from "@playwright/test";
import { watchErrors, assertNoErrors, waitForPage } from "./helpers/app.js";

const PAGES = ["/", "/teams", "/contracts", "/contract?id=C008", "/workload", "/plan", "/settings", "/contract?id=NOPE", "/customers", "/customer?key=%E9%9D%92%E8%91%89%E7%89%A9%E6%B5%81", "/customer?key=nope", "/rules", "/data-check", "/team?id=S21", "/team?id=NOPE", "/members", "/member?id=M011", "/member?id=M099", "/member?id=NOPE", "/masters"];
const seedsEnv = (process.env.MONKEY_SEEDS ?? "1,2,3").trim();
const SEEDS = /^\d+$/.test(seedsEnv) && !seedsEnv.includes(",") ? Array.from({ length: Number(seedsEnv) }, (_, i) => i + 1) : seedsEnv.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n));
const ACTIONS = Number(process.env.MONKEY_ACTIONS ?? 150);
const KEYS = ["Tab", "Shift+Tab", "Enter", "Space", "Escape", "ArrowDown"] as const;
const SEARCH_WORDS = ["さくら", "C0", "みなと", "zzz", "", "保守", "T1"];
const BAD_TEXT = /\bNaN\b|\bundefined\b|\bnull\b|\bInfinity\b|\[object Object\]/;

/** mulberry32 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const test = base.extend({});

const CANDIDATES = 'a[href], button, input, select, summary, [role="button"], label.yn-toggle-chip, #observablehq-sidebar-backdrop';

async function describeHandle(h: ElementHandle): Promise<string> {
  return h.evaluate((el) => {
    const e = el as HTMLElement;
    const id = e.id ? `#${e.id}` : "";
    const cls = e.className && typeof e.className === "string" ? "." + e.className.trim().split(/\s+/).slice(0, 3).join(".") : "";
    const text = (e.getAttribute("aria-label") ?? e.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 40);
    const href = e.getAttribute("href");
    return `${e.tagName.toLowerCase()}${id}${cls}${href ? `[href=${href}]` : ""} "${text}"`;
  });
}

for (const path of PAGES) {
  for (const seed of SEEDS) {
    test(`monkey ${path} seed=${seed}`, async ({ page, baseURL }, testInfo) => {
      test.setTimeout(240_000);
      const origin = new URL(baseURL!).origin;
      const errors = watchErrors(page, { ignoreAborted: true });
      const random = rng(seed * 7919 + path.length);
      const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(random() * arr.length)]!;
      const trace: string[] = [];
      const log = (s: string) => trace.push(`${String(trace.length + 1).padStart(3, "0")} ${s}`);
      let dialogWasOpen = false;

      const ensureLoaded = async () => {
        if (page.url() === "about:blank" || !page.url().startsWith(origin)) {
          log(`  → off-site/blank (${page.url()}), returning to ${path}`);
          await page.goto(path);
        }
        await page.waitForLoadState("domcontentloaded");
        await waitForPage(page);
      };

      /** 操作のあとの不変条件 */
      const check = async (step: number) => {
        await ensureLoaded();
        expect(new URL(page.url()).origin, "同一オリジンに留まる").toBe(origin);
        assertNoErrors(errors, `step ${step}`);
        const state = await page.evaluate(() => {
          const text = document.body.innerText;
          return {
            h1: document.querySelectorAll("h1").length,
            bad: text.match(/\bNaN\b|\bundefined\b|\bnull\b|\bInfinity\b|\[object Object\]/)?.[0] ?? null,
            badContext: (() => {
              const m = text.match(/.{0,40}(\bNaN\b|\bundefined\b|\bnull\b|\bInfinity\b|\[object Object\]).{0,40}/);
              return m ? m[0] : null;
            })(),
            emptyYen: /—\s*(百万円|千円|円)/.test(text) ? text.match(/.{0,40}—\s*(百万円|千円|円).{0,20}/)?.[0] ?? "—円" : null,
            dialogs: document.querySelectorAll("dialog[open]").length,
          };
        });
        expect(state.h1, `h1 が 1 つある (step ${step})`).toBe(1);
        expect(state.bad, `不正な文字列が表示されていない (step ${step}): ${state.badContext}`).toBeNull();
        expect(state.emptyYen, `「—円」が表示されていない (step ${step})`).toBeNull();
        if (state.dialogs > 0) {
          dialogWasOpen = true;
          // 開いているダイアログは Esc で閉じられる（半分の確率で閉じ、残りは中を触らせる）
          if (random() < 0.5) {
            // 選択欄（select）や月・日付の入力欄にフォーカスがあると、Enter/Space で開いたリストやカレンダーを
            // 最初の Esc が閉じる（ブラウザ標準）。利用者と同じく、その場合はもう一度 Esc を押す
            const onSelect = await page.evaluate(() => {
              const el = document.activeElement;
              if (el?.tagName === "SELECT") return true;
              // 候補を開いている名前の入力欄（SPEC §31.2）も、最初の Esc は候補だけを閉じる
              if (el?.getAttribute("role") === "combobox" && el.getAttribute("aria-expanded") === "true") return true;
              return el instanceof HTMLInputElement && ["month", "date", "week", "time", "datetime-local"].includes(el.type);
            });
            await page.keyboard.press("Escape");
            if (onSelect && (await page.locator("dialog[open]").count()) > 0) await page.keyboard.press("Escape");
            await expect(page.locator("dialog[open]"), `Esc でダイアログが閉じる (step ${step})`).toHaveCount(0);
            log("  → Escape closed dialog");
          }
        }
      };

      const candidates = async (): Promise<ElementHandle[]> => {
        // マウスを右下に退避（サイドバーのホバー領域から離す）
        const vp = page.viewportSize();
        if (vp) await page.mouse.move(vp.width - 4, vp.height - 4).catch(() => {});
        const dialogOpen = (await page.locator("dialog[open]").count()) > 0;
        // 5 倍のデータでは候補が数百〜数千になるため、判定はページ内で 1 回にまとめ（要素ごとの往復をしない）、
        // 候補に印を付けてから取り出す。順序は従来どおり文書順
        await page.evaluate(
          ({ selector, dialogOpen, origin }) => {
            for (const el of document.querySelectorAll("[data-monkey-cand]")) el.removeAttribute("data-monkey-cand");
            const root = dialogOpen ? document.querySelector("dialog[open]") : document.body;
            if (!root) return;
            const judge = (el: Element) => {
              const e = el as HTMLElement;
              const r = e.getBoundingClientRect();
              const style = getComputedStyle(e);
              // checkVisibility は閉じた <details> の中（レイアウト箱は残るが描画されない）も hidden と判定する
              const cv = typeof e.checkVisibility === "function" ? e.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: true } as never) : true;
              const visible = cv && r.width > 0 && r.height > 0 && style.visibility !== "hidden" && style.display !== "none";
              const disabled = (e as HTMLButtonElement).disabled === true;
              const tag = e.tagName.toLowerCase();
              let skip = false;
              if (e.classList.contains("yn-export")) skip = true; // ダウンロードは別テスト
              if (e.hasAttribute("download")) skip = true;
              // 閉じた <details> の中身（summary 自体は可）
              if (tag !== "summary" && e.closest("details:not([open])")) skip = true;
              // Observable Framework のサイドバー: 開閉用の不可視チェックボックスは触らない。
              // 狭い幅ではホバーでスライドして出る（遷移中は見えていても消える）ので、完全に開いている（left: 0）ときだけ中のリンクを候補にする
              if (e.id === "observablehq-sidebar-toggle") skip = true;
              const sidebar = e.closest("#observablehq-sidebar");
              if (sidebar && getComputedStyle(sidebar).left !== "0px") skip = true;
              // 狭い幅でサイドバーを開くと背景（backdrop ラベル）がページを覆う。その間はサイドバー内か backdrop（閉じる）だけ触れる
              const backdrop = document.getElementById("observablehq-sidebar-backdrop");
              const bs = backdrop ? getComputedStyle(backdrop) : null;
              const backdropActive = !!backdrop && bs!.display !== "none" && bs!.visibility !== "hidden" && bs!.pointerEvents !== "none" && backdrop.getBoundingClientRect().width > 0;
              if (backdropActive && !sidebar && e !== backdrop) skip = true;
              if (!backdropActive && e === backdrop) skip = true;
              // 開いている候補の一覧（コンボボックスの listbox）の下に隠れた要素は押せない（押すと候補を選ぶ）。
              // 一覧が重なるのは選択式の入力として普通の動きなので候補から外す（一覧の項目自体は候補に残る）
              if (r.width > 0 && r.height > 0) {
                const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
                const list = top?.closest("[role=listbox]");
                if (list && !list.contains(e) && !e.contains(list)) skip = true;
              }
              if (tag === "a") {
                const href = (e as HTMLAnchorElement).href;
                if (!href.startsWith(origin)) skip = true;
                if (/^(mailto|tel|javascript):/.test(href)) skip = true;
              }
              return { visible, disabled, skip };
            };
            for (const el of root.querySelectorAll(selector)) {
              const info = judge(el);
              if (info.visible && !info.disabled && !info.skip) el.setAttribute("data-monkey-cand", "");
            }
          },
          { selector: CANDIDATES, dialogOpen, origin },
        ).catch(() => {});
        return page.locator("[data-monkey-cand]").elementHandles();
      };

      const isDetached = (e: unknown) => /not attached|detached|Execution context|Target closed|navigation/i.test(String((e as Error)?.message ?? e));

      await page.goto(path);
      await waitForPage(page);
      log(`start ${path} seed=${seed} viewport=${JSON.stringify(page.viewportSize())}`);
      await check(0);

      try {
        for (let step = 1; step <= ACTIONS; step++) {
          const roll = random();
          if (roll < 0.5) {
            // クリック
            const cands = await candidates();
            if (cands.length === 0) {
              log(`${step} click: no candidates`);
            } else {
              const h = pick(cands);
              const desc = await describeHandle(h).catch(() => "(detached)");
              const tag = await h.evaluate((el) => (el as Element).tagName.toLowerCase()).catch(() => "");
              if (tag === "select") {
                const count = await h.evaluate((el) => (el as HTMLSelectElement).options.length).catch(() => 0);
                if (count > 0) {
                  const idx = Math.floor(random() * count);
                  log(`${step} select option #${idx} on ${desc}`);
                  await h.selectOption({ index: idx }).catch((e) => {
                    if (!isDetached(e)) throw e;
                    log("  → detached, skipped");
                  });
                }
              } else if (tag === "input" && (await h.evaluate((el) => (el as HTMLInputElement).type).catch(() => "")) === "search") {
                const word = pick(SEARCH_WORDS);
                log(`${step} type "${word}" into ${desc}`);
                await h.fill(word).catch((e) => {
                  if (!isDetached(e)) throw e;
                });
              } else {
                log(`${step} click ${desc}`);
                try {
                  // サイドバーの backdrop は左側をサイドバー自身が覆うので、露出している右端を押す
                  const isBackdrop = await h.evaluate((el) => (el as HTMLElement).id === "observablehq-sidebar-backdrop").catch(() => false);
                  if (isBackdrop) {
                    const box = await h.boundingBox();
                    await h.click({ timeout: 5000, position: { x: Math.max(1, (box?.width ?? 2) - 8), y: Math.max(1, (box?.height ?? 2) / 2) } });
                  } else await h.click({ timeout: 5000 });
                } catch (e) {
                  if (isDetached(e)) log("  → detached during click, skipped");
                  // 開いた候補リストなどの下に隠れた要素（利用者が押すと上の要素に当たる）。押せないのが正しい
                  else if (/intercepts pointer events/.test((e as Error).message)) log("  → covered by another element, skipped");
                  else throw new Error(`クリックできない要素: ${desc}\n${(e as Error).message}`);
                }
              }
            }
          } else if (roll < 0.68) {
            const key = pick(KEYS);
            // Enter/Space は外部リンクやダウンロードに触れない
            const target = await page
              .evaluate(() => {
                const el = document.activeElement as HTMLElement | null;
                if (!el) return null;
                return { tag: el.tagName.toLowerCase(), href: (el as HTMLAnchorElement).href ?? null, cls: el.className ?? "", text: (el.textContent ?? "").trim().slice(0, 30) };
              })
              .catch(() => null);
            const blocked = (key === "Enter" || key === "Space") && target && ((target.href && !target.href.startsWith(origin)) || /yn-export/.test(String(target.cls)));
            if (blocked) {
              log(`${step} key ${key} skipped (target ${JSON.stringify(target)})`);
            } else {
              log(`${step} key ${key} (focus: ${target ? `${target.tag} "${target.text}"` : "none"})`);
              await page.keyboard.press(key).catch((e) => {
                if (!isDetached(e)) throw e;
              });
            }
          } else if (roll < 0.8) {
            const w = 360 + Math.floor(random() * (1600 - 360 + 1));
            const hgt = 600 + Math.floor(random() * 400);
            log(`${step} resize ${w}×${hgt}`);
            await page.setViewportSize({ width: w, height: hgt });
          } else if (roll < 0.9) {
            await candidates();
            const selects = await page.locator("select[data-monkey-cand]").elementHandles();
            if (selects.length) {
              const h = pick(selects);
              const count = await h.evaluate((el) => (el as HTMLSelectElement).options.length).catch(() => 0);
              const idx = Math.floor(random() * Math.max(1, count));
              log(`${step} select option #${idx} on ${await describeHandle(h).catch(() => "(detached)")}`);
              await h.selectOption({ index: idx }).catch((e) => {
                if (!isDetached(e)) throw e;
              });
            } else log(`${step} select: none`);
          } else {
            const back = random() < 0.6;
            log(`${step} history ${back ? "back" : "forward"} from ${page.url()}`);
            const res = back ? await page.goBack({ waitUntil: "domcontentloaded" }).catch(() => null) : await page.goForward({ waitUntil: "domcontentloaded" }).catch(() => null);
            if (!res) log("  → no history entry");
          }
          await check(step);
        }
        // 最後に開いているダイアログがあれば必ず Esc で閉じられること
        if ((await page.locator("dialog[open]").count()) > 0) {
          const listOpen = await page.evaluate(() => document.activeElement?.getAttribute("aria-expanded") === "true");
          await page.keyboard.press("Escape");
          if (listOpen) await page.keyboard.press("Escape");
          await expect(page.locator("dialog[open]")).toHaveCount(0);
        }
        log(`done. dialog opened at least once: ${dialogWasOpen}`);
      } catch (error) {
        const text = trace.join("\n");
        await testInfo.attach(`monkey-trace-seed${seed}.txt`, { body: text, contentType: "text/plain" });
        const e = error as Error;
        e.message = `${e.message}\n\n--- monkey trace (${path}, seed=${seed}, ${trace.length} entries) ---\n${text}`;
        throw e;
      } finally {
        await testInfo.attach(`monkey-trace-seed${seed}.txt`, { body: trace.join("\n"), contentType: "text/plain" }).catch(() => {});
      }
    });
  }
}
