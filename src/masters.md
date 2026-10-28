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
      title: "マスタ編集",
      lead: "メンバーの所属・役職、時間単価、チーム、アサインを画面で直して保存する画面です。誰でも見られますが、保存できるのはリーダー層（GitLab の Developer 以上）だけです。保存した内容は、CI がビルドし直したあとに各画面の数値へ反映されます。",
      breadcrumbs: [{ label: "全体サマリー", href: "./" }, { label: "マスタ編集" }],
    }),
  );
}
```

```js
if (model && mastersData && !mastersData.error) {
  const mode = effectiveSaveMode(mastersData.masterEdit);
  display(html`<section class="yn-me-intro" aria-labelledby="yn-me-intro-title">
    <h2 id="yn-me-intro-title" class="yn-me-intro-title">はじめての方へ: 何を編集すると何が変わるか</h2>
    <dl class="yn-me-intro-grid">
      <div><dt>メンバー</dt><dd>所属チーム・役職。<strong>役職</strong>を変えると、その月からの<strong>時間単価</strong>が変わり原価が変わります。</dd></div>
      <div><dt>単価</dt><dd>役職ごと・パートナー個人の時間単価。<strong>原価 = 作業時間 × 単価</strong> なので、原価・粗利・消化率・着地見込みが変わります。</dd></div>
      <div><dt>組織</dt><dd>組織の名前・種別（課・チーム・班など自由）・親子関係・リーダー。チーム一覧の組織の木と、上位組織の合計が変わります。</dd></div>
      <div><dt>アサイン／稼働計画</dt><dd>誰をどの契約に何人月割り当てるか。「稼働計画」タブでは組織のメンバー別・月別にまとめて見ながら入力できます（人月でも時間でも入力可）。着地見込み（アサイン方式）とメンバー別の計画が変わります。</dd></div>
    </dl>
    <p class="yn-me-intro-rule"><strong>履歴は「行を追加」で残します。</strong>「4月から単価を変える」なら、既存の行は書き換えず、適用開始月を 4 月にした行を追加します。適用開始月より前の月は、これまでの値のまま計算されます。過去の月の数値が変わる操作には、適用前に影響する月数を表示します（計算基準日 ${dateIso(model.meta.asOf)}、${monthJa(model.meta.asOfMonth)} までを「過去」として数えます）。</p>
    <ol class="yn-me-flow" aria-label="保存までの流れ">
      <li><span class="yn-me-flow-n" aria-hidden="true">1</span> タブでファイルを選んで編集</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">2</span> 「検証」でエラーが無いことを確認</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">3</span> 「変更内容」で差分を確認</li>
      <li><span class="yn-me-flow-n" aria-hidden="true">4</span> ${mode === "gitlab" ? "GitLab に保存（マージリクエスト／コミット）" : "CSV をダウンロードして GitLab にアップロード"}</li>
    </ol>
    <p class="yn-me-small">編集中の内容は、このブラウザに下書きとして自動保存されます（保存するまで他の人には見えません）。下書きのあとに他の人が元データを更新していたら、復元のときに下書きの変更を最新のデータに当て直します（同じ行を両方で変えていれば、どちらを残すか選びます）。</p>
  </section>`);
}
```

```js
if (model && mastersData?.error) {
  display(errorState({ title: "マスタのデータを読み込めませんでした", error: mastersData.error }));
} else if (model && mastersData) {
  const params = new URLSearchParams(location.search);
  display(mastersEditor({ data: mastersData, config: model.config, asOfMonth: model.meta.asOfMonth, minMonth: model.meta.minMonth, initialView: params.get("view"), initialTeam: params.get("team") || null, initialMember: params.get("member") || null }));
}
```
