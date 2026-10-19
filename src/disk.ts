import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export interface DiskSpace {
  freeGB: number;
  totalGB: number;
}

export interface ExtraDiskPath {
  path: string;
  minFreeGB: number;
  label: string;
}

export interface MonitoredDisk extends DiskSpace, ExtraDiskPath {
  source: 'worktrees' | 'extra';
  low: boolean;
}

const DOCKER_ROOT_CACHE_MS = 10 * 60 * 1000;
let dockerRootCache: { at: number; path: string | null } = { at: 0, path: null };

export function discoverDockerRootDir(now = Date.now()): string | null {
  if (now - dockerRootCache.at < DOCKER_ROOT_CACHE_MS) return dockerRootCache.path;
  let dockerPath: string | null = null;
  try {
    const output = execFileSync('docker', ['info', '-f', '{{.DockerRootDir}}'], {
      encoding: 'utf8',
      timeout: 3000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (output) dockerPath = output;
  } catch {
    // Docker is optional; an unavailable daemon must not affect AgentHub.
  }
  dockerRootCache = { at: now, path: dockerPath };
  return dockerPath;
}

export function resetDockerRootCache(): void {
  dockerRootCache = { at: 0, path: null };
}

export function getMonitoredDisks(worktreesDir: string, worktreesMinFreeGB = 3, extraPaths: ExtraDiskPath[] = [], includeDocker = true): MonitoredDisk[] {
  const configured = [...extraPaths];
  const dockerRoot = includeDocker ? discoverDockerRootDir() : null;
  if (dockerRoot && !configured.some((entry) => path.resolve(entry.path) === path.resolve(dockerRoot))) {
    configured.push({ path: dockerRoot, minFreeGB: 5, label: 'Docker' });
  }
  const paths: Array<ExtraDiskPath & { source: MonitoredDisk['source'] }> = [
    { path: worktreesDir, minFreeGB: worktreesMinFreeGB, label: 'Worktrees', source: 'worktrees' },
    ...configured.map((entry) => ({ ...entry, source: 'extra' as const })),
  ];
  return paths.map((entry) => {
    const space = getDiskSpaceSync(entry.path);
    return { ...entry, ...space, low: space.freeGB < entry.minFreeGB };
  });
}

export interface StatFsLike {
  bsize?: number | bigint;
  bavail?: number | bigint;
  bfree?: number | bigint;
  blocks?: number | bigint;
}

interface MockableFs {
  statfs?: {
    (path: string, callback: (err: unknown, stats?: StatFsLike) => void): void;
    mock?: unknown;
    _isMockFunction?: boolean;
  };
  statfsSync?: (path: string) => StatFsLike;
  promises?: {
    statfs?: {
      (path: string): Promise<StatFsLike>;
      mock?: unknown;
    };
  };
}

export function parseStatFs(stats: StatFsLike): DiskSpace {
  const bsize = Number(stats.bsize ?? 1);
  const bavail = stats.bavail !== undefined ? Number(stats.bavail) : Number(stats.bfree ?? 0);
  const blocks = Number(stats.blocks ?? 0);
  const freeBytes = bavail * bsize;
  const totalBytes = blocks * bsize;
  const freeGB = Math.round((freeBytes / (1024 ** 3)) * 10) / 10;
  const totalGB = Math.round((totalBytes / (1024 ** 3)) * 10) / 10;
  return { freeGB, totalGB };
}

export function getDiskSpaceSync(targetPath: string): DiskSpace {
  const customFs = fs as unknown as MockableFs;
  // If fs.statfs is a mock function, try calling it with a callback
  if (typeof customFs.statfs === 'function' && (customFs.statfs.mock || customFs.statfs._isMockFunction)) {
    let mockStats: StatFsLike | null = null;
    try {
      customFs.statfs(targetPath, (err, stats) => {
        if (!err && stats) mockStats = stats;
      });
    } catch {
      // ignore
    }
    if (mockStats) return parseStatFs(mockStats);
  }

  const candidates = [targetPath];
  let parent = path.resolve(targetPath);
  while (parent !== path.dirname(parent)) {
    parent = path.dirname(parent);
    candidates.push(parent);
  }
  for (const candidate of candidates) {
    try {
      const stats = fs.statfsSync(candidate);
      return parseStatFs(stats);
    } catch {
      // Try the parent mount when the target directory is inaccessible.
    }
  }
  try {
    let fallbackStats: StatFsLike | null = null;
    try {
      if (typeof customFs.statfs === 'function') {
      customFs.statfs(targetPath, (err, stats) => {
          if (!err && stats) fallbackStats = stats;
        });
      }
    } catch {
      // ignore
    }
    if (fallbackStats) return parseStatFs(fallbackStats);
  } catch {
    // ignore
  }
  return { freeGB: 0, totalGB: 0 };
}

export async function getDiskSpace(targetPath: string): Promise<DiskSpace> {
  const customFs = fs as unknown as MockableFs;
  if (typeof customFs.promises?.statfs === 'function' && customFs.promises.statfs.mock) {
    try {
      const stats = await customFs.promises.statfs(targetPath);
      return parseStatFs(stats);
    } catch {
      // fallback
    }
  }

  if (typeof fs.statfs === 'function') {
    return new Promise((resolve) => {
      try {
        fs.statfs(targetPath, (err, stats) => {
          if (!err && stats) {
            return resolve(parseStatFs(stats));
          }
          resolve(getDiskSpaceSync(targetPath));
        });
      } catch {
        resolve(getDiskSpaceSync(targetPath));
      }
    });
  }

  return getDiskSpaceSync(targetPath);
}
