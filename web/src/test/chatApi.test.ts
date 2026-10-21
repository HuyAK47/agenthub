import { describe, it, expect, afterEach, vi } from 'vitest';
import { setToken } from '../api/client';
import { getChatMessages } from '../api/chat';

describe('getChatMessages', () => {
  const originalFetch = window.fetch;
  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const respond = (body: unknown) => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } }),
    );
  };

  it('đọc dạng phân trang { messages, hasMore }', async () => {
    setToken('t');
    respond({ messages: [{ id: 'm1', role: 'user', content: 'hi' }], hasMore: false });
    expect((await getChatMessages('s1')).map((m) => m.id)).toEqual(['m1']);
  });

  it('vẫn đọc được dạng mảng của server cũ', async () => {
    setToken('t');
    respond([{ id: 'm2', role: 'assistant', content: 'ok' }]);
    expect((await getChatMessages('s1')).map((m) => m.id)).toEqual(['m2']);
  });
});
