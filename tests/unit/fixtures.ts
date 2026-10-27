/**
 * テスト用のデータ組み立てヘルパー
 */
import type { Assignment, Config, Contract, Dataset, MappingRule, MemberRecord, RateRecord, TeamRecord, Worklog } from "../../src/core/types.js";

export const baseConfig: Config = {
  fiscalYearStartMonth: 4,
  standardHoursPerMonth: 160,
  hoursPerBusinessDay: 8,
  burnRateDangerThreshold: 1.0,
  closingBusinessDay: 3,
  forecastMethodDefault: "recent3",
  forecastRecentMonths: 3,
  currency: { code: "JPY", defaultUnit: "yen" },
  labels: { customer: "顧客", project: "案件", contract: "契約", team: "チーム", member: "メンバー" },
  worklogSource: {
    adapter: "csv",
    csv: { path: "data/worklogs" },
    http: {
      url: "",
      authHeader: "Authorization",
      refetchMonths: 3,
      columns: {
        date: "date",
        memberId: "member_id",
        memberName: "member_name",
        customerName: "customer_name",
        projectName: "project_name",
        task: "task",
        hours: "hours",
      },
    },
  },
  costTypes: [{ id: "labor", label: "工数原価" }],
};

export function contract(overrides: Partial<Contract> & { contractId: string }): Contract {
  return {
    customerName: "ABC株式会社",
    projectName: "保守",
    teamId: null,
    startMonth: "2026-04",
    endMonth: "2027-03",
    totalAmount: 2_400_000,
    ...overrides,
  };
}

export function rule(customer: string, project: string, contractId: string): MappingRule {
  return { worklogCustomerName: customer, worklogProjectName: project, contractId };
}

export function member(overrides: Partial<MemberRecord> & { memberId: string }): MemberRecord {
  return {
    name: overrides.memberId,
    kind: "employee",
    title: "SE",
    department: "開発部",
    section: "1課",
    teamId: null,
    effectiveFrom: "2000-01",
    ...overrides,
  };
}

export function rate(key: string, hourlyRate: number, effectiveFrom = "2000-01"): RateRecord {
  return { key, hourlyRate, effectiveFrom };
}

export function team(teamId: string, parentTeamId: string | null, effectiveFrom = "2000-01", name = teamId): TeamRecord {
  return { teamId, name, parentTeamId, effectiveFrom };
}

export function worklog(overrides: Partial<Worklog> & { date: string; memberId: string; hours: number }): Worklog {
  return {
    memberName: overrides.memberId,
    customerName: "ABC株式会社",
    projectName: "保守",
    task: "作業",
    ...overrides,
  };
}

export function assignment(overrides: Partial<Assignment> & { memberId: string; contractId: string }): Assignment {
  return { startMonth: "2026-04", endMonth: "2027-03", allocation: 0.5, ...overrides };
}

export function dataset(overrides: Partial<Dataset> = {}): Dataset {
  return {
    config: baseConfig,
    contracts: [],
    mappings: [],
    assignments: [],
    teams: [],
    members: [],
    rates: [],
    holidays: [],
    worklogs: [],
    ...overrides,
  };
}
