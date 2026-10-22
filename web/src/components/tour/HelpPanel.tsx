import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';
import { TourDefinition, tourDefinitions, modalTourDefinitions, useTour } from './TourContext';

type HelpPanelProps = { open: boolean; onClose: () => void };

export const HelpPanel: React.FC<HelpPanelProps> = ({ open, onClose }) => {
  const { t } = useLocale();
  const { openTour, getPageTour } = useTour();
  const [query, setQuery] = useState('');
  const current = getPageTour(typeof window === 'undefined' ? '/' : window.location.pathname);
  const tours = useMemo(() => {
    const all = [...tourDefinitions, ...(current ? [current] : []), ...modalTourDefinitions];
    const unique = new Map<string, TourDefinition>();
    all.forEach((tour) => unique.set(tour.id, tour));
    const needle = query.trim().toLocaleLowerCase();
    return Array.from(unique.values()).filter((tour) => !needle || `${tour.id} ${tour.steps.map((step) => `${t(step.title)} ${t(step.content)}`).join(' ')}`.toLocaleLowerCase().includes(needle));
  }, [current, query, t]);

  if (!open) return null;
  return (
    <div className="fixed inset-0 z-[65]" role="dialog" aria-modal="true" aria-label={t('tour.panelTitle')}>
      <button type="button" aria-label={t('tour.close')} className="absolute inset-0 bg-[var(--t-overlay)]" onClick={onClose} />
      <aside className="absolute right-0 top-0 h-full w-full max-w-md overflow-y-auto border-l border-[var(--t-border)] bg-[var(--t-surface)] p-5 text-[var(--t-text)] shadow-2xl">
        <div className="flex items-center justify-between gap-3">
          <div><h2 className="text-lg font-semibold">{t('tour.panelTitle')}</h2><p className="mt-1 text-xs text-[var(--t-text-3)]">{t('tour.panelDescription')}</p></div>
          <button type="button" onClick={onClose} aria-label={t('tour.close')} className="rounded-lg p-2 hover:bg-[var(--t-hover)]"><X size={18} /></button>
        </div>
        <label className="mt-5 flex items-center gap-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2">
          <Search size={16} className="text-[var(--t-text-3)]" />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('tour.search')} aria-label={t('tour.search')} className="min-w-0 flex-1 bg-transparent text-sm outline-none" />
        </label>
        <div className="mt-5 space-y-2">
          {tours.map((tour) => (
            <button key={tour.id} type="button" onClick={() => { openTour(tour.id); onClose(); }} className="w-full rounded-lg border border-[var(--t-border)] p-3 text-left hover:bg-[var(--t-hover)]">
              <span className="block text-sm font-semibold">{tour.steps[0] ? t(tour.steps[0].title) : tour.id}</span>
              <span className="mt-1 block text-xs text-[var(--t-text-3)]">{t('tour.stepCount', { count: tour.steps.length })}</span>
            </button>
          ))}
          {!tours.length && <p className="py-6 text-center text-sm text-[var(--t-text-3)]">{t('tour.noResults')}</p>}
        </div>
        <button type="button" onClick={() => { if (current) openTour(current.id); onClose(); }} disabled={!current} className="mt-5 w-full rounded-lg bg-[var(--t-accent)] px-3 py-2 text-sm font-semibold text-[var(--t-on-accent)] disabled:opacity-50">{t('tour.restartCurrent')}</button>
      </aside>
    </div>
  );
};
