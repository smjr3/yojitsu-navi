/**
 * 今月の進捗（SPEC §61）。asOf の月の、案件ごと・日ごとの実績（速報）。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS.daily(createContext()));
