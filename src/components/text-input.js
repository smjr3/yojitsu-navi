/**
 * 検索・絞り込みの入力欄で、打ち終わってから反映する（SPEC §105）。
 *
 *   onTextInput(input, apply, delay?) → { flush(), cancel() }
 *
 * - 打つたびではなく、最後に打ってから delay ミリ秒（既定 150）たってから apply を 1 回呼ぶ
 * - 日本語入力（IME）で変換している間は呼ばない。確定（compositionend）してから呼ぶ。
 *   変換中に表を描き直したり入力欄を作り直したりすると、変換中の文字が勝手に確定されるため
 * - flush: 待っている反映をすぐ行う（ポップアップを閉じるときなど）。cancel: 待っている反映をやめる
 */
export function onTextInput(input, apply, delay = 150) {
  let composing = false;
  let timer = null;
  const cancel = () => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const schedule = () => {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      apply();
    }, delay);
  };
  input.addEventListener("compositionstart", () => {
    composing = true;
    cancel();
  });
  input.addEventListener("compositionend", () => {
    composing = false;
    schedule();
  });
  input.addEventListener("input", (ev) => {
    if (composing || ev.isComposing) return;
    schedule();
  });
  return {
    flush() {
      if (timer === null) return;
      cancel();
      apply();
    },
    cancel,
  };
}
