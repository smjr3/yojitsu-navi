/**
 * メンバー詳細のグラフの日・週（SPEC §130）。メンバー・月・日ごとの実績の時間と計画の重み。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["member-days"](createContext()));
