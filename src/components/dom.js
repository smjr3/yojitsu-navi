/**
 * 表の行・セルなど、数が多い部品を軽く作るための小さな関数（SPEC §106）
 *
 *   h("td", { class: "num", title: null }, "1,234", node, [more, children])
 *
 * htl の html`` は呼ぶたびに HTML 文字列を組み立てて解析するので、表の 1 マスごとに使うと重い。
 * こちらは document.createElement で直接作る。結果の DOM は html`` と同じ:
 * - 属性の値が null / undefined / false なら付けない。true は空の値で付ける。値の NUL は U+FFFD（HTML の解析と同じ）
 * - 子が null / undefined / false なら何も足さない。配列は展開する。文字列・数値は文字として足す（HTML として解釈しない）
 */
export function h(tag, attrs = null, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const k in attrs) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      // HTML として解析したときと同じく、属性の NUL は U+FFFD にする（CSS.escape で作るセレクタと合わせる）
      el.setAttribute(k, v === true ? "" : String(v).replaceAll("\u0000", "\uFFFD"));
    }
  }
  appendChildren(el, children);
  return el;
}

/** 子を足す（h と同じ規則） */
export function appendChildren(el, children) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
  return el;
}
