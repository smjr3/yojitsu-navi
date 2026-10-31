/**
 * 計算基準日の置き換え（SPEC §74）
 *
 * 作業実績の取り込みは毎日成功するとは限らないので、画面の「今日」は取り込んだ日（＝ビルドした日）ではなく、
 * 開いている人の今日（日本時間）にする。ビルド済みの Model（作業ログ明細なし）だけで、asOf に依る値を計算し直す:
 *   - meta: asOf・asOfMonth・確定済みの最新月・年度・年度の月・前年同期比の可否
 *   - 契約の月の状態（確定・速報・未来）と着地見込み（既定の対象 = 新しい asOf の年度）
 *   - リソース計画の明細（新しい asOf 月より前を落とす）
 *   - 組織の木（asOf 月の組織）
 * 実績・予算そのもの（作業ログから作る値）は変わらない。取り込んだ時点は meta.worklogFetchedAt のまま。
 */
import { addMonths, fiscalYearMonths, fiscalYearOf, isValidISODate, monthOfDate, todayJst } from "./calendar.js";
import { forecastAllMethodsForMonths } from "./forecast.js";
import { HolidaySet } from "./holidays.js";
import { teamTreeAt } from "./masters.js";
import { lastFinalMonth, monthStatus, type StatusContext } from "./status.js";
import type { ContractMonth, ISODate, Model, ModelMeta, YearMonth } from "./types.js";

/**
 * 画面で使う計算基準日。YOJITSU_AS_OF で固定したビルド（asOfFixed）はそのまま、
 * それ以外は日本時間の今日。ただしビルドした日より前には戻さない（端末の時計がずれていても、
 * リソース計画の明細がある月より前にしない）。
 */
export function viewerAsOf(meta: Pick<ModelMeta, "asOf" | "asOfFixed">, now: Date = new Date()): ISODate {
  if (meta.asOfFixed) return meta.asOf;
  const today = todayJst(now);
  return today > meta.asOf ? today : meta.asOf;
}

/**
 * 作業実績の取り込みが止まっているか: 最後に取り込んだ日（日本時間）が今日の前日より前（§74）。
 * 毎日の取り込みが朝でも夜でも、1 回抜けたら true になる。取り込んだことが無ければ false（「未取得」と出す）
 */
export function isWorklogStale(meta: Pick<ModelMeta, "asOf" | "worklogFetchedAt">): boolean {
  if (!meta.worklogFetchedAt) return false;
  const at = new Date(meta.worklogFetchedAt);
  if (Number.isNaN(at.getTime())) return false;
  const [y, m, d] = meta.asOf.split("-").map(Number);
  const yesterday = new Date(Date.UTC(y!, m! - 1, d! - 1)).toISOString().slice(0, 10);
  return todayJst(at) < yesterday;
}

/**
 * Model の計算基準日を asOf に置き換えた Model を返す（元の Model は変えない。同じ日なら元のまま）。
 * asOf はビルドした日以降にする（viewerAsOf）。それより前にすると、リソース計画の明細が足りない。
 */
export function rebaseModel<M extends Pick<Model, "meta" | "config" | "contracts" | "holidays" | "teams" | "teamTree" | "rootTeamIds">>(model: M, asOf: ISODate): M {
  if (!isValidISODate(asOf)) throw new RangeError(`asOf が不正な日付です: ${asOf}`);
  if (asOf === model.meta.asOf) return model;
  const config = model.config;
  const asOfMonth = monthOfDate(asOf);
  const holidays = new HolidaySet(model.holidays);
  const statusCtx: StatusContext = { asOf, config, holidays };
  const statusCache = new Map<YearMonth, ContractMonth["status"]>();
  const statusOf = (m: YearMonth): ContractMonth["status"] => {
    let s = statusCache.get(m);
    if (s === undefined) {
      s = monthStatus(m, statusCtx);
      statusCache.set(m, s);
    }
    return s;
  };
  const fiscalYear = fiscalYearOf(asOfMonth, config.fiscalYearStartMonth);
  const fyMonths = fiscalYearMonths(fiscalYear, config.fiscalYearStartMonth);
  const basis = { asOfMonth, fiscalYear, forecastRecentMonths: config.forecastRecentMonths };

  const contracts = model.contracts.map((r) => {
    const months = r.months.map((cm) => {
      const status = statusOf(cm.month);
      return status === cm.status ? cm : { ...cm, status };
    });
    const assignmentPlan = r.assignmentPlan
      ? { ...r.assignmentPlan, lines: r.assignmentPlan.lines.filter((l) => l.month >= asOfMonth) }
      : r.assignmentPlan;
    const forecasts = forecastAllMethodsForMonths(basis, r.contract, months, assignmentPlan, fyMonths);
    return { ...r, months, assignmentPlan, forecasts };
  });

  const priorYearCutoff = addMonths(asOfMonth, -12);
  const hasPriorYearData = contracts.some((r) =>
    r.months.some((m) => m.status === "final" && m.month <= priorYearCutoff && (m.cost > 0 || m.budget > 0)),
  );
  const team = asOfMonth === model.meta.asOfMonth ? null : teamTreeAt({ teams: model.teams }, asOfMonth);

  return {
    ...model,
    meta: {
      ...model.meta,
      asOf,
      asOfMonth,
      lastFinalMonth: lastFinalMonth(statusCtx),
      fiscalYear,
      fiscalYearMonths: fyMonths,
      hasPriorYearData,
    },
    contracts,
    ...(team ? { teamTree: team.tree, rootTeamIds: team.rootTeamIds } : {}),
  };
}
