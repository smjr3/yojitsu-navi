/**
 * メンバー別の画面（/members, /member）が読むデータ（SPEC §18）。Model.memberMonths と単価の変遷。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["member-months"](createContext()));
