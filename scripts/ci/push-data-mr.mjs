/**
 * 取り込んだデータを MR で反映する（scripts/ci/fetch-data.mjs から呼ぶ。SPEC §39.4）。Windows・Linux のどちらの Runner でも動く
 *
 *   node scripts/ci/push-data-mr.mjs <種類> <コミットメッセージ> <パス>...
 *
 * - <パス> に変更が無ければ何もしない（まだ無いパスは飛ばす）
 * - あれば data/<種類>-<日時> ブランチに 1 コミットして push し、push オプションで
 *   MR の作成・パイプライン成功後の自動マージ・ソースブランチの削除を指定する
 *   （反映先のブランチは保護ブランチで「直接プッシュ = No one」なので、データも MR を通す）
 * - 必要な環境変数:
 *     GIT_PUSH_TOKEN  Project Access Token（role: Maintainer、scope: write_repository）
 *     CI_SERVER_URL / CI_PROJECT_PATH / CI_COMMIT_BRANCH（GitLab CI が入れる）
 *   DATA_PUSH_REMOTE を入れるとその remote に push する（テスト用）
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** data/<種類>-YYYYMMDD-HHMMSS（UTC） */
export function dataBranch(kind, now = new Date()) {
  const s = now.toISOString();
  return `data/${kind}-${s.slice(0, 10).replace(/-/g, "")}-${s.slice(11, 19).replace(/:/g, "")}`;
}

/** https://gitlab.example.local → https://oauth2:<token>@gitlab.example.local/<project>.git（ポート付きの URL もそのまま） */
export function remoteUrl(env) {
  if (env.DATA_PUSH_REMOTE) return env.DATA_PUSH_REMOTE;
  if (!env.GIT_PUSH_TOKEN) throw new Error("GIT_PUSH_TOKEN が未設定です");
  if (!env.CI_SERVER_URL || !env.CI_PROJECT_PATH) throw new Error("CI_SERVER_URL・CI_PROJECT_PATH がありません");
  return `${env.CI_SERVER_URL.replace("://", `://oauth2:${env.GIT_PUSH_TOKEN}@`)}/${env.CI_PROJECT_PATH}.git`;
}

/** 戻り値は画面に出す 1 行。トークンは URL に入るがログには出さない（remote を出力しない） */
export function pushDataMr({ kind, message, paths, env = process.env, cwd = process.cwd(), now = new Date() }) {
  if (!kind) throw new Error("種類を指定してください（例 worklogs）");
  if (!message) throw new Error("コミットメッセージを指定してください");
  if (!paths?.length) throw new Error("対象のパスを指定してください");
  const target = env.CI_COMMIT_BRANCH;
  if (!target) throw new Error("CI_COMMIT_BRANCH がありません");
  const remote = remoteUrl(env);
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] });

  // まだ無いファイル（失敗の記録など）を git add に渡すとエラーになるので、ある・追跡中のものだけ渡す
  const tracked = (p) => spawnSync("git", ["ls-files", "--error-unmatch", "--", p], { cwd, stdio: "ignore" }).status === 0;
  const present = paths.filter((p) => existsSync(join(cwd, p)) || tracked(p));
  if (present.length === 0) return `変更はありません（${kind}）`;
  git(["add", "--", ...present]);
  if (spawnSync("git", ["diff", "--cached", "--quiet"], { cwd }).status === 0) return `変更はありません（${kind}）`;

  const branch = dataBranch(kind, now);
  git(["-c", `user.name=${env.GIT_AUTHOR_NAME || "yojitsu-navi-bot"}`, "-c", `user.email=${env.GIT_AUTHOR_EMAIL || "yojitsu-navi-bot@example.local"}`, "commit", "-q", "-m", message]);
  // merge_when_pipeline_succeeds は 17.11 で auto_merge に改名されたが、旧名も受け付ける（古い社内 GitLab でも動く）
  const r = spawnSync(
    "git",
    ["push", "-q", remote, `HEAD:refs/heads/${branch}`, "-o", "merge_request.create", "-o", `merge_request.target=${target}`, "-o", "merge_request.merge_when_pipeline_succeeds", "-o", "merge_request.remove_source_branch", "-o", `merge_request.title=${message}`],
    { cwd, encoding: "utf-8" },
  );
  if (r.status !== 0) throw new Error(`push に失敗しました: ${String(r.stderr ?? "").split(remote).join("<remote>").trim()}`);
  return `MR を作成しました: ${branch} → ${target}（パイプラインが成功すると自動でマージされます）`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [kind, message, ...paths] = process.argv.slice(2);
  try {
    console.log(pushDataMr({ kind, message, paths }));
  } catch (e) {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  }
}
