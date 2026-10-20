import React, { useState, useMemo, useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  getBatches,
  getBatch,
  getProjects,
  dispatchBatch,
  discardBatch,
  addTaskToBatch,
  removeTaskFromBatch,
  updateTask,
} from '../api/client';
import { Task, BatchStatus, TaskLevel } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { TaskDag } from '../components/dag';
import { StatusBadge } from '../components/StatusBadge';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import {
  Layers,
  Send,
  Trash2,
  Plus,
  Edit2,
  AlertTriangle,
  FolderGit2,
  User,
  Clock,
  Sparkles,
} from 'lucide-react';
import { formatTimeAgo } from '../lib/time';

const toArray = (val: string | string[] | null | undefined): string[] => {
  if (!val) return [];
  return Array.isArray(val) ? val : [val];
};

const BatchStatusBadge: React.FC<{ status: BatchStatus }> = ({ status }) => {
  const { t } = useLocale();
  const styles = {
    draft: 'bg-amber-500/15 text-amber-500 border-amber-500/30',
    dispatched: 'bg-emerald-500/15 text-emerald-500 border-emerald-500/30',
    discarded: 'bg-zinc-500/15 text-zinc-400 border-zinc-500/30',
  }[status];

  return (
    <span
      data-testid={`batch-status-badge-${status}`}
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium border ${styles}`}
    >
      {t(`plans.${status}`)}
    </span>
  );
};

export const PlansPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const { batchId } = useParams<{ batchId?: string }>();
  const queryClient = useQueryClient();

  // Filters
  const [filterProject, setFilterProject] = useState<string>('all');
  const [filterStatus, setFilterStatus] = useState<string>('all');

  // Modals & form state
  const [showAddModal, setShowAddModal] = useState<boolean>(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [showDiscardModal, setShowDiscardModal] = useState<boolean>(false);
  const [taskToRemove, setTaskToRemove] = useState<Task | null>(null);
  const [dispatchError, setDispatchError] = useState<string | null>(null);

  // Add Task form state
  const [newSlug, setNewSlug] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [newBody, setNewBody] = useState('');
  const [newLevel, setNewLevel] = useState<TaskLevel>('easy');
  const [newModelChain, setNewModelChain] = useState('');
  const [newDeps, setNewDeps] = useState<string[]>([]);
  const [addFormError, setAddFormError] = useState<string | null>(null);

  // Edit Task form state
  const [editTitle, setEditTitle] = useState('');
  const [editBody, setEditBody] = useState('');
  const [editLevel, setEditLevel] = useState<TaskLevel>('easy');
  const [editModelChain, setEditModelChain] = useState('');
  const [editDeps, setEditDeps] = useState<string[]>([]);
  const [editFormError, setEditFormError] = useState<string | null>(null);

  // Queries
  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const { data: batches = [], isLoading: isLoadingBatches } = useQuery({
    queryKey: ['batches', filterProject, filterStatus],
    queryFn: () =>
      getBatches({
        project: filterProject !== 'all' ? filterProject : undefined,
        status: filterStatus !== 'all' ? filterStatus : undefined,
      }),
  });

  // Determine active batch ID
  const activeBatchId = useMemo(() => {
    if (batchId) return batchId;
    if (batches.length > 0) return batches[0].id;
    return null;
  }, [batchId, batches]);

  // Sync route if no batchId in URL but batches exist
  useEffect(() => {
    if (!batchId && batches.length > 0) {
      navigate(`/plans/${batches[0].id}`, { replace: true });
    }
  }, [batchId, batches, navigate]);

  // Query active batch detail
  const { data: currentBatch, isLoading: isLoadingBatch } = useQuery({
    queryKey: ['batch', activeBatchId],
    queryFn: () => (activeBatchId ? getBatch(activeBatchId) : null),
    enabled: Boolean(activeBatchId),
  });

  // Mutations
  const dispatchMutation = useMutation({
    mutationFn: () => {
      if (!activeBatchId) throw new Error('No active batch');
      return dispatchBatch(activeBatchId);
    },
    onSuccess: () => {
      setDispatchError(null);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['batch', activeBatchId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
    onError: (err: any) => {
      const msg = err.response?.data?.message || err.message || t('plans.cycleError');
      setDispatchError(msg);
    },
  });

  const discardMutation = useMutation({
    mutationFn: () => {
      if (!activeBatchId) throw new Error('No active batch');
      return discardBatch(activeBatchId);
    },
    onSuccess: () => {
      setShowDiscardModal(false);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['batch', activeBatchId] });
      queryClient.invalidateQueries({ queryKey: ['tasks'] });
    },
  });

  const addTaskMutation = useMutation({
    mutationFn: (data: {
      slug: string;
      title: string;
      body?: string;
      level?: TaskLevel;
      modelChain?: string[];
      dependsOn?: string[];
    }) => {
      if (!activeBatchId) throw new Error('No active batch');
      return addTaskToBatch(activeBatchId, data);
    },
    onSuccess: () => {
      setShowAddModal(false);
      resetAddForm();
      setDispatchError(null);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['batch', activeBatchId] });
    },
    onError: (err: any) => {
      setAddFormError(err.response?.data?.message || err.message || 'Lỗi thêm task');
    },
  });

  const removeTaskMutation = useMutation({
    mutationFn: (taskId: string) => {
      if (!activeBatchId) throw new Error('No active batch');
      return removeTaskFromBatch(activeBatchId, taskId);
    },
    onSuccess: () => {
      setTaskToRemove(null);
      setDispatchError(null);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['batch', activeBatchId] });
    },
  });

  const updateTaskMutation = useMutation({
    mutationFn: ({
      taskId,
      updates,
    }: {
      taskId: string;
      updates: {
        title?: string;
        body?: string;
        level?: TaskLevel;
        modelChain?: string[];
        dependsOn?: string[];
      };
    }) => updateTask(taskId, updates),
    onSuccess: () => {
      setEditingTask(null);
      setDispatchError(null);
      queryClient.invalidateQueries({ queryKey: ['batches'] });
      queryClient.invalidateQueries({ queryKey: ['batch', activeBatchId] });
    },
    onError: (err: any) => {
      setEditFormError(err.response?.data?.message || err.message || 'Lỗi cập nhật task');
    },
  });

  const resetAddForm = () => {
    setNewSlug('');
    setNewTitle('');
    setNewBody('');
    setNewLevel('easy');
    setNewModelChain('');
    setNewDeps([]);
    setAddFormError(null);
  };

  const handleOpenEdit = (task: Task) => {
    setEditingTask(task);
    setEditTitle(task.title);
    setEditBody(task.body || '');
    setEditLevel(task.level || 'easy');
    setEditModelChain(task.modelChain ? toArray(task.modelChain).join(', ') : '');
    setEditDeps(task.dependsOn ? toArray(task.dependsOn) : []);
    setEditFormError(null);
  };

  const handleAddSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newSlug.trim()) {
      setAddFormError('Slug không được để trống');
      return;
    }
    if (!newTitle.trim()) {
      setAddFormError('Tiêu đề không được để trống');
      return;
    }

    const modelChainArr = newModelChain.trim()
      ? newModelChain.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    addTaskMutation.mutate({
      slug: newSlug.trim(),
      title: newTitle.trim(),
      body: newBody.trim() || undefined,
      level: newLevel,
      modelChain: modelChainArr,
      dependsOn: newDeps.length > 0 ? newDeps : undefined,
    });
  };

  const handleEditSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTask) return;
    if (!editTitle.trim()) {
      setEditFormError('Tiêu đề không được để trống');
      return;
    }

    const modelChainArr = editModelChain.trim()
      ? editModelChain.split(',').map((s) => s.trim()).filter(Boolean)
      : undefined;

    updateTaskMutation.mutate({
      taskId: editingTask.id,
      updates: {
        title: editTitle.trim(),
        body: editBody.trim(),
        level: editLevel,
        modelChain: modelChainArr,
        dependsOn: editDeps,
      },
    });
  };

  const isDraft = currentBatch?.status === 'draft';
  const batchTasks = currentBatch?.tasks || [];

  return (
    <div className="flex flex-col h-[calc(100vh-56px)] overflow-hidden">
      {/* Top Header */}
      <div className="px-6 py-4 border-b border-[var(--t-border)] bg-[var(--t-surface)] flex items-center justify-between shrink-0">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Layers className="w-5 h-5 text-[var(--t-accent)]" />
            {t('plans.title')}
          </h1>
          <p className="text-xs text-[var(--t-text-3)] mt-0.5">{t('plans.subtitle')}</p>
        </div>

        {/* Global Filter Bar */}
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 text-xs">
            <FolderGit2 className="w-4 h-4 text-[var(--t-text-3)]" />
            <select
              data-testid="filter-project"
              value={filterProject}
              onChange={(e) => setFilterProject(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)]"
            >
              <option value="all">{t('plans.allProjects')}</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name || p.id}
                </option>
              ))}
            </select>
          </div>

          <div className="flex items-center gap-2 text-xs">
            <select
              data-testid="filter-status"
              value={filterStatus}
              onChange={(e) => setFilterStatus(e.target.value)}
              className="px-2.5 py-1.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)]"
            >
              <option value="all">{t('plans.allStatuses')}</option>
              <option value="draft">{t('plans.draft')}</option>
              <option value="dispatched">{t('plans.dispatched')}</option>
              <option value="discarded">{t('plans.discarded')}</option>
            </select>
          </div>
        </div>
      </div>

      {/* Main Split Layout: Left List, Right Detail */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Column: Batches List */}
        <div className="w-[340px] max-[1100px]:w-[280px] border-r border-[var(--t-border)] bg-[var(--t-surface)] flex flex-col shrink-0">
          <div className="px-4 py-3 border-b border-[var(--t-border)] font-semibold text-xs uppercase tracking-wider text-[var(--t-text-3)] flex items-center justify-between">
            <span>{t('plans.batchList')}</span>
            <span className="font-mono text-xs">{batches.length}</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[var(--t-border)]">
            {isLoadingBatches ? (
              <div className="p-8 text-center text-xs text-[var(--t-text-3)]">
                <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-[var(--t-accent)] mx-auto mb-2" />
                Đang tải...
              </div>
            ) : batches.length === 0 ? (
              <div className="p-8 text-center text-xs text-[var(--t-text-3)]">
                {t('plans.noBatches')}
              </div>
            ) : (
              batches.map((batch) => {
                const isSelected = batch.id === activeBatchId;
                return (
                  <div
                    key={batch.id}
                    data-testid={`batch-item-${batch.id}`}
                    onClick={() => {
                      setDispatchError(null);
                      navigate(`/plans/${batch.id}`);
                    }}
                    className={`p-3.5 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[var(--t-surface-2)] border-l-4 border-l-[var(--t-accent)]'
                        : 'hover:bg-[var(--t-hover)]'
                    }`}
                  >
                    <div className="flex items-start justify-between gap-2">
                      <h3 className="font-semibold text-sm line-clamp-1 text-[var(--t-text)]">
                        {batch.title}
                      </h3>
                      <BatchStatusBadge status={batch.status} />
                    </div>

                    {batch.goal && (
                      <p className="text-xs text-[var(--t-text-3)] line-clamp-2 mt-1">
                        {batch.goal}
                      </p>
                    )}

                    <div className="flex items-center gap-2 mt-2.5 text-[11px] text-[var(--t-text-3)]">
                      <span className="px-1.5 py-0.5 rounded bg-[var(--t-surface)] border border-[var(--t-border)] font-mono">
                        {batch.projectId}
                      </span>
                      <span>•</span>
                      <span>
                        {t('plans.tasksCount', { count: batch.tasks?.length ?? 0 })}
                      </span>
                      <span>•</span>
                      <span>{formatTimeAgo(batch.createdAt)}</span>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        {/* Right Column: Active Batch Details */}
        <div className="flex-1 flex flex-col min-w-0 bg-[var(--t-bg)] overflow-y-auto">
          {isLoadingBatch ? (
            <div className="flex-1 flex items-center justify-center p-12 text-sm text-[var(--t-text-3)]">
              <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-[var(--t-accent)] mr-2" />
              Đang tải chi tiết đợt...
            </div>
          ) : !currentBatch ? (
            <div className="flex-1 flex flex-col items-center justify-center p-12 text-center text-[var(--t-text-3)]">
              <Layers className="w-12 h-12 stroke-1 mb-3 text-[var(--t-text-3)] opacity-40" />
              <p className="text-sm font-medium">{t('plans.selectBatch')}</p>
            </div>
          ) : (
            <div className="p-6 space-y-6 max-w-6xl w-full mx-auto">
              {/* Batch Header Card */}
              <div className="p-5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-xs">
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1.5 flex-1 min-w-[240px]">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h2
                        data-testid="batch-title"
                        className="text-lg font-bold text-[var(--t-text)]"
                      >
                        {currentBatch.title}
                      </h2>
                      <BatchStatusBadge status={currentBatch.status} />
                    </div>

                    <div className="flex items-center gap-3 text-xs text-[var(--t-text-3)] flex-wrap pt-1">
                      <span className="inline-flex items-center gap-1 font-mono">
                        <FolderGit2 className="w-3.5 h-3.5" />
                        {currentBatch.projectId}
                      </span>
                      <span>•</span>
                      <span className="inline-flex items-center gap-1">
                        <User className="w-3.5 h-3.5" />
                        {currentBatch.createdBy || 'unknown'}
                      </span>
                      <span>•</span>
                      <span className="inline-flex items-center gap-1">
                        <Clock className="w-3.5 h-3.5" />
                        {new Date(currentBatch.createdAt).toLocaleString()}
                      </span>
                    </div>
                  </div>

                  {/* Actions for draft batches */}
                  {isDraft && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <Button
                        data-testid="btn-add-task"
                        variant="secondary"
                        size="sm"
                        onClick={() => {
                          resetAddForm();
                          setShowAddModal(true);
                        }}
                      >
                        <Plus className="w-4 h-4 mr-1" />
                        {t('plans.addTask')}
                      </Button>

                      <Button
                        data-testid="btn-discard-batch"
                        variant="ghost"
                        size="sm"
                        className="text-[var(--t-crit)] hover:bg-[var(--t-crit)]/10"
                        onClick={() => setShowDiscardModal(true)}
                        disabled={discardMutation.isPending}
                      >
                        <Trash2 className="w-4 h-4 mr-1" />
                        {t('plans.discardBatch')}
                      </Button>

                      <Button
                        data-testid="btn-dispatch-batch"
                        variant="primary"
                        size="sm"
                        onClick={() => dispatchMutation.mutate()}
                        loading={dispatchMutation.isPending}
                      >
                        <Send className="w-4 h-4 mr-1" />
                        {t('plans.dispatchBatch')}
                      </Button>
                    </div>
                  )}
                </div>

                {/* Batch Goal Banner */}
                {currentBatch.goal ? (
                  <div className="mt-4 p-3 rounded-lg bg-[var(--t-surface-2)] border border-[var(--t-border)] text-xs text-[var(--t-text-2)]">
                    <span className="font-semibold text-[var(--t-text)] mr-1.5">
                      {t('plans.goal')}:
                    </span>
                    {currentBatch.goal}
                  </div>
                ) : (
                  <p className="mt-3 text-xs italic text-[var(--t-text-3)]">
                    {t('plans.noGoal')}
                  </p>
                )}

                {/* Error Banner (e.g. cycle detected) */}
                {dispatchError && (
                  <div
                    data-testid="dispatch-error-alert"
                    className="mt-4 p-3.5 rounded-lg bg-[var(--t-crit)]/10 border border-[var(--t-crit)]/30 text-xs text-[var(--t-crit)] flex items-start gap-2.5"
                  >
                    <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                    <div>
                      <p className="font-semibold">{t('plans.cycleError')}</p>
                      <p className="mt-0.5 text-[11px] opacity-90">{dispatchError}</p>
                    </div>
                  </div>
                )}
              </div>

              {/* Section 1: DAG View */}
              <div className="p-5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-xs">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-semibold text-[var(--t-text)] flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-[var(--t-accent)]" />
                    {t('plans.dagView')}
                  </h3>
                  <span className="text-xs text-[var(--t-text-3)]">
                    {t('plans.tasksCount', { count: batchTasks.length })}
                  </span>
                </div>

                <div
                  data-testid="plans-dag-container"
                  className="w-full h-[320px] rounded-lg border border-[var(--t-border)] overflow-hidden bg-[var(--t-bg)]"
                >
                  <TaskDag
                    tasks={batchTasks}
                    onSelectTask={(task) => {
                      if (isDraft) handleOpenEdit(task);
                    }}
                  />
                </div>
              </div>

              {/* Section 2: Task List Table */}
              <div className="p-5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-xs">
                <div className="flex items-center justify-between mb-4">
                  <h3 className="text-sm font-semibold text-[var(--t-text)]">
                    {t('plans.taskList')}
                  </h3>
                  {isDraft && (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        resetAddForm();
                        setShowAddModal(true);
                      }}
                    >
                      <Plus className="w-3.5 h-3.5 mr-1" />
                      {t('plans.addTask')}
                    </Button>
                  )}
                </div>

                {batchTasks.length === 0 ? (
                  <div className="py-8 text-center text-xs text-[var(--t-text-3)]">
                    Đợt này chưa có task nào
                  </div>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-left text-xs border-collapse">
                      <thead>
                        <tr className="border-b border-[var(--t-border)] text-[var(--t-text-3)] uppercase font-semibold text-[11px]">
                          <th className="py-2.5 px-3">{t('plans.slug')}</th>
                          <th className="py-2.5 px-3">{t('plans.taskTitle')}</th>
                          <th className="py-2.5 px-3">{t('plans.level')}</th>
                          <th className="py-2.5 px-3">{t('plans.modelChain')}</th>
                          <th className="py-2.5 px-3">{t('plans.dependsOn')}</th>
                          <th className="py-2.5 px-3">Trạng thái</th>
                          {isDraft && (
                            <th className="py-2.5 px-3 text-right">Thao tác</th>
                          )}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-[var(--t-border)]">
                        {batchTasks.map((task) => (
                          <tr
                            key={task.id}
                            data-testid={`task-row-${task.id}`}
                            className="hover:bg-[var(--t-hover)] transition-colors"
                          >
                            <td className="py-3 px-3 font-mono text-[var(--t-accent)] font-medium">
                              {task.slug}
                            </td>
                            <td className="py-3 px-3">
                              <div className="font-medium text-[var(--t-text)]">
                                {task.title}
                              </div>
                              {task.body && (
                                <div className="text-[11px] text-[var(--t-text-3)] line-clamp-1 mt-0.5">
                                  {task.body}
                                </div>
                              )}
                            </td>
                            <td className="py-3 px-3">
                              <span
                                className={`px-2 py-0.5 rounded text-[11px] font-medium border ${
                                  task.level === 'hard'
                                    ? 'bg-rose-500/10 text-rose-500 border-rose-500/20'
                                    : 'bg-blue-500/10 text-blue-500 border-blue-500/20'
                                }`}
                              >
                                {t(`plans.${task.level || 'easy'}`)}
                              </span>
                            </td>
                            <td className="py-3 px-3 font-mono text-[11px] text-[var(--t-text-2)]">
                              {toArray(task.modelChain).length > 0
                                ? toArray(task.modelChain).join(', ')
                                : '-'}
                            </td>
                            <td className="py-3 px-3 font-mono text-[11px] text-[var(--t-text-3)]">
                              {toArray(task.dependsOn).length > 0
                                ? toArray(task.dependsOn).join(', ')
                                : '-'}
                            </td>
                            <td className="py-3 px-3">
                              <StatusBadge status={task.status} size="sm" />
                            </td>
                            {isDraft && (
                              <td className="py-3 px-3 text-right">
                                <div className="inline-flex items-center gap-1">
                                  <Button
                                    data-testid={`btn-edit-task-${task.id}`}
                                    variant="ghost"
                                    size="sm"
                                    onClick={() => handleOpenEdit(task)}
                                    title={t('plans.editTask')}
                                  >
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </Button>
                                  <Button
                                    data-testid={`btn-remove-task-${task.id}`}
                                    variant="ghost"
                                    size="sm"
                                    className="text-[var(--t-crit)] hover:bg-[var(--t-crit)]/10"
                                    onClick={() => setTaskToRemove(task)}
                                    title={t('plans.removeTask')}
                                  >
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </Button>
                                </div>
                              </td>
                            )}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Modal: Add Task */}
      <Modal
        isOpen={showAddModal}
        onClose={() => setShowAddModal(false)}
        title={t('plans.addTask')}
      >
        <form onSubmit={handleAddSubmit} className="p-6 space-y-4">
          {addFormError && (
            <div className="p-3 text-xs bg-[var(--t-crit)]/10 text-[var(--t-crit)] border border-[var(--t-crit)]/30 rounded-lg">
              {addFormError}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.slug')} *
            </label>
            <Input
              data-testid="input-add-slug"
              value={newSlug}
              onChange={(e) => setNewSlug(e.target.value)}
              placeholder="e.g. auth-flow"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.taskTitle')} *
            </label>
            <Input
              data-testid="input-add-title"
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder="e.g. Implement authentication flow"
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.level')}
            </label>
            <select
              data-testid="select-add-level"
              value={newLevel}
              onChange={(e) => setNewLevel(e.target.value as TaskLevel)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)]"
            >
              <option value="easy">{t('plans.easy')}</option>
              <option value="hard">{t('plans.hard')}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.modelChain')}
            </label>
            <Input
              data-testid="input-add-modelchain"
              value={newModelChain}
              onChange={(e) => setNewModelChain(e.target.value)}
              placeholder="e.g. agy:claude-sonnet-4-6-thinking, gemini-3.8-flash-high"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.dependsOn')}
            </label>
            {batchTasks.length === 0 ? (
              <p className="text-xs text-[var(--t-text-3)] italic">Không có task nào khác để phụ thuộc</p>
            ) : (
              <div className="max-h-32 overflow-y-auto space-y-1.5 p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
                {batchTasks.map((tItem) => (
                  <label
                    key={tItem.id}
                    className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={newDeps.includes(tItem.slug)}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setNewDeps([...newDeps, tItem.slug]);
                        } else {
                          setNewDeps(newDeps.filter((d) => d !== tItem.slug));
                        }
                      }}
                      className="rounded border-[var(--t-border)] text-[var(--t-accent)]"
                    />
                    <span className="font-mono text-[var(--t-accent)]">{tItem.slug}</span>
                    <span className="text-[var(--t-text-3)] truncate">- {tItem.title}</span>
                  </label>
                ))}
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.taskBody')}
            </label>
            <textarea
              data-testid="textarea-add-body"
              value={newBody}
              onChange={(e) => setNewBody(e.target.value)}
              rows={4}
              placeholder="Chi tiết yêu cầu markdown..."
              className="w-full px-3 py-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)] font-mono resize-y"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--t-border)]">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setShowAddModal(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="btn-submit-add-task"
              type="submit"
              variant="primary"
              size="sm"
              loading={addTaskMutation.isPending}
            >
              {addTaskMutation.isPending ? t('plans.creatingTask') : t('plans.addTask')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Edit Task */}
      <Modal
        isOpen={Boolean(editingTask)}
        onClose={() => setEditingTask(null)}
        title={t('plans.editTask')}
      >
        <form onSubmit={handleEditSubmit} className="p-6 space-y-4">
          {editFormError && (
            <div className="p-3 text-xs bg-[var(--t-crit)]/10 text-[var(--t-crit)] border border-[var(--t-crit)]/30 rounded-lg">
              {editFormError}
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.slug')}
            </label>
            <input
              disabled
              value={editingTask?.slug || ''}
              className="w-full px-3 py-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] opacity-60 text-xs text-[var(--t-text)] font-mono cursor-not-allowed"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.taskTitle')} *
            </label>
            <Input
              data-testid="input-edit-title"
              value={editTitle}
              onChange={(e) => setEditTitle(e.target.value)}
              required
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.level')}
            </label>
            <select
              data-testid="select-edit-level"
              value={editLevel}
              onChange={(e) => setEditLevel(e.target.value as TaskLevel)}
              className="w-full px-3 py-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)]"
            >
              <option value="easy">{t('plans.easy')}</option>
              <option value="hard">{t('plans.hard')}</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.modelChain')}
            </label>
            <Input
              data-testid="input-edit-modelchain"
              value={editModelChain}
              onChange={(e) => setEditModelChain(e.target.value)}
              placeholder="e.g. agy:claude-sonnet-4-6-thinking"
            />
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.dependsOn')}
            </label>
            <div className="max-h-32 overflow-y-auto space-y-1.5 p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]">
              {batchTasks
                .filter((tItem) => tItem.id !== editingTask?.id)
                .map((tItem) => {
                  const isChecked =
                    editDeps.includes(tItem.slug) || editDeps.includes(tItem.id);
                  return (
                    <label
                      key={tItem.id}
                      className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer"
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        onChange={(e) => {
                          if (e.target.checked) {
                            setEditDeps([...editDeps, tItem.slug]);
                          } else {
                            setEditDeps(
                              editDeps.filter(
                                (d) => d !== tItem.slug && d !== tItem.id
                              )
                            );
                          }
                        }}
                        className="rounded border-[var(--t-border)] text-[var(--t-accent)]"
                      />
                      <span className="font-mono text-[var(--t-accent)]">{tItem.slug}</span>
                      <span className="text-[var(--t-text-3)] truncate">- {tItem.title}</span>
                    </label>
                  );
                })}
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-[var(--t-text-2)] mb-1">
              {t('plans.taskBody')}
            </label>
            <textarea
              data-testid="textarea-edit-body"
              value={editBody}
              onChange={(e) => setEditBody(e.target.value)}
              rows={4}
              className="w-full px-3 py-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-xs text-[var(--t-text)] focus:outline-hidden focus:ring-1 focus:ring-[var(--t-accent)] font-mono resize-y"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--t-border)]">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setEditingTask(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="btn-submit-edit-task"
              type="submit"
              variant="primary"
              size="sm"
              loading={updateTaskMutation.isPending}
            >
              {updateTaskMutation.isPending ? t('plans.updatingTask') : t('plans.saveChanges')}
            </Button>
          </div>
        </form>
      </Modal>

      {/* Modal: Confirm Discard Batch */}
      <Modal
        isOpen={showDiscardModal}
        onClose={() => setShowDiscardModal(false)}
        title={t('plans.confirmDiscardTitle')}
      >
        <div className="p-6 space-y-4">
          <p className="text-sm text-[var(--t-text-2)]">
            {t('plans.confirmDiscardMessage')}
          </p>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--t-border)]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setShowDiscardModal(false)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="btn-confirm-discard"
              variant="danger"
              size="sm"
              onClick={() => discardMutation.mutate()}
              loading={discardMutation.isPending}
            >
              {t('plans.discardBatch')}
            </Button>
          </div>
        </div>
      </Modal>

      {/* Modal: Confirm Remove Task */}
      <Modal
        isOpen={Boolean(taskToRemove)}
        onClose={() => setTaskToRemove(null)}
        title={t('plans.confirmRemoveTaskTitle')}
      >
        <div className="p-6 space-y-4">
          <p className="text-sm text-[var(--t-text-2)]">
            {t('plans.confirmRemoveTaskMessage', { title: taskToRemove?.title })}
          </p>
          <div className="flex items-center justify-end gap-2 pt-2 border-t border-[var(--t-border)]">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setTaskToRemove(null)}
            >
              {t('common.cancel')}
            </Button>
            <Button
              data-testid="btn-confirm-remove-task"
              variant="danger"
              size="sm"
              onClick={() => {
                if (taskToRemove) removeTaskMutation.mutate(taskToRemove.id);
              }}
              loading={removeTaskMutation.isPending}
            >
              {t('plans.removeTask')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
};
