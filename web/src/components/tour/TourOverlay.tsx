import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useLocale } from '../../context/LocaleContext';
import { useTour } from './TourContext';

type Rect = { top: number; left: number; width: number; height: number };

export const TourOverlay: React.FC = () => {
  const { t } = useLocale();
  const { active, stepIndex, next, previous, closeTour } = useTour();
  const location = useLocation();
  const [rect, setRect] = useState<Rect | null>(null);
  const step = active?.steps[stepIndex];
  const title = step ? t(step.title) : '';
  const content = step ? t(step.content) : '';

  useEffect(() => {
    if (!active || !step) return;
    let cancelled = false;
    let attempts = 0;
    const locate = () => {
      if (cancelled) return;
      const target = document.querySelector(step.selector) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: 'center', behavior: 'smooth' });
        const update = () => {
          const box = target.getBoundingClientRect();
          setRect({ top: box.top, left: box.left, width: box.width, height: box.height });
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('scroll', update, true);
        return () => { window.removeEventListener('resize', update); window.removeEventListener('scroll', update, true); };
      }
      if (attempts++ < 20) window.setTimeout(locate, 50);
      else next();
    };
    setRect(null);
    const cleanup = locate();
    return () => { cancelled = true; if (typeof cleanup === 'function') cleanup(); };
  }, [active, location.pathname, next, step]);

  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTour(false);
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') previous();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closeTour, next, previous]);

  if (!active || !step || !rect) return null;
  const gap = 14;
  const bubbleWidth = Math.min(360, window.innerWidth - 24);
  const placement = step.placement || 'bottom';
  const preferred = placement === 'top'
    ? { top: rect.top - gap, left: rect.left + rect.width / 2, transform: 'translate(-50%, -100%)' }
    : placement === 'left'
      ? { top: rect.top + rect.height / 2, left: rect.left - gap, transform: 'translate(-100%, -50%)' }
      : placement === 'right'
        ? { top: rect.top + rect.height / 2, left: rect.left + rect.width + gap, transform: 'translateY(-50%)' }
        : { top: rect.top + rect.height + gap, left: rect.left + rect.width / 2, transform: 'translateX(-50%)' };
  const top = placement === 'top' && rect.top < 190 ? rect.top + rect.height + gap : preferred.top;
  const safeLeft = Math.max(12, Math.min(window.innerWidth - 12, preferred.left));
  const safeStyle: React.CSSProperties = { top, left: safeLeft, width: bubbleWidth, transform: preferred.transform };

  return (
    <div className="fixed inset-0 z-[70]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-[var(--t-overlay)]" />
      <div className="absolute rounded-xl pointer-events-none border-2 border-[var(--t-accent)] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)]" style={{ top: rect.top - 4, left: rect.left - 4, width: rect.width + 8, height: rect.height + 8 }} />
      <section className="absolute rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 shadow-2xl text-[var(--t-text)] max-sm:!left-3 max-sm:!right-3 max-sm:!bottom-3 max-sm:!top-auto max-sm:!transform-none max-sm:!w-auto" style={safeStyle}>
        <button type="button" onClick={() => closeTour(false)} aria-label={t('tour.close')} className="absolute right-2 top-2 rounded p-1 text-[var(--t-text-3)] hover:bg-[var(--t-hover)]"><X size={16} /></button>
        <h2 className="pr-6 text-base font-semibold">{title}</h2>
        <p className="mt-2 text-sm text-[var(--t-text-2)]">{content}</p>
        <div className="mt-4 flex items-center justify-between gap-3">
          <span className="text-xs text-[var(--t-text-3)]">{t('tour.step', { current: stepIndex + 1, total: active.steps.length })}</span>
          <div className="flex gap-2">
            <button type="button" onClick={previous} disabled={stepIndex === 0} className="rounded-lg border border-[var(--t-border)] px-3 py-1.5 text-xs disabled:opacity-40">{t('tour.previous')}</button>
            <button type="button" onClick={next} className="rounded-lg bg-[var(--t-accent)] px-3 py-1.5 text-xs font-semibold text-[var(--t-on-accent)]">{stepIndex === active.steps.length - 1 ? t('tour.finish') : t('tour.next')}</button>
            <button type="button" onClick={() => closeTour(false)} className="rounded-lg px-2 py-1.5 text-xs text-[var(--t-text-3)] hover:text-[var(--t-text)]">{t('tour.skip')}</button>
          </div>
        </div>
      </section>
    </div>
  );
};
