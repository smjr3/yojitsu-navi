/** scripts/lib/release.mjs の型（テストから使う） */
export function nextVersion(current: string, spec: string | undefined): string;
export function renameNextHeading(text: string, v: string): string;
export function releaseNotes(text: string, v: string): string;
