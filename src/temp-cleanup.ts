import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const AGENTHUB_TMP_PREFIX = 'agenthub-';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function isOwnedByCurrentUser(stat: fs.Stats): boolean {
  const uid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  return uid === undefined || stat.uid === uid;
}

function listAgentHubDirectories(tmpDir: string): string[] {
  try {
    return fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith(AGENTHUB_TMP_PREFIX))
      .map((entry) => path.join(tmpDir, entry.name));
  } catch {
    return [];
  }
}

export function countAgentHubTempDirectories(tmpDir = os.tmpdir()): number {
  return listAgentHubDirectories(tmpDir).length;
}

export function cleanupStaleAgentHubTempDirs(options: {
  tmpDir?: string;
  olderThanMs?: number;
  now?: number;
} = {}): string[] {
  const tmpDir = options.tmpDir || os.tmpdir();
  const olderThanMs = options.olderThanMs ?? DEFAULT_MAX_AGE_MS;
  const now = options.now ?? Date.now();
  const removed: string[] = [];

  for (const dir of listAgentHubDirectories(tmpDir)) {
    try {
      const stat = fs.lstatSync(dir);
      if (!stat.isDirectory() || !isOwnedByCurrentUser(stat) || now - stat.mtimeMs < olderThanMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch {
      // Best effort: another process may be using or removing this directory.
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
