import React, { useEffect, useState } from 'react';
import { useLocale } from '../context/LocaleContext';

interface CountdownTimerProps {
  until: number; // epoch seconds
  className?: string;
  onExpire?: () => void;
}

export function formatRemaining(seconds: number, expiredText = '\u0048\u1ebft h\u1ea1n'): string {
  if (seconds <= 0) return expiredText;
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hrs > 0) {
    return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const CountdownTimer: React.FC<CountdownTimerProps> = ({
  until,
  className = '',
  onExpire,
}) => {
  const { t } = useLocale();
  const [remaining, setRemaining] = useState<number>(() => {
    const now = Math.floor(Date.now() / 1000);
    return Math.max(0, until - now);
  });

  useEffect(() => {
    const update = () => {
      const now = Math.floor(Date.now() / 1000);
      const diff = Math.max(0, until - now);
      setRemaining(diff);
      if (diff === 0 && onExpire) {
        onExpire();
      }
    };

    update();
    const interval = setInterval(update, 1000);
    return () => clearInterval(interval);
  }, [until, onExpire]);

  const isExpired = remaining <= 0;

  return (
    <span
      data-testid="countdown-timer"
      className={`font-mono inline-flex items-center text-xs px-2 py-0.5 rounded border ${
        isExpired
          ? 'bg-[var(--t-surface-2)] text-[var(--t-text-3)] border-[var(--t-border)]'
          : 'bg-[var(--t-warn)]/15 text-[var(--t-warn)] border-[var(--t-warn)]/30'
      }  ${className}`}
    >
      ⏱ {formatRemaining(remaining, t('timer.expired'))}
    </span>
  );
};

