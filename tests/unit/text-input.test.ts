/** 検索欄は日本語の変換中に反映しない（SPEC §105） */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { onTextInput } from "../../src/components/text-input.js";

const ev = (type: string, isComposing = false) => Object.assign(new Event(type), { isComposing });

describe("onTextInput", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("打ち終わってから 1 回だけ反映する", () => {
    const el = new EventTarget();
    const apply = vi.fn();
    onTextInput(el, apply);
    el.dispatchEvent(ev("input"));
    vi.advanceTimersByTime(100);
    el.dispatchEvent(ev("input"));
    vi.advanceTimersByTime(149);
    expect(apply).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("変換中（compositionstart〜compositionend）は反映せず、確定してから反映する", () => {
    const el = new EventTarget();
    const apply = vi.fn();
    onTextInput(el, apply);
    el.dispatchEvent(ev("compositionstart"));
    el.dispatchEvent(ev("input", true));
    el.dispatchEvent(ev("input")); // isComposing を付けないブラウザでも止める
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalled();
    el.dispatchEvent(ev("compositionend"));
    vi.advanceTimersByTime(150);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("変換の前に打った分の反映も、変換が始まったら待つ（変換中に描き直さない）", () => {
    const el = new EventTarget();
    const apply = vi.fn();
    onTextInput(el, apply);
    el.dispatchEvent(ev("input"));
    vi.advanceTimersByTime(50);
    el.dispatchEvent(ev("compositionstart"));
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalled();
    el.dispatchEvent(ev("compositionend"));
    vi.advanceTimersByTime(150);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("isComposing の付いた input は compositionstart が無くても反映しない", () => {
    const el = new EventTarget();
    const apply = vi.fn();
    onTextInput(el, apply);
    el.dispatchEvent(ev("input", true));
    vi.advanceTimersByTime(1000);
    expect(apply).not.toHaveBeenCalled();
  });

  it("flush は待っている反映をすぐ行い、cancel はやめる", () => {
    const el = new EventTarget();
    const apply = vi.fn();
    const h = onTextInput(el, apply);
    h.flush();
    expect(apply).not.toHaveBeenCalled();
    el.dispatchEvent(ev("input"));
    h.flush();
    expect(apply).toHaveBeenCalledTimes(1);
    el.dispatchEvent(ev("input"));
    h.cancel();
    vi.advanceTimersByTime(1000);
    expect(apply).toHaveBeenCalledTimes(1);
  });
});
