import { spawn } from 'node:child_process';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const fakeAgent = path.resolve(__dirname, 'fixtures', 'fake-agent.mjs');

function exitOf(child: ReturnType<typeof spawn>): Promise<number | null> {
  return new Promise((resolve) => child.on('exit', (code) => resolve(code)));
}

describe('test fixtures never outlive their test run', () => {
  it('a never-ending fake agent exits once its owning test process is gone', async () => {
    // Stand-in for a test worker that dies without cleaning up.
    const owner = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 300)']);
    const agent = spawn(process.execPath, [fakeAgent], {
      env: { ...process.env, FAKE_MODE: 'sleep-loop', AGENTHUB_TEST_OWNER_PID: String(owner.pid) },
      stdio: 'ignore',
      detached: true,
    });
    try {
      await exitOf(owner);
      const started = Date.now();
      expect(await exitOf(agent)).toBe(1);
      expect(Date.now() - started).toBeLessThan(5000);
    } finally {
      try { process.kill(-agent.pid!, 'SIGKILL'); } catch { /* exited */ }
    }
  });

  it('a never-ending fake agent exits after its lifetime cap even if the owner lives', async () => {
    const agent = spawn(process.execPath, [fakeAgent], {
      env: { ...process.env, FAKE_MODE: 'sleep-loop', FAKE_MAX_LIFETIME_MS: '500' },
      stdio: 'ignore',
      detached: true,
    });
    try {
      expect(await exitOf(agent)).toBe(1);
    } finally {
      try { process.kill(-agent.pid!, 'SIGKILL'); } catch { /* exited */ }
    }
  });
});
