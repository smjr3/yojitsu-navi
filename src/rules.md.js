// 計算ルール画面（ページローダ）: 本文は src/i18n/rules.txt（Markdown）、見出しなどは src/i18n/ja.js から組み立てる。
// 本文の {名前} は下の PLACEHOLDERS にある名前だけを画面の値（${名前}）に置き換える（それ以外の波かっこはそのまま表示）。
// Framework はページローダの出力をキャッシュするので、ローカルで rules.txt を直したら `npm run clean` してから preview/build する。
import { readFileSync } from "node:fs";
import ja from "./i18n/ja.js";

const PLACEHOLDERS = [
  "contract", "customer", "project", "team", "member", "costTypes",
  "threshold", "fy", "fyStartMonth", "fyEndYear", "fyEndMonth", "asOf", "asOfMonth", "lastFinalMonth", "closingDay",
  "standardHours", "dayHours", "recentMonths", "methodDefault", "methodRecent3", "methodAll", "methodAssignment",
];

const body = readFileSync(new URL("./i18n/rules.txt", import.meta.url), "utf-8")
  .replace(/^﻿/, "")
  .replace(/<!--[\s\S]*?-->\n?/g, "")
  // インラインコード（`…`）の中は Markdown では ${} が効かないので、差し込み口を含むものは <code> に書き換える
  .replace(/`([^`\n]*\{\w+\}[^`\n]*)`/g, (whole, code) => (/\{(\w+)\}/.test(code) && [...code.matchAll(/\{(\w+)\}/g)].some((m) => PLACEHOLDERS.includes(m[1])) ? `<code>${code}</code>` : whole))
  .replace(/\{(\w+)\}/g, (whole, name) => (PLACEHOLDERS.includes(name) ? `\${${name}}` : whole))
  .trim();


process.stdout.write(`---
title: ${JSON.stringify(ja.app.pages.rules)}
---

\`\`\`js
import { T, fmt } from "./i18n/index.js";
import { pageHeader, loadJson } from "./components/layout.js";
import { formatPercent, monthJa, METHOD_LABELS } from "./components/format.js";
\`\`\`

\`\`\`js
const model = await loadJson(FileAttachment("./data/model.json"));
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
const lastFinalMonth = monthJa(meta.lastFinalMonth ?? "—");
const methodDefault = METHOD_LABELS[config.forecastMethodDefault ?? "recent3"];
const methodRecent3 = METHOD_LABELS.recent3;
const methodAll = METHOD_LABELS.all;
const methodAssignment = METHOD_LABELS.assignment;
\`\`\`

\`\`\`js
if (model) {
  display(
    pageHeader({
      model,
      title: T.app.pages.rules,
      lead: T.rules.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: "./" }, { label: T.app.pages.rules }],
    }),
  );
}
\`\`\`

<div class="yn-prose">

${body}

</div>
`);
