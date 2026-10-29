"""画面フォント（BIZ UDPゴシック）の同梱ファイル src/fonts/*.woff2 を作る（docs/UI_NOTES.md「フォント」）

    pip install fonttools brotli
    python3 scripts/fonts/build_fonts.py <BIZUDPGothic-Regular.ttf> <BIZUDPGothic-Bold.ttf>

元の TTF は Google Fonts（https://fonts.google.com/specimen/BIZ+UDPGothic）の配布物。SIL Open Font License 1.1。
変更は 2 点だけ:
  - 「1」の送り幅が他の数字より狭いので、他の数字と同じ幅にして中央に寄せる（表の桁がそろう。§46）
  - ライセンス本文（src/fonts/OFL.txt）をフォントの name 表（ID 13）に入れる（配信物にライセンスを添えるため）
字形・ヒンティングは変えない。グリフはすべて残す（人名・顧客名の第2水準以上の漢字でも別フォントに落ちない）。
"""
import os
import sys

from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "..", "..", "src", "fonts")


def build(src: str, style: str) -> None:
    font = TTFont(src)
    cmap = font.getBestCmap()
    hmtx = font["hmtx"]
    widths = {hmtx[cmap[ord(c)]][0] for c in "023456789"}
    if len(widths) != 1:
        sys.exit(f"{src}: 「1」以外の数字の幅がそろっていません {sorted(widths)}")
    full = widths.pop()
    one = cmap[ord("1")]
    adv, _ = hmtx[one]
    if adv != full:
        shift = (full - adv) // 2
        glyph = font["glyf"][one]
        glyph.coordinates.translate((shift, 0))
        glyph.recalcBounds(font["glyf"])
        hmtx[one] = (full, glyph.xMin)
    with open(os.path.join(OUT, "OFL.txt"), encoding="utf-8") as f:
        font["name"].setName(f.read(), 13, 3, 1, 0x409)
    font.flavor = "woff2"
    out = os.path.join(OUT, f"BIZUDPGothic-{style}.woff2")
    font.save(out)
    print(f"{os.path.relpath(out)}  {os.path.getsize(out) // 1024} KB")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    build(sys.argv[1], "Regular")
    build(sys.argv[2], "Bold")
