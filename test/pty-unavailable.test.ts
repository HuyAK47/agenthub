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
});
