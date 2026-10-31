---
title: リソース計画
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { T } from "./i18n/index.js";
import { pageHeader, errorState, loadModel } from "./components/layout.js";
import { mastersEditor, PLAN_VIEWS } from "./components/masters.js";
```

```js
const model = await loadModel(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const mastersData = model ? await FileAttachment("./data/masters.json").json().catch((error) => ({ error })) : null;
```

```js
if (model) {
  display(
    pageHeader({
      model: null,
      title: T.app.pages.plan,
      lead: T.plan.lead,
      breadcrumbs: [{ label: T.app.pages.plan }], // 全体サマリーの配下ではないので親を付けない（§69）
    }),
  );
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: T.mastersPage.loadFailed, error: mastersData.error }));
} else if (model && mastersData) {
  const params = new URLSearchParams(location.search);
  display(
    mastersEditor({
      data: mastersData,
      config: model.config,
      model,
      asOfMonth: model.meta.asOfMonth,
      minMonth: model.meta.minMonth,
      views: PLAN_VIEWS,
      initialTeam: params.get("team") || null,
      initialMember: params.get("member") || null,
      initialJump: params.get("jump"),
    }),
  );
}
```
