// config.json の互換確認（SPEC §96）。Node の標準機能だけで動く（upgrade・update が依存を入れる前にも動かすため）
//
// 設定の項目を宣言で持ち、導入先の config.json が新しい版で動くかだけを見る:
//   エラー（CI を止める）: 必須の項目が無い・型が違う・決まった値のどれでもない・範囲の外
//   注意（止めない）    : この版で使わない項目（打ち間違い・古い版の項目）・名前が変わった／廃止された項目
// 任意の項目は無くても既定値で動くので知らせない（推奨値は CHANGELOG.md の「新しい設定と推奨値」）。
// 「_」で始まる項目（"_comment" など）はメモとして見ない。
//
// 項目を足す・変えるときはここも直す（tests/unit/config-schema.test.ts がリポジトリの config.json と
// テスト用の設定の全項目がここにあることを確かめる）。必須の項目を足すと既存の導入先が止まるので、
// 新しい項目は既定値のある任意の項目にする。項目の名前を変える・やめるときは deprecated に移し方を書く。
// 名前だけを変えたときは renamedTo に新しい項目（"a.b.c"）も書く（yojitsu-navi migrate-config --apply が値を移す。SPEC §104）。

/** @typedef {{ type: string, required?: boolean | ((root: any) => boolean), requiredWhen?: string, enum?: any[], min?: number, max?: number,
 *   props?: Record<string, Node>, additional?: Node, items?: Node, variants?: { key: string, cases: Record<string, Record<string, Node>> },
 *   deprecated?: string, renamedTo?: string, since?: string }} Node */

const str = (o = {}) => ({ type: "string", ...o });
const int = (o = {}) => ({ type: "integer", ...o });
const num = (o = {}) => ({ type: "number", ...o });
const oneOf = (values, o = {}) => ({ type: "string", enum: values, ...o });
const obj = (props, o = {}) => ({ type: "object", props, ...o });
const arr = (items, o = {}) => ({ type: "array", items, ...o });
const column = (o = {}) => ({ type: "columnSpec", ...o });
const scalar = { type: "scalar" };

/** 取り込まない行の条件（§20） */
const FILTER = obj({ column: str({ required: true }), equals: scalar, notEquals: scalar, in: arr(scalar) });
const STOP_WHEN = oneOf(["short", "empty"]);
const MAX_PAGES = int({ min: 1 });
/** ページング（§20.1・§90）。type ごとに項目が違う */
const PAGINATION = {
  type: "object",
  props: { type: oneOf(["none", "page", "offset", "link", "cursor"], { required: true }) },
  variants: {
    key: "type",
    cases: {
      none: {},
      page: { pageParam: str({ required: true }), sizeParam: str(), size: int({ min: 1 }), startPage: int({ min: 0 }), stopWhen: STOP_WHEN, maxPages: MAX_PAGES },
      offset: { offsetParam: str({ required: true }), limitParam: str(), limit: int({ min: 1 }), stopWhen: STOP_WHEN, maxPages: MAX_PAGES },
      link: { maxPages: MAX_PAGES },
      cursor: { cursorPath: str({ required: true }), cursorParam: str({ required: true }), maxPages: MAX_PAGES },
    },
  },
};
const ENCODING = oneOf(["auto", "utf-8", "shift_jis"]);
/** http の取得元の共通の項目（作業実績・人事。url は adapter が http のときだけ必須。authHeader は省略で Authorization） */
function httpOptions(isHttp, extra = {}) {
  const when = { required: isHttp, requiredWhen: "adapter が http のとき" };
  return obj({
    url: str(when),
    authHeader: str(),
    authScheme: str(),
    dataPath: str(),
    method: str(),
    pagination: PAGINATION,
    query: str(),
    filters: arr(FILTER),
    encoding: ENCODING,
    ...extra,
  }, when);
}

const worklogIsHttp = (root) => root?.worklogSource?.adapter === "http";
const memberAdapter = (root) => root?.memberSource?.adapter;
const projectAdapter = (root) => root?.projectSource?.adapter;
const projectImports = (root) => ["csv", "http"].includes(projectAdapter(root));

/** @type {Node} */
export const CONFIG_SCHEMA = obj({
  fiscalYearStartMonth: int({ required: true, min: 1, max: 12 }),
  standardHoursPerMonth: num({ required: true, min: 0, exclusiveMin: true }),
  hoursPerBusinessDay: num({ required: true, min: 0, exclusiveMin: true }),
  burnRateDangerThreshold: num({ required: true, min: 0, exclusiveMin: true }),
  closingBusinessDay: int({ required: true, min: 1 }),
  forecastMethodDefault: oneOf(["recent3", "all", "assignment"], { required: true }),
  forecastRecentMonths: int({ required: true, min: 1 }),
  currency: obj({ code: str(), defaultUnit: oneOf(["yen", "thousandYen", "millionYen"]) }),
  labels: obj({ customer: str(), project: str(), contract: str(), team: str(), member: str() }),
  worklogSource: obj(
    {
      adapter: oneOf(["csv", "http", "dummy"], { required: true }),
      csv: obj({ path: str() }),
      http: httpOptions(worklogIsHttp, {
        refetchMonths: int({ min: 1 }),
        columns: obj(
          {
            date: column({ required: worklogIsHttp }),
            memberId: column({ required: worklogIsHttp }),
            memberName: column({ required: worklogIsHttp }),
            customerName: column({ required: worklogIsHttp }),
            projectName: column({ required: worklogIsHttp }),
            task: column({ required: worklogIsHttp }),
            hours: column({ required: worklogIsHttp }),
            taskCode: column(),
          },
          { required: worklogIsHttp, requiredWhen: "adapter が http のとき" },
        ),
        dateFormat: oneOf(["YYYY-MM-DD", "YYYY/MM/DD", "YYYYMMDD", "ISO8601", "epochMillis"]),
        hoursUnit: oneOf(["hours", "minutes", "seconds"]),
        members: obj({ param: str(), style: oneOf(["join", "repeat"]), separator: str(), chunkSize: int({ min: 1 }) }),
      }),
    },
    { required: true },
  ),
  memberSource: obj({
    adapter: oneOf(["csv", "http", "none"], { required: true }),
    csv: obj(
      { path: str({ required: (root) => memberAdapter(root) === "csv", requiredWhen: "adapter が csv のとき" }), encoding: ENCODING },
      { required: (root) => memberAdapter(root) === "csv", requiredWhen: "adapter が csv のとき" },
    ),
    http: httpOptions((root) => memberAdapter(root) === "http"),
    columns: obj({
      memberId: column({ required: (root) => ["csv", "http"].includes(memberAdapter(root)), requiredWhen: "adapter が csv・http のとき" }),
      name: column({ required: (root) => ["csv", "http"].includes(memberAdapter(root)), requiredWhen: "adapter が csv・http のとき" }),
      kind: column(),
      title: column(),
      division: column(),
      department: column(),
      section: column(),
    }, { required: (root) => ["csv", "http"].includes(memberAdapter(root)), requiredWhen: "adapter が csv・http のとき" }),
    kindMap: { type: "object", props: {}, additional: oneOf(["employee", "partner"]) },
    filters: arr(FILTER),
  }),
  /** 案件管理システムの正式な案件の一覧（§98） */
  projectSource: obj({
    adapter: oneOf(["csv", "http", "none"], { required: true }),
    csv: obj(
      { path: str({ required: (root) => projectAdapter(root) === "csv", requiredWhen: "adapter が csv のとき" }), encoding: ENCODING },
      { required: (root) => projectAdapter(root) === "csv", requiredWhen: "adapter が csv のとき" },
    ),
    http: httpOptions((root) => projectAdapter(root) === "http"),
    columns: obj(
      {
        projectId: column({ required: projectImports, requiredWhen: "adapter が csv・http のとき" }),
        customerName: column({ required: projectImports, requiredWhen: "adapter が csv・http のとき" }),
        projectName: column({ required: projectImports, requiredWhen: "adapter が csv・http のとき" }),
      },
      { required: projectImports, requiredWhen: "adapter が csv・http のとき" },
    ),
    filters: arr(FILTER),
  }),
  /** 作業名から案件名を抜き出して紐付ける（§97。無ければ使わない） */
  projectFromTask: obj({ marker: str(), enabled: { type: "boolean" } }),
  /** 作業名の括弧内をタスクにする（§101。無ければ使わない） */
  taskFromName: obj({ markers: arr(str()), enabled: { type: "boolean" } }),
  costTypes: arr(obj({ id: str({ required: true }), label: str({ required: true }) }), { required: true }),
  masterEdit: obj({
    mode: oneOf(["gitlab", "download", "demo"], { required: true }),
    gitlab: obj({ apiBaseUrl: str(), projectId: { type: "stringOrNumber" }, targetBranch: str(), commitMode: oneOf(["mr", "direct"]), tokenUrl: str() }),
  }),
  taskCodeCheck: obj({
    include: arr(str(), { required: true }),
    exclude: arr(str()),
    onUnregistered: oneOf(["warn", "stop"]),
    onChange: oneOf(["warn", "stop"]),
  }),
});

const TYPE_LABEL = {
  string: "文字列",
  integer: "整数",
  number: "数",
  boolean: "true / false",
  object: "{ … }（項目の集まり）",
  array: "[ … ]（配列）",
  columnSpec: "列名の文字列か、その配列",
  scalar: "文字列・数・true / false",
  stringOrNumber: "文字列か数",
};

function typeOk(type, v) {
  switch (type) {
    case "string":
      return typeof v === "string";
    case "integer":
      return typeof v === "number" && Number.isInteger(v);
    case "number":
      return typeof v === "number" && Number.isFinite(v);
    case "boolean":
      return typeof v === "boolean";
    case "object":
      return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":
      return Array.isArray(v);
    case "columnSpec":
      return typeof v === "string" || (Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "string"));
    case "scalar":
      return ["string", "number", "boolean"].includes(typeof v);
    case "stringOrNumber":
      return typeof v === "string" || (typeof v === "number" && Number.isFinite(v));
    default:
      return true;
  }
}

const show = (v) => {
  const s = JSON.stringify(v);
  return s === undefined ? String(v) : s.length > 60 ? `${s.slice(0, 57)}…` : s;
};

/**
 * config.json（読んだもの）を確かめる。
 * @param {unknown} config
 * @param {Node} [schema]
 * @returns {{ level: "error" | "warning", code: string, path: string, message: string }[]}
 */
export function checkConfig(config, schema = CONFIG_SCHEMA) {
  /** @type {{ level: "error" | "warning", code: string, path: string, message: string }[]} */
  const out = [];
  const err = (code, path, message) => out.push({ level: "error", code, path, message });
  const warn = (code, path, message) => out.push({ level: "warning", code, path, message });

  /** @param {Node} node */
  function visit(node, v, path) {
    if (v === undefined) {
      const req = typeof node.required === "function" ? node.required(config) : node.required;
      if (req) err("CONFIG_MISSING", path, `必須の項目がありません${node.requiredWhen ? `（${node.requiredWhen}）` : ""}`);
      return;
    }
    if (node.deprecated) {
      warn("CONFIG_DEPRECATED", path, node.renamedTo ? `${node.deprecated}（yojitsu-navi migrate-config --apply で ${node.renamedTo} に移せます）` : node.deprecated);
      return;
    }
    if (!typeOk(node.type, v)) {
      err("CONFIG_TYPE", path, `${TYPE_LABEL[node.type] ?? node.type}にしてください（今: ${show(v)}）`);
      return;
    }
    if (node.enum && !node.enum.includes(v)) {
      err("CONFIG_VALUE", path, `${node.enum.map((x) => JSON.stringify(x)).join(" / ")} のどれかにしてください（今: ${show(v)}）`);
      return;
    }
    if (typeof v === "number") {
      const low = node.min !== undefined && (node.exclusiveMin ? v <= node.min : v < node.min);
      const high = node.max !== undefined && v > node.max;
      if (low || high) {
        const range = [node.min !== undefined ? `${node.min} ${node.exclusiveMin ? "より大きい" : "以上"}` : "", node.max !== undefined ? `${node.max} 以下` : ""].filter(Boolean).join("・");
        err("CONFIG_RANGE", path, `${range}にしてください（今: ${show(v)}）`);
      }
      return;
    }
    if (node.type === "array" && node.items) {
      v.forEach((x, i) => visit(node.items, x, `${path}[${i}]`));
      return;
    }
    if (node.type !== "object") return;
    let props = node.props ?? {};
    if (node.variants) {
      const c = node.variants.cases[v[node.variants.key]];
      if (c) props = { ...props, ...c };
    }
    for (const [k, child] of Object.entries(props)) visit(child, v[k], path ? `${path}.${k}` : k);
    for (const [k, x] of Object.entries(v)) {
      if (k in props || k.startsWith("_") || k === "$schema") continue;
      const p = path ? `${path}.${k}` : k;
      if (node.additional) visit(node.additional, x, p);
      else warn("CONFIG_UNKNOWN", p, "この版では使わない項目です（打ち間違いか、古い版の項目。要らなければ消す）");
    }
  }

  if (!typeOk("object", config)) {
    err("CONFIG_TYPE", "", "config.json は { … } の形にしてください");
    return out;
  }
  visit(schema, config, "");
  return out;
}

/** 結果を行にする（エラー → 注意の順） */
export function formatConfigIssues(issues) {
  const errors = issues.filter((i) => i.level === "error");
  const warnings = issues.filter((i) => i.level === "warning");
  const lines = [];
  if (errors.length) lines.push(`エラー（直すまで CI が止まります）: ${errors.length} 件`, ...errors.map((i) => `  - ${i.path || "(全体)"}: ${i.message}`));
  if (warnings.length) lines.push(`注意（止めません）: ${warnings.length} 件`, ...warnings.map((i) => `  - ${i.path}: ${i.message}`));
  return lines;
}

/** BOM を除いて JSON として読む。読めなければ { error } */
export function parseConfigText(text) {
  try {
    return { config: JSON.parse(String(text).replace(/^﻿/, "")) };
  } catch (e) {
    return { error: `config.json を JSON として読めません: ${e instanceof Error ? e.message : String(e)}` };
  }
}
