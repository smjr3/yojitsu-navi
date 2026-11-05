export interface ConfigIssue {
  level: "error" | "warning";
  code: string;
  path: string;
  message: string;
}
export const CONFIG_SCHEMA: unknown;
export function checkConfig(config: unknown, schema?: unknown): ConfigIssue[];
export function formatConfigIssues(issues: ConfigIssue[]): string[];
export function parseConfigText(text: string): { config?: unknown; error?: string };
