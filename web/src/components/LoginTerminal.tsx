import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Terminal as XTerm } from 'xterm';
import { FitAddon } from '@xterm/addon-fit';
import 'xterm/css/xterm.css';
import { getToken } from '../api/client';
import { useOptionalTheme } from '../context/ThemeContext';
import { AlertTriangle, Copy, ExternalLink, Send, Terminal, X } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { useFocusTrap } from './ui/useFocusTrap';

interface LoginTerminalProps {
  profileName: string;
  sessionId: string;
  onClose: () => void;
}

type ConnState = 'connecting' | 'open' | 'closed' | 'error';

export function getTerminalTheme(effectiveTheme: 'light' | 'dark') {
  return effectiveTheme === 'dark'
    ? { background: '#1a1c23', foreground: '#dcdfe8', cursor: '#4d94ff', selectionBackground: '#001f4d' }
    : { background: '#ffffff', foreground: '#21232c', cursor: '#0066ff', selectionBackground: '#e0edff' };
}

// Strip ANSI/OSC sequences before extracting a URL from agy output.
// eslint-disable-next-line no-control-regex -- strips terminal escape sequences
const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g;

/**
 * Find the longest login URL in output. Narrow terminals can wrap a URL,
 * so join adjacent lines before matching.
 */
export function extractLoginUrl(raw: string): string | null {
  // Terminal hyperlinks (OSC 8) carry the full URL even when the visible text is short.
  // eslint-disable-next-line no-control-regex -- matches OSC 8 escape sequences
  const osc = [...raw.matchAll(/\x1b\]8;[^;\x07\x1b]*;(https:\/\/[^\x07\x1b]+)(?:\x07|\x1b\\)/g)].map((m) => m[1]);
  if (osc.length > 0) return osc.sort((a, b) => b.length - a.length)[0];
  const text = raw.replace(ANSI_RE, '').replace(/\r/g, '');
  const joined = text.replace(/\n(?=[^\s])/g, '');
  const urls = joined.match(/https:\/\/[^\s"'<>]+/g);
  if (!urls) return null;
  return urls.sort((a, b) => b.length - a.length)[0];
}

export const LoginTerminal: React.FC<LoginTerminalProps> = ({ profileName, sessionId, onClose }) => {
  const { t } = useLocale();
  const themeContext = useOptionalTheme();
  const effectiveTheme = themeContext?.effectiveTheme ?? (document.documentElement.classList.contains('dark') ? 'dark' : 'light');
  const themeRef = useRef(effectiveTheme);
  const queryClient = useQueryClient();
  const termRef = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const termObj = useRef<XTerm | null>(null);
  const outputRef = useRef('');
  const [conn, setConn] = useState<ConnState>('connecting');
  const [loginUrl, setLoginUrl] = useState<string | null>(null);
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const sendInput = useCallback((data: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'input', data }));
      return true;
    }
    return false;
  }, []);

  useEffect(() => {
    if (!termRef.current) return;
    const term = new XTerm({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: "'JetBrains Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      scrollback: 5000,
      theme: {
        ...getTerminalTheme(themeRef.current),
      },
    });
    termObj.current = term;
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(termRef.current);

    const token = getToken() || '';
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(
      `${protocol}//${window.location.host}/api/pty/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
    );
    wsRef.current = ws;
    setConn('connecting');

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
      }
    };
    // Fit after layout and whenever the container size changes.
    const fit = () => {
      try {
        fitAddon.fit();
        sendResize();
      } catch {
        /* container has no size yet */
      }
    };
    const raf = requestAnimationFrame(fit);
    const ro = new ResizeObserver(() => fit());
    ro.observe(termRef.current);

    ws.onopen = () => {
      setConn('open');
      fit();
      term.focus();
    };
    ws.onmessage = (event) => {
      const data = typeof event.data === 'string' ? event.data : '';
      term.write(data);
      outputRef.current = (outputRef.current + data).slice(-20000);
      const url = extractLoginUrl(outputRef.current);
      if (url) setLoginUrl(url);
    };
    ws.onclose = () => {
      setConn((c) => (c === 'error' ? c : 'closed'));
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    };
    ws.onerror = () => setConn('error');

    term.onData((data) => sendInput(data));

    // Ctrl+V / Ctrl+Shift+V: paste from the clipboard instead of sending ^V.
    // Tab: send \t into the terminal session instead of moving browser focus.
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === 'keydown' && e.ctrlKey && (e.key === 'v' || e.key === 'V')) {
        navigator.clipboard
          ?.readText()
          .then((t) => t && sendInput(t))
          .catch(() => {
            /* browser blocked clipboard access; let the paste event handle it */
          });
        return false;
      }
      if (e.type === 'keydown' && e.key === 'Tab') {
        e.preventDefault();
        sendInput('\t');
        return false;
      }
      return true;
    });

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      ws.close();
      term.dispose();
      termObj.current = null;
      wsRef.current = null;
    };
  }, [sessionId, queryClient, sendInput, attempt]);

  useEffect(() => {
    themeRef.current = effectiveTheme;
    const term = termObj.current;
    if (term?.options) term.options.theme = getTerminalTheme(effectiveTheme);
  }, [effectiveTheme]);

  // Paste event fallback for context-menu paste and unavailable Clipboard API.
  const onPaste = (e: React.ClipboardEvent) => {
    const t = e.clipboardData.getData('text');
    if (t) {
      e.preventDefault();
      sendInput(t);
    }
  };

  const submitCode = () => {
    const v = code.trim();
    if (!v) return;
    if (sendInput(v + '\r')) setCode('');
  };

  const finish = () => {
    sendInput('/exit\r');
    setTimeout(() => {
      wsRef.current?.close();
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
      onClose();
    }, 800);
  };

  const cancel = () => {
    sendInput('\x03');
    wsRef.current?.close();
    onClose();
  };

  const copyUrl = async () => {
    if (!loginUrl) return;
    try {
      await navigator.clipboard.writeText(loginUrl);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore clipboard failures */
    }
  };

  const containerRef = useFocusTrap<HTMLDivElement>({
    isOpen: true,
    onClose: cancel,
    autoFocus: false,
    ignoreSelector: '.xterm, .xterm-helper-textarea, [data-terminal]',
    shouldIgnoreEvent: (e) => {
      const target = e.target as HTMLElement | null;
      const active = document.activeElement as HTMLElement | null;
      if (termRef.current) {
        if (target && termRef.current.contains(target)) return true;
        if (active && termRef.current.contains(active)) return true;
      }
      return false;
    },
  });

  const connLabel: Record<ConnState, string> = {
    connecting: t('profiles.connectingTerminal'), open: t('profiles.connectedTerminal'), closed: t('profiles.sessionEnded'), error: t('profiles.wsError'),
  };
  const connColor: Record<ConnState, string> = {
    connecting: 'bg-[var(--t-warn)]',
    open: 'bg-[var(--t-ok)]',
    closed: 'bg-[var(--t-text-3)]',
    error: 'bg-[var(--t-crit)]',
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="login-terminal-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3"
      data-testid="login-terminal"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="flex h-[88vh] w-[94vw] max-w-[1200px] flex-col overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] text-[var(--t-text)] shadow-2xl outline-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[var(--t-border)] px-5 py-3">
          <div className="flex items-center gap-2.5">
            <Terminal className="h-5 w-5 text-[var(--t-accent)]" />
            <h2 id="login-terminal-title" className="text-base font-semibold">{t('extra.loginTitle', { name: profileName })}</h2>
            <span className="ml-2 flex items-center gap-1.5 text-xs text-[var(--t-text-3)]">
              <span className={`inline-block h-2 w-2 rounded-full ${connColor[conn]}`} />
              {connLabel[conn]}
            </span>
          </div>
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg p-1.5 text-[var(--t-text-3)] hover:bg-[var(--t-hover)] hover:text-[var(--t-text)] cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
            aria-label={t('profiles.doneAndClose')}
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* Instructions */}
        <div className="grid gap-x-6 gap-y-1 border-b border-[var(--t-border)] bg-[var(--t-warn)]/10 px-5 py-3 text-sm sm:grid-cols-2 text-[var(--t-text)]">
          <div><b>1.</b> <b>{t('extra.loginOpen')}</b>.</div>
          <div className="flex items-start gap-1.5">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-[var(--t-warn)]" />
            <span><b>2.</b> {t('profiles.terminalNoticeBody', { otherAccount: t('profiles.otherAccountBtnText') })}</span>
          </div>
          <div><b>3.</b> {t('extra.pasteCode')}.</div>
          <div><b>4.</b> {t('extra.finish')}.</div>
        </div>

        {/* Login link */}
        <div className="flex items-center gap-2 border-b border-[var(--t-border)] px-5 py-2.5">
          {loginUrl ? (
            <>
              <a
                href={loginUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--t-accent)] px-3 py-1.5 text-sm font-medium text-white hover:bg-[var(--t-accent-hover)] transition-colors"
              >
                <ExternalLink className="h-4 w-4" /> {t('extra.loginOpen')}
              </a>
              <button
                type="button"
                onClick={copyUrl}
                aria-label={copied ? t('extra.copied') : t('extra.copy')}
                className="inline-flex items-center gap-1.5 rounded-lg border border-[var(--t-border)] px-3 py-1.5 text-sm hover:bg-[var(--t-hover)] cursor-pointer transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
              >
                <Copy className="h-4 w-4" /> {copied ? t('extra.copied') : t('extra.copy')}
              </button>
              <span className="truncate font-mono text-xs text-[var(--t-text-3)]" title={loginUrl}>
                {loginUrl}
              </span>
            </>
          ) : (
            <span className="text-sm text-[var(--t-text-3)]">{t('extra.loginWaiting')}</span>
          )}
        </div>

        {/* Terminal with a fixed-size container for xterm fitting */}
        <div className="relative min-h-0 flex-1 bg-[var(--t-bg)]" onPaste={onPaste} onClick={() => termObj.current?.focus()}>
          <div ref={termRef} data-terminal="true" className="absolute inset-0 p-3" />
        </div>

        {/* Verification code field */}
        <div className="flex items-center gap-2 border-t border-[var(--t-border)] px-5 py-3">
          <input
            value={code}
            onChange={(e) => setCode(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submitCode();
              }
            }}
            placeholder={t('extra.pasteCode')}
            className="min-w-0 flex-1 rounded-lg border border-[var(--t-border)] bg-[var(--t-bg)] px-3 py-2 font-mono text-sm text-[var(--t-text)] outline-hidden focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)]"
            data-testid="login-code-input"
            disabled={conn !== 'open'}
          />
          <button
            type="button"
            onClick={submitCode}
            disabled={conn !== 'open' || !code.trim()}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[var(--t-accent)] px-4 py-2 text-sm font-medium text-white hover:bg-[var(--t-accent-hover)] disabled:opacity-40 cursor-pointer transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
          >
            <Send className="h-4 w-4" /> {t('extra.send')}
          </button>
          <div className="mx-1 h-6 w-px bg-[var(--t-border)]" />
          {conn === 'error' || conn === 'closed' ? (
            <button
              type="button"
              onClick={() => setAttempt((a) => a + 1)}
              className="rounded-lg border border-[var(--t-border)] px-3 py-2 text-sm hover:bg-[var(--t-hover)] cursor-pointer transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
            >
              {t('extra.reconnect')}
            </button>
          ) : null}
          <button
            type="button"
            onClick={finish}
            className="rounded-lg bg-[var(--t-ok)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 cursor-pointer transition-opacity focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
          >
            {t('extra.finish')}
          </button>
          <button
            type="button"
            onClick={cancel}
            className="rounded-lg border border-[var(--t-border)] px-3 py-2 text-sm hover:bg-[var(--t-hover)] cursor-pointer transition-colors focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
          >
            {t('common.cancel')}
          </button>
        </div>
      </div>
    </div>
  );
};
