import { describe, expect, it, vi } from 'vitest';

const { execFileSync, calls } = vi.hoisted(() => {
  const calls: string[][] = [];
  const execFileSync = vi.fn((file: string, args: string[]) => {
    calls.push([file, ...args]);
    if (file === 'ps' && args[0] === '-axo') {
      if (args[1] === 'pid=,ppid=,rss=,%cpu=,stat=') {
        return [
          ' 201     1  100  1.25 S',
          ' 202   201  200  2.50 R+',
          ' 203   202   50  0.25 T',
          ' 204   999  999 99.00 Z',
          'garbage row',
          ' 205   206  100  1.00 S',
          ' 206   205  100  1.00 R',
        ].join('\n');
      }
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

  it('measures the root tree from one ps snapshot and ignores malformed or unrelated rows', async () => {
    const { darwinPlatform } = await import('../src/platform/darwin.js');

    const measured = darwinPlatform.measureProcessTree!(201);

    expect(measured.pids).toEqual([201, 202, 203]);
    expect(measured.rss).toBe((100 + 200 + 50) * 1024);
    expect(measured.cpu).toBe(4);
    expect(measured.states).toEqual({ 201: 'S', 202: 'R+', 203: 'T' });
  });

  it('does not loop when the process table contains a parent cycle', async () => {
    const { darwinPlatform } = await import('../src/platform/darwin.js');

    const measured = darwinPlatform.measureProcessTree!(205);

    expect(measured.pids).toEqual([205, 206]);
    expect(measured.states).toMatchObject({ 205: 'S', 206: 'R' });
  });
});
