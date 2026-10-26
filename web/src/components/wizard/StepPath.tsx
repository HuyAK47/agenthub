import { Input } from '../ui';
import type { StepProps } from './types';

export function StepPath({ draft, update, t }: StepProps) {
  return (
    <div className="grid gap-4 md:grid-cols-2">
      <label className="text-sm">
        {t('projects.nameLabel')}
        <Input
          className="mt-1"
          value={draft.name}
          onChange={(event) => update({ name: event.target.value })}
          placeholder={t('projects.namePlaceholder')}
        />
      </label>
      <label className="text-sm">
        {t('projects.pathLabel')}
        <Input
          className="mt-1"
          value={draft.path}
          onChange={(event) => update({ path: event.target.value })}
          placeholder={t('projects.pathPlaceholder')}
        />
      </label>
    </div>
  );
}
