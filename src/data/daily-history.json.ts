/**
 * グラフの日・週（SPEC §130）。案件・月・日ごとの実績（日・週を選んだときだけ読む）。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["daily-history"](createContext()));
