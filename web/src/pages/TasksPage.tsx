import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getProjects, getTasks, getStatus } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { groupTasksByStatus, KANBAN_STATUSES } from '../utils/tasks';
import { Task } from '../types/api';
import { Plus, Filter, ArrowUpRight, Zap, Flame } from 'lucide-react';
import { SilentRunIndicator } from '../components/SilentRunIndicator';
import { useLocale } from '../context/LocaleContext';

export const TasksPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [selectedProject, setSelectedProject] = useState<string>('all');

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const { data: hubStatus } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10_000,
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks', selectedProject],
    queryFn: () => getTasks(selectedProject !== 'all' ? { project: selectedProject } : undefined),
    refetchInterval: 5000,
  });

  const grouped = groupTasksByStatus(tasks);

  return (
    <div className="space-y-6">
      {/* Top Bar: Filter & New Task Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{t('tasks.title')}</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('tasks.subtitle')}
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Project Filter */}
          <div className="flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 shadow-xs">
            <Filter className="w-4 h-4 text-[var(--text-secondary)]" />
            <select
              value={selectedProject}
              onChange={(e) => setSelectedProject(e.target.value)}
              aria-label={t('tasks.filterProject')}
              className="text-xs font-medium bg-transparent border-none text-[var(--text-primary)] focus:outline-none cursor-pointer"
            >
              <option value="all" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                {t('tasks.allProjects')}
              </option>
              {projects.map((p) => (
                <option key={p.id} value={p.id} className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* New Task Button */}
          <button
            type="button"
            onClick={() => navigate('/tasks/new')}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold shadow-xs cursor-pointer transition-colors"
          >
            <Plus className="w-4 h-4" />
            <span>{t('tasks.createTask')}</span>
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
        </div>
      ) : (
        /* Kanban Board Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pb-8">
          {KANBAN_STATUSES.map((statusKey) => {
            const colTasks: Task[] = grouped[statusKey] || [];

            return (
              <div
                key={statusKey}
                data-testid={`kanban-column-${statusKey}`}
                style={{
                  borderColor: 'var(--t-border)',
                }}
                className="relative flex flex-col rounded-xl border bg-[var(--t-surface-2)] p-3 min-h-[420px] transition-colors overflow-hidden"
              >
                <div
                  aria-hidden="true"
                  className="absolute inset-x-0 top-0 h-[3px]"
                  style={{ backgroundColor: `var(--status-${statusKey}-color, var(--t-accent))` }}
                />
                {/* Column Header */}
                <div className="flex items-center justify-between px-1 py-1.5 mb-3">
                  <div className="flex items-center gap-2">
                    <StatusBadge status={statusKey} size="sm" />
                  </div>
                  <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)]">
                    {colTasks.length}
                  </span>
                </div>

                {/* Cards List */}
                <div className="space-y-2.5 flex-1 overflow-y-auto">
                  {colTasks.length === 0 ? (
                    <div className="h-24 border border-dashed border-[var(--border-default)] rounded-lg flex items-center justify-center text-xs text-[var(--text-muted)] italic">
                      {t('common.empty')}
                    </div>
                  ) : (
                    colTasks.map((task) => (
                      <Link
                        key={task.id}
                        to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`}
                        className="block bg-[var(--bg-surface)] p-3.5 rounded-lg border border-[var(--border-default)] shadow-xs hover:border-[var(--t-accent)] hover:shadow-sm transition-all group"
                      >
                        <div className="flex items-start justify-between gap-2 mb-1.5">
                          <span className="text-xs font-mono text-[var(--text-secondary)] font-medium">
                            {task.slug}
                          </span>
                          {task.checks && task.checks.length > 0 && (
                            <span title={task.checks.every((check) => check.ok) ? t('extra.checkPassed') : t('extra.checkFailed')} className={task.checks.every((check) => check.ok) ? 'text-[var(--t-ok)]' : 'text-[var(--t-crit)]'}>
                              {task.checks.every((check) => check.ok) ? '✓' : '✗'}
                            </span>
                          )}
                          <ArrowUpRight className="w-3.5 h-3.5 text-[var(--text-muted)] group-hover:text-[var(--t-accent)] transition-colors" />
                        </div>

                        <h3 className="text-sm font-semibold text-[var(--text-primary)] line-clamp-2 mb-2.5">
                          {task.title}
                        </h3>

                        {task.reviewerEscalated ? (
                          <span className="inline-flex mb-2 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)]">
                            {t('extra.waitingApprover')}
                          </span>
                        ) : null}

                        {task.waitReason && (
                          <div className="mb-2">
                            <StatusBadge
                              status={task.status}
                              waitReason={task.waitReason}
                              diskFreeGB={hubStatus?.disk?.freeGB}
                              diskMinFreeGB={hubStatus?.disk?.minFreeGB}
                              size="sm"
                            />
                          </div>
                        )}

                        {task.status === 'running' && <SilentRunIndicator lastActivityAt={task.currentRun?.lastActivityAt} />}

                        <div className="flex items-center justify-between gap-2 pt-2 border-t border-[var(--border-subtle)] text-[11px]">
                          <span className="inline-flex items-center px-1.5 py-0.5 rounded bg-[var(--bg-surface-subtle)] font-medium text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                            {task.projectId}
                          </span>

                          <div className="flex items-center gap-1.5">
                            {task.level === 'hard' ? (
                              <span className="inline-flex items-center gap-0.5 text-[var(--t-purple)] font-medium">
                                <Flame className="w-3 h-3" /> {t('common.hard')}
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-0.5 text-[var(--t-ok)] font-medium">
                                <Zap className="w-3 h-3" /> {t('common.easy')}
                              </span>
                            )}

                            {task.attempt > 0 && (
                              <span className="font-mono text-[var(--text-muted)]">#{task.attempt}</span>
                            )}
                          </div>
                        </div>
                      </Link>
                    ))
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
