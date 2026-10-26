import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

// jsdom không có canvas → giả lập xterm và FitAddon.
const termInstances: Array<{ onDataCb?: (d: string) => void; keyHandler?: (e: KeyboardEvent) => boolean }> = [];
vi.mock('xterm', () => ({
  Terminal: class {
    cols = 120;
    rows = 30;
    rec: { onDataCb?: (d: string) => void; keyHandler?: (e: KeyboardEvent) => boolean } = {};
    constructor() {
      termInstances.push(this.rec);
    }
    loadAddon() {}
    open() {}
    write() {}
    focus() {}
    dispose() {}
    onData(cb: (d: string) => void) {
      this.rec.onDataCb = cb;
    }
    attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
      this.rec.keyHandler = h;
    }
  },
}));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() {} } }));
vi.mock('xterm/css/xterm.css', () => ({}));
vi.mock('../api/client', () => ({ getToken: () => 'tok' }));

import { LoginTerminal, extractLoginUrl } from '../components/LoginTerminal';

class FakeWS {
  static OPEN = 1;
  static last: FakeWS;
  readyState = 0;
  sent: string[] = [];
  onopen?: () => void;
  onmessage?: (e: { data: string }) => void;
  onclose?: () => void;
  onerror?: () => void;
  constructor(public url: string) {
    FakeWS.last = this;
  }
  send(d: string) {
    this.sent.push(d);
  }
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
}

describe('extractLoginUrl', () => {
  it('lấy URL đầy đủ từ hyperlink OSC 8 của agy mới', () => {
    const url = 'https://accounts.google.com/o/oauth2/auth?client_id=abc&redirect_uri=http%3A%2F%2Flocalhost&state=xyz';
    const raw = `Copy and paste the URL:\r\n \x1b]8;id=jk1;${url}\x07Click here to authenticate\x1b]8;;\x07\r\n`;
    expect(extractLoginUrl(raw)).toBe(url);
  });

  it('ghép URL bị cắt qua nhiều dòng và bỏ mã ANSI', () => {
    const raw =
      '\x1b[1mOpen this URL:\x1b[0m\r\nhttps://accounts.google.com/o/oauth2/auth?client_id=abc\r\n&scope=openid&state=xyz\r\n\r\nEnter the authorization code: ';
    expect(extractLoginUrl(raw)).toBe('https://accounts.google.com/o/oauth2/auth?client_id=abc&scope=openid&state=xyz');
  });
  it('trả null khi chưa có URL', () => {
    expect(extractLoginUrl('Starting…')).toBeNull();
  });
});

describe('LoginTerminal', () => {
  beforeEach(() => {
    termInstances.length = 0;
    vi.stubGlobal('WebSocket', FakeWS as unknown as typeof WebSocket);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  const renderIt = (onClose = vi.fn(), onReconnect?: () => Promise<string>) =>
    render(
      <QueryClientProvider client={new QueryClient()}>
        <LoginTerminal profileName="g3" sessionId="s1" onClose={onClose} onReconnect={onReconnect} />
      </QueryClientProvider>,
    );

  it('ô nhập mã gửi chuỗi kèm \\r vào PTY', () => {
    renderIt();
    act(() => FakeWS.last.open());
    const input = screen.getByTestId('login-code-input');
    fireEvent.change(input, { target: { value: '  4/0AbCdEf  ' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(FakeWS.last.sent).toContain(JSON.stringify({ type: 'input', data: '4/0AbCdEf\r' }));
  });

  it('hiện nút mở link khi output có URL đăng nhập', () => {
    renderIt();
    act(() => FakeWS.last.open());
    act(() => FakeWS.last.onmessage?.({ data: 'Go to https://accounts.google.com/o/oauth2/auth?x=1 \r\n' }));
    const link = screen.getByRole('link', { name: /Mở trang đăng nhập/ });
    expect(link.getAttribute('href')).toBe('https://accounts.google.com/o/oauth2/auth?x=1');
  });

  it('sự kiện paste gửi nội dung clipboard vào PTY', () => {
    renderIt();
    act(() => FakeWS.last.open());
    const area = screen.getByTestId('login-terminal').querySelector('.relative') as HTMLElement;
    fireEvent.paste(area, { clipboardData: { getData: () => 'CODE123' } });
    expect(FakeWS.last.sent).toContain(JSON.stringify({ type: 'input', data: 'CODE123' }));
  });

  it('Ctrl+V không gửi ký tự ^V vào terminal', () => {
    renderIt();
    const handler = termInstances[0].keyHandler!;
    expect(handler({ type: 'keydown', ctrlKey: true, key: 'v' } as KeyboardEvent)).toBe(false);
    expect(handler({ type: 'keydown', ctrlKey: false, key: 'a' } as KeyboardEvent)).toBe(true);
  });

  it('Hoàn tất gửi /exit', () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    renderIt(onClose);
    act(() => FakeWS.last.open());
    fireEvent.click(screen.getByRole('button', { name: 'Hoàn tất' }));
    expect(FakeWS.last.sent).toContain(JSON.stringify({ type: 'input', data: '/exit\r' }));
    act(() => vi.advanceTimersByTime(1000));
    expect(onClose).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it('phím Tab trong terminal gửi \\t vào PTY và không bị trap', () => {
    renderIt();
    act(() => FakeWS.last.open());
    const handler = termInstances[0].keyHandler!;
    const preventDefault = vi.fn();
    const result = handler({ type: 'keydown', key: 'Tab', preventDefault } as unknown as KeyboardEvent);
    expect(result).toBe(false);
    expect(preventDefault).toHaveBeenCalled();
    expect(FakeWS.last.sent).toContain(JSON.stringify({ type: 'input', data: '\t' }));
  });

  it('phím Escape khi focus trong terminal KHÔNG hủy phiên / đóng dialog', () => {
    const onClose = vi.fn();
    renderIt(onClose);
    act(() => FakeWS.last.open());

    const termContainer = screen.getByTestId('login-terminal').querySelector('[data-terminal="true"]') as HTMLElement;
    const fakeTermInput = document.createElement('textarea');
    fakeTermInput.className = 'xterm-helper-textarea';
    termContainer.appendChild(fakeTermInput);
    fakeTermInput.focus();

    fireEvent.keyDown(fakeTermInput, { key: 'Escape' });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('phím Escape khi focus ngoài terminal đóng dialog và gửi hủy phiên', () => {
    const onClose = vi.fn();
    renderIt(onClose);
    act(() => FakeWS.last.open());

    const closeBtn = screen.getByRole('button', { name: /xong & đóng|đóng/i });
    closeBtn.focus();

    fireEvent.keyDown(closeBtn, { key: 'Escape' });
    expect(onClose).toHaveBeenCalled();
    expect(FakeWS.last.sent).toContain(JSON.stringify({ type: 'input', data: '\x03' }));
  });

  it('hiện lỗi reconnect và cho thử lại khi callback thất bại', async () => {
    const onReconnect = vi.fn().mockRejectedValue(new Error('agy không khả dụng'));
    renderIt(vi.fn(), onReconnect);
    act(() => FakeWS.last.onerror?.());
    const button = screen.getByRole('button', { name: 'Kết nối lại' });
    await act(async () => { fireEvent.click(button); });
    expect(onReconnect).toHaveBeenCalledTimes(1);
    expect(screen.getByText('agy không khả dụng')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Kết nối lại' })).toBeInTheDocument();
  });
});
