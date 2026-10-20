import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeletableWorktreePath } from './worktrees/index.js';
import { getPlatform } from './platform/index.js';

export interface ReaperOptions {
  worktreesDir?: string;
  protectedPaths?: Array<string | null | undefined>;
  graceMs?: number;
}

export interface ProcessInfo {
  pid: number;
  ppid: number;
  parentName: string;
  cwd: string;
  cpu: number;
  rss: number;
  startedAt: number;
}

export function isOrphanProcess(info: Pick<ProcessInfo, 'ppid' | 'parentName'>): boolean {
  return info.ppid === 1 || /^(init|systemd)$/i.test(info.parentName);
}

const DELETED_SUFFIX = ' (deleted)';

function defaultWorktreesDir(): string {
  return path.join(os.homedir(), '.agenthub', 'worktrees');
}

export function cleanCwd(cwd: string): string {
  return cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd;
}

export function isInside(target: string, dir: string): boolean {
  const resolvedTarget = resolveReal(cleanCwd(target));
  const resolvedDir = resolveReal(cleanCwd(dir));
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
}

function resolveReal(target: string): string {
  const resolved = path.resolve(target);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

export function processAncestors(): Set<number> {
  const ancestors = new Set<number>([process.pid]);
  let pid = process.pid;
  for (;;) {
    const parent = getPlatform().process.parentPid(pid);
    if (!parent || ancestors.has(parent)) break;
    ancestors.add(parent);
    pid = parent;
  }
  return ancestors;
}

export function processIds(): number[] {
  try {
    return fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return [];
  }
}
function guard(dir: string, options: ReaperOptions): boolean {
  return isDeletableWorktreePath(
    options.worktreesDir || defaultWorktreesDir(),
    dir,
    options.protectedPaths || [],
  );
}

export function listProcessesInDir(dir: string, options: ReaperOptions = {}): ProcessInfo[] {
  if (!guard(dir, options)) return [];
  const excluded = processAncestors();
  const result: ProcessInfo[] = [];
  for (const info of getPlatform().process.listProcesses()) {
    if (excluded.has(info.pid)) continue;
    if (info && isInside(info.cwd, dir)) result.push(info);
  }
  return result;
}

export function findProcessesInDir(dir: string, options: ReaperOptions = {}): number[] {
  return listProcessesInDir(dir, options).map((info) => info.pid);
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killAfterGrace(pids: number[], graceMs: number): void {
  const timer = setTimeout(() => {
    for (const pid of pids) {
      if (alive(pid)) {
        try { process.kill(pid, 'SIGKILL'); } catch { /* process exited */ }
      }
    }
  }, graceMs);
  timer.unref();
}

function logReap(pids: number[], dir: string): void {
  if (pids.length > 0) console.log(`[reaper] cleaned ${pids.join(', ')} in ${dir}`);
}

function reapSync(dir: string, options: ReaperOptions): number[] {
  const pids = findProcessesInDir(dir, options);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* process exited */ }
  }
  killAfterGrace(pids, options.graceMs ?? 5000);
  logReap(pids, dir);
  return pids;
}

export async function reap(dir: string, options: ReaperOptions = {}): Promise<number[]> {
  const pids = findProcessesInDir(dir, options);
  if (pids.length === 0) return pids;
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* process exited */ }
  }
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, options.graceMs ?? 5000);
    timer.unref();
  });
  for (const pid of pids) {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process exited */ }
    }
  }
  logReap(pids, dir);
  return pids;
}

export function reapSyncForWorktree(dir: string, options: ReaperOptions = {}): number[] {
  return reapSync(dir, options);
}

export function listAllWorktreeProcesses(options: ReaperOptions = {}): ProcessInfo[] {
  const worktreesDir = options.worktreesDir || defaultWorktreesDir();
  if (!fs.existsSync(worktreesDir)) return [];
  const excluded = processAncestors();
  const result: ProcessInfo[] = [];
  for (const info of getPlatform().process.listProcesses()) {
    if (excluded.has(info.pid)) continue;
    if (info && isInside(info.cwd, worktreesDir) && isDeletableWorktreePath(worktreesDir, cleanCwd(info.cwd), options.protectedPaths || [])) {
      result.push(info);
    }
  }
  return result;
}
