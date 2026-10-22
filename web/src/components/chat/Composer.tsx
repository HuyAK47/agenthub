import React, { useEffect, useRef, useState } from 'react';
import { Send, Square, Sparkles } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

export interface ComposerProps {
  onSend: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  isEmpty: boolean;
  disabled?: boolean;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onCancel,
  busy,
  isEmpty,
  disabled = false,
}) => {
  const { t } = useLocale();
  const quickPrompts = [t('extra.quickPromptTasks'), t('extra.quickPromptQuota'), t('extra.quickPromptSplit')];
  const [text, setText] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea height
  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = 'auto';
    textarea.style.height = `${Math.min(textarea.scrollHeight, 180)}px`;
  }, [text]);

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (busy || disabled) return;
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const handleQuickPromptClick = (prompt: string) => {
    if (busy || disabled) return;
    onSend(prompt);
  };

  return (
    <div data-tour="chat-composer" className="p-4 border-t border-[var(--border-default)] bg-[var(--bg-surface)]">
      {/* Quick Prompts when conversation is empty */}
      {isEmpty && (
        <div className="mb-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] font-medium">
            <Sparkles className="w-3.5 h-3.5 text-[var(--t-warn)]" />
            <span>{t('extra.quickPrompts')}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => handleQuickPromptClick(prompt)}
                disabled={busy || disabled}
                className="px-3 py-1.5 rounded-lg text-xs bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer text-left"
              >
                {prompt}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Input container */}
      <form onSubmit={handleSubmit} className="relative flex items-end gap-2">
        <label htmlFor="chat-message-input" className="sr-only">
          {t('extra.chatPlaceholder')}
        </label>
        <div className="flex-1 relative rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] focus-within:border-[var(--t-accent)] focus-within:ring-2 focus-within:ring-[var(--t-accent)] transition-all">
          <textarea
            id="chat-message-input"
            aria-label={t('extra.chatPlaceholder')}
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            disabled={busy || disabled}
            placeholder={
              busy
                ? t('extra.claudeAnswering')
                : t('extra.chatPlaceholder')
            }
            className="w-full resize-none bg-transparent px-4 py-3 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-hidden max-h-[180px] min-h-[48px] leading-relaxed"
          />
        </div>

        {/* Action button (Send / Stop) */}
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            title={t('extra.stopResponse')}
            aria-label={t('extra.stopResponse')}
            className="h-12 px-4 rounded-xl bg-[var(--t-crit)] hover:bg-[var(--t-crit)]/90 text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer shrink-0"
          >
            <Square className="w-4 h-4 fill-current" />
            <span className="hidden sm:inline">{t('extra.stop')}</span>
          </button>
        ) : (
          <button
            type="submit"
            disabled={disabled || !text.trim()}
            title={t('extra.sendMessage')}
            aria-label={t('extra.sendMessage')}
            className="h-12 px-4 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] disabled:bg-[var(--bg-surface-subtle)] disabled:text-[var(--text-muted)] disabled:border disabled:border-[var(--border-default)] disabled:cursor-not-allowed text-white font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer shrink-0"
          >
            <Send className="w-4 h-4" />
            <span className="hidden sm:inline">{t('common.send')}</span>
          </button>
        )}
      </form>
    </div>
  );
};

// Backwards compatibility alias
export const ChatInput = Composer;
export type ChatInputProps = ComposerProps;
