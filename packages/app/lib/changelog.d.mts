// changelog.mjs の型（テストから読むため）
export declare const CHANGELOG: string;
export declare const NOTE_HEADINGS: string[];
export declare const NEXT_HEADING: string;
export interface ChangelogEntry {
  version: string;
  sections: Map<string, string[]>;
}
export declare function parseChangelog(text: string): ChangelogEntry[];
export declare function versionsBetween(entries: ChangelogEntry[], from: string, to: string): ChangelogEntry[];
export declare function configValue(config: unknown, path: string): unknown;
export declare function settingLines(lines: string[], config: unknown): string[];
export declare function updateNotes(text: string, from: string, to: string, config: unknown): string[];
