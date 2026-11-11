export interface MyHoursCardRow {
  label: string;
  sub?: string;
  plannedHours: number;
  actualHours: number;
}
export interface MyHoursConfig {
  enabled: boolean;
  demo: boolean;
  api: string;
  demoUser: string;
  labels: Record<string, string>;
}
export const DEMO_USERNAME: string;
export function myHoursCard(doc: Document, data: { name?: string; memberHref?: string; rows: MyHoursCardRow[] }, labels: Record<string, string>): HTMLElement;
export function runMyHours(cfg: MyHoursConfig, w: unknown, card: typeof myHoursCard): void;
export function myHoursConfig(masterEdit: unknown, labels: Record<string, string>): MyHoursConfig;
export function myHoursScript(cfg: MyHoursConfig): string;
