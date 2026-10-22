import React, { useEffect, useRef, useState, useCallback } from 'react';
import { getVersion, getToken } from '../api/client';
import { RefreshCw } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';

export const VersionBanner: React.FC = () => {
  const { t } = useLocale();
  const [hasUpdate, setHasUpdate] = useState(false);
  const initialBuildIdRef = useRef<string | null>(null);
  const isInitializedRef = useRef<boolean>(false);

  const checkVersion = useCallback(async () => {
    const token = getToken();
    if (!token) return;

    try {
      const data = await getVersion();
      if (!data || !data.webBuildId) return;

      if (!isInitializedRef.current) {
        initialBuildIdRef.current = data.webBuildId;
        isInitializedRef.current = true;
      } else if (
        initialBuildIdRef.current &&
        data.webBuildId !== initialBuildIdRef.current
      ) {
        setHasUpdate(true);
      }
    } catch {
      // Ignore 404 and other unavailable version endpoints.
    }
  }, []);

  useEffect(() => {
    checkVersion();

    const interval = setInterval(checkVersion, 60000);

    const onFocus = () => {
      checkVersion();
    };
    window.addEventListener('focus', onFocus);

    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', onFocus);
    };
  }, [checkVersion]);

  if (!hasUpdate) return null;

  return (
    <div
      data-tour="updates"
      role="alert"
      className="bg-[var(--t-accent)] text-[var(--t-on-accent)] px-4 py-2 text-sm font-medium flex items-center justify-between shadow-md relative z-50"
    >
      <div className="flex items-center gap-2">
        <RefreshCw className="w-4 h-4 animate-spin-slow" />
        <span>{t('extra.updateAvailable')}</span>
      </div>
      <button
        type="button"
        onClick={() => window.location.reload()}
        className="px-3 py-1 bg-[var(--t-surface)] text-[var(--t-accent)] hover:bg-[var(--t-hover)] text-xs font-semibold rounded-lg shadow-xs cursor-pointer"
      >
        {t('extra.reload')}
      </button>
    </div>
  );
};
