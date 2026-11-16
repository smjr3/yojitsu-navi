// 版上げと公開で使う小さな関数（scripts/bump-version.mjs・scripts/ci/publish-npm.mjs。SPEC §121）。開発元のリポジトリだけで使う

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)$/;

/** 今の版と指定（patch など、または x.y.z）から次の版 */
export function nextVersion(current, spec) {
  const m = VERSION_RE.exec(current);
  if (!m) throw new Error(`今の版 ${current} が x.y.z の形ではありません`);
  const [a, b, c] = m.slice(1).map(Number);
  if (spec === "major") return `${a + 1}.0.0`;
  if (spec === "minor") return `${a}.${b + 1}.0`;
  if (spec === "patch") return `${a}.${b}.${c + 1}`;
  if (VERSION_RE.test(spec ?? "")) return spec;
  throw new Error("patch・minor・major か x.y.z を指定してください");
}

/** CHANGELOG の「## 次の版」を「## <版>」にした文章 */
export function renameNextHeading(text, v) {
  const re = /^##\s+次の版[^\S\r\n]*$/m;
  if (!re.test(text)) throw new Error("CHANGELOG.md に「## 次の版」がありません。導入先に届く変更を書いてから版を上げてください");
  return text.replace(re, `## ${v}`);
}

/** CHANGELOG.md の「## <版>」の中身（リリースの説明に使う） */
export function releaseNotes(text, v) {
  const lines = String(text).split(/\r?\n/);
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${v.replace(/\./g, "\\.")}(?![\\d.])`).test(l));
  if (start < 0) return "";
  let end = lines.findIndex((l, i) => i > start && /^##\s/.test(l) && !l.startsWith("###"));
  if (end < 0) end = lines.length;
  return lines.slice(start + 1, end).join("\n").trim();
}
