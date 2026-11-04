// npm publish の直前の確認（packages/app の prepublishOnly。SPEC §83・§84）
//
// 1. 配布物が組み立て済みか（npm run app:build を忘れると package.json と README だけが公開される）
// 2. 版がルートの package.json と同じか
// 3. 変更履歴（CHANGELOG.md）にこの版の見出しがある（update が導入先で行うことを出すため。SPEC §91.2・docs/RELEASE.md）
// 4. 公開の npm（registry.npmjs.org）へは、GitHub Actions の publish-npm（YOJITSU_PUBLIC_PUBLISH=1）からだけ出す。
//    手元の PC からうっかり公開しないため（ほかの npm レジストリへは .npmrc か --registry で指定する）
// Windows・Linux のどちらでも動く（npm は scripts/lib/npm.mjs で起動する）
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "./lib/npm.mjs";
import { parseChangelog } from "../packages/app/lib/changelog.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const PKG = join(ROOT, "packages", "app");
const required = ["dist/gitlab-setup.mjs", "dist/core/index.js", "dist/core/index.d.ts", "dist/i18n/ja.js", "template/package.json", "LICENSE"];

const errors = [];
const missing = required.filter((f) => !existsSync(join(PKG, f)));
if (missing.length) errors.push(`配布物がありません（先に npm run app:build）: ${missing.join(", ")}`);

const version = (p) => JSON.parse(readFileSync(p, "utf-8")).version;
const [app, root] = [version(join(PKG, "package.json")), version(join(ROOT, "package.json"))];
if (app !== root) errors.push(`packages/app の version（${app}）がルートの package.json（${root}）と違います`);
const changelog = join(ROOT, "CHANGELOG.md");
if (!existsSync(changelog) || !parseChangelog(readFileSync(changelog, "utf-8")).some((e) => e.version === app)) {
  errors.push(`CHANGELOG.md に「## ${app}」がありません。「## 次の版」を「## ${app}」にしてください（docs/RELEASE.md）`);
}

const registry = String(npm(["config", "get", "registry"], { cwd: PKG, encoding: "utf-8" })).trim();
if (/registry\.npmjs\.org/.test(registry) && process.env.YOJITSU_PUBLIC_PUBLISH !== "1") {
  errors.push(`公開先が npmjs.com です。npmjs.com へは GitHub Actions の publish-npm から公開します（docs/RELEASE.md）`);
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`yojitsu-navi ${app}: 公開前の確認 OK（公開先 ${registry}）`);
