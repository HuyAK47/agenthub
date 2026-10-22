import { describe, expect, it } from 'vitest';
import { formatReset, formatExpiry } from '../src/time-format.js';

describe('backend time formatter', () => {
  it('uses Asia/Ho_Chi_Minh and accepts seconds or milliseconds', () => {
    const now = Date.parse('2026-10-15T01:00:00Z');
    const reset = Date.parse('2026-10-15T03:15:00Z');
    expect(formatReset(Math.floor(reset / 1000), now, 'vi')).toContain('10:15 hôm nay');
    expect(formatReset(reset, now, 'vi')).toContain('còn 2 giờ 15 phút');
  });

  it('describes expiry and unknown values without negative durations', () => {
    const now = Date.parse('2026-10-15T01:00:00Z');
    expect(formatExpiry(now - 60_000, now, 'vi')).toContain('đã hết hạn lúc');
    expect(formatReset(undefined, now, 'vi')).toBe('chưa rõ thời điểm reset');
  });
});
