/**
 * 作業名の括弧内を作業種別（タスク）として扱う（SPEC §101）
 *
 * - 作業名に目印（config.taskFromName.markers。省略時は projectFromTask.marker）があれば、目印の直後の括弧内をタスクとする。
 *   括弧は ( ) と全角の（ ）（NFKC で同じ）、[ ]・【 】・「 」・〔 〕も受け付ける。目印と括弧の間の空白は無視する
 * - 括弧が無い・空・期間の表記（例: 年月〜年月）なら「タスク分類なし」。稼働時間としては数えるが、未分類の警告（TASK_UNCLASSIFIED）にはしない
 * - 目印の照合は §97 と同じく全角半角・大文字小文字・空白を区別しない。複数の目印があれば作業名の中で最も前にあるもの
 * - 目印の無い作業名はこれまでどおり（作業名そのままを task-types.csv で分類する）
 */
import { normalizeKeyword } from "./normalize.js";
import type { Config } from "./types.js";

/** 作業名の目印の位置（NFKC 後の文字列の添字）。見つからなければ null */
export function findMarker(text: string, key: string): { start: number; end: number } | null {
  if (key === "") return null;
  let compact = "";
  const pos: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (/\s/u.test(ch)) continue;
    const lower = ch.toLowerCase();
    for (let j = 0; j < lower.length; j++) pos.push(i);
    compact += lower;
  }
  const at = compact.indexOf(key);
  if (at < 0) return null;
  return { start: pos[at] as number, end: (pos[at + key.length - 1] as number) + 1 };
}

/** 抜き出した結果。task が null = タスク分類なし */
export interface TaskFromName {
  task: string | null;
}

export interface TaskNameExtractor {
  readonly enabled: boolean;
  /** 目印が無い（従来どおり作業名で分類する）なら undefined */
  extract(task: string): TaskFromName | undefined;
}

const DISABLED: TaskNameExtractor = { enabled: false, extract: () => undefined };

const BRACKETS: Record<string, string> = { "(": ")", "[": "]", "【": "】", "「": "」", "〔": "〕" };

/** 期間の表記か（数字と年・月・日・期・区切りだけ。数字を 1 つ以上含む） */
export function isPeriodText(text: string): boolean {
  const t = normalizeKeyword(text);
  if (!/[0-9]/.test(t)) return false;
  const rest = t
    .replace(/令和|平成|fy|上期|下期|四半期|月分|から|まで|頃|ごろ/g, "")
    .replace(/[0-9年月日度期第半分q/.,、・\-~〜～‐‑‒–—―−ー]/gu, "");
  return rest === "";
}

/** 目印の直後の括弧内（無ければ null）。閉じ括弧が無ければ末尾まで */
function bracketAfter(text: string, end: number): string | null {
  let i = end;
  while (i < text.length && /\s/u.test(text[i] as string)) i++;
  const open = text[i];
  const close = open === undefined ? undefined : BRACKETS[open];
  if (open === undefined || close === undefined) return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    const ch = text[j];
    if (ch === open) depth++;
    else if (ch === close && --depth === 0) return text.slice(i + 1, j);
  }
  return text.slice(i + 1);
}

/** 作業名からタスクを抜き出す（目印が無ければ undefined） */
export function extractTaskFromName(task: string, markers: readonly string[]): TaskFromName | undefined {
  const text = (task ?? "").normalize("NFKC");
  let best: { start: number; end: number } | null = null;
  for (const m of markers) {
    const hit = findMarker(text, normalizeKeyword(m));
    if (hit && (!best || hit.start < best.start || (hit.start === best.start && hit.end > best.end))) best = hit;
  }
  if (!best) return undefined;
  const inner = bracketAfter(text, best.end);
  const value = (inner ?? "").replace(/\s+/gu, " ").trim();
  if (value === "" || isPeriodText(value)) return { task: null };
  return { task: value };
}

/** 設定の目印（taskFromName.markers、無ければ projectFromTask.marker。空の目印は捨てる） */
export function taskMarkers(config: Pick<Config, "taskFromName" | "projectFromTask"> | undefined): string[] {
  const cfg = config?.taskFromName;
  if (!cfg || cfg.enabled === false) return [];
  const list = Array.isArray(cfg.markers) ? cfg.markers : typeof config?.projectFromTask?.marker === "string" ? [config.projectFromTask.marker] : [];
  return list.filter((m): m is string => typeof m === "string" && normalizeKeyword(m) !== "");
}

export function createTaskNameExtractor(config: Pick<Config, "taskFromName" | "projectFromTask"> | undefined): TaskNameExtractor {
  const markers = taskMarkers(config);
  if (markers.length === 0) return DISABLED;
  const cache = new Map<string, TaskFromName | undefined>();
  return {
    enabled: true,
    extract(task) {
      if (cache.has(task)) return cache.get(task);
      const v = extractTaskFromName(task, markers);
      cache.set(task, v);
      return v;
    },
  };
}
