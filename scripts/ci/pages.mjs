/**
 * pages ジョブ: build の成果物 dist/ を public/ に移し、圧縮版（.gz）を並べる。Windows・Linux のどちらの Runner でも動く
 * （.gz があると GitLab Pages が gzip で配信し、約 3 MB の JSON が数百 KB になって初回表示が速くなる）
 */
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { gzipSync } from "node:zlib";

const EXT = /\.(html|js|css|json|svg|txt|csv)$/;

/** dir の下の対象ファイルの横に .gz を作り、作った数を返す */
export function gzipTree(dir) {
  let n = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) n += gzipTree(p);
    else if (EXT.test(name)) {
      writeFileSync(`${p}.gz`, gzipSync(readFileSync(p), { level: 9 }));
      n++;
    }
  }
  return n;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!existsSync(join("dist", "index.html"))) {
    console.error("dist/index.html がありません（build ジョブの成果物を確認）");
    process.exit(1);
  }
  rmSync("public", { recursive: true, force: true });
  renameSync("dist", "public");
  console.log(`public/ に移しました（圧縮版 ${gzipTree("public")} ファイル）`);
}
