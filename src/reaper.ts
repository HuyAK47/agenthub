import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeletableWorktreePath } from './worktrees/index.js';

export interface ReaperOptions {
  worktreesDir?: string;
  protectedPaths?: Array<string | null | undefined>;
  graceMs?: number;
}

export interface ProcessInfo {
  pid: number;
  cwd: string;
  cpu: number;
  rss: number;
  startedAt: number;
}

const DELETED_SUFFIX = ' (deleted)';

function defaultWorktreesDir(): string {
  return path.join(os.homedir(), '.agenthub', 'worktrees');
}

function cleanCwd(cwd: string): string {
  return cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd;
}

function isInside(target: string, dir: string): boolean {
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

function bootTimeMs(): number {
  try {
    const seconds = fs.readFileSync('/proc/stat', 'utf8').match(/^btime\s+(\d+)$/m)?.[1];
    return Number(seconds || 0) * 1000;
  } catch {
    return 0;
  }
}

function processAncestors(): Set<number> {
  const ancestors = new Set<number>([process.pid]);
  let pid = process.pid;
  for (;;) {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const parent = Number(afterComm[1]);
      if (!parent || ancestors.has(parent)) break;
      ancestors.add(parent);
      pid = parent;
    } catch {
      break;
    }
  }
  return ancestors;
}

function processIds(): number[] {
  try {
    return fs.readdirSync('/proc').filter((entry) => /^\d+$/.test(entry)).map(Number);
  } catch {
    return [];
  }
}

function readProcessInfo(pid: number): ProcessInfo | null {
  try {
    const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
    const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
    const rssMatch = status.match(/^VmRSS:\s+(\d+)\s+kB$/m);
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
    const ticks = Number(afterComm[11] || 0) + Number(afterComm[12] || 0);
    const startTicks = Number(afterComm[19] || 0);
    let cpu = 0;
    try {
      const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
      const hz = 100;
      cpu = uptime > 0 ? (ticks / hz / uptime) * 100 : 0;
    } catch {
      // proc/uptime may be unavailable outside Linux.
    }
    const startedAt = bootTimeMs() + startTicks * 10;
    return { pid, cwd, cpu, rss: Number(rssMatch?.[1] || 0) * 1024, startedAt };
  } catch {
    return null;
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
  for (const pid of processIds()) {
    if (excluded.has(pid)) continue;
    const info = readProcessInfo(pid);
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
  for (const pid of processIds()) {
    if (excluded.has(pid)) continue;
    const info = readProcessInfo(pid);
    if (info && isInside(info.cwd, worktreesDir) && isDeletableWorktreePath(worktreesDir, cleanCwd(info.cwd), options.protectedPaths || [])) {
      result.push(info);
    }
  }
  return result;
}
