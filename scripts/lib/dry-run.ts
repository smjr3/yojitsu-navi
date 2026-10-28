/**
 * --dry-run の表示（列の対応表）。列名だけを出し、応答の値は出さない
 */
import type { FetchReport } from "../adapters/http-source.js";

export function formatMappingTable(r: FetchReport): string[] {
  const out: string[] = [];
  out.push(`応答 ${r.rawRowCount} 行（filters で除外 ${r.filteredOut} 行）`);
  out.push(`応答の最初の1行の列名: ${r.rawColumns.length > 0 ? r.rawColumns.join(", ") : "（なし）"}`);
  out.push("列の対応表（予実ナビの項目 <- 取得元の列）:");
  for (const m of r.mapping) {
    const cand = m.candidates.join(" / ") || "未設定";
    out.push(`  ${m.field.padEnd(13)} <- ${cand}${m.resolved ? `  [使う列: ${m.resolved}]` : "  [見つかりません]"}`);
  }
  return out;
}
