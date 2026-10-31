/**
 * スケジュール実行の取り込み（.gitlab-ci.yml の fetch-worklogs / fetch-members）。Windows・Linux のどちらの Runner でも動くよう、
 * シェルの書き方に頼らず Node で書く（SPEC §39.4）
 *
 *   node scripts/ci/fetch-data.mjs worklogs   作業実績 API から直近を取り直す → 検証 → MR
 *   node scripts/ci/fetch-data.mjs members    人事データから所属・役職を取り込む → 検証 → MR
 */
import { execFileSync } from "node:child_process";
import { npm } from "../lib/npm.mjs";
import { pushDataMr } from "./push-data-mr.mjs";

const JOBS = {
  worklogs: { script: "fetch", tokens: ["WORKLOG_API_TOKEN", "GIT_PUSH_TOKEN"], title: "作業実績を更新", paths: ["data/worklogs"] },
  members: { script: "fetch:members", tokens: ["GIT_PUSH_TOKEN"], title: "メンバーの所属・役職を更新", paths: ["data/masters/members.csv"] },
};

const kind = process.argv[2] ?? "";
const job = JOBS[kind];
if (!job) {
  console.error(`種類は ${Object.keys(JOBS).join(" / ")} のどれかです（${kind || "なし"}）`);
  process.exit(2);
}
for (const name of job.tokens) {
  if (!process.env[name]) {
    console.error(`${name} が未設定です`);
    process.exit(1);
  }
}
const branch = process.env.CI_COMMIT_BRANCH;
if (!branch) {
  console.error("CI_COMMIT_BRANCH がありません");
  process.exit(1);
}

try {
  execFileSync("git", ["checkout", "-B", branch, `origin/${branch}`], { stdio: "inherit" });
  npm(["run", job.script], { stdio: "inherit" });
  // 取り直した結果で検証が通ることを確認してから反映する
  npm(["run", "validate"], { stdio: "inherit" });
  const stamp = new Date().toISOString().slice(0, 16);
  console.log(pushDataMr({ kind, message: `chore(data): ${job.title} (${stamp}Z)`, paths: job.paths }));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
