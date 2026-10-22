import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { getProjects, getStatus, getTasks, getTasksPage } from '../api/client';
import { StatusBadge } from '../components/StatusBadge';
import { groupTasksByStatus, KANBAN_STATUSES } from '../utils/tasks';
import { Task } from '../types/api';
import { Plus, Filter, ArrowUpRight, Zap, Flame, LayoutGrid, Network, List } from 'lucide-react';
import { SilentRunIndicator } from '../components/SilentRunIndicator';
import { useLocale } from '../context/LocaleContext';
import { useShowMore } from '../components/CollapsibleList';
import { TaskDag } from '../components/dag';
import { filterTasksForDag } from '../components/dag/dagUtils';
import { DataTable } from '../components/ui';

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

export const TasksPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [urlParams, setUrlParams] = useSearchParams();
  const [viewMode, setViewMode] = useState<'kanban' | 'dag' | 'list'>((urlParams.get('view') as 'kanban' | 'dag' | 'list') || 'kanban');
  const [selectedProject, setSelectedProject] = useState<string>(urlParams.get('project') || 'all');
  const [selectedStatus, setSelectedStatus] = useState<string>(urlParams.get('status') || 'all');
  const [doneFilter, setDoneFilter] = useState<'active_chains' | '1d' | '3d' | '7d' | '30d' | 'all'>('active_chains');
  const [search, setSearch] = useState<string>(urlParams.get('search') || '');
  const [page, setPage] = useState(Number(urlParams.get('page') || 1));
  const [pageSize, setPageSize] = useState(Number(urlParams.get('pageSize') || 20));
  const [cursors, setCursors] = useState<Record<number, string | undefined>>({});
  const cursor = cursors[page - 1];

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const { data, isLoading: isPageLoading } = useQuery({
    queryKey: ['tasks', selectedProject, selectedStatus, search, page, pageSize, cursor],
    queryFn: () => getTasksPage({ project: selectedProject, status: selectedStatus, search, limit: pageSize, cursor }),
    enabled: viewMode === 'list' && (page === 1 || Boolean(cursor)),
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const { data: allTasks = [], isLoading: isAllTasksLoading } = useQuery({
    queryKey: ['tasks-kanban', selectedProject, search],
    queryFn: () => getTasks({ project: selectedProject, search }),
    enabled: viewMode !== 'list',
    refetchInterval: 5000,
    placeholderData: keepPreviousData,
  });
  const initialFilters = useRef(true);
  useEffect(() => {
    if (data?.nextCursor) setCursors((current) => ({ ...current, [page]: data.nextCursor || undefined }));
  }, [data?.nextCursor, page]);
  useEffect(() => {
    const next = new URLSearchParams(urlParams);
    const values: Record<string, string> = { project: selectedProject, status: selectedStatus, search, page: String(page), pageSize: String(pageSize), view: viewMode };
    for (const [key, value] of Object.entries(values)) {
      if (value && value !== 'all' && value !== '1' && !(key === 'pageSize' && value === '20') && !(key === 'view' && value === 'kanban')) next.set(key, value);
      else next.delete(key);
    }
    if (next.toString() !== urlParams.toString()) setUrlParams(next, { replace: true });
  }, [selectedProject, selectedStatus, search, page, pageSize, viewMode, setUrlParams, urlParams]);
  useEffect(() => {
    if (initialFilters.current) {
      initialFilters.current = false;
      return;
    }
    setPage(1);
    setCursors({});
  }, [selectedProject, search, selectedStatus, pageSize]);
  useEffect(() => {
    if (viewMode === 'list' && page > 1 && !cursor) setPage(1);
  }, [viewMode, page, cursor]);
  const tasks = allTasks;

  const grouped = useMemo(() => groupTasksByStatus(tasks), [tasks]);

  const dagTasks = useMemo(() => {
    return filterTasksForDag(tasks, {
      project: selectedProject,
      status: selectedStatus,
      doneFilter,
    });
  }, [tasks, search, selectedProject, selectedStatus, doneFilter]);

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
            <button
              type="button"
              onClick={() => setViewMode('list')}
              data-testid="view-toggle-list"
              aria-label={t('tasks.listView')}
              title={t('tasks.listView')}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-xs font-medium cursor-pointer transition-colors ${viewMode === 'list' ? 'bg-[var(--t-accent)] text-white shadow-xs font-semibold' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'}`}
            >
              <List className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">{t('tasks.listView')}</span>
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
                <option
                  key={p.id}
                  value={p.id}
                  className="bg-[var(--bg-surface)] text-[var(--text-primary)]"
                >
                  {p.name}
                </option>
              ))}
            </select>
          </div>

          {/* DAG-specific filters (Status & Done cutoff) */}
          {viewMode !== 'kanban' && (
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

      {viewMode === 'list' ? (
        <DataTable
          rows={data?.items || []}
          loading={isPageLoading}
          columns={[
            { key: 'slug', title: t('tasks.slug'), render: (task) => <Link className="font-mono text-[var(--t-accent)] hover:underline" to={`/tasks/${encodeURIComponent(task.id.replace('/', '~'))}`}>{task.slug}</Link> },
            { key: 'title', title: t('tasks.title'), render: (task) => <span className="truncate" title={task.title}>{task.title}</span> },
            { key: 'status', title: t('tasks.status'), render: (task) => <StatusBadge status={task.status} size="sm" /> },
            { key: 'project', title: t('tasks.project'), render: (task) => <span>{task.projectId}</span> },
          ]}
          page={page}
          pageSize={pageSize}
          total={data?.total || 0}
          onPageChange={setPage}
          onPageSizeChange={(size) => { setPageSize(size); setPage(1); setCursors({}); }}
        />
      ) : isAllTasksLoading ? (
        <div className="flex items-center justify-center min-h-[40vh]">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
        </div>
      ) : viewMode === 'dag' ? (
        <div data-testid="dag-view-wrapper" className="pb-8">
          <TaskDag tasks={dagTasks} />
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
