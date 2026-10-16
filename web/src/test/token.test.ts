import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  clearToken,
  getToken,
  initTokenFromHash,
  setToken,
  subscribeUnauthorized,
} from '../api/client';

describe('Token Handling', () => {
  beforeEach(() => {
    sessionStorage.clear();
    window.location.hash = '';
  });

  it('đọc token từ hash, lưu vào sessionStorage và trả về token', () => {
    window.location.hash = '#token=secret_token_12345';
    const token = initTokenFromHash();

    expect(token).toBe('secret_token_12345');
    expect(sessionStorage.getItem('agenthub_token')).toBe('secret_token_12345');
  });

  it('xóa hash khỏi URL bằng history.replaceState sau khi đọc', () => {
    window.location.hash = '#token=clean_me_token';
    const replaceStateSpy = vi.spyOn(window.history, 'replaceState');

    initTokenFromHash();

    expect(replaceStateSpy).toHaveBeenCalled();
  });

  it('getToken trả về token đã lưu hoặc null nếu chưa có', () => {
    expect(getToken()).toBeNull();
    setToken('custom_token_abc');
    expect(getToken()).toBe('custom_token_abc');
  });

  it('clearToken xóa token khỏi sessionStorage và kích hoạt unauthorized listener', () => {
    setToken('test_token_xyz');
    let notified = false;
    const unsubscribe = subscribeUnauthorized(() => {
      notified = true;
    });

    clearToken();

    expect(getToken()).toBeNull();
    expect(notified).toBe(true);
    unsubscribe();
  });
});
