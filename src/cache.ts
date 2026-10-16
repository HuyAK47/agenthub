import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface EnsureNodeModulesOptions {
  worktreeDir: string;
  projectDir?: string;
  cacheBaseDir?: string;
  env?: NodeJS.ProcessEnv;
  execFn?: (
    cmd: string,
    args: string[],
    opts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
  ) => Promise<{ stdout: string; stderr: string }>;
}

export interface EnsureNodeModulesResult {
  cached: boolean;
  createdCache: boolean;
  usedNpmCi: boolean;
}

export function getLockFileInfo(dir: string): { type: 'npm' | 'pnpm'; file: string; path: string } | null {
  const pnpmPath = path.join(dir, 'pnpm-lock.yaml');
  if (fs.existsSync(pnpmPath)) {
    return { type: 'pnpm', file: 'pnpm-lock.yaml', path: pnpmPath };
  }
  const npmPath = path.join(dir, 'package-lock.json');
  if (fs.existsSync(npmPath)) {
    return { type: 'npm', file: 'package-lock.json', path: npmPath };
  }
  return null;
}

export function hashFile(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

export function getCacheNodeModulesDir(cacheEntryDir: string): string | null {
  const inside = path.join(cacheEntryDir, 'node_modules');
  if (fs.existsSync(inside)) return inside;
  if (fs.existsSync(cacheEntryDir)) {
    try {
      const files = fs.readdirSync(cacheEntryDir);
      // Older cache entries stored the node_modules contents directly under
      // the hash directory. New entries also contain package metadata, so do
      // not mistake an incomplete/new entry for the old layout.
      if (
        files.length > 0 &&
        !files.includes('node_modules') &&
        !files.includes('package.json') &&
        !files.includes('package-lock.json') &&
        !files.includes('pnpm-lock.yaml')
      ) {
        return cacheEntryDir;
      }
    } catch {
      // ignore
    }
  }
  return null;
}

export async function verifyNativeModules(
  dir: string,
  execFn?: EnsureNodeModulesOptions['execFn'],
): Promise<boolean> {
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) return true;
  const pkgJsonPath = path.join(dir, 'package.json');
  if (!fs.existsSync(pkgJsonPath)) return true;

  const candidateModules = ['better-sqlite3', 'node-pty'];
  for (const mod of candidateModules) {
    if (fs.existsSync(path.join(nm, mod))) {
      try {
        if (execFn) {
          await execFn(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, timeout: 30000 });
        } else {
          await execFileAsync(process.execPath, ['-e', `require(${JSON.stringify(mod)})`], { cwd: dir, timeout: 30000 });
        }
      } catch (err) {
        console.warn(`[cache] Native module ${mod} verification failed in ${dir}:`, err);
        return false;
      }
    }
  }
  return true;
}

export function areDirectoriesHardLinked(dir1: string, dir2: string): boolean {
  if (!fs.existsSync(dir1) || !fs.existsSync(dir2)) return false;

  function findFirstFile(current: string): string | null {
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(current, entry.name);
        if (entry.isFile()) return full;
        if (entry.isDirectory()) {
          const res = findFirstFile(full);
          if (res) return res;
        }
      }
    } catch {
      // ignore
    }
    return null;
  }

  const file1 = findFirstFile(dir1);
  if (!file1) return false;
  const rel = path.relative(dir1, file1);
  const file2 = path.join(dir2, rel);
  if (!fs.existsSync(file2)) return false;

  try {
    return fs.statSync(file1).ino === fs.statSync(file2).ino;
  } catch {
    return false;
  }
}
export async function ensureNodeModules(opts: EnsureNodeModulesOptions): Promise<EnsureNodeModulesResult> {
  const { worktreeDir, projectDir, env } = opts;
  const pkgPath = path.join(worktreeDir, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    return { cached: false, createdCache: false, usedNpmCi: false };
  }

  const worktreeLock = getLockFileInfo(worktreeDir);
  if (!worktreeLock) {
    return { cached: false, createdCache: false, usedNpmCi: false };
  }

  const lockHash = hashFile(worktreeLock.path);
  const cacheBase =
    opts.cacheBaseDir ||
    path.join(
      process.env.AGENTHUB_HOME || path.join(os.homedir(), '.agenthub'),
      'cache',
      'node_modules',
    );
  const cacheEntryDir = path.join(cacheBase, lockHash);
  const targetNodeModules = path.join(worktreeDir, 'node_modules');

  const isWeb = path.basename(worktreeDir) === 'web';
  const worktreeRoot = isWeb ? path.dirname(worktreeDir) : worktreeDir;
  const agentHubDir = path.join(worktreeRoot, '.agenthub');
  const hashFileName = isWeb ? 'web-lock.hash' : 'root-lock.hash';
  const hashFilePath = path.join(agentHubDir, hashFileName);

  const runner = async (
    cmd: string,
    args: string[],
    runOpts?: { cwd?: string; env?: NodeJS.ProcessEnv; timeout?: number },
  ) => {
    if (opts.execFn) {
      return opts.execFn(cmd, args, runOpts);
    }
    return execFileAsync(cmd, args, {
      cwd: runOpts?.cwd,
      env: runOpts?.env || env || process.env,
      timeout: runOpts?.timeout ?? 600000,
    });
  };

  const writeHash = () => {
    try {
      fs.mkdirSync(agentHubDir, { recursive: true });
      fs.writeFileSync(hashFilePath, lockHash, 'utf8');
    } catch {
      // ignore
    }
  };

  const installInWorktree = async (): Promise<EnsureNodeModulesResult> => {
    try {
      fs.rmSync(targetNodeModules, { recursive: true, force: true });
    } catch {
      // ignore
    }
    const ciCmd = worktreeLock.type === 'pnpm' ? 'pnpm' : 'npm';
    const ciArgs = worktreeLock.type === 'pnpm' ? ['i', '--frozen-lockfile'] : ['ci', '--ignore-scripts=false'];
    await runner(ciCmd, ciArgs, { cwd: worktreeDir, timeout: 600000 });
    writeHash();
    return { cached: false, createdCache: false, usedNpmCi: true };
  };

  const verifyOrInstall = async (result: EnsureNodeModulesResult): Promise<EnsureNodeModulesResult> => {
    if (await verifyNativeModules(worktreeDir, opts.execFn)) return result;
    return installInWorktree();
  };

  const createCacheAtomically = async (sourceNodeModules?: string): Promise<string | null> => {
    fs.mkdirSync(cacheBase, { recursive: true });
    const tempDir = await fs.promises.mkdtemp(path.join(cacheBase, '.tmp-nm-cache-'));
    try {
      const tempNm = path.join(tempDir, 'node_modules');
      if (sourceNodeModules) {
        await runner('cp', ['-al', sourceNodeModules, tempNm], { timeout: 600000 });
      } else {
        fs.copyFileSync(pkgPath, path.join(tempDir, 'package.json'));
        fs.copyFileSync(worktreeLock.path, path.join(tempDir, worktreeLock.file));
        const ciCmd = worktreeLock.type === 'pnpm' ? 'pnpm' : 'npm';
        const ciArgs = worktreeLock.type === 'pnpm' ? ['i', '--frozen-lockfile'] : ['ci', '--ignore-scripts=false'];
        await runner(ciCmd, ciArgs, { cwd: tempDir, timeout: 600000 });
      }
      if (!fs.existsSync(tempNm)) return null;
      if (sourceNodeModules) {
        fs.copyFileSync(path.join(path.dirname(sourceNodeModules), 'package.json'), path.join(tempDir, 'package.json'));
        fs.copyFileSync(worktreeLock.path, path.join(tempDir, worktreeLock.file));
      }
      try {
        await fs.promises.rename(tempDir, cacheEntryDir);
        return path.join(cacheEntryDir, 'node_modules');
      } catch {
        // Another worker won the race. Its complete cache is authoritative.
        return getCacheNodeModulesDir(cacheEntryDir);
      }
    } finally {
      if (fs.existsSync(tempDir)) {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ }
      }
    }
  };

  // Case 1: targetNodeModules already exists
  if (fs.existsSync(targetNodeModules)) {
    let recordedHash: string | null = null;
    if (fs.existsSync(hashFilePath)) {
      try {
        recordedHash = fs.readFileSync(hashFilePath, 'utf8').trim();
      } catch {
        // ignore
      }
    }

    if (recordedHash) {
      if (recordedHash === lockHash) {
        return verifyOrInstall({ cached: true, createdCache: false, usedNpmCi: false });
      }
      return installInWorktree();
    }

    // No recorded hash: check if matches projectDir
    let matchesProject = false;
    if (projectDir) {
      const projectLock = getLockFileInfo(projectDir);
      if (projectLock && fs.existsSync(projectLock.path)) {
        matchesProject = hashFile(projectLock.path) === lockHash;
      }
    }

    if (matchesProject || getCacheNodeModulesDir(cacheEntryDir)) {
      writeHash();
      return verifyOrInstall({ cached: true, createdCache: false, usedNpmCi: false });
    }

    // Differing lockfile with no record
    return installInWorktree();
  }

  // Case 2: targetNodeModules does not exist yet (worktree creation)
  let cacheNm = getCacheNodeModulesDir(cacheEntryDir);
  let createdCache = false;

  if (!cacheNm) {
    let matchesProject = false;
    if (projectDir) {
      const projectLock = getLockFileInfo(projectDir);
      const projectNm = path.join(projectDir, 'node_modules');
      if (projectLock && fs.existsSync(projectLock.path)) {
        const projectHash = hashFile(projectLock.path);
        if (projectHash === lockHash) {
          matchesProject = true;
          if (fs.existsSync(projectNm)) cacheNm = await createCacheAtomically(projectNm);
          if (cacheNm) createdCache = true;
        }
      }
    } else {
      matchesProject = true;
    }

    if (!cacheNm) {
      if (matchesProject) {
        cacheNm = await createCacheAtomically();
        if (cacheNm) createdCache = true;
      } else {
        return installInWorktree();
      }
    }
  }

  if (cacheNm && fs.existsSync(cacheNm)) {
    await runner('cp', ['-al', cacheNm, targetNodeModules], { timeout: 600000 });
    writeHash();
    return verifyOrInstall({ cached: true, createdCache, usedNpmCi: false });
  }

  return { cached: false, createdCache: false, usedNpmCi: true };
}

export async function ensureWorktreeNodeModules(
  worktreePath: string,
  projectPath?: string,
  cacheBaseDir?: string,
  execFn?: EnsureNodeModulesOptions['execFn'],
): Promise<void> {
  // 1. Root
  await ensureNodeModules({
    worktreeDir: worktreePath,
    projectDir: projectPath,
    cacheBaseDir,
    execFn,
  });

  // 2. Web/ if web/package.json exists
  const webWorktreeDir = path.join(worktreePath, 'web');
  if (fs.existsSync(path.join(webWorktreeDir, 'package.json'))) {
    const webProjectDir = projectPath ? path.join(projectPath, 'web') : undefined;
    await ensureNodeModules({
      worktreeDir: webWorktreeDir,
      projectDir: webProjectDir,
      cacheBaseDir,
      execFn,
    });
  }
}
