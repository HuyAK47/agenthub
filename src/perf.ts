import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PERF_GROUPS = ['hub daemon', 'worker', 'test/vitest', 'checks', 'agy', 'codex', 'claude', 'Chrome', 'VS Code', 'docker', 'other'] as const;
export type PerfGroup = typeof PERF_GROUPS[number];

export interface PerfProcess { pid: number; group: PerfGroup; rssBytes: number; cpuPercent: number; command: string; }
export interface PerfSample { at: string; cpuCount: number; processes: PerfProcess[]; groups: Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>; }

function emptyGroups(): Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }> {
  return Object.fromEntries(PERF_GROUPS.map((group) => [group, { cpuPercent: 0, rssBytes: 0, processes: 0 }])) as Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>;
}

function classify(command: string): PerfGroup {
  const c = command.toLowerCase();
  if (c.includes('dist/cli.js daemon') || c.includes('agenthub daemon')) return 'hub daemon';
  if (c.includes('vitest') || c.includes('jest') || c.includes('npm test')) return 'test/vitest';
  if (c.includes('check') && (c.includes('npm') || c.includes('node'))) return 'checks';
  if (c.includes('agy')) return 'agy';
  if (c.includes('codex')) return 'codex';
  if (c.includes('claude')) return 'claude';
  if (c.includes('chrome') || c.includes('chromium')) return 'Chrome';
  if (c.includes('code') || c.includes('vscode')) return 'VS Code';
  if (c.includes('docker')) return 'docker';
  if (c.includes('worktrees') || c.includes('fake-agent')) return 'worker';
  return 'other';
}

function readLinuxProcesses(procRoot = '/proc'): PerfProcess[] {
  const result: PerfProcess[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { return result; }
  const hz = 100;
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const dir = path.join(procRoot, entry.name);
    try {
      const stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const ticks = Number(fields[11] || 0) + Number(fields[12] || 0);
      const uptime = Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(/\s+/)[0]);
      const start = Number(fields[19] || 0) / hz;
      const age = Math.max(0.01, uptime - start);
      const rssPages = Number(fields[21] || 0);
      const command = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim() || stat.slice(stat.indexOf('(') + 1, close);
      const group = classify(command);
      result.push({ pid: Number(entry.name), group, rssBytes: rssPages * (os as typeof os).pagesize?.() || rssPages * 4096, cpuPercent: (ticks / hz / age) * 100, command });
    } catch { /* process exited between directory and reads */ }
  }
  return result;
}

export function samplePerf(procRoot = '/proc'): PerfSample {
  const processes = process.platform === 'linux' ? readLinuxProcesses(procRoot) : [];
  const groups = emptyGroups();
  for (const process of processes) {
    const group = groups[process.group];
    group.cpuPercent += process.cpuPercent;
    group.rssBytes += process.rssBytes;
    group.processes += 1;
  }
  return { at: new Date().toISOString(), cpuCount: os.cpus().length, processes, groups };
}

export class PerfCollector {
  private samples: PerfSample[] = [];
  private timer?: NodeJS.Timeout;
  constructor(private readonly maxSamples = 120, private readonly sampler: () => PerfSample = () => samplePerf()) {}
  sample(): PerfSample { const value = this.sampler(); this.samples.push(value); if (this.samples.length > this.maxSamples) this.samples.shift(); return value; }
  start(intervalMs = 30_000): void { if (this.timer) return; this.sample(); this.timer = setInterval(() => this.sample(), intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  getSamples(): PerfSample[] { return this.samples.map((sample) => ({ ...sample, processes: [...sample.processes], groups: { ...sample.groups } })); }
  latest(): PerfSample { return this.samples[this.samples.length - 1] || this.sample(); }
}

export function formatPerfTable(samples: PerfSample[]): string {
  const latest = samples[samples.length - 1];
  if (!latest) return 'Không có dữ liệu hiệu năng';
  const rows = PERF_GROUPS.map((group) => { const v = latest.groups[group]; return `${group}\t${v.processes}\t${v.cpuPercent.toFixed(1)}%\t${(v.rssBytes / 1024 ** 3).toFixed(2)} GB`; });
  return ['Nhóm\tProcess\tCPU\tRSS', ...rows].join('\n');
}
