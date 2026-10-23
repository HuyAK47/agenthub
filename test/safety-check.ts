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
interface ServiceSnapshot { path: string; exists: boolean; mtime: number | null; checksum: string | null; }

function resolveTargetHomes(): string[] {
  const homes = new Set<string>();
  const curr = os.homedir();
  homes.add(curr);

  // If running inside isolated worker HOME e.g. /home/user/.agy-homes/g2
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

function getServiceSnapshot(filePath: string): ServiceSnapshot {
  if (!fs.existsSync(filePath)) return { path: filePath, exists: false, mtime: null, checksum: null };
  try {
    return { path: filePath, exists: true, mtime: fs.statSync(filePath).mtimeMs, checksum: getChecksum(filePath) };
  } catch {
    return { path: filePath, exists: false, mtime: null, checksum: null };
  }
}

let initialAgyHomes: AgyHomesSnapshot[] = [];
let initialHubHomes: HubHomeSnapshot[] = [];
let initialWeb: WebSnapshot;
let initialServices: ServiceSnapshot[] = [];
let initialTempDirNames = new Set<string>();
let testTempRoot: string | undefined;

function getAgentHubTempDirNames(): Set<string> {
  try {
    return new Set(fs.readdirSync(os.tmpdir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('agenthub-'))
      .map((entry) => entry.name));
  } catch {
    return new Set();
  }
}

export function setup({ provide }: { provide: (key: string, value: string) => void }) {
  initialTempDirNames = getAgentHubTempDirNames();
  testTempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-test-run-'));
  provide('agenthubTestTmpRoot', testTempRoot);
  const targetHomes = resolveTargetHomes();
  const realHome = os.userInfo().homedir;
  initialServices = [
    path.join(realHome, '.config', 'systemd', 'user', 'agenthub.service'),
    path.join(realHome, 'Library', 'LaunchAgents', 'dev.agenthub.plist'),
  ].map(getServiceSnapshot);

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
    if (testTempRoot) {
      try { fs.rmSync(testTempRoot, { recursive: true, force: true }); } catch { /* best effort */ }
    }
    const remainingNewTempDirs = [...getAgentHubTempDirNames()]
      .filter((name) => !initialTempDirNames.has(name));
    const leakedTempDirs = remainingNewTempDirs.length;
    if (leakedTempDirs > 5) {
      const prefixes = new Set(remainingNewTempDirs.map((name) => name.replace(/[^-]+$/, '')));
      const message = `TEMP LEAK WARNING: ${leakedTempDirs} agenthub-* directories remain after tests; prefixes: ${[...prefixes].join(', ')}`;
      console.warn(message);
      if (process.env.AGENTHUB_TEST_TMP_FAIL === '1') throw new Error(message);
    }
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

    for (const snap of initialServices) {
      const current = getServiceSnapshot(snap.path);
      if (snap.exists !== current.exists || snap.mtime !== current.mtime || snap.checksum !== current.checksum) {
        throw new Error(
          `SAFETY NET VIOLATION: service file changed during test execution: ${snap.path}\n` +
          `Before: exists=${snap.exists}, mtime=${snap.mtime}, sha256=${snap.checksum}\n` +
          `After:  exists=${current.exists}, mtime=${current.mtime}, sha256=${current.checksum}`,
        );
      }
    }
  };
}
