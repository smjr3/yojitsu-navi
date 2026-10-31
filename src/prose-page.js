// 読み物の画面（計算ルール・使い方）のページローダの共通部分。
// 本文は src/i18n/*.txt（Markdown）、見出しなどは src/i18n/ja.js から組み立てる。
// 本文の {名前} は PLACEHOLDERS にある名前だけを画面の値（${名前}）に置き換える（それ以外の波かっこはそのまま表示）。
// Framework はページローダの出力をキャッシュするので、ローカルで本文を直したら `npm run clean` してから preview/build する。
import { readFileSync } from "node:fs";

export const PLACEHOLDERS = [
  "contract", "customer", "project", "team", "member", "costTypes",
  "threshold", "fy", "fyStartMonth", "fyEndYear", "fyEndMonth", "fyFirstMonth", "fyLastMonth", "asOf", "asOfMonth", "asOfYm", "lastFinalMonth", "closingDay",
  "standardHours", "dayHours", "recentMonths", "methodDefault", "methodRecent3", "methodAll", "methodAssignment",
];

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

/** 本文（Markdown）を読み、コメントを除いて差し込み口を ${名前} にする */
export function readProse(file) {
  return readFileSync(new URL(`./i18n/${file}`, import.meta.url), "utf-8")
    .replace(/^﻿/, "")
    .replace(/<!--[\s\S]*?-->\n?/g, "")
    // インラインコード（`…`）の中は Markdown では ${} が効かないので、差し込み口を含むものは <code> に書き換える
    .replace(/`([^`\n]*\{\w+\}[^`\n]*)`/g, (whole, code) => ([...code.matchAll(/\{(\w+)\}/g)].some((m) => PLACEHOLDERS.includes(m[1])) ? `<code>${code}</code>` : whole))
    .replace(/\{(\w+)\}/g, (whole, name) => (PLACEHOLDERS.includes(name) ? `\${${name}}` : whole))
    .trim();
}

/**
 * 「## 番号. 名前」の見出しから目次を作る（行き先の id は numberHeadings が付ける）。
 * 名前の差し込み口は ${名前} のまま残す（Markdown の中で値に置き換わる）
 */
export function proseToc(body, label) {
  const items = [...body.matchAll(/^## (\d+)\. (.+)$/gm)].map((m) => `<li><a href="#${m[1]}">${m[1]}. ${escapeHtml(m[2]).replace(/\$\{(\w+)\}/g, "${$1}")}</a></li>`);
  return items.length ? `<nav class="yn-prose-toc" aria-label="${escapeHtml(label)}"><ol>${items.join("")}</ol></nav>` : "";
}

/**
 * 「## 番号. 名前」の見出しを id = 番号 の h2 にする（目次・本文のリンク #番号 の行き先）。
 * Framework に任せると、名前に英字が入ったとき id が「9-gitlab」のように変わってしまうため
 */
export function numberHeadings(body) {
  return body.replace(/^## (\d+)\. (.+)$/gm, (_, n, text) => `<h2 id="${n}" tabindex="-1">${n}. ${text}</h2>`);
}

/** ページ全体（front matter・設定値の読み込み・見出し・本文）を組み立てる */
export function prosePage({ title, leadKey, body, toc = "" }) {
  return `---
title: ${JSON.stringify(title)}
---

\`\`\`js
import { T, fmt } from "./i18n/index.js";
import { pageHeader, loadModel } from "./components/layout.js";
import { formatPercent, monthJa, METHOD_LABELS } from "./components/format.js";
\`\`\`

\`\`\`js
const model = await loadModel(FileAttachment("./data/model.json"));
const config = model?.config ?? {};
const meta = model?.meta ?? {};
const fyStartMonth = config.fiscalYearStartMonth ?? 4;
const fyEndMonth = ((fyStartMonth + 10) % 12) + 1;
const fy = meta.fiscalYear ?? new Date().getFullYear();
const fyEndYear = fyStartMonth === 1 ? fy : fy + 1;
const threshold = formatPercent(config.burnRateDangerThreshold ?? 1, 0);
const closingDay = config.closingBusinessDay ?? 3;
const recentMonths = config.forecastRecentMonths ?? 3;
const standardHours = config.standardHoursPerMonth ?? 160;
const dayHours = config.hoursPerBusinessDay ?? 8;
const labels = config.labels ?? T.rules.defaultLabels;
const { contract, customer, project, team, member } = labels;
const costTypes = (config.costTypes ?? []).map((t) => t.label).join("、") || T.rules.defaultCostType;
const asOf = meta.asOf ?? "—";
const asOfMonth = monthJa(meta.asOfMonth ?? "—");
const asOfYm = meta.asOfMonth ?? "—";
const fyFirstMonth = meta.fiscalYearMonths?.[0] ?? "—";
const fyLastMonth = meta.fiscalYearMonths?.at(-1) ?? "—";
const lastFinalMonth = monthJa(meta.lastFinalMonth ?? "—");
const methodDefault = METHOD_LABELS[config.forecastMethodDefault ?? "assignment"];
const methodRecent3 = METHOD_LABELS.recent3;
const methodAll = METHOD_LABELS.all;
const methodAssignment = METHOD_LABELS.assignment;
\`\`\`

\`\`\`js
if (model) {
  display(
    pageHeader({
      model,
      title: ${JSON.stringify(title)},
      lead: ${leadKey},
      breadcrumbs: [{ label: ${JSON.stringify(title)} }], // 全体サマリーの配下ではない（§69）
    }),
  );
}
\`\`\`

<div class="yn-prose">

${toc}

${body}

</div>
`;
}
