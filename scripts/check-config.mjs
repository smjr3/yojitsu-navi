#!/usr/bin/env node
/**
 * config.json の互換確認（SPEC §96）。npm run config:check
 *
 *   node scripts/check-config.mjs [--root <フォルダ>] [--json]
 *
 * この版で動くかだけを見る: 必須の項目が無い・型や値が違うとエラー（終了コード 1）、使わない項目・廃止された項目は注意（止めない）。
 * Node の標準機能だけで動く（依存を入れる前の upgrade・update からも呼ぶ）。npm run validate も同じ確かめを含む
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkConfig, formatConfigIssues, parseConfigText } from "./lib/config-schema.mjs";

const argv = process.argv.slice(2);
const at = argv.indexOf("--root");
const root = resolve(at >= 0 && argv[at + 1] ? argv[at + 1] : process.cwd());
const asJson = argv.includes("--json");
const path = join(root, "config.json");

let issues;
if (!existsSync(path)) issues = [{ level: "error", code: "CONFIG_MISSING", path: "", message: `${path} がありません` }];
else {
  const r = parseConfigText(readFileSync(path, "utf-8"));
  issues = r.error ? [{ level: "error", code: "CONFIG_PARSE", path: "", message: r.error }] : checkConfig(r.config);
}
const errors = issues.filter((i) => i.level === "error").length;
if (asJson) console.log(JSON.stringify({ errors, warnings: issues.length - errors, issues }));
else {
  console.log(issues.length ? ["config.json の互換確認:", ...formatConfigIssues(issues)].join("\n") : "config.json の互換確認: 問題ありません");
}
process.exit(errors ? 1 : 0);
