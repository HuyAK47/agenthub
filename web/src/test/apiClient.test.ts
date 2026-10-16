import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { apiFetch, AuthError, clearToken, setToken } from '../api/client';

describe('API Client', () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    sessionStorage.clear();
  });

  afterEach(() => {
    window.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('gắn header Authorization: Bearer <token> và Content-Type khi gửi request', async () => {
    setToken('valid_agent_token_999');

    let capturedHeaders: Headers | undefined;
    window.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const res = await apiFetch<{ ok: boolean }>('/api/test', {
      method: 'POST',
      body: JSON.stringify({ hello: 'world' }),
    });

    expect(res).toEqual({ ok: true });
    expect(capturedHeaders?.get('Authorization')).toBe('Bearer valid_agent_token_999');
    expect(capturedHeaders?.get('Content-Type')).toBe('application/json');
  });

  it('báo lỗi AuthError ngay lập tức khi thiếu token', async () => {
    clearToken();

    await expect(apiFetch('/api/test')).rejects.toThrow(AuthError);
  });

  it('xử lý 401: xóa token và throw AuthError khi API trả về 401 Unauthorized', async () => {
    setToken('expired_token_123');

    window.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    await expect(apiFetch('/api/protected')).rejects.toThrow(AuthError);
    expect(sessionStorage.getItem('agenthub_token')).toBeNull();
  });
});
