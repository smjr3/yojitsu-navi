/**
 * データ確認ページ用: CSV 読み込み時の問題 ＋ validateDataset の結果（scripts/validate-data.ts と同じ内容）
 */
import { checkProjects, type ValidationIssue } from "../core/index.js";
import { buildStamp, emitJson, loadParsed, resolveAsOf } from "./_shared.js";

emitJson(() => {
  const parsed = loadParsed();
  // parsed.issues は validateDataset の結果も含む（もう一度かけると同じ問題が文面違いで二重に出る）
  const all = parsed.issues;
  const seen = new Set<string>();
  const issues: ValidationIssue[] = [];
  for (const i of all) {
    const key = `${i.severity}|${i.code}|${i.file ?? ""}|${i.row ?? ""}|${i.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    issues.push(i);
  }
  const order = { error: 0, warning: 1 } as const;
  issues.sort((a, b) => order[a.severity] - order[b.severity] || (a.file ?? "").localeCompare(b.file ?? "") || (a.row ?? 0) - (b.row ?? 0));

  return {
    asOf: resolveAsOf(),
    issues,
    summary: {
      contracts: parsed.dataset.contracts.length,
      members: parsed.dataset.members.length,
      worklogs: parsed.dataset.worklogs.length,
      errors: issues.filter((i) => i.severity === "error").length,
      warnings: issues.filter((i) => i.severity === "warning").length,
    },
    // 正式な案件の一覧との照合（§98）。一覧が無ければ enabled: false
    projects: checkProjects(parsed.dataset.contracts, parsed.dataset.projects),
    _build: buildStamp(),
  };
});
