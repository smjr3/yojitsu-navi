// 計算ルール画面（ページローダ）: 本文は src/i18n/rules.txt（Markdown）。組み立ては src/prose-page.js（使い方画面と共通）
import ja from "./i18n/ja.js";
import { prosePage, readProse } from "./prose-page.js";

process.stdout.write(prosePage({ title: ja.app.pages.rules, leadKey: "T.rules.lead", body: readProse("rules.txt") }));
