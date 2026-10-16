import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ensureNodeModules } from '../src/cache.js';

const execFileAsync = promisify(execFile);

describe('node_modules cache', () => {
  let tmpDir: string | undefined;

  afterEach(() => {
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('hard-links a matching project dependency tree through the cache', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cache-test-'));
    const projectDir = path.join(tmpDir, 'project');
    const worktreeDir = path.join(tmpDir, 'worktree');
    const cacheDir = path.join(tmpDir, 'cache');
    for (const dir of [projectDir, worktreeDir]) fs.mkdirSync(dir, { recursive: true });

    const lock = '{"name":"fixture","lockfileVersion":3}';
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), lock);
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'fixture'), { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
    fs.writeFileSync(path.join(worktreeDir, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(worktreeDir, 'package-lock.json'), lock);

    const result = await ensureNodeModules({ worktreeDir, projectDir, cacheBaseDir: cacheDir });
    const worktreeFile = path.join(worktreeDir, 'node_modules', 'fixture', 'index.js');
    const cacheFile = path.join(cacheDir, 'node_modules', 'fixture', 'index.js');
    // The cache is keyed by the lock hash, not by a fixed directory name.
    const cacheEntry = fs.readdirSync(cacheDir).find((entry) => entry.length === 64);
    const hashedCacheFile = path.join(cacheDir, cacheEntry!, 'node_modules', 'fixture', 'index.js');

    expect(result).toMatchObject({ cached: true, createdCache: true, usedNpmCi: false });
    expect(fs.statSync(worktreeFile).ino).toBe(fs.statSync(hashedCacheFile).ino);
    expect(fs.existsSync(cacheFile)).toBe(false);
  });

  it('runs npm ci in the worktree when the lock hash differs', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cache-test-'));
    const worktreeDir = path.join(tmpDir, 'worktree');
    const projectDir = path.join(tmpDir, 'project');
    const calls: Array<{ cmd: string; args: string[] }> = [];
    for (const dir of [projectDir, worktreeDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.writeFileSync(path.join(worktreeDir, 'package.json'), '{"name":"changed"}');
    fs.writeFileSync(path.join(worktreeDir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');

    const result = await ensureNodeModules({
      worktreeDir,
      projectDir,
      cacheBaseDir: path.join(tmpDir, 'cache'),
      execFn: async (cmd, args, opts) => {
        calls.push({ cmd, args });
        if (cmd === 'npm') fs.mkdirSync(path.join(opts?.cwd || worktreeDir, 'node_modules'), { recursive: true });
        return { stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({ cached: false, usedNpmCi: true });
    expect(calls).toEqual([{ cmd: 'npm', args: ['ci', '--ignore-scripts=false'] }]);
  });

  it('falls back to a private npm ci when native verification fails', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cache-test-'));
    const projectDir = path.join(tmpDir, 'project');
    const worktreeDir = path.join(tmpDir, 'worktree');
    const cacheDir = path.join(tmpDir, 'cache');
    for (const dir of [projectDir, worktreeDir]) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(projectDir, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(projectDir, 'package-lock.json'), '{"lockfileVersion":3}');
    fs.mkdirSync(path.join(projectDir, 'node_modules', 'better-sqlite3'), { recursive: true });
    fs.writeFileSync(path.join(worktreeDir, 'package.json'), '{"name":"fixture"}');
    fs.writeFileSync(path.join(worktreeDir, 'package-lock.json'), '{"lockfileVersion":3}');

    const calls: string[] = [];
    const result = await ensureNodeModules({
      worktreeDir,
      projectDir,
      cacheBaseDir: cacheDir,
      execFn: async (cmd, args, opts) => {
        calls.push(cmd);
        if (cmd === process.execPath) throw new Error('wrong ABI');
        if (cmd === 'npm') fs.mkdirSync(path.join(opts?.cwd || worktreeDir, 'node_modules'), { recursive: true });
        if (cmd === 'cp') await execFileAsync(cmd, args, { cwd: opts?.cwd });
        return { stdout: '', stderr: '' };
      },
    });

    expect(result).toMatchObject({ cached: false, usedNpmCi: true });
    expect(calls).toContain(process.execPath);
    expect(calls).toContain('npm');
  });

  it('publishes a concurrently built cache with an atomic rename', async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-cache-test-'));
    const cacheDir = path.join(tmpDir, 'cache');
    const worktreeA = path.join(tmpDir, 'a');
    const worktreeB = path.join(tmpDir, 'b');
    for (const dir of [worktreeA, worktreeB]) {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"fixture"}');
      fs.writeFileSync(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3}');
    }

    const execFn = async (cmd: string, _args: string[], opts?: { cwd?: string }) => {
      if (cmd === 'npm') {
        await new Promise((resolve) => setTimeout(resolve, 10));
        const cwd = opts?.cwd || tmpDir!;
        fs.mkdirSync(path.join(cwd, 'node_modules', 'fixture'), { recursive: true });
        fs.writeFileSync(path.join(cwd, 'node_modules', 'fixture', 'index.js'), 'module.exports = 1;');
      } else if (cmd === 'cp') {
        await execFileAsync(cmd, _args, { cwd: opts?.cwd });
      }
      return { stdout: '', stderr: '' };
    };

    await Promise.all([
      ensureNodeModules({ worktreeDir: worktreeA, cacheBaseDir: cacheDir, execFn }),
      ensureNodeModules({ worktreeDir: worktreeB, cacheBaseDir: cacheDir, execFn }),
    ]);

    const entries = fs.readdirSync(cacheDir).filter((entry) => /^[a-f0-9]{64}$/.test(entry));
    expect(entries).toHaveLength(1);
    const cachedFile = path.join(cacheDir, entries[0], 'node_modules', 'fixture', 'index.js');
    expect(fs.statSync(path.join(worktreeA, 'node_modules', 'fixture', 'index.js')).ino).toBe(fs.statSync(cachedFile).ino);
    expect(fs.statSync(path.join(worktreeB, 'node_modules', 'fixture', 'index.js')).ino).toBe(fs.statSync(cachedFile).ino);
  });
});
