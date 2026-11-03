/**
 * 取り込み時の作業コードの点検（SPEC §92）。fetch-worklogs が月ファイルを書く前に呼ぶ
 *
 * - 取り込んだ後のデータ（書き換えない月の既存の行 ＋ 取り直した行）で、未登録の作業コードと作業名の変更を探す
 * - 作業名の変更は、取り込む前のデータに無かったものだけ（一度取り込んだ変更は毎回止めない）
 * - config.taskCodeCheck の onUnregistered / onChange が stop なら例外で止める（月ファイルは書かない）。
 *   作業名の変更は、確かめた後に FETCH_ACCEPT_TASK_CHANGES=1（--accept-task-changes）で 1 回だけ通せる
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { csvParse } from "d3-dsv";
import { isMatchChange, findTaskCodeIssues, taskCodeCheckEnabled, taskCodeWarnings, type TaskCodeFindings } from "../../src/core/taskCodes.js";
import type { Config, MappingRule, TaskCodeChange, Worklog } from "../../src/core/types.js";
import { stripBom } from "./csv.js";
import { readTextAuto } from "./encoding.js";

/** mapping.csv の作業コードの行（§92）だけを読む。点検に要るのはこれだけ */
export function readCodeRules(rootDir: string): MappingRule[] {
  const path = join(rootDir, "data", "mapping.csv");
  if (!existsSync(path)) return [];
  const body = stripBom(readTextAuto(path));
  if (body.trim() === "") return [];
  const out: MappingRule[] = [];
  for (const r of csvParse(body)) {
    const code = (r.task_code ?? "").trim();
    if (code === "") continue;
    const rule: MappingRule = { worklogCustomerName: r.worklog_customer_name ?? "", worklogProjectName: r.worklog_project_name ?? "", contractId: (r.contract_id ?? "").trim(), taskCode: code };
    const from = (r.start_month ?? "").trim();
    const to = (r.end_month ?? "").trim();
    if (from !== "") rule.startMonth = from;
    if (to !== "") rule.endMonth = to;
    out.push(rule);
  }
  return out;
}

const changeKey = (c: TaskCodeChange): string => `${c.taskCode}\u0000${c.before}\u0000${c.after}`;

export interface TaskCodeGateResult {
  findings: TaskCodeFindings;
  /** 取り込む前に無かった作業名の変更 */
  newChanges: TaskCodeChange[];
  /** 表示用の 1 行ずつ（警告の文言） */
  lines: string[];
}

/** 点検する（止めない）。設定が無ければ null */
export function inspectTaskCodes(config: Config, rules: readonly MappingRule[], before: readonly Worklog[], after: readonly Worklog[]): TaskCodeGateResult | null {
  const check = config.taskCodeCheck;
  if (!taskCodeCheckEnabled(check)) return null;
  const findings = findTaskCodeIssues(after, rules, check);
  const known = new Set(findTaskCodeIssues(before, rules, check).changes.map(changeKey));
  const newChanges = findings.changes.filter((c) => !known.has(changeKey(c)));
  const lines = taskCodeWarnings({ unregistered: findings.unregistered, changes: newChanges }).map((w) => w.message);
  return { findings, newChanges, lines };
}

const LIST_MAX = 10;

/** stop の設定なら例外を投げる。止めないときは警告の行を返す */
export function enforceTaskCodeGate(config: Config, result: TaskCodeGateResult | null, acceptChanges: boolean): string[] {
  if (!result) return [];
  const check = config.taskCodeCheck;
  const reasons: string[] = [];
  if (check?.onUnregistered === "stop" && result.findings.unregistered.length > 0) {
    reasons.push(`運用保守のキーワードに合う未登録の作業コードが ${result.findings.unregistered.length} 件あります。mapping.csv に task_code の行を足してください`);
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
