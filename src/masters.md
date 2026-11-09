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
import { pageHeader, errorState, loadModel } from "./components/layout.js";
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
const model = await loadModel(FileAttachment("./data/model.json"), { skeleton: "page-skeleton" });
const mastersData = model ? await FileAttachment("./data/masters.json").json().catch((error) => ({ error })) : null;
```

```js
if (model) {
  display(
    pageHeader({
      model: null,
      title: T.app.pages.masters,
      lead: T.mastersPage.lead,
      breadcrumbs: [{ label: T.app.pages.masters }], // 全体サマリーの配下ではない（§69）
    }),
  );
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: T.mastersPage.loadFailed, error: mastersData.error }));
} else if (model && mastersData) {
  const params = new URLSearchParams(location.search);
  // ?q=検索語・?unset=未設定の種類・?new=1&列名=値（追加のダイアログの初期値。§101）
  const initialAdd = params.get("new") === "1" ? Object.fromEntries([...params].filter(([k]) => /^[a-z_]+$/.test(k) && !["view", "new", "q", "unset", "jump", "team", "member"].includes(k))) : null;
  display(mastersEditor({ data: mastersData, config: model.config, asOfMonth: model.meta.asOfMonth, minMonth: model.meta.minMonth, views: LEDGER_VIEWS, initialView: params.get("view"), initialTeam: params.get("team") || null, initialMember: params.get("member") || null, initialJump: params.get("jump"), initialQuery: params.get("q") || null, initialUnset: params.get("unset") || null, initialAdd }));
}
```
