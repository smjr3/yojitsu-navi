/**
 * 取り込み時の作業コードの点検（SPEC §92）。fetch-worklogs が月ファイルを書く前に呼ぶ
 *
 * - 取り込んだ後のデータ（書き換えない月の既存の行 ＋ 取り直した行）で、未登録の作業コードと作業名の変更を探す
 * - 作業名の変更は、取り込む前のデータに無かったものだけ（一度取り込んだ変更は毎回止めない）
 * - config.taskCodeCheck の onUnregistered / onChange が stop なら例外で止める（月ファイルは書かない）。
 *   作業名の変更は、確かめた後に FETCH_ACCEPT_TASK_CHANGES=1（--accept-task-changes）で 1 回だけ通せる
 * - 作業名から案件名を抜き出す設定（§97）があれば、案件名で契約が見つかる作業は未登録に数えない。
 *   取り込む前に無かった作業コードは「新しい作業コード」として表示だけする（止めない）
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { isValidISODate } from "../../src/core/calendar.js";
import { parseCsvTable } from "../../src/core/csv.js";
import { normalizeCode, normalizeName } from "../../src/core/normalize.js";
import { createProjectMatcher, type ProjectMatcher } from "../../src/core/projectFromTask.js";
import { isMatchChange, findTaskCodeIssues, matchesMaintenance, taskCodeCheckEnabled, taskCodeWarnings, type TaskCodeFindings } from "../../src/core/taskCodes.js";
import type { Config, Contract, ISODate, MappingRule, ProjectAlias, TaskCodeCheckConfig, TaskCodeChange, Worklog } from "../../src/core/types.js";
import { stripBom } from "./csv.js";
import { readTextAuto } from "./encoding.js";

/** mapping.csv の作業コードの行（§92）だけを読む。点検に要るのはこれだけ */
export function readCodeRules(rootDir: string): MappingRule[] {
  const path = join(rootDir, "data", "mapping.csv");
  if (!existsSync(path)) return [];
  const body = stripBom(readTextAuto(path));
  if (body.trim() === "") return [];
  // 画面・検証と同じ読み方（ヘッダ・セルの前後の空白を除く）
  const out: MappingRule[] = [];
  for (const r of parseCsvTable(body).rows) {
    const code = r.get("task_code");
    if (code === "") continue;
    const rule: MappingRule = { worklogCustomerName: r.get("worklog_customer_name"), worklogProjectName: r.get("worklog_project_name"), contractId: r.get("contract_id"), taskCode: code };
    const from = r.get("start_month");
    const to = r.get("end_month");
    if (from !== "") rule.startMonth = from;
    if (to !== "") rule.endMonth = to;
    out.push(rule);
  }
  return out;
}

/** 作業名の案件名の照合（§97）に要る contracts.csv の案件名と別名だけを読む。設定が無ければ使わない */
export function readProjectMatcher(rootDir: string, config: Config): ProjectMatcher {
  const read = (name: string) => {
    const path = join(rootDir, "data", name);
    if (!existsSync(path)) return [];
    const body = stripBom(readTextAuto(path));
    return body.trim() === "" ? [] : parseCsvTable(body).rows;
  };
  if (!config.projectFromTask) return createProjectMatcher(undefined, []);
  const contracts: Contract[] = read("contracts.csv").map((r) => ({ contractId: r.get("contract_id"), customerName: r.get("customer_name"), projectName: r.get("project_name"), teamId: null, startMonth: r.get("start_month"), endMonth: r.get("end_month"), totalAmount: 0 }));
  const aliases: ProjectAlias[] = read("project-aliases.csv").map((r) => ({ alias: r.get("alias"), projectName: r.get("project_name") }));
  return createProjectMatcher(config.projectFromTask, contracts, aliases);
}

const changeKey = (c: TaskCodeChange): string => `${normalizeCode(c.taskCode)}\u0000${normalizeName(c.before)}\u0000${normalizeName(c.after)}`;

export interface TaskCodeGateResult {
  findings: TaskCodeFindings;
  /** 取り込む前に無かった作業名の変更 */
  newChanges: TaskCodeChange[];
  /** 取り込む前に無かった作業コード（§97。表示だけ） */
  newCodes: string[];
  /** 表示用の 1 行ずつ（警告の文言） */
  lines: string[];
}

/** 点検する（止めない）。設定が無ければ null */
export function inspectTaskCodes(config: Config, rules: readonly MappingRule[], before: readonly Worklog[], after: readonly Worklog[], projects?: ProjectMatcher): TaskCodeGateResult | null {
  const check = config.taskCodeCheck;
  const checking = !!check && taskCodeCheckEnabled(check);
  // 作業名の案件名（§97）だけを使うときも、新しい作業コードは知らせる
  if (!checking && !projects?.enabled) return null;
  const findings: TaskCodeFindings = checking ? findTaskCodeIssues(after, rules, check, projects) : { unregistered: [], changes: [] };
  const known = new Set(checking ? findTaskCodeIssues(before, rules, check, projects).changes.map(changeKey) : []);
  const seen = new Set<string>();
  const newChanges: TaskCodeChange[] = [];
  for (const c of [...findings.changes, ...(checking ? replacedNames(before, after, check) : [])]) {
    const k = changeKey(c);
    if (known.has(k) || seen.has(k)) continue;
    seen.add(k);
    newChanges.push(c);
  }
  const lines = taskCodeWarnings({ unregistered: findings.unregistered, changes: newChanges }).map((w) => w.message);
  // 新しい作業コード（§97）: 案件の判定には使わず、発生を知らせるだけ
  const newCodes: string[] = [];
  if (projects?.enabled) {
    const prev = namesByCode(before);
    for (const [code, names] of namesByCode(after)) {
      if (prev.has(code)) continue;
      const first = [...names.values()].reduce((a, b) => (b.firstDate < a.firstDate ? b : a));
      newCodes.push(`${code}（${first.task}、${first.firstDate}〜）`);
    }
    newCodes.sort();
    if (newCodes.length > 0) {
      const shown = newCodes.slice(0, LIST_MAX).join(" / ");
      lines.push(`新しい作業コード ${newCodes.length} 件: ${shown}${newCodes.length > LIST_MAX ? ` ほか ${newCodes.length - LIST_MAX} 件` : ""}`);
    }
  }
  return { findings, newChanges, newCodes, lines };
}

interface NameUse {
  task: string;
  firstDate: ISODate;
  lastDate: ISODate;
}

/** 作業コード → 正規化した作業名 → 使った期間（作業コード・日付・時間が正しい行だけ） */
function namesByCode(rows: readonly Worklog[]): Map<string, Map<string, NameUse>> {
  const out = new Map<string, Map<string, NameUse>>();
  for (const w of rows) {
    const code = normalizeCode(w.taskCode);
    if (code === "" || !isValidISODate(w.date) || !Number.isFinite(w.hours) || w.hours <= 0) continue;
    let names = out.get(code);
    if (!names) out.set(code, (names = new Map()));
    const key = normalizeName(w.task);
    const u = names.get(key);
    if (!u) names.set(key, { task: w.task.trim(), firstDate: w.date, lastDate: w.date });
    else {
      if (w.date < u.firstDate) u.firstDate = w.date;
      if (w.date > u.lastDate) u.lastDate = w.date;
    }
  }
  return out;
}

/**
 * 取り直しで古い作業名の行がすべて置き換わった変更（取り込んだ後のデータだけでは名前が 1 つに見える）。
 * 取り込む前に無かった作業名を、取り込む前に最後に使っていた作業名からの変更とする
 */
function replacedNames(before: readonly Worklog[], after: readonly Worklog[], check: TaskCodeCheckConfig): TaskCodeChange[] {
  const prev = namesByCode(before);
  const out: TaskCodeChange[] = [];
  for (const [code, names] of namesByCode(after)) {
    const old = prev.get(code);
    if (!old || old.size === 0) continue;
    const latest = [...old.values()].reduce((a, b) => (b.lastDate > a.lastDate ? b : a));
    for (const [key, u] of names) {
      if (old.has(key)) continue;
      out.push({ taskCode: code, before: latest.task, after: u.task, changedOn: u.firstDate, matchBefore: matchesMaintenance(check, latest.task), matchAfter: matchesMaintenance(check, u.task) });
    }
  }
  return out;
}

const LIST_MAX = 10;

/** stop の設定なら例外を投げる。止めないときは警告の行を返す */
export function enforceTaskCodeGate(config: Config, result: TaskCodeGateResult | null, acceptChanges: boolean): string[] {
  if (!result) return [];
  const check = config.taskCodeCheck;
  const reasons: string[] = [];
  if (check?.onUnregistered === "stop" && result.findings.unregistered.length > 0) {
    reasons.push(`運用保守のキーワードに合う未登録の作業コードが ${result.findings.unregistered.length} 件あります。${config.projectFromTask ? "作業名の案件名を contracts.csv・project-aliases.csv に合わせるか、" : ""}mapping.csv に task_code の行を足してください`);
  }
  if (check?.onChange === "stop" && !acceptChanges && result.newChanges.length > 0) {
    const matchChanged = result.newChanges.filter(isMatchChange).length;
    reasons.push(`作業名が変わった作業コードが ${result.newChanges.length} 件（うちキーワードの一致が変わったもの ${matchChanged} 件）あります。確かめたら FETCH_ACCEPT_TASK_CHANGES=1 で取り込んでください`);
  }
  if (reasons.length === 0) return result.lines;
  const shown = result.lines.slice(0, LIST_MAX);
  const more = result.lines.length > LIST_MAX ? ` ほか ${result.lines.length - LIST_MAX} 件` : "";
  throw new Error(`${reasons.join("。")}。月ファイルは書き換えていません。${shown.join(" / ")}${more}`);
}
