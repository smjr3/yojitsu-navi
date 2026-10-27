// dist/ を配信する小さな静的サーバ（E2E 用）
//   node tests/e2e/serve.mjs <root=dist> <port=4173>
// - cleanUrls: /contracts → contracts.html、/ → index.html
// - 無いものは 404（ディレクトリも 404）
// - /__health は常に 200（dist が未生成でも Playwright の webServer 待ちが成立する）
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize, resolve, sep } from "node:path";

const root = resolve(process.argv[2] ?? "dist");
const port = Number(process.argv[3] ?? 4173);

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".csv": "text/csv; charset=utf-8",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

async function isFile(p) {
  try {
    return (await stat(p)).isFile();
  } catch {
    return false;
  }
}

const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url ?? "/", "http://localhost");
    if (url.pathname === "/__health") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    let pathname = decodeURIComponent(url.pathname);
    if (pathname.endsWith("/")) pathname += "index";
    // パストラバーサル防止
    const safe = normalize(pathname).replace(/^(\.\.(\/|\\|$))+/, "");
    let file = join(root, safe);
    if (!file.startsWith(root + sep) && file !== root) {
      res.writeHead(403, { "content-type": "text/plain" });
      res.end("forbidden");
      return;
    }
    if (!(await isFile(file)) && extname(file) === "" && (await isFile(file + ".html"))) file += ".html";
    if (!(await isFile(file))) {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found: " + pathname);
      return;
    }
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-store", "content-length": body.length });
    res.end(body);
  } catch (error) {
    res.writeHead(500, { "content-type": "text/plain; charset=utf-8" });
    res.end(String(error?.stack ?? error));
  }
});

server.listen(port, "127.0.0.1", () => console.log(`[e2e] serving ${root} on http://127.0.0.1:${port}`));
