export const LOCAL_CI_FILE: string;
export const PLACEHOLDER_KEY: string;
export const PLACEHOLDER: string;
export function lintCiYaml(text: string, file: string, definedElsewhere?: Set<string>): string[];
export function filledKeys(text: string): string[];
export function repairLocalPlaceholder(text: string): string;
export function ciHash(text: string): string;
export function migratedHash(localText: string | null | undefined): string;
export function migrateCi(o: { current: string; base: string; local?: string | null; force?: boolean }): {
  local: string;
  moved: string[];
  same: string[];
  manual: string[];
  changed: boolean;
};
