import type { SyncExecFn } from '../doctor.js';

export interface PlatformProcessInfo {
  pid: number;
  ppid: number;
  parentName: string;
  cwd: string;
  cpu: number;
  rss: number;
  startedAt: number;
}

export interface PlatformProcessApi {
  listProcesses(): PlatformProcessInfo[];
  parentPid(pid: number): number | null;
}

export interface ServiceInstallResult {
  file: string;
  content: string;
  activate: string;
  skipped?: boolean;
  message?: string;
}

export interface ServiceRestartResult {
  restarted: boolean;
  message: string;
}

export interface ServiceUninstallResult {
  uninstalled: boolean;
  file: string;
  message: string;
}

export interface PlatformApi {
  process: PlatformProcessApi;
  freeMemoryBytes(): number;
  lowPriority(executable: string, args: string[]): [string, string[]];
  openBrowser(url: string, openFn?: (file: string, args: string[], callback?: (err: Error | null) => void) => void): void;
  installService(opts: { nodePath: string; cliPath: string; currentPath: string; homeDir: string; print: boolean; exec?: (command: string, options: { stdio: 'inherit' }) => void }): ServiceInstallResult;
  restartService(opts?: { exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceRestartResult;
  uninstallService(opts?: { homeDir?: string; exec?: (command: string, options?: { stdio?: 'inherit' | 'pipe' | 'ignore' }) => void }): ServiceUninstallResult;
  serviceCheck(exec: SyncExecFn, timeoutMs: number): { id: string; name: string; status: 'ok' | 'error' | 'skip' | 'warn'; message: string; suggestion?: string; details?: Record<string, unknown> };
  measureProcessTree?(rootPid: number, worktreePath?: string | null, prev?: { ticks: number; time: number }): {
    rss: number;
    cpu: number;
    totalTicks: number;
    measuredAt: number;
    pids: number[];
    states: Record<number, string>;
  };
}
