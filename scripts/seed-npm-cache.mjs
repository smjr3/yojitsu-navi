// Observable Framework のビルドを外部ネットワークなしで通すための準備（npm の prebuild で自動実行）
//
// Framework 1.13 は組み込みの client.js をバンドルするとき、推奨ライブラリ（React・Leaflet など、
// このアプリでは使っていないもの）のバージョンを registry.npmjs.org に問い合わせる。
// 結果は src/.observablehq/cache/_npm/<name>@<version>/ という空ディレクトリとして覚えるので、
// 先に作っておけば問い合わせが起きず、社内 CI（外部に出られない Runner）でもビルドできる。
// ここに並べたライブラリの本体は dist/ に含まれず、画面からも読み込まれない（バージョン番号は何でもよい）。
// Framework を更新してビルドが registry.npmjs.org への接続で失敗したら、エラーに出た名前をここに足す。
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const VERSIONS = [
  "@observablehq/plot@0.6.17",
  "@observablehq/sample-datasets@1.0.1",
  "apache-arrow@21.2.0",
  "arquero@8.0.3",
  "d3@7.9.0",
  "d3-dsv@3.0.1",
  "echarts@6.1.0",
  "htl@1.0.0",
  "leaflet@1.9.4",
  "lodash@4.18.1",
  "mapbox-gl@3.33.0",
  "parquet-wasm@0.9.0",
  "react@19.3.1",
  "react-dom@19.3.1",
  "topojson-client@3.1.0",
];

const cacheDir = join(ROOT, "src", ".observablehq", "cache", "_npm");
for (const spec of VERSIONS) mkdirSync(join(cacheDir, spec), { recursive: true });
