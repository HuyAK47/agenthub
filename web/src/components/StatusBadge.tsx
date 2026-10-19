import React from 'react';
import { QueryClientContext } from '@tanstack/react-query';
import { TaskStatus, WaitReason, HubStatus } from '../types/api';
import { useLocale } from '../context/LocaleContext';

export type ExtendedTaskStatus = TaskStatus | 'checking';

export interface StatusBadgeProps {
  status: ExtendedTaskStatus;
  waitReason?: WaitReason;
  diskFreeGB?: number;
  diskMinFreeGB?: number;
  diskLabel?: string;
  className?: string;
  size?: 'sm' | 'md' | 'lg';
}

export const StatusBadge: React.FC<StatusBadgeProps> = ({
  status,
  waitReason,
  diskFreeGB,
  diskMinFreeGB,
  diskLabel,
  className = '',
  size = 'md',
}) => {
  const { t } = useLocale();
  const queryClient = React.useContext(QueryClientContext);
  const cachedStatus = queryClient?.getQueryData<HubStatus>(['status']);

  let label = t(`status.${status}`);
  if (waitReason) {
    if (waitReason === 'disk') {
      const free = diskFreeGB ?? cachedStatus?.disk?.freeGB;
      const min = diskMinFreeGB ?? cachedStatus?.disk?.minFreeGB;
      if (free !== undefined && min !== undefined) {
        const diskName = diskLabel ?? cachedStatus?.disks?.find((disk) => disk.low)?.label;
        label = diskName ? t('waitReason.diskNamed', { label: diskName, free, min }) : t('waitReason.disk', { free, min });
      } else {
        label = t('waitReason.diskShort');
      }
    } else if (waitReason === 'quota') {
      label = t('waitReason.quota');
    } else if (waitReason === 'parallel') {
      label = t('waitReason.parallel');
    } else if (waitReason === 'profile_busy') {
      label = t('waitReason.profile_busy');
    }
  }

  const isPulse = status === 'running' || status === 'checking';
  const isWaitingWithReason = Boolean(waitReason);

  const bgStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-bg)`
    : `var(--status-${status}-bg, color-mix(in srgb, var(--t-surface-2) 15%, transparent))`;

  const colorStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-text)`
    : `var(--status-${status}-text, var(--t-text))`;

  const borderStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-border)`
    : `var(--status-${status}-border, transparent)`;

  const dotStyle = isWaitingWithReason
    ? `var(--wait-${waitReason}-dot)`
    : `var(--status-${status}-dot, currentColor)`;

  const sizeClasses = {
    sm: 'text-xs px-2.5 py-0.5',
    md: 'text-xs font-semibold px-3 py-1',
    lg: 'text-sm font-semibold px-3.5 py-1.5',
  }[size];

  return (
    <span
      data-testid={`status-badge-${status}`}
      data-status={status}
      data-wait-reason={waitReason || undefined}
      style={{
        backgroundColor: bgStyle,
        color: colorStyle,
        borderColor: borderStyle,
      }}
      className={`inline-flex items-center gap-1.5 rounded-full border border-transparent font-semibold transition-colors ${sizeClasses} ${className}`}
    >
      <span
        style={{
          backgroundColor: dotStyle,
        }}
        className={`w-1.5 h-1.5 rounded-full ${isPulse ? 'animate-pulse' : ''}`}
      />
      <span>{label}</span>
    </span>
  );
};
