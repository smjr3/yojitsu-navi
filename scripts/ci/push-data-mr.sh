#!/usr/bin/env bash
# 取り込んだデータを MR で反映する（.gitlab-ci.yml の fetch-worklogs / fetch-members から呼ぶ。SPEC §39.4）
#
#   scripts/ci/push-data-mr.sh <種類> <コミットメッセージ> <パス>...
#
# - <パス> に変更が無ければ何もしない
# - あれば data/<種類>-<日時> ブランチに 1 コミットして push し、push オプションで
#   MR の作成・パイプライン成功後の自動マージ・ソースブランチの削除を指定する
#   （反映先のブランチは保護ブランチで「直接プッシュ = No one」なので、データも MR を通す）
# - 必要な環境変数:
#     GIT_PUSH_TOKEN  Project Access Token（role: Maintainer、scope: write_repository）
#     CI_SERVER_URL / CI_PROJECT_PATH / CI_COMMIT_BRANCH（GitLab CI が入れる）
#   DATA_PUSH_REMOTE を入れるとその remote に push する（テスト用）
set -euo pipefail

kind="${1:?種類を指定してください（例 worklogs）}"
message="${2:?コミットメッセージを指定してください}"
shift 2
[ "$#" -gt 0 ] || { echo "対象のパスを指定してください" >&2; exit 2; }

target="${CI_COMMIT_BRANCH:?CI_COMMIT_BRANCH がありません}"
if [ -n "${DATA_PUSH_REMOTE:-}" ]; then
  remote="$DATA_PUSH_REMOTE"
else
  : "${GIT_PUSH_TOKEN:?GIT_PUSH_TOKEN が未設定です}"
  # https://gitlab.example.local → https://oauth2:<token>@gitlab.example.local（ポート付きの URL もそのまま）
  remote="${CI_SERVER_URL/:\/\//://oauth2:${GIT_PUSH_TOKEN}@}/${CI_PROJECT_PATH}.git"
fi

git add -- "$@"
if git diff --cached --quiet; then
  echo "変更はありません（${kind}）"
  exit 0
fi

branch="data/${kind}-$(date -u +%Y%m%d-%H%M%S)"
git -c user.name="${GIT_AUTHOR_NAME:-yojitsu-navi-bot}" -c user.email="${GIT_AUTHOR_EMAIL:-yojitsu-navi-bot@example.local}" commit -q -m "$message"
# トークンは URL に入るがログには出さない（set -x しない・remote を echo しない）
# merge_when_pipeline_succeeds は 17.11 で auto_merge に改名されたが、旧名も受け付ける（古い社内 GitLab でも動く）
git push -q "$remote" "HEAD:refs/heads/${branch}" \
  -o merge_request.create \
  -o "merge_request.target=${target}" \
  -o merge_request.merge_when_pipeline_succeeds \
  -o merge_request.remove_source_branch \
  -o "merge_request.title=${message}"
echo "MR を作成しました: ${branch} → ${target}（パイプラインが成功すると自動でマージされます）"
