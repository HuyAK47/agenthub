import React, { useState } from 'react';
import { Check, CircleAlert, ChevronDown, ChevronRight, FileEdit, FileText, Hammer, Loader2, Search, Terminal, Wrench } from 'lucide-react';
import { ChatMessage } from '../../types/api';
import { useLocale } from '../../context/LocaleContext';
import { formatToolDuration, getToolKind, summarizeTool, ToolKind } from './chatPresentation';

export interface ToolStepProps { message: ChatMessage; }

const ICONS: Record<ToolKind, React.FC<{ className?: string }>> = {
  read: FileText, search: Search, bash: Terminal, edit: FileEdit, hub: Hammer, other: Wrench,
};

function statusIcon(message: ChatMessage, isRunning: boolean) {
  if (message.meta?.status === 'error') return <CircleAlert className="w-3.5 h-3.5 text-[var(--t-crit)]" />;
  if (isRunning || message.meta?.status === 'running') return <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--t-accent)]" />;
  return <Check className="w-3.5 h-3.5 text-[var(--t-ok)]" />;
}

export const ToolStepItem: React.FC<ToolStepProps & { isRunning?: boolean }> = ({ message, isRunning = false }) => {
  const { t, locale } = useLocale();
  const [detailsOpen, setDetailsOpen] = useState(false);
  const Icon = ICONS[getToolKind(message.meta?.name)];
  const duration = formatToolDuration(message.meta?.durationMs, locale);
  const hasDetails = Boolean(message.meta?.input || message.meta?.output || message.meta?.diff);

  return (
    <div className="text-xs text-[var(--t-text)]">
      <button type="button" onClick={() => hasDetails && setDetailsOpen((value) => !value)} className={`w-full flex items-center gap-2 text-left ${hasDetails ? 'cursor-pointer' : 'cursor-default'}`} aria-expanded={hasDetails ? detailsOpen : undefined}>
        <Icon className="w-3.5 h-3.5 shrink-0 text-[var(--t-text-2)]" />
        <span className="min-w-0 flex-1 truncate font-medium">- {summarizeTool(message, { read: t('extra.toolRead'), run: t('extra.toolRun'), default: t('extra.toolDefault') })}</span>
        {duration && <span className="shrink-0 text-[11px] text-[var(--t-text-3)]">{duration}</span>}
        {statusIcon(message, isRunning)}
        {hasDetails && (detailsOpen ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />)}
      </button>
      {detailsOpen && <div className="ml-5 mt-1 space-y-1.5 text-[11px] text-[var(--t-text-3)]">
        {message.meta?.input !== undefined && <pre className="max-h-28 overflow-auto rounded bg-[var(--t-surface-2)] p-2 whitespace-pre-wrap break-words font-mono">{typeof message.meta.input === 'string' ? message.meta.input : JSON.stringify(message.meta.input, null, 2)}</pre>}
        {message.meta?.diff && <pre className="max-h-44 overflow-auto rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 whitespace-pre-wrap break-words font-mono">{message.meta.diff.split('\n').map((line, index) => <span key={`${index}-${line}`} className={line.startsWith('+') ? 'text-[var(--t-ok)]' : line.startsWith('-') ? 'text-[var(--t-crit)]' : 'block'}>{line}{'\n'}</span>)}</pre>}
        {message.meta?.output && <pre className="max-h-28 overflow-auto rounded bg-[var(--t-surface-2)] p-2 whitespace-pre-wrap break-words font-mono">{message.meta.output}</pre>}
      </div>}
    </div>
  );
};

export interface ToolStepGroupProps { messages: ChatMessage[]; isRunning?: boolean; }

export const ToolStep: React.FC<ToolStepGroupProps> = ({ messages, isRunning = false }) => {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  if (messages.length === 0) return null;
  const latestMessage = messages[messages.length - 1];
  return (
    <div className="my-2 max-w-2xl">
      <button
        type="button"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
        title={t('extra.toolUsed', { count: messages.length })}
        className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-mono bg-[var(--t-surface-2)] hover:bg-[var(--t-hover)] text-[var(--t-text-2)] border border-[var(--t-border)] shadow-xs transition-colors cursor-pointer"
      >
        <Wrench className="w-3.5 h-3.5" />
        <span aria-hidden="true">⚙ </span>
        <span className="font-semibold text-[var(--t-text)]">
          {t('extra.stepsDone', { count: messages.length })}
        </span>{' '}
        <span>{expanded ? '▾' : '▸'}</span>
      </button>

      {expanded && (
        <div className="mt-2 pl-4 border-l-2 border-[var(--t-border)] space-y-1.5">
          {messages.map((msg) => (
            <ToolStepItem key={msg.id} message={msg} />
          ))}
        </div>
      )}

      {!expanded && isRunning && latestMessage && (
        <div className="mt-2 pl-4 border-l-2 border-[var(--t-border)] space-y-1.5">
          <ToolStepItem message={latestMessage} isRunning />
        </div>
      )}
    </div>
  );
};

export const ToolChipsGroup = ToolStep;
