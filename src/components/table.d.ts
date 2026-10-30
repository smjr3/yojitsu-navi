// テストから使う分だけの型（本体は table.js）
export interface FilterColumn {
  key: string;
  label: string;
  type?: string;
  get?: (row: any) => unknown;
  render?: (row: any, unit: string) => unknown;
  exportValue?: (row: any, unit: string) => unknown;
  filterValue?: (row: any) => string | string[];
}
export type ColumnFilter = { q?: string; values?: string[] | null } | { min?: number; max?: number } | null;
export function matchesFilter(col: FilterColumn, f: ColumnFilter, row: any, unit: string): boolean;
export function safeFileName(name: string): string;
