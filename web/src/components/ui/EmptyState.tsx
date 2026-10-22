import React from 'react';
import { useLocale } from '../../context/LocaleContext';

export const EmptyState: React.FC<{ title?: string; description?: string }> = ({ title, description }) => {
  const { t } = useLocale();
  return (
  <div className="flex min-h-24 flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-[var(--t-border)] p-6 text-center text-sm text-[var(--t-text-3)]">
    <p className="font-medium text-[var(--t-text)]">{title || t('pagination.empty')}</p>
    {description && <p>{description}</p>}
  </div>
  );
};

