import { describe, expect, it } from 'vitest';
import { formatReset, formatTimeAgo, parseApiTime } from '../lib/time';

describe('API time helpers', () => {
  it('treats legacy SQLite timestamps as UTC', () => {
    expect(parseApiTime('2026-10-15 08:20:00')).toBe(Date.parse('2026-10-15T08:20:00Z'));
  });

  it('formats legacy timestamps as relative time', () => {
    const now = Date.parse('2026-10-15T08:21:00Z');
    expect(formatTimeAgo('2026-10-15 08:20:00', now)).toBe('1 phút trước');
  });

  it('handles invalid timestamps in formatTimeAgo with localized fallback', () => {
    const now = Date.parse('2026-10-15T08:21:00Z');
    expect(formatTimeAgo(NaN, now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo(NaN, now, 'en')).toBe('time unknown');
    expect(formatTimeAgo('invalid date', now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo('invalid date', now, 'en')).toBe('time unknown');
    expect(formatTimeAgo('', now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo('', now, 'en')).toBe('time unknown');
    expect(formatTimeAgo(null as any, now, 'vi')).toBe('chưa rõ thời gian');
    expect(formatTimeAgo(null as any, now, 'en')).toBe('time unknown');
  });

  it('formats reset with an absolute Vietnam time for seconds and milliseconds', () => {
    const now = Date.parse('2026-10-15T01:00:00Z');
    const reset = Date.parse('2026-10-15T03:15:00Z');
    expect(formatReset(Math.floor(reset / 1000), now, 'vi')).toContain('còn 2 giờ 15 phút');
    expect(formatReset(reset, now, 'vi')).toContain('10:15 hôm nay');
  });

  it('handles tomorrow, week resets, expired and missing values', () => {
    const now = Date.parse('2026-10-15T16:00:00Z');
    expect(formatReset(Date.parse('2026-10-15T18:10:00Z'), now, 'vi')).toContain('01:10 ngày mai');
    expect(formatReset(Date.parse('2026-10-19T01:00:00Z'), now, 'vi')).toContain('Thứ Hai');
    expect(formatReset(now - 1000, now, 'vi')).toContain('đã reset lúc');
    expect(formatReset(null, now, 'vi')).toBe('chưa rõ thời điểm reset');
  });
});
