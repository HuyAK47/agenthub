import React, { useState } from 'react';
import { Check, ChevronDown, Play, X } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export interface CheckResult {
  name: string;
  ok: boolean;
  exitCode: number | null;
  durationMs: number;
  outputTail: string;
}

interface CheckResultsProps {
  checks?: CheckResult[];
  onRerun?: () => void;
  rerunning?: boolean;
  onCreateTask?: (check: CheckResult) => void;
}

export const CheckResults: React.FC<CheckResultsProps> = ({ checks = [], onRerun, rerunning = false, onCreateTask }) => {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState<string | null>(null);
  return (
    <section aria-label={t('extra.checkResults')} data-tour="task-review" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <h2 className="font-semibold text-[var(--t-text)]">{t('extra.checkResults')}</h2>
        {onRerun && (
          <button type="button" onClick={onRerun} disabled={rerunning} className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] text-xs font-semibold disabled:opacity-50 transition-colors cursor-pointer">
            <Play className="w-3.5 h-3.5" /> {rerunning ? t('common.loading') : t('extra.rerunCheck')}
          </button>
        )}
      </div>
      {checks.length === 0 ? <p className="text-xs text-[var(--t-text-3)]">{t('extra.noCheckResults')}</p> : (
        <div className="space-y-1.5">
          {checks.map((check, index) => {
            const key = `${check.name}-${index}`;
            const isOpen = expanded === key;
            return (
              <div key={key} className="rounded-lg border border-[var(--t-border)] overflow-hidden">
                <button type="button" onClick={() => setExpanded(isOpen ? null : key)} className="w-full flex items-center gap-2 px-3 py-2 text-left text-xs text-[var(--t-text)] hover:bg-[var(--t-hover)] transition-colors cursor-pointer">
                  {check.ok ? <Check aria-label={t('extra.checkPassed')} className="w-4 h-4 text-[var(--t-ok)]" /> : <X aria-label={t('extra.checkFailed')} className="w-4 h-4 text-[var(--t-crit)]" />}
                  <span className="font-mono flex-1">{check.name}</span>
                  <span className="text-[var(--t-text-3)]">{(check.durationMs / 1000).toFixed(1)}s</span>
                  <ChevronDown className={`w-3.5 h-3.5 transition-transform ${isOpen ? 'rotate-180' : ''}`} />
                </button>
                {isOpen && <div className="border-t border-[var(--t-border)] bg-[var(--t-surface-2)]"><pre className="text-[var(--t-text)] p-3 text-[11px] font-mono whitespace-pre-wrap max-h-64 overflow-auto">{check.outputTail || t('extra.noOutput')}</pre>{onCreateTask && !check.ok && <button type="button" data-tour="task-capture" onClick={() => onCreateTask(check)} className="mx-3 mb-3 px-2.5 py-1.5 rounded-md bg-[var(--t-accent)] text-[var(--t-on-accent)] text-xs font-semibold cursor-pointer">{t('extra.captureFix')}</button>}</div>}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
