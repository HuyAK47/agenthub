import React from 'react';
import { TaskStatus } from '../types/api';
import { useLocale } from '../context/LocaleContext';

export type ExtendedTaskStatus = TaskStatus | 'checking';

interface StatusBadgeProps {
  status: ExtendedTaskStatus;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  className = '',
  size = 'md',
}) => {
  const { t } = useLocale();
  const label = t(`status.${status}`);
  const isPulse = status === 'running' || status === 'checking';

  const sizeClasses = {
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-xs font-semibold px-3 py-1',
    lg: 'text-sm font-semibold px-3.5 py-1.5',
  }[size];

  return (
    <span
      data-testid={`status-badge-${status}`}
      style={{
        backgroundColor: `var(--status-${status}-bg, color-mix(in srgb, var(--t-surface-2) 15%, transparent))`,
        color: `var(--status-${status}-text, var(--t-text))`,
        borderColor: `var(--status-${status}-border, transparent)`,
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border border-transparent font-semibold transition-colors ${sizeClasses}  ${className}`}
    >
      <span
        style={{
          backgroundColor: `var(--status-${status}-dot, currentColor)`,
        }}
        className={`w-1.5 h-1.5 rounded-full ${isPulse ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
};
