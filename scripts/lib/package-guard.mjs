// npm パッケージの組み立て（scripts/build-app.mjs）は開発元のリポジトリ専用（SPEC §84.1）。
// 社内で init したプロジェクト（利用環境）で動かすと、社内の設定（.npmrc の参照先・証明書・CI の設定・config.json・data/）を
// 含むファイルがそのままパッケージに入るので、組み立てる前に止める。
import { existsSync } from "node:fs";
import { join } from "node:path";

/** 利用環境の記録（packages/app/lib/project.mjs の MANIFEST と同じ。project.mjs は組み立てで写すファイルを読むので、組み立て前のここでは読み込まない） */
export const PROJECT_MANIFEST = ".yojitsu-navi.json";

/** パッケージに入れてはいけないファイル（社内のレジストリ・トークン・証明書・鍵、利用環境の記録・依存・バックアップ） */
const INTERNAL_PATTERNS = [
  /(^|\/)\.npmrc$/,
  /(^|\/)\.yarnrc(\.yml)?$/,
  /(^|\/)\.env(\..*)?$/,
  /\.(pem|crt|cer|key|p12|pfx)$/i,
  /^\.yojitsu-navi\.json$/,
  /^\.yojitsu-navi-backup\//,
  /^vendor\//,
];

/** パッケージに入れてはいけないファイルか */
export function isInternalFile(path) {
  return INTERNAL_PATTERNS.some((re) => re.test(path.replace(/\\/g, "/")));
}

/** 組み立てを止める理由（無ければ空）。root は組み立てるリポジトリ、files は template に写すファイル */
export function packageGuardProblems(root, files) {
  const problems = [];
  if (existsSync(join(root, PROJECT_MANIFEST))) {
    problems.push(
      `ここは yojitsu-navi init で作ったプロジェクト（${PROJECT_MANIFEST} がある）です。パッケージの組み立て（npm run app:build・app:pack）は開発元のリポジトリ専用で、ここで作ると社内の設定（config.json・data/・CI の設定など）がそのまま入ります。新しい版は開発元が公開したものを npm install -g yojitsu-navi@<版> → yojitsu-navi update で入れてください`,
    );
  }
  const internal = files.filter(isInternalFile);
  if (internal.length) problems.push(`パッケージに入れてはいけないファイルがあります（社内の接続先・証明書・鍵など）: ${internal.join(", ")}`);
  return problems;
}
