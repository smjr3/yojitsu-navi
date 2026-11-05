// yojitsu-navi upgrade（SPEC §94）: 版を上げる作業を 1 回で行う。
// update → 依存を入れる（npm ci）→ CI のファイルの確認 → データ検証 → テスト（既定は飛ばす）→ ビルド。
// 失敗したところで止まり、最後に結果の要約を出す。全部の出力はログのファイル（UTF-8）に残す
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { CliError, check, update } from "./project.mjs";

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
    const keep = (chunk) => {
      const text = chunk.toString("utf-8");
      o.out.fileOnly(text.replace(/\n$/, ""));
      for (const line of text.split(/\r?\n/)) if (line) tail.push(line);
      if (tail.length > 40) tail.splice(0, tail.length - 40);
    };
    let child;
    try {
      child = spawn(cmd, args, { cwd: o.cwd, env: o.env, shell: o.shell ?? false, windowsHide: true });
    } catch (e) {
      done({ ok: false, tail: [String(e)] });
      return;
    }
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (e) => done({ ok: false, tail: [...tail, String(e)] }));
    child.on("close", (code) => done({ ok: code === 0, tail }));
  });
}

const seconds = (ms) => `${Math.max(1, Math.round(ms / 1000))} 秒`;

/**
 * @param {{ pkgDir: string, version: string, dir: string, out: ReturnType<import("./output.mjs").createOutput>,
 *   update?: object, test?: boolean, env?: NodeJS.ProcessEnv, now?: () => number }} o
 *   update: update に渡すオプション（overwrite・keepLocal・force・commit）
 *   test: テストを動かす（既定は環境変数 YOJITSU_RUN_TESTS=1 のときだけ。CI の test ジョブと同じ）
 * @returns {Promise<{ ok: boolean, code: number, steps: { name: string, status: "ok" | "failed" | "skipped" | "notRun", note: string }[] }>}
 */
export async function upgrade(o) {
  const { dir, out } = o;
  const env = { ...(o.env ?? process.env) };
  const now = o.now ?? Date.now;
  const runTests = o.test ?? env.YOJITSU_RUN_TESTS === "1";
  const npm = (args) => npmCommand(args, env);
  let committed = true;
  let branch = "";
  let notes = 0;
  /** @type {{ name: string, title: string, run: () => Promise<{ ok: boolean, note?: string, tail?: string[], code?: number }> | { ok: boolean, note?: string, tail?: string[], code?: number }, skip?: string }[]} */
  const steps = [
    {
      name: "update",
      title: "ファイルを新しい版にする（update）",
      run: () => {
        const r = update({ ...o.update, pkgDir: o.pkgDir, version: o.version, dir, log: out.log, detail: out.detail });
        committed = Boolean(r.commit) || (!r.changed.length && !r.added.length && !r.removed.length && o.update?.commit !== false);
        branch = r.commit?.branch ?? "";
        notes = r.notes.length;
        const note = `変更 ${r.changed.length}・追加 ${r.added.length}・削除 ${r.removed.length}${r.commit ? `・ブランチ ${r.commit.branch} にコミット（${r.commit.hash}）` : r.changed.length + r.added.length + r.removed.length ? "・コミットしていない" : ""}`;
        const warn = [r.sampleLeft.length ? `サンプルのまま残っているデータ ${r.sampleLeft.length}` : "", r.extras.length ? `パッケージに無いファイル ${r.extras.length}` : ""].filter(Boolean);
        return { ok: true, note: warn.length ? `${note}（要確認: ${warn.join("・")}）` : note };
      },
    },
    {
      name: "install",
      title: "依存を入れる（npm ci）",
      run: async () => {
        // CI と同じ入れ方（依存込みのプロジェクトは vendor/npm-cache から。社内ミラーは NPM_CONFIG_REGISTRY・.npmrc）
        const script = join(dir, "scripts", "ci", "install.mjs");
        const [cmd, args, shell] = existsSync(script) ? [process.execPath, [script], false] : npm(["ci", "--no-audit", "--no-fund"]);
        return run(cmd, args, { cwd: dir, env, shell, out });
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
      skip: runTests ? "" : "既定では動かさない（--test か YOJITSU_RUN_TESTS=1）",
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
    if (s.skip) {
      out.log(`\n[${head}] 飛ばしました: ${s.skip}`);
      results.push({ name: s.name, title: s.title, status: "skipped", note: s.skip });
      continue;
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
    if (r.ok) {
      out.log(`  済み（${took}）`);
      results.push({ name: s.name, title: s.title, status: "ok", note: [r.note, took].filter(Boolean).join("・") });
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
