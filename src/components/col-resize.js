/**
 * 列幅を変える境目（列見出しの右端）の操作。マスタ編集・リソース計画の名前列・一覧表（dataTable）で共通。
 * ドラッグ、または矢印キー（Shift で大きく）で変え、ダブルクリック・Home で既定に戻す。
 * current() = 今の幅、apply(幅 | null, 覚えるか)。ドラッグ中は表を描き直さず幅だけ変え、覚えるのは離したとき
 */
export function bindColResizer(handle, current, apply) {
  handle.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    ev.preventDefault();
    ev.stopPropagation();
    const startX = ev.clientX;
    const startW = current();
    let last = null;
    handle.setPointerCapture?.(ev.pointerId);
    handle.classList.add("is-dragging");
    const move = (e) => {
      last = startW + e.clientX - startX;
      apply(last, false);
    };
    const up = () => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      handle.removeEventListener("pointercancel", up);
      handle.classList.remove("is-dragging");
      if (last != null) apply(last, true);
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
    handle.addEventListener("pointercancel", up);
  });
  handle.addEventListener("dblclick", (ev) => {
    ev.stopPropagation();
    apply(null, true);
  });
  // 列見出しの並べ替えなどへ伝わらないように
  handle.addEventListener("click", (ev) => ev.stopPropagation());
  handle.addEventListener("keydown", (ev) => {
    const step = ev.shiftKey ? 40 : 10;
    if (ev.key === "ArrowRight" || ev.key === "ArrowLeft") {
      ev.preventDefault();
      ev.stopPropagation();
      apply(current() + (ev.key === "ArrowRight" ? step : -step), true);
    } else if (ev.key === "Home") {
      ev.preventDefault();
      ev.stopPropagation();
      apply(null, true);
    }
  });
}
