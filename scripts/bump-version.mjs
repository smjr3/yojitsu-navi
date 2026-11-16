// 版を上げる（docs/RELEASE.md「公開するたび」。SPEC §121）
//
//   npm run version:bump -- patch|minor|major|<x.y.z>
//
// ルートと packages/app の package.json、package-lock.json の版を同じ値にし、CHANGELOG.md の「## 次の版」を「## <版>」にする。
// main にマージされると GitHub Actions の publish-npm が npm 公開・タグ・リリースまで行う。開発元のリポジトリだけで使う
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { nextVersion, renameNextHeading } from "./lib/release.mjs";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
function main() {
  const spec = process.argv[2];
  const read = (p) => readFileSync(join(ROOT, p), "utf-8");
  const write = (p, s) => writeFileSync(join(ROOT, p), s);
  const root = JSON.parse(read("package.json"));
  const v = nextVersion(root.version, spec);
  const changelog = renameNextHeading(read("CHANGELOG.md"), v);
  for (const p of ["package.json", "packages/app/package.json"]) {
    const j = JSON.parse(read(p));
    j.version = v;
    write(p, `${JSON.stringify(j, null, 2)}\n`);
  }
  const lock = JSON.parse(read("package-lock.json"));
  lock.version = v;
  if (lock.packages?.[""]) lock.packages[""].version = v;
  write("package-lock.json", `${JSON.stringify(lock, null, 2)}\n`);
  write("CHANGELOG.md", changelog);
  console.log(`${root.version} → ${v}（main にマージされると publish-npm が公開します）`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    main();
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exit(1);
  }
}
