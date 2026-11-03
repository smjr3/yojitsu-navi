/**
 * 取り込みアダプタの性質（docs/SPEC.md §20）
 * - 応答の列名を任意に付け替えても、mapping を合わせれば同じ Worklog になる
 * - ページの分け方（種類・サイズ）によらず結果が同じ
 * - members.csv への追記は冪等で、既存の行を消さない
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createHttpAdapter } from "../../scripts/adapters/http.js";
import type { MemberImport } from "../../scripts/adapters/members.js";
import { mergeMembers, type MemberCsvRow } from "../../scripts/lib/members-merge.js";
import type { Config, Worklog } from "../../src/core/types.js";

const noSleep = async () => {};
const FIELDS = ["date", "memberId", "memberName", "customerName", "projectName", "task", "hours"] as const;

function config(http: Record<string, unknown>): Config {
  return {
    fiscalYearStartMonth: 4,
    standardHoursPerMonth: 160,
    hoursPerBusinessDay: 8,
    burnRateDangerThreshold: 1,
    closingBusinessDay: 3,
    forecastMethodDefault: "recent3",
    forecastRecentMonths: 3,
    currency: { code: "JPY", defaultUnit: "yen" },
    labels: { customer: "顧客", project: "案件", contract: "契約", team: "チーム", member: "メンバー" },
    worklogSource: { adapter: "http", csv: { path: "data/worklogs" }, http: { url: "https://api.example.local/w?from={from}&to={to}", authHeader: "Authorization", refetchMonths: 3, ...http } as never },
    costTypes: [{ id: "labor", label: "工数原価" }],
  };
}

const worklogArb: fc.Arbitrary<Worklog> = fc.record({
  date: fc.integer({ min: 1, max: 28 }).map((d) => `2026-09-${String(d).padStart(2, "0")}`),
  memberId: fc.stringMatching(/^[A-Z][0-9]{3}$/),
  memberName: fc.constantFrom("山田 太郎", "鈴木 花子", "Taro"),
  customerName: fc.constantFrom("青葉物流", "やまびこ通信", "x"),
  projectName: fc.constantFrom("保守", "運用", ""),
  task: fc.constantFrom("定例", "調査", ""),
  hours: fc.integer({ min: 1, max: 80 }).map((n) => n / 4),
});

const key = (w: Worklog) => JSON.stringify(w);
const sortKeys = (ws: Worklog[]) => ws.map(key).sort();

async function fetchWith(http: Record<string, unknown>, handler: (url: URL) => Response | Promise<Response>): Promise<Worklog[]> {
  const fetchImpl = (async (u: string) => handler(new URL(u))) as unknown as typeof fetch;
  return createHttpAdapter({ fetchImpl, sleep: noSleep }).fetch({ from: "2026-09", to: "2026-09", config: config(http), env: { WORKLOG_API_TOKEN: "t" }, log: () => {} });
}

const json = (body: unknown, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json", ...headers } });

describe("列名の付け替え", () => {
  const nameArb = fc.stringMatching(/^[a-z][a-z0-9_]{0,8}$/).filter((s) => s !== "wrap");
  it("任意の列名・入れ子・単位・日付形式でも、mapping を合わせれば同じ Worklog", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(worklogArb, { minLength: 1, maxLength: 12 }),
        fc.uniqueArray(nameArb, { minLength: 7, maxLength: 7 }),
        fc.array(fc.boolean(), { minLength: 7, maxLength: 7 }),
        fc.constantFrom("YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "ISO8601", "epochMillis"),
        fc.constantFrom("hours", "minutes", "seconds"),
        async (logs, names, nest, dateFormat, hoursUnit) => {
          const colFor = (i: number) => (nest[i] ? `wrap.${names[i]}` : (names[i] as string));
          const columns = Object.fromEntries(FIELDS.map((f, i) => [f, colFor(i)]));
          const fmtDate = (d: string): string | number => {
            const [y, m, dd] = d.split("-") as [string, string, string];
            if (dateFormat === "YYYY/MM/DD") return `${y}/${m}/${dd}`;
            if (dateFormat === "YYYYMMDD") return `${y}${m}${dd}`;
            if (dateFormat === "ISO8601") return `${d}T10:20:30+09:00`;
            if (dateFormat === "epochMillis") return Date.parse(`${d}T12:00:00+09:00`);
            return d;
          };
          const mult = hoursUnit === "minutes" ? 60 : hoursUnit === "seconds" ? 3600 : 1;
          const rows = logs.map((w) => {
            const src: Record<string, unknown> = { ...w, date: fmtDate(w.date), hours: w.hours * mult };
            const row: Record<string, unknown> = {};
            FIELDS.forEach((f, i) => {
              const col = colFor(i);
              if (nest[i]) {
                const wrap = (row.wrap ??= {}) as Record<string, unknown>;
                wrap[names[i] as string] = src[f];
              } else row[col] = src[f];
            });
            return row;
          });
          const out = await fetchWith({ columns, dateFormat, hoursUnit }, () => json(rows));
          expect(out.map((w) => ({ ...w, hours: Math.round(w.hours * 1e6) / 1e6 }))).toEqual(logs.map((w) => ({ ...w, hours: Math.round(w.hours * 1e6) / 1e6 })));
        },
      ),
      { numRuns: 60 },
    );
  });

  it("候補の並びに本命の列があれば、手前の候補が無くても同じ結果", async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(worklogArb, { minLength: 1, maxLength: 8 }), async (logs) => {
        const columns = { date: ["x_date", "date"], memberId: ["x", "memberId"], memberName: ["memberName"], customerName: ["customerName"], projectName: ["projectName"], task: ["task"], hours: ["x_h", "hours"] };
        const out = await fetchWith({ columns }, () => json(logs));
        expect(out).toEqual(logs);
      }),
      { numRuns: 30 },
    );
  });
});

describe("ページ分割", () => {
  it("none / page / offset / link / cursor のどれでも、どんなサイズでも同じ結果", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(worklogArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom("page", "offset", "link", "cursor"),
        async (logs, size, type) => {
          // 同一内容のページが続いても誤検出しないよう、行を区別できるようにする
          const data = logs.map((w, i) => ({ ...w, task: `${w.task}#${i}` }));
          const expected = data;
          const base = columnsFor();
          const slice = (start: number) => data.slice(start, start + size);
          let out: Worklog[];
          if (type === "page") {
            out = await fetchWith({ ...base, pagination: { type: "page", pageParam: "p", sizeParam: "s", size } }, (u) => json(slice((Number(u.searchParams.get("p")) - 1) * size)));
          } else if (type === "offset") {
            out = await fetchWith({ ...base, pagination: { type: "offset", offsetParam: "o", limitParam: "l", limit: size } }, (u) => json(slice(Number(u.searchParams.get("o")))));
          } else if (type === "link") {
            out = await fetchWith({ ...base, pagination: { type: "link" } }, (u) => {
              const start = Number(u.searchParams.get("start") ?? "0");
              const headers: Record<string, string> = start + size < data.length ? { link: `<${u.origin}${u.pathname}?start=${start + size}>; rel="next"` } : {};
              return json(slice(start), headers);
            });
          } else {
            out = await fetchWith({ ...base, dataPath: "items", pagination: { type: "cursor", cursorPath: "next", cursorParam: "c" } }, (u) => {
              const start = Number(u.searchParams.get("c") ?? "0");
              return json({ items: slice(start), next: start + size < data.length ? String(start + size) : null });
            });
          }
          expect(sortKeys(out)).toEqual(sortKeys(expected));
          expect(out).toEqual(expected); // 順序も保つ
        },
      ),
      { numRuns: 80 },
    );
  });
});

describe("ページ分割（件数パラメータなし・空配列で終了）", () => {
  it("page / offset: 件数を付けず空配列まで取っても、どんなサイズでも同じ結果。従来の設定と同じ行・同じ順序", async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(worklogArb, { minLength: 0, maxLength: 25 }),
        fc.integer({ min: 1, max: 30 }),
        fc.constantFrom("page", "offset"),
        async (logs, size, type) => {
          const data = logs.map((w, i) => ({ ...w, task: `${w.task}#${i}` }));
          const base = columnsFor();
          const slice = (start: number) => data.slice(start, start + size);
          // 件数のパラメータが付いたら 400（連携先と同じ）。1 ページの件数は API 側で固定
          const strict = (u: URL, start: () => number) => (u.searchParams.has("s") || u.searchParams.has("l") ? new Response("bad", { status: 400 }) : json(slice(start())));
          let out: Worklog[];
          let legacy: Worklog[];
          if (type === "page") {
            out = await fetchWith({ ...base, pagination: { type: "page", pageParam: "p", stopWhen: "empty" } }, (u) => strict(u, () => (Number(u.searchParams.get("p")) - 1) * size));
            legacy = await fetchWith({ ...base, pagination: { type: "page", pageParam: "p", sizeParam: "s", size } }, (u) => json(slice((Number(u.searchParams.get("p")) - 1) * size)));
          } else {
            out = await fetchWith({ ...base, pagination: { type: "offset", offsetParam: "o", stopWhen: "empty" } }, (u) => strict(u, () => Number(u.searchParams.get("o"))));
            legacy = await fetchWith({ ...base, pagination: { type: "offset", offsetParam: "o", limitParam: "l", limit: size } }, (u) => json(slice(Number(u.searchParams.get("o")))));
          }
          expect(out).toEqual(data);
          expect(legacy).toEqual(data);
        },
      ),
      { numRuns: 80 },
    );
  });
});

function columnsFor() {
  return { columns: Object.fromEntries(FIELDS.map((f) => [f, f])) };
}

describe("members 追記の冪等性", () => {
  const idArb = fc.integer({ min: 1, max: 12 }).map((n) => `M${String(n).padStart(3, "0")}`);
  const importArb: fc.Arbitrary<MemberImport> = fc.record(
    {
      memberId: idArb,
      name: fc.constantFrom("A", "B", "C"),
      kind: fc.constantFrom("employee" as const, "partner" as const),
      title: fc.constantFrom("部長", "課長", "一般", ""),
      department: fc.constantFrom("第1事業部", "第2事業部", ""),
      section: fc.constantFrom("第1課", ""),
    },
    { requiredKeys: ["memberId", "name"] },
  );
  const rowArb: fc.Arbitrary<MemberCsvRow> = fc.record({
    member_id: idArb,
    name: fc.constantFrom("A", "B"),
    kind: fc.constantFrom("employee", "partner"),
    title: fc.constantFrom("部長", "課長", "一般"),
    department: fc.constantFrom("第1事業部", "第2事業部"),
    section: fc.constantFrom("第1課", ""),
    team_id: fc.constantFrom("", "T1", "T2"),
    effective_from: fc.constantFrom("2025-04", "2026-04", "2026-09"),
  });
  const dedupe = (xs: MemberImport[]) => [...new Map(xs.map((x) => [x.memberId, x])).values()];

  it("2 回目は何も変えない／既存の行は消えない・変わらない（実行月の行を除く）", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 15 }), fc.array(importArb, { maxLength: 12 }), (existing, imp0) => {
        const imported = dedupe(imp0);
        const month = "2026-10";
        const once = mergeMembers(existing, imported, month);
        const twice = mergeMembers(once.rows, imported, month);
        expect(twice.added + twice.changed).toBe(0);
        expect(twice.rows).toEqual(once.rows);
        // 削除しない: 既存の行は先頭にそのまま残る（実行月より前の行は一切変わらない）
        expect(once.rows.slice(0, existing.length)).toEqual(existing);
        expect(once.rows.length).toBe(existing.length + once.added + once.changed);
        // 追加された行は実行月で、team_id は直前の有効レコードを引き継ぐ
        for (const r of once.rows.slice(existing.length)) expect(r.effective_from).toBe(month);
      }),
      { numRuns: 200 },
    );
  });

  it("同じ月に続けて内容が変わっても、その月の行は 1 つだけ", () => {
    fc.assert(
      fc.property(fc.array(rowArb, { maxLength: 8 }), fc.array(importArb, { maxLength: 8 }), fc.array(importArb, { maxLength: 8 }), (existing, a0, b0) => {
        const a = dedupe(a0);
        const b = dedupe(b0);
        const r2 = mergeMembers(mergeMembers(existing, a, "2026-10").rows, b, "2026-10").rows;
        const seen = new Set<string>();
        for (const r of r2.slice(existing.length)) {
          const k = `${r.member_id}|${r.effective_from}`;
          expect(seen.has(k)).toBe(false);
          seen.add(k);
        }
      }),
      { numRuns: 100 },
    );
  });
});
