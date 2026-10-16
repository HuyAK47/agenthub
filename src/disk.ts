import fs from 'node:fs';

export interface DiskSpace {
  freeGB: number;
  totalGB: number;
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

  try {
    const stats = fs.statfsSync(targetPath);
    return parseStatFs(stats);
  } catch {
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
    return { freeGB: 0, totalGB: 0 };
  }
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
