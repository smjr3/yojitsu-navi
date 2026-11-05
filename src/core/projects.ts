/**
 * 正式な案件の一覧（案件管理システム。data/projects.csv）と契約（contracts.csv）の照合（SPEC §98）
 *
 * - 契約の project_id が正式な案件 ID。顧客名・案件名は一覧の値が正（取り込み `npm run fetch:projects` が contracts.csv に書き戻す）
 * - 期間・金額・担当チームは contracts.csv の手入力が正（一覧からは取らない）
 * - project_id の無い契約は「未照合」として保留する（推測で ID を入れない）。同じ案件名の案件は候補として出すだけ
 * - 一覧にあって契約の無い案件は「契約の無い案件」として出す（新しい案件の見落としを防ぐ）
 *
 * 一覧が無い・空のときは照合しない（取り込みを使わない導入先ではこれまでどおり）。
 */
import { normalizeName } from "./normalize.js";
import type { Contract, Dataset, Project } from "./types.js";
import { T, fmt } from "../i18n/index.js";
import type { ValidationIssue } from "./validate.js";

export interface UnlinkedContract {
  contractId: string;
  customerName: string;
  projectName: string;
  startMonth: string;
  endMonth: string;
  /** 案件名（§4.1 の正規化）が同じ正式な案件の ID。候補として出すだけ（自動では入れない） */
  candidates: string[];
}

export interface UnknownProjectContract {
  contractId: string;
  projectId: string;
  customerName: string;
  projectName: string;
}

export interface NameMismatch {
  contractId: string;
  projectId: string;
  field: "customer_name" | "project_name";
  current: string;
  official: string;
}

export interface ProjectCheck {
  /** 正式な案件の一覧がある（照合する）か */
  enabled: boolean;
  /** 一覧の件数 */
  projects: number;
  /** project_id のある契約の数 */
  linked: number;
  unlinked: UnlinkedContract[];
  /** project_id が一覧に無い契約 */
  unknown: UnknownProjectContract[];
  /** 顧客名・案件名が一覧と違う契約（取り込みで直る） */
  mismatched: NameMismatch[];
  /** 一覧にあって、どの契約の project_id にも無い案件 */
  unregistered: Project[];
}

const byId = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** 案件名で正式な案件を引く索引（正規化した案件名 → ID） */
export function projectNameIndex(projects: readonly Project[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const p of projects) {
    const k = normalizeName(p.projectName);
    if (k === "") continue;
    const list = out.get(k) ?? [];
    if (!list.includes(p.projectId)) list.push(p.projectId);
    out.set(k, list);
  }
  return out;
}

/** 照合の結果（データ確認画面の一覧に使う） */
export function checkProjects(contracts: readonly Contract[], projects: readonly Project[] | undefined): ProjectCheck {
  const list = projects ?? [];
  const empty: ProjectCheck = { enabled: false, projects: 0, linked: 0, unlinked: [], unknown: [], mismatched: [], unregistered: [] };
  if (list.length === 0) return empty;
  const official = new Map<string, Project>();
  for (const p of list) if (p.projectId !== "" && !official.has(p.projectId)) official.set(p.projectId, p);
  const names = projectNameIndex(list);
  const used = new Set<string>();
  const out: ProjectCheck = { ...empty, enabled: true, projects: official.size };
  for (const c of contracts) {
    if (c.projectId === undefined || c.projectId === "") {
      const candidates = [...(names.get(normalizeName(c.projectName)) ?? [])].sort(byId);
      out.unlinked.push({ contractId: c.contractId, customerName: c.customerName, projectName: c.projectName, startMonth: c.startMonth, endMonth: c.endMonth, candidates });
      continue;
    }
    out.linked++;
    used.add(c.projectId);
    const p = official.get(c.projectId);
    if (!p) {
      out.unknown.push({ contractId: c.contractId, projectId: c.projectId, customerName: c.customerName, projectName: c.projectName });
      continue;
    }
    if (c.customerName !== p.customerName) out.mismatched.push({ contractId: c.contractId, projectId: c.projectId, field: "customer_name", current: c.customerName, official: p.customerName });
    if (c.projectName !== p.projectName) out.mismatched.push({ contractId: c.contractId, projectId: c.projectId, field: "project_name", current: c.projectName, official: p.projectName });
  }
  out.unregistered = [...official.values()].filter((p) => !used.has(p.projectId)).sort((a, b) => byId(a.projectId, b.projectId));
  return out;
}

/** 検証（§14 に追加。§98）: 一覧の ID の空・重複は error、契約の ID が一覧に無い・名前の違いは warning */
export function validateProjects(dataset: Pick<Dataset, "contracts" | "projects">): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const projects = dataset.projects ?? [];
  if (projects.length === 0) return issues;
  const file = "projects.csv";
  const seen = new Map<string, number>();
  projects.forEach((p, i) => {
    const row = i + 2;
    if (p.projectId === "") {
      issues.push({ severity: "error", code: "PROJECT_ID_EMPTY", message: fmt(T.checks.projectIdEmpty, { file, row }), file, row });
      return;
    }
    const prev = seen.get(p.projectId);
    if (prev !== undefined) issues.push({ severity: "error", code: "DUPLICATE_PROJECT_ID", message: fmt(T.checks.duplicateProjectId, { file, row, projectId: p.projectId, prev }), file, row, ref: { projectId: p.projectId } });
    else seen.set(p.projectId, row);
  });
  const check = checkProjects(dataset.contracts, projects);
  const rowOf = new Map<string, number>();
  dataset.contracts.forEach((c, i) => {
    if (!rowOf.has(c.contractId)) rowOf.set(c.contractId, i + 2);
  });
  for (const u of check.unknown) {
    const row = rowOf.get(u.contractId);
    issues.push({ severity: "warning", code: "PROJECT_ID_UNKNOWN", message: fmt(T.checks.projectIdUnknown, { file: "contracts.csv", row: row ?? "", contractId: u.contractId, projectId: u.projectId }), file: "contracts.csv", ...(row !== undefined ? { row } : {}), ref: { contractId: u.contractId, projectId: u.projectId } });
  }
  for (const m of check.mismatched) {
    const row = rowOf.get(m.contractId);
    issues.push({
      severity: "warning",
      code: "PROJECT_NAME_MISMATCH",
      message: fmt(T.checks.projectNameMismatch, { file: "contracts.csv", row: row ?? "", contractId: m.contractId, column: m.field, current: m.current, official: m.official }),
      file: "contracts.csv",
      ...(row !== undefined ? { row } : {}),
      ref: { contractId: m.contractId, projectId: m.projectId, column: m.field },
    });
  }
  return issues;
}
