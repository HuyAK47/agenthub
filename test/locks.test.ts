import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { isLockFree, lockCommand } from '../src/profiles/locks.js';

describe('profile lock commands', () => {
  afterEach(() => vi.restoreAllMocks());

  it('uses flock on Linux', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('linux');
    expect(lockCommand('/tmp/agenthub.lock', ['true'])).toEqual(['flock', ['-n', '/tmp/agenthub.lock', 'true']]);
  });

  it('uses lockf with non-blocking macOS flags', () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('darwin');
    expect(lockCommand('/tmp/agenthub.lock', ['true'])).toEqual(['/usr/bin/lockf', ['-k', '-s', '-t', '0', '/tmp/agenthub.lock', 'true']]);
  });

  it('detects a held Linux lock and then observes it after release', async () => {
    if (process.platform !== 'linux') return;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lock-'));
    const file = path.join(dir, 'slot.lock');
    const child = spawn('flock', ['-n', file, 'sleep', '2'], { stdio: 'ignore', detached: true });
    try {
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve());
        child.once('error', reject);
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      await expect(isLockFree(file)).resolves.toBe(false);
      const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      process.kill(-(child.pid || 0), 'SIGKILL');
      await closed;
      for (let attempt = 0; attempt < 10 && !(await isLockFree(file)); attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await expect(isLockFree(file)).resolves.toBe(true);
    } finally {
      if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already closed */ }
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
