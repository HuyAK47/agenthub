import React from 'react';

export interface StatTileProps {
  label: string;
  value: React.ReactNode;
  icon?: React.ReactNode;
  iconColor?: string;
  iconBg?: string;
  subtext?: React.ReactNode;
  className?: string;
}

export const StatTile: React.FC<StatTileProps> = ({
  label,
  value,
  icon,
  iconColor = 'var(--t-accent)',
  iconBg,
  subtext,
  className = '',
}) => {
  const defaultIconBg = iconBg || `color-mix(in srgb, ${iconColor} 12%, transparent)`;

  return (
    <div
      className={`bg-[var(--t-surface)] border border-[var(--t-border)] rounded-xl p-5 shadow-[0_1px_3px_rgba(0,0,0,0.04)] shadow-none flex items-start justify-between gap-4 transition-colors ${className}`}
    >
      <div className="flex-1 min-w-0">
        <div className="text-xs font-medium text-[var(--t-text-3)] mb-1 truncate">{label}</div>
        <div className="text-[28px] font-bold leading-tight tabular-nums text-[var(--t-text)] truncate">
          {value}
        </div>
        {subtext && <div className="mt-1 text-xs text-[var(--t-text-3)]">{subtext}</div>}
      </div>
      {icon && (
        <div
          className="w-10 h-10 rounded-lg flex items-center justify-center shrink-0"
          style={{ backgroundColor: defaultIconBg, color: iconColor }}
        >
          {icon}
        </div>
      )}
    </div>
  );
};
