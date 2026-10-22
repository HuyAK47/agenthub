import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from 'react-router-dom';
import { getStatus, getProfiles, getClaudeQuota, getClaudeFailover, clearClaudeFailover, getOrphans, reapOrphans, pauseTask, resumeTask, getBrain, getProjects } from '../api/client';
import { getChatSessions, createChatSession, sendChatMessage, retryChatLimitNow } from '../api/chat';
import { subscribeToEvents } from '../api/sse';
import { EventItem } from '../types/api';
import { parseApiTime, formatTimeAgo } from '../lib/time';
import {
  PlayCircle,
  Clock,
  AlertTriangle,
  XCircle,
  Activity,
  Cpu,
  ArrowRight,
  Radio,
  Send,
  HardDrive,
  Play,
  Pause,
  ExternalLink,
  CheckCircle2,
  AlertCircle,
} from 'lucide-react';
import { BrainCard } from '../components/BrainCard';
import { ReviewQueue } from '../components/ReviewQueue';
import { WaitingQueue } from '../components/WaitingQueue';
import { DailyUsageTable } from '../components/DailyUsageTable';
import { ModelBadge } from '../components/ModelBadge';
import { useLocale } from '../context/LocaleContext';
import { CollapsibleList } from '../components/CollapsibleList';
import { QuotaUsage } from '../components/QuotaUsage';
import { Profile, QuotaUsageItem, ProjectBrain } from '../types/api';

function providerUsage(profiles: Profile[], engine: Profile['engine']): QuotaUsageItem[] {
  const rows = profiles.filter((profile) => profile.engine === engine).flatMap((profile) => profile.usage || []);
  const best = new Map<string, QuotaUsageItem>();
  for (const row of rows) {
    const key = `${row.grp}:${row.window}`;
    const previous = best.get(key);
    if (!previous || row.remainingPct > previous.remainingPct) best.set(key, row);
  }
  return [...best.values()].sort((a, b) => a.grp.localeCompare(b.grp) || a.window.localeCompare(b.window));
}

function RunningDuration({ startedAt }: { startedAt: string }) {
  const [elapsed, setElapsed] = useState('');

  useEffect(() => {
    const update = () => {
      const start = parseApiTime(startedAt);
      const now = Date.now();
      const diffSec = Math.max(0, Math.floor((now - start) / 1000));
      const hours = Math.floor(diffSec / 3600);
      const minutes = Math.floor((diffSec % 3600) / 60);
      const seconds = diffSec % 60;

      if (hours > 0) {
        setElapsed(`${hours}h ${minutes}m ${seconds}s`);
      } else {
        setElapsed(`${minutes}m ${seconds}s`);
      }
    };

    update();
    const timer = setInterval(update, 1000);
    return () => clearInterval(timer);
  }, [startedAt]);

  return <span className="font-mono text-xs">{elapsed}</span>;
}

export const DashboardPage: React.FC = () => {
  const { t } = useLocale();
  const navigate = useNavigate();
  const [liveEvents, setLiveEvents] = useState<EventItem[]>([]);
  const [quickChatText, setQuickChatText] = useState('');
  const [isSubmittingQuickChat, setIsSubmittingQuickChat] = useState(false);
  const [isReaping, setIsReaping] = useState(false);

  const { data: status, isLoading, error } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 5000,
  });
  const { data: profiles = [], refetch: refetchProfiles } = useQuery({
    queryKey: ['profiles'],
    queryFn: getProfiles,
    refetchInterval: 30_000,
  });
  const { data: claudeQuota } = useQuery({ queryKey: ['claude-quota'], queryFn: getClaudeQuota, refetchInterval: 30_000 });
  const { data: brainOverview } = useQuery({ queryKey: ['brain'], queryFn: getBrain, refetchInterval: 5000 });
  const { data: claudeFailover } = useQuery({ queryKey: ['claude-failover'], queryFn: getClaudeFailover, refetchInterval: 5000 });
  const failoverMutation = useMutation({ mutationFn: clearClaudeFailover });
  const { data: orphans = [], refetch: refetchOrphans } = useQuery({ queryKey: ['system-orphans'], queryFn: getOrphans, refetchInterval: 30_000 });
  const { data: projects = [] } = useQuery({ queryKey: ['projects'], queryFn: getProjects, refetchInterval: 30_000 });

  const queryClient = useQueryClient();
  const pauseMutation = useMutation({
    mutationFn: (id: string) => pauseTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });
  const resumeMutation = useMutation({
    mutationFn: (id: string) => resumeTask(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['status'] });
    },
  });

  const handleReap = async () => {
    if (isReaping) return;
    setIsReaping(true);
    try {
      await reapOrphans();
      await refetchOrphans();
    } finally {
      setIsReaping(false);
    }
  };

  const handleQuickChat = async (e: React.FormEvent) => {
    e.preventDefault();
    const text = quickChatText.trim();
    if (!text || isSubmittingQuickChat) return;

    try {
      setIsSubmittingQuickChat(true);
      const sessions = await getChatSessions();
      let targetSessionId: string;
      if (sessions.length > 0) {
        targetSessionId = sessions[0].id;
      } else {
        const newSession = await createChatSession({
          title: text.length > 30 ? text.slice(0, 30) + '...' : text,
          mode: 'safe',
        });
        targetSessionId = newSession.id;
      }

      await sendChatMessage(targetSessionId, text);
      navigate(`/chat/${targetSessionId}`);
    } catch (err: any) {
      alert(err.message || t('extra.quickChatError'));
      setIsSubmittingQuickChat(false);
    }
  };

  useEffect(() => {
    const unsub = subscribeToEvents((event) => {
      setLiveEvents((prev) => [event, ...prev.filter((e) => e.id !== event.id)].slice(0, 20));
    });
    return unsub;
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[50vh]">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
      </div>
    );
  }

  if (error || !status) {
    return (
      <div className="p-6 bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] rounded-xl border border-[var(--t-crit)]">
        {t('dashboard.loadError')}
      </div>
    );
  }

  const taskCounts = status.tasks || status.tasksByStatus || {};
  const runningCount = taskCounts.running || 0;
  const checkingCount = taskCounts.checking || 0;
  const reviewCount = taskCounts.review || 0;
  const waitingQuotaCount = taskCounts.waiting_quota || 0;
  const errorCount = (taskCounts.failed || 0) + (taskCounts.blocked || 0);
  const workers = status.running || status.runningWorkers || [];
  const events = liveEvents.length > 0 ? liveEvents : status.recentEvents || [];

  const metrics = [
    {
      label: t('status.running'),
      value: runningCount,
      icon: PlayCircle,
      statusKey: 'running',
    },
    {
      label: t('status.checking'),
      value: checkingCount,
      icon: Activity,
      statusKey: 'checking',
    },
    {
      label: t('dashboard.reviewCount'),
      value: reviewCount,
      icon: Clock,
      statusKey: 'review',
    },
    {
      label: t('status.waiting_quota'),
      value: waitingQuotaCount,
      icon: AlertTriangle,
      statusKey: 'waiting_quota',
    },
    {
      label: t('status.failed'),
      value: errorCount,
      icon: XCircle,
      statusKey: 'failed',
    },
  ];

  return (
    <div className="space-y-8">
      {/* Page Title */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-[var(--text-primary)]">{t('dashboard.title')}</h1>
          <p className="text-sm text-[var(--text-secondary)]">
            {t('dashboard.subtitle')}
          </p>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          {status.disk && (
            <div
              data-testid="disk-status"
              className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border transition-colors ${
                (status.disk.minFreeGB !== undefined ? status.disk.freeGB < status.disk.minFreeGB : status.disk.freeGB < 5)
                  ? 'text-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] border-[var(--t-warn)] font-medium'
                  : 'text-[var(--t-text-2)] bg-[var(--t-surface-2)] border-[var(--t-border)]'
              }`}
            >
              <HardDrive className="w-3.5 h-3.5" />
              <span>
                {status.disk.minFreeGB !== undefined
                  ? t('extra.diskFreeWithMin', { free: status.disk.freeGB, total: status.disk.totalGB, min: status.disk.minFreeGB })
                  : t('extra.diskFree', { free: status.disk.freeGB, total: status.disk.totalGB })}
              </span>
            </div>
          )}
          {status.load && (
            <div
              data-testid="load-status"
              className={`flex items-center gap-2 text-xs px-3 py-1.5 rounded-full border ${
                status.load.overloaded
                  ? 'text-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] border-[var(--t-warn)] font-medium'
                  : 'text-[var(--t-text-2)] bg-[var(--t-surface-2)] border-[var(--t-border)]'
              }`}
            >
              <Cpu className="w-3.5 h-3.5" />
              <span>{status.load.overloaded ? t('dashboard.loadReducing') : t('dashboard.loadNormal')}</span>
              <span>{status.load.load1.toFixed(1)} · {status.load.freeMemGB.toFixed(1)} GB</span>
            </div>
          )}
          <div className="flex items-center gap-2 text-xs text-[var(--t-ok)] bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] px-3 py-1.5 rounded-full border border-[var(--t-ok)]">
            <Radio className="w-3.5 h-3.5 animate-pulse" />
            <span>{t('dashboard.online')}</span>
          </div>
        </div>
      </div>

      {status.disks && status.disks.length > 0 && (
        <div data-testid="monitored-disks" className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {status.disks.map((disk) => (
            <div key={`${disk.label}:${disk.path}`} className={`rounded-xl border p-4 ${disk.low ? 'border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_10%,transparent)]' : 'border-[var(--border-default)] bg-[var(--bg-surface)]'}`}>
              <div className="flex items-center justify-between gap-2">
                <span className="font-semibold text-sm">{disk.label}</span>
                <HardDrive className="w-4 h-4 text-[var(--t-text-2)]" />
              </div>
              <div className="mt-2 text-xs text-[var(--text-secondary)]">
                {disk.freeGB} / {disk.totalGB} GB trống · ngưỡng {disk.minFreeGB} GB
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Brain Card */}
      {status.brain && <BrainCard brain={status.brain} quota={claudeQuota} onRetryLimit={() => retryChatLimitNow('brain')} />}
      {brainOverview?.brains && <div data-testid="project-brains" className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 space-y-3">
        <h2 className="text-base font-semibold">{t('dashboard.brains')}</h2>
        {brainOverview.brains.map((brain: ProjectBrain) => <div key={brain.projectId || 'system'} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--t-border)] pt-3 first:border-0 first:pt-0" data-testid={`brain-row-${brain.projectId || 'system'}`}>
          <div><div className="font-medium text-sm">{brain.projectName}</div><div className="text-xs text-[var(--text-secondary)]">{t('dashboard.brainMode')}: {t(`dashboard.brainMode_${brain.mode}`)} · {t('projects.brainPermissions')}: {brain.permissions} · Mode phiên: {brain.sessionMode || 'safe'} · {t(`dashboard.brainState${brain.state}`)}{brain.queued ? ` · ${t('dashboard.brainQueued')}` : ''}</div>{brain.directives?.length ? <div className="mt-1 text-xs text-[var(--text-secondary)]">📌 {brain.directives.map((directive) => directive.text).join(' · ')}</div> : null}</div>
          <div className="flex items-center gap-3 text-xs"><span>{t('dashboard.brainTokens')}: {brain.tokensToday.toLocaleString()}</span><Link to={`/chat/${encodeURIComponent(brain.sessionId)}`} className="text-[var(--t-accent)] hover:underline">{t('dashboard.openBrainChat')}</Link></div>
        </div>)}
        {brainOverview.assistants?.map((assistant) => <div key={`assistant-${assistant.projectId || 'system'}`} className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--t-border)] pt-3" data-testid={`assistant-row-${assistant.projectId || 'system'}`}>
          <div><div className="font-medium text-sm">{t('dashboard.assistant')} · {assistant.projectName}</div><div className="text-xs text-[var(--text-secondary)]">{assistant.busy ? t('dashboard.assistantWorking') : t('dashboard.assistantReady')}</div></div>
          <Link to={`/chat/${encodeURIComponent(assistant.sessionId)}`} className="text-xs text-[var(--t-accent)] hover:underline">{t('dashboard.openAssistantChat')}</Link>
        </div>)}
      </div>}

      {/* CI Card */}
      <div data-testid="dashboard-ci" className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-[var(--t-accent)]" />
            <h2 className="text-base font-semibold">{t('dashboard.ciCardTitle')}</h2>
          </div>
          <span className="text-xs text-[var(--text-secondary)]">{t('dashboard.ciCardSubtitle')}</span>
        </div>
        {projects.length === 0 ? (
          <p className="text-xs text-[var(--text-secondary)]">{t('dashboard.ciCardNoData')}</p>
        ) : (
          <div className="space-y-2">
            {projects.map((proj) => {
              const ci = proj.ciStatus;
              return (
                <div
                  key={proj.id}
                  data-testid={`dashboard-ci-${proj.id}`}
                  className="flex items-center justify-between border-t border-[var(--t-border)] pt-2.5 first:border-0 first:pt-0 text-xs"
                >
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-sm">{proj.name}</span>
                    <span className="font-mono text-[var(--text-secondary)]">({proj.id})</span>
                  </div>
                  <div className="flex items-center gap-2">
                    {!ci ? (
                      <span className="text-[var(--text-secondary)] italic">{t('projects.ciNoRun')}</span>
                    ) : ci.status !== 'completed' ? (
                      <span className="inline-flex items-center gap-1 text-[var(--t-warn)] font-medium">
                        <Clock className="w-3.5 h-3.5 animate-spin" />
                        <span>{t('dashboard.ciRunning')}</span>
                        {ci.sha && <span className="font-mono">({ci.sha.slice(0, 7)})</span>}
                      </span>
                    ) : ci.conclusion === 'success' ? (
                      <span className="inline-flex items-center gap-1 text-[var(--t-ok)] font-medium">
                        <CheckCircle2 className="w-3.5 h-3.5" />
                        <span>{t('dashboard.ciPassed')}</span>
                        {ci.sha && <span className="font-mono">({ci.sha.slice(0, 7)})</span>}
                      </span>
                    ) : (
                      <span className="inline-flex items-center gap-1 text-[var(--t-crit)] font-medium">
                        <AlertCircle className="w-3.5 h-3.5" />
                        <span>{t('dashboard.ciFailed')}</span>
                        {ci.sha && <span className="font-mono">({ci.sha.slice(0, 7)})</span>}
                      </span>
                    )}
                    {ci?.url && (
                      <a
                        href={ci.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[var(--t-accent)] hover:underline ml-2"
                        title={t('projects.ciViewRun')}
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Metric Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-4">
        {metrics.map((m) => {
          const Icon = m.icon;
          return (
            <div
              key={m.label}
              className="p-5 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-xs flex items-center justify-between transition-colors"
            >
              <div className="space-y-1">
                <p className="text-xs font-medium text-[var(--text-secondary)]">{m.label}</p>
                <p className="text-3xl font-extrabold tracking-tight text-[var(--text-primary)]">{m.value}</p>
              </div>
              <div
                style={{
                  backgroundColor: `var(--status-${m.statusKey}-bg)`,
                  color: `var(--status-${m.statusKey}-text)`,
                  borderColor: `var(--status-${m.statusKey}-border)`,
                }}
                className="p-3 rounded-xl border"
              >
                <Icon className="w-6 h-6" />
              </div>
            </div>
          );
        })}
      </div>

      {/* Running workers */}
      <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] overflow-hidden shadow-xs transition-colors">
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Cpu className="w-5 h-5 text-[var(--t-accent)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('dashboard.runningWorkers')}</h2>
          </div>
          <span className="text-xs text-[var(--text-secondary)]">
            {t('extra.workersExecuting', { count: workers.length })}
          </span>
        </div>

        {workers.length === 0 ? (
          <div className="p-8 text-center text-[var(--text-secondary)] text-sm">
            {t('extra.noWorkers')}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] text-xs uppercase font-medium">
                <tr>
                  <th className="px-6 py-3">Task</th>
                  <th className="px-6 py-3">Project</th>
                  <th className="px-6 py-3">Model</th>
                  <th className="px-6 py-3">{t('dashboard.thProfile')}</th>
                  <th className="px-6 py-3">{t('dashboard.thElapsed')}</th>
                  <th className="px-6 py-3">{t('dashboard.thResources')}</th>
                  <th className="px-6 py-3 text-right">{t('dashboard.thDetails')}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {workers.map((worker) => {
                  const parts = worker.taskId.includes('/')
                    ? worker.taskId.split('/')
                    : worker.taskId.split('~');
                  const projectId = worker.projectId || parts[0] || 'unknown';
                  // Requirement 7: if item has title, display title; otherwise taskId
                  const displayTitle = worker.title ? worker.title : worker.taskId;
                  const routeId = worker.taskId.replace('/', '~');

                  return (
                    <tr key={worker.taskId} className="hover:bg-[var(--bg-surface-hover)] transition-colors">
                      <td className="px-6 py-4">
                        <Link
                          to={`/tasks/${encodeURIComponent(routeId)}`}
                          className="font-medium text-[var(--t-accent)] hover:underline flex items-center gap-1.5"
                        >
                          <span>{displayTitle}</span>
                        </Link>
                        {worker.title && worker.title !== worker.taskId && (
                          <div className="text-xs text-[var(--text-muted)] font-mono mt-0.5">{worker.taskId}</div>
                        )}
                        {worker.paused && (
                          <div className="mt-1.5">
                            <span
                              data-testid={`worker-paused-${worker.taskId}`}
                              className={`inline-flex items-center rounded px-1.5 py-0.5 text-[11px] font-medium border ${
                                worker.pauseReason === 'load'
                                  ? 'bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]'
                                  : 'bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] border-[var(--border-subtle)]'
                              }`}
                            >
                              {worker.pauseReason === 'load' ? t('status.pausedOverload') : t('status.paused')}
                            </span>
                          </div>
                        )}
                        {((worker.noCommitMinutes != null && worker.noCommitMinutes > 0) || worker.isLooping) && (
                          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
                            {worker.noCommitMinutes != null && worker.noCommitMinutes > 0 && (
                              <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-warn)] border border-[color-mix(in_srgb,var(--t-warn)_30%,transparent)]">
                                {t('extra.noCommit', { minutes: worker.noCommitMinutes })}
                              </span>
                            )}
                            {worker.isLooping && (
                              <span className="inline-flex items-center rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] px-1.5 py-0.5 text-[11px] font-medium text-[var(--t-crit)] border border-[color-mix(in_srgb,var(--t-crit)_30%,transparent)]">
                                {t('extra.looping')}
                              </span>
                            )}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4">
                        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)]">
                          {projectId}
                        </span>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <ModelBadge model={worker.model} engine={worker.engine} />
                      </td>
                      <td className="px-6 py-4 font-medium text-[var(--text-primary)]">{worker.profileName}</td>
                      <td className="px-6 py-4 text-[var(--text-secondary)]">
                        <RunningDuration startedAt={worker.startedAt} />
                      </td>
                      <td className="px-6 py-4 text-xs text-[var(--text-secondary)] whitespace-nowrap">
                        <div className="font-mono">
                          {worker.rss ? `${(worker.rss / (1024 * 1024)).toFixed(0)} MB` : '0 MB'}
                        </div>
                        <div className="text-[11px] text-[var(--text-muted)] font-mono">
                          {(worker.cpu ?? 0).toFixed(1)}% CPU
                        </div>
                      </td>
                      <td className="px-6 py-4 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-2">
                          {worker.paused ? (
                            <button
                              type="button"
                              onClick={() => resumeMutation.mutate(worker.taskId)}
                              disabled={resumeMutation.isPending}
                              className="px-2.5 py-1 text-xs font-medium rounded-md bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] hover:bg-[color-mix(in_srgb,var(--t-ok)_25%,transparent)] border border-[color-mix(in_srgb,var(--t-ok)_30%,transparent)] inline-flex items-center gap-1 cursor-pointer"
                              title={t('dashboard.btnResume')}
                            >
                              <Play className="w-3 h-3" />
                              <span>{t('dashboard.btnResume')}</span>
                            </button>
                          ) : (
                            <button
                              type="button"
                              onClick={() => pauseMutation.mutate(worker.taskId)}
                              disabled={pauseMutation.isPending}
                              className="px-2.5 py-1 text-xs font-medium rounded-md bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-subtle)] inline-flex items-center gap-1 cursor-pointer"
                              title={t('dashboard.btnPause')}
                            >
                              <Pause className="w-3 h-3" />
                              <span>{t('dashboard.btnPause')}</span>
                            </button>
                          )}
                          <Link
                            to={`/tasks/${encodeURIComponent(routeId)}`}
                            className="text-xs font-medium text-[var(--t-accent)] hover:text-[var(--t-accent)] inline-flex items-center gap-1"
                          >
                            {t('common.view')} <ArrowRight className="w-3.5 h-3.5" />
                          </Link>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Review queue */}
      <ReviewQueue activeTaskId={status.brain?.taskId} />

      {/* Waiting queue */}
      <WaitingQueue
        diskFreeGB={(status.disks?.find((disk) => disk.low) ?? status.disks?.[0])?.freeGB ?? status.disk?.freeGB}
        diskMinFreeGB={(status.disks?.find((disk) => disk.low) ?? status.disks?.[0])?.minFreeGB ?? status.disk?.minFreeGB}
        diskLabel={(status.disks?.find((disk) => disk.low) ?? status.disks?.[0])?.label}
      />

      {status.overlaps && status.overlaps.length > 0 && (
        <div
          data-testid="overlap-warnings"
          className="rounded-xl border border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_10%,transparent)] p-4 space-y-2"
        >
          <div className="flex items-center gap-2 text-[var(--t-warn)] font-semibold text-sm">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            <span>{t('dashboard.overlapWarningTitle')}</span>
          </div>
          <p className="text-xs text-[var(--text-secondary)]">
            {t('dashboard.overlapWarningDesc', { count: status.overlaps.length })}
          </p>
          <ul className="space-y-1.5 text-xs">
            {status.overlaps.map((ov) => (
              <li key={ov.id} className="flex items-center gap-2 text-[var(--text-primary)]">
                <span className="font-mono px-1.5 py-0.5 rounded bg-[var(--bg-surface)] border border-[var(--border-default)]">
                  {ov.taskId}
                </span>
                <span>{ov.content}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div data-testid="dashboard-provider-quotas" className="grid gap-4 md:grid-cols-3">
        {([
          ['agy', 'Antigravity'],
          ['codex', 'Codex'],
          ['claude', 'Claude'],
        ] as const).map(([engine, label]) => {
          const engineProfiles = profiles.filter((profile) => profile.engine === engine);
          return (
            <div key={engine} className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 shadow-xs">
              <div className="mb-2 flex items-center justify-between gap-2">
                <h2 className="text-sm font-semibold text-[var(--text-primary)]">Quota {label}</h2>
                <span className="text-[11px] text-[var(--text-secondary)]">{engineProfiles.length} hồ sơ</span>
              </div>
              <QuotaUsage usage={providerUsage(profiles, engine)} onRefresh={() => { void refetchProfiles(); }} />
              {engine === 'claude' && engineProfiles.some((profile) => profile.claudeTokens) && (
                <div className="mt-2 text-xs text-[var(--text-secondary)]">
                  Token hôm nay: {Math.round(engineProfiles.reduce((sum, profile) => sum + (profile.claudeTokens?.today || 0), 0)).toLocaleString()}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {claudeQuota && <div className="rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] p-4 flex items-center justify-between">
        <span className="font-semibold text-sm">{t('extra.claudeQuota')}</span>
        <span className="text-sm">{claudeQuota.profiles?.length ? claudeQuota.profiles.map((p) => `${p.profileName}: ${p.status || t('extra.unknown')} (${p.source}, ${new Date(p.observedAt).toLocaleTimeString()})`).join(' · ') : `${claudeQuota.status || t('extra.unknown')}${claudeQuota.resetsAt ? ` · ${new Date(claudeQuota.resetsAt * 1000).toLocaleTimeString()}` : ''}`}</span>
      </div>}
      {claudeFailover && <div data-testid="claude-failover" className={`rounded-xl border p-4 ${claudeFailover.active ? 'border-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_10%,transparent)]' : 'border-[var(--border-default)] bg-[var(--bg-surface)]'}`}>
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0">
            <div className="font-semibold text-sm">Failover Claude: {claudeFailover.active ? 'ĐANG BẬT' : 'đang tắt'}</div>
            {claudeFailover.active && claudeFailover.step && <div className="text-sm mt-1">Đang dùng: {claudeFailover.step.type === 'model' ? claudeFailover.step.model : claudeFailover.step.type === 'profile' ? `tài khoản ${claudeFailover.step.profile || 'khác'}` : claudeFailover.step.type === 'apiKey' ? `API key (đã dùng $${claudeFailover.dailyCostUSD.toFixed(2)}/$${claudeFailover.step.dailyCapUSD ?? 0})` : claudeFailover.step.type === 'engine' ? claudeFailover.step.engine : 'chờ reset'}</div>}
            {claudeFailover.reason && <div className="text-xs mt-1">Lý do: {claudeFailover.reason}</div>}
            {claudeFailover.evidence && <div className="text-xs text-[var(--text-secondary)] mt-1 truncate">Bằng chứng: {claudeFailover.evidence.file}:{claudeFailover.evidence.line} · {new Date(claudeFailover.evidence.observedAt).toLocaleString()}</div>}
          </div>
          {claudeFailover.active && <button type="button" onClick={() => failoverMutation.mutate()} disabled={failoverMutation.isPending} className="shrink-0 px-3 py-2 rounded-lg bg-[var(--t-warn)] text-white text-xs font-semibold disabled:opacity-50">{failoverMutation.isPending ? 'Đang tắt…' : 'Tắt failover'}</button>}
        </div>
      </div>}

      {/* Compact quick chat */}
      <div className="p-4 rounded-xl border border-[var(--border-default)] bg-[var(--bg-surface)] shadow-xs transition-colors">
        <form onSubmit={handleQuickChat} className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
          <div className="flex items-center gap-2 text-xs font-semibold text-[var(--text-primary)] shrink-0">
            <div className="w-6 h-6 rounded-full bg-[var(--t-claude)] text-white font-bold text-xs flex items-center justify-center shadow-xs">
              C
            </div>
            <span>{t('extra.quickChat')}</span>
          </div>

          <div className="flex-1 relative">
            <input
              type="text"
              value={quickChatText}
              onChange={(e) => setQuickChatText(e.target.value)}
              placeholder={t('extra.quickChatPlaceholder')}
              disabled={isSubmittingQuickChat}
              className="w-full text-xs rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)] disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            disabled={!quickChatText.trim() || isSubmittingQuickChat}
            className="px-4 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold inline-flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-40 disabled:cursor-not-allowed cursor-pointer shrink-0 transition-colors"
          >
            <Send className="w-3.5 h-3.5" />
            <span>{isSubmittingQuickChat ? t('extra.sending') : t('extra.send')}</span>
          </button>
        </form>
      </div>

      <div data-testid="orphan-processes" className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] overflow-hidden shadow-xs">
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">Tiến trình mồ côi</h2>
            <p className="text-xs text-[var(--text-secondary)]">Các tiến trình còn giữ cwd trong worktree đã dừng.</p>
          </div>
          <button type="button" onClick={handleReap} disabled={isReaping || orphans.length === 0} className="px-3 py-2 rounded-lg bg-[var(--t-crit)] text-white text-xs font-semibold disabled:opacity-40 disabled:cursor-not-allowed">
            {isReaping ? 'Đang dọn…' : 'Dọn'} ({orphans.length})
          </button>
        </div>
        {orphans.length > 0 && (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)]">
                <tr><th className="px-6 py-3">PID</th><th className="px-6 py-3">CWD</th><th className="px-6 py-3">CPU</th><th className="px-6 py-3">RSS</th><th className="px-6 py-3">Task</th></tr>
              </thead>
              <tbody className="divide-y divide-[var(--border-subtle)]">
                {orphans.map((orphan) => <tr key={orphan.pid}>
                  <td className="px-6 py-3 font-mono">{orphan.pid}</td>
                  <td className="px-6 py-3 font-mono max-w-sm truncate" title={orphan.cwd}>{orphan.cwd}</td>
                  <td className="px-6 py-3">{orphan.cpu.toFixed(1)}%</td>
                  <td className="px-6 py-3">{(orphan.rss / 1024 / 1024).toFixed(1)} MB</td>
                  <td className="px-6 py-3">{orphan.task?.title || orphan.task?.id || 'Không xác định'}</td>
                </tr>)}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daily Usage Table */}
      <DailyUsageTable />

      {/* Recent events */}
      <div className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] overflow-hidden shadow-xs transition-colors">
        <div className="px-6 py-4 border-b border-[var(--border-default)] flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Activity className="w-5 h-5 text-[var(--t-purple)]" />
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('dashboard.eventStream')}</h2>
          </div>
          <span className="text-xs text-[var(--text-secondary)]">{t('dashboard.realtime')}</span>
        </div>

        {events.length === 0 ? (
          <div className="p-8 text-center text-[var(--text-secondary)] text-sm">
            {t('dashboard.noEvents')}
          </div>
        ) : (
          <ul className="divide-y divide-[var(--border-subtle)]">
            <CollapsibleList items={events} initial={10} step={10} storageKey="agenthub:dashboard:events" className="contents">
            {(event) => {
              const isClaude =
                event.type === 'brain.status' ||
                (typeof event.payload === 'object' &&
                  event.payload !== null &&
                  (event.payload as Record<string, unknown>).by === 'claude-review');

              return (
                <li
                  key={event.id}
                  className="px-6 py-3.5 flex items-center justify-between gap-4 text-sm hover:bg-[var(--bg-surface-hover)] transition-colors"
                >
                  <div className="flex items-center gap-3 min-w-0">
                    {isClaude && (
                      <span
                        data-testid="claude-event-icon"
                        className="w-5 h-5 rounded-full flex items-center justify-center font-bold text-white text-[10px] shrink-0 shadow-2xs select-none"
                        style={{ backgroundColor: 'var(--t-claude)' }}
                        title="Claude Code"
                      >
                        C
                      </span>
                    )}
                    <span className="font-mono text-xs px-2 py-0.5 rounded bg-[var(--bg-surface-subtle)] text-[var(--text-primary)] border border-[var(--border-subtle)] shrink-0">
                      {event.type}
                    </span>
                    {event.taskId && (
                      <Link
                        to={`/tasks/${encodeURIComponent(event.taskId.replace('/', '~'))}`}
                        className="text-xs font-mono text-[var(--t-accent)] hover:underline shrink-0"
                      >
                        {event.taskId}
                      </Link>
                    )}
                    {event.payload && (
                      <span className="text-xs text-[var(--text-secondary)] truncate font-mono">
                        {JSON.stringify(event.payload)}
                      </span>
                    )}
                  </div>
                  <span className="text-xs text-[var(--text-muted)] shrink-0" title={Number.isFinite(parseApiTime(event.ts)) ? new Date(parseApiTime(event.ts)).toISOString() : String(event.ts)}>{formatTimeAgo(event.ts)}</span>
                </li>
              );
            }}
            </CollapsibleList>
          </ul>
        )}
      </div>
    </div>
  );
};
