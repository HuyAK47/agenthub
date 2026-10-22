import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from 'react-router-dom';
import { apiFetch, rescanClaudeSessions } from '../api/client';
import { Card } from '../components/ui/Card';
import { useLocale } from '../context/LocaleContext';
import { formatNumber } from '../utils/format';
import { CollapsibleList } from '../components/CollapsibleList';

type TaskUsage = { taskId: string; effectiveTokens: number };
type Session = { sessionId: string; cwd: string; title: string | null; model: string | null; messages: number; effectiveTokens: number; lastAt: string | null; active: boolean; topTasks: TaskUsage[]; limitResetAt?: number | null; autoResumeEnabled?: number };
type Turn = { ts: string; turnId: string; effectiveTokens: number; input: number; output: number; tasks: TaskUsage[] };
type SessionDetail = Session & { turns: Turn[] };
const formatTokens = (value: number, locale: string) => formatNumber(value, { locale });
const formatTaskId = (id: string, outsideLabel: string) => (id === '_general' ? outsideLabel : id);

const SessionTable: React.FC<{ sessions: Session[] }> = ({ sessions }) => {
  const { t, locale } = useLocale();
  return (
    <Card>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-[var(--t-text-3)]">
              <th className="py-2">{t('extra.claudeSessions')}</th>
              <th>{t('extra.model')}</th>
              <th>{t('extra.messages')}</th>
              <th>{t('extra.token')}</th>
              <th>{t('extra.task')}</th>
              <th>{t('extra.lastActive')}</th>
            </tr>
          </thead>
          <tbody>
            <CollapsibleList items={sessions} initial={20} step={20} storageKey="agenthub:claude-sessions" tableColSpan={6}>
            {(session) => (
              <tr className="border-t border-[var(--t-border)]" key={session.sessionId}>
                <td className="py-3 min-w-[260px]">
                  <Link className="hover:text-[var(--t-accent)]" to={`/claude-sessions/${encodeURIComponent(session.sessionId)}`}>
                    <span
                      className={`inline-block w-2 h-2 rounded-full mr-2 ${session.active ? 'bg-[var(--t-ok)]' : 'bg-[var(--t-text-3)]'}`}
                      title={session.active ? t('claudeSessions.active') : ''}
                    />
                    {session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId)}
                  </Link>
                  <div className="text-xs text-[var(--t-text-3)] truncate max-w-[320px]">{session.cwd}</div>
                </td>
                <td>{session.model || t('extra.unknown')}</td>
                <td>{session.messages}</td>
                <td>{formatTokens(session.effectiveTokens, locale)}</td>
                <td className="max-w-[220px]">
                  {session.topTasks.length > 0
                    ? session.topTasks
                        .map((task) => `${formatTaskId(task.taskId, t('claudeSessions.outsideTask'))} (${formatTokens(task.effectiveTokens, locale)})`)
                        .join(', ')
                    : t('claudeSessions.outsideTask')}
                </td>
                <td>{session.lastAt ? new Date(session.lastAt).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US') : ''}</td>
              </tr>
            )}
            </CollapsibleList>
          </tbody>
        </table>
      </div>
    </Card>
  );
};

const TurnChart: React.FC<{ turns: Turn[]; label: string }> = ({ turns, label }) => {
  const max = Math.max(1, ...turns.map((turn) => turn.effectiveTokens));
  const width = Math.max(500, turns.length * 28);
  return (
    <svg className="w-full h-40" viewBox={`0 0 ${width} 120`} role="img" aria-label={label}>
      {turns.map((turn, index) => {
        const height = (turn.effectiveTokens / max) * 90;
        return <rect key={turn.turnId} x={index * Math.max(28, 500 / Math.max(1, turns.length))} y={105 - height} width="16" height={height} rx="3" fill="var(--t-claude)" />;
      })}
    </svg>
  );
};

const SessionDetail: React.FC<{ data: SessionDetail; sessionId: string }> = ({ data, sessionId }) => {
  const { t, locale } = useLocale();
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <Link className="text-[var(--t-accent)] text-sm" to="/claude-sessions">← {t('extra.claudeSessions')}</Link>
      <Card>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-xl font-semibold">{data.title || (sessionId.length > 8 ? sessionId.slice(0, 8) : sessionId)}</h1>
          {data.active && (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] text-[var(--t-ok)] border border-[color-mix(in_srgb,var(--t-ok)_30%,transparent)]">
              <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-ok)] animate-pulse" />
              {t('claudeSessions.active')}
            </span>
          )}
        </div>
        <p className="text-sm text-[var(--t-text-3)] mt-1 break-all">{data.cwd} · {data.model || t('extra.unknown')}</p>
        <label className="flex items-center gap-2 mt-4 text-sm cursor-pointer">
          <input
            type="checkbox"
            checked={data.autoResumeEnabled === 1}
            onChange={(event) => {
              void apiFetch(`/api/claude/sessions/${encodeURIComponent(sessionId)}/auto-resume`, {
                method: 'PATCH',
                body: JSON.stringify({ enabled: event.target.checked }),
              });
            }}
          />
          {t('claudeSessions.autoResumeLimit')}
        </label>
        {data.limitResetAt ? (
          <p className="text-sm text-[var(--t-warn)] mt-2">
            {t('claudeSessions.rateLimit5h', {
              time: new Date(data.limitResetAt * 1000 + 60_000).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US'),
            })}
          </p>
        ) : null}
        <h2 className="font-semibold mt-6 mb-2">{t('extra.tokensOverTime')}</h2>
        <TurnChart turns={data.turns} label={t('extra.tokensOverTime')} />
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[var(--t-text-3)]">
                <th className="py-2">{t('extra.tokensOverTime')}</th>
                <th>{t('extra.token')}</th>
                <th>{t('extra.task')}</th>
              </tr>
            </thead>
            <tbody>
              {data.turns.map((turn) => (
                <tr className="border-t border-[var(--t-border)]" key={`${turn.turnId}-${turn.ts}`}>
                  <td className="py-2">{new Date(turn.ts).toLocaleString(locale === 'vi' ? 'vi-VN' : 'en-US')}</td>
                  <td>{formatTokens(turn.effectiveTokens, locale)}</td>
                  <td>
                    {turn.tasks.length > 0
                      ? turn.tasks
                          .map((task) => `${formatTaskId(task.taskId, t('claudeSessions.outsideTask'))} (${formatTokens(task.effectiveTokens, locale)})`)
                          .join(', ')
                      : t('claudeSessions.outsideTask')}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
};

export const ClaudeSessionsPage: React.FC = () => {
  const { t } = useLocale();
  const { sessionId } = useParams();
  const queryClient = useQueryClient();
  const sessions = useQuery({ queryKey: ['claude-sessions'], queryFn: () => apiFetch<Session[]>('/api/claude/sessions') });
  const detail = useQuery({ queryKey: ['claude-session', sessionId], queryFn: () => apiFetch<SessionDetail>(`/api/claude/sessions/${encodeURIComponent(sessionId!)}`), enabled: !!sessionId });
  const rescan = useMutation({ mutationFn: rescanClaudeSessions, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['claude-sessions'] }) });

  if (sessionId && detail.data) return <SessionDetail data={detail.data} sessionId={sessionId} />;
  return (
    <div className="space-y-4 max-w-6xl mx-auto">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold">{t('extra.claudeSessions')}</h1>
          <p className="text-xs text-[var(--t-text-3)] mt-0.5">{t('claudeSessions.scopeNote')}</p>
        </div>
        <button
          type="button"
          onClick={() => rescan.mutate()}
          disabled={rescan.isPending}
          className="rounded-lg bg-[var(--t-accent)] text-white px-3 py-2 text-sm disabled:opacity-50 self-start sm:self-auto cursor-pointer"
        >
          {rescan.isPending ? '…' : t('extra.rescan')}
        </button>
      </div>
      <SessionTable sessions={sessions.data || []} />
    </div>
  );
};
