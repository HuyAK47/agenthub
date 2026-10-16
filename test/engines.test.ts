import { describe, it, expect } from 'vitest';
import { parseResetTime, lastNLines, AgyEngine, CodexEngine } from '../src/engines/index.js';
import { getModelFamily, getModelEngine } from '../src/quota/index.js';

describe('parseResetTime', () => {
  it('parses "Resets in 4h54m26s" to seconds + 60s buffer', () => {
    const result = parseResetTime('Resets in 4h54m26s');
    // 4*3600 + 54*60 + 26 = 14400 + 3240 + 26 = 17666 + 60 = 17726
    expect(result).toBe(17726);
  });

  it('parses "try again in 2h 3m" to seconds + 60s buffer', () => {
    const result = parseResetTime('try again in 2h 3m');
    // 2*3600 + 3*60 = 7200 + 180 = 7380 + 60 = 7440
    expect(result).toBe(7440);
  });

  it('parses "Resets in 1h2m3s" to seconds + 60s buffer', () => {
    const result = parseResetTime('Resets in 1h2m3s');
    // 1*3600 + 2*60 + 3 = 3600 + 120 + 3 = 3723 + 60 = 3783
    expect(result).toBe(3783);
  });

  it('returns 18000 when no time info found', () => {
    const result = parseResetTime('some random text');
    expect(result).toBe(18000);
  });
});

describe('getModelFamily', () => {
  it('claude-opus-4-6-thinking → claude', () => {
    expect(getModelFamily('claude-opus-4-6-thinking')).toBe('claude');
  });

  it('gemini-3.8-flash-high → gemini', () => {
    expect(getModelFamily('gemini-3.8-flash-high')).toBe('gemini');
  });

  it('codex:gpt-5.6-luna → codex', () => {
    expect(getModelFamily('codex:gpt-5.6-luna')).toBe('codex');
  });

  it('gpt-oss-120b-medium → gpt', () => {
    expect(getModelFamily('gpt-oss-120b-medium')).toBe('gpt');
  });
});

describe('getModelEngine', () => {
  it('codex: models → codex engine', () => {
    expect(getModelEngine('codex:gpt-5.6-luna')).toBe('codex');
  });

  it('non-codex models → agy engine', () => {
    expect(getModelEngine('claude-opus-4-6-thinking')).toBe('agy');
    expect(getModelEngine('gemini-3.8-flash-high')).toBe('agy');
  });
});

describe('detectQuota', () => {
  const agy = new AgyEngine('/nonexistent');
  const codex = new CodexEngine('/nonexistent');

  it('detects RESOURCE_EXHAUSTED in last 8 lines', () => {
    const log = [
      'line 1',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'AGY_ERROR: {"short_error":"RESOURCE_EXHAUSTED (code 429): Individual quota reached. Resets in 4h54m26s."}',
    ].join('\n');

    const result = agy.detectQuota(log);
    expect(result.exhausted).toBe(true);
    expect(result.resetSeconds).toBe(17726);
  });

  it('ignores "429" that appears earlier in the log (not in last 8 lines)', () => {
    // Build a log where "429" appears at the start but not in the last 8 lines
    const lines = [
      '429 error in some test code at line 5',
      'line 2',
      'line 3',
      'line 4',
      'line 5',
      'line 6',
      'line 7',
      'line 8',
      'line 9',
      'line 10',
      'line 11',
      'completed successfully',
    ];
    const log = lines.join('\n');

    const result = agy.detectQuota(log);
    expect(result.exhausted).toBe(false);
  });

  it('detects codex quota pattern', () => {
    const log = 'some output\nusage limit exceeded, try again in 2h 3m\n';
    const result = codex.detectQuota(log);
    expect(result.exhausted).toBe(true);
    expect(result.resetSeconds).toBe(7440);
  });
});

describe('detectAuthError', () => {
  it('detects agy authentication failures in the last 8 lines', () => {
    const agy = new AgyEngine('/nonexistent');
    expect(agy.detectAuthError('error: UNAUTHENTICATED (code 401)')).toEqual({ expired: true });
    expect(agy.detectAuthError('old error: code 401\n' + Array.from({ length: 8 }, (_, i) => `line ${i}`).join('\n'))).toEqual({ expired: false });
    expect(agy.detectAuthError('AGY_ERROR: {"error_code":401}')).toEqual({ expired: true });
  });
});

describe('lastNLines', () => {
  it('returns last N lines of a string', () => {
    const text = 'a\nb\nc\nd\ne';
    expect(lastNLines(text, 3)).toBe('c\nd\ne');
  });

  it('returns all lines if fewer than N', () => {
    expect(lastNLines('a\nb', 5)).toBe('a\nb');
  });
});
