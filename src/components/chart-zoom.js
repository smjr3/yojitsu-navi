/**
 * グラフの枠（凡例＋拡大ボタン＋グラフ本体）と拡大表示ダイアログ。全グラフ共通。
 * draw(width, height?) を渡すと、画面の幅に合わせて描き直す。拡大時はダイアログの広さで描き直す
 * （画像の拡大ではなく再描画なので、月の目盛りやツールチップがそのまま使える）。
 */
import { html } from "htl";
import { T } from "../i18n/index.js";

/** 幅が変わったら描き直す。同じ幅なら描き直さない（ツールチップの状態を保つ） */
function autoSize(host, draw, getHeight = () => undefined) {
  let last = "";
  let frame = 0;
  const render = () => {
    frame = 0;
    const width = Math.floor(host.clientWidth);
    if (width <= 0) return;
    const height = getHeight();
    const key = `${width}x${height ?? ""}`;
    if (key === last) return;
    last = key;
    host.replaceChildren(draw(width, height));
  };
  const schedule = () => {
    if (!frame) frame = requestAnimationFrame(render);
  };
  let ro = null;
  if (typeof ResizeObserver !== "undefined") {
    ro = new ResizeObserver(schedule);
    ro.observe(host);
  }
  render();
  return { render: schedule, disconnect: () => ro?.disconnect() };
}

let zoomEl = null;
let zoomSizer = null;
let zoomOpener = null;

function ensureZoomDialog() {
  if (zoomEl && zoomEl.isConnected) return zoomEl;
  const dialog = html`<dialog class="yn-dialog yn-chart-zoom" aria-labelledby="yn-chart-zoom-title">
    <div class="yn-dialog-inner">
      <header class="yn-dialog-head">
        <div class="yn-chart-zoom-titles">
          <h2 id="yn-chart-zoom-title" class="yn-dialog-title"></h2>
          <p class="yn-chart-zoom-sub"></p>
        </div>
        <button type="button" class="yn-btn yn-btn-icon yn-dialog-close" aria-label=${T.charts.zoomClose}>×</button>
      </header>
      <div class="yn-chart-zoom-body">
        <div class="yn-chart-zoom-legend"></div>
        <div class="yn-chart-zoom-plot"></div>
        <p class="yn-chart-zoom-rotate">${T.charts.zoomRotateHint}</p>
      </div>
    </div>
  </dialog>`;
  const close = () => dialog.close();
  dialog.querySelector(".yn-dialog-close").addEventListener("click", close);
  dialog.addEventListener("click", (ev) => {
    if (ev.target === dialog) close();
  });
  dialog.addEventListener("close", () => {
    zoomSizer?.disconnect();
    zoomSizer = null;
    dialog.querySelector(".yn-chart-zoom-plot").replaceChildren();
    dialog.querySelector(".yn-chart-zoom-legend").replaceChildren();
    if (zoomOpener?.isConnected) zoomOpener.focus();
    zoomOpener = null;
  });
  document.body.appendChild(dialog);
  zoomEl = dialog;
  return dialog;
}

/** 拡大表示を開く。draw はダイアログの幅・高さで呼ばれる */
export function openChartZoom({ title, subtitle = null, legend = null, draw }, opener = null) {
  const dialog = ensureZoomDialog();
  zoomOpener = opener ?? document.activeElement;
  dialog.querySelector("#yn-chart-zoom-title").textContent = title ?? T.charts.zoomTitle;
  // 何のグラフか分かるように、画面の見出し（チーム名・案件名など）と期間を添える
  const pageTitle = document.querySelector(".yn-page-title")?.textContent?.trim() ?? "";
  const sub = [pageTitle, subtitle].filter(Boolean).join(" ・ ");
  const subEl = dialog.querySelector(".yn-chart-zoom-sub");
  subEl.textContent = sub;
  subEl.hidden = sub === "";
  const legendHost = dialog.querySelector(".yn-chart-zoom-legend");
  legendHost.replaceChildren(...(legend ? [typeof legend === "function" ? legend() : legend.cloneNode(true)] : []));
  const plotHost = dialog.querySelector(".yn-chart-zoom-plot");
  plotHost.replaceChildren();
  zoomSizer?.disconnect();
  if (!dialog.open) dialog.showModal();
  // 高さは枠の残り（凡例・注記を除く）。低すぎると読めないので下限を設ける
  zoomSizer = autoSize(plotHost, draw, () => Math.max(180, Math.floor(plotHost.clientHeight) - 8));
  dialog.querySelector(".yn-dialog-close").focus();
  return dialog;
}

export function closeChartZoom() {
  if (zoomEl?.open) zoomEl.close();
}

/** 拡大ボタン単体（独自の枠を持つグラフ向け） */
export function chartZoomButton({ title, subtitle = null, legend = null, draw }) {
  const btn = html`<button type="button" class="yn-btn yn-btn-sm yn-chart-zoom-btn" aria-haspopup="dialog" aria-label=${`${T.charts.zoom}: ${title ?? ""}`.trim()} title=${T.charts.zoomTip}><span aria-hidden="true">⤢</span><span class="yn-chart-zoom-label">${T.charts.zoom}</span></button>`;
  btn.addEventListener("click", () => openChartZoom({ title, subtitle, legend, draw }, btn));
  return btn;
}

/**
 * グラフの枠。凡例の右に拡大ボタンを置き、本体は幅に合わせて描き直す。
 * after には枠内でグラフの下に置くもの（表の折りたたみなど）を渡す。
 */
export function chartFigure({ title, subtitle = null, legend = null, draw, after = null, className = "" }) {
  const plot = html`<div class="yn-chart-plot"></div>`;
  const fig = html`<figure class=${`yn-card yn-chart-card ${className}`.trim()}>
    <div class="yn-chart-head">
      <div class="yn-chart-head-legend">${legend}</div>
      ${chartZoomButton({ title, subtitle, legend, draw })}
    </div>
    ${plot}
    ${after}
  </figure>`;
  // 画面に入ってから幅を測る（display 前は幅 0）
  let sizer = null;
  const start = () => {
    if (!sizer) sizer = autoSize(plot, (w) => draw(w));
  };
  if (typeof requestAnimationFrame !== "undefined") requestAnimationFrame(start);
  else start();
  return fig;
}
