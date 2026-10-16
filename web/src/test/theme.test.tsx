import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider, useTheme } from '../context/ThemeContext';

function TestThemeConsumer() {
  const { mode, effectiveTheme, setMode } = useTheme();
  return (
    <div>
      <div data-testid="theme-mode">{mode}</div>
      <div data-testid="effective-theme">{effectiveTheme}</div>
      <button onClick={() => setMode('light')}>Set Light</button>
      <button onClick={() => setMode('dark')}>Set Dark</button>
      <button onClick={() => setMode('system')}>Set System</button>
    </div>
  );
}

describe('ThemeContext & Dark Theme requirements', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
    vi.restoreAllMocks();
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.className = '';
  });

  it('mặc định là dark theme ở lần đầu mở khi chưa có localStorage', () => {
    render(
      <ThemeProvider>
        <TestThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme-mode').textContent).toBe('dark');
    expect(screen.getByTestId('effective-theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('agenthub_theme')).toBe('dark');
  });

  it('đọc đúng cấu hình đã lưu từ localStorage nếu có', () => {
    localStorage.setItem('agenthub_theme', 'light');

    render(
      <ThemeProvider>
        <TestThemeConsumer />
      </ThemeProvider>
    );

    expect(screen.getByTestId('theme-mode').textContent).toBe('light');
    expect(screen.getByTestId('effective-theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
  });

  it('cho phép chuyển đổi giữa 3 chế độ Tối / Sáng / Theo hệ thống', () => {
    render(
      <ThemeProvider>
        <TestThemeConsumer />
      </ThemeProvider>
    );

    // Chuyển sang Light
    act(() => {
      screen.getByText('Set Light').click();
    });
    expect(screen.getByTestId('theme-mode').textContent).toBe('light');
    expect(screen.getByTestId('effective-theme').textContent).toBe('light');
    expect(document.documentElement.classList.contains('dark')).toBe(false);
    expect(localStorage.getItem('agenthub_theme')).toBe('light');

    // Chuyển sang Dark
    act(() => {
      screen.getByText('Set Dark').click();
    });
    expect(screen.getByTestId('theme-mode').textContent).toBe('dark');
    expect(screen.getByTestId('effective-theme').textContent).toBe('dark');
    expect(document.documentElement.classList.contains('dark')).toBe(true);
    expect(localStorage.getItem('agenthub_theme')).toBe('dark');

    // Chuyển sang System
    act(() => {
      screen.getByText('Set System').click();
    });
    expect(screen.getByTestId('theme-mode').textContent).toBe('system');
    expect(localStorage.getItem('agenthub_theme')).toBe('system');
  });

  it('bọc try/catch an toàn khi localStorage ném lỗi', () => {
    const getItemSpy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('Access denied');
    });
    const setItemSpy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('Quota exceeded');
    });

    // Render không được ném exception
    expect(() => {
      render(
        <ThemeProvider>
          <TestThemeConsumer />
        </ThemeProvider>
      );
    }).not.toThrow();

    // Vẫn mặc định là dark an toàn
    expect(screen.getByTestId('theme-mode').textContent).toBe('dark');

    // Đổi mode cũng không ném exception
    expect(() => {
      act(() => {
        screen.getByText('Set Light').click();
      });
    }).not.toThrow();

    getItemSpy.mockRestore();
    setItemSpy.mockRestore();
  });
});
