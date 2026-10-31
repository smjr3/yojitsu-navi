/**
 * npm を OS によらず起動する（Windows の npm は npm.cmd で、Node 20.12 以降は shell なしで .cmd を起動できないため）。
 * npm-cli.js を今の Node で直接動かす。`npm run` から呼ばれたときは npm_execpath、無ければ Node の隣の npm を探す。
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

function npmCli() {
  const fromEnv = process.env.npm_execpath;
  if (fromEnv && /npm-cli\.js$/.test(fromEnv) && existsSync(fromEnv)) return fromEnv;
  const dir = dirname(process.execPath);
  for (const p of [join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")]) {
    if (existsSync(p)) return p;
  }
  return null;
}

/** execFileSync に渡す [コマンド, 引数] */
export function npmCommand(args) {
  const cli = npmCli();
  return cli ? [process.execPath, [cli, ...args]] : ["npm", args];
}

/** npm を実行する（オプションは execFileSync と同じ） */
export function npm(args, options = {}) {
  const [cmd, argv] = npmCommand(args);
  return execFileSync(cmd, argv, options);
}
