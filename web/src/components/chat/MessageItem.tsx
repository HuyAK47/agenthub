import React, { memo, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatMessage } from '../../types/api';
import { Check, Copy, AlertCircle } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

export interface MessageItemProps {
  message: ChatMessage;
  isStreaming?: boolean;
  onRetry?: () => void;
}

function CodeBlock({ children, className }: { children: any; className?: string }) {
  const { t } = useLocale();
  const [copied, setCopied] = useState(false);
  const codeString = String(children).replace(/\n$/, '');
  const match = /language-(\w+)/.exec(className || '');

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(codeString);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // fallback
    }
  };

  return (
    <div className="relative group my-3 rounded-lg overflow-hidden border border-[var(--border-default)] bg-[var(--t-bg)]">
      {/* Code Header */}
      <div className="flex items-center justify-between px-3 py-1.5 bg-[var(--t-bg)] text-xs text-[var(--t-text-3)] border-b border-[var(--border-default)] font-mono">
        <span>{match ? match[1] : 'code'}</span>
        <button
          type="button"
          onClick={handleCopy}
          aria-label={copied ? t('extra.copied') : t('extra.copy')}
          className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
        >
          {copied ? (
            <>
              <Check className="w-3.5 h-3.5 text-[var(--t-ok)]" />
              <span className="text-[var(--t-ok)]">{t('extra.copied')}</span>
            </>
          ) : (
            <>
              <Copy className="w-3.5 h-3.5" />
              <span>{t('extra.copy')}</span>
            </>
          )}
        </button>
      </div>
      {/* Code Body */}
      <pre className="p-3 text-xs font-mono text-[var(--t-text)] overflow-x-auto leading-relaxed">
        <code>{children}</code>
      </pre>
    </div>
  );
}

function formatDuration(durationMs: number, secondLabel = 'seconds'): string {
  const sec = durationMs / 1000;
  return sec.toLocaleString('vi-VN', { maximumFractionDigits: 1 }) + ` ${secondLabel}`;
}

function formatStats(meta: ChatMessage['meta'] | undefined, secondLabel: string, turnLabel: string): string | null {
  if (!meta || meta.durationMs === undefined) return null;
  const parts: string[] = [];
  parts.push(formatDuration(meta.durationMs, secondLabel));
  if (meta.numTurns !== undefined) {
    parts.push(`${meta.numTurns} ${turnLabel}`);
  }
  return parts.join(' · ');
}

const MessageItemComponent: React.FC<MessageItemProps> = ({
  message,
  isStreaming = false,
  onRetry,
}) => {
  const { t } = useLocale();

  // User message
  if (message.role === 'user') {
    return (
      <div className="flex justify-end my-3">
        <div className="max-w-2xl px-4 py-2.5 rounded-2xl rounded-tr-xs bg-[var(--t-accent)] text-white text-sm shadow-xs whitespace-pre-wrap break-words leading-relaxed">
          {message.content}
        </div>
      </div>
    );
  }

  // System message (e.g. "Đã nén ngữ cảnh")
  if (message.role === 'system') {
    return (
      <div className="flex justify-center my-3" data-testid="system-message">
        <div className="px-3.5 py-1.5 rounded-full bg-[var(--bg-surface-subtle)] border border-[var(--border-default)] text-[var(--text-secondary)] text-xs font-medium shadow-xs text-center">
          {message.content}
        </div>
      </div>
    );
  }

  // Error message (red border)
  if (message.role === 'error') {
    return (
      <div className="flex justify-start my-3">
        <div className="max-w-2xl px-4 py-3 rounded-xl border border-[var(--t-crit)] bg-[var(--t-crit)]/10 text-[var(--t-crit)] text-sm shadow-xs flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-[var(--t-crit)] shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="font-semibold text-xs tracking-wider uppercase">
              {t('extra.error')}
            </div>
            <div className="whitespace-pre-wrap break-words">{message.content}</div>
            {onRetry && (
              <button type="button" onClick={onRetry} className="text-xs underline font-semibold cursor-pointer">
                {t('extra.retry') === 'extra.retry' ? 'Thử lại' : t('extra.retry')}
              </button>
            )}
          </div>
        </div>
      </div>
    );
  }

  // Assistant message
  const statsText = formatStats(message.meta, t('extra.seconds'), t('extra.turns'));

  return (
    <div className="flex gap-3 my-3">
      {/* Claude Avatar */}
      <div
        className="w-7 h-7 rounded-full flex items-center justify-center text-white font-bold text-xs shrink-0 shadow-xs mt-0.5"
        style={{ backgroundColor: 'var(--t-claude)' }}
      >
        C
      </div>

      {/* Message Content */}
      <div
        className="flex-1 min-w-0 space-y-2"
        aria-live={isStreaming ? 'polite' : undefined}
      >
        <div className="text-sm text-[var(--text-primary)] leading-relaxed space-y-2 markdown-body overflow-hidden break-words">
          <ReactMarkdown
            remarkPlugins={[remarkGfm]}
            components={{
              code({ node, inline, className, children, ...props }: any) {
                if (inline) {
                  return (
                    <code
                      className="px-1.5 py-0.5 rounded bg-[var(--bg-surface-subtle)] text-[var(--text-primary)] font-mono text-xs border border-[var(--border-subtle)]"
                      {...props}
                    >
                      {children}
                    </code>
                  );
                }
                return <CodeBlock className={className}>{children}</CodeBlock>;
              },
            }}
          >
            {message.content}
          </ReactMarkdown>
          {isStreaming && (
            <span className="inline-block w-2 h-4 bg-[var(--t-accent)] animate-pulse align-middle ml-1" />
          )}
        </div>

        {/* Turn stats (duration, turns) */}
        {statsText && (
          <div className="text-[11px] text-[var(--text-secondary)] font-mono">
            {statsText}
          </div>
        )}
      </div>
    </div>
  );
};

export const MessageItem = memo(MessageItemComponent);

// Backwards compatibility alias
export const ChatMessageItem = MessageItem;
export type ChatMessageItemProps = MessageItemProps;
