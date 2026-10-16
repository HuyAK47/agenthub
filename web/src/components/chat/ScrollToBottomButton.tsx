import React from 'react';
import { ArrowDown } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';

interface ScrollToBottomButtonProps {
  show: boolean;
  onClick: () => void;
}

export const ScrollToBottomButton: React.FC<ScrollToBottomButtonProps> = ({
  show,
  onClick,
}) => {
  const { t } = useLocale();
  if (!show) return null;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={t('extra.newMessages')}
      className="absolute bottom-20 left-1/2 -translate-x-1/2 z-20 flex items-center gap-1.5 px-3.5 py-1.5 rounded-full bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold shadow-lg transition-all transform hover:scale-105 cursor-pointer animate-bounce focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
    >
      <ArrowDown className="w-3.5 h-3.5" />
      <span>↓ {t('extra.newMessages')}</span>
    </button>
  );
};
