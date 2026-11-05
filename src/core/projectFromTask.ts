/**
 * 作業名から案件名を抜き出して案件に紐付ける（SPEC §97）
 *
 * - 作業名に目印（config.projectFromTask.marker）があれば運用保守の作業とし、最初の目印より前を案件名とする。
 *   目印の後ろ（括弧内の表記など）は使わない。目印の照合は全角半角・大文字小文字・空白を区別しない
 * - 抜き出した案件名が contracts.csv の project_name と完全一致（§4.1 の正規化後）する契約へ紐付ける。曖昧一致はしない
 * - 表記揺れは data/project-aliases.csv（alias → project_name）で明示的に登録したものだけを使う
 */
import { normalizeKeyword, normalizeName } from "./normalize.js";
import type { Contract, Dataset, ProjectAlias, ProjectFromTaskConfig } from "./types.js";
import { T, fmt } from "../i18n/index.js";

/** 有効か（目印が空でなく enabled が false でない） */
export function projectFromTaskEnabled(cfg: ProjectFromTaskConfig | undefined): cfg is ProjectFromTaskConfig {
  return !!cfg && cfg.enabled !== false && typeof cfg.marker === "string" && normalizeKeyword(cfg.marker) !== "";
}

/**
 * 作業名の最初の目印より前（NFKC・前後の空白を除いたもの）。目印が無ければ null。
 * 目印は normalizeKeyword（NFKC・小文字・空白を除く）で照合する
 */
export function extractProjectName(task: string, marker: string): string | null {
  const key = normalizeKeyword(marker);
  if (key === "") return null;
  const text = (task ?? "").normalize("NFKC");
  // 空白を除いた小文字の文字列と、その各文字の元の位置
  let compact = "";
  const pos: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (/\s/u.test(ch)) continue;
    const lower = ch.toLowerCase();
    for (let j = 0; j < lower.length; j++) pos.push(i);
    compact += lower;
  }
  const at = compact.indexOf(key);
  if (at < 0) return null;
  return text.slice(0, pos[at]).trim();
}

export interface ProjectMatcher {
  readonly enabled: boolean;
  /** 作業名から抜き出した案件名（目印が無い・無効なら null） */
  extract(task: string): string | null;
  /** 抜き出した案件名 → 案件名（または別名の指す案件名）が一致する契約ID（ファイルの順）。一致が無ければ null */
  contractIdsFor(projectName: string): readonly string[] | null;
}

const DISABLED: ProjectMatcher = { enabled: false, extract: () => null, contractIdsFor: () => null };

/** 抜き出しと照合の準備。contracts は不備で除外中の契約も含めて渡す（除外中なら理由を出すため） */
export function createProjectMatcher(cfg: ProjectFromTaskConfig | undefined, contracts: readonly Contract[], aliases: readonly ProjectAlias[] = []): ProjectMatcher {
  if (!projectFromTaskEnabled(cfg)) return DISABLED;
  const marker = cfg.marker;
  const byName = new Map<string, string[]>();
  // 同じ契約IDの 2 行目以降は計算から外れる（§2）ので、別の案件名を持ち込ませない
  const seenIds = new Set<string>();
  for (const c of contracts) {
    if (seenIds.has(c.contractId)) continue;
    seenIds.add(c.contractId);
    const key = normalizeName(c.projectName);
    if (key === "") continue;
    const list = byName.get(key);
    if (list) {
      if (!list.includes(c.contractId)) list.push(c.contractId);
    } else byName.set(key, [c.contractId]);
  }
  // 別名: 案件名と同じ名前の別名・複数の案件名を指す別名は使わない（検証で知らせる）
  const aliasTargets = new Map<string, Set<string>>();
  for (const a of aliases) {
    const k = normalizeName(a.alias);
    const t = normalizeName(a.projectName);
    if (k === "" || t === "" || byName.has(k)) continue;
    const set = aliasTargets.get(k);
    if (set) set.add(t);
    else aliasTargets.set(k, new Set([t]));
  }
  const extractCache = new Map<string, string | null>();
  return {
    enabled: true,
    extract(task) {
      let v = extractCache.get(task);
      if (v === undefined) {
        v = extractProjectName(task, marker);
        extractCache.set(task, v);
      }
      return v;
    },
    contractIdsFor(projectName) {
      const k = normalizeName(projectName);
      if (k === "") return null;
      const direct = byName.get(k);
      if (direct) return direct;
      const targets = aliasTargets.get(k);
      if (!targets || targets.size !== 1) return null;
      return byName.get([...targets][0] as string) ?? null;
    },
  };
}

/** Dataset の設定・契約（除外中も含む）・別名から作る */
export function projectMatcherFor(dataset: Pick<Dataset, "config" | "contracts" | "projectAliases">): ProjectMatcher {
  return createProjectMatcher(dataset.config.projectFromTask, dataset.contracts, dataset.projectAliases ?? []);
}

/** 作業名の案件名（§97）で契約が見つかる作業か */
export function resolvesByTask(projects: ProjectMatcher | undefined, task: string): boolean {
  if (!projects?.enabled) return false;
  const name = projects.extract(task);
  return name !== null && projects.contractIdsFor(name) !== null;
}

export interface AliasIssue {
  severity: "error" | "warning";
  code: "ALIAS_EMPTY" | "ALIAS_DUPLICATE" | "ALIAS_UNKNOWN_PROJECT" | "ALIAS_SHADOWED";
  /** CSV の行番号（ヘッダ = 1）。重複は最後の行 */
  row: number;
  message: string;
  ref: Record<string, string | number>;
}

/** project-aliases.csv の検証（§97） */
export function validateProjectAliases(aliases: readonly ProjectAlias[], contracts: readonly Contract[]): AliasIssue[] {
  const file = "project-aliases.csv";
  const names = new Set(contracts.map((c) => normalizeName(c.projectName)).filter((k) => k !== ""));
  const issues: AliasIssue[] = [];
  const groups = new Map<string, { alias: string; targets: Map<string, string>; rows: number[] }>();
  aliases.forEach((a, i) => {
    const row = i + 2;
    const k = normalizeName(a.alias);
    const t = normalizeName(a.projectName);
    if (k === "" || t === "") {
      issues.push({ severity: "error", code: "ALIAS_EMPTY", row, message: fmt(T.checks.aliasEmpty, { file, row }), ref: {} });
      return;
    }
    if (names.has(k)) {
      issues.push({ severity: "warning", code: "ALIAS_SHADOWED", row, message: fmt(T.checks.aliasShadowed, { file, row, alias: a.alias }), ref: { alias: a.alias } });
      return;
    }
    if (!names.has(t)) {
      issues.push({ severity: "warning", code: "ALIAS_UNKNOWN_PROJECT", row, message: fmt(T.checks.aliasUnknownProject, { file, row, alias: a.alias, project: a.projectName }), ref: { alias: a.alias, projectName: a.projectName } });
    }
    const g = groups.get(k);
    if (g) {
      if (!g.targets.has(t)) g.targets.set(t, a.projectName.trim());
      g.rows.push(row);
    } else groups.set(k, { alias: a.alias.trim(), targets: new Map([[t, a.projectName.trim()]]), rows: [row] });
  });
  for (const g of groups.values()) {
    if (g.targets.size < 2) continue;
    const row = g.rows[g.rows.length - 1] as number;
    issues.push({ severity: "error", code: "ALIAS_DUPLICATE", row, message: fmt(T.checks.aliasDuplicate, { file, alias: g.alias, targets: [...g.targets.values()].join("、"), rows: g.rows.join(", ") }), ref: { alias: g.alias } });
  }
  return issues.sort((a, b) => a.row - b.row);
}
