import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, ProfileRepo, QuotaMarkRepo, QuotaUsageRepo } from '../src/db/index.js';
import { hasClaudeQuotaAvailable, parseUsage, QuotaUsageService } from '../src/quota/usage.js';
import { ProfileLockService } from '../src/profiles/locks.js';
import { AppService } from '../src/services/index.js';
import { ClaudeSessionRepo } from '../src/claude-sessions/repo.js';

const sampleResetAt = Math.floor(new Date('2026-10-23T11:00:00+07:00').getTime() / 1000);
const sample = [
  `Gemini Models\tWeekly Limit Remaining\t85%\t${new Date((sampleResetAt + 7 * 3600) * 1000).toISOString()}`,
  `Gemini Models\tFive Hour Limit Remaining\t45%\t${new Date((sampleResetAt + 60) * 1000).toISOString()}`,
  `Claude and GPT models\tWeekly Limit Remaining\t49%\t${new Date((sampleResetAt + 7 * 3600 + 60) * 1000).toISOString()}`,
  `Claude and GPT models\tFive Hour Limit Remaining\t0%\t${new Date(sampleResetAt * 1000).toISOString()}`,
].join('\n');

describe('quota usage', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-23T10:00:00+07:00'));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('requires every Claude window to have quota remaining', () => {
    expect(hasClaudeQuotaAvailable([
      { grp: 'Claude and GPT models', remainingPct: 0 },
      { grp: 'Claude and GPT models', remainingPct: 60 },
    ])).toBe(false);
    expect(hasClaudeQuotaAvailable([
      { grp: 'Claude and GPT models', remainingPct: 1 },
      { grp: 'Claude and GPT models', remainingPct: 60 },
    ])).toBe(true);
  });

  it('parses the agy usage format and ignores malformed lines', () => {
    const parsed = parseUsage(`${sample}\nnoise\tmissing\nBroken\tFive Hour Limit Remaining\tnope\tnot-date`);
    expect(parsed).toHaveLength(4);
    expect(parsed[0]).toMatchObject({ group: 'Gemini Models', window: 'week', remainingPct: 85, families: ['gemini'] });
    expect(parsed[3].resetAt).toBe(sampleResetAt);
  });

  it('stores usage and creates a mark ending at resetAt', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-usage-'));
    const script = path.join(dir, 'fake-agy.mjs');
    fs.writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(sample)})`);
    fs.chmodSync(script, 0o755);
    const db = openDatabase(path.join(dir, 'hub.db'));
    const profiles = new ProfileRepo(db); const marks = new QuotaMarkRepo(db); const usage = new QuotaUsageRepo(db);
    fs.mkdirSync(path.join(dir, '.gemini', 'antigravity-cli'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'), 'dummy-token');
    profiles.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: dir, email: 'a@example.com', enabled: 1 });
    const service = new QuotaUsageService(profiles, usage, marks, undefined, script);
    await service.collect(profiles.get('g1')!);
    expect(marks.getAll()).toContainEqual(expect.objectContaining({ profileName: 'g1', family: 'claude', until: sampleResetAt, reason: 'usage' }));
    expect(usage.getForProfile('g1')).toHaveLength(4);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collector ignores codex profile and unauthenticated agy profiles', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-usage-codex-'));
    const script = path.join(dir, 'fake-agy.mjs');
    fs.writeFileSync(script, `#!/usr/bin/env node\nprocess.stdout.write(${JSON.stringify(sample)})`);
    fs.chmodSync(script, 0o755);

    const db = openDatabase(path.join(dir, 'hub.db'));
    const profiles = new ProfileRepo(db);
    const marks = new QuotaMarkRepo(db);
    const usage = new QuotaUsageRepo(db);

    profiles.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: dir, email: null, enabled: 1 });
    profiles.upsert({ name: 'g_unauth', engine: 'agy', kind: 'isolated', home: path.join(dir, 'unauth'), email: 'u@example.com', enabled: 1 });

    const service = new QuotaUsageService(profiles, usage, marks, undefined, script);

    const codexRes = await service.collect(profiles.get('codex')!);
    expect(codexRes).toEqual([]);
    expect(usage.getForProfile('codex')).toHaveLength(0);

    const unauthRes = await service.collect(profiles.get('g_unauth')!);
    expect(unauthRes).toEqual([]);
    expect(usage.getForProfile('g_unauth')).toHaveLength(0);

    const checkRes = await service.check(profiles.get('codex')!);
    expect(checkRes.entries).toHaveLength(0);
    expect(checkRes.error).toContain('codex');

    expect(service.bestRemaining(profiles.get('codex')!, 'codex')).toBeNull();

    service.collectAll();
    expect(usage.getAll()).toHaveLength(0);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('deletes stale codex usage rows when started or explicitly requested', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-usage-clean-'));
    const db = openDatabase(path.join(dir, 'hub.db'));
    const profiles = new ProfileRepo(db);
    const marks = new QuotaMarkRepo(db);
    const usage = new QuotaUsageRepo(db);

    profiles.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: dir, email: null, enabled: 1 });

    usage.upsert({
      profileName: 'codex',
      grp: 'Gemini Models',
      window: '5h',
      remainingPct: 80,
      resetAt: 1234567890,
      fetchedAt: 1234567800,
    });
    expect(usage.getForProfile('codex')).toHaveLength(1);

    const service = new QuotaUsageService(profiles, usage, marks);
    service.start();
    service.stop();

    expect(usage.getForProfile('codex')).toHaveLength(0);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not expose profiles without Claude usage in Claude quota', () => {
    const db = openDatabase(':memory:');
    const profiles = new ProfileRepo(db);
    profiles.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1 });
    profiles.upsert({ name: 'gemini', engine: 'agy', kind: 'isolated', home: null, email: null, enabled: 1 });
    const usageRows = [
      { profileName: 'codex', grp: 'Codex', window: '5h', remainingPct: 0, resetAt: 1_900_000_000, fetchedAt: 1_800_000_000 },
      { profileName: 'gemini', grp: 'Gemini Models', window: '5h', remainingPct: 80, resetAt: 1_900_000_000, fetchedAt: 1_800_000_000 },
    ];
    const service = Object.create(AppService.prototype) as AppService;
    service.profileRepo = profiles;
    service.usageService = { getAll: () => usageRows } as unknown as QuotaUsageService;
    service.claudeSessionRepo = new ClaudeSessionRepo(db);

    expect(service.getClaudeQuota().profiles).toEqual([]);
    db.close();
  });
});

function hasCommand(name: string): boolean {
  for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
    const candidate = path.join(dir, name);
    try {
      const stat = fs.statSync(candidate);
      if (stat.isFile() && (process.platform === 'win32' || (stat.mode & 0o111) !== 0)) return true;
    } catch { /* next */ }
  }
  return false;
}

const canRunExternalLock = process.platform === 'darwin' ? fs.existsSync('/usr/bin/lockf') : hasCommand('flock');

describe('profile locks', () => {
  it('gives Codex two compatible lock slots', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-lock-'));
    const service = new ProfileLockService(dir, 2, 2);
    const profile = { name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1, createdAt: '' };
    expect(service.slotsTotal(profile)).toBe(2);
    expect(service.lockPath(profile, 1)).toBe(path.join(dir, 'codex.lock'));
    expect(service.lockPath(profile, 2)).toBe(path.join(dir, 'codex.lock2'));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(!canRunExternalLock)('detects an external flock-held slot', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lock-'));
    const lock = path.join(dir, 'g1.lock');
    fs.writeFileSync(lock, '');
    const [tool, args] = process.platform === 'darwin'
      ? ['/usr/bin/lockf', ['-k', lock, 'sleep', '5']]
      : ['flock', [lock, 'sleep', '5']];
    const child = spawn(tool, args, { stdio: 'ignore' });
    const service = new ProfileLockService(dir);
    try {
      await vi.waitFor(() => {
        const slots = service.getSlotsSync({ name: 'g1', engine: 'agy', kind: 'isolated', home: dir, email: null, enabled: 1, createdAt: '' });
        expect(slots).toMatchObject({ slotsUsed: 1, slotsTotal: 2, busy: false });
      }, { timeout: 3000 });
    } finally {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reserves and releases slots in memory', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-reserve-lock-'));
    const service = new ProfileLockService(dir, 2, 2);
    const profile = { name: 'codex', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1, createdAt: '' };

    expect(service.findFreeSlotSync(profile)).toBe(1);
    const lock1 = service.lockPath(profile, 1);
    service.reserve(profile, lock1);

    expect(service.isReserved(profile, lock1)).toBe(true);
    expect(service.findFreeSlotSync(profile)).toBe(2);
    expect(service.getSlotsSync(profile)).toMatchObject({ slotsUsed: 1, slotsTotal: 2, busy: false });

    const lock2 = service.lockPath(profile, 2);
    service.reserve(profile, lock2);
    expect(service.findFreeSlotSync(profile)).toBeNull();
    expect(service.getSlotsSync(profile)).toMatchObject({ slotsUsed: 2, slotsTotal: 2, busy: true });

    service.release(profile, lock1);
    expect(service.findFreeSlotSync(profile)).toBe(1);
    expect(service.getSlotsSync(profile)).toMatchObject({ slotsUsed: 1, slotsTotal: 2, busy: false });

    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('blocks another profile sharing the same codex lockFile', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-shared-lock-'));
    const service = new ProfileLockService(dir, 2, 2);
    const p1 = { name: 'codex-1', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1, createdAt: '' };
    const p2 = { name: 'codex-2', engine: 'codex', kind: 'codex', home: null, email: null, enabled: 1, createdAt: '' };

    const lock1 = service.lockPath(p1, 1);
    service.reserve(p1, lock1);

    // p2 also uses codex.lock for slot 1, so p2 must see slot 1 as reserved
    expect(service.isReserved(p2, lock1)).toBe(true);
    expect(service.findFreeSlotSync(p2)).toBe(2);

    fs.rmSync(dir, { recursive: true, force: true });
  });
});
