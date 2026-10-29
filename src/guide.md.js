// 使い方画面（ページローダ）: 本文は src/i18n/guide.txt（Markdown）。組み立ては src/prose-page.js（計算ルール画面と共通）
// 利用者向けのマニュアル。外部の文書（README など）へ誘導せず、この画面の中で完結させる（§47）
import ja from "./i18n/ja.js";
import { numberHeadings, prosePage, proseToc, readProse } from "./prose-page.js";

const body = readProse("guide.txt");
process.stdout.write(prosePage({ title: ja.app.pages.guide, leadKey: "T.guide.lead", body: numberHeadings(body), toc: proseToc(body, ja.guide.tocLabel) }));
