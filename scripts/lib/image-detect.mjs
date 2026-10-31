// 画像ファイルの判定（拡張子と先頭のバイト）。リポジトリ全体の検査（tests/unit/docs-links.test.ts）と
// npm パッケージを作るとき（scripts/build-app.mjs・build-core.mjs）で同じものを使う
import { closeSync, openSync, readSync, statSync } from "node:fs";

export const IMAGE_EXT = /\.(png|jpe?g|jfif|gif|webp|avif|heic|heif|bmp|tiff?|ico|icns|svgz?|psd|xcf|eps)$/i;

/** 先頭のバイトで画像と分かるか（拡張子を変えた・付けていない画像も見つける） */
export function looksLikeImage(abs) {
  if (!statSync(abs).isFile()) return false;
  const head = Buffer.alloc(64);
  const fd = openSync(abs, "r");
  const n = readSync(fd, head, 0, 64, 0);
  closeSync(fd);
  const buf = head.subarray(0, n);
  const hex = buf.toString("hex");
  const raw = buf.toString("latin1");
  const text = raw.trimStart();
  return (
    hex.startsWith("89504e47") || // PNG
    hex.startsWith("ffd8ff") || // JPEG
    raw.startsWith("GIF8") ||
    (raw.startsWith("RIFF") && raw.slice(8, 12) === "WEBP") ||
    /^....ftyp(avif|avis|heic|heix|mif1)/s.test(raw) ||
    (hex.startsWith("424d") && n >= 18 && [12, 40, 52, 56, 64, 108, 124].includes(buf.readUInt32LE(14))) || // BMP（ヘッダ長で確かめる）
    hex.startsWith("49492a00") || hex.startsWith("4d4d002a") || // TIFF
    hex.startsWith("00000100") || // ICO
    raw.startsWith("8BPS") || // PSD
    /^(<\?xml[^>]*\?>\s*)?<svg\b/i.test(text)
  );
}

/** 画像か（拡張子または中身） */
export const isImage = (path, abs) => IMAGE_EXT.test(path) || looksLikeImage(abs);
