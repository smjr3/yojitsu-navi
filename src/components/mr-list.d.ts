export interface MrDescribe {
  value?: (fileId: string, column: string, value: string) => string;
  target?: (kind: string, id: string) => string;
}
export interface MrFileChange {
  id?: string;
  diff: { added: Array<{ after: Record<string, string> }>; changed: Array<{ after: Record<string, string> }>; removed: unknown[] } | null;
}
export interface MrNamer {
  value(fileId: string, column: string, value: string): string;
  lead(fileId: string, def: unknown, rec: Record<string, string>): string;
}
export function namerFor(describe: MrDescribe | null, files: MrFileChange[]): MrNamer;
export function mrTitleText(title: string): string;
export function mergeRequestsPanel(opts: { cfg: unknown; fetchImpl: unknown; now?: () => Date; describe?: MrDescribe | null }): { el: HTMLElement; refresh(opts?: { notice?: unknown }): Promise<void> };
