import React from 'react';
import { ChatSession } from '../../types/api';
import {
  Plus,
  MessageSquare,
  ShieldCheck,
  AlertTriangle,
  Trash2,
  Clock,
} from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

interface ChatSessionListProps {
  sessions: ChatSession[];
  activeSessionId?: string | null;
  onSelectSession: (session: ChatSession) => void;
  onNewSession: () => void;
  onDeleteSession: (sessionId: string) => void;
  isDeletingId?: string | null;
}

function formatRelativeTime(dateString: string, t: (key: string, params?: Record<string, string | number>) => string): string {
  try {
    const date = new Date(dateString);
    const now = new Date();
    const diffSec = Math.floor((now.getTime() - date.getTime()) / 1000);

    if (diffSec < 60) return t('extra.justNow');
    if (diffSec < 3600) return t('extra.minutesAgo', { count: Math.floor(diffSec / 60) });
    if (diffSec < 86400) return t('extra.hoursAgo', { count: Math.floor(diffSec / 3600) });
    return date.toLocaleDateString();
  } catch {
    return dateString;
  }
}

export const ChatSessionList: React.FC<ChatSessionListProps> = ({
  sessions,
  activeSessionId,
  onSelectSession,
  onNewSession,
  onDeleteSession,
  isDeletingId,
}) => {
  const { t } = useLocale();
  return (
    <div className="flex flex-col h-full bg-[var(--bg-surface)] border-r border-[var(--border-default)]">
      {/* Top Header / New Chat Button */}
      <div className="p-3 border-b border-[var(--border-default)]">
        <button
          type="button"
          onClick={onNewSession}
          className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white font-medium text-xs shadow-xs transition-colors cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>+ {t('extra.newChat')}</span>
        </button>
      </div>

      {/* Session list */}
      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        {sessions.length === 0 ? (
          <div className="p-6 text-center text-xs text-[var(--text-secondary)]">
            {t('extra.noChats')}
          </div>
        ) : (
          sessions.map((session) => {
            const isActive = session.id === activeSessionId;
            return (
              <div
                key={session.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelectSession(session)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    onSelectSession(session);
                  }
                }}
                className={`group relative p-3 rounded-xl cursor-pointer transition-all border text-left ${
                  isActive
                    ? 'bg-[var(--t-selected)] border-[var(--t-accent)]/30 text-[var(--text-primary)]'
                    : 'border-transparent hover:bg-[var(--bg-surface-hover)] text-[var(--text-primary)]'
                }`}
              >
                <div className="flex items-start justify-between gap-2">
                  <div className="flex items-center gap-2 min-w-0 flex-1">
                    <MessageSquare
                      className={`w-4 h-4 shrink-0 ${
                        isActive ? 'text-[var(--t-accent)]' : 'text-[var(--text-secondary)]'
                      }`}
                    />
                    <span className="font-medium text-xs truncate">
                      {session.title || t('extra.chat')}
                    </span>
                  </div>

                  {/* Delete button (shows on hover and focus) */}
                  <button
                    type="button"
                    title={t('extra.deleteSession')}
                    aria-label={t('extra.deleteSession')}
                    aria-busy={isDeletingId === session.id ? true : undefined}
                    onClick={(e) => {
                      e.stopPropagation();
                      if (session.busy) {
                        alert(t('extra.busySession'));
                        return;
                      }
                      onDeleteSession(session.id);
                    }}
                    disabled={isDeletingId === session.id}
                    className="opacity-0 group-hover:opacity-100 focus:opacity-100 focus-visible:opacity-100 p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--t-crit)] hover:bg-[var(--t-crit)]/10 transition-opacity focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>

                {/* Subtitle / Badges */}
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10px]">
                  {/* Mode Badge */}
                  {session.mode === 'full' ? (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--t-crit)]/10 text-[var(--t-crit)] border border-[var(--t-crit)]/20 font-medium">
                      <AlertTriangle className="w-3 h-3" />
                      <span>{t('extra.fullMode')}</span>
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-[var(--t-ok)]/10 text-[var(--t-ok)] border border-[var(--t-ok)]/20 font-medium">
                      <ShieldCheck className="w-3 h-3" />
                      <span>{t('extra.safeMode')}</span>
                    </span>
                  )}

                  {/* Project badge */}
                  {session.projectId && (
                    <span className="px-1.5 py-0.5 rounded bg-[var(--bg-surface-subtle)] text-[var(--text-secondary)] border border-[var(--border-subtle)] font-mono">
                      {session.projectId}
                    </span>
                  )}

                  {/* Busy / Answering indicator */}
                  {session.busy && (
                    <span className="inline-flex items-center gap-1 text-[var(--t-accent)] font-medium animate-pulse ml-auto">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--t-accent)]" />
                      <span>{t('extra.answering')}</span>
                    </span>
                  )}

                  {/* Time */}
                  {!session.busy && (
                    <span className="inline-flex items-center gap-1 text-[var(--text-muted)] ml-auto">
                      <Clock className="w-3 h-3" />
                      <span>{formatRelativeTime(session.updatedAt, t)}</span>
                    </span>
                  )}
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
};
