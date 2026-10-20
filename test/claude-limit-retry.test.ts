import { afterEach, describe, expect, it, vi } from 'vitest';
import { openDatabase, ChatRetryRepo } from '../src/db/index.js';
import { detectClaudeQuota, parseStreamJsonLine } from '../src/chat/parse.js';

const dbs: ReturnType<typeof openDatabase>[] = [];
afterEach(() => { for (const db of dbs.splice(0)) db.close(); });

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

  it('returns a durable retry to pending after an in-flight attempt is limited again', () => {
    vi.useFakeTimers();
    const db = openDatabase(':memory:'); dbs.push(db);
    db.prepare("INSERT INTO chat_sessions (id,title,model) VALUES ('s','Session','sonnet')").run();
    const repo = new ChatRetryRepo(db);
    repo.insert({ sessionId: 's', messageId: 'm', text: 'continue', resetAt: 100 });
    repo.markSent('m');
    repo.defer('m', 200);
    expect(repo.getPending()).toMatchObject([{ messageId: 'm', attempts: 1, status: 'pending', resetAt: 200 }]);
    vi.useRealTimers();
  });
});
