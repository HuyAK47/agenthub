import React, { useState } from 'react';
import { ChatMessage } from '../../types/api';
import { useLocale } from '../../context/LocaleContext';

export interface ToolStepProps {
  message: ChatMessage;
}

export const ToolStepItem: React.FC<ToolStepProps> = ({ message }) => {
  const { t } = useLocale();
  const text = message.meta?.name || message.meta?.summary || message.content || t('extra.tool');
  return (
    <div key={message.id} className="flex items-center gap-2 text-xs font-mono">
      <span className="text-[var(--t-text-3)]">⚙</span>
      <span className="text-[var(--text-primary)] font-medium">{text}</span>
      {message.meta?.summary && message.meta.name && (
        <span className="text-[var(--text-muted)] text-[11px]">
          - {message.meta.summary}
        </span>
      )}
    </div>
  );
};

export interface ToolStepGroupProps {
  messages: ChatMessage[];
  isRunning?: boolean;
}

export const ToolStep: React.FC<ToolStepGroupProps> = ({ messages, isRunning = false }) => {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);

  if (messages.length === 0) return null;

  const latestMessage = messages[messages.length - 1];

  return (
    <div className="my-2 max-w-xl">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={t('extra.toolUsed', { count: messages.length })}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-surface-hover)] text-[var(--text-secondary)] border border-[var(--border-default)] shadow-xs transition-colors cursor-pointer"
      >
        <span>⚙</span>{' '}
        <span className="font-semibold text-[var(--text-primary)]">
          {t('extra.stepsDone', { count: messages.length })}
        </span>{' '}
        <span>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="mt-2 pl-4 border-l-2 border-[var(--border-default)] space-y-1.5">
          {messages.map((msg) => (
            <ToolStepItem key={msg.id} message={msg} />
          ))}
        </div>
      )}

      {!expanded && isRunning && latestMessage && (
        <div className="mt-2 pl-4 border-l-2 border-[var(--border-default)] space-y-1.5">
          <ToolStepItem message={latestMessage} />
        </div>
      )}
    </div>
  );
};

// Backwards compatibility alias
export const ToolChipsGroup = ToolStep;
