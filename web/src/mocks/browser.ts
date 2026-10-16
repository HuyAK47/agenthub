import { setupWorker } from 'msw/browser';
import { handlers } from './handlers';

export const worker =
  typeof window !== 'undefined' && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
    ? setupWorker(...handlers)
    : null;

/**
 * Determines whether mock mode should be activated.
 * Contract: Mock mode is ONLY allowed when import.meta.env.DEV or when built with VITE_MOCK=1.
 * Query param ?mock=1 is strictly ignored on official production builds.
 */
export function isMockEnabled(): boolean {
  if (import.meta.env.VITE_MOCK === '1') {
    return true;
  }
  if (import.meta.env.DEV) {
    if (typeof window !== 'undefined') {
      const param = new URLSearchParams(window.location.search).get('mock');
      if (param === '0') return false;
    }
    return true;
  }
  return false;
}

/**
 * Initializes mock environment if enabled via VITE_MOCK env var or DEV mode.
 */
export async function setupMocks(): Promise<void> {
  const isMock = isMockEnabled();

  if (!isMock) return;

  // Set default dev token in mock mode if none exists
  if (typeof window !== 'undefined' && !sessionStorage.getItem('agenthub_token')) {
    sessionStorage.setItem('agenthub_token', 'mock_token_dev_1234567890abcdef');
  }

  if (worker) {
    void worker.start({
      serviceWorker: { url: '/mockServiceWorker.js' },
      onUnhandledRequest: 'bypass',
    });
  }

  // Mock WebSocket for /api/pty in mock mode
  setupMockWebSocket();
}

function setupMockWebSocket() {
  const OriginalWebSocket = window.WebSocket;

  window.WebSocket = class MockWebSocket extends EventTarget {
    url: string;
    readyState: number = WebSocket.CONNECTING;
    onopen: ((event: Event) => void) | null = null;
    onmessage: ((event: MessageEvent) => void) | null = null;
    onclose: ((event: CloseEvent) => void) | null = null;
    onerror: ((event: Event) => void) | null = null;

    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;

    constructor(url: string | URL, protocols?: string | string[]) {
      super();
      const urlStr = url.toString();
      this.url = urlStr;

      // If it's not our pty URL, fallback to real WebSocket if possible
      if (!urlStr.includes('/api/pty/')) {
        return new OriginalWebSocket(url, protocols) as any;
      }

      setTimeout(() => {
        this.readyState = WebSocket.OPEN;
        const openEvent = new Event('open');
        this.onopen?.(openEvent);
        this.dispatchEvent(openEvent);

        // Send simulated login banner
        this.emitMessage(
          '\r\n\x1b[1;36m=== Google Antigravity Isolated Login ===\x1b[0m\r\n' +
            'Vui lòng mở URL sau trên trình duyệt:\r\n' +
            '\x1b[34mhttps://accounts.google.com/o/oauth2/auth?client_id=...&response_type=code\x1b[0m\r\n\r\n' +
            '\x1b[1;33m[CHÚ Ý]: Trên trang Google, hãy bấm "Sử dụng tài khoản khác" để không trùng tài khoản.\x1b[0m\r\n\r\n' +
            'Nhấn phím bất kỳ sau khi đã xác thực xong trên trình duyệt...\r\n',
        );
      }, 300);
    }

    send(data: string | ArrayBufferLike | Blob | ArrayBufferView) {
      if (typeof data === 'string') {
        try {
          const parsed = JSON.parse(data);
          if (parsed.type === 'input') {
            setTimeout(() => {
              this.emitMessage('\r\n\x1b[32m✔ Đăng nhập thành công!\x1b[0m\r\nEmail liên kết: \x1b[1mnew.account@gmail.com\x1b[0m\r\nPhiên kết thúc.\r\n');
              setTimeout(() => {
                this.close();
              }, 1200);
            }, 500);
          }
        } catch {
          // ignore
        }
      }
    }

    close(code?: number, reason?: string) {
      this.readyState = WebSocket.CLOSED;
      const closeEvent = new CloseEvent('close', { code: code || 1000, reason: reason || 'Normal Closure' });
      this.onclose?.(closeEvent);
      this.dispatchEvent(closeEvent);
    }

    private emitMessage(text: string) {
      const msgEvent = new MessageEvent('message', { data: text });
      this.onmessage?.(msgEvent);
      this.dispatchEvent(msgEvent);
    }
  } as any;
}
