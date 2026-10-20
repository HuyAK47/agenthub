import React, { useEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  checkProfile,
  createProfile,
  getProfiles,
  loginProfile,
  updateProfile,
  refreshProfileUsage,
  deleteQuota,
  deleteProfile,
} from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { QuotaUsage } from '../components/QuotaUsage';
import { DailyUsageTable } from '../components/DailyUsageTable';
import { CountdownTimer } from '../components/CountdownTimer';
import { LoginTerminal } from '../components/LoginTerminal';
import {
  Plus,
  AlertTriangle,
  X,
  AlertCircle,
} from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

function formatHHMM(epochSeconds: number): string {
  if (!epochSeconds || Number.isNaN(epochSeconds)) return '--:--';
  const sec = epochSeconds > 1e11 ? Math.floor(epochSeconds / 1000) : epochSeconds;
  const d = new Date(sec * 1000);
  if (Number.isNaN(d.getTime())) return '--:--';
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

export const ProfilesPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();

  const [showAddModal, setShowAddModal] = useState(false);
  const [newProfileName, setNewProfileName] = useState('');
  const [newProfileEngine, setNewProfileEngine] = useState<'agy' | 'claude'>('agy');
  const [addError, setAddError] = useState<string | null>(null);

  // Active terminal login session
  const [activeLogin, setActiveLogin] = useState<{ name: string; sessionId: string } | null>(null);

  // Check profile state and toasts
  const [checkingMap, setCheckingMap] = useState<Record<string, { timerId: any; startedAt: number }>>({});
  const checkingMapRef = useRef<Record<string, { timerId: any; startedAt: number }>>({});
  const [toasts, setToasts] = useState<
    Array<{
      id: string;
      type: 'success' | 'error' | 'info';
      ok?: boolean;
      message: string;
      durationMs?: number;
    }>
  >([]);

  const addToast = (toast: {
    type: 'success' | 'error' | 'info';
    ok?: boolean;
    message: string;
    durationMs?: number;
  }) => {
    const id = `toast_${Date.now()}_${Math.random().toString(36).substring(2, 6)}`;
    setToasts((prev) => [...prev, { ...toast, id }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 8000);
  };

  const removeToast = (id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  };

  const { data: profiles = [], isLoading, error } = useQuery({
    queryKey: ['profiles'],
    queryFn: getProfiles,
    refetchInterval: 5000,
  });

  const toggleMutation = useMutation({
    mutationFn: ({ name, enabled }: { name: string; enabled: boolean }) =>
      updateProfile(name, { enabled }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
  });

  const usageMutation = useMutation({
    mutationFn: (name: string) => refreshProfileUsage(name),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['profiles'] }),
  });

  const deleteQuotaMutation = useMutation({
    mutationFn: ({ name, family }: { name: string; family: string }) =>
      deleteQuota(name, family),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['profiles'] });
    },
  });

  const handleRemoveQuota = async (name: string, family: string) => {
    if (window.confirm(t('profiles.confirmRemoveQuota', { family, name }))) {
      try {
        await deleteQuotaMutation.mutateAsync({ name, family });
        addToast({
          type: 'success',
          ok: true,
          message: t('profiles.removeQuotaSuccess', { family, name }),
        });
      } catch (err: any) {
        addToast({
          type: 'error',
          ok: false,
          message: err?.message || t('profiles.removeQuotaFailed'),
        });
      }
    }
  };

  // Listen to SSE profile.check
  useEffect(() => {
    const unsubscribe = subscribeToEvents((event) => {
      if (event.type === 'profile.check') {
        const payload = event.payload || {};
        const profileName = payload.name;
        if (profileName && checkingMapRef.current[profileName]) {
          const { timerId } = checkingMapRef.current[profileName];
          clearTimeout(timerId);
          delete checkingMapRef.current[profileName];
          setCheckingMap((prev) => {
            const next = { ...prev };
            delete next[profileName];
            return next;
          });

          const ok = Boolean(payload.ok);
          const durationMs = payload.durationMs;
          const msg = payload.message || (ok ? t('extra.checkPassed') : t('extra.checkFailed'));

          addToast({
            type: ok ? 'success' : 'error',
            ok,
            message: durationMs !== undefined ? `${msg} (${durationMs}ms)` : msg,
            durationMs,
          });

          queryClient.invalidateQueries({ queryKey: ['profiles'] });
          refreshProfileUsage(profileName).catch(() => {});
        }
      }
    });

    return () => {
      unsubscribe();
      for (const info of Object.values(checkingMapRef.current)) {
        clearTimeout(info.timerId);
      }
    };
  }, [queryClient]);

  const handleCheck = async (name: string) => {
    // Timeout after 75 seconds.
    const timerId = setTimeout(() => {
      if (checkingMapRef.current[name]) {
        delete checkingMapRef.current[name];
        setCheckingMap((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        addToast({
          type: 'error',
          ok: false,
          message: `${t('profiles.checkResultFor', { name })}: ${t('extra.timeout')}`,
        });
      }
    }, 75000);

    checkingMapRef.current[name] = { timerId, startedAt: Date.now() };
    setCheckingMap((prev) => ({
      ...prev,
      [name]: { timerId, startedAt: Date.now() },
    }));

    try {
      await checkProfile(name);
    } catch (err: any) {
      if (
        err?.status === 409 ||
        err?.message?.includes('409') ||
        err?.message?.toLowerCase().includes('checking')
      ) {
        addToast({
          type: 'info',
          message: `${t('profiles.checkResultFor', { name })}: ${t('extra.checking')}`,
        });
      } else {
        clearTimeout(timerId);
        delete checkingMapRef.current[name];
        setCheckingMap((prev) => {
          const next = { ...prev };
          delete next[name];
          return next;
        });
        addToast({
          type: 'error',
          ok: false,
          message: err?.message || `${t('extra.checkFailed')}: ${name}`,
        });
      }
    }
  };

  const createAndLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProfileName.trim()) {
      setAddError(t('profiles.nameRequired'));
      return;
    }
    setAddError(null);

    try {
      const name = newProfileName.trim();
      await createProfile({ name, engine: newProfileEngine });
      const loginRes = await loginProfile(name);
      setShowAddModal(false);
      setNewProfileName('');
      setNewProfileEngine('agy');
      setActiveLogin({ name, sessionId: loginRes.sessionId });
    } catch (err: any) {
      setAddError(err.message || t('profiles.createFailed'));
    }
  };

  const handleManualLogin = async (name: string) => {
    try {
      const loginRes = await loginProfile(name);
      setActiveLogin({ name, sessionId: loginRes.sessionId });
    } catch (err: any) {
      alert(err.message || t('extra.loginFailed'));
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('profiles.title')}</h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('profiles.subtitle')}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            setAddError(null);
            setShowAddModal(true);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold shadow-xs cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{t('profiles.addBtn')}</span>
        </button>
      </div>

      {/* Toasts Container */}
      <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2 max-w-md w-full pointer-events-none">
        {toasts.map((toast) => (
          <div
            key={toast.id}
            role="alert"
            className={`pointer-events-auto p-4 rounded-xl shadow-lg border flex items-start justify-between gap-3 text-sm transition-all ${
              toast.type === 'success'
                ? 'bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] border-[var(--t-ok)] text-[var(--t-ok)]'
                : toast.type === 'error'
                ? 'bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] border-[var(--t-crit)] text-[var(--t-crit)]'
                : 'bg-[var(--t-accent-bg)] border-[var(--t-accent)] text-[var(--t-accent)]'
            }`}
          >
            <div className="flex items-start gap-2.5">
              {toast.type === 'success' ? (
                <span className="text-[var(--t-ok)] font-bold text-base leading-none mt-0.5">
                  ✓
                </span>
              ) : toast.type === 'error' ? (
                <span className="text-[var(--t-crit)] font-bold text-base leading-none mt-0.5">
                  ✗
                </span>
              ) : (
                <AlertCircle className="w-4 h-4 text-[var(--t-accent)] mt-0.5 shrink-0" />
              )}
              <div className="flex-1">
                <p className="font-medium text-xs sm:text-sm">{toast.message}</p>
              </div>
            </div>
            <button
              type="button"
              onClick={() => removeToast(toast.id)}
              aria-label={t('extra.closeNotice')}
              className="text-[var(--t-text-3)] hover:text-[var(--t-text-3)] p-0.5 cursor-pointer"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ))}
      </div>

      {/* Profiles Table */}
      <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] overflow-hidden shadow-xs">
        {isLoading ? (
          <div className="flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
          </div>
        ) : error ? (
          <div className="p-8 text-center text-[var(--t-crit)] text-sm">{t('profiles.loadError')}</div>
        ) : profiles.length === 0 ? (
          <div className="p-8 text-center text-[var(--t-text-3)] text-sm">{t('profiles.empty')}</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-[var(--t-surface-2)] text-xs text-[var(--t-text-3)] uppercase font-medium">
                <tr>
                  <th className="px-6 py-3.5">{t('profiles.thProfile')}</th>
                  <th className="px-6 py-3.5">{t('profiles.thEngineKind')}</th>
                  <th className="px-6 py-3.5">{t('profiles.thEmail')}</th>
                  <th className="px-6 py-3.5">{t('profiles.thQuota')}</th>
                  <th className="px-6 py-3.5">{t('profiles.thStatus')}</th>
                  <th className="px-6 py-3.5">{t('profiles.thToggle')}</th>
                  <th className="px-6 py-3.5 text-right">{t('profiles.thActions')}</th>
                </tr>
              </thead>
              <tbody className="divide-y border-[var(--t-border)]">
                {profiles.map((profile) => {
                  const isDup = Boolean(
                    profile.duplicateWarning ||
                      (profile.duplicateEmailWith && profile.duplicateEmailWith.length > 0),
                  );
                  const isBusy = Boolean(profile.busy ?? profile.isBusy);
                  const isEnabled = !!profile.enabled;

                  const nowSec = Math.floor(Date.now() / 1000);
                  const activeQuotaMarks = (profile.quotaMarks || []).filter((mark) => {
                    const sec = mark.until > 1e11 ? Math.floor(mark.until / 1000) : mark.until;
                    return sec > nowSec;
                  });

                  const isLoggedIn =
                    typeof profile.loggedIn === 'boolean'
                      ? profile.loggedIn
                      : Boolean(profile.email);

                  const isNeedsVerification = profile.authState === 'needs_verification';
                  const isNotLoggedIn = profile.authState === 'not_logged_in' || (!isNeedsVerification && !isLoggedIn);
                  const needsReLogin = profile.authState === 'not_logged_in' &&
                    Boolean(profile.authMessage && /401|hết hạn|expired/i.test(profile.authMessage));
                  const canLogin = (profile.engine === 'agy' && profile.kind === 'isolated') || profile.engine === 'claude' || profile.engine === 'codex';

                  return (
                    <tr
                      key={profile.name}
                      className="hover:bg-[var(--t-surface-2)] transition-colors"
                    >
                      {/* Name */}
                      <td className="px-6 py-4 font-semibold text-[var(--t-text)] flex items-center gap-2">
                        <span>{profile.name}</span>
                        {isBusy && (
                          <span className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded bg-[var(--t-accent-bg)] text-[var(--t-accent)]">
                            {t('profiles.busyTag')}
                          </span>
                        )}
                      </td>

                      {/* Engine & Kind */}
                      <td className="px-6 py-4">
                        <span className="font-mono text-xs uppercase px-2 py-0.5 rounded bg-[var(--t-surface-2)] text-[var(--t-text)] font-medium mr-1.5">
                          {profile.engine}
                        </span>
                        <span className="text-xs text-[var(--t-text-3)] font-mono">({profile.kind})</span>
                      </td>

                      {/* Email + Duplicate warning */}
                      <td className="px-6 py-4">
                        {needsReLogin ? (
                          <div className="flex items-center gap-2">
                            <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] border border-[var(--t-crit)]">
                              {t('profiles.needsLogin')}
                            </span>
                            {canLogin && (
                              <button
                                type="button"
                                onClick={() => handleManualLogin(profile.name)}
                                className="text-xs text-[var(--t-accent)] hover:underline font-medium cursor-pointer"
                              >
                                {t('profiles.loginNow')}
                              </button>
                            )}
                          </div>
                        ) : isNeedsVerification ? (
                          <div className="space-y-1">
                            {profile.email && (
                              <div className="font-medium text-[var(--t-text)]">
                                {profile.email}
                              </div>
                            )}
                            <div>
                              <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-semibold bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border border-[var(--t-warn)]">
                                {t('extra.needVerification')}
                              </span>
                            </div>
                            <div>
                              {profile.verifyUrl ? (
                                <a
                                  href={profile.verifyUrl}
                                  target="_blank"
                                  rel="noopener"
                                  className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)] hover:underline font-medium cursor-pointer"
                                >
                                  {t('extra.openVerification')}
                                </a>
                              ) : (
                                <button
                                  type="button"
                                  disabled
                                  className="inline-flex items-center gap-1 text-xs text-[var(--t-text-3)] font-medium cursor-not-allowed"
                                >
                                  {t('extra.openVerification')}
                                </button>
                              )}
                            </div>
                            <p className="text-xs text-[var(--t-text-3)]">
                              {t('extra.verificationTip')}
                            </p>
                            {isDup && profile.email && (
                              <div className="mt-1 text-xs text-[var(--t-crit)] font-bold flex items-start gap-1">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <div>
                                  <span>
                                    {profile.duplicateEmailWith && profile.duplicateEmailWith.length > 0
                                      ? t('profiles.duplicateEmail', { emails: profile.duplicateEmailWith.join(', ') })
                                      : t('extra.duplicateWarning')}
                                  </span>
                                  <div className="font-normal text-[11px] text-[var(--t-crit)]">
                                    {t('extra.duplicateTip')}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        ) : isNotLoggedIn ? (
                          <div className="flex items-center gap-2">
                            <span className="text-xs text-[var(--t-text-3)] italic">{t('profiles.notLoggedIn')}</span>
                            {canLogin && (
                              <button
                                type="button"
                                onClick={() => handleManualLogin(profile.name)}
                                className="text-xs text-[var(--t-accent)] hover:underline font-medium cursor-pointer"
                              >
                                {t('profiles.loginNow')}
                              </button>
                            )}
                          </div>
                        ) : (
                          <div>
                            <span className="font-medium text-[var(--t-text)]">
                              {profile.engine === 'codex'
                                ? 'Codex (ChatGPT)'
                                : profile.email || t('extra.loggedIn')}
                            </span>
                            {/* Duplicate email warning */}
                            {isDup && profile.email && (
                                <div className="mt-1 text-xs text-[var(--t-crit)] font-bold flex items-start gap-1">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <div>
                                  <span>
                                    {profile.duplicateEmailWith && profile.duplicateEmailWith.length > 0
                                      ? t('profiles.duplicateEmail', { emails: profile.duplicateEmailWith.join(', ') })
                                      : t('extra.duplicateWarning')}
                                  </span>
                                  <div className="font-normal text-[11px] text-[var(--t-crit)]">
                                    {t('extra.duplicateTip')}
                                  </div>
                                </div>
                              </div>
                            )}
                          </div>
                        )}
                      </td>

                      {/* Live quota usage & Quota marks */}
                      <td className="px-6 py-4">
                        <div className="space-y-2">
                          {activeQuotaMarks.length > 0 && (
                            <div className="flex flex-col gap-1.5">
                              {activeQuotaMarks.map((mark) => (
                                <div
                                  key={mark.family}
                                  data-testid={`quota-mark-${mark.family}`}
                                  title={mark.reason}
                                  className="inline-flex items-center flex-wrap gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-[color-mix(in_srgb,var(--t-warn)_15%,transparent)] text-[var(--t-warn)] border border-[var(--t-warn)]/30"
                                >
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-[var(--t-warn)]" />
                                  <span>
                                    {t('profiles.quotaLocked', {
                                      family: mark.family,
                                      time: formatHHMM(mark.until),
                                    })}
                                  </span>
                                  <CountdownTimer
                                    until={mark.until}
                                    onExpire={() => queryClient.invalidateQueries({ queryKey: ['profiles'] })}
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleRemoveQuota(profile.name, mark.family)}
                                    disabled={
                                      deleteQuotaMutation.isPending &&
                                      deleteQuotaMutation.variables?.name === profile.name &&
                                      deleteQuotaMutation.variables?.family === mark.family
                                    }
                                    className="ml-1 px-2 py-0.5 text-xs font-semibold rounded bg-[var(--t-warn)] text-white hover:opacity-90 transition-opacity cursor-pointer disabled:opacity-50"
                                  >
                                    {t('profiles.removeQuota')}
                                  </button>
                                </div>
                              ))}
                            </div>
                          )}
                          <QuotaUsage
                            usage={profile.usage}
                            onRefresh={() => usageMutation.mutate(profile.name)}
                            refreshing={usageMutation.isPending && usageMutation.variables === profile.name}
                          />
                        </div>
                      </td>

                      {/* Busy Status */}
                      <td className="px-6 py-4 text-xs font-medium">
                        {profile.slotsTotal ? (
                          <span className={isBusy ? 'text-[var(--t-accent)]' : 'text-[var(--t-text-3)]'}>{isBusy ? t('extra.executing', { used: profile.slotsUsed || 0, total: profile.slotsTotal }) : t('profiles.ready')}</span>
                        ) : (
                          <span className="text-[var(--t-text-3)]">{t('profiles.idle')}</span>
                        )}
                      </td>

                      {/* Enable/Disable Toggle */}
                      <td className="px-6 py-4">
                        <button
                          type="button"
                          onClick={() =>
                            toggleMutation.mutate({ name: profile.name, enabled: !isEnabled })
                          }
                          aria-label={t('profiles.toggleAria', { name: profile.name })}
                          className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus:outline-none ${
                            isEnabled ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-surface-2)]'
                          }`}
                        >
                          <span
                            className={`pointer-events-none inline-block h-4 w-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out ${
                              isEnabled ? 'translate-x-4' : 'translate-x-0'
                            }`}
                          />
                        </button>
                      </td>

                      {/* Action buttons */}
                      <td className="px-6 py-4 text-right space-x-2">
                        {/* Check button */}
                        {(() => {
                          const isChecking = Boolean(checkingMap[profile.name]);
                          return (
                            <button
                              type="button"
                              onClick={() => handleCheck(profile.name)}
                              disabled={isChecking}
                              className={`inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border transition-colors ${
                                isChecking
                                  ? 'border-[var(--t-accent)] bg-[var(--t-accent-bg)] text-[var(--t-accent)] opacity-90 cursor-not-allowed'
                                  : 'border-[var(--t-border)] bg-[var(--t-surface-2)] hover:bg-[var(--t-surface-2)] cursor-pointer'
                              }`}
                            >
                              {isChecking ? (
                                <>
                                  <span
                                    role="status"
                                    aria-label={t('common.loading')}
                                    className="animate-spin inline-block w-3 h-3 border-2 border-current border-t-transparent rounded-full"
                                  />
                                  <span>{t('profiles.checkingBtn')}</span>
                                </>
                              ) : (
                                <span>{t('profiles.checkBtn')}</span>
                              )}
                            </button>
                          );
                        })()}

                        {/* Relogin / Login button */}
                        {canLogin && (
                          <button
                            type="button"
                            onClick={() => handleManualLogin(profile.name)}
                            className="px-2.5 py-1 text-xs font-medium rounded bg-[var(--t-accent-bg)] text-[var(--t-accent)] border border-[var(--t-accent)] hover:bg-[var(--t-accent-bg)] cursor-pointer"
                          >
                            {t('profiles.loginBtn')}
                          </button>
                        )}
                        {profile.engine === 'claude' && profile.kind === 'isolated' && (
                          <button type="button" onClick={async () => {
                            if (!window.confirm(`Xóa hồ sơ Claude ${profile.name}?`)) return;
                            await deleteProfile(profile.name);
                            queryClient.invalidateQueries({ queryKey: ['profiles'] });
                          }} className="px-2.5 py-1 text-xs font-medium rounded text-[var(--t-crit)] border border-[var(--t-crit)] cursor-pointer">Đăng xuất</button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Daily Usage Table */}
      <DailyUsageTable />

      {/* Add Profile Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className="bg-[var(--t-surface)] rounded-xl max-w-md w-full p-6 space-y-4 border border-[var(--t-border)] shadow-xl">
            <h3 className="text-lg font-bold">{t('profiles.modalAddTitle')}</h3>
            <p className="text-xs text-[var(--t-text-3)]">
              {t('profiles.modalAddDesc')}
            </p>

            {addError && (
              <div className="p-3 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-xs">
                {addError}
              </div>
            )}

            <form onSubmit={createAndLogin} className="space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('profiles.profileNameLabel')}
                </label>
                <input
                  type="text"
                  placeholder={t('profiles.profileNamePlaceholder')}
                  value={newProfileName}
                  onChange={(e) => setNewProfileName(e.target.value)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">Engine</label>
                <select value={newProfileEngine} onChange={(e) => setNewProfileEngine(e.target.value as 'agy' | 'claude')} className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)]">
                  <option value="agy">Antigravity</option>
                  <option value="claude">Claude Code</option>
                </select>
              </div>

              <div className="flex justify-end gap-3 pt-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
                >
                  {t('common.cancel')}
                </button>
                <button
                  type="submit"
                  className="px-4 py-2 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white cursor-pointer"
                >
                  {t('profiles.createAndLoginBtn')}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Login Terminal Modal with xterm.js */}
      {activeLogin && (
        <LoginTerminal
          profileName={activeLogin.name}
          sessionId={activeLogin.sessionId}
          onClose={() => setActiveLogin(null)}
        />
      )}
    </div>
  );
};
