import React, { useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Send, RefreshCw, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { getTelegramPairingCode } from '../api/client';
import { useLocale } from '../context/LocaleContext';

export interface TelegramCardProps {
  hasToken?: boolean;
  allowedChatsCount?: number;
}

export const TelegramCard: React.FC<TelegramCardProps> = ({ hasToken, allowedChatsCount }) => {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [isRefreshing, setIsRefreshing] = useState(false);

  const { data: pairing, isLoading } = useQuery({
    queryKey: ['telegram-pairing'],
    queryFn: () => getTelegramPairingCode(false),
    refetchInterval: 10_000,
  });

  const refreshMutation = useMutation({
    mutationFn: () => getTelegramPairingCode(true),
    onSuccess: (data) => {
      queryClient.setQueryData(['telegram-pairing'], data);
    },
  });

  const handleRefresh = async () => {
    setIsRefreshing(true);
    try {
      await refreshMutation.mutateAsync();
    } finally {
      setIsRefreshing(false);
    }
  };

  const code = pairing?.code || '------';
  const expiresInSec = pairing?.expiresInSec ?? 0;
  const isExpired = expiresInSec <= 0 && !isLoading;
  const minutes = Math.floor(expiresInSec / 60);
  const seconds = expiresInSec % 60;
  const minStr = String(minutes).padStart(2, '0');
  const secStr = String(seconds).padStart(2, '0');

  const count = allowedChatsCount ?? pairing?.allowedChatIds?.length ?? 0;

  return (
    <div
      data-testid="telegram-card"
      className="bg-[var(--bg-surface)] rounded-xl border border-[var(--border-default)] p-5 shadow-xs transition-colors"
    >
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2.5">
          <div className="p-2 rounded-lg bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]">
            <Send className="w-5 h-5" />
          </div>
          <div>
            <h2 className="text-base font-semibold text-[var(--text-primary)]">{t('telegram.cardTitle')}</h2>
            <p className="text-xs text-[var(--text-secondary)]">
              {t('telegram.connectedChats', { count })}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {hasToken ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--t-ok)] bg-[color-mix(in_srgb,var(--t-ok)_12%,transparent)] px-2.5 py-1 rounded-full border border-[var(--t-ok)] font-medium">
              <CheckCircle2 className="w-3.5 h-3.5" />
              <span>{t('telegram.hasTokenBadge')}</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 text-xs text-[var(--t-warn)] bg-[color-mix(in_srgb,var(--t-warn)_12%,transparent)] px-2.5 py-1 rounded-full border border-[var(--t-warn)] font-medium">
              <AlertTriangle className="w-3.5 h-3.5" />
              <span>{t('telegram.noTokenWarning')}</span>
            </span>
          )}
        </div>
      </div>

      <div className="rounded-lg bg-[var(--bg-surface-subtle)] border border-[var(--border-subtle)] p-4 flex flex-col md:flex-row items-start md:items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="text-xs text-[var(--text-secondary)] font-medium">
            {t('telegram.pairingCode')}
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-2xl font-bold tracking-widest text-[var(--text-primary)] bg-[var(--bg-surface)] px-3 py-1 rounded border border-[var(--border-default)]">
              {code.length === 6 ? `${code.slice(0, 3)} ${code.slice(3)}` : code}
            </span>
            <span className="text-xs text-[var(--text-secondary)]">
              {isExpired
                ? t('telegram.expired')
                : t('telegram.expiresIn', { min: minStr, sec: secStr })}
            </span>
          </div>
          <p className="text-xs text-[var(--text-secondary)] pt-1">
            {t('telegram.instructions', { code })}
          </p>
        </div>

        <button
          type="button"
          onClick={handleRefresh}
          disabled={isRefreshing}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface)] text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] transition-colors disabled:opacity-50 shrink-0"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
          <span>{t('telegram.refreshCode')}</span>
        </button>
      </div>
    </div>
  );
};
