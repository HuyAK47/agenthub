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
}

const DELETED_SUFFIX = ' (deleted)';

function defaultWorktreesDir(): string {
  return path.join(os.homedir(), '.agenthub', 'worktrees');
}

function cleanCwd(cwd: string): string {
  return cwd.endsWith(DELETED_SUFFIX) ? cwd.slice(0, -DELETED_SUFFIX.length) : cwd;
}

function isInside(target: string, dir: string): boolean {
  const resolvedTarget = path.resolve(cleanCwd(target));
  const resolvedDir = path.resolve(cleanCwd(dir));
  return resolvedTarget === resolvedDir || resolvedTarget.startsWith(resolvedDir + path.sep);
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
    let cpu = 0;
    try {
      const uptime = Number(fs.readFileSync('/proc/uptime', 'utf8').split(/\s+/)[0]);
      const hz = 100;
      cpu = uptime > 0 ? (ticks / hz / uptime) * 100 : 0;
    } catch {
      // proc/uptime may be unavailable outside Linux.
    }
    return { pid, cwd, cpu, rss: Number(rssMatch?.[1] || 0) * 1024 };
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

function reapSync(dir: string, options: ReaperOptions): number[] {
  const pids = findProcessesInDir(dir, options);
  for (const pid of pids) {
    try { process.kill(pid, 'SIGTERM'); } catch { /* process exited */ }
  }
  const deadline = Date.now() + (options.graceMs ?? 5000);
  while (Date.now() < deadline && pids.some(alive)) {
    // This is intentionally synchronous because WorktreeService.remove is synchronous.
    const until = Math.min(deadline, Date.now() + 50);
    while (Date.now() < until) { /* wait */ }
  }
  for (const pid of pids) {
    if (alive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* process exited */ }
    }
  }
  if (pids.length > 0) console.log(`[reaper] cleaned ${pids.join(', ')} in ${dir}`);
  return pids;
}

export async function reap(dir: string, options: ReaperOptions = {}): Promise<number[]> {
  return reapSync(dir, options);
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
