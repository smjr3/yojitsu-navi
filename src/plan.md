---
title: 稼働計画
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-line"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { pageHeader, loadJson, errorState } from "./components/layout.js";
import { mastersEditor } from "./components/masters.js";
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
      title: "稼働計画",
      lead: "リーダーが、組織のメンバー一人ひとりの稼働計画（どの契約に月何人月）を入れる画面です。人月でも時間でも入力でき、保存は人月に揃えます。中身はマスタ編集の「アサイン」と同じデータで、保存できるのはリーダー層（GitLab の Developer 以上）だけです。",
      breadcrumbs: [{ label: "全体サマリー", href: "./" }, { label: "稼働計画" }],
    }),
  );
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: "マスタのデータを読み込めませんでした", error: mastersData.error }));
} else if (model && mastersData) {
  const params = new URLSearchParams(location.search);
  display(
    mastersEditor({
      data: mastersData,
      config: model.config,
      asOfMonth: model.meta.asOfMonth,
      minMonth: model.meta.minMonth,
      initialView: "plan",
      initialTeam: params.get("team") || null,
      initialMember: params.get("member") || null,
    }),
  );
}
```
