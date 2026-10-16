import { execFile } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { ProfileRepo, ProfileRow, QuotaMarkRepo, QuotaUsageRepo, QuotaUsageRow } from '../db/index.js';
import { isProfileLoggedIn } from '../profiles/index.js';
import { parseAuthState } from '../profiles/auth.js';

const execFileAsync = promisify(execFile);
const GROUP_FAMILIES: Record<string, string[]> = {
  'Gemini Models': ['gemini'],
  'Claude and GPT models': ['claude', 'gpt'],
};

export interface UsageEntry {
  group: string;
  families: string[];
  window: '5h' | 'week';
  remainingPct: number;
  resetAt: number;
}

export interface UsageCheckResult {
  entries: UsageEntry[];
  output: string;
  error?: string;
}

export function parseUsage(text: string): UsageEntry[] {
  const result: UsageEntry[] = [];
  for (const line of text.split(/\r?\n/)) {
    const columns = line.split('\t');
    if (columns.length < 4) continue;
    const group = columns[0].trim();
    const label = columns[1].trim().toLowerCase();
    const remainingPct = Number.parseInt(columns[2].replace('%', '').trim(), 10);
    const resetAt = Date.parse(columns[3].trim());
    const families = GROUP_FAMILIES[group];
    if (!families || !Number.isFinite(remainingPct) || !Number.isFinite(resetAt)) continue;
    const window = label.startsWith('five hour') ? '5h' : label.startsWith('weekly') ? 'week' : null;
    if (!window) continue;
    result.push({ group, families, window, remainingPct: Math.max(0, Math.min(100, remainingPct)), resetAt: Math.floor(resetAt / 1000) });
  }
  return result;
}

export async function fetchUsage(profile: ProfileRow, agyPath = process.env.AGENTHUB_AGY_BIN || path.join(os.homedir(), '.gemini', 'bin', 'agy')): Promise<UsageEntry[]> {
  const result = await runUsage(profile, agyPath);
  return result.entries;
}

async function runUsage(profile: ProfileRow, agyPath: string): Promise<UsageCheckResult> {
  const env = { ...process.env } as Record<string, string>;
  if (profile.kind === 'isolated' && profile.home) {
    env.HOME = profile.home;
    env.DBUS_SESSION_BUS_ADDRESS = 'unix:path=/nonexistent/agy-no-keyring';
  }
  try {
    const { stdout, stderr } = await execFileAsync(agyPath, ['-p', '/usage'], {
      env,
      timeout: 60_000,
      maxBuffer: 1024 * 1024,
    });
    return { entries: parseUsage(stdout), output: `${stdout}${stderr}` };
  } catch (error) {
    const result = error as { stdout?: string; stderr?: string; message?: string };
    return {
      entries: parseUsage(`${result.stdout || ''}`),
      output: `${result.stdout || ''}${result.stderr || ''}`,
      error: result.message || 'agy usage check failed',
    };
  }
}

export interface UsageEventSink {
  emit(type: string, taskId?: string, payload?: unknown): unknown;
}

export class QuotaUsageService {
  private active = 0;
  private pending = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private isLoggedIn: (profile: ProfileRow) => boolean;

  constructor(
    private profiles: ProfileRepo,
    private usage: QuotaUsageRepo,
    private marks: QuotaMarkRepo,
    private eventBus?: UsageEventSink,
    private agyPath?: string,
    isLoggedIn?: (profile: ProfileRow) => boolean,
  ) {
    this.isLoggedIn = isLoggedIn || isProfileLoggedIn;
  }

  getForProfile(name: string): QuotaUsageRow[] { return this.usage.getForProfile(name); }
  getAll(): QuotaUsageRow[] { return this.usage.getAll(); }

  async check(profile: ProfileRow): Promise<UsageCheckResult> {
    if (profile.engine !== 'agy') {
      return { entries: [], output: '', error: `Cannot check quota usage for engine ${profile.engine}` };
    }
    const result = await runUsage(profile, this.agyPath || process.env.AGENTHUB_AGY_BIN || path.join(os.homedir(), '.gemini', 'bin', 'agy'));
    const auth = parseAuthState(result.output, result.entries.length > 0);
    this.profiles.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
    if (result.entries.length > 0) this.saveEntries(profile, result.entries);
    return result;
  }

  start(): void {
    this.usage.deleteForEngine('codex');
    this.collectAll();
    this.timer = setInterval(() => this.collectAll(), 5 * 60 * 1000);
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = null; }

  collectAll(): void {
    for (const profile of this.profiles.getEnabled().filter((p) => p.engine === 'agy' && this.isLoggedIn(p))) {
      this.collect(profile);
    }
  }

  async collect(profile: ProfileRow): Promise<QuotaUsageRow[]> {
    if (profile.engine !== 'agy' || !this.isLoggedIn(profile)) return [];
    if (this.active >= 2) { this.pending.add(profile.name); return []; }
    this.active++;
    try {
      const result = await runUsage(profile, this.agyPath || process.env.AGENTHUB_AGY_BIN || path.join(os.homedir(), '.gemini', 'bin', 'agy'));
      const auth = parseAuthState(result.output, result.entries.length > 0);
      this.profiles.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
      const entries = result.entries;
      const fetchedAt = Math.floor(Date.now() / 1000);
      this.saveEntries(profile, entries, fetchedAt);
      return entries.map((e) => ({ profileName: profile.name, grp: e.group, window: e.window, remainingPct: e.remainingPct, resetAt: e.resetAt, fetchedAt }));
    } catch { return []; }
    finally {
      this.active--;
      const next = [...this.pending][0];
      if (next) { this.pending.delete(next); const p = this.profiles.get(next); if (p) void this.collect(p); }
    }
  }

  private saveEntries(profile: ProfileRow, entries: UsageEntry[], fetchedAt = Math.floor(Date.now() / 1000)): void {
    for (const entry of entries) {
      const row: QuotaUsageRow = { profileName: profile.name, grp: entry.group, window: entry.window, remainingPct: entry.remainingPct, resetAt: entry.resetAt, fetchedAt };
      this.usage.upsert(row);
      if (entry.remainingPct === 0) {
        for (const family of entry.families) {
          this.markForEmail(profile, family, entry.resetAt);
          this.eventBus?.emit('quota.exhausted', undefined, { profile: profile.name, family, reason: 'usage' });
        }
      }
    }
  }

  private markForEmail(profile: ProfileRow, family: string, until: number): void {
    for (const p of this.profiles.getAll().filter((p) => p.name === profile.name || (!!profile.email && p.email === profile.email))) {
      this.marks.mark(p.name, family, until, 'usage');
    }
  }

  bestRemaining(profile: ProfileRow, family: string): number | null {
    if (profile.engine !== 'agy') return null;
    const names = profile.email ? this.profiles.getAll().filter((p) => p.email === profile.email).map((p) => p.name) : [profile.name];
    const group = family === 'gemini' ? 'Gemini Models' : family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null;
    if (!group) return null;
    const values = names.flatMap((name) => this.usage.getForProfile(name).filter((u) => u.window === '5h' && u.grp === group).map((u) => u.remainingPct));
    return values.length ? Math.max(...values) : null;
  }
}
