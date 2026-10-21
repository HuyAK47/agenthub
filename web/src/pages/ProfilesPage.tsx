import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AlertTriangle,
  Check,
  Clock,
  ExternalLink,
  MoreVertical,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from 'lucide-react';
import {
  apiFetch,
  checkProfile,
  createProfile,
  deleteProfile,
  deleteQuota,
  getProfiles,
  getConfig,
  getStatus,
  loginProfile,
  refreshProfileUsage,
  renameProfile,
  updateProfile,
} from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { DailyUsageTable } from '../components/DailyUsageTable';
import { LoginTerminal } from '../components/LoginTerminal';
import { QuotaUsage } from '../components/QuotaUsage';
import { useLocale } from '../context/LocaleContext';
import { Profile } from '../types/api';

type Provider = 'agy' | 'codex' | 'claude';
const providers: Array<{ id: Provider; title: string; subtitleKey: string; color: string }> = [
  {
    id: 'agy',
    title: 'Antigravity (Gemini)',
    subtitleKey: 'profiles.antigravitySubtitle',
    color: 'var(--t-accent)',
  },
  {
    id: 'codex',
    title: 'Codex (OpenAI)',
    subtitleKey: 'profiles.codexSubtitle',
    color: 'var(--t-ok)',
  },
  { id: 'claude', title: 'Claude', subtitleKey: 'profiles.claudeSubtitle', color: 'var(--t-warn)' },
];

function StatusBadge({ profile }: { profile: Profile }) {
  const { t } = useLocale();
  const loggedIn = profile.loggedIn ?? Boolean(profile.email);
  const state =
    profile.authState === 'needs_verification'
      ? 'verify'
      : profile.authState === 'error'
        ? 'error'
        : !loggedIn
          ? 'off'
          : 'on';
  const labels = {
    on: t('profiles.loggedIn'),
    off: t('profiles.notLoggedIn'),
    verify: t('profiles.needsVerification'),
    error: t('profiles.error'),
  };
  const colors = {
    on: 'text-[var(--t-ok)] border-[var(--t-ok)]',
    off: 'text-[var(--t-text-3)] border-[var(--t-border)]',
    verify: 'text-[var(--t-warn)] border-[var(--t-warn)]',
    error: 'text-[var(--t-crit)] border-[var(--t-crit)]',
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${colors[state]}`}
    >
      <span className="h-1.5 w-1.5 rounded-full bg-current" />
      {labels[state]}
    </span>
  );
}
function usageText(profile: Profile) {
  const { t } = useLocale();
  if (profile.claudeTokens)
    return t('profiles.claudeUsage', { today: profile.claudeTokens.today.toLocaleString(), week: profile.claudeTokens.week.toLocaleString() });
  const five = profile.usage?.find((u) => u.window === '5h');
  const week = profile.usage?.find((u) => u.window === 'week');
  return five || week
    ? t('profiles.quotaUsage', { five: five ? `${five.remainingPct}% / 5h` : '—', week: week ? `${week.remainingPct}% / ${t('profiles.week')}` : '—' })
    : t('profiles.noQuotaData');
}
function formatHHMM(epoch: number) { const date = new Date(epoch * 1000); return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`; }

export const ProfilesPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState('');
  const [newEngine, setNewEngine] = useState<Provider>('agy');
  const [newAccountType, setNewAccountType] = useState<'personal' | 'team' | 'api'>('personal');
  const [addError, setAddError] = useState('');
  const [activeLogin, setActiveLogin] = useState<{ name: string; engine: Provider; sessionId: string } | null>(null);
  const [menu, setMenu] = useState<string | null>(null);
  const [editing, setEditing] = useState<Profile | null>(null);
  const [renaming, setRenaming] = useState<Profile | null>(null);
  const [deleting, setDeleting] = useState<Profile | null>(null);
  const [checking, setChecking] = useState<Record<string, boolean>>({});
  const [toasts, setToasts] = useState<Array<{ id: number; text: string; error?: boolean }>>([]);
  const checkTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const {
    data: profiles = [],
    isLoading,
    error,
  } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles, refetchInterval: 5000 });
  const { data: systemConfig } = useQuery({ queryKey: ['config'], queryFn: getConfig });
  const { data: status } = useQuery({
    queryKey: ['status'],
    queryFn: getStatus,
    refetchInterval: 5000,
  });
  const runningByProfile = new Map((status?.running || []).map((run) => [run.profileName, run]));
  const toast = (text: string, isError = false) => {
    const id = Date.now();
    setToasts((old) => [...old, { id, text, error: isError }]);
    setTimeout(() => setToasts((old) => old.filter((item) => item.id !== id)), 6000);
  };
  useEffect(
    () =>
      subscribeToEvents((event) => {
        if (event.type !== 'profile.check') return;
        const name = String((event.payload as any)?.name || '');
        if (!name) return;
        clearTimeout(checkTimers.current[name]);
        setChecking((old) => ({ ...old, [name]: false }));
        const ok = Boolean((event.payload as any)?.ok);
        toast(
          `${ok ? '✓' : '✗'} ${(event.payload as any)?.message || (ok ? 'Kiểm tra thành công' : 'Kiểm tra thất bại')}${(event.payload as any)?.durationMs ? ` (${(event.payload as any).durationMs}ms)` : ''}`,
          !ok,
        );
        queryClient.invalidateQueries({ queryKey: ['profiles'] });
        void refreshProfileUsage(name);
      }),
    [queryClient],
  );
  const runLogin = async (name: string, engine: Provider) => {
    try {
      setActiveLogin({ name, engine, sessionId: (await loginProfile(name)).sessionId });
    } catch (err: any) {
      toast(err?.message || 'Không thể mở trình đăng nhập', true);
    }
  };
  const runCheck = async (name: string) => {
    setChecking((old) => ({ ...old, [name]: true }));
    checkTimers.current[name] = setTimeout(
      () => {
        setChecking((old) => ({ ...old, [name]: false }));
        toast(t('profiles.checkTimeout'), true);
      },
      75_000,
    );
    try {
      await checkProfile(name);
    } catch (err: any) {
      clearTimeout(checkTimers.current[name]);
      setChecking((old) => ({ ...old, [name]: false }));
      toast(err?.status === 409 ? t('profiles.checkAlreadyRunning') : err?.message || 'Kiểm tra thất bại', true);
    }
  };
  const createAndLogin = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!newName.trim()) {
      setAddError('Vui lòng nhập tên tài khoản');
      return;
    }
    try {
      const name = newName.trim();
      await createProfile({ name, engine: newEngine, accountType: newAccountType });
      setShowAdd(false);
      setNewName('');
      setNewAccountType('personal');
      setAddError('');
      await runLogin(name, newEngine);
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    } catch (err: any) {
      setAddError(err?.message || 'Không thể tạo tài khoản');
    }
  };

  return (
    <div className="space-y-6" onClick={() => menu && setMenu(null)}>
      <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('profiles.title')}</h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('profiles.subtitle')}
          </p>
        </div>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            setShowAdd(true);
          }}
          className="inline-flex items-center gap-2 rounded-lg bg-[var(--t-accent)] px-4 py-2 text-sm font-semibold text-white"
        >
          <Plus className="h-4 w-4" />
          {t('profiles.addBtn')}
        </button>
      </div>
      <div className="fixed bottom-5 right-5 z-[60] space-y-2">
        {toasts.map((item) => (
          <div
            key={item.id}
            role="alert"
            className={`rounded-lg border px-4 py-3 text-sm shadow-lg ${item.error ? 'border-[var(--t-crit)] text-[var(--t-crit)]' : 'border-[var(--t-ok)] text-[var(--t-ok)]'} bg-[var(--t-surface)]`}
          >
            {item.text}
          </div>
        ))}
      </div>
      {isLoading ? (
        <div className="p-12 text-center">{t('profiles.loading')}</div>
      ) : error ? (
        <div className="p-8 text-center text-[var(--t-crit)]">
          {t('profiles.loadError')}
        </div>
      ) : (
        <div className="space-y-8">
          {providers.map((provider) => {
            const grouped = profiles.filter((profile) => profile.engine === provider.id);
            return (
              <section key={provider.id} aria-labelledby={`provider-${provider.id}`}>
                <div className="mb-3 flex items-center gap-3">
                  <div className="h-8 w-1 rounded-full" style={{ background: provider.color }} />
                  <div>
                    <h2 id={`provider-${provider.id}`} className="text-lg font-semibold">
                      {provider.title}
                    </h2>
                    <p className="text-xs text-[var(--t-text-3)]">{t(provider.subtitleKey)}</p>
                  </div>
                  <span className="rounded-full bg-[var(--t-surface-2)] px-2 py-0.5 text-xs text-[var(--t-text-3)]">
                    {grouped.length}
                  </span>
                </div>
                {systemConfig?.multiplePerProvider && grouped.filter((profile) => profile.accountType === 'personal').length > 1 && (
                  <div className="mb-3 rounded-lg border border-[var(--t-warn)] bg-[var(--t-warn)]/10 p-3 text-sm text-[var(--t-warn)]">
                    {t('profiles.multiplePersonalWarning')}
                  </div>
                )}
                {grouped.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-[var(--t-border)] p-6 text-sm text-[var(--t-text-3)]">
                    {t('profiles.emptyProvider', { provider: provider.title })}
                  </div>
                ) : (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {grouped.map((profile) => (
                      <div key={profile.name} id={`profile-${profile.name}`}>
                      <ProfileCard
                        profile={profile}
                        run={runningByProfile.get(profile.name)}
                        menu={menu}
                        setMenu={setMenu}
                        checking={Boolean(checking[profile.name])}
                        onLogin={runLogin}
                        onCheck={runCheck}
                        onEdit={setEditing}
                        onRename={setRenaming}
                        onDelete={setDeleting}
                        onToggle={(enabled) =>
                          updateProfile(profile.name, { enabled }).then(() =>
                            queryClient.invalidateQueries({ queryKey: ['profiles'] }),
                          )
                        }
                        onRefresh={() =>
                          refreshProfileUsage(profile.name).then(() =>
                            queryClient.invalidateQueries({ queryKey: ['profiles'] }),
                          )
                        }
                        onQuotaRemoved={(family) => toast(t('profiles.removeQuotaSuccess', { family, name: profile.name }))}
                      />
                      </div>
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      <DailyUsageTable />
      {showAdd && (
        <Modal title={t('profiles.addBtn')} onClose={() => setShowAdd(false)}>
          <form onSubmit={createAndLogin} className="space-y-4">
            <p className="text-sm text-[var(--t-text-3)]">
              {t('profiles.addDescription')}
            </p>
            {addError && (
              <p className="rounded bg-[var(--t-crit)]/10 p-2 text-xs text-[var(--t-crit)]">
                {addError}
              </p>
            )}
            <label className="block text-sm">
              {t('profiles.accountName')}
              <input
                autoFocus
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t('profiles.accountNamePlaceholder')}
                className="field mt-1"
              />
            </label>
            <label className="block text-sm">
              {t('profiles.provider')}
              <select
                value={newEngine}
                onChange={(e) => setNewEngine(e.target.value as Provider)}
                className="field mt-1"
              >
                <option value="agy">Antigravity (Gemini)</option>
                <option value="codex">Codex (OpenAI)</option>
                <option value="claude">Claude</option>
              </select>
            </label>
            <label className="block text-sm">
              {t('profiles.accountType')}
              <select value={newAccountType} onChange={(e) => setNewAccountType(e.target.value as typeof newAccountType)} className="field mt-1">
                <option value="personal">{t('profiles.personal')}</option>
                <option value="team">{t('profiles.team')}</option>
                <option value="api">{t('profiles.api')}</option>
              </select>
            </label>
            <div className="flex justify-end gap-2">
              <button type="button" onClick={() => setShowAdd(false)} className="button-secondary">
                {t('common.cancel')}
              </button>
              <button type="submit" className="button-primary">
                {t('profiles.createAndGuide')}
              </button>
            </div>
          </form>
        </Modal>
      )}
      {editing && (
        <EditProfileModal
          profile={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {renaming && (
        <RenameModal
          profile={renaming}
          onClose={() => setRenaming(null)}
          onSaved={() => {
            setRenaming(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {deleting && (
        <DeleteModal
          profile={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            setDeleting(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
      {activeLogin && (
        <LoginWizard
          profileName={activeLogin.name}
          engine={activeLogin.engine}
          sessionId={activeLogin.sessionId}
          onClose={() => {
            setActiveLogin(null);
            queryClient.invalidateQueries({ queryKey: ['profiles'] });
          }}
        />
      )}
    </div>
  );
};

function ProfileCard({
  profile,
  run,
  menu,
  setMenu,
  checking,
  onLogin,
  onCheck,
  onEdit,
  onRename,
  onDelete,
  onToggle,
  onRefresh,
  onQuotaRemoved,
}: {
  profile: Profile;
  run?: any;
  menu: string | null;
  setMenu: (name: string | null) => void;
  checking: boolean;
  onLogin: (name: string, engine: Provider) => void;
  onCheck: (name: string) => void;
  onEdit: (profile: Profile) => void;
  onRename: (profile: Profile) => void;
  onDelete: (profile: Profile) => void;
  onToggle: (enabled: boolean) => void;
  onRefresh: () => void;
  onQuotaRemoved: (family: string) => void;
}) {
  const { t } = useLocale();
  const logged = profile.loggedIn ?? Boolean(profile.email);
  const canLogin = profile.kind !== 'keyring' || profile.engine === 'claude';
  const busy = Boolean(profile.busy || profile.isBusy);
  const activeMarks = (profile.quotaMarks || []).filter((mark) => mark.until > Math.floor(Date.now() / 1000));
  return (
    <article
      className="relative rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-5 shadow-xs"
      data-testid={`profile-card-${profile.name}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <div className="rounded-lg bg-[var(--t-surface-2)] p-2 text-[var(--t-accent)]">
            <UserRound className="h-5 w-5" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="truncate font-semibold">{profile.label || profile.name}</h3>
              {profile.label && (
                <span className="font-mono text-xs text-[var(--t-text-3)]">({profile.name})</span>
              )}
              {busy && (
                <span className="rounded bg-[var(--t-accent-bg)] px-1.5 py-0.5 text-[10px] font-bold text-[var(--t-accent)]">
                  {t('profiles.busyTag')}
                </span>
              )}
            </div>
            <p className="truncate text-sm text-[var(--t-text-3)]">
              {logged
                ? profile.email || (profile.engine === 'codex' ? 'Codex (ChatGPT)' : t('profiles.authenticated'))
                : t('profiles.noEmail')}
            </p>
          </div>
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label={t('profiles.actionsAria', { name: profile.name })}
            onClick={(e) => {
              e.stopPropagation();
              setMenu(menu === profile.name ? null : profile.name);
            }}
            className="rounded-lg p-2 text-[var(--t-text-3)] hover:bg-[var(--t-surface-2)]"
          >
            <MoreVertical className="h-4 w-4" />
          </button>
          {menu === profile.name && (
            <div
              onClick={(e) => e.stopPropagation()}
              className="absolute right-0 top-10 z-20 w-44 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-1 shadow-xl"
            >
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onLogin(profile.name, profile.engine);
                }}
              >
                {logged ? t('extra.reLogin') : t('profiles.loginNow')}
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onCheck(profile.name);
                }}
              >
                {t('profiles.checkBtn')}
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onEdit(profile);
                }}
              >
                {t('common.edit')}
              </button>
              <button
                type="button"
                className="menu-item"
                onClick={() => {
                  setMenu(null);
                  onRename(profile);
                }}
              >
                {t('profiles.rename')}
              </button>
              {profile.kind !== 'system' && (
                <button
                  type="button"
                  className="menu-item text-[var(--t-crit)]"
                  onClick={() => {
                    setMenu(null);
                    onDelete(profile);
                  }}
                >
                  {t('extra.deleteProfile')}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
      <div className="mt-4 flex flex-wrap items-center gap-2">
        <StatusBadge profile={profile} />
        {profile.duplicateWarning && (
          <span className="inline-flex items-center gap-1 rounded-full border border-[var(--t-crit)] px-2 py-0.5 text-[11px] font-semibold text-[var(--t-crit)]">
            <AlertTriangle className="h-3 w-3" />
            {t('profiles.duplicateEmail')}
            {profile.duplicateEmailWith?.length ? `: ${profile.duplicateEmailWith.join(', ')}` : ''}
          </span>
        )}
        <span className="text-xs text-[var(--t-text-3)]">{t('profiles.priority', { value: profile.priority ?? 0 })}</span>
        <span className="rounded-full bg-[var(--t-surface-2)] px-2 py-0.5 text-[11px] text-[var(--t-text-3)]">
          {t(`profiles.accountTypes.${profile.accountType || 'personal'}`)}
        </span>
      </div>
      {profile.authState === 'needs_verification' && profile.verifyUrl && (
        <a
          href={profile.verifyUrl}
          target="_blank"
          rel="noopener"
          className="mt-2 inline-flex items-center gap-1 text-xs text-[var(--t-warn)] hover:underline"
        >
          <ExternalLink className="h-3 w-3" />
          {t('profiles.openVerification')}
        </a>
      )}
      {profile.authState === 'needs_verification' && (
        <p className="mt-1 text-xs text-[var(--t-text-3)]">{t('profiles.verificationTip')}</p>
      )}
      <div className="mt-4 rounded-lg bg-[var(--t-surface-2)] p-3">
        <div className="flex items-center justify-between text-xs">
          <span className="font-medium">{t('profiles.quotaTitle')}</span>
          <span className="text-[var(--t-text-3)]">{usageText(profile)}</span>
        </div>
        <div className="mt-2">
          <QuotaUsage usage={profile.usage} onRefresh={onRefresh} />
        </div>
        {activeMarks.map((mark) => (
          <div key={mark.family} data-testid={`quota-mark-${mark.family}`} title={mark.reason || undefined} className="mt-2 flex items-center justify-between rounded border border-[var(--t-warn)] px-2 py-1 text-xs text-[var(--t-warn)]">
            <span>{t('profiles.quotaLocked', { family: mark.family, time: formatHHMM(mark.until) })}</span>
            <button type="button" onClick={() => { if (window.confirm(t('profiles.confirmRemoveQuota', { family: mark.family, name: profile.name }))) void deleteQuota(profile.name, mark.family).then(() => { onRefresh(); onQuotaRemoved(mark.family); }); }} className="ml-2 underline">{t('profiles.removeQuota')}</button>
          </div>
        ))}
      </div>
      {profile.engine === 'claude' && (
        <div className="mt-4 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)]/60 p-3" data-testid={`claude-limited-section-${profile.name}`}>
          <div className="flex items-center justify-between text-xs font-semibold">
            <span className="flex items-center gap-1.5 text-[var(--t-warn)]">
              <Clock className="h-3.5 w-3.5" />
              {t('profiles.limitedSessions')}
            </span>
            <span className="rounded-full bg-[var(--t-warn)]/10 px-2 py-0.5 text-[10px] text-[var(--t-warn)] font-bold">
              {profile.limitedSessions?.length || 0}
            </span>
          </div>
          {profile.limitedSessions && profile.limitedSessions.length > 0 ? (
            <div className="mt-2 space-y-2.5">
              {profile.limitedSessions.map((session) => (
                <div
                  key={session.sessionId}
                  className="rounded-md border border-[var(--t-border)] bg-[var(--t-surface)] p-2.5 text-xs shadow-2xs space-y-1.5"
                  data-testid={`limited-session-${session.sessionId}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-semibold text-[var(--t-text)] truncate max-w-[220px]" title={session.title || session.sessionId}>
                      {session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId)}
                    </span>
                    <Link
                      to={`/claude-sessions/${encodeURIComponent(session.sessionId)}`}
                      className="text-[var(--t-accent)] hover:underline whitespace-nowrap text-[11px]"
                    >
                      {t('profiles.viewDetails')} →
                    </Link>
                  </div>
                  <div className="font-mono text-[11px] text-[var(--t-text-3)] truncate" title={session.cwd}>
                    {session.cwd}
                  </div>
                  <div className="flex flex-wrap items-center justify-between gap-2 border-t border-[var(--t-border)] pt-1.5 text-[11px]">
                    <span className="text-[var(--t-warn)]">
                      {t('profiles.resetsAt', { time: formatHHMM(session.limitResetAt) })}
                    </span>
                    <label className="flex items-center gap-1.5 cursor-pointer text-[var(--t-text-2)] hover:text-[var(--t-text)]">
                      <input
                        type="checkbox"
                        checked={session.autoResumeEnabled}
                        onChange={(e) => {
                          const nextVal = e.target.checked;
                          void apiFetch(`/api/claude/sessions/${encodeURIComponent(session.sessionId)}/auto-resume`, {
                            method: 'PATCH',
                            body: JSON.stringify({ enabled: nextVal }),
                          }).then(() => {
                            onRefresh();
                          });
                        }}
                        className="rounded border-[var(--t-border)]"
                      />
                      <span>{t('profiles.autoResumeLimit')}</span>
                    </label>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p className="mt-2 text-xs text-[var(--t-text-3)] italic">
              {t('profiles.noLimitedSessions')}
            </p>
          )}
        </div>
      )}
      <div className="mt-3 flex items-center gap-2 text-xs text-[var(--t-text-3)]">
        {run ? (
          <>
            <span className="h-2 w-2 rounded-full bg-[var(--t-ok)]" />
            {t('profiles.runningTask')}:{' '}
            <span className="truncate text-[var(--t-text)]">{run.title || run.taskId}</span>
          </>
        ) : (
          <>
            <span className="h-2 w-2 rounded-full bg-[var(--t-text-3)]" />
            {t('profiles.idleTask')}
          </>
        )}
      </div>
      {profile.notes && (
        <p className="mt-2 border-l-2 border-[var(--t-border)] pl-2 text-xs text-[var(--t-text-3)]">
          {profile.notes}
        </p>
      )}
      <div className="mt-4 flex items-center justify-between border-t border-[var(--t-border)] pt-3">
        <label className="flex items-center gap-2 text-xs text-[var(--t-text-3)]">
          <button type="button" aria-label={t('profiles.toggleAria', { name: profile.name })} disabled={profile.kind === 'system'} onClick={() => onToggle(!Boolean(profile.enabled))} className={`h-5 w-9 rounded-full p-0.5 ${profile.enabled ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-surface-2)]'}`}>
            <span className={`block h-4 w-4 rounded-full bg-white transition-transform ${profile.enabled ? 'translate-x-4' : ''}`} />
          </button>
          {t('profiles.enable')}
        </label>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => onCheck(profile.name)}
            disabled={checking}
            className="inline-flex items-center gap-1 rounded border border-[var(--t-border)] px-2.5 py-1 text-xs disabled:opacity-50"
          >
            {checking ? (
              <RefreshCw className="h-3 w-3 animate-spin" />
            ) : (
              <Check className="h-3 w-3" />
            )}
            {checking ? t('profiles.checkingBtn') : t('profiles.checkBtn')}
          </button>
          {canLogin && (
            <button
              type="button"
              aria-label={logged ? t('extra.reLogin') : t('profiles.loginBtn')}
              onClick={() => onLogin(profile.name, profile.engine)}
              className="rounded bg-[var(--t-accent-bg)] px-2.5 py-1 text-xs font-medium text-[var(--t-accent)]"
            >
              {logged ? t('extra.reLogin') : t('profiles.loginNow')}
            </button>
          )}
        </div>
      </div>
    </article>
  );
}

function Modal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-6 shadow-2xl">
        <div className="mb-5 flex items-center justify-between">
          <h2 className="text-lg font-semibold">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Đóng">
            <X className="h-5 w-5" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
function EditProfileModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [label, setLabel] = useState(profile.label || '');
  const [notes, setNotes] = useState(profile.notes || '');
  const [priority, setPriority] = useState(String(profile.priority ?? 0));
  const [enabled, setEnabled] = useState(Boolean(profile.enabled));
  const [error, setError] = useState('');
  return (
    <Modal title={`Sửa hồ sơ ${profile.name}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await updateProfile(profile.name, {
              label: label || null,
              notes: notes || null,
              priority: Number(priority) || 0,
              enabled,
            });
            onSaved();
          } catch (err: any) {
            setError(err?.message || 'Không thể lưu hồ sơ');
          }
        }}
      >
        <label className="block text-sm">
          Tên hiển thị
          <input className="field mt-1" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
        <label className="block text-sm">
          Ghi chú
          <textarea
            className="field mt-1"
            rows={3}
            value={notes}
            onChange={(e) => setNotes(e.target.value)}
          />
        </label>
        <label className="block text-sm">
          Ưu tiên
          <input
            className="field mt-1"
            type="number"
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Bật hồ sơ
        </label>
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            Huỷ
          </button>
          <button className="button-primary">Lưu</button>
        </div>
      </form>
    </Modal>
  );
}
function RenameModal({
  profile,
  onClose,
  onSaved,
}: {
  profile: Profile;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [error, setError] = useState('');
  return (
    <Modal title={`Đổi tên ${profile.name}`} onClose={onClose}>
      <form
        className="space-y-3"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await renameProfile(profile.name, name.trim());
            onSaved();
          } catch (err: any) {
            setError(err?.message || 'Không thể đổi tên');
          }
        }}
      >
        <label className="block text-sm">
          Tên mới
          <input
            className="field mt-1"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
          />
        </label>
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            Huỷ
          </button>
          <button className="button-primary">Đổi tên</button>
        </div>
      </form>
    </Modal>
  );
}
function DeleteModal({
  profile,
  onClose,
  onDeleted,
}: {
  profile: Profile;
  onClose: () => void;
  onDeleted: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [purge, setPurge] = useState(false);
  const [error, setError] = useState('');
  return (
    <Modal title={`Xoá hồ sơ ${profile.name}`} onClose={onClose}>
      <form
        className="space-y-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (typed !== profile.name) {
            setError('Tên nhập lại chưa khớp');
            return;
          }
          try {
            await deleteProfile(profile.name, purge);
            onDeleted();
          } catch (err: any) {
            setError(err?.message || 'Không thể xoá hồ sơ');
          }
        }}
      >
        <p className="text-sm text-[var(--t-text-3)]">
          Nhập lại <code className="font-mono text-[var(--t-text)]">{profile.name}</code> để xác
          nhận.
        </p>
        <input
          className="field"
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
          autoFocus
          placeholder={profile.name}
        />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" checked={purge} onChange={(e) => setPurge(e.target.checked)} />
          Xoá cả thư mục dữ liệu đăng nhập
        </label>
        {error && <p className="text-xs text-[var(--t-crit)]">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className="button-secondary" onClick={onClose}>
            Huỷ
          </button>
          <button disabled={typed !== profile.name} className="button-danger">
            <Trash2 className="h-3 w-3" />
            Xoá hồ sơ
          </button>
        </div>
      </form>
    </Modal>
  );
}
function LoginWizard({
  profileName,
  engine,
  sessionId,
  onClose,
}: {
  profileName: string;
  engine: Provider;
  sessionId: string;
  onClose: () => void;
}) {
  const provider = engine === 'codex'
    ? 'Codex'
    : engine === 'claude'
      ? 'Claude'
      : 'Antigravity';
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-3">
      <div className="flex h-[90vh] w-[96vw] max-w-[1400px] flex-col overflow-hidden rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] shadow-2xl">
        <div className="border-b border-[var(--t-border)] p-4">
          <h2 className="text-lg font-semibold">
            Hướng dẫn đăng nhập {provider} · {profileName}
          </h2>
          <div className="mt-3 grid gap-2 text-xs text-[var(--t-text-3)] sm:grid-cols-4">
            <Step
              n="1"
              text={
                provider === 'Antigravity'
                  ? 'Chọn Google OAuth'
                  : provider === 'Codex'
                    ? 'Chạy device-auth'
                    : 'Gửi /login'
              }
            />
            <Step n="2" text="Mở link và đăng nhập" />
            <Step n="3" text="Copy mã xác thực" />
            <Step n="4" text="Dán mã và chờ xác nhận" />
          </div>
        </div>
        <div className="min-h-0 flex-1">
          <LoginTerminal profileName={profileName} sessionId={sessionId} onClose={onClose} />
        </div>
      </div>
    </div>
  );
}
function Step({ n, text }: { n: string; text: string }) {
  return (
    <div className="rounded-lg bg-[var(--t-surface-2)] p-2">
      <b className="mr-1 text-[var(--t-accent)]">{n}.</b>
      {text}
    </div>
  );
}
