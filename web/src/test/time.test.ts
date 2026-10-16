import { describe, expect, it } from 'vitest';
import { formatTimeAgo, parseApiTime } from '../lib/time';

describe('API time helpers', () => {
  it('treats legacy SQLite timestamps as UTC', () => {
    expect(parseApiTime('2026-10-15 08:20:00')).toBe(Date.parse('2026-10-15T08:20:00Z'));
  });

  it('formats legacy timestamps as relative time', () => {
    const now = Date.parse('2026-10-15T08:21:00Z');
    expect(formatTimeAgo('2026-10-15 08:20:00', now)).toBe('1 phút trước');
  });
});
