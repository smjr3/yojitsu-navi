/**
 * データ確認の作業実績の一覧に「誰の作業か」を付ける（SPEC §100）。
 *
 * - peopleColumn(model): 「作業した人」の列（最も時間の多い人 ＋ ほか n 人。押すと人ごとの時間。列の絞り込みは人で選べる）
 * - groupedWorklogTable({ model, groups, columns, ... }): 「案件ごと／人ごと」を切り替えられる表。
 *   人ごとは、一覧のまとまりを社員番号で集め直す（時間・件数・まとまりの数・最後の日。押すとその人のまとまり）
 */
import { html } from "htl";
import { T, fmt } from "../i18n/index.js";
import { dataTable } from "./table.js";
import { formatHours, integer } from "./format.js";
import { teamName } from "./analysis.js";

/** 社員番号 → 最新のマスタの行（無ければ undefined） */
function latestMembers(model) {
  const map = new Map();
  for (const m of model.members ?? []) {
    const hit = map.get(m.memberId);
    if (!hit || m.effectiveFrom >= hit.effectiveFrom) map.set(m.memberId, m);
  }
  return map;
}

/** 表示する名前と所属。マスタにあればマスタの名前、無ければ作業実績の名前 */
function personOf(model, latest, p) {
  const rec = latest.get(p.memberId);
  const name = rec?.name || p.memberName || p.memberId || T.dataCheck.empty;
  const team = !rec ? T.team.unregistered : rec.teamId ? teamName(model, rec.teamId) : T.members.noTeam;
  return { memberId: p.memberId, name, team, unknown: !rec };
}

/** マスタに無い人の印（メンバー一覧と同じ） */
const unknownChip = (p) => (p.unknown ? html` <span class="yn-chip yn-chip-neutral" title=${T.members.chipUnknownTitle}>${T.members.chipUnknown}</span>` : null);

const label = (p) => (p.memberId ? `${p.memberId} ${p.name}` : p.name);

/** 「作業した人」の列 */
export function peopleColumn(model) {
  const latest = latestMembers(model);
  const people = (r) => (r.members ?? []).map((p) => ({ ...personOf(model, latest, p), hours: p.hours, count: p.count }));
  return {
    key: "people",
    label: T.dataCheck.colPeople,
    type: "custom",
    get: (r) => people(r)[0]?.name ?? "",
    render: (r) => {
      const list = people(r);
      if (list.length === 0) return T.dataCheck.empty;
      const top = list[0];
      return html`<span>${top.name}${unknownChip(top)}${list.length > 1 ? html`<span class="yn-muted">${fmt(T.dataCheck.peopleMore, { n: list.length - 1 })}</span>` : null}</span>`;
    },
    filterValue: (r) => people(r).map(label),
    exportValue: (r) => people(r).map((p) => `${label(p)}（${p.hours}）`).join("、"),
    breakdown: (r) => ({
      title: T.dataCheck.colPeople,
      subtitle: [r.customerName, r.projectName ?? r.task].filter(Boolean).join(" / ") || r.taskCode || "",
      sections: [
        {
          table: {
            columns: [{ label: T.members.colMemberId }, { label: T.dataCheck.colName }, { label: T.members.colTeam }, { label: T.columns.hours, align: "num" }, { label: T.dataCheck.colCount, align: "num" }],
            rows: people(r).map((p) => [p.memberId || T.dataCheck.empty, p.name, p.team, formatHours(p.hours), integer(p.count)]),
          },
        },
      ],
    }),
  };
}

/**
 * まとまりを人ごとに集め直す。groupName(g) は人の内訳に出すまとまりの名前
 * @returns {{key, memberId, name, team, unknown, hours, count, groups, lastDate, items: {name, hours, count}[]}[]}
 */
export function byPerson(model, groups, groupName) {
  const latest = latestMembers(model);
  const acc = new Map();
  for (const g of groups) {
    for (const p of g.members ?? []) {
      let a = acc.get(p.memberId);
      if (!a) acc.set(p.memberId, (a = { key: p.memberId || "\u0000", ...personOf(model, latest, p), hours: 0, count: 0, groups: 0, lastDate: "", items: [] }));
      a.hours += p.hours;
      a.count += p.count;
      a.groups += 1;
      // その人の最後の日（まとまりの最後の日ではない）
      if (p.lastDate > a.lastDate) a.lastDate = p.lastDate;
      a.items.push({ name: groupName(g), hours: p.hours, count: p.count });
    }
  }
  for (const a of acc.values()) a.items.sort((x, y) => y.hours - x.hours);
  return [...acc.values()];
}

const AXES = ["group", "person"];

/**
 * 「案件ごと／人ごと」を切り替えられる表
 * @param {{model, groups, columns, caption, exportName, sort, groupName(g), groupLabel?}} opts
 */
export function groupedWorklogTable({ model, groups, columns, caption, exportName, sort, groupName, groupLabel = T.dataCheck.groupProject }) {
  const root = html`<div class="yn-grouped-worklogs"></div>`;
  let axis = "group";
  const rows = groups.map((g, i) => ({ key: i, ...g }));
  const personRows = () => byPerson(model, groups, groupName);
  const toolbar = () => {
    const seg = html`<div class="yn-seg yn-seg-sm" role="group" aria-label=${T.dataCheck.axisLabel}></div>`;
    for (const id of AXES) {
      const b = html`<button type="button" class="yn-seg-btn" data-axis=${id} aria-pressed=${id === axis ? "true" : "false"}>${id === "group" ? fmt(T.dataCheck.axisBy, { group: groupLabel }) : T.dataCheck.axisPerson}</button>`;
      b.addEventListener("click", () => {
        if (axis === id) return;
        axis = id;
        draw();
        root.querySelector(`[data-axis="${id}"]`)?.focus();
      });
      seg.append(b);
    }
    return seg;
  };
  const personColumns = [
    // 名前を先頭に。社員番号は「列」で選べる列（Excel には常に出す。§106.1）
    { key: "name", label: T.dataCheck.colName, type: "text", render: (r) => html`<span>${r.name}${unknownChip(r)}</span>`, exportValue: (r) => r.name },
    { key: "memberId", label: T.members.colMemberId, type: "text", empty: T.dataCheck.empty, optional: true, exportAlways: true },
    { key: "team", label: T.members.colTeam, type: "text", hideOnPhone: true },
    {
      key: "hours",
      label: T.columns.hours,
      type: "hours",
      breakdown: (r) => ({
        title: `${r.name}（${r.memberId || T.dataCheck.empty}）`,
        subtitle: caption,
        sections: [{ table: { columns: [{ label: groupLabel }, { label: T.columns.hours, align: "num" }, { label: T.dataCheck.colCount, align: "num" }], rows: r.items.map((x) => [x.name, formatHours(x.hours), integer(x.count)]) } }],
      }),
    },
    { key: "count", label: T.dataCheck.colCount, type: "int", hideOnPhone: true },
    { key: "groups", label: fmt(T.dataCheck.colGroups, { group: groupLabel }), type: "int" },
    { key: "lastDate", label: T.dataCheck.colLastDate, type: "text", hideOnPhone: true },
  ];
  const draw = () => {
    const table =
      axis === "group"
        ? dataTable({ columns, rows, caption, exportName, sort, maxHeight: 560, toolbar: toolbar() })
        : dataTable({ columns: personColumns, rows: personRows(), caption, exportName: `${exportName}_by_person`, sort: { key: "hours", dir: "desc" }, maxHeight: 560, toolbar: toolbar() });
    root.replaceChildren(table);
  };
  draw();
  return root;
}
