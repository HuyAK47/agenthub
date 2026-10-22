import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const PERF_GROUPS = ['hub daemon', 'worker', 'test/vitest', 'checks', 'agy', 'codex', 'claude', 'Chrome', 'VS Code', 'docker', 'other'] as const;
export type PerfGroup = typeof PERF_GROUPS[number];
export interface PerfProcess { pid: number; group: PerfGroup; rssBytes: number; cpuPercent: number; command: string; }
export interface PerfSample { at: string; cpuCount: number; processes: PerfProcess[]; groups: Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>; }
type ProcessState = { ticks: number; uptime: number };

const commandName = (command: string): string => path.basename(command.trim().split(/\s+/, 1)[0] || '').toLowerCase();
export function classify(command: string): PerfGroup {
  const value = command.trim().toLowerCase();
  const name = commandName(value);
  if ((name === 'node' || name === 'cli.js' || name === 'agenthub') && /(?:dist\/)?cli\.js\s+daemon|agenthub\s+daemon/.test(value)) return 'hub daemon';
  if (['vitest', 'jest'].includes(name) || (name === 'npm' && /(?:^|\s)test(?:\s|$)/.test(value))) return 'test/vitest';
  if (['check', 'checks', 'agenthub-check'].includes(name)) return 'checks';
  if (name === 'agy') return 'agy';
  if (name === 'codex') return 'codex';
  if (name === 'claude') return 'claude';
  if (['chrome', 'chrome.exe', 'chromium', 'chromium-browser'].includes(name)) return 'Chrome';
  if (['code', 'code-insiders'].includes(name) || /(?:visual studio code|\/vscode\/|\/code(?:-insiders)?(?:\s|$))/.test(value)) return 'VS Code';
  if (name === 'docker' || name === 'dockerd') return 'docker';
  if (/worktrees|fake-agent(?:\.m?js)?(?:\s|$)/.test(value)) return 'worker';
  return 'other';
}

let cachedPageSize: number | undefined;
let cachedClockTicks: number | undefined;
function systemValue(name: string, fallback: number): number {
  try { const value = Number(execFileSync('getconf', [name], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); return Number.isFinite(value) && value > 0 ? value : fallback; } catch { return fallback; }
}
function pageSize(): number { return cachedPageSize ??= systemValue('PAGESIZE', 4096); }
function clockTicks(): number { return cachedClockTicks ??= systemValue('CLK_TCK', 100); }
function emptyGroups(): Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }> {
  return Object.fromEntries(PERF_GROUPS.map((group) => [group, { cpuPercent: 0, rssBytes: 0, processes: 0 }])) as Record<PerfGroup, { cpuPercent: number; rssBytes: number; processes: number }>;
}

function readLinuxProcesses(procRoot: string, previous: Map<number, ProcessState>, uptime: number): PerfProcess[] {
  const result: PerfProcess[] = [];
  let entries: fs.Dirent[];
  try { entries = fs.readdirSync(procRoot, { withFileTypes: true }); } catch { return result; }
  const hz = clockTicks();
  for (const entry of entries) {
    if (!/^\d+$/.test(entry.name)) continue;
    const dir = path.join(procRoot, entry.name);
    try {
      const stat = fs.readFileSync(path.join(dir, 'stat'), 'utf8');
      const close = stat.lastIndexOf(')');
      const fields = stat.slice(close + 2).split(' ');
      const ticks = Number(fields[11] || 0) + Number(fields[12] || 0);
      const pid = Number(entry.name);
      const prior = previous.get(pid);
      previous.set(pid, { ticks, uptime });
      const elapsed = prior ? Math.max(0.01, uptime - prior.uptime) : 0;
      const cpuPercent = prior ? Math.max(0, ((ticks - prior.ticks) / hz / elapsed) * 100) : 0;
      const rssPages = Number(fields[21] || 0);
      const command = fs.readFileSync(path.join(dir, 'cmdline'), 'utf8').replaceAll('\0', ' ').trim() || stat.slice(stat.indexOf('(') + 1, close);
      result.push({ pid, group: classify(command), rssBytes: rssPages * pageSize(), cpuPercent, command: command.slice(0, 120) });
    } catch { /* process exited between directory and reads */ }
  }
  return result;
}

export function createPerfSampler(procRoot = '/proc'): () => PerfSample {
  const previous = new Map<number, ProcessState>();
  return () => {
    let uptime = 0;
    try { uptime = Number(fs.readFileSync(path.join(procRoot, 'uptime'), 'utf8').split(/\s+/)[0]); } catch { /* unavailable */ }
    const processes = process.platform === 'linux' ? readLinuxProcesses(procRoot, previous, uptime) : [];
    const groups = emptyGroups();
    for (const process of processes) { const group = groups[process.group]; group.cpuPercent += process.cpuPercent; group.rssBytes += process.rssBytes; group.processes += 1; }
    return { at: new Date().toISOString(), cpuCount: os.cpus().length, processes, groups };
  };
}
export function samplePerf(procRoot = '/proc'): PerfSample { return createPerfSampler(procRoot)(); }

export class PerfCollector {
  private samples: PerfSample[] = [];
  private timer?: NodeJS.Timeout;
  private readonly sampler: () => PerfSample;
  constructor(private readonly maxSamples = 120, sampler?: () => PerfSample) { this.sampler = sampler || createPerfSampler(); }
  sample(): PerfSample { const value = this.sampler(); this.samples.push(value); if (this.samples.length > this.maxSamples) this.samples.shift(); return value; }
  start(intervalMs = 30_000): void { if (this.timer) return; this.sample(); this.timer = setInterval(() => this.sample(), intervalMs); this.timer.unref?.(); }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }
  getSamples(): PerfSample[] { const latest = this.samples.length - 1; return this.samples.map((sample, index) => ({ ...sample, processes: index === latest ? sample.processes.slice().sort((a, b) => b.cpuPercent - a.cpuPercent).slice(0, 10) : [], groups: { ...sample.groups } })); }
  latest(): PerfSample { return this.getSamples().at(-1) || this.sample(); }
}

export function formatPerfTable(samples: PerfSample[]): string {
  const latest = samples[samples.length - 1];
  if (!latest) return 'Không có dữ liệu hiệu năng';
  const rows = PERF_GROUPS.map((group) => { const v = latest.groups[group]; return `${group}\t${v.processes}\t${v.cpuPercent.toFixed(1)}%\t${(v.rssBytes / 1024 ** 3).toFixed(2)} GB`; });
  return ['Nhóm\tProcess\tCPU\tRSS', ...rows].join('\n');
}
