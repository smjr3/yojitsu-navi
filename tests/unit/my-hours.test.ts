/**
 * 今月の残り時間（SPEC §113）
 * - 行: 計画も実績も無い行は出さない・計画の多い順・運用保守以外は「運用保守以外: 種別」
 * - GitLab のユーザー名 → 社員番号: 前後の空白・先頭の @・大文字小文字を無視。月の時点の行で引く。重複は出さない（データ確認の警告）
 * - ヘッダーのスクリプト: トークンの持ち主の今月の行だけを出す。トークンが無い・ユーザー名が無いときは何も出さない
 */
// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { buildMyHoursPayload, duplicateGitlabUsernames, gitlabUsernameIndex, myHoursRows, myHoursTotals, normalizeGitlabUsername, type MemberMonth } from "../../src/core/index.js";
import { validateDataset } from "../../src/core/validate.js";
import { DEMO_USER } from "../../src/core/gitlab-mock.js";
import { DEMO_USERNAME, myHoursCard, myHoursConfig, myHoursScript, runMyHours } from "../../src/components/my-hours.js";
import { TOKEN_STORAGE_KEY } from "../../src/components/gitlab-client.js";
import { formatMembersCsv, mergeMembers } from "../../scripts/lib/members-merge.js";
import { parseDataset } from "../../src/core/csv.js";
import { T } from "../../src/i18n/index.js";
import { baseConfig, dataset, member } from "./fixtures.js";

const line = (contractId: string, plannedHours: number, actualHours: number, outsideType?: string) => ({
  contractId,
  ...(outsideType !== undefined ? { outsideType } : {}),
  allocation: plannedHours / 160,
  assignmentCount: plannedHours > 0 ? 1 : 0,
  plannedHours,
  plannedCost: 0,
  actualHours,
  actualCost: 0,
});
const mm = (memberId: string, month: string, byContract: ReturnType<typeof line>[]): MemberMonth => ({ memberId, month, byContract }) as unknown as MemberMonth;
const names: Record<string, string> = { C1: "勘定系保守", C2: "契約管理保守", C3: "学習管理保守" };
const contractOf = (id: string) => (names[id] ? { projectName: names[id]!, customerName: `顧客${id}` } : undefined);

describe("myHoursRows / myHoursTotals", () => {
  it("計画も実績も無い行を除き、計画の多い順。名前はリソース計画の作業の行と同じ（案件名＋顧客名、種別＋運用保守以外）", () => {
    const rows = myHoursRows(mm("M1", "2026-10", [line("C1", 80, 68.75), line("C2", 0, 0), line("C3", 8, 11.5), line("~outside:提案", 16, 2, "提案"), line("~outside:", 0, 1, "")]), contractOf);
    expect(rows.map((r) => [r.label, r.sub, r.plannedHours, r.actualHours])).toEqual([
      ["勘定系保守", "顧客C1", 80, 68.75],
      ["提案", T.planEdit.outsideTypeSub, 16, 2],
      ["学習管理保守", "顧客C3", 8, 11.5],
      [T.masterFiles.outside, T.planEdit.outsideSub, 0, 1],
    ]);
    expect(rows.map((r) => r.contractId)).toEqual(["C1", null, "C3", null]);
    expect(myHoursTotals(rows)).toEqual({ plannedHours: 104, actualHours: 83.25, remainingHours: 20.75 });
  });
  it("案件名が無ければ契約ID。その月のデータが無ければ空", () => {
    expect(myHoursRows(mm("M1", "2026-10", [line("C9", 8, 0)]), () => undefined)[0]).toMatchObject({ label: "C9", sub: "" });
    expect(myHoursRows(undefined, () => undefined)).toEqual([]);
    expect(myHoursTotals([])).toEqual({ plannedHours: 0, actualHours: 0, remainingHours: 0 });
  });
  it("計画を超えたら残りはマイナス", () => {
    expect(myHoursTotals(myHoursRows(mm("M1", "2026-10", [line("C1", 8, 10.25)]), contractOf)).remainingHours).toBe(-2.25);
  });
});

describe("GitLab のユーザー名", () => {
  it("比べ方: 空白・先頭の @・大文字小文字を無視", () => {
    expect(normalizeGitlabUsername("  @Sato.K ")).toBe("sato.k");
    expect(normalizeGitlabUsername(undefined)).toBe("");
  });
  it("月の時点の行で引く（後から付けた・外したも反映）。どの月の行にも無い人は出さない", () => {
    const members = [
      member({ memberId: "M1", effectiveFrom: "2026-04" }),
      member({ memberId: "M1", effectiveFrom: "2026-10", gitlabUsername: "@Taro" }),
      member({ memberId: "M2", effectiveFrom: "2026-04", gitlabUsername: "hanako" }),
      member({ memberId: "M2", effectiveFrom: "2026-11" }),
      member({ memberId: "M3", effectiveFrom: "2027-01", gitlabUsername: "future" }),
      member({ memberId: "M4", effectiveFrom: "2026-04" }),
    ];
    expect([...gitlabUsernameIndex(members, "2026-10")]).toEqual([
      ["future", "M3"],
      ["hanako", "M2"],
      ["taro", "M1"],
    ]);
    expect([...gitlabUsernameIndex(members, "2026-09")].map(([u]) => u)).toEqual(["future", "hanako"]);
    expect([...gitlabUsernameIndex(members, "2026-11")].map(([u]) => u)).toEqual(["future", "taro"]);
  });
  it("同じユーザー名が複数の人に付いていたら、その名前では誰も出さず警告", () => {
    const members = [member({ memberId: "M1", gitlabUsername: "same" }), member({ memberId: "M2", gitlabUsername: "SAME" }), member({ memberId: "M3", gitlabUsername: "solo" })];
    expect([...gitlabUsernameIndex(members, "2026-10")]).toEqual([["solo", "M3"]]);
    expect(duplicateGitlabUsernames(members)).toEqual([{ username: "same", memberIds: ["M1", "M2"] }]);
    const issues = validateDataset(dataset({ members })).filter((i) => i.code === "GITLAB_USERNAME_DUPLICATE");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ severity: "warning", file: "masters/members.csv" });
    expect(issues[0]!.message).toContain("M1、M2");
  });
});

describe("members.csv の gitlab_username 列", () => {
  const header = "member_id,name,kind,title,department,section,team_id,effective_from";
  it("任意の列。無いファイルも読める", () => {
    const base = {
      config: baseConfig,
      contracts: "contract_id,customer_name,project_name,team_id,start_month,end_month,total_amount\n",
      mapping: "worklog_customer_name,worklog_project_name,contract_id\n",
      assignments: "member_id,contract_id,start_month,end_month,allocation\n",
      teams: "team_id,name,parent_team_id,effective_from\n",
      rates: "key,hourly_rate,effective_from\n",
      holidays: "date,name\n",
      worklogs: [],
    };
    const without = parseDataset({ ...base, members: `${header}\nM1,太郎,employee,SE,部,課,,2026-04\n` });
    expect(without.dataset.members[0]!.gitlabUsername).toBeUndefined();
    const withCol = parseDataset({ ...base, members: `${header},gitlab_username\nM1,太郎,employee,SE,部,課,,2026-04, taro \n` });
    expect(withCol.dataset.members[0]!.gitlabUsername).toBe("taro");
  });
  it("メンバーの取り込みで消えない（変わった人の新しい行にも引き継ぐ）", () => {
    const existing = [{ member_id: "M1", name: "太郎", kind: "employee", title: "SE", division: "", department: "部", section: "課", team_id: "", effective_from: "2026-04", status: "", gitlab_username: "taro" }];
    const res = mergeMembers(existing, [{ memberId: "M1", name: "太郎", title: "主任" }], "2026-10");
    expect(res.rows.map((r) => [r.effective_from, r.title, r.gitlab_username])).toEqual([
      ["2026-04", "SE", "taro"],
      ["2026-10", "主任", "taro"],
    ]);
    expect(formatMembersCsv(res.rows, Object.keys(existing[0]!)).split("\n")[0]).toContain("gitlab_username");
  });
});

describe("buildMyHoursPayload", () => {
  it("ユーザー名のある人だけ、基準月と翌月の行", () => {
    const p = buildMyHoursPayload({
      asOf: "2026-10-27",
      asOfFixed: false,
      asOfMonth: "2026-10",
      members: [member({ memberId: "M1", name: "太郎", gitlabUsername: "Taro" }), member({ memberId: "M2", name: "花子" })],
      memberMonths: [mm("M1", "2026-10", [line("C1", 80, 10)]), mm("M1", "2026-11", [line("C1", 80, 0)]), mm("M1", "2026-12", [line("C1", 80, 0)]), mm("M2", "2026-10", [line("C1", 8, 0)])],
      contractOf,
    });
    expect(p.users).toEqual({ "2026-10": { taro: "M1" }, "2026-11": { taro: "M1" } });
    expect(Object.keys(p.members)).toEqual(["M1"]);
    expect(p.members.M1!.name).toBe("太郎");
    expect(Object.keys(p.members.M1!.months)).toEqual(["2026-10", "2026-11"]);
    expect(p.members.M1!.months["2026-10"]).toEqual([{ label: "勘定系保守", sub: "顧客C1", contractId: "C1", plannedHours: 80, actualHours: 10 }]);
  });

  it("ユーザー名の付け替えは月ごとに引く（翌月から別の人に付けたら翌月はその人）", () => {
    const p = buildMyHoursPayload({
      asOf: "2026-10-27",
      asOfFixed: false,
      asOfMonth: "2026-10",
      members: [
        member({ memberId: "M1", name: "太郎", effectiveFrom: "2026-04", gitlabUsername: "taro" }),
        member({ memberId: "M1", name: "太郎", effectiveFrom: "2026-11" }),
        member({ memberId: "M2", name: "次郎", effectiveFrom: "2026-04" }),
        member({ memberId: "M2", name: "次郎", effectiveFrom: "2026-11", gitlabUsername: "taro" }),
      ],
      memberMonths: [],
      contractOf: () => undefined,
    });
    expect(p.users).toEqual({ "2026-10": { taro: "M1" }, "2026-11": { taro: "M2" } });
    expect(Object.keys(p.members)).toEqual(["M1", "M2"]);
  });
});

describe("myHoursCard", () => {
  it("残り・計画・実績と案件ごとの行。超えた行は「超過」", () => {
    const el = myHoursCard(document, { name: "太郎", memberHref: "./member?id=M1", rows: [{ label: "勘定系保守", sub: "あおば銀行", plannedHours: 80, actualHours: 68.75 }, { label: "学習管理保守", plannedHours: 8, actualHours: 11.5 }] }, T.myHours);
    expect(el.querySelector(".yn-my-hours-big")?.textContent).toBe("残り 7.75h");
    expect(el.querySelector(".yn-my-hours-sub")?.textContent).toBe("計画 88h ・ 実績 80.25h");
    const cells = [...el.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(cells).toEqual([
      ["勘定系保守あおば銀行", "80h", "68.75h", "11.25h"],
      ["学習管理保守", "8h", "11.5h", "超過 3.5h"],
    ]);
    expect(el.querySelector(".yn-my-hours-project-sub")?.textContent).toBe("あおば銀行");
    expect(el.querySelector(".yn-my-hours-bar-over")).toBeNull();
    expect(el.querySelector("a")?.getAttribute("href")).toBe("./member?id=M1");
  });
  it("全体で超えたら赤。行が無ければ「計画も実績もありません」", () => {
    const over = myHoursCard(document, { rows: [{ label: "a", plannedHours: 1, actualHours: 2 }] }, T.myHours);
    expect(over.querySelector(".yn-my-hours-big")?.className).toContain("is-over");
    expect(over.querySelector(".yn-my-hours-big")?.textContent).toBe("超過 1h");
    // バーは計画の分と超えた分に分ける（計画 1h・実績 2h → 半分ずつ）
    expect(over.querySelector<HTMLElement>(".yn-my-hours-bar-used")?.style.width).toBe("50%");
    expect(over.querySelector<HTMLElement>(".yn-my-hours-bar-over")?.style.width).toBe("50%");
    const empty = myHoursCard(document, { rows: [] }, T.myHours);
    expect(empty.querySelector("table")).toBeNull();
    expect(empty.textContent).toContain(T.myHours.noPlan);
  });
});

describe("ヘッダーのスクリプト（runMyHours）", () => {
  const payload = {
    asOf: "2026-10-27",
    asOfFixed: true,
    users: { "2026-10": { taro: "M1" } } as Record<string, Record<string, string>>,
    members: { M1: { name: "太郎", months: { "2026-10": [{ label: "勘定系保守", contractId: "C1", plannedHours: 80, actualHours: 70 }] } } },
  };
  const tick = () => new Promise((r) => setTimeout(r, 0));
  function setup(token: string | null, user: string | null) {
    document.body.innerHTML = `<div class="yn-topbar"><div class="yn-filter-fetched"></div><nav class="yn-tools"><a class="yn-tool">リソース計画</a></nav></div>`;
    sessionStorage.clear();
    localStorage.clear();
    if (token) sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
    const calls: string[] = [];
    const fetch = async (url: string) => {
      calls.push(url);
      if (url.endsWith("/user")) return { ok: user !== null, status: user ? 200 : 401, json: async () => ({ username: user }) };
      if (url.includes("my-month.json")) return { ok: true, status: 200, json: async () => payload };
      return { ok: false, status: 404, json: async () => null };
    };
    Object.assign(window, { fetch });
    return calls;
  }
  const cfg = myHoursConfig({ mode: "gitlab", gitlab: { apiBaseUrl: "https://g/api/v4/" } }, T.myHours);

  it("トークンの持ち主の今月の残りを右上に出し、押すと内訳が開く", async () => {
    const calls = setup("glpat-x", "Taro");
    runMyHours(cfg, window, myHoursCard);
    await tick();
    await tick();
    const btn = document.querySelector<HTMLButtonElement>(".yn-my-hours-btn");
    expect(btn?.textContent).toBe("今月の残り10h");
    expect(document.querySelector(".yn-topbar")?.classList.contains("has-my-hours")).toBe(true);
    expect(calls[0]).toBe("https://g/api/v4/user");
    const pop = document.querySelector<HTMLElement>(".yn-my-hours-pop")!;
    expect(pop.hidden).toBe(true);
    btn!.click();
    expect(pop.hidden).toBe(false);
    expect(pop.querySelector(".yn-my-hours-name")?.textContent).toBe("太郎");
    document.body.click();
    expect(pop.hidden).toBe(true);
    // 2 回目からはユーザー名を覚えている（GitLab を呼ばない）
    const again = setup("glpat-x", "Taro");
    localStorage.setItem("yojitsu-navi:gitlab-me:v1", JSON.stringify({ u: "taro", t: `${"glpat-x".length}:${"glpat-x".slice(-4)}`, at: Date.now() }));
    runMyHours(cfg, window, myHoursCard);
    await tick();
    await tick();
    expect(again.some((u) => u.endsWith("/user"))).toBe(false);
    expect(document.querySelector(".yn-my-hours-btn")).not.toBeNull();
  });
  it("設定画面でトークンを消す・別の人のトークンにすると、出し直す", async () => {
    // 他のテストの登録が残らないよう、別のウィンドウで動かす
    const store = () => {
      const m = new Map<string, string>();
      return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), removeItem: (k: string) => void m.delete(k), clear: () => m.clear() };
    };
    const doc = document.implementation.createHTMLDocument("");
    doc.body.innerHTML = `<div class="yn-topbar"><nav class="yn-tools"></nav></div>`;
    Object.defineProperty(doc, "readyState", { value: "complete" });
    let who = "Taro";
    const w = Object.assign(new EventTarget(), {
      document: doc,
      sessionStorage: store(),
      localStorage: store(),
      URL,
      CustomEvent,
      location: { href: "https://example.invalid/" },
      fetch: async (url: string) =>
        url.endsWith("/user") ? { ok: true, status: 200, json: async () => ({ username: who }) } : { ok: true, status: 200, json: async () => payload },
    });
    w.sessionStorage.setItem(TOKEN_STORAGE_KEY, "glpat-aaaa");
    runMyHours(cfg, w, myHoursCard);
    await tick();
    await tick();
    const count = () => w.document.querySelectorAll(".yn-my-hours").length;
    expect(count()).toBe(1);
    // 消す（clearToken は yn-mr-count に null を送る）
    w.sessionStorage.clear();
    w.dispatchEvent(new w.CustomEvent("yn-mr-count", { detail: null }));
    await tick();
    expect(count()).toBe(0);
    expect(w.document.querySelector(".yn-topbar")?.classList.contains("has-my-hours")).toBe(false);
    // 別の人のトークン（マスタに無い人）→ 出さない
    who = "someone";
    w.sessionStorage.setItem(TOKEN_STORAGE_KEY, "glpat-bbbb");
    w.dispatchEvent(new w.CustomEvent("yn-mr-count", { detail: undefined }));
    await tick();
    await tick();
    expect(count()).toBe(0);
    // 本人のトークンに戻す → 出る（重ならない）。件数の通知（数）だけでは出し直さない
    who = "Taro";
    w.localStorage.clear();
    w.sessionStorage.setItem(TOKEN_STORAGE_KEY, "glpat-cccc");
    w.dispatchEvent(new w.CustomEvent("yn-mr-count", { detail: undefined }));
    await tick();
    await tick();
    w.dispatchEvent(new w.CustomEvent("yn-mr-count", { detail: 3 }));
    await tick();
    await tick();
    expect(count()).toBe(1);
  });
  it("トークンが無い・マスタにユーザー名が無い・接続先が無いときは何も出さない", async () => {
    setup(null, "taro");
    runMyHours(cfg, window, myHoursCard);
    await tick();
    expect(document.querySelector(".yn-my-hours")).toBeNull();
    setup("glpat-x", "someone");
    runMyHours(cfg, window, myHoursCard);
    await tick();
    await tick();
    expect(document.querySelector(".yn-my-hours")).toBeNull();
    setup("glpat-x", "taro");
    runMyHours(myHoursConfig({ mode: "download" }, T.myHours), window, myHoursCard);
    await tick();
    await tick();
    expect(document.querySelector(".yn-my-hours")).toBeNull();
  });
  it("デモはデモの利用者として出す（GitLab を呼ばない）", async () => {
    expect(DEMO_USERNAME).toBe(DEMO_USER.username);
    const calls = setup("demo", null);
    payload.users = { "2026-10": { [DEMO_USERNAME]: "M1" } };
    runMyHours(myHoursConfig({ mode: "demo" }, T.myHours), window, myHoursCard);
    await tick();
    await tick();
    expect(calls.some((u) => u.endsWith("/user"))).toBe(false);
    expect(document.querySelector(".yn-my-hours-btn")).not.toBeNull();
    payload.users = { "2026-10": { taro: "M1" } };
  });
  it("埋め込みスクリプトに </script> を含めない", () => {
    expect(myHoursScript({ ...cfg, labels: { ...T.myHours, title: "</script>" } })).not.toContain("</script>");
  });
});
