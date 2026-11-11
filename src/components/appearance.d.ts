export const THEME_KEY: string;
export const ACCENT_KEY: string;
export const GITLAB_LOOK_KEY: string;
export const THEME_PREFS: string[];
export const ACCENTS: string[];
export const DEFAULT_ACCENT: string;
export const TEXT_SIZE_KEY: string;
export const TEXT_SIZES: string[];
export const DEFAULT_TEXT_SIZE: string;
export const TEXT_SCALES: Record<string, number>;
export function textScale(doc?: { documentElement?: { dataset?: Record<string, string | undefined> } } | null): number;
export function scaledPx(px: number, doc?: { documentElement?: { dataset?: Record<string, string | undefined> } } | null): number;
export interface GitlabLook {
  mode: "light" | "dark" | "auto" | null;
  accent: string | null;
}
export function lookFromGitlab(u: unknown): GitlabLook;
export interface LookState {
  theme: string | null;
  accent: string | null;
  gitlab: { mode?: string | null; accent?: string | null } | null;
  osDark: boolean;
}
export interface Look {
  theme: "light" | "dark";
  accent: string;
  themeFrom: "app" | "gitlab" | "os";
  accentFrom: "app" | "gitlab" | "default";
}
export function resolveLook(s: LookState): Look;
export function runAppearance(fromGitlab: typeof lookFromGitlab, resolve: typeof resolveLook, cfg: { api: string } | null, w: unknown): void;
export function appearanceConfig(masterEdit: unknown): { api: string };
export function appearanceScript(cfg: { api: string }): string;
export interface AppearanceApi {
  get(): Look & { themePref: string; accentPref: string; textSize: string; auto: Look };
  setTheme(t: string): void;
  setAccent(a: string): void;
  setTextSize(v: string): void;
  setGitlabUser(u: unknown): void;
}
