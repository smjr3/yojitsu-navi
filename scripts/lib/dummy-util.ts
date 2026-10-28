/**
 * ダミーデータ生成の小道具（決定的な乱数・日付）。scripts/generate-dummy.ts と scripts/dummy-scale.ts が使う
 */
import type { YearMonth } from "../../src/core/types.js";

// ---------------------------------------------------------------------------
// 乱数（決定的）
// ---------------------------------------------------------------------------

/** mulberry32: 32bit シードの軽量 PRNG */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  private readonly next: () => number;
  constructor(seed: number) {
    this.next = mulberry32(seed);
  }
  /** [0,1) */
  float(): number {
    return this.next();
  }
  /** 整数 [min, max] */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(arr: readonly T[]): T {
    const v = arr[Math.floor(this.next() * arr.length)];
    if (v === undefined) throw new Error("pick: empty array");
    return v;
  }
  /** 重み付き選択 */
  weighted<T>(items: ReadonlyArray<readonly [T, number]>): T {
    const total = items.reduce((s, [, w]) => s + w, 0);
    let r = this.next() * total;
    for (const [v, w] of items) {
      r -= w;
      if (r < 0) return v;
    }
    const last = items[items.length - 1];
    if (!last) throw new Error("weighted: empty");
    return last[0];
  }
}

// ---------------------------------------------------------------------------
// 年月・日付ユーティリティ
// ---------------------------------------------------------------------------

export function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function ymOf(date: string): YearMonth {
  return date.slice(0, 7);
}

/** from〜to（両端含む）の全日付（YYYY-MM-DD）。UTC で計算 */
export function eachDay(from: string, to: string): string[] {
  const out: string[] = [];
  const [fy, fm, fd] = from.split("-").map(Number) as [number, number, number];
  const [ty, tm, td] = to.split("-").map(Number) as [number, number, number];
  let t = Date.UTC(fy, fm - 1, fd);
  const end = Date.UTC(ty, tm - 1, td);
  while (t <= end) {
    const d = new Date(t);
    out.push(`${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`);
    t += 86400000;
  }
  return out;
}

export function weekday(date: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/** 1日の時間を 0.25 刻みで n 個に分ける（各スロット >= 0.25） */
export function splitHours(rng: Rng, total: number, n: number): number[] {
  const units = Math.round(total * 4);
  if (n <= 1 || units < n) return [total];
  const cuts = new Set<number>();
  while (cuts.size < n - 1) cuts.add(rng.int(1, units - 1));
  const sorted = [...cuts].sort((a, b) => a - b);
  const out: number[] = [];
  let prev = 0;
  for (const c of sorted) {
    out.push((c - prev) / 4);
    prev = c;
  }
  out.push((units - prev) / 4);
  return out;
}

export function monthCount(from: YearMonth, to: YearMonth): number {
  const [fy, fm] = from.split("-").map(Number) as [number, number];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  return (ty - fy) * 12 + (tm - fm) + 1;
}


/** 年月に n か月足す */
export function addMonths(ym: YearMonth, n: number): YearMonth {
  const [y, m] = ym.split("-").map(Number) as [number, number];
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${pad2((t % 12) + 1)}`;
}
