import React from 'react';

export const EmptyState: React.FC<{ title?: string; description?: string }> = ({ title = 'Không có dữ liệu', description }) => (
  <div className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--t-border)] p-6 text-center text-sm text-[var(--t-text-3)]">
    <p className="font-medium text-[var(--t-text)]">{title}</p>
    {description && <p>{description}</p>}
  </div>
);

