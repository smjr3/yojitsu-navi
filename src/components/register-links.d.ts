export function mastersHref(view: string, params?: Record<string, string | number | null | undefined>): string;
export interface OfficialProjectLike {
  projectId: string;
  customerName: string;
  projectName: string;
}
export function officialProjectLookup(officialProjects: readonly OfficialProjectLike[] | null | undefined): (name: string | null | undefined) => OfficialProjectLike | null;
export function registerContractHref(row: { customerName?: string; projectName?: string; projectId?: string; firstDate?: string }, lookup?: (name: string | undefined) => OfficialProjectLike | null): string;
export interface UnlinkedLike {
  contractId: string;
  customerName?: string;
  candidates?: readonly string[];
}
export function unlinkedByCandidate<C extends UnlinkedLike>(unlinked: readonly C[] | null | undefined): Map<string, C[]>;
export function contractListText(contracts: ReadonlyArray<{ contractId: string; customerName?: string }> | null | undefined): string;
