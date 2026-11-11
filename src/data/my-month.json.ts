/**
 * ヘッダー右上の「今月の残り」（SPEC §113）。GitLab のユーザー名 → 本人の今月の計画と実績。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["my-month"](createContext()));
