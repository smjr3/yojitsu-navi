/**
 * 工数の明細（SPEC §30.2）。工数画面と詳細画面の「作業種別の内訳」だけが読む。中身は _outputs.ts
 */
import { emitJson } from "./_shared.js";
import { AGGREGATE_OUTPUTS, createContext } from "./_outputs.js";

emitJson(() => AGGREGATE_OUTPUTS["work-hours"](createContext()));
