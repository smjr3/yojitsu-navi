---
title: 設定
---

<div id="page-skeleton" class="yn-skeleton" aria-busy="true" aria-label="読み込み中">
  <div class="yn-skel-line yn-skel-title"></div>
  <div class="yn-skel-block"></div>
</div>

```js
import { T } from "./i18n/index.js";
import { pageHeader, loadJson } from "./components/layout.js";
import { settingsPanel } from "./components/settings.js";
```

```js
// 接続先（config.json の masterEdit）はマスタ編集と同じデータから読む
const mastersData = await loadJson(FileAttachment("./data/masters.json"), { skeleton: "page-skeleton" });
```

```js
display(pageHeader({ model: null, title: T.app.pages.settings, lead: T.settings.lead }));
if (mastersData) display(settingsPanel({ masterEdit: mastersData.masterEdit }));
```
