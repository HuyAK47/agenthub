import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

interface AgyHomesSnapshot {
  dir: string;
  subdirs: string[];
}

interface HubHomeSnapshot {
  dir: string;
  exists: boolean;
  mtime: number | null;
}

interface WebSnapshot { path: string; checksum: string | null; }

function resolveTargetHomes(): string[] {
  const homes = new Set<string>();
  const curr = os.homedir();
  homes.add(curr);

  // If running inside isolated worker HOME e.g. /home/ducanh/.agy-homes/g2
  const match = curr.match(/(.*?)\/\.agy-homes\/[^/]+$/);
  if (match) {
    homes.add(match[1]);
  }

  return Array.from(homes);
}

function getSubdirectories(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

function getHubStatus(dir: string): { exists: boolean; mtime: number | null } {
  if (!fs.existsSync(dir)) {
    return { exists: false, mtime: null };
  }
  try {
    const stat = fs.statSync(dir);
    return { exists: true, mtime: stat.mtimeMs };
  } catch {
    return { exists: false, mtime: null };
  }
}

function getChecksum(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  try { return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex'); } catch { return null; }
}

let initialAgyHomes: AgyHomesSnapshot[] = [];
let initialHubHomes: HubHomeSnapshot[] = [];
let initialWeb: WebSnapshot;

export function setup() {
  const targetHomes = resolveTargetHomes();

  initialAgyHomes = targetHomes.map((home) => {
    const dir = path.join(home, '.agy-homes');
    return {
      dir,
      subdirs: getSubdirectories(dir),
    };
  });

  initialHubHomes = targetHomes.map((home) => {
    const dir = path.join(home, '.agenthub');
    const status = getHubStatus(dir);
    return {
      dir,
      exists: status.exists,
      mtime: status.mtime,
    };
  });
  const webPath = path.resolve(__dirname, '..', 'dist', 'web', 'index.html');
  initialWeb = { path: webPath, checksum: getChecksum(webPath) };

  return () => {
    // Teardown safety checks
    for (const snap of initialAgyHomes) {
      const currentSubdirs = getSubdirectories(snap.dir);
      const isMatch =
        snap.subdirs.length === currentSubdirs.length &&
        snap.subdirs.every((name, idx) => name === currentSubdirs[idx]);

      if (!isMatch) {
        throw new Error(
          `SAFETY NET VIOLATION: Subdirectories of ${snap.dir} changed during test execution!\n` +
          `Before: [${snap.subdirs.join(', ')}]\n` +
          `After:  [${currentSubdirs.join(', ')}]`,
        );
      }
    }

    for (const snap of initialHubHomes) {
      const currentStatus = getHubStatus(snap.dir);

      if (!snap.exists && currentStatus.exists) {
        throw new Error(
          `SAFETY NET VIOLATION: ${snap.dir} was created during test execution! Tests must use temporary directory.`,
        );
      }

      if (snap.exists && currentStatus.exists && snap.mtime !== currentStatus.mtime) {
        throw new Error(
          `SAFETY NET VIOLATION: ${snap.dir} was modified during test execution! (mtime: ${snap.mtime} vs ${currentStatus.mtime})`,
        );
      }
    }

    const currentChecksum = getChecksum(initialWeb.path);
    if (currentChecksum !== initialWeb.checksum) {
      throw new Error(`SAFETY NET VIOLATION: ${initialWeb.path} checksum changed during test execution!`);
    }
  };
}
