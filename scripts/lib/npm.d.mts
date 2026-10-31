import type { ExecFileSyncOptions } from "node:child_process";
export function npmCommand(args: string[]): [string, string[]];
export function npm(args: string[], options?: ExecFileSyncOptions): string | Buffer;
