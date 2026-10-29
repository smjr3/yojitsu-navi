/**
 * ビルド環境から GitLab の接続先を補う（SPEC §38.1。Node 側専用）
 *
 * config.json の masterEdit.gitlab.apiBaseUrl・projectId が空のとき、環境変数
 *   YOJITSU_GITLAB_API_URL（例 https://gitlab.example.local/api/v4）
 *   YOJITSU_GITLAB_PROJECT（例 group/yojitsu-navi）
 * で埋める。.gitlab-ci.yml の build ジョブが CI_API_V4_URL・CI_PROJECT_PATH を渡すので、
 * 社内 GitLab では config.json を書き換えなくてもマスタ編集の保存先が決まる。
 * config.json に値があればそちらを優先する（別のプロジェクトに保存したい場合）。
 * マスタ編集のローダ（src/data/_masters.ts）とヘッダーのバッジ（observablehq.config.js）が同じ結果を使う。
 */

/** 環境変数（入力の指紋に入れる名前。scripts/lib/inputs.ts） */
export const GITLAB_ENV_KEYS = ["YOJITSU_GITLAB_API_URL", "YOJITSU_GITLAB_PROJECT"];

/**
 * @param {unknown} masterEdit config.json の masterEdit（そのまま。壊れていてもよい）
 * @param {Record<string, string | undefined>} env
 * @returns {unknown} 補った masterEdit（補うものが無ければ元のまま）
 */
export function withGitLabEnv(masterEdit, env) {
  const api = String(env.YOJITSU_GITLAB_API_URL ?? "").trim();
  const project = String(env.YOJITSU_GITLAB_PROJECT ?? "").trim();
  if (api === "" && project === "") return masterEdit;
  const me = masterEdit && typeof masterEdit === "object" ? masterEdit : {};
  const g = me.gitlab && typeof me.gitlab === "object" ? me.gitlab : {};
  const blank = (v) => v === undefined || v === null || String(v).trim() === "";
  // demo・download は接続先を使わないのでそのまま
  if (me.mode === "demo" || me.mode === "download") return masterEdit;
  return {
    ...me,
    gitlab: {
      ...g,
      apiBaseUrl: blank(g.apiBaseUrl) ? api : g.apiBaseUrl,
      projectId: blank(g.projectId) ? project : g.projectId,
    },
  };
}
