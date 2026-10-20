import { describe, expect, it, vi } from 'vitest';

const { execFileSync, calls } = vi.hoisted(() => {
  const calls: string[][] = [];
  const execFileSync = vi.fn((file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === 'ps' && args[0] === '-axo') {
      return [
        ' 101     1  2048  12.5 Mon Oct 20 10:00:00 2026 node',
        ' 102   101  1024   1.0 Mon Oct 20 10:01:00 2026 worker',
        ' 103   102   512   0.0 Mon Oct 20 10:02:00 2026 python',
        ' 104   999   256   0.0 Mon Oct 20 10:03:00 2026 unrelated',
        ' 105     1   768   2.5 Mon Oct 20 10:04:00 2026 claude',
      ].join('\n');
    }
    if (file === 'lsof') {
      return ['p101', 'n/project', 'p102', 'n/project', 'p103', 'n/project/sub', 'p105', 'n/other'].join('\n');
    }
    return '';
  });
  return { execFileSync, calls };
});

vi.mock('node:child_process', () => ({ execFile, execFileSync }));

const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

describe('darwin process listing', () => {
  it('uses batched ps/lsof output and fills process metadata', async () => {
    const { darwinPlatform } = await import('../src/platform/darwin.js');

    const processes = darwinPlatform.process.listProcesses();

    expect(processes).toEqual([
      expect.objectContaining({ pid: 101, ppid: 1, parentName: '', rss: 2048 * 1024, cpu: 12.5, cwd: '/project', startedAt: Date.parse('Mon Oct 20 10:00:00 2026') }),
      expect.objectContaining({ pid: 102, ppid: 101, parentName: 'node', cwd: '/project', startedAt: Date.parse('Mon Oct 20 10:01:00 2026') }),
      expect.objectContaining({ pid: 103, ppid: 102, parentName: 'worker', cwd: '/project/sub' }),
      expect.objectContaining({ pid: 104, ppid: 999, parentName: '', cwd: '' }),
      expect.objectContaining({ pid: 105, ppid: 1, parentName: '', cwd: '/other' }),
    ]);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual(['ps', '-axo', 'pid=,ppid=,rss=,%cpu=,lstart=,comm=']);
    expect(calls[1]).toEqual(['lsof', '-a', '-d', 'cwd', '-Fpn', '-p', '101,102,103,105']);
  });
});
