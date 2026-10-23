import type { ProjectSettings } from '../../types/api';
import type { StepProps } from './types';

export function StepBrain({ draft, update, t }: StepProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="text-sm">
        {t('projects.brainMode')}
        <select
          className="mt-1 w-full rounded border bg-[var(--t-surface-2)] p-2"
          value={draft.settings.brain.mode}
          onChange={(event) =>
            update({
              settings: {
                ...draft.settings,
                brain: {
                  ...draft.settings.brain,
                  mode: event.target
                    .value as ProjectSettings['brain']['mode'],
                },
              },
            })
          }
        >
          <option value="inherit">{t('projects.brainInherit')}</option>
          <option value="suggest">{t('projects.brainSuggest')}</option>
          <option value="auto">{t('projects.brainAuto')}</option>
          <option value="external">{t('projects.brainExternal')}</option>
        </select>
      </label>
      <label className="text-sm">
        {t('projects.telegramContent')}
        <select
          className="mt-1 w-full rounded border bg-[var(--t-surface-2)] p-2"
          value={draft.settings.notifications.telegramContent}
          onChange={(event) =>
            update({
              settings: {
                ...draft.settings,
                notifications: {
                  ...draft.settings.notifications,
                  telegramContent: event.target
                    .value as ProjectSettings['notifications']['telegramContent'],
                },
              },
            })
          }
        >
          <option value="full">{t('projects.telegramFull')}</option>
          <option value="minimal">{t('projects.telegramMinimal')}</option>
        </select>
      </label>
    </div>
  );
}
