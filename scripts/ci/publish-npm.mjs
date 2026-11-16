/**
 * GitHub Actions の publish-npm: main の packages/app/package.json の版がまだ公開されていなければ、
 * npmjs.com への公開・タグ v<版>・GitHub のリリースまでを行う（SPEC §83・§84・§121、手順は docs/RELEASE.md）。
 *
 *   node scripts/ci/publish-npm.mjs --check   公開が要るかだけを調べ、GITHUB_OUTPUT に needed=true|false を書く（依存のインストール前に動く）
 *   node scripts/ci/publish-npm.mjs           型チェック・テスト・ビルド → npm publish → タグとリリースを作る
 *
 * どこで止まっても、もう一度動かせば残りだけを行う（npm に版があれば公開を飛ばし、リリースがあれば作らない）。
 * 認証は trusted publishing（OIDC。npm 側で設定したとき）か Secrets の NPM_TOKEN（setup-node が .npmrc に入れる）。
 * 手元の PC からは公開しない（scripts/check-publish.mjs が YOJITSU_PUBLIC_PUBLISH=1 のときだけ npmjs.com を通す）
 */
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { npm } from "../lib/npm.mjs";
import { releaseNotes } from "../lib/release.mjs";

const pkgDir = join("packages", "app");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf-8"));
const version = pkg.version;
const tag = `v${version}`;

/** npmjs.com にこの版があるか（認証なしで読む。.npmrc のトークンは使わない） */
async function onNpm() {
  const res = await fetch(`https://registry.npmjs.org/${pkg.name}/${version}`);
  if (res.status === 404) return false;
  if (!res.ok) throw new Error(`npmjs.com を確かめられませんでした（${res.status}）`);
  return true;
}

/** GitHub にこの版のリリースがあるか（gh は GitHub のランナーに入っている） */
function hasRelease() {
  try {
    execFileSync("gh", ["release", "view", tag, "--json", "tagName"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const published = await onNpm();
const released = hasRelease();

if (process.argv.includes("--check")) {
  const needed = !(published && released);
  console.log(needed ? `${tag}: 公開します（npm ${published ? "済み" : "未"}、リリース ${released ? "済み" : "未"}）` : `${tag}: 公開済みです。何もしません`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  process.exit(0);
}

try {
  if (!published) {
    // 公開する前に型チェック・テストを通し、配布物を作り直す（公開前の確認は prepublishOnly の check-publish.mjs）
    npm(["run", "typecheck"], { stdio: "inherit" });
    npm(["exec", "--", "vitest", "run"], { stdio: "inherit" });
    npm(["run", "app:build"], { stdio: "inherit" });
    npm(["publish", "--access", "public"], { cwd: pkgDir, stdio: "inherit", env: { ...process.env, YOJITSU_PUBLIC_PUBLISH: "1" } });
  }
  if (!released) {
    const notes = releaseNotes(readFileSync("CHANGELOG.md", "utf-8"), version) || `yojitsu-navi ${version}`;
    const file = join(mkdtempSync(join(tmpdir(), "release-")), "notes.md");
    writeFileSync(file, `${notes}\n`);
    const target = process.env.GITHUB_SHA ?? "main";
    execFileSync("gh", ["release", "create", tag, "--title", tag, "--target", target, "--notes-file", file], { stdio: "inherit" });
  }
  console.log(`${tag}: 公開しました（npm・タグ・リリース）`);
} catch {
  process.exit(1);
}
