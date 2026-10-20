import React from 'react';
import { ChatSession } from '../../types/api';
import { Sparkles, AlertTriangle } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

export interface ContextMeterProps {
  session: ChatSession;
  onCompact?: () => void;
  hasCompactApi?: boolean;
  className?: string;
}

export const CONTEXT_WINDOW_LIMIT = 200000;

export const ContextMeter: React.FC<ContextMeterProps> = ({
  session,
  onCompact,
  hasCompactApi = false,
  className = '',
}) => {
  const { t } = useLocale();
  const contextTokens = session.contextTokens || 0;
  const inputTokens = session.inputTokens || 0;
  const outputTokens = session.outputTokens || 0;
  const totalTokens = inputTokens + outputTokens;

  const pct = Math.min(100, Math.round((contextTokens / CONTEXT_WINDOW_LIMIT) * 100));
  const isHigh = pct > 80;
  const isMedium = pct > 60 && pct <= 80;

  const barColor = isHigh
    ? 'bg-[var(--t-crit)]'
    : isMedium
    ? 'bg-[var(--t-warn)]'
    : 'bg-[var(--t-accent)]';

  const textColor = isHigh
    ? 'text-[var(--t-crit)]'
    : isMedium
    ? 'text-[var(--t-warn)]'
    : 'text-[var(--text-secondary)]';

  return (
    <div
      data-testid="context-meter"
      className={`flex flex-col gap-1 text-[11px] ${className}`}
      title={`${t('extra.contextLabel')}: ${contextTokens.toLocaleString()} / 200.000 (${pct}%) · ${t('extra.totalTokens')}: ${totalTokens.toLocaleString()}`}
    >
      <div className="flex items-center justify-between gap-2">
        <span className="flex items-center gap-1 font-medium text-[var(--text-secondary)]">
          <span>{t('extra.contextLabel')}:</span>
          <span className={`font-semibold ${textColor}`}>
            {pct}% ({contextTokens.toLocaleString()} / 200k)
          </span>
        </span>
        <span className="text-[var(--text-muted)] text-[10px]">
          {t('extra.totalTokens')}: <strong className="font-mono text-[var(--text-secondary)]">{totalTokens.toLocaleString()}</strong>
        </span>
      </div>

      <div className="w-full h-1.5 rounded-full bg-[var(--bg-surface-subtle)] border border-[var(--border-subtle)] overflow-hidden">
        <div
          role="progressbar"
          aria-valuenow={pct}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-label={t('extra.contextRatio')}
          className={`h-full rounded-full transition-all duration-300 ${barColor}`}
          style={{ width: `${Math.max(pct, contextTokens > 0 ? 2 : 0)}%` }}
        />
      </div>

      {isHigh && (
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <span className="flex items-center gap-1 text-[var(--t-crit)] text-[10px] font-medium">
            <AlertTriangle className="w-3 h-3 shrink-0" />
            <span>{t('extra.compactWarning')}</span>
          </span>
          {(hasCompactApi || onCompact) && (
            <button
              type="button"
              onClick={onCompact}
              data-testid="compact-button"
              className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-[10px] font-semibold transition-colors cursor-pointer"
            >
              <Sparkles className="w-2.5 h-2.5" />
              <span>{t('extra.compactContext')}</span>
            </button>
          )}
        </div>
      )}
    </div>
  );
};
