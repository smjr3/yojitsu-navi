type Env = Record<string, string | undefined>;
export function dataBranch(kind: string, now?: Date): string;
export function remoteUrl(env: Env): string;
export function pushDataMr(opts: { kind: string; message: string; paths: string[]; env?: Env; cwd?: string; now?: Date }): string;
