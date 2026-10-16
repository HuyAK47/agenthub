import { describe, expect, it, afterEach } from 'vitest';
import { parseDbTime } from '../src/db/time.js';

describe('parseDbTime', () => {
  const originalTz = process.env.TZ;

  afterEach(() => {
    if (originalTz === undefined) delete process.env.TZ;
    else process.env.TZ = originalTz;
  });

  it('parses SQLite UTC strings, ISO offsets, and numbers under a local timezone', () => {
    process.env.TZ = 'Asia/Ho_Chi_Minh';
    expect(parseDbTime('2026-10-15 08:20:00')).toBe(Date.parse('2026-10-15T08:20:00Z'));
    expect(parseDbTime('2026-10-15T08:20:00+07:00')).toBe(Date.parse('2026-10-15T01:20:00Z'));
    expect(parseDbTime(123456789)).toBe(123456789);
  });
});
