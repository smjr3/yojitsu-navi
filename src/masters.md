---
title: マスタ編集
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { T } from "./i18n/index.js";
import { pageHeader, loadJson, errorState } from "./components/layout.js";
import { mastersEditor, LEDGER_VIEWS } from "./components/masters.js";
```

```js
// アサイン・リソース計画はリソース計画の画面で編集する（§36）。以前のリンク（?view=assignments / plan）はそちらへ
{
  const v = new URLSearchParams(location.search).get("view");
  if (v === "assignments" || v === "plan") {
    const q = new URLSearchParams(location.search);
    q.delete("view");
    location.replace(`./plan${q.toString() ? `?${q}` : ""}`);
  }
}
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
      // 全体の配下ではない（「⋯」から開く道具の画面）のでパンくずは出さない
      breadcrumbs: [],
    }),
  );
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: T.mastersPage.loadFailed, error: mastersData.error }));
} else if (model && mastersData) {
  const params = new URLSearchParams(location.search);
  display(mastersEditor({ data: mastersData, config: model.config, asOfMonth: model.meta.asOfMonth, minMonth: model.meta.minMonth, views: LEDGER_VIEWS, initialView: params.get("view"), initialTeam: params.get("team") || null, initialMember: params.get("member") || null, initialJump: params.get("jump") }));
}
```
