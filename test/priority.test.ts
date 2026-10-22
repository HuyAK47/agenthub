import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { LIMITED_TEST_ENV, lowPriority, runInProcessGroup } from '../src/priority.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('priority helpers', () => {
  it('wraps commands with nice on linux and macos', () => {
    const [exe, args] = lowPriority('/bin/echo', ['hi']);
    const usesNice =
      (process.platform === 'linux' && fs.existsSync('/usr/bin/nice')) ||
      (process.platform === 'darwin' && process.env.AGENTHUB_NO_NICE !== '1');
    if (usesNice) {
      expect(exe).toMatch(/nice$/);
      expect(args).toContain('/bin/echo');
      expect(args.at(-1)).toBe('hi');
    } else {
      expect(exe).toBe('/bin/echo');
    }
  });

  it('passes vitest worker limits to the child', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-prio-'));
    dirs.push(dir);
    const r = await runInProcessGroup(process.execPath, ['-e', 'process.stdout.write(process.env.VITEST_MAX_THREADS || "")'], {
      cwd: dir,
      env: process.env,
      timeoutMs: 10_000,
    });
    expect(r.code).toBe(0);
    expect(r.output).toBe(LIMITED_TEST_ENV.VITEST_MAX_THREADS);
  });

  it('kills grandchildren left behind after the main command exits', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-prio-'));
    dirs.push(dir);
    const pidFile = path.join(dir, 'grandchild.pid');
    // Lệnh chính bật một tiến trình cháu sống lâu rồi thoát ngay (giống vitest pool sót lại).
    const script = `const { spawn } = require('node:child_process');
const c = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
process.exit(0);`;
    const r = await runInProcessGroup(process.execPath, ['-e', script], { cwd: dir, env: process.env, timeoutMs: 10_000 });
    expect(r.code).toBe(0);
    const grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(alive(grandchild)).toBe(false);
  });

  it('kills the whole group on timeout', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-prio-'));
    dirs.push(dir);
    const started = Date.now();
    const r = await runInProcessGroup(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: dir, env: process.env, timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(5000);
  });
});
