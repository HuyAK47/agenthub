import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { getDiskSpaceSync, getMonitoredDisks } from '../src/disk.js';

describe('getDiskSpaceSync', () => {
  it('returns positive freeGB and totalGB for an existing real directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disk-sync-test-'));
    try {
      const result = getDiskSpaceSync(tmpDir);
      expect(result.freeGB).toBeGreaterThan(0);
      expect(result.totalGB).toBeGreaterThan(0);
      expect(result.freeGB).toBeLessThanOrEqual(result.totalGB);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('walks up to parent directory when path does not exist', () => {
    const nonExistent = path.join(os.tmpdir(), 'agenthub-disk-sync-nonexistent-' + Date.now());
    // The parent (os.tmpdir()) exists, so we should still get a valid result
    const result = getDiskSpaceSync(nonExistent);
    expect(result.freeGB).toBeGreaterThan(0);
    expect(result.totalGB).toBeGreaterThan(0);
  });

  it('monitors every configured worktree root', () => {
    const seen: string[] = [];
    const disks = getMonitoredDisks(['/legacy', '/encrypted'], 3, [], false, (target) => {
      seen.push(target);
      return { freeGB: 10, totalGB: 20 };
    });
    expect(seen).toEqual(['/legacy', '/encrypted']);
    expect(disks).toHaveLength(2);
    expect(disks.every((disk) => disk.source === 'worktrees')).toBe(true);
  });
});
