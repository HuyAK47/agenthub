import React, { memo, useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getProjects, getStatus, getTasks } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { groupTasksByStatus, KANBAN_STATUSES } from '../utils/tasks';
import { Task } from '../types/api';
import { Plus, Filter, ArrowUpRight, Zap, Flame, LayoutGrid, Network, FolderKanban, ChevronDown, AlertTriangle } from 'lucide-react';
import { SilentRunIndicator } from '../components/SilentRunIndicator';
import { useLocale } from '../context/LocaleContext';
import { useShowMore } from '../components/CollapsibleList';
import { TaskDag } from '../components/dag';
import { filterTasksForDag } from '../components/dag/dagUtils';

const normalizeText = (text: string): string =>
  text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[đĐ]/g, (c) => (c === 'đ' ? 'd' : 'D'))
    .toLowerCase();

export interface KanbanColumnProps {
  statusKey: (typeof KANBAN_STATUSES)[number];
  tasks: Task[];
  search: string;
}

const KanbanColumnComponent: React.FC<KanbanColumnProps> = ({ statusKey, tasks, search }) => {
  const { t } = useLocale();
  // Dùng chung cache ['status'] giữa các cột, chỉ để hiện dung lượng đĩa trong nhãn "Chờ ổ đĩa".
  const { data: hubStatus } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 10_000,
  });

  const filteredTasks = useMemo(() => {
    const query = normalizeText(search.trim());
    let list = tasks;
    if (query) {
      list = list.filter((task) => {
        const slugMatch = normalizeText(task.slug).includes(query);
        const titleMatch = normalizeText(task.title).includes(query);
        return slugMatch || titleMatch;
      });
    }
    return [...list].sort((a, b) => {
      const timeA = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
      const timeB = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
      return timeB - timeA;
    });
  }, [tasks, search]);

  const initialCount = statusKey === 'done' || statusKey === 'cancelled' ? 10 : 20;
  const { visibleItems, hasMore, isExpanded, showMore, collapse } = useShowMore(
    filteredTasks,
    initialCount,
    20,
    `agenthub:tasks:${statusKey}`,
  );

  const remaining = filteredTasks.length - visibleItems.length;
  const nextStep = Math.min(20, remaining);

  return (
    <div
      data-testid={`kanban-column-${statusKey}`}
      style={{
        borderColor: 'var(--t-border)',
      }}
      className="relative flex flex-col rounded-xl border bg-[var(--t-surface-2)] p-3 min-h-[420px] transition-colors overflow-hidden"
    >
      <div
        aria-hidden="true"
        className="absolute inset-x-0 top-0 h-[3px]"
        style={{
          backgroundColor: `var(--status-${statusKey}-color, var(--t-accent))`,
        }}
      />

      {/* Column Header */}
      <div className="flex items-center justify-between px-1 py-1.5 mb-3">
        <div className="flex items-center gap-2">
          <StatusBadge status={statusKey} size="sm" />
        </div>
        <span className="text-xs font-bold font-mono px-2 py-0.5 rounded-full bg-[var(--bg-surface)] border border-[var(--border-default)] text-[var(--text-primary)]">
          {tasks.length}
        </span>
      </div>

      {/* Cards List */}
      <div className="space-y-2.5 flex-1 overflow-y-auto">
        {filteredTasks.length === 0 ? (
          <div className="h-24 border border-dashed border-[var(--border-default)] rounded-lg flex items-center justify-center text-xs text-[var(--text-muted)] italic">
            {t('common.empty')}
          </div>
        ) : (
          visibleItems.map((task) => (
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
                  <span
                    title={
                      task.checks.every((check) => check.ok)
                        ? t('extra.checkPassed')
                        : t('extra.checkFailed')
                    }
                    className={
                      task.checks.every((check) => check.ok)
                        ? 'text-[var(--t-ok)]'
                        : 'text-[var(--t-crit)]'
                    }
                  >
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

              {task.status === 'running' && (
                <div className="flex items-center gap-1.5 flex-wrap mb-2">
                  <SilentRunIndicator lastActivityAt={task.currentRun?.lastActivityAt} />
                  {task.currentRun?.noCommitMinutes != null && task.currentRun.noCommitMinutes > 0 && (
                    <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-warn)] border border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]">
                      {t('extra.noCommit', { minutes: task.currentRun.noCommitMinutes })}
                    </span>
                  )}
                  {task.currentRun?.isLooping && (
                    <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-crit)] border border-[color-mix(in_srgb,var(--t-crit)_30%,transparent)]">
                      {t('extra.looping')}
                    </span>
                  )}
                </div>
              )}

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

        {(hasMore || isExpanded) && (
          <div className="flex items-center justify-center gap-3 pt-2">
            {hasMore && (
              <button
                type="button"
                onClick={showMore}
                className="text-xs font-medium text-[var(--t-accent)] hover:underline cursor-pointer"
              >
                Xem thêm {nextStep} (còn {remaining})
              </button>
            )}
            {isExpanded && (
              <button
                type="button"
                onClick={collapse}
                className="text-xs text-[var(--text-secondary)] hover:underline cursor-pointer"
              >
                Thu gọn
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export const KanbanColumn = memo(KanbanColumnComponent);

const PROJECT_VIEW_STORAGE_KEY = 'agenthub:tasks:view-mode';
const PROJECT_TASK_ORDER: Task['status'][] = ['running', 'review', 'blocked', 'queued', 'waiting_quota', 'checking', 'draft', 'failed', 'done', 'cancelled'];

function readStoredTaskView(): 'kanban' | 'dag' | 'project' {
  try {
    const value = window.localStorage.getItem(PROJECT_VIEW_STORAGE_KEY);
    return value === 'dag' || value === 'project' ? value : 'kanban';
  } catch {
    return 'kanban';
  }
}

function writeStoredTaskView(value: 'kanban' | 'dag' | 'project') {
  try {
    window.localStorage.setItem(PROJECT_VIEW_STORAGE_KEY, value);
  } catch {
    // Private browsing and disabled storage should not break the task page.
  }
}

function isAttentionTask(task: Task) {
  return task.status === 'blocked' || task.status === 'failed' || Boolean(task.reviewerEscalated);
}

function isOldDoneTask(task: Task) {
  if (task.status !== 'done' && task.status !== 'cancelled') return false;
  const updated = new Date(task.updatedAt).getTime();
  return Number.isFinite(updated) && Date.now() - updated > 24 * 60 * 60 * 1000;
}

const ProjectTaskCard: React.FC<{ task: Task }> = ({ task }) => {
  const { t } = useLocale();
  return (
    <Link
      to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`}
      className="block rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] p-3 hover:border-[var(--t-accent)] transition-colors"
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-mono text-[var(--text-secondary)] truncate">{task.slug}</div>
          <div className="mt-1 text-sm font-semibold text-[var(--text-primary)] line-clamp-2">{task.title}</div>
        </div>
        <StatusBadge status={task.status} size="sm" />
      </div>
      {task.reviewerEscalated ? <span className="mt-2 inline-flex text-[11px] font-semibold text-[var(--t-warn)]">{t('extra.waitingApprover')}</span> : null}
    </Link>
  );
};

const ProjectTaskGroup: React.FC<{ project: { id: string; name: string; priority?: number }; tasks: Task[]; onCreate: () => void }> = ({ project, tasks, onCreate }) => {
  const { t } = useLocale();
  const [open, setOpen] = useState(true);
  const [showOldDone, setShowOldDone] = useState(false);
  const counts = useMemo(() => ({
    running: tasks.filter((task) => task.status === 'running').length,
    checking: tasks.filter((task) => task.status === 'checking').length,
    review: tasks.filter((task) => task.status === 'review').length,
    blocked: tasks.filter((task) => task.status === 'blocked').length,
    waiting: tasks.filter((task) => ['queued', 'waiting_quota'].includes(task.status)).length,
  }), [tasks]);
  const visibleTasks = useMemo(() => {
    const sorted = [...tasks].sort((a, b) => {
      const rank = (status: Task['status']) => PROJECT_TASK_ORDER.indexOf(status);
      return rank(a.status) - rank(b.status) || new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
    });
    return showOldDone ? sorted : sorted.filter((task) => !isOldDoneTask(task));
  }, [tasks, showOldDone]);
  const paginatedTasks = useShowMore(
    visibleTasks,
    20,
    20,
    `agenthub:tasks:project:${project.id}`,
  );
  const remaining = visibleTasks.length - paginatedTasks.visibleItems.length;
  const oldDoneCount = tasks.filter(isOldDoneTask).length;

  return (
    <section className="rounded-xl border border-[var(--border-default)] bg-[var(--t-surface-2)] overflow-hidden" data-testid={`project-task-group-${project.id}`}>
      <div className="flex items-center gap-2 p-3 sm:p-4">
        <button type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open} className="flex min-w-0 flex-1 items-center gap-2 text-left">
          <ChevronDown className={`h-4 w-4 shrink-0 transition-transform ${open ? '' : '-rotate-90'}`} />
          <FolderKanban className="h-4 w-4 shrink-0 text-[var(--t-accent)]" />
          <span className="truncate font-semibold text-[var(--text-primary)]">{project.name}</span>
          {project.priority != null && project.priority > 0 ? <span className="rounded-full bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-2 py-0.5 text-[11px] font-semibold text-[var(--t-warn)]">{t('tasks.priority', { value: project.priority })}</span> : null}
        </button>
        <div className="hidden flex-wrap justify-end gap-1.5 text-[11px] sm:flex" aria-label={t('tasks.projectCounts')}>
          <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--t-ok)]">{t('status.running')}: {counts.running}</span>
          <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--t-accent)]">{t('status.checking')}: {counts.checking}</span>
          <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--t-warn)]">{t('status.review')}: {counts.review}</span>
          <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--t-crit)]">{t('status.blocked')}: {counts.blocked}</span>
          <span className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--text-secondary)]">{t('tasks.waitingShort')}: {counts.waiting}</span>
        </div>
        <button type="button" onClick={onCreate} className="inline-flex shrink-0 items-center gap-1 rounded-lg bg-[var(--t-accent)] px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-[var(--t-accent-hover)]" aria-label={`${t('tasks.createTask')} ${project.name}`}>
          <Plus className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('tasks.createTask')}</span>
        </button>
      </div>
      {open && <div className="border-t border-[var(--border-default)] p-3 sm:p-4">
        <div className="mb-3 flex flex-wrap gap-1.5 text-[11px] sm:hidden">
          {Object.entries(counts).map(([key, count]) => <span key={key} className="rounded-full bg-[var(--bg-surface)] px-2 py-0.5 text-[var(--text-secondary)]">{key}: {count}</span>)}
        </div>
        {visibleTasks.length > 0 ? <div className="grid grid-cols-1 gap-2 md:grid-cols-2 xl:grid-cols-3">{paginatedTasks.visibleItems.map((task) => <ProjectTaskCard key={task.id} task={task} />)}</div> : <div className="rounded-lg border border-dashed border-[var(--border-default)] p-5 text-center text-xs italic text-[var(--text-muted)]">{t('common.empty')}</div>}
        {(paginatedTasks.hasMore || paginatedTasks.isExpanded) && <div className="flex items-center justify-center gap-3 pt-3">
          {paginatedTasks.hasMore && <button type="button" onClick={paginatedTasks.showMore} className="text-xs font-medium text-[var(--t-accent)] hover:underline">Xem thêm {Math.min(20, remaining)} (còn {remaining})</button>}
          {paginatedTasks.isExpanded && <button type="button" onClick={paginatedTasks.collapse} className="text-xs text-[var(--text-secondary)] hover:underline">Thu gọn</button>}
        </div>}
        {oldDoneCount > 0 && <button type="button" onClick={() => setShowOldDone((value) => !value)} className="mt-3 text-xs font-medium text-[var(--t-accent)] hover:underline">{showOldDone ? t('tasks.hideOldDone') : t('tasks.showOldDone', { count: oldDoneCount })}</button>}
      </div>}
    </section>
  );
};

export const TasksPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<'kanban' | 'dag' | 'project'>(readStoredTaskView);
  const [selectedProjects, setSelectedProjects] = useState<string[]>(() => searchParams.get('project')?.split(',').filter(Boolean) ?? []);
  const [selectedStatus, setSelectedStatus] = useState<string>('all');
  const [attentionOnly, setAttentionOnly] = useState(false);
  const [doneFilter, setDoneFilter] = useState<'active_chains' | '1d' | '3d' | '7d' | '30d' | 'all'>('active_chains');
  const [search, setSearch] = useState<string>('');

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const { data: tasks = [], isLoading } = useQuery({
    queryKey: ['tasks'],
    queryFn: () => getTasks(),
    refetchInterval: 5000,
  });

  const selectedProject = selectedProjects.length === 1 ? selectedProjects[0] : 'all';
  const filteredTasks = useMemo(() => tasks.filter((task) => (selectedProjects.length === 0 || selectedProjects.includes(task.projectId)) && (!attentionOnly || isAttentionTask(task))), [tasks, selectedProjects, attentionOnly]);
  const grouped = useMemo(() => groupTasksByStatus(filteredTasks), [filteredTasks]);
  const projectGroups = useMemo(() => projects.map((project) => ({ ...project, tasks: filteredTasks.filter((task) => task.projectId === project.id) })).filter((project) => selectedProjects.length === 0 || selectedProjects.includes(project.id)), [projects, filteredTasks, selectedProjects]);

  useEffect(() => writeStoredTaskView(viewMode), [viewMode]);

  const dagTasks = useMemo(() => {
    let list = filteredTasks;
    const query = normalizeText(search.trim());
    if (query) {
      list = list.filter((task) => {
        const slugMatch = normalizeText(task.slug).includes(query);
        const titleMatch = normalizeText(task.title).includes(query);
        return slugMatch || titleMatch;
      });
    }
    return filterTasksForDag(list, {
      project: selectedProject,
      status: selectedStatus,
      doneFilter,
    });
  }, [filteredTasks, search, selectedProject, selectedStatus, doneFilter]);

  const setMode = (mode: 'kanban' | 'dag' | 'project') => setViewMode(mode);
  const toggleProject = (id: string) => setSelectedProjects((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);

  return (
    <div className="space-y-6" data-tour="task-lifecycle">
      {/* Top Bar: Filter & New Task Button */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4" data-tour="task-filters">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">
            {t('tasks.title')}
          </h1>
          <p className="text-sm text-[var(--text-secondary)]">{t('tasks.subtitle')}</p>
        </div>

        <div className="flex items-center gap-3 flex-wrap sm:flex-nowrap">
          {/* View Mode Toggle: Kanban <-> Sơ đồ (DAG) */}
          <div className="flex items-center bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg p-0.5 shadow-xs" data-tour="task-views">
            <button
              type="button"
              onClick={() => setViewMode('kanban')}
              data-testid="view-toggle-kanban"
              aria-label={t('dag.toggleKanban')}
              title={t('dag.toggleKanban')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'kanban'
                  ? 'bg-[var(--t-accent)] text-white shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <LayoutGrid className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('dag.toggleKanban')}</span>
            </button>
            <button type="button" onClick={() => setMode('project')} data-testid="view-toggle-project" aria-label={t('tasks.projectView')} title={t('tasks.projectView')} className={`inline-flex items-center gap-1.5 rounded px-2.5 py-1 text-xs font-medium transition-colors ${viewMode === 'project' ? 'bg-[var(--t-accent)] text-white shadow-xs font-semibold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>
              <FolderKanban className="h-3.5 w-3.5" /><span className="hidden sm:inline">{t('tasks.projectView')}</span>
            </button>
            <button
              type="button"
              onClick={() => setViewMode('dag')}
              data-testid="view-toggle-dag"
              aria-label={t('dag.toggleDag')}
              title={t('dag.toggleDag')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${
                viewMode === 'dag'
                  ? 'bg-[var(--t-accent)] text-white shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
            >
              <Network className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('dag.toggleDag')}</span>
            </button>
          </div>

          {/* Quick Filter (Slug / Title) */}
          <div className="flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 shadow-xs">
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t('tasks.filterQuick')}
              aria-label={t('tasks.filterQuick')}
              className="text-xs font-medium bg-transparent border-none text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none w-36 sm:w-48"
            />
          </div>

          {/* Project filters */}
          <div className="flex max-w-full flex-wrap items-center gap-1.5 rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] px-2 py-1.5 shadow-xs" aria-label={t('tasks.filterProject')}>
            <Filter className="w-4 h-4 text-[var(--text-secondary)]" />
            <button type="button" onClick={() => setSelectedProjects([])} className={`rounded-full px-2 py-1 text-xs font-medium ${selectedProjects.length === 0 ? 'bg-[var(--t-accent)] text-white' : 'text-[var(--text-secondary)]'}`}>{t('tasks.allProjects')}</button>
            {projects.map((p) => <button type="button" key={p.id} onClick={() => toggleProject(p.id)} className={`rounded-full px-2 py-1 text-xs font-medium ${selectedProjects.includes(p.id) ? 'bg-[var(--t-accent)] text-white' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}>{p.name}</button>)}
          </div>
          <button type="button" onClick={() => setAttentionOnly((value) => !value)} className={`inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-xs font-semibold ${attentionOnly ? 'border-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_12%,transparent)] text-[var(--t-crit)]' : 'border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-secondary)]'}`} aria-pressed={attentionOnly}>
            <AlertTriangle className="h-3.5 w-3.5" />{t('tasks.attention')}
          </button>

          {/* DAG-specific filters (Status & Done cutoff) */}
          {viewMode === 'dag' && (
            <>
              {/* Status Filter */}
              <div className="flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 shadow-xs">
                <select
                  value={selectedStatus}
                  onChange={(e) => setSelectedStatus(e.target.value)}
                  aria-label={t('dag.filterStatus')}
                  className="text-xs font-medium bg-transparent border-none text-[var(--text-primary)] focus:outline-none cursor-pointer"
                >
                  <option value="all" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.allStatuses')}
                  </option>
                  {KANBAN_STATUSES.map((st) => (
                    <option
                      key={st}
                      value={st}
                      className="bg-[var(--bg-surface)] text-[var(--text-primary)]"
                    >
                      {t(`status.${st}`)}
                    </option>
                  ))}
                </select>
              </div>

              {/* Done tasks filter */}
              <div className="flex items-center gap-2 bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-lg px-3 py-1.5 shadow-xs">
                <select
                  value={doneFilter}
                  onChange={(e) => setDoneFilter(e.target.value as any)}
                  aria-label={t('dag.hideDone')}
                  className="text-xs font-medium bg-transparent border-none text-[var(--text-primary)] focus:outline-none cursor-pointer"
                >
                  <option value="active_chains" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.activeChains')}
                  </option>
                  <option value="1d" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.done1d')}
                  </option>
                  <option value="3d" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.done3d')}
                  </option>
                  <option value="7d" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.done7d')}
                  </option>
                  <option value="30d" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.done30d')}
                  </option>
                  <option value="all" className="bg-[var(--bg-surface)] text-[var(--text-primary)]">
                    {t('dag.doneAll')}
                  </option>
                </select>
              </div>
            </>
          )}

          {/* New Task Button */}
          <button
            type="button"
            onClick={() => navigate('/tasks/new')}
            data-tour="task-actions"
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold shadow-xs cursor-pointer transition-colors shrink-0"
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
      ) : viewMode === 'dag' ? (
        <div data-testid="dag-view-wrapper" className="pb-8">
          <TaskDag tasks={dagTasks} />
        </div>
      ) : viewMode === 'project' ? (
        <div className="space-y-4 pb-8" data-testid="project-view-wrapper">
          {projectGroups.length === 0 ? <div className="rounded-xl border border-dashed border-[var(--border-default)] p-8 text-center text-sm text-[var(--text-muted)]">{t('common.empty')}</div> : projectGroups.map((project) => <ProjectTaskGroup key={project.id} project={project} tasks={project.tasks} onCreate={() => navigate(`/tasks/new?project=${encodeURIComponent(project.id)}`)} />)}
        </div>
      ) : (
        /* Kanban Board Grid */
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 pb-8" data-tour="task-columns">
          {KANBAN_STATUSES.map((statusKey) => (
            <KanbanColumn
              key={statusKey}
              statusKey={statusKey}
              tasks={grouped[statusKey] || []}
              search={search}
            />
          ))}
        </div>
      )}
    </div>
  );
};
