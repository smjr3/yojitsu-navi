// yojitsu-navi コマンドの出力（SPEC §94）。画面と、指定があればログのファイル（UTF-8・BOM 付き）に書く。
// Windows の PowerShell で日本語が化けるときも、ログのファイルは UTF-8 で読める（メモ帳・VS Code・Get-Content がそのまま開ける）
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * @param {{ file?: string, summary?: boolean, screen?: (s: string) => void, errScreen?: (s: string) => void }} o
 *   summary: 画面には要約（log）だけを出し、詳しい行（detail）はファイルにだけ書く
 */
export function createOutput(o = {}) {
  const screen = o.screen ?? ((s) => console.log(s));
  const errScreen = o.errScreen ?? ((s) => console.error(s));
  const file = o.file || "";
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "﻿");
  }
  const toFile = (s) => {
    if (file) appendFileSync(file, `${String(s).replace(/\r?\n/g, "\n")}\n`);
  };
  return {
    file,
    /** 画面とファイルの両方 */
    log(s) {
      screen(s);
      toFile(s);
    },
    /** 詳しい行。要約のときはファイルだけ */
    detail(s) {
      if (!o.summary) screen(s);
      toFile(s);
    },
    error(s) {
      errScreen(s);
      toFile(s);
    },
    /** ファイルだけ（子のプロセスの出力など） */
    fileOnly(s) {
      toFile(s);
    },
  };
}
