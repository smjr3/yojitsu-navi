export const END_SOON_MONTHS: number;
export const TIMELINE_GROUPS: readonly ("customer" | "team" | "none")[];
export const TIMELINE_SORTS: readonly ("end" | "start" | "amount" | "burn")[];
export interface TimelineRow {
  contractId: string;
  customerName: string;
  projectName: string;
  teamId?: string | null;
  teamName?: string;
  startMonth: string;
  endMonth: string;
  totalAmount?: number;
  burnRate?: number | null;
  [k: string]: unknown;
}
export function isEnded(row: { endMonth: string }, asOfMonth: string): boolean;
export function isEndingSoon(row: { endMonth: string }, asOfMonth: string): boolean;
export function arrangeTimeline<R extends TimelineRow>(rows: R[], opts: { group?: string; sort?: string; asOfMonth: string }): { key: string; label: string; rows: R[] }[];
export function monthBars(months: { month: string; status: string; budget: number; cost: number }[] | undefined, visible: { from: string; to: string }): { month: string; ratio: number; over: boolean; budget: number; cost: number }[];
export interface TimelinePrefs {
  group: string;
  sort: string;
}
export function loadTimelinePrefs(storage?: Pick<Storage, "getItem"> | null): TimelinePrefs;
export function saveTimelinePrefs(prefs: TimelinePrefs, storage?: Pick<Storage, "setItem"> | null): void;
export function contractTimeline(opts: { rows: TimelineRow[]; period: { from: string; to: string }; asOf: string; unit: string; href: (row: TimelineRow) => string }): HTMLElement;
