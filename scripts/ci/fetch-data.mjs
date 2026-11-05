/**
 * スケジュール実行の取り込み（.gitlab-ci.yml の fetch-worklogs / fetch-members）。Windows・Linux のどちらの Runner でも動くよう、
 * シェルの書き方に頼らず Node で書く（SPEC §39.4）
 *
 *   node scripts/ci/fetch-data.mjs worklogs   作業実績 API から直近を取り直す → 検証 → MR
 *   node scripts/ci/fetch-data.mjs members    人事データから所属・役職を取り込む → 検証 → MR
 *
 * 取り込みに失敗したとき（§87）: CSV は書き換えず、失敗の記録（meta）だけを MR にしてからジョブを失敗で終える。
 * 記録はデータ確認画面に出る。検証（validate）で落ちたときは記録しない（MR を開いたまま理由を直す運用）。
 *
 * 過去の取り直し（作業実績のみ）: Build > Pipelines > Run pipeline で変数 FETCH_FROM / FETCH_TO（YYYY-MM）、
 * 必要なら FETCH_MEMBERS（社員番号をカンマ区切り）を入れて実行する。初回の取り込みは FETCH_MODE=initial（今年度の初めから今月まで。§96）。
 * npm run fetch がそのまま読む
 */
import { execFileSync } from "node:child_process";
import { npm } from "../lib/npm.mjs";
import { pushDataMr } from "./push-data-mr.mjs";

const JOBS = {
  worklogs: { script: "fetch", tokens: ["WORKLOG_API_TOKEN", "GIT_PUSH_TOKEN"], title: "作業実績を更新", paths: ["data/worklogs"], meta: "data/worklogs/_meta.json", failTitle: "作業実績の取得に失敗（記録のみ）" },
  members: { script: "fetch:members", tokens: ["GIT_PUSH_TOKEN"], title: "メンバーの所属・役職を更新", paths: ["data/masters/members.csv", "data/masters/_members-meta.json"], meta: "data/masters/_members-meta.json", failTitle: "所属・役職の取り込みに失敗（記録のみ）" },
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
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
try {
  npm(["run", job.script], { stdio: "inherit" });
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  // 取り込みの失敗: CSV は書き換わっていない。失敗の記録だけを反映して、データ確認画面に出す
  try {
    const stamp = new Date().toISOString().slice(0, 16);
    console.log(pushDataMr({ kind: `${kind}-failed`, message: `chore(data): ${job.failTitle} (${stamp}Z)`, paths: [job.meta] }));
  } catch (e2) {
    console.error(`失敗の記録を反映できませんでした: ${e2 instanceof Error ? e2.message : e2}`);
  }
  process.exit(1);
}
try {
  // 取り直した結果で検証が通ることを確認してから反映する
  npm(["run", "validate"], { stdio: "inherit" });
  const stamp = new Date().toISOString().slice(0, 16);
  console.log(pushDataMr({ kind, message: `chore(data): ${job.title} (${stamp}Z)`, paths: job.paths }));
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
