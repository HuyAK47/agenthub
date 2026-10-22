import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  addProjectKnowledge,
  createNewProject,
  createProject,
  createTask,
  inspectProject,
  writeProjectGuidance,
} from '../api/client';
import { useLocale } from '../context/LocaleContext';
import type { ProjectInspection, ProjectSettings } from '../types/api';
import { Button, Card } from './ui';
import {
  emptyDraft,
  StepBrain,
  StepContext,
  StepInspect,
  StepMode,
  StepPath,
  StepSuggestions,
  StepSummary,
} from './wizard';
import type { WizardDraft } from './wizard';

const DRAFT_KEY = 'agenthub.projectWizard';

function restoredDraft(): WizardDraft {
  try {
    const saved = JSON.parse(localStorage.getItem(DRAFT_KEY) || '{}') as Partial<WizardDraft>;
    return { ...emptyDraft(), ...saved };
  } catch {
    return emptyDraft();
  }
}

function projectSettings(draft: WizardDraft, inspection: ProjectInspection | null): ProjectSettings {
  const sensitiveRoot = draft.sensitive && inspection?.mount.mountpoint
    ? inspection.mount.mountpoint
    : draft.settings.worktree.root;
  return {
    ...draft.settings,
    brain: draft.sensitive
      ? { ...draft.settings.brain, permissions: 'standard' }
      : draft.settings.brain,
    worktree: {
      ...draft.settings.worktree,
      ...(sensitiveRoot ? { root: sensitiveRoot, logsInRoot: true } : {}),
      install: draft.skipInstall ? 'skip' : 'auto',
      gitHooks: draft.skipHooks ? 'skip' : 'run',
    },
    integration: {
      ...draft.settings.integration,
      enabled: draft.integration,
      branch: draft.integration
        ? `agenthub/${draft.name.toLowerCase().replace(/[^a-z0-9_-]+/g, '-')}-integration`
        : undefined,
      baseRef: draft.branch,
    },
    references: draft.references.filter((reference) => reference.name && reference.path),
    notifications: draft.sensitive
      ? { ...draft.settings.notifications, telegramContent: 'minimal' }
      : draft.settings.notifications,
  };
}

export function ProjectWizard({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WizardDraft>(restoredDraft);

  const update = (patch: Partial<WizardDraft>) => {
    setError(null);
    setDraft((current) => ({ ...current, ...patch }));
  };

  const inspectMutation = useMutation({
    mutationFn: () => inspectProject(draft.path),
    onSuccess: (value) => {
      setInspection(value);
      setDraft((current) => ({
        ...current,
        branch: value.currentBranch || value.branches[0] || current.branch,
        checks: value.suggestedSettings.checks,
        skipInstall: value.suggestedSettings.skipInstall,
        skipHooks: value.suggestedSettings.skipGitHooks,
        integration: value.isGitRepo,
        sensitive: value.suggestedSettings.sensitiveProject,
      }));
      setStep(2);
    },
    onError: (cause: Error) => setError(cause.message),
  });

  const createMutation = useMutation({
    mutationFn: async () => {
      const input = {
        name: draft.name,
        path: draft.path,
        defaultBranch: draft.branch,
        checks: draft.checks,
        settings: projectSettings(draft, inspection),
      };
      return draft.mode === 'new' ? createNewProject(input) : createProject(input);
    },
    onSuccess: async (project) => {
      if (draft.contextApproved) {
        if (draft.pinMemory && inspection?.memoryPreview) {
          await addProjectKnowledge(project.id, { content: inspection.memoryPreview, pinned: true });
        }
        if (draft.selectedSessions.length > 0) {
          await createTask({
            project: project.id,
            slug: 'summarize-previous-context',
            title: 'Review and summarize previous Claude Code context',
            body: [
              'Read the selected previous session files and summarize durable project knowledge.',
              '',
              'Selected sessions:',
              ...draft.selectedSessions,
              '',
              'Present the proposed knowledge for user approval before pinning it.',
            ].join('\n'),
            level: 'easy',
            start: true,
          });
        }
      }
      if (draft.agentsDraft && draft.agentsApproved && draft.agentsContent.trim()) {
        await writeProjectGuidance(project.id, draft.agentsContent.trim());
      }
      localStorage.removeItem(DRAFT_KEY);
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  useEffect(() => {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
  }, [draft]);

  const canNext = useMemo(
    () => step !== 1 || Boolean(draft.name.trim() && draft.path.trim()),
    [step, draft.name, draft.path],
  );

  const next = () => {
    setError(null);
    if (step === 1 && draft.mode === 'existing') {
      inspectMutation.mutate();
      return;
    }
    if (step === 1) setInspection(null);
    setStep((current) => Math.min(6, current + 1));
  };

  return (
    <Card data-testid="project-wizard" data-tour="modal-project-wizard" className="space-y-5 p-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold">{t('projects.wizardTitle')}</h2>
          <p className="text-sm text-[var(--t-text-3)]">{t(`projects.wizardWhy${step}`)}</p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>{t('common.close')}</Button>
      </div>
      <div className="flex gap-1" aria-label={t('projects.wizardProgress')}>
        {[0, 1, 2, 3, 4, 5, 6].map((item) => (
          <div key={item} className={`h-1 flex-1 rounded ${item <= step ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-border)]'}`} />
        ))}
      </div>
      {error && <div role="alert" className="rounded-lg p-3 text-sm text-[var(--t-crit)]">{error}</div>}
      {step === 0 && <StepMode draft={draft} update={update} t={t} />}
      {step === 1 && <StepPath draft={draft} update={update} t={t} />}
      {step === 2 && <StepInspect inspection={inspection} draft={draft} update={update} t={t} />}
      {step === 3 && <StepSuggestions inspection={inspection} draft={draft} update={update} t={t} />}
      {step === 4 && <StepContext inspection={inspection} draft={draft} update={update} t={t} />}
      {step === 5 && <StepBrain draft={draft} update={update} t={t} />}
      {step === 6 && <StepSummary draft={draft} inspection={inspection} t={t} />}
      <div className="flex justify-between">
        <Button type="button" variant="secondary" size="sm" disabled={step === 0} onClick={() => setStep((current) => Math.max(0, current - 1))}>{t('projects.wizardBack')}</Button>
        {step < 6 ? (
          <Button type="button" size="sm" onClick={next} disabled={!canNext || inspectMutation.isPending} loading={inspectMutation.isPending}>{t('projects.wizardNext')}</Button>
        ) : (
          <Button type="button" size="sm" onClick={() => createMutation.mutate()} loading={createMutation.isPending}>{t('projects.wizardCreate')}</Button>
        )}
      </div>
    </Card>
  );
}

export { projectSettings };
