import { describe, it, expect } from 'vitest';
import { isAgyLoginMenu } from '../src/api/pty.js';

describe('agy login menu', () => {
  it('nhận ra menu chọn cách đăng nhập của agy mới', () => {
    const raw = ' \x1b[1mWelcome to the Antigravity CLI.\x1b[0m\r\n Signing in... Select login method:\r\n > 1. Google OAuth\r\n2. Use a Google Cloud project';
    expect(isAgyLoginMenu(raw)).toBe(true);
  });

  it('không bấm Enter khi chưa có menu', () => {
    expect(isAgyLoginMenu('Welcome to the Antigravity CLI. You are currently not signed in.')).toBe(false);
  });
});
