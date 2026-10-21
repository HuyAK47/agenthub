import { describe, expect, it, vi } from 'vitest';

describe('process-tree Darwin delegation', () => {
  it('delegates to the platform implementation on macOS', async () => {
    const platform = await import('../src/platform/index.js');
    const measure = vi.spyOn(platform.darwinPlatform, 'measureProcessTree').mockReturnValue({
      rss: 123,
      cpu: 4.5,
      totalTicks: 450,
      measuredAt: 42,
      pids: [77],
      states: { 77: 'R' },
    });
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    try {
      const { measureProcessTree } = await import('../src/process-tree.js');
      expect(measureProcessTree(77)).toEqual(expect.objectContaining({ rss: 123, pids: [77] }));
      expect(measure).toHaveBeenCalledWith(77, undefined, undefined);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      measure.mockRestore();
    }
  });
});
