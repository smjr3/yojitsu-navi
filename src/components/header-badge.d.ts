export interface BadgeConfig {
  enabled: boolean;
  demo: boolean;
  api: string;
  projectId: string;
  targetBranch: string;
  label: string;
}
export function badgeConfig(masterEdit: unknown, label: string): BadgeConfig;
export function runMrBadge(cfg: BadgeConfig, w: unknown): void;
export function mrBadgeScript(cfg: BadgeConfig): string;
