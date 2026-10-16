import React from 'react';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export interface UsageItem { grp: string; window: '5h' | 'week'; remainingPct: number; resetAt: number; fetchedAt: number }

function until(epoch: number): string {
  const seconds = Math.max(0, epoch - Math.floor(Date.now() / 1000));
  const h = Math.floor(seconds / 3600); const m = Math.floor((seconds % 3600) / 60);
  return h ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
}
function color(pct: number): string { return pct > 50 ? 'bg-[var(--t-ok)]' : pct >= 20 ? 'bg-[var(--t-warn)]' : 'bg-[var(--t-crit)]'; }

export const QuotaUsage: React.FC<{ usage?: UsageItem[]; onRefresh: () => void; refreshing?: boolean }> = ({ usage = [], onRefresh, refreshing }) => {
  const { t } = useLocale();
  const groups = [...new Set(usage.map((u) => u.grp))];
  return <div className="space-y-2 min-w-[220px]">
    {groups.length === 0 && <span className="text-xs text-[var(--t-text-3)]">{t('extra.noData')}</span>}
    {groups.map((group) => <div key={group} className="space-y-1">
      <div className="text-xs font-medium text-[var(--t-text-2)]">{group}</div>
      {(['5h', 'week'] as const).map((window) => { const item = usage.find((u) => u.grp === group && u.window === window); return <div key={window} className="flex items-center gap-2 text-[11px]">
        <span className="w-8 text-[var(--t-text-3)]">{window === '5h' ? t('extra.fiveHours') : t('extra.week')}</span>
        {item ? <><div className="h-1.5 w-16 rounded-full bg-[var(--t-surface-2)] border border-[var(--t-border)]"><div className={`h-full rounded-full ${color(item.remainingPct)}`} style={{ width: `${item.remainingPct}%` }} /></div><span>{item.remainingPct}% · {t('extra.resetIn', { time: until(item.resetAt) })}</span></> : <span className="text-[var(--t-text-3)]">—</span>}
      </div>; })}
    </div>)}
    <button type="button" onClick={onRefresh} disabled={refreshing} className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline cursor-pointer"><RefreshCw className={`w-3 h-3 ${refreshing ? 'animate-spin' : ''}`} /> {t('extra.refresh')}</button>
  </div>;
};
