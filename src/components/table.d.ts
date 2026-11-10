// テストから使う分だけの型（本体は table.js）
export interface FilterColumn {
  key: string;
  label: string;
  type?: string;
  get?: (row: any) => unknown;
  render?: (row: any, unit: string) => unknown;
  exportValue?: (row: any, unit: string) => unknown;
  filterValue?: (row: any) => string | string[];
  dateValue?: (row: any) => string | null | (string | null | undefined)[];
}
export type ColumnFilter = { q?: string; values?: string[] | null } | { min?: number; max?: number } | { from?: string; to?: string } | null;
export function matchesFilter(col: FilterColumn, f: ColumnFilter, row: any, unit: string): boolean;
/** 日付の絞り込みの入力（年・年月・日）→ "YYYY" | "YYYY-MM" | "YYYY-MM-DD"。空は null、読めないときは undefined（SPEC §109） */
export function parseDateFilterInput(text: string): string | null | undefined;
export function safeFileName(name: string): string;
/** 木構造の表の絞り込み: 一致した行とその祖先を元の並びで残す（SPEC §70） */
export function treeFilteredRows<T extends { key: any; parentKey?: any }>(rows: T[], matched: T[], onKeys?: (matched: Set<any>, parents: Set<any>) => void): T[];
