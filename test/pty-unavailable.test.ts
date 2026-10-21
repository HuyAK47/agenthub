import { describe, expect, it, vi } from 'vitest';

const spawn = vi.fn(() => { throw new Error('spawn-helper EACCES'); });
vi.mock('node-pty', () => ({ default: { spawn } }));

describe('PtyManager unavailable PTY', () => {
  it('returns pty_unavailable and leaves no session when spawn throws', async () => {
    const { PtyManager } = await import('../src/api/pty.js');
    const service = {
      profileRepo: { get: vi.fn(() => undefined) },
      createProfile: vi.fn(() => ({ name: 'darwin', engine: 'agy', kind: 'isolated', home: '/tmp' })),
      config: { agyHomesDir: '/tmp/agy-homes', chat: { claudeBin: null } },
    };
    const manager = new PtyManager(service as never);

    expect(() => manager.createSession('darwin')).toThrow(expect.objectContaining({
      statusCode: 503,
      error: 'pty_unavailable',
    }));
    expect(manager.getSession('missing')).toBeUndefined();
    expect(spawn).toHaveBeenCalledOnce();
  });

  it('ensureSpawnHelperExecutable applies executable permission to spawn-helper binaries', async () => {
    const { ensureSpawnHelperExecutable } = await import('../src/api/pty.js');
    const fs = await import('node:fs');
    const path = await import('node:path');
    const { createRequire } = await import('node:module');
    const require = createRequire(import.meta.url);
    const ptyDir = path.dirname(require.resolve('node-pty/package.json'));
    const darwinHelper = path.join(ptyDir, 'prebuilds', 'darwin-arm64', 'spawn-helper');
    if (fs.existsSync(darwinHelper)) {
      ensureSpawnHelperExecutable();
      expect(fs.statSync(darwinHelper).mode & 0o111).not.toBe(0);
    }
  });
});
