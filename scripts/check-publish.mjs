// npm publish の直前の確認（packages/core・packages/app の prepublishOnly。SPEC §43・§44）
//
//   node ../../scripts/check-publish.mjs core|app
//
// 1. 配布物が組み立て済みか（core:build / app:build を忘れると package.json と README だけが公開される）
// 2. 公開先が公開の npm（registry.npmjs.org）でないか。社内のコードと文書を外に出さないため、
//    公開先は社内 GitLab の Package Registry（.npmrc か --registry で指定）に限る
// Windows・Linux のどちらでも動く（npm は scripts/lib/npm.mjs で起動する）
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { npm } from "./lib/npm.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const kind = process.argv[2];
const PKG = join(ROOT, "packages", kind ?? "");
const required = { core: ["dist/core/index.js", "dist/core/index.d.ts", "dist/i18n/ja.js"], app: ["dist/gitlab-setup.mjs", "template/package.json"] }[kind];
if (!required) {
  console.error("使い方: node scripts/check-publish.mjs core|app");
  process.exit(1);
}

const errors = [];
const missing = required.filter((f) => !existsSync(join(PKG, f)));
if (missing.length) errors.push(`配布物がありません（先に npm run ${kind}:build）: ${missing.join(", ")}`);

if (kind === "app") {
  const v = (p) => JSON.parse(readFileSync(p, "utf-8")).version;
  const [app, root] = [v(join(PKG, "package.json")), v(join(ROOT, "package.json"))];
  if (app !== root) errors.push(`packages/app の version（${app}）がルートの package.json（${root}）と違います`);
}

const name = JSON.parse(readFileSync(join(PKG, "package.json"), "utf-8")).name;
const scope = name.startsWith("@") ? name.split("/")[0] : null;
const get = (key) => String(npm(["config", "get", key], { cwd: PKG, encoding: "utf-8" })).trim();
const scoped = scope ? get(`${scope}:registry`) : "";
const registry = scoped && scoped !== "undefined" ? scoped : get("registry");
if (/registry\.npmjs\.org/.test(registry)) {
  errors.push(`公開先が公開の npm（${registry}）です。社内 GitLab の Package Registry を .npmrc か --registry で指定してください（docs/DEPLOY_GITLAB.md）`);
}

if (errors.length) {
  for (const e of errors) console.error(e);
  process.exit(1);
}
console.log(`${name}: 公開前の確認 OK（公開先 ${registry}）`);
