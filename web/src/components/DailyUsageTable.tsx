import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Calendar,
  RefreshCw,
  CheckCircle2,
  AlertTriangle,
  Clock,
  Sparkles,
} from 'lucide-react';
import { getDailyUsage } from '../api/client';
import { DailyUsageDay } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { formatNumber } from '../utils/format';

export interface DailyUsageTableProps {
  days?: number;
  className?: string;
  defaultView?: 'date' | 'overview';
}

function formatDuration(ms: number): string {
  if (!ms || ms <= 0) return '0s';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getQuotaColor(pct: number | null): string {
  if (pct == null) return 'bg-[var(--t-border)] text-[var(--t-text-3)]';
  if (pct >= 50) return 'bg-[var(--t-ok)] text-[var(--t-on-accent)]';
  if (pct >= 20) return 'bg-[var(--t-warn)] text-[var(--t-on-accent)]';
  return 'bg-[var(--t-crit)] text-[var(--t-on-accent)]';
}

function formatDisplayDate(dateStr: string, isToday: boolean, todayLabel: string): string {
  if (isToday) return `${todayLabel} (${dateStr.slice(5)})`;
  return dateStr.slice(5); // e.g. "10-15"
}

export const DailyUsageTable: React.FC<DailyUsageTableProps> = ({
  days = 7,
  className = '',
  defaultView = 'date',
}) => {
  const { t } = useLocale();
  const [viewMode, setViewMode] = useState<'date' | 'overview'>(defaultView);
  const [selectedDateIndex, setSelectedDateIndex] = useState<number>(0);

  const {
    data: report,
    isLoading,
    isError,
    refetch,
    isFetching,
  } = useQuery({
    queryKey: ['dailyUsage', days],
    queryFn: () => getDailyUsage(days),
    staleTime: 30_000,
    refetchInterval: 60_000,
  });

  if (isLoading) {
    return (
      <div
        data-testid="daily-usage-loading"
        className={`rounded-2xl border border-[var(--t-border)] bg-[var(--t-surface-1)] p-6 shadow-xs ${className}`}
      >
        <div className="flex items-center gap-3">
          <RefreshCw className="w-5 h-5 animate-spin text-[var(--t-accent)]" />
          <span className="text-sm text-[var(--t-text-2)]">{t('common.loading')}</span>
        </div>
      </div>
    );
  }

  if (isError || !report) {
    return (
      <div
        data-testid="daily-usage-error"
        className={`rounded-2xl border border-[var(--t-crit)]/20 bg-[var(--t-crit-bg)] p-6 ${className}`}
      >
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2 text-sm text-[var(--t-crit)]">
            <AlertTriangle className="w-4 h-4" />
            <span>{t('dailyUsage.loadError')}</span>
          </div>
          <button
            type="button"
            onClick={() => refetch()}
            className="text-xs text-[var(--t-accent)] hover:underline cursor-pointer"
          >
            {t('common.retry')}
          </button>
        </div>
      </div>
    );
  }

  const { dates = [], profiles = [], byDay = [] } = report;
  const activeDate = dates[selectedDateIndex] || dates[0] || '';
  const currentDayData: DailyUsageDay | undefined = byDay.find((d) => d.date === activeDate);
  const idleCount = profiles.filter((p) => p.isIdle).length;

  return (
    <section
      data-testid="daily-usage-section"
      className={`rounded-2xl border border-[var(--t-border)] bg-[var(--t-surface-1)] p-6 shadow-xs transition-colors space-y-6 ${className}`}
    >
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <Calendar className="w-5 h-5 text-[var(--t-accent)]" />
            <h2 className="text-base font-semibold text-[var(--t-text-1)]">
              {t('dailyUsage.title')}
            </h2>
            {idleCount > 0 && (
              <span className="inline-flex items-center gap-1 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[var(--t-ok-bg)] text-[var(--t-ok)] border border-[var(--t-ok)]/30">
                <Sparkles className="w-3 h-3" />
                {idleCount} {t('dailyUsage.suggestedIdle')}
              </span>
            )}
          </div>
          <p className="text-xs text-[var(--t-text-3)]">{t('dailyUsage.subtitle')}</p>
        </div>

        {/* View toggle & Refresh */}
        <div className="flex items-center gap-2 self-start sm:self-auto">
          <div className="inline-flex p-1 rounded-xl bg-[var(--t-surface-2)] border border-[var(--t-border)]">
            <button
              type="button"
              onClick={() => setViewMode('date')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                viewMode === 'date'
                  ? 'bg-[var(--t-surface-1)] text-[var(--t-text-1)] shadow-xs'
                  : 'text-[var(--t-text-3)] hover:text-[var(--t-text-2)]'
              }`}
            >
              {t('dailyUsage.viewByDate')}
            </button>
            <button
              type="button"
              onClick={() => setViewMode('overview')}
              className={`px-3 py-1 text-xs font-medium rounded-lg transition-colors cursor-pointer ${
                viewMode === 'overview'
                  ? 'bg-[var(--t-surface-1)] text-[var(--t-text-1)] shadow-xs'
                  : 'text-[var(--t-text-3)] hover:text-[var(--t-text-2)]'
              }`}
            >
              {t('dailyUsage.viewAll', { days: 7 })}
            </button>
          </div>

          <button
            type="button"
            onClick={() => refetch()}
            disabled={isFetching}
            title={t('extra.refresh')}
            className="p-2 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text-2)] hover:text-[var(--t-text-1)] transition-colors cursor-pointer disabled:opacity-50"
          >
            <RefreshCw className={`w-4 h-4 ${isFetching ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* Date Selector Pills (when viewMode === 'date') */}
      {viewMode === 'date' && dates.length > 0 && (
        <div className="space-y-4">
          <div className="flex items-center gap-2 overflow-x-auto pb-1 scrollbar-thin">
            {dates.map((dateStr, idx) => {
              const isToday = idx === 0;
              const isSelected = idx === selectedDateIndex;
              const dayData = byDay.find((d) => d.date === dateStr);
              const runs = dayData?.totalRuns || 0;

              return (
                <button
                  key={dateStr}
                  type="button"
                  onClick={() => setSelectedDateIndex(idx)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-medium whitespace-nowrap transition-all cursor-pointer flex items-center gap-1.5 border ${
                    isSelected
                      ? 'bg-[var(--t-accent)] text-[var(--t-on-accent)] border-[var(--t-accent)] shadow-sm'
                      : 'bg-[var(--t-surface-2)] text-[var(--t-text-2)] border-[var(--t-border)] hover:bg-[var(--t-surface-3)]'
                  }`}
                >
                  <span>{formatDisplayDate(dateStr, isToday, t('dailyUsage.today'))}</span>
                  {runs > 0 && (
                    <span
                      className={`px-1.5 py-0.2 rounded-full text-[10px] font-bold ${
                        isSelected ? 'bg-[var(--t-on-accent)]/20 text-[var(--t-on-accent)]' : 'bg-[var(--t-surface-1)] text-[var(--t-text-3)]'
                      }`}
                    >
                      {runs}
                    </span>
                  )}
                </button>
              );
            })}
          </div>

          {/* Day summary badges */}
          {currentDayData && (
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-3">
              <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3">
                <span className="text-[11px] text-[var(--t-text-3)] block">{t('dailyUsage.runs')}</span>
                <span className="text-lg font-bold text-[var(--t-text-1)]">{currentDayData.totalRuns}</span>
              </div>
              <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3">
                <span className="text-[11px] text-[var(--t-text-3)] block">{t('dailyUsage.duration')}</span>
                <span className="text-lg font-bold text-[var(--t-text-1)]">
                  {formatDuration(currentDayData.totalDurationMs)}
                </span>
              </div>
              <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3">
                <span className="text-[11px] text-[var(--t-text-3)] block">{t('dailyUsage.tokens')}</span>
                <span className="text-lg font-bold text-[var(--t-text-1)]">
                  {formatNumber(currentDayData.totalTokens)}
                </span>
              </div>
              <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3">
                <span className="text-[11px] text-[var(--t-text-3)] block">{t('dailyUsage.claudeTokens')}</span>
                <span className="text-lg font-bold text-[var(--t-purple)]">
                  {formatNumber(currentDayData.claudeTokens ?? 0)}
                </span>
              </div>
              <div className="rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3">
                <span className="text-[11px] text-[var(--t-text-3)] block">{t('dailyUsage.suggestedIdle')}</span>
                <span className="text-lg font-bold text-[var(--t-ok)]">
                  {idleCount} / {profiles.length}
                </span>
              </div>
            </div>
          )}

          {/* Table for Selected Date */}
          <div className="overflow-x-auto rounded-xl border border-[var(--t-border)]">
            <table className="w-full text-left text-xs border-collapse">
              <thead>
                <tr className="border-b border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text-3)] font-semibold uppercase tracking-wider text-[11px]">
                  <th className="py-3 px-4">{t('dailyUsage.profile')}</th>
                  <th className="py-3 px-4">{t('dailyUsage.quotaRemaining')}</th>
                  <th className="py-3 px-4 text-center">{t('dailyUsage.runs')}</th>
                  <th className="py-3 px-4">{t('dailyUsage.duration')}</th>
                  <th className="py-3 px-4 text-right">{t('dailyUsage.tokens')}</th>
                  <th className="py-3 px-4 text-right">{t('dailyUsage.claudeTokens')}</th>
                  <th className="py-3 px-4">{t('dailyUsage.status')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--t-border)]">
                {profiles.map((profile) => {
                  const metric = profile.daily[activeDate] || { runs: 0, durationMs: 0, tokens: 0 };
                  const isHighlighted = profile.isIdle;

                  return (
                    <tr
                      key={profile.name}
                      data-testid={`daily-usage-row-${profile.name}`}
                      className={`transition-colors ${
                        isHighlighted
                          ? 'bg-[var(--t-ok-bg)] border-l-4 border-l-[var(--t-ok)] hover:bg-[var(--t-ok-bg)]'
                          : 'hover:bg-[var(--t-surface-2)]/50'
                      }`}
                    >
                      {/* Profile Name & Engine */}
                      <td className="py-3.5 px-4 font-medium text-[var(--t-text-1)]">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold">{profile.name}</span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] uppercase font-bold tracking-wider ${
                              profile.engine === 'codex'
                                ? 'bg-[var(--t-purple-bg)] text-[var(--t-purple)] border border-[var(--t-purple)]/30'
                                : profile.engine === 'claude'
                                  ? 'bg-[var(--t-warn-bg)] text-[var(--t-warn)] border border-[var(--t-warn)]/30'
                                  : 'bg-[var(--t-info-bg)] text-[var(--t-info)] border border-[var(--t-info)]/30'
                            }`}
                          >
                            {profile.engine}
                          </span>
                        </div>
                      </td>

                      {/* Quota Remaining */}
                      <td className="py-3.5 px-4">
                        {profile.engine === 'claude' ? (
                          <span className="text-[11px] text-[var(--t-text-3)]">
                            Claude CLI
                          </span>
                        ) : profile.engine === 'codex' ? (
                          <span className="text-[11px] text-[var(--t-text-3)]">
                            Codex CLI · GPT-5.6
                          </span>
                        ) : (
                          <div className="flex flex-col gap-1 text-[11px]">
                            {/* Gemini */}
                            <div className="flex items-center gap-1.5">
                              <span className="w-12 font-medium text-[var(--t-text-2)]">Gemini:</span>
                              <span className="text-[var(--t-text-3)]">
                                5h:
                              </span>
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${getQuotaColor(
                                   profile.quota.gemini5h,
                                )}`}
                              >
                                {profile.quota.gemini5h != null ? `${profile.quota.gemini5h}%` : '—'}
                              </span>
                              <span className="text-[var(--t-text-3)] ml-1">
                                W:
                              </span>
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${getQuotaColor(
                                  profile.quota.geminiWeek,
                                )}`}
                              >
                                {profile.quota.geminiWeek != null ? `${profile.quota.geminiWeek}%` : '—'}
                              </span>
                            </div>

                            {/* Claude & GPT */}
                            <div className="flex items-center gap-1.5">
                              <span className="w-12 font-medium text-[var(--t-text-2)]">Claude:</span>
                              <span className="text-[var(--t-text-3)]">
                                5h:
                              </span>
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${getQuotaColor(
                                  profile.quota.claude5h,
                                )}`}
                              >
                                {profile.quota.claude5h != null ? `${profile.quota.claude5h}%` : '—'}
                              </span>
                              <span className="text-[var(--t-text-3)] ml-1">
                                W:
                              </span>
                              <span
                                className={`px-1.5 py-0.2 rounded text-[10px] font-bold ${getQuotaColor(
                                  profile.quota.claudeWeek,
                                )}`}
                              >
                                {profile.quota.claudeWeek != null ? `${profile.quota.claudeWeek}%` : '—'}
                              </span>
                            </div>
                          </div>
                        )}
                      </td>

                      {/* Runs Count */}
                      <td className="py-3.5 px-4 text-center font-semibold text-[var(--t-text-1)]">
                        {metric.runs > 0 ? (
                          <span className="inline-block px-2 py-0.5 rounded-full bg-[var(--t-surface-2)] text-[var(--t-text-1)]">
                            {metric.runs}
                          </span>
                        ) : (
                          <span className="text-[var(--t-text-3)]">0</span>
                        )}
                      </td>

                      {/* Duration */}
                      <td className="py-3.5 px-4 text-[var(--t-text-2)] font-mono text-[11px]">
                        <div className="flex items-center gap-1">
                          <Clock className="w-3.5 h-3.5 text-[var(--t-text-3)]" />
                          <span>{formatDuration(metric.durationMs)}</span>
                        </div>
                      </td>

                      {/* Tokens */}
                      <td className="py-3.5 px-4 text-right font-mono font-medium text-[var(--t-text-1)]">
                        {metric.tokens > 0 ? (
                          <span className="text-[var(--t-accent)]">{formatNumber(metric.tokens)}</span>
                        ) : (
                          <span className="text-[var(--t-text-3)]">0</span>
                        )}
                      </td>

                      {/* Claude Tokens */}
                      <td className="py-3.5 px-4 text-right font-mono font-medium text-[var(--t-text-1)]">
                        {(metric.claudeTokens ?? 0) > 0 ? (
                          <span className="text-[var(--t-purple)]">
                            {formatNumber(metric.claudeTokens!)}
                          </span>
                        ) : profile.engine === 'claude' && metric.tokens > 0 ? (
                          <span className="text-[var(--t-purple)]">
                            {formatNumber(metric.tokens)}
                          </span>
                        ) : (
                          <span className="text-[var(--t-text-3)]">—</span>
                        )}
                      </td>

                      {/* Status / Idle Suggestion */}
                      <td className="py-3.5 px-4">
                        {profile.isIdle ? (
                          <div className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-semibold bg-[var(--t-ok-bg)] text-[var(--t-ok)] border border-[var(--t-ok)]/30">
                            <Sparkles className="w-3.5 h-3.5 shrink-0" />
                            <span>{t('dailyUsage.suggestedIdle')}</span>
                          </div>
                        ) : !profile.enabled ? (
                          <span className="text-[var(--t-text-3)]">{t('dailyUsage.disabled')}</span>
                        ) : metric.runs > 0 ? (
                          <span className="inline-flex items-center gap-1 text-[var(--t-text-2)]">
                            <CheckCircle2 className="w-3.5 h-3.5 text-[var(--t-info)]" />
                            <span>{t('dailyUsage.active')}</span>
                          </span>
                        ) : (
                          <span className="text-[var(--t-text-3)]">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              {currentDayData && (
                <tfoot>
                  <tr className="border-t border-[var(--t-border)] bg-[var(--t-surface-2)]/40 font-semibold text-[11px] text-[var(--t-text-2)]">
                    <td className="py-2.5 px-4">{t('dailyUsage.total')}</td>
                    <td className="py-2.5 px-4">—</td>
                    <td className="py-2.5 px-4 text-center">{currentDayData.totalRuns}</td>
                    <td className="py-2.5 px-4 font-mono">{formatDuration(currentDayData.totalDurationMs)}</td>
                    <td className="py-2.5 px-4 text-right font-mono text-[var(--t-accent)]">
                      {formatNumber(currentDayData.totalTokens)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono text-[var(--t-purple)]">
                      {formatNumber(currentDayData.claudeTokens ?? 0)}
                    </td>
                    <td className="py-2.5 px-4">—</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </div>
      )}

      {/* 7-Day Overview Matrix (when viewMode === 'overview') */}
      {viewMode === 'overview' && (
        <div className="overflow-x-auto rounded-xl border border-[var(--t-border)]">
          <table className="w-full text-left text-xs border-collapse">
            <thead>
              <tr className="border-b border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text-3)] font-semibold uppercase tracking-wider text-[11px]">
                <th className="py-3 px-4">{t('dailyUsage.profile')}</th>
                <th className="py-3 px-3">{t('dailyUsage.status')}</th>
                {dates.map((d, i) => (
                  <th key={d} className="py-3 px-3 text-center">
                    {i === 0 ? t('dailyUsage.today') : d.slice(5)}
                  </th>
                ))}
                <th className="py-3 px-4 text-right">{t('dailyUsage.total')}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--t-border)]">
              {profiles.map((profile) => (
                <tr
                  key={profile.name}
                  className={`transition-colors ${
                    profile.isIdle
                      ? 'bg-[var(--t-ok-bg)] border-l-4 border-l-[var(--t-ok)] hover:bg-[var(--t-ok-bg)]'
                      : 'hover:bg-[var(--t-surface-2)]/50'
                  }`}
                >
                  <td className="py-3 px-4 font-semibold text-[var(--t-text-1)]">
                    <div className="flex items-center gap-1.5">
                      <span>{profile.name}</span>
                      <span className="text-[10px] text-[var(--t-text-3)] font-normal uppercase">
                        ({profile.engine})
                      </span>
                    </div>
                  </td>
                  <td className="py-3 px-3">
                    {profile.isIdle ? (
                      <span className="px-2 py-0.5 rounded text-[10px] font-bold bg-[var(--t-ok-bg)] text-[var(--t-ok)]">
                        {t('dailyUsage.suggestedIdle')}
                      </span>
                    ) : (
                      <span className="text-[var(--t-text-3)] text-[11px]">—</span>
                    )}
                  </td>
                  {dates.map((d) => {
                    const m = profile.daily[d] || { runs: 0, durationMs: 0, tokens: 0 };
                    return (
                      <td key={d} className="py-3 px-3 text-center font-mono text-[11px]">
                        {m.runs > 0 ? (
                          <div>
                            <span className="font-semibold text-[var(--t-text-1)]">{m.runs}r</span>
                            <span className="text-[10px] text-[var(--t-text-3)] block">
                              {formatNumber(m.tokens)}
                            </span>
                          </div>
                        ) : (
                          <span className="text-[var(--t-text-3)]">—</span>
                        )}
                      </td>
                    );
                  })}
                  <td className="py-3 px-4 text-right font-mono font-bold text-[var(--t-text-1)]">
                    <div>
                      <span>{profile.totals.runs} {t('dailyUsage.runs').toLowerCase()}</span>
                      <span className="text-[10px] text-[var(--t-accent)] block">
                        {formatNumber(profile.totals.tokens)}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
};
