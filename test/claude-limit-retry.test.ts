import { describe, expect, it } from 'vitest';
import { detectClaudeQuota, parseStreamJsonLine } from '../src/chat/parse.js';

describe('Claude limit retry signals', () => {
  it('parses rejected rate_limit_info with its reset timestamp', () => {
    expect(parseStreamJsonLine(JSON.stringify({ type: 'rate_limit_info', rate_limit_info: { status: 'rejected', resetsAt: 1_900_000_000 } }))).toEqual([
      { type: 'rate_limit_info', status: 'rejected', resetsAt: 1_900_000_000 },
    ]);
  });

  it('extracts the reset delay and safety minute from usage-limit text', () => {
    expect(detectClaudeQuota({ streamText: 'Usage limit reached. Resets in 1h 2m' })).toEqual({ exhausted: true, resetSeconds: 3780 });
    expect(detectClaudeQuota({ streamText: 'network timeout' })).toEqual({ exhausted: false });
  });
});
