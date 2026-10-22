import React, { useEffect, useRef, useState } from 'react';
import { AtSign, Send, Square, Sparkles } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

export interface ComposerProps {
  onSend: (text: string) => void;
  onCancel: () => void;
  busy: boolean;
  isEmpty: boolean;
  disabled?: boolean;
  sessionKey?: string;
  editText?: string | null;
}

export const Composer: React.FC<ComposerProps> = ({
  onSend,
  onCancel,
  busy,
  isEmpty,
  disabled = false,
  sessionKey = 'new',
  editText,
}) => {
  const { t } = useLocale();
  const quickPrompts = [t('extra.quickPromptTasks'), t('extra.quickPromptQuota'), t('extra.quickPromptSplit')];
  const [text, setText] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [history, setHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const draftKey = `agenthub_chat_draft_${sessionKey}`;

  useEffect(() => {
    try { setText(localStorage.getItem(draftKey) || ''); } catch { setText(''); }
    try {
      const saved = JSON.parse(localStorage.getItem(`agenthub_chat_history_${sessionKey}`) || '[]');
      setHistory(Array.isArray(saved) ? saved : []);
    } catch { setHistory([]); }
  }, [draftKey, sessionKey]);

  useEffect(() => {
    if (editText !== undefined && editText !== null) {
      setText(editText);
      textareaRef.current?.focus();
    }
  }, [editText]);

  useEffect(() => {
    try {
      if (text) localStorage.setItem(draftKey, text);
      else localStorage.removeItem(draftKey);
    } catch { /* Storage is optional. */ }
  }, [draftKey, text]);

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
    const nextHistory = [trimmed, ...history.filter((item) => item !== trimmed)].slice(0, 30);
    setHistory(nextHistory);
    try { localStorage.setItem(`agenthub_chat_history_${sessionKey}`, JSON.stringify(nextHistory)); } catch { /* optional */ }
    setText('');
    setShowSuggestions(false);
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'ArrowUp' && !text.includes('\n') && history.length > 0) {
      e.preventDefault();
      const next = Math.min(historyIndex + 1, history.length - 1);
      setHistoryIndex(next);
      setText(history[next]);
      return;
    }
    if (e.key === 'ArrowDown' && historyIndex >= 0) {
      e.preventDefault();
      const next = historyIndex - 1;
      setHistoryIndex(next);
      setText(next < 0 ? '' : history[next]);
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const suggestions = text.startsWith('/')
    ? ['/newtask', '/plan', '/status', '/tasks', '/brain', '/directives'].filter((item) => item.startsWith(text.split(/\s/)[0]))
    : text.startsWith('@') ? ['@task/', '@project/', '@file/'] : [];

  const insertSuggestion = (value: string) => {
    setText(value + (value.endsWith('/') ? '' : ' '));
    setShowSuggestions(false);
    textareaRef.current?.focus();
  };

  const handleQuickPromptClick = (prompt: string) => {
    if (busy || disabled) return;
    onSend(prompt);
  };

  return (
    <div data-tour="chat-composer" className="p-4 border-t border-[var(--t-border)] bg-[var(--t-surface)]">
      {/* Quick Prompts when conversation is empty */}
      {isEmpty && (
        <div className="mb-3 space-y-1.5">
          <div className="flex items-center gap-1.5 text-xs text-[var(--t-text-2)] font-medium">
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
                className="px-3 py-1.5 rounded-lg text-xs bg-[var(--t-surface-2)] hover:bg-[var(--t-hover)] border border-[var(--t-border)] text-[var(--t-text-2)] hover:text-[var(--t-text)] transition-colors cursor-pointer text-left"
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
        <div className="flex-1 relative rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] focus-within:border-[var(--t-accent)] focus-within:ring-2 focus-within:ring-[var(--t-accent)] transition-all">
          <textarea
            id="chat-message-input"
            aria-label={t('extra.chatPlaceholder')}
            ref={textareaRef}
            rows={1}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onFocus={() => setShowSuggestions(text.startsWith('/') || text.startsWith('@'))}
            onBlur={() => setTimeout(() => setShowSuggestions(false), 120)}
            onKeyDown={handleKeyDown}
            disabled={busy || disabled}
            placeholder={
              busy
                ? t('extra.claudeAnswering')
                : t('extra.chatPlaceholder')
            }
            className="w-full resize-none bg-transparent px-4 py-3 text-sm text-[var(--t-text)] placeholder-[var(--t-text-3)] focus:outline-hidden max-h-[180px] min-h-[48px] leading-relaxed"
          />
          {showSuggestions && suggestions.length > 0 && (
            <div role="listbox" aria-label="Chat suggestions" className="absolute bottom-full left-0 right-0 mb-2 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-1.5 shadow-xl">
              {suggestions.map((suggestion) => (
                <button key={suggestion} type="button" role="option" onMouseDown={(event) => event.preventDefault()} onClick={() => insertSuggestion(suggestion)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-xs text-[var(--t-text)] hover:bg-[var(--t-surface-2)]">
                  {suggestion.startsWith('@') ? <AtSign className="w-3.5 h-3.5 text-[var(--t-accent)]" /> : <span className="font-mono text-[var(--t-accent)]">/</span>}
                  {suggestion}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Action button (Send / Stop) */}
        {busy ? (
          <button
            type="button"
            onClick={onCancel}
            title={t('extra.stopResponse')}
            aria-label={t('extra.stopResponse')}
            className="h-12 px-4 rounded-xl bg-[var(--t-crit)] hover:bg-[var(--t-crit)]/90 text-[var(--t-on-accent)] font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer shrink-0"
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
            className="h-12 px-4 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] disabled:bg-[var(--t-surface-2)] disabled:text-[var(--t-text-3)] disabled:border disabled:border-[var(--t-border)] disabled:cursor-not-allowed text-[var(--t-on-accent)] font-semibold text-xs flex items-center justify-center gap-1.5 shadow-xs transition-colors cursor-pointer shrink-0"
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
