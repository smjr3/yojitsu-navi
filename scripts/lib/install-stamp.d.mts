export const INSTALL_STAMP: string;
export interface InstallKey {
  lock: string;
  vendor: boolean;
  node: string;
  platform: string;
}
export function installKey(dir: string, nodeVersion?: string, platform?: string): InstallKey;
export function installUpToDate(dir: string, key?: InstallKey): boolean;
export function writeInstallStamp(dir: string, key?: InstallKey): void;
export function clearInstallStamp(dir: string): void;
