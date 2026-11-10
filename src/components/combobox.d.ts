export interface ComboOption {
  value: string;
  label: string;
  sub?: string;
  search?: string;
  muted?: boolean;
}
export const COMBO_MAX: number;
export function normalizeQuery(text: unknown): string;
export function filterOptions<T extends ComboOption>(options: readonly T[], query: string): T[];
export function combobox(opts: Record<string, unknown>): HTMLElement & { setValue(v: string): void; getValue(): string; input: HTMLInputElement };
