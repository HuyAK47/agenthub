import { describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

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

  it('ensureSpawnHelperExecutable applies executable permission to spawn-helper binaries in temporary directory', async () => {
    const { ensureSpawnHelperExecutable, fixSpawnHelperPermissions } = await import('../src/api/pty.js');

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-spawn-helper-test-'));
    try {
      const releaseDir = path.join(tmpDir, 'build', 'Release');
      fs.mkdirSync(releaseDir, { recursive: true });
      const helperRelease = path.join(releaseDir, 'spawn-helper');
      fs.writeFileSync(helperRelease, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

      const prebuildDir = path.join(tmpDir, 'prebuilds', `${process.platform}-${process.arch}`);
      fs.mkdirSync(prebuildDir, { recursive: true });
      const helperPrebuild = path.join(prebuildDir, 'spawn-helper');
      fs.writeFileSync(helperPrebuild, '#!/bin/sh\nexit 0\n', { mode: 0o644 });

      // Before ensure, files do not have executable permission
      expect(fs.statSync(helperRelease).mode & 0o111).toBe(0);
      expect(fs.statSync(helperPrebuild).mode & 0o111).toBe(0);

      // Call ensureSpawnHelperExecutable with ptyDir
      ensureSpawnHelperExecutable(tmpDir);

      expect(fs.statSync(helperRelease).mode & 0o111).not.toBe(0);
      expect(fs.statSync(helperPrebuild).mode & 0o111).not.toBe(0);

      // Test fixSpawnHelperPermissions directly with a custom list of candidate file paths
      const directHelper = path.join(tmpDir, 'custom-spawn-helper');
      fs.writeFileSync(directHelper, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
      expect(fs.statSync(directHelper).mode & 0o111).toBe(0);

      fixSpawnHelperPermissions([directHelper]);
      expect(fs.statSync(directHelper).mode & 0o111).not.toBe(0);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
