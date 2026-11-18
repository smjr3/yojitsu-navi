/**
 * 氏名にカーソルを合わせる・フォーカスすると出す、メンバーの吹き出し（SPEC §148）
 *
 *   setMemberTipModel(model)      … pageHeader が呼ぶ（全ページ共通。model.json だけで作る）
 *   memberTipAttrs(memberId)      … 氏名の要素に付ける属性 { "data-member-tip": id }
 *
 * 性能（§107）: 行ごとに吹き出しを作らない。文書に 1 組だけ委譲のリスナーを付け、
 * 合わせたときに中身を 1 つだけ作る。今月の計画・実績の集計は初めて出すときに 1 回だけ作って使い回す。
 * タッチ（指）では出さない（押すと従来どおり詳細へ移る）。体制図は自前の吹き出しがあるので使わない。
 */
import { T, fmt } from "../i18n/index.js";
import { h } from "./dom.js";
import { placeNear } from "./plan-cell.js";
import { dateJa, decimal, formatHours, monthJa } from "./format.js";
import { createMonthHours } from "../core/index.js";
import { treeAt } from "./analysis.js";

const ATTR = "data-member-tip";
const TOP_PROJECTS = 3;

let model = null;
let cache = null;
let el = null;
let anchor = null;
let installed = false;

export function memberTipAttrs(memberId) {
  return memberId ? { [ATTR]: memberId } : {};
}

export function setMemberTipModel(m) {
  if (!m || m === model) return;
  model = m;
  cache = null;
  install();
}

/** 今月の人ごとの計画・実績（案件別）。初めて出すときに 1 回だけ作る */
function monthIndex() {
  if (cache) return cache;
  const month = model.meta.asOfMonth;
  const byMember = new Map();
  const slot = (id, c) => {
    let m = byMember.get(id);
    if (!m) byMember.set(id, (m = { plan: 0, actual: 0, contracts: new Map() }));
    let x = m.contracts.get(c.contractId);
    if (!x) m.contracts.set(c.contractId, (x = { contract: c, plan: 0, actual: 0 }));
    return [m, x];
  };
  for (const c of model.contracts ?? []) {
    for (const l of c.assignmentPlan?.lines ?? []) {
      if (l.month !== month) continue;
      const [m, x] = slot(l.memberId, c.contract);
      m.plan += l.hours;
      x.plan += l.hours;
    }
    const mo = c.months?.find((x) => x.month === month);
    for (const l of mo?.costLines ?? []) {
      if (!l.memberId || l.costType !== "labor") continue;
      const [m, x] = slot(l.memberId, c.contract);
      m.actual += l.hours;
      x.actual += l.hours;
    }
  }
  const { tree } = treeAt(model, month);
  cache = { month, byMember, tree };
  return cache;
}

/** a が b と同じか b の配下か */
function within(tree, a, b) {
  for (let id = a, n = 0; id && n < 50; id = tree[id]?.parentTeamId, n++) if (id === b) return true;
  return false;
}

function recordsOf(id) {
  return model.members.filter((r) => r.memberId === id).sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
}

function content(id) {
  const { month, byMember, tree } = monthIndex();
  const recs = recordsOf(id);
  if (!recs.length) return null;
  const cur = recs.filter((r) => r.effectiveFrom <= month).at(-1) ?? recs[0];
  const prev = recs.filter((r) => r.effectiveFrom < cur.effectiveFrom).at(-1);

  const teamName = (tid) => tree[tid]?.name ?? model.teams.find((t) => t.teamId === tid)?.name ?? "";
  const isLeft = cur.status === "left";
  const kids = [h("p", { class: "yn-plan-tip-head" }, cur.title ? fmt(T.memberTip.head, { name: cur.name, title: cur.title }) : cur.name)];

  // チーム（リーダーの印）
  const leads = cur.teamId && tree[cur.teamId]?.leaderMemberId === id;
  kids.push(h("p", null, cur.teamId ? teamName(cur.teamId) : T.memberTip.noTeam, leads ? h("span", { class: "yn-chip yn-chip-neutral yn-member-tip-chip" }, T.memberTip.leader) : null));

  // 在籍の状態・異動
  const when = (r) => (r.statusDate ? dateJa(r.statusDate) : monthJa(r.effectiveFrom));
  // 不在の行が続いていれば、いちばん早い行の日付から
  let leftRec = cur;
  for (let i = recs.indexOf(cur) - 1; isLeft && i >= 0 && recs[i].status === "left"; i--) leftRec = recs[i];
  if (isLeft) kids.push(h("p", { class: "yn-member-tip-warn" }, fmt(T.memberTip.leftFrom, { when: when(leftRec) })));
  else if (prev && cur.effectiveFrom === month && prev.teamId !== cur.teamId) kids.push(h("p", null, fmt(T.memberTip.movedIn, { team: prev.teamId ? teamName(prev.teamId) : T.memberTip.noTeam })));
  // 来月以降の予定: 役職だけの変更は飛ばし、最初の異動・不在を出す
  let next = null;
  for (let i = recs.indexOf(cur) + 1, last = cur; i < recs.length; last = recs[i], i++) {
    if (recs[i].effectiveFrom <= month) continue;
    if (recs[i].status === "left" || recs[i].teamId !== last.teamId) {
      next = recs[i];
      break;
    }
  }
  if (!isLeft && next) {
    if (next.status === "left") kids.push(h("p", { class: "yn-member-tip-warn" }, fmt(T.memberTip.leftFrom, { when: when(next) })));
    else if (next.teamId !== cur.teamId) kids.push(h("p", null, fmt(T.memberTip.moveTo, { month: monthJa(next.effectiveFrom), team: next.teamId ? teamName(next.teamId) : T.memberTip.noTeam })));
  }

  // 今月の計画・実績、主な案件
  const m = byMember.get(id);
  if (m && (m.plan > 0 || m.actual > 0)) {
    const cfg = model.config;
    kids.push(
      h(
        "ul",
        { class: "yn-plan-tip-list" },
        h("li", null, h("span", null, T.memberTip.plan), h("span", { class: "num" }, fmt(T.memberTip.planValue, { pm: fmt(T.numbers.personMonths, { value: decimal(m.plan / createMonthHours(model.holidays, cfg.hoursPerBusinessDay)(month), 2) }), hours: formatHours(m.plan) }))),
        h("li", null, h("span", null, T.memberTip.actual), h("span", { class: "num" }, formatHours(m.actual))),
      ),
    );
    const list = [...m.contracts.values()].sort((a, b) => b.actual + b.plan - (a.actual + a.plan));
    kids.push(h("p", { class: "yn-member-tip-sub" }, T.memberTip.projects));
    kids.push(
      h(
        "ul",
        { class: "yn-plan-tip-list" },
        list.slice(0, TOP_PROJECTS).map((x) => {
          const support = cur.teamId && x.contract.teamId && !within(tree, x.contract.teamId, cur.teamId) && !within(tree, cur.teamId, x.contract.teamId);
          return h(
            "li",
            null,
            h("span", null, `${x.contract.customerName} / ${x.contract.projectName}`, support ? [h("br"), h("small", null, fmt(T.memberTip.support, { team: teamName(x.contract.teamId) }))] : null),
            h("span", { class: "num" }, fmt(T.memberTip.projectValue, { actual: formatHours(x.actual), plan: formatHours(x.plan) })),
          );
        }),
      ),
    );
    if (list.length > TOP_PROJECTS) kids.push(h("p", { class: "yn-plan-tip-foot" }, fmt(T.memberTip.more, { n: list.length - TOP_PROJECTS })));
  } else if (!isLeft) kids.push(h("p", { class: "yn-plan-tip-foot" }, T.memberTip.none));
  return h("div", null, kids);
}

function show(target) {
  if (!model || target === anchor) return;
  const id = target.getAttribute(ATTR);
  let body = null;
  try {
    body = content(id);
  } catch {
    body = null; // 吹き出しの失敗で画面を壊さない
  }
  if (!body) return hide();
  if (!el) {
    el = h("div", { class: "yn-plan-tip yn-member-tip", role: "tooltip", id: "yn-member-tip", hidden: true });
    document.body.append(el);
  }
  hide();
  anchor = target;
  el.replaceChildren(body);
  el.hidden = false;
  placeNear(el, target, { width: 340 });
  target.setAttribute("aria-describedby", "yn-member-tip");
}

function hide() {
  if (el) el.hidden = true;
  anchor?.removeAttribute("aria-describedby");
  anchor = null;
}

function install() {
  if (installed || typeof document === "undefined") return;
  installed = true;
  const find = (t) => (t instanceof Element ? t.closest(`[${ATTR}]`) : null);
  document.addEventListener("pointerover", (e) => {
    if (e.pointerType === "touch") return;
    const t = find(e.target);
    if (t) show(t);
    else if (anchor && !anchor.contains(e.target)) hide();
  });
  document.addEventListener("pointerout", (e) => {
    if (anchor && !anchor.contains(e.relatedTarget)) hide();
  });
  // 押してフォーカスが移ったとき（指・マウス）は出さない。キーボードで移ったときだけ出す
  let byPointer = false;
  document.addEventListener("pointerdown", () => (byPointer = true), { capture: true });
  document.addEventListener("keydown", () => (byPointer = false), { capture: true });
  document.addEventListener("focusin", (e) => {
    if (byPointer) return;
    const t = find(e.target);
    if (t) show(t);
    else hide();
  });
  document.addEventListener("focusout", (e) => {
    if (anchor && !anchor.contains(e.relatedTarget)) hide();
  });
  document.addEventListener("keydown", (e) => e.key === "Escape" && hide());
  // 押した（指で触れた）ら閉じる
  document.addEventListener("pointerdown", hide, { capture: true });
  // スクロールしたら付いていく（画面から外れたら消す）
  addEventListener(
    "scroll",
    () => {
      if (!anchor) return;
      const r = anchor.getBoundingClientRect();
      if (!anchor.isConnected || r.bottom < 0 || r.top > document.documentElement.clientHeight) hide();
      else placeNear(el, anchor, { width: 340 });
    },
    { passive: true, capture: true },
  );
}
