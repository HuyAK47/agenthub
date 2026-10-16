import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { getSavings, getProjects } from '../api/client';
import { Project } from '../types/api';
import {
  Sparkles,
  Code2,
  CheckCircle2,
  RotateCcw,
  Info,
  Calendar,
  Filter,
  ArrowUpRight,
} from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export const SavingsPage: React.FC = () => {
  const { t, locale } = useLocale();
  const [projectFilter, setProjectFilter] = useState<string>('');
  const [sinceFilter, setSinceFilter] = useState<string>('');
  const formatNumber = (value: number) => value.toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US');

  const { data: projects = [] } = useQuery<Project[]>({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const {
    data: savings,
    isLoading,
    error,
  } = useQuery({
    queryKey: ['savings', projectFilter, sinceFilter],
    queryFn: () =>
      getSavings({
        project: projectFilter || undefined,
        since: sinceFilter || undefined,
      }),
  });

  const formatDuration = (ms: number | null | undefined) => {
    if (!ms || ms <= 0) return '0s';
    const totalSec = Math.floor(ms / 1000);
    const hours = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    if (hours > 0) return `${hours}h ${mins}m`;
    if (mins > 0) return `${mins}m ${secs}s`;
    return `${secs}s`;
  };

  const summary = savings?.summary;
  const tasks = savings?.tasks || [];
  const byDay = savings?.byDay || [];

  // Chart max calculation
  const maxDayTokens = Math.max(
    1,
    ...byDay.map((d) => Math.max(d.geminiTokens, d.codexTokens, d.totalTokens)),
  );

  return (
    <div className="space-y-8 max-w-7xl mx-auto">
      {/* Header and Filters */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('savings.title')}</h1>
          <p className="text-sm text-[var(--text-secondary)] mt-1">
            {t('savings.subtitle')}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3">
          <div className="flex items-center gap-1.5 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-2.5 py-1.5 text-xs shadow-xs">
            <Filter className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <select
              value={projectFilter}
              onChange={(e) => setProjectFilter(e.target.value)}
              aria-label={t('tasks.filterProject')}
              className="bg-transparent border-none text-[var(--text-primary)] focus:outline-none cursor-pointer"
            >
              <option value="">{t('tasks.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-1.5 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-2.5 py-1.5 text-xs shadow-xs">
            <Calendar className="w-3.5 h-3.5 text-[var(--text-secondary)]" />
            <input
              type="date"
              value={sinceFilter}
              onChange={(e) => setSinceFilter(e.target.value)}
              aria-label={t('savings.fromDate')}
              className="bg-transparent border-none text-[var(--text-primary)] focus:outline-none cursor-pointer text-xs"
            />
          </div>

          {(projectFilter || sinceFilter) && (
            <button
              type="button"
              onClick={() => {
                setProjectFilter('');
                setSinceFilter('');
              }}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline px-2 py-1"
            >
              {t('savings.clearFilters')}
            </button>
          )}
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center p-16">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-blue-600" />
        </div>
      ) : error ? (
        <div className="p-8 text-center text-rose-600 text-sm">
          {t('savings.loadError')}
        </div>
      ) : (
        <>
          {/* 4 Metric Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {/* Card 1: avoided Claude work */}
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--text-secondary)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.claudeSaved')}
                </span>
                <div className="p-2 rounded-lg bg-blue-50 dark:bg-blue-950/60 text-blue-600 dark:text-blue-400">
                  <Sparkles className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                  {summary ? formatNumber(summary.claudeSavedTokens) : '0'}
                  <span className="text-xs font-normal text-[var(--text-secondary)] ml-1">
                    tokens
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-1.5 text-xs text-emerald-600 dark:text-emerald-400 font-medium">
                  <span className="px-1.5 py-0.5 rounded bg-emerald-50 dark:bg-emerald-950/60 border border-emerald-200/50 dark:border-emerald-800/50">
                    {((summary?.savingsRatio || 0) * 100).toFixed(1)}%
                  </span>
                  <span>{t('savings.savingRate')}</span>
                </div>
              </div>
            </div>

            {/* Card 2: worker-written code */}
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--text-secondary)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.codeWritten')}
                </span>
                <div className="p-2 rounded-lg bg-emerald-50 dark:bg-emerald-950/60 text-emerald-600 dark:text-emerald-400">
                  <Code2 className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                  +{summary ? formatNumber(summary.totalLinesAdded) : '0'}
                  <span className="text-xs font-normal text-[var(--text-secondary)] ml-1">
                    {t('savings.lines')}
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                    -{summary ? formatNumber(summary.totalLinesDeleted) : '0'} {t('savings.linesDeleted')}
                </div>
              </div>
            </div>

            {/* Card 3: approved tasks */}
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--text-secondary)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.approvedTasks')}
                </span>
                <div className="p-2 rounded-lg bg-indigo-50 dark:bg-indigo-950/60 text-indigo-600 dark:text-indigo-400">
                  <CheckCircle2 className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                  {summary?.tasksApprovedCount || 0}
                  <span className="text-xs font-normal text-[var(--text-secondary)] ml-1">
                    task
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                  {t('savings.totalTasks', { count: tasks.length })}
                </div>
              </div>
            </div>

            {/* Card 4: average review rounds */}
            <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-5 shadow-xs flex flex-col justify-between">
              <div className="flex items-center justify-between text-[var(--text-secondary)] mb-2">
                <span className="text-xs font-semibold uppercase tracking-wider">
                  {t('savings.avgReviewRounds')}
                </span>
                <div className="p-2 rounded-lg bg-amber-50 dark:bg-amber-950/60 text-amber-600 dark:text-amber-400">
                  <RotateCcw className="w-4 h-4" />
                </div>
              </div>
              <div>
                <div className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
                  {(summary?.avgReviewRounds || 0).toFixed(1)}
                  <span className="text-xs font-normal text-[var(--text-secondary)] ml-1">
                    {t('savings.rounds')}
                  </span>
                </div>
                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                  {t('savings.changesRound')}
                </div>
              </div>
            </div>
          </div>

          {/* Bar Chart: Daily Token Usage by Engine */}
          <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-6 shadow-xs space-y-4">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  {t('savings.tokensByDay')}
                </h2>
                <p className="text-xs text-[var(--text-secondary)]">
                  {t('savings.tokensByDayDesc')}
                </p>
              </div>

              {/* Legend */}
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-xs bg-blue-500" />
                  <span className="text-[var(--text-secondary)]">Gemini (agy)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <div className="w-3 h-3 rounded-xs bg-emerald-500" />
                  <span className="text-[var(--text-secondary)]">Codex</span>
                </div>
              </div>
            </div>

            {byDay.length === 0 ? (
              <div className="py-12 text-center text-xs text-[var(--text-secondary)]">
                {t('savings.noDailyData')}
              </div>
            ) : (
              <div className="w-full overflow-x-auto">
                <div className="min-w-[600px] h-64 flex flex-col justify-end pt-4 pb-2">
                  {/* SVG Chart */}
                  <svg className="w-full h-48" viewBox={`0 0 ${Math.max(600, byDay.length * 60)} 200`}>
                    <defs>
                      <linearGradient id="geminiGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#3b82f6" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="#1d4ed8" stopOpacity="0.7" />
                      </linearGradient>
                      <linearGradient id="codexGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity="0.9" />
                        <stop offset="100%" stopColor="#047857" stopOpacity="0.7" />
                      </linearGradient>
                    </defs>

                    {/* Horizontal grid lines */}
                    {[0.25, 0.5, 0.75, 1].map((pct) => (
                      <line
                        key={pct}
                        x1="0"
                        y1={180 - pct * 160}
                        x2="100%"
                        y2={180 - pct * 160}
                        stroke="currentColor"
                        strokeDasharray="4 4"
                        className="text-[var(--border-default)] opacity-40"
                      />
                    ))}

                    {/* Bars */}
                    {byDay.map((d, idx) => {
                      const totalWidth = Math.max(600, byDay.length * 60);
                      const groupWidth = totalWidth / byDay.length;
                      const xBase = idx * groupWidth + groupWidth * 0.15;
                      const barW = Math.min(20, groupWidth * 0.35);

                      const geminiH = Math.max(4, (d.geminiTokens / maxDayTokens) * 160);
                      const codexH = Math.max(4, (d.codexTokens / maxDayTokens) * 160);

                      return (
                        <g key={d.date} className="cursor-pointer group">
                          {/* Gemini bar */}
                          <rect
                            x={xBase}
                            y={180 - geminiH}
                            width={barW}
                            height={geminiH}
                            rx="3"
                            fill="url(#geminiGrad)"
                            className="transition-all hover:opacity-100 opacity-90"
                          >
                            <title>{`${d.date} - Gemini: ${formatNumber(d.geminiTokens)} tokens`}</title>
                          </rect>

                          {/* Codex bar */}
                          <rect
                            x={xBase + barW + 4}
                            y={180 - codexH}
                            width={barW}
                            height={codexH}
                            rx="3"
                            fill="url(#codexGrad)"
                            className="transition-all hover:opacity-100 opacity-90"
                          >
                            <title>{`${d.date} - Codex: ${formatNumber(d.codexTokens)} tokens`}</title>
                          </rect>

                          {/* Date label */}
                          <text
                            x={xBase + barW}
                            y="196"
                            textAnchor="middle"
                            className="text-[10px] fill-[var(--text-secondary)] font-mono"
                          >
                            {d.date.slice(5)}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                </div>
              </div>
            )}
          </div>

          {/* Table by Task */}
          <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] shadow-xs overflow-hidden">
            <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
              <div>
                <h2 className="text-base font-semibold text-[var(--text-primary)]">
                  {t('savings.byTask')}
                </h2>
                <p className="text-xs text-[var(--text-secondary)] mt-0.5">
                    {t('savings.byTaskDesc')}
                </p>
              </div>
              <span className="text-xs text-[var(--text-secondary)]">
                {tasks.length} task
              </span>
            </div>

            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="bg-[var(--bg-surface-hover)] border-b border-[var(--border-default)] text-[var(--text-secondary)] font-semibold uppercase tracking-wider">
                  <tr>
                    <th className="px-6 py-3">Task</th>
                    <th className="px-6 py-3">Model</th>
                    <th className="px-6 py-3 text-right">{t('savings.linesChange')}</th>
                    <th className="px-6 py-3 text-right">Worker Tokens</th>
                    <th className="px-6 py-3 text-center">Claude</th>
                    <th className="px-6 py-3 text-center">{t('savings.reviewRounds')}</th>
                    <th className="px-6 py-3 text-right">{t('taskDetail.thDuration')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border-default)] text-[var(--text-primary)]">
                  {tasks.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-6 py-8 text-center text-[var(--text-secondary)]">
                        {t('savings.noMatchingTasks')}
                      </td>
                    </tr>
                  ) : (
                    tasks.map((task) => (
                      <tr
                        key={task.taskId}
                        className="hover:bg-[var(--bg-surface-hover)] transition-colors"
                      >
                        <td className="px-6 py-3.5">
                          <Link
                            to={`/tasks/${encodeURIComponent(task.taskId)}`}
                            className="font-medium hover:text-blue-600 dark:hover:text-blue-400 flex items-center gap-1 group"
                          >
                            <span>{task.title || task.slug}</span>
                            <ArrowUpRight className="w-3 h-3 opacity-0 group-hover:opacity-100 transition-opacity" />
                          </Link>
                          <div className="text-[11px] font-mono text-[var(--text-secondary)] mt-0.5">
                            {task.taskId}
                          </div>
                        </td>
                        <td className="px-6 py-3.5">
                          <span className="inline-flex items-center px-2 py-0.5 rounded text-[11px] font-mono bg-gray-100 dark:bg-gray-800 text-[var(--text-secondary)] border border-[var(--border-default)]">
                            {task.model || task.engine}
                          </span>
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono">
                          {task.linesAdded > 0 || task.linesDeleted > 0 ? (
                            <>
                              <span className="text-emerald-600 dark:text-emerald-400">
                                +{task.linesAdded}
                              </span>{' '}
                              <span className="text-rose-600 dark:text-rose-400">
                                -{task.linesDeleted}
                              </span>
                            </>
                          ) : (
                            <span className="text-[var(--text-secondary)]">0</span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono font-medium">
                          {task.estimated && (
                            <span
                              title={t('savings.estimatedTitle')}
                              className="text-amber-500 mr-1 select-none"
                            >
                              ≈
                            </span>
                          )}
                          <span>{formatNumber(task.tokens)}</span>
                        </td>
                        <td className="px-6 py-3.5 text-center font-mono">
                          {task.reviewRounds > 0 ? (
                            <span className="px-1.5 py-0.5 rounded bg-amber-50 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300 font-semibold text-[11px]">
                              {task.reviewRounds}
                            </span>
                          ) : (
                            <span className="text-[var(--text-secondary)]">0</span>
                          )}
                        </td>
                        <td className="px-6 py-3.5 text-center">
                          <span className={task.claudeCostSource === 'measured' ? 'text-emerald-600 dark:text-emerald-400' : 'text-amber-600 dark:text-amber-400'}>
                            {task.claudeCostSource === 'measured' ? 'measured' : 'estimated'}
                          </span>
                          {task.claudeEffectiveTokens ? <div className="text-[11px] font-mono text-[var(--text-secondary)]">{formatNumber(task.claudeEffectiveTokens)}</div> : null}
                        </td>
                        <td className="px-6 py-3.5 text-right font-mono text-[var(--text-secondary)]">
                          {formatDuration(task.durationMs)}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>

          {/* Explanation Callout */}
          <div className="p-4 rounded-xl bg-blue-50/70 dark:bg-blue-950/40 border border-blue-200/60 dark:border-blue-900/60 text-xs text-blue-900 dark:text-blue-300 flex items-start gap-3">
            <Info className="w-5 h-5 text-blue-600 dark:text-blue-400 shrink-0 mt-0.5" />
            <div className="space-y-1">
              <p className="font-semibold">{t('savings.methodTitle')}</p>
              <p className="text-blue-800 dark:text-blue-300/90 leading-relaxed">
                {t('savings.methodDesc')}
                {t('savings.factorsPrefix')} (<code>bucketTokens</code>, <code>claudeFactor</code>, <code>claudeOverheadPerTask</code>) {t('savings.factorsSuffix')}{' '}
                <Link to="/settings" className="font-semibold underline hover:text-blue-700 dark:hover:text-blue-200">
                  {t('common.settings')}
                </Link>.
              </p>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
