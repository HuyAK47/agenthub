import React, { useEffect, useState } from 'react';
import { getToken, initTokenFromHash, setToken, subscribeUnauthorized } from '../api/client';
import { KeyRound, Terminal, ShieldAlert } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

interface AuthGateProps {
  children: React.ReactNode;
}

export const AuthGate: React.FC<AuthGateProps> = ({ children }) => {
  const { t } = useLocale();
  const [token, setTokenState] = useState<string | null>(() => {
    // Try reading hash first
    const fromHash = initTokenFromHash();
    return fromHash || getToken();
  });
  const [manualToken, setManualToken] = useState('');
  const [showManualInput, setShowManualInput] = useState(false);

  useEffect(() => {
    // Check hash on mount/hashchange
    const onHashChange = () => {
      const t = initTokenFromHash();
      if (t) setTokenState(t);
    };
    window.addEventListener('hashchange', onHashChange);

    const unsubscribe = subscribeUnauthorized(() => {
      setTokenState(null);
    });

    return () => {
      window.removeEventListener('hashchange', onHashChange);
      unsubscribe();
    };
  }, []);

  const handleManualSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (manualToken.trim()) {
      setToken(manualToken.trim());
      setTokenState(manualToken.trim());
    }
  };

  if (!token) {
    return (
      <div
        data-testid="auth-required-screen"
        className="min-h-screen flex items-center justify-center p-4 bg-[var(--t-bg)] text-[var(--t-text)]"
      >
        <div className="max-w-md w-full bg-[var(--t-surface)] rounded-xl shadow-lg border border-[var(--t-border)] p-8 text-center space-y-6">
          <div className="w-16 h-16 mx-auto bg-[var(--t-warn)]/15 rounded-full flex items-center justify-center text-[var(--t-warn)]">
            <ShieldAlert className="w-8 h-8" />
          </div>

          <div className="space-y-2">
            <h1 className="text-xl font-bold tracking-tight">{t('authGate.title')}</h1>
            <p className="text-sm text-[var(--t-text-3)]">
              {t('authGate.desc')}
            </p>
          </div>

          <div className="bg-[var(--t-surface-2)] text-[var(--t-text)] p-4 rounded-lg font-mono text-sm flex items-center justify-between border border-[var(--t-border)] shadow-inner">
            <div className="flex items-center gap-2">
              <Terminal className="w-4 h-4 text-[var(--t-ok)]" />
              <span className="text-[var(--t-ok)] font-bold">agenthub open</span>
            </div>
          </div>

          <p className="text-xs text-[var(--t-text-3)]">
            {t('authGate.info')}
          </p>

          <div className="pt-4 border-t border-[var(--t-border)]">
            <button
              type="button"
              onClick={() => setShowManualInput(!showManualInput)}
              className="text-xs text-[var(--t-accent)] hover:underline inline-flex items-center gap-1 cursor-pointer"
            >
              <KeyRound className="w-3 h-3" />
              {showManualInput ? t('authGate.hideManual') : t('authGate.showManual')}
            </button>

            {showManualInput && (
              <form onSubmit={handleManualSubmit} className="mt-3 flex gap-2">
                <input
                  type="password"
                  placeholder={t('authGate.placeholder')}
                  value={manualToken}
                  onChange={(e) => setManualToken(e.target.value)}
                  className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-hidden focus:ring-2 focus:ring-[var(--t-accent)]/30 focus:border-[var(--t-accent)]"
                />
                <button
                  type="submit"
                  className="px-3 py-1.5 text-xs font-medium rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white cursor-pointer"
                >
                  {t('authGate.confirm')}
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  return <>{children}</>;
};
