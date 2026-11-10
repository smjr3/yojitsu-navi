// テストから使う分だけの型（本体は column-prefs.js）
export interface ColumnPrefs {
  order: string[];
  hidden: string[];
  /** 選べる列（optional）のうち出す列 */
  shown?: string[];
}
export function loadColumnPrefs(id: string): ColumnPrefs;
export function saveColumnPrefs(id: string, prefs: ColumnPrefs): void;
export function orderColumns<T>(cols: T[], prefs: ColumnPrefs, keyOf?: (c: T) => string): T[];
export function arrangeColumns<T>(cols: T[], prefs: ColumnPrefs, keyOf?: (c: T) => string): T[];
export function isCustomized<T>(cols: T[], prefs: ColumnPrefs, keyOf?: (c: T) => string): boolean;
export function hiddenKeys<T>(cols: T[], prefs: ColumnPrefs, keyOf?: (c: T) => string): Set<string>;
