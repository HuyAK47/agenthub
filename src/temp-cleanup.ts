import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENTHUB_TMP_PREFIX = 'agenthub-';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const CLEANUP_BATCH_SIZE = 32;
const SCAN_TIMEOUT_MS = 100;
const warnedSkippedRoots = new Set<string>();

export interface AgentHubTempDirectoryInfo {
  path: string;
  ageMs: number;
  sizeBytes: number;
  containsGit: boolean;
  owned: boolean;
}

function isOwnedByCurrentUser(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined || stat.uid === uid;
}

async function listAgentHubDirectories(tmpDir: string): Promise<string[]> {
  try {
    return (await fs.promises.readdir(tmpDir, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(AGENTHUB_TMP_PREFIX))
      .map((entry) => path.join(tmpDir, entry.name));
  } catch {
    return [];
  }
}

async function containsGitDirectory(root: string): Promise<boolean> {
  const pending = [root];
  const deadline = Date.now() + SCAN_TIMEOUT_MS;
  while (pending.length > 0) {
    if (Date.now() >= deadline) return true;
    const current = pending.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(current, { withFileTypes: true });
    } catch {
      return true;
    }
    for (const entry of entries) {
      if (entry.name === '.git') return true;
      if (entry.isDirectory() && entry.name !== 'node_modules') pending.push(path.join(current, entry.name));
    }
  }
  return false;
}

async function directorySize(root: string): Promise<number> {
  let total = 0;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop()!;
    try {
      for (const entry of await fs.promises.readdir(current, { withFileTypes: true })) {
        const child = path.join(current, entry.name);
        if (entry.isDirectory()) pending.push(child);
        else if (entry.isFile()) {
          try { total += (await fs.promises.stat(child)).size; } catch { /* best effort */ }
        }
      }
    } catch { /* best effort */ }
  }
  return total;
}

export async function inspectAgentHubTempDirs(
  tmpDir = os.tmpdir(),
  now = Date.now(),
): Promise<AgentHubTempDirectoryInfo[]> {
  const result: AgentHubTempDirectoryInfo[] = [];
  for (const dir of await listAgentHubDirectories(tmpDir)) {
    try {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory()) continue;
      result.push({
        path: dir,
        ageMs: Math.max(0, now - stat.mtimeMs),
        sizeBytes: await directorySize(dir),
        containsGit: await containsGitDirectory(dir),
        owned: isOwnedByCurrentUser(stat),
      });
    } catch { /* best effort */ }
  }
  return result;
}

export async function countAgentHubTempDirectories(tmpDir = os.tmpdir()): Promise<number> {
  return (await listAgentHubDirectories(tmpDir)).length;
}

export async function cleanupStaleAgentHubTempDirs(options: {
  tmpDir?: string;
  olderThanMs?: number;
  now?: number;
} = {}): Promise<string[]> {
  const tmpDir = options.tmpDir || os.tmpdir();
  const olderThanMs = options.olderThanMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];

  const skipped: string[] = [];
  const directories = await listAgentHubDirectories(tmpDir);
  for (let index = 0; index < directories.length; index += 1) {
    const dir = directories[index];
    try {
      const stat = await fs.promises.lstat(dir);
      if (!stat.isDirectory() || !isOwnedByCurrentUser(stat) || now - stat.mtimeMs < olderThanMs) continue;
      if (await containsGitDirectory(dir)) {
        skipped.push(dir);
        continue;
      }
      await fs.promises.rm(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Best effort: another process may be using or removing this directory.
    }
    if ((index + 1) % CLEANUP_BATCH_SIZE === 0) await new Promise<void>((resolve) => setImmediate(resolve));
  }
  if (skipped.length > 0) {
    const key = path.resolve(tmpDir);
    if (!warnedSkippedRoots.has(key)) {
      warnedSkippedRoots.add(key);
      console.warn(`[temp-cleanup] Bỏ qua ${skipped.length} thư mục chứa repo git trong ${tmpDir}`);
    }
  }
  return removed;
}

export function cleanupTaskRunArtifacts(logPaths: Array<string | null | undefined>): string[] {
  const removed: string[] = [];
  for (const logPath of logPaths) {
    if (!logPath) continue;
    const finalPath = logPath.endsWith('.log')
      ? `${logPath.slice(0, -'.log'.length)}.final.json`
      : `${logPath}.final.json`;
    try {
      if (fs.existsSync(finalPath)) {
        fs.rmSync(finalPath, { force: true });
        removed.push(finalPath);
      }
    } catch {
      // A completed run must remain readable even if its disposable output cannot be removed.
    }
  }
  return removed;
}

export const AGENTHUB_TEMP_MAX_AGE_MS = DEFAULT_MAX_AGE_MS;
