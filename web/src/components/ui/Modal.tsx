import React, { useId } from 'react';
import { X } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';
import { useFocusTrap } from './useFocusTrap';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  maxWidth?: string;
  titleId?: string;
  ariaLabel?: string;
  'aria-label'?: string;
}

export const Modal: React.FC<ModalProps> = ({
  isOpen,
  onClose,
  title,
  children,
  className = '',
  maxWidth = 'max-w-lg',
  titleId: customTitleId,
  ariaLabel,
  'aria-label': propAriaLabel,
}) => {
  const { t, locale } = useLocale();
  const autoTitleId = useId();
  const titleId = customTitleId || autoTitleId;
  const containerRef = useFocusTrap<HTMLDivElement>({ isOpen, onClose });

  if (!isOpen) return null;

  const fallbackLabel = ariaLabel || propAriaLabel || (locale === 'en' ? 'Dialog' : 'Hộp thoại');

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      aria-label={!title ? fallbackLabel : undefined}
      onClick={onClose}
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className={`w-full ${maxWidth} bg-[var(--t-surface)] border border-[var(--t-border)] rounded-xl shadow-xl transition-all overflow-hidden flex flex-col max-h-[90vh] outline-hidden ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title ? (
          <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--t-border)]">
            <h3 id={titleId} className="text-base font-semibold text-[var(--t-text)]">{title}</h3>
            <button
              type="button"
              onClick={onClose}
              aria-label={t('common.close')}
              className="p-1 rounded-lg text-[var(--t-text-3)] hover:text-[var(--t-text)] hover:bg-[var(--t-hover)] transition-colors cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        ) : (
          <span id={titleId} className="sr-only">{fallbackLabel}</span>
        )}
        <div className="p-6 overflow-y-auto">{children}</div>
      </div>
    </div>
  );
};
