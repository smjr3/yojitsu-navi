// npm run ci:check: CI（.gitlab-ci.yml と include 先）が使うファイルが揃ってコミットされているか、GitLab が受け付けない書き方が無いかを確かめる（SPEC §85・§91.3）。
// yojitsu-navi check と同じ確かめを、コマンドを入れていない PC・Runner でもプロジェクトの中から動かせるようにしたもの。Node の標準モジュールだけを使う
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { CI_FILE, checkCiFiles, describeCiProblems } from "../lib/ci-files.mjs";

const root = fileURLToPath(new URL("../..", import.meta.url));
const inGit = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], { cwd: root, encoding: "utf-8" }).stdout?.trim() === "true";
const r = checkCiFiles(root, { git: inGit });
const problems = describeCiProblems(r);
if (problems) {
  console.error(problems);
  process.exit(1);
}
console.log(`CI（${CI_FILE}）が使う ${r.required.length} ファイルは揃っています${inGit ? "" : "（git のリポジトリではないので、コミットされているかは見ていません）"}`);
