import type { StepProps } from './types';

export function StepMode({ draft, update, t }: StepProps) {
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {(['existing', 'new'] as const).map((mode) => {
        const label = mode === 'existing' ? 'Existing' : 'New';
        return (
          <button
            type="button"
            aria-pressed={draft.mode === mode}
            key={mode}
            className={`rounded-lg border p-4 text-left ${
              draft.mode === mode
                ? 'border-[var(--t-accent)]'
                : 'border-[var(--t-border)]'
            }`}
            onClick={() => update({ mode })}
          >
            <b>{t(`projects.wizard${label}`)}</b>
            <p className="mt-1 text-xs text-[var(--t-text-3)]">
              {t(`projects.wizard${label}Desc`)}
            </p>
          </button>
        );
      })}
    </div>
  );
}
