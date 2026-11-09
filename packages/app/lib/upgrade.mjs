// yojitsu-navi upgrade（SPEC §94）: 版を上げる作業を 1 回で行う。
// update → 設定の互換確認（SPEC §96）→ 依存を入れる（npm ci）→ CI のファイルの確認 → データ検証 → テスト → ビルド。
// 依存とテストは要るときだけ動かす（SPEC §100）。失敗したところで止まり、最後に結果の要約を出す。全部の出力はログのファイル（UTF-8）に残す
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError, VENDOR_CACHE, check, configCompat, missingConfigReport, update } from "./project.mjs";

/** 依存を入れたときの印（node_modules の中。lock ファイル・Node の版・OS が同じなら入れ直さない。SPEC §100） */
export const INSTALL_STAMP = "node_modules/.yojitsu-navi-install.json";

/** 依存の中身を決めるもの（package-lock.json・依存込みのキャッシュの有無・Node の主な版・OS） */
export function installKey(dir, nodeVersion = process.version, platform = `${process.platform}-${process.arch}`) {
  const lock = join(dir, "package-lock.json");
  const h = createHash("sha256").update(existsSync(lock) ? readFileSync(lock) : Buffer.alloc(0)).digest("hex");
  return { lock: h, vendor: existsSync(join(dir, VENDOR_CACHE)), node: nodeVersion.split(".")[0], platform };
}

/** 前に入れた依存がそのまま使えるか（node_modules があり、印が今の lock ファイルなどと同じ） */
export function installUpToDate(dir, key = installKey(dir)) {
  try {
    const s = JSON.parse(readFileSync(join(dir, INSTALL_STAMP), "utf-8"));
    return s.lock === key.lock && s.vendor === key.vendor && s.node === key.node && s.platform === key.platform;
  } catch {
    return false;
  }
}

/** 社内で手を加えたコード（テストを動かす理由）。社内の版のまま残したパッケージのファイルと、社内で足した画面・スクリプト・テスト・設定のファイル */
export function localCodeChanges(kept, extras) {
  const code = (f) => /^(src|scripts|tests)\//.test(f) || /^[^/]+\.config\.(m?[jt]s|json)$/.test(f) || f === "package.json" || f === "tsconfig.json";
  return [...new Set([...kept, ...extras.filter(code)])].sort();
}

/** npm を OS によらず起動する [コマンド, 引数, shell]（Windows の npm は npm.cmd で、shell なしでは起動できないため Node の隣の npm-cli.js を使う） */
export function npmCommand(args, env = process.env, execPath = process.execPath) {
  const fromEnv = env.npm_execpath;
  const dir = dirname(execPath);
  const candidates = [fromEnv && /npm-cli\.js$/.test(fromEnv) ? fromEnv : "", join(dir, "node_modules", "npm", "bin", "npm-cli.js"), join(dir, "..", "lib", "node_modules", "npm", "bin", "npm-cli.js")];
  const cli = candidates.find((p) => p && existsSync(p));
  return cli ? [execPath, [cli, ...args], false] : ["npm", args, process.platform === "win32"];
}

/** 子のプロセスを動かし、出力をログのファイルに書く（画面には出さない。失敗したときは最後の行を出す） */
function run(cmd, args, o) {
  return new Promise((done) => {
    const tail = [];
    const addLine = (line) => {
      o.out.fileOnly(line);
      if (line) tail.push(line);
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    };
    // 出力は区切りの途中で届く（日本語の 1 文字・1 行が 2 つに分かれる）ので、流れごとに文字と行をつなぎ直す
    const reader = () => {
      const decoder = new StringDecoder("utf8");
      let rest = "";
      return {
        push(chunk) {
          const lines = (rest + decoder.write(chunk)).split(/\r?\n/);
          rest = lines.pop() ?? "";
          for (const l of lines) addLine(l);
        },
        end() {
          const last = rest + decoder.end();
          rest = "";
          if (last) addLine(last);
        },
      };
    };
    const outR = reader();
    const errR = reader();
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, shell: o.shell ?? false, windowsHide: true });
    } catch (e) {
      done({ ok: false, tail: [String(e)] });
      return;
    }
    child.stdout.on("data", (c) => outR.push(c));
    child.stderr.on("data", (c) => errR.push(c));
    child.on("error", (e) => done({ ok: false, tail: [...tail, String(e)] }));
    child.on("close", (code) => {
      outR.end();
      errR.end();
      done({ ok: code === 0, tail });
    });
  });
}

/**
 * upgrade --dry-run（SPEC §100）: 何も変えずに、upgrade が止まらずに進めるか・依存とテストを動かすかを出す。
 * 止まる理由（社内で変えたパッケージのファイル・config.json のエラー）があれば終了コード 2
 */
function preview(o, testChoice) {
  const { dir, out } = o;
  /** @type {any} */
  let r;
  try {
    r = update({ ...o.update, pkgDir: o.pkgDir, version: o.version, dir, dryRun: true, log: out.detail, detail: out.detail, exclude: out.file ? [out.file] : [] });
  } catch (e) {
    if (!(e instanceof CliError)) throw e;
    out.error(e.message);
    return { ok: false, code: 2, steps: [] };
  }
  const unresolved = r.conflicts.filter((c) => !r.kept.includes(c.path) && !r.overwritten.includes(c.path));
  const lockNext = join(o.pkgDir, "template", "package-lock.json");
  const nextKey = { ...installKey(dir), lock: existsSync(lockNext) ? createHash("sha256").update(readFileSync(lockNext)).digest("hex") : installKey(dir).lock };
  const code = localCodeChanges(r.kept, r.extras);
  const tests = testChoice === true ? "動かす（指定あり）" : testChoice === false ? "動かさない（指定あり）" : code.length ? `動かす（社内で手を加えたコード ${code.length} ファイル）` : "動かさない（社内で手を加えたコードが無い）";
  const m = missingConfigReport(o.pkgDir, dir);
  out.log(`版上げの確認（何も変えていません）: 変更 ${r.changed.length}・追加 ${r.added.length}・削除 ${r.removed.length} ファイル`);
  out.log(`  残すもの（触らない）: config.json・data/・${[".gitlab-ci.local.yml", ".npmrc"].filter((f) => existsSync(join(dir, f))).join("・") || "（社内の CI・npm の設定ファイルは無し）"}${r.extras.length ? `・社内で足したファイル ${r.extras.length}` : ""}${r.kept.length ? `・社内の版のまま残すファイル ${r.kept.length}` : ""}`);
  if (r.mergedIgnore) out.log(`  .gitignore: 社内で足した ${r.mergedIgnore} 行を残して新しい版にします`);
  out.log(`  依存（npm ci）: ${!o.install && installUpToDate(dir, nextKey) ? "入れ直さない（package-lock.json が同じ）" : "入れる"}`);
  out.log(`  テスト: ${tests}`);
  if (m.missing.length) out.log(`  config.json に無い新しい設定: ${m.missing.length} 項目（無くても既定値で動きます。yojitsu-navi migrate-config）`);
  const stops = [];
  if (unresolved.length) stops.push(`社内で変えたパッケージのファイル ${unresolved.length}:\n${unresolved.map((c) => `    ${c.path}`).join("\n")}\n    → yojitsu-navi update --dry-run で差分を確かめ、--overwrite か --keep-local を付ける（.gitlab-ci.yml なら yojitsu-navi migrate-ci）`);
  if (r.configCheck.errors) stops.push(`config.json のエラー ${r.configCheck.errors}:\n${r.configCheck.lines.map((l) => `  ${l}`).join("\n")}`);
  out.log("");
  if (stops.length) {
    out.log(`結果: このままでは upgrade が止まります`);
    for (const s of stops) out.log(`  - ${s}`);
    return { ok: false, code: 2, steps: [] };
  }
  out.log("結果: このまま yojitsu-navi upgrade で止まらずに進めます（残すものは変わりません）");
  return { ok: true, code: 0, steps: [] };
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`;

/**
 * @param {{ pkgDir: string, version: string, dir: string, out: ReturnType<import("./output.mjs").createOutput>,
 *   update?: object, test?: boolean, env?: NodeJS.ProcessEnv, now?: () => number }} o
 *   update: update に渡すオプション（overwrite・keepLocal・force・commit）
 *   test: true で必ず動かす・false で動かさない。省略は環境変数 YOJITSU_RUN_TESTS（1 で動かす・0 で動かさない）、
 *     それも無ければ社内で手を加えたコードがあるときだけ動かす（SPEC §100）
 * @returns {Promise<{ ok: boolean, code: number, steps: { name: string, status: "ok" | "failed" | "skipped" | "notRun", note: string }[] }>}
 */
export async function upgrade(o) {
  const { dir, out } = o;
  const env = { ...(o.env ?? process.env) };
  const now = o.now ?? Date.now;
  const testEnv = env.YOJITSU_RUN_TESTS === "1" ? true : env.YOJITSU_RUN_TESTS === "0" ? false : undefined;
  const testChoice = o.test ?? testEnv;
  /** 社内で手を加えたコード（update のあとで決まる） */
  let localCode = [];
  if (o.dryRun) return preview(o, testChoice);
  const npm = (args) => npmCommand(args, env);
  let committed = true;
  let branch = "";
  let notes = 0;
  /** @type {{ errors: number, warnings: number, lines: string[] } | null} */
  let configCheck = null;
  /** @type {{ name: string, title: string, run: () => Promise<{ ok: boolean, note?: string, tail?: string[], code?: number }> | { ok: boolean, note?: string, tail?: string[], code?: number }, skip?: string }[]} */
  const steps = [
    {
      name: "update",
      title: "ファイルを新しい版にする（update）",
      run: () => {
        const r = update({ ...o.update, pkgDir: o.pkgDir, version: o.version, dir, log: out.log, detail: out.detail, exclude: out.file ? [out.file] : [] });
        // 自動のコミットに失敗した（フックに断られたなど）ときは、--no-commit と違って止める（コミットの無いまま先へ進めない）
        if (r.commitError) return { ok: false, tail: [`git commit できませんでした: ${r.commitError}`, "変更は git add してあります。直してから git commit するか、--no-commit で進めてください"] };
        committed = Boolean(r.commit) || (!r.changed.length && !r.added.length && !r.removed.length && o.update?.commit !== false);
        branch = r.commit?.branch ?? "";
        notes = r.notes.length;
        configCheck = r.configCheck ?? null;
        localCode = localCodeChanges(r.kept ?? [], r.extras ?? []);
        const note = `変更 ${r.changed.length}・追加 ${r.added.length}・削除 ${r.removed.length}${r.commit ? `・ブランチ ${r.commit.branch} にコミット（${r.commit.hash}）` : r.changed.length + r.added.length + r.removed.length ? "・コミットしていない" : ""}`;
        const warn = [r.sampleLeft.length ? `サンプルのまま残っているデータ ${r.sampleLeft.length}` : "", r.extras.length ? `パッケージに無いファイル ${r.extras.length}` : ""].filter(Boolean);
        return { ok: true, note: warn.length ? `${note}（要確認: ${warn.join("・")}）` : note };
      },
    },
    {
      name: "config",
      title: "設定の互換確認（config.json）",
      run: () => {
        // 本番で決めた設定（config.json）が新しい版でそのまま動くかだけを見る。必須の項目の追加・型や値の違いがあれば止める（SPEC §96）
        const c = configCheck ?? configCompat(dir);
        if (c.errors) return { ok: false, tail: [...c.lines, "config.json を直してコミットしてから、もう一度 yojitsu-navi upgrade を実行してください（項目は docs/DATA.md。yojitsu-navi migrate-config で足りない項目を確かめられます）"] };
        // 新しい版で増えた任意の項目（無くても既定値で動く）。書き足すかは migrate-config で選ぶ（SPEC §100）
        const m = missingConfigReport(o.pkgDir, dir);
        if (m.missing.length) out.detail(["config.json に無い新しい設定（無くても既定値で動きます。yojitsu-navi migrate-config で確かめ・書き足せます）:", ...m.missing.map((x) => `  ${x.path}  ひな形の値: ${x.value}`)].join("\n"));
        const extra = [c.warnings ? `注意 ${c.warnings}` : "", m.missing.length ? `新しい設定 ${m.missing.length}（yojitsu-navi migrate-config）` : ""].filter(Boolean);
        return { ok: true, note: extra.length ? `問題なし（${extra.join("・")}。ログのファイルに一覧）` : "問題なし" };
      },
    },
    {
      name: "install",
      title: "依存を入れる（npm ci）",
      run: async () => {
        // package-lock.json・Node の版・OS が前に入れたときと同じなら入れ直さない（--install で必ず入れる。SPEC §100）
        const key = installKey(dir);
        if (!o.install && installUpToDate(dir, key)) return { ok: true, skipped: "依存が変わっていない（package-lock.json が前と同じ）" };
        // CI と同じ入れ方（依存込みのプロジェクトは vendor/npm-cache から。社内ミラーは NPM_CONFIG_REGISTRY・.npmrc）
        const script = join(dir, "scripts", "ci", "install.mjs");
        const [cmd, args, shell] = existsSync(script) ? [process.execPath, [script], false] : npm(["ci", "--no-audit", "--no-fund"]);
        const r = await run(cmd, args, { cwd: dir, env, shell, out });
        if (r.ok && existsSync(join(dir, "node_modules"))) writeFileSync(join(dir, INSTALL_STAMP), `${JSON.stringify(key)}\n`);
        return r;
      },
    },
    {
      name: "check",
      title: "CI が使うファイルの確認（check）",
      run: () => {
        // --no-commit のときは、コミットされているかは見ない（ファイルがあるかだけ）
        const r = check({ dir, log: out.log, git: committed ? undefined : false });
        return { ok: true, note: `${r.required.length} ファイル${committed ? "" : "（コミットは見ていない）"}` };
      },
    },
    { name: "validate", title: "データ検証（npm run validate）", run: () => npmRun("validate") },
    {
      name: "test",
      title: "テスト（npm run typecheck・npm test）",
      // 社内で手を加えたコードが無ければ、開発元が確かめたものと同じなので動かさない（CI の test ジョブと同じ考え。SPEC §79.2・§100）
      skip: () => {
        if (testChoice === true) return "";
        if (testChoice === false) return o.test === false ? "--no-test" : "YOJITSU_RUN_TESTS=0";
        return localCode.length ? "" : "社内で手を加えたコードが無い（動かすときは --test）";
      },
      reason: () => (testChoice === undefined && localCode.length ? `社内で手を加えたコード ${localCode.length} ファイル` : ""),
      run: async () => {
        const t = await npmRun("typecheck");
        return t.ok ? npmRun("test") : t;
      },
    },
    { name: "build", title: "ビルド（npm run build）", run: () => npmRun("build") },
  ];
  async function npmRun(script) {
    const [cmd, args, shell] = npm(["run", script]);
    return run(cmd, args, { cwd: dir, env, shell, out });
  }

  const results = [];
  let failed = null;
  for (const [i, s] of steps.entries()) {
    const head = `${i + 1}/${steps.length} ${s.title}`;
    if (failed) {
      results.push({ name: s.name, title: s.title, status: "notRun", note: "" });
      continue;
    }
    const skip = typeof s.skip === "function" ? s.skip() : s.skip;
    if (skip) {
      out.log(`\n[${head}] 飛ばしました: ${skip}`);
      results.push({ name: s.name, title: s.title, status: "skipped", note: skip });
      continue;
    }
    const reason = s.reason?.() ?? "";
    if (reason) {
      out.log(`\n[${head}] 動かします: ${reason}`);
      out.detail(localCode.map((f) => `  ${f}`).join("\n"));
    }
    out.log(`\n[${head}]`);
    const t0 = now();
    let r;
    try {
      r = await s.run();
    } catch (e) {
      r = { ok: false, tail: [e instanceof CliError ? e.message : String(e?.stack ?? e)], code: e instanceof CliError ? 2 : 1 };
    }
    const took = seconds(now() - t0);
    if (r.ok && r.skipped) {
      out.log(`  飛ばしました: ${r.skipped}`);
      results.push({ name: s.name, title: s.title, status: "skipped", note: r.skipped });
    } else if (r.ok) {
      out.log(`  済み（${took}）`);
      results.push({ name: s.name, title: s.title, status: "ok", note: [reason, r.note, took].filter(Boolean).join("・") });
    } else {
      failed = { step: s, code: r.code ?? 1 };
      out.error(`  失敗しました（${took}）。最後の出力:\n${(r.tail ?? []).map((l) => `    ${l}`).join("\n")}`);
      results.push({ name: s.name, title: s.title, status: "failed", note: took });
    }
  }

  const mark = { ok: "済み    ", failed: "失敗    ", skipped: "飛ばした", notRun: "未実行  " };
  out.log("");
  out.log(failed ? `結果: ${failed.step.title} で止まりました` : "結果: すべて済みました");
  for (const [i, r] of results.entries()) out.log(`  ${mark[r.status]} ${i + 1}. ${r.title}${r.note ? `  ${r.note}` : ""}`);
  if (out.file) out.log(`ログ（UTF-8）: ${out.file}`);
  if (notes) out.log(`変更履歴の「更新後に行うこと」など ${notes} 行は、ログのファイルか CHANGELOG.md にあります。MR の中で済ませてください`);
  if (failed) {
    out.log("");
    out.log("直してから、もう一度 yojitsu-navi upgrade を実行してください（済んだところはやり直しても変わりません）");
  } else if (branch) {
    out.log("");
    out.log(`次に行うこと: git push -u origin ${branch} → GitLab で MR を作り、パイプラインが緑になったらリーダーがマージする`);
  }
  return { ok: !failed, code: failed ? failed.code : 0, steps: results.map(({ name, status, note }) => ({ name, status, note })) };
}
