---
title: マスタ編集
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { html } from "htl";
import { T, fmt, rich } from "./i18n/index.js";
import { pageHeader, loadJson, errorState } from "./components/layout.js";
import { mastersEditor } from "./components/masters.js";
import { effectiveSaveMode } from "./core/gitlab.js";
import { dateIso, monthJa } from "./components/format.js";
```

```js
const model = await loadJson(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const mastersData = model ? await FileAttachment("./data/masters.json").json().catch((error) => ({ error })) : null;
```

```js
if (model) {
  display(
    pageHeader({
      model: null,
      title: T.app.pages.masters,
      lead: T.mastersPage.lead,
      breadcrumbs: [{ label: T.app.pages.index, href: "./" }, { label: T.app.pages.masters }],
    }),
  );
}
```

```js
if (model && mastersData && !mastersData.error) {
  const mode = effectiveSaveMode(mastersData.masterEdit);
  display(html`<section class="yn-me-intro" aria-labelledby="yn-me-intro-title">
    <h2 id="yn-me-intro-title" class="yn-me-intro-title">${T.mastersPage.introTitle}</h2>
    <dl class="yn-me-intro-grid">
      <div><dt>${T.masterFiles.members}</dt><dd>${rich(T.mastersPage.introMembers)}</dd></div>
      <div><dt>${T.masterFiles.rates}</dt><dd>${rich(T.mastersPage.introRates)}</dd></div>
      <div><dt>${T.masterFiles.teams}</dt><dd>${rich(T.mastersPage.introTeams)}</dd></div>
      <div><dt>${T.masterFiles.assignments}</dt><dd>${rich(T.mastersPage.introAssignments)}</dd></div>
    </dl>
    <p class="yn-me-intro-rule">${rich(T.mastersPage.introRule, { asOf: dateIso(model.meta.asOf), month: monthJa(model.meta.asOfMonth) })}</p>
    <ol class="yn-me-flow" aria-label=${T.mastersPage.flowLabel}>
      <li><span class="yn-me-flow-n" aria-hidden="true">1</span> ${T.mastersPage.flow1}</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">2</span> ${T.mastersPage.flow2}</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">3</span> ${T.mastersPage.flow3}</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">4</span> ${mode === "gitlab" ? T.mastersPage.flow4Gitlab : T.mastersPage.flow4Download}</li>
    </ol>
    <p class="yn-me-small">${T.mastersPage.draftNote}</p>
  </section>`);
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: T.mastersPage.loadFailed, error: mastersData.error }));
} else if (model && mastersData) {
  display(mastersEditor({ data: mastersData, config: model.config, asOfMonth: model.meta.asOfMonth, minMonth: model.meta.minMonth }));
}
```
