#!/usr/bin/env node
/**
 * コミットの作者・コミッター・Co-authored-by が決まったアドレスだけかを確かめる（SPEC §151）。npm run check:authors
 *
 *   node scripts/check-commit-authors.mjs [<範囲>]   （既定は origin/main..HEAD）
 *
 * 仮の名前（x <x@x> など）や個人のメールアドレスのコミットが main に入ると、GitHub の Contributors に
 * 知らない人として出たり、公開リポジトリにアドレスが残ったりする。PR の CI と npm run check で止める。
 * 範囲が読めない（origin/main が無いなど）ときは何もしない。Node の標準機能だけで動く。
 * 違反のアドレスは出さない（公開の CI のログに残さないため）。コミットと欄だけを出す
 */
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** 使ってよいアドレス: Claude、GitHub の noreply（利用者・bot）、GitHub のマージ */
const ALLOWED = [
  /^noreply@anthropic\.com$/i,
  /^noreply@github\.com$/i,
  /^(\d+\+)?[A-Za-z0-9-]+(\[bot\])?@users\.noreply\.github\.com$/i,
];

export function allowedEmail(email) {
  return ALLOWED.some((re) => re.test(email.trim()));
}

/** git log の 1 件（作者・コミッター・本文）から違反の欄を返す */
export function commitProblems({ authorEmail, committerEmail, body }) {
  const out = [];
  if (!allowedEmail(authorEmail)) out.push("作者");
  if (!allowedEmail(committerEmail)) out.push("コミッター");
  for (const m of body.matchAll(/^co-authored-by:\s*.*?<([^>]*)>\s*$/gim)) {
    if (!allowedEmail(m[1])) out.push("Co-authored-by");
  }
  return out;
}

/** git log の出力（%H %ae %ce %B を \x1f・\x1e 区切り）を分ける */
export function parseLog(text) {
  return text
    .split("\x1e")
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim())
    .map((s) => {
      const [sha, authorEmail, committerEmail, body = ""] = s.split("\x1f");
      return { sha, authorEmail, committerEmail, body };
    });
}

function main() {
  const range = process.argv[2] || "origin/main..HEAD";
  let text;
  try {
    text = execFileSync("git", ["log", "--format=%H%x1f%ae%x1f%ce%x1f%B%x1e", range], { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    console.log(`コミットの作者: ${range} を読めないので確かめません`);
    return;
  }
  const bad = parseLog(text)
    .map((c) => ({ sha: c.sha.slice(0, 7), problems: commitProblems(c) }))
    .filter((c) => c.problems.length);
  if (!bad.length) {
    console.log("コミットの作者: 問題なし");
    return;
  }
  console.error("コミットの作者・共同作者に、使えないアドレス（仮の名前・個人のアドレス）があります:");
  for (const c of bad) console.error(`  ${c.sha}: ${[...new Set(c.problems)].join("・")}`);
  console.error("git config の user.name・user.email を直し、そのコミットを作り直してください（CONTRIBUTING.md「コミット」）");
  process.exitCode = 1;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
