import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { parseCodexRateLimits, readCodexRateLimits } from '../src/quota/codex-usage.js';
import { openDatabase, ProfileRepo, QuotaMarkRepo, QuotaUsageRepo } from '../src/db/index.js';
import { QuotaUsageService } from '../src/quota/usage.js';

const line = (primary: number, secondary: number) => JSON.stringify({
  timestamp: '2026-10-20T10:00:00Z',
  type: 'event_msg',
  payload: {
    type: 'token_count',
    info: null,
    rate_limits: {
      limit_id: 'codex',
      primary: { used_percent: primary, window_minutes: 300, resets_at: 2_000_000_000 },
      secondary: { used_percent: secondary, window_minutes: 10080, resets_at: 2_000_500_000 },
      plan_type: 'plus',
    },
  },
});

describe('Codex usage từ session log', () => {
  it('lấy rate_limits cuối cùng trong file', () => {
    const parsed = parseCodexRateLimits(`${line(10, 1)}\n{"type":"other"}\n${line(14, 2)}\n`, 123);
    expect(parsed?.planType).toBe('plus');
    expect(parsed?.windows).toEqual([
      { window: '5h', usedPercent: 14, resetAt: 2_000_000_000 },
      { window: 'week', usedPercent: 2, resetAt: 2_000_500_000 },
    ]);
  });

  it('ghi quota_usage cho hồ sơ codex', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-codex-usage-'));
    const day = path.join(dir, '.codex', 'sessions', '2026', '10', '20');
    fs.mkdirSync(day, { recursive: true });
    fs.writeFileSync(path.join(day, 'rollout-a.jsonl'), `${line(40, 5)}\n`);
    expect(readCodexRateLimits(path.join(dir, '.codex'))?.windows[0].usedPercent).toBe(40);

    const db = openDatabase(path.join(dir, 'hub.db'));
    const profiles = new ProfileRepo(db);
    profiles.upsert({ name: 'codex', engine: 'codex', kind: 'codex', home: dir, email: null, enabled: 1, authState: null, authMessage: null, verifyUrl: null });
    const usage = new QuotaUsageService(profiles, new QuotaUsageRepo(db), new QuotaMarkRepo(db));
    const rows = usage.collectCodex(profiles.get('codex')!, 1_900_000_000);
    expect(rows.map((r) => [r.window, r.remainingPct])).toEqual([['5h', 60], ['week', 95]]);
    expect(usage.getForProfile('codex')).toHaveLength(2);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
