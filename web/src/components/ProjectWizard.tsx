import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { addProjectKnowledge, createNewProject, createProject, createTask, inspectProject, writeProjectGuidance } from '../api/client';
import { useLocale } from '../context/LocaleContext';
import { ProjectInspection, ProjectSettings } from '../types/api';
import { Button, Card, Input } from './ui';

type WizardMode = 'existing' | 'new';
type Check = { name: string; cmd: string[]; reason: string };
type Reference = { name: string; path: string; inject: boolean };
type ClaudeSession = { name: string; modifiedAt: string; sizeBytes: number };

export interface WizardDraft {
  mode: WizardMode;
  name: string;
  path: string;
  branch: string;
  settings: ProjectSettings;
  skipInstall: boolean;
  skipHooks: boolean;
  integration: boolean;
  sensitive: boolean;
  checks: Check[];
  pinMemory: boolean;
  /** User confirmed they want to generate an AGENTS.md draft after creation */
  agentsDraft: boolean;
  /** Read-only references to attach */
  references: Reference[];
  /** Selected Claude sessions for context import */
  selectedSessions: string[];
  /** User has approved pinning the selected memory/sessions */
  contextApproved: boolean;
  agentsContent: string;
  agentsApproved: boolean;
}

type Translate = (key: string, vars?: Record<string, string | number>) => string;

export interface StepProps {
  draft: WizardDraft;
  update: (patch: Partial<WizardDraft>) => void;
  t: Translate;
}

const emptyDraft = (): WizardDraft => ({
  mode: 'existing',
  name: '',
  path: '',
  branch: 'main',
  settings: {
    brain: { mode: 'inherit', permissions: 'standard' },
    worktree: { install: 'auto', gitHooks: 'run' },
    integration: { enabled: false },
    ci: {},
    references: [],
    reviewChecklist: [],
    notifications: { telegramContent: 'full' },
  },
  skipInstall: false,
  skipHooks: false,
  integration: false,
  sensitive: false,
  checks: [],
  pinMemory: false,
  agentsDraft: false,
  references: [],
  selectedSessions: [],
  contextApproved: false,
  agentsContent: '# AgentHub project guidance\n\n## Conventions\n- Keep changes focused and use Conventional Commits.\n\n## Checks\n- Run the project checks before committing.\n',
  agentsApproved: false,
});

/* ------------------------------------------------------------------ */
/*  Step 0 – Mode                                                      */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Step 1 – Path & Name                                               */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/*  Step 2 – Inspect results & branch selector                         */
/* ------------------------------------------------------------------ */

export function StepInspect({
  inspection,
  draft,
  update,
  t,
}: StepProps & { inspection: ProjectInspection | null }) {
  return (
    <div className="space-y-3">
      {inspection ? (
        <div className="grid gap-2 text-sm sm:grid-cols-2">
          <span>
            {t('projects.wizardRepo')}:{' '}
            {inspection.isGitRepo ? 'Git' : t('projects.wizardNotGit')}
          </span>
          <span>
            {t('projects.wizardLanguage')}: {inspection.language}
          </span>
          <span>
            {t('projects.wizardBranch')}:{' '}
            {inspection.currentBranch || t('common.empty')}
          </span>
          <span>
            {t('projects.wizardRemote')}:{' '}
            {inspection.remoteHost || t('common.empty')}
          </span>
          <span>
            {t('projects.wizardLockfiles')}:{' '}
            {inspection.lockfiles.join(', ') || t('common.empty')}
          </span>
          <span>
            {t('projects.wizardGuidance')}:{' '}
            {inspection.guidanceFiles.join(', ') || t('common.empty')}
          </span>
          <span>
            {t('projects.wizardSessions')}: {inspection.claudeSessions.length}
          </span>
          {inspection.sizeTruncated && (
            <span>{t('projects.wizardSizeTruncated')}</span>
          )}
        </div>
      ) : (
        <p className="text-sm">{t('projects.wizardNewReady')}</p>
      )}
      <label className="block text-sm">
        {t('projects.branchLabel')}
        <select
          className="mt-1 w-full rounded border bg-[var(--t-surface-2)] p-2"
          value={draft.branch}
          onChange={(event) => update({ branch: event.target.value })}
        >
          {inspection?.branches.map((branch) => (
            <option key={branch} value={branch}>
              {branch}
            </option>
          ))}
          {!inspection && (
            <option value={draft.branch}>{draft.branch}</option>
          )}
        </select>
      </label>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Shared Suggestion checkbox                                         */
/* ------------------------------------------------------------------ */

function Suggestion({
  checked,
  onChange,
  label,
  reason,
}: {
  checked: boolean;
  onChange: (value: boolean) => void;
  label: string;
  reason: string;
}) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        {label}
        {reason && (
          <span className="block text-xs text-[var(--t-text-3)]">
            {reason}
          </span>
        )}
      </span>
    </label>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 3 – Suggestions                                               */
/* ------------------------------------------------------------------ */

export function StepSuggestions({
  inspection,
  draft,
  update,
  t,
}: StepProps & { inspection: ProjectInspection | null }) {
  const checks = inspection?.suggestedSettings.checks || [];

  const toggleCheck = (check: Check) =>
    update({
      checks: draft.checks.some((item) => item.name === check.name)
        ? draft.checks.filter((item) => item.name !== check.name)
        : [...draft.checks, check],
    });

  const installReason = inspection?.lockfiles.length
    ? `${t('projects.wizardReasonLockfile')}: ${inspection.lockfiles.join(', ')}`
    : inspection?.monorepo.detected
      ? `${t('projects.wizardReasonMonorepo')}: ${inspection.monorepo.type}`
      : '';

  const hooksReason =
    inspection?.gitHooks.husky || inspection?.gitHooks.commitlint
      ? t('projects.wizardReasonHooks')
      : '';

  const sensitiveReason =
    inspection?.mount.encrypted || inspection?.mount.temporary
      ? t('projects.wizardReasonMount')
      : '';

  return (
    <div className="space-y-3">
      <p className="text-sm">{t('projects.wizardSuggestionsDesc')}</p>
      <Suggestion
        checked={draft.skipInstall}
        onChange={(value) => update({ skipInstall: value })}
        label={t('projects.wizardSkipInstall')}
        reason={installReason}
      />
      <Suggestion
        checked={draft.skipHooks}
        onChange={(value) => update({ skipHooks: value })}
        label={t('projects.wizardSkipHooks')}
        reason={hooksReason}
      />
      <Suggestion
        checked={draft.integration}
        onChange={(value) => update({ integration: value })}
        label={t('projects.wizardIntegration')}
        reason={t('projects.wizardIntegrationReason')}
      />
      {sensitiveReason && (
        <Suggestion
          checked={draft.sensitive}
          onChange={(value) => update({ sensitive: value })}
          label={t('projects.wizardSensitive')}
          reason={sensitiveReason}
        />
      )}
      {checks.length > 0 && (
        <div className="space-y-2">
          <b className="text-sm">{t('projects.wizardChecks')}</b>
          {checks.map((check) => (
            <Suggestion
              key={check.name}
              checked={draft.checks.some((item) => item.name === check.name)}
              onChange={() => toggleCheck(check)}
              label={check.name}
              reason={check.reason}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 4 – Context (AGENTS.md, references, legacy sessions/memory)   */
/* ------------------------------------------------------------------ */

export function StepContext({
  inspection,
  draft,
  update,
  t,
}: StepProps & { inspection: ProjectInspection | null }) {
  const sessions: ClaudeSession[] = inspection?.claudeSessions || [];

  const toggleSession = (name: string) =>
    update({
      selectedSessions: draft.selectedSessions.includes(name)
        ? draft.selectedSessions.filter((s) => s !== name)
        : [...draft.selectedSessions, name],
    });

  const addReference = () =>
    update({
      references: [...draft.references, { name: '', path: '', inject: false }],
    });

  const updateReference = (index: number, patch: Partial<Reference>) =>
    update({
      references: draft.references.map((ref, i) =>
        i === index ? { ...ref, ...patch } : ref,
      ),
    });

  const removeReference = (index: number) =>
    update({
      references: draft.references.filter((_, i) => i !== index),
    });

  const hasGuidance = Boolean(inspection?.guidanceFiles.length);
  const hasAnythingToPin =
    draft.pinMemory || draft.selectedSessions.length > 0;

  return (
    <div className="space-y-4">
      <p className="text-sm">{t('projects.wizardContextDesc')}</p>

      {/* AGENTS.md section */}
      <div className="space-y-1">
        <p className="text-sm font-medium">{t('projects.wizardGuidance')}</p>
        {hasGuidance ? (
          <p className="text-sm text-[var(--t-text-3)]">
            {t('projects.wizardGuidanceFound')}:{' '}
            {inspection!.guidanceFiles.join(', ')}
          </p>
        ) : (
          <>
            <Suggestion
              checked={draft.agentsDraft}
              onChange={(value) => update({ agentsDraft: value })}
              label={t('projects.wizardAgentsDraft')}
              reason={t('projects.wizardAgentsDraftReason')}
            />
            {draft.agentsDraft && (
            <div className="space-y-2">
              <textarea
                aria-label={t('projects.wizardAgentsContent')}
                className="min-h-32 w-full rounded border bg-[var(--t-surface-2)] p-2 text-sm"
                value={draft.agentsContent}
                onChange={(event) => update({ agentsContent: event.target.value })}
              />
              <Suggestion
                checked={draft.agentsApproved}
                onChange={(value) => update({ agentsApproved: value })}
                label={t('projects.wizardAgentsApprove')}
                reason={t('projects.wizardAgentsApproveReason')}
              />
            </div>
            )}
          </>
        )}
      </div>

      {/* Read-only references */}
      <div className="space-y-2">
        <p className="text-sm font-medium">
          {t('projects.sectionReferencesTitle')}
        </p>
        {draft.references.map((ref, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input
              className="flex-1"
              value={ref.name}
              onChange={(event) =>
                updateReference(i, { name: event.target.value })
              }
              placeholder={t('projects.refNamePlaceholder')}
            />
            <Input
              className="flex-1"
              value={ref.path}
              onChange={(event) =>
                updateReference(i, { path: event.target.value })
              }
              placeholder={t('projects.refPathPlaceholder')}
            />
            <label className="flex items-center gap-1 text-xs">
              <input
                type="checkbox"
                checked={ref.inject}
                onChange={(event) =>
                  updateReference(i, { inject: event.target.checked })
                }
              />
              {t('projects.inject')}
            </label>
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => removeReference(i)}
            >
              ×
            </Button>
          </div>
        ))}
        <Button type="button" variant="secondary" size="sm" onClick={addReference}>
          {t('projects.addReference')}
        </Button>
      </div>

      {/* MEMORY.md preview and pin */}
      {inspection?.memoryPreview && (
        <div className="space-y-1">
          <p className="text-sm font-medium">{t('projects.wizardPinMemory')}</p>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={draft.pinMemory}
              onChange={(event) => update({ pinMemory: event.target.checked })}
            />
            <span>
              {t('projects.wizardPinMemoryLabel')}
              <pre className="mt-2 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-[var(--t-surface-2)] p-2 text-xs">
                {inspection.memoryPreview}
              </pre>
            </span>
          </label>
        </div>
      )}

      {/* Claude sessions listing and selection */}
      {sessions.length > 0 && (
        <div className="space-y-2">
          <p className="text-sm font-medium">
            {t('projects.wizardSessionsFound', { count: sessions.length })}
          </p>
          <ul className="space-y-1 text-sm">
            {sessions.map((session) => (
              <li key={session.name} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={draft.selectedSessions.includes(session.name)}
                  onChange={() => toggleSession(session.name)}
                />
                <span className="text-xs">
                  {session.name} ·{' '}
                  {new Date(session.modifiedAt).toLocaleString()} ·{' '}
                  {Math.round(session.sizeBytes / 1024)} KB
                </span>
                <details className="text-xs">
                  <summary>{t('projects.wizardViewSession')}</summary>
                  <pre className="mt-1 max-h-32 max-w-full overflow-auto whitespace-pre-wrap rounded bg-[var(--t-surface-2)] p-2">
                    {inspection?.claudeSessionPreviews.find((preview) => preview.name === session.name)?.content || t('projects.wizardNoSessionPreview')}
                  </pre>
                </details>
              </li>
            ))}
          </ul>
        </div>
      )}

      {sessions.length === 0 && !inspection?.memoryPreview && (
        <p className="text-sm text-[var(--t-text-3)]">
          {t('projects.wizardNoSessions')}
        </p>
      )}

      {/* Approval gate: context is only pinned after user approves */}
      {hasAnythingToPin && (
        <Suggestion
          checked={draft.contextApproved}
          onChange={(value) => update({ contextApproved: value })}
          label={t('projects.wizardContextApprove')}
          reason={t('projects.wizardContextReadonly')}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Step 5 – Brain & Notifications                                     */
/* ------------------------------------------------------------------ */

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
                  mode: event.target.value as ProjectSettings['brain']['mode'],
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

/* ------------------------------------------------------------------ */
/*  Step 6 – Summary                                                   */
/* ------------------------------------------------------------------ */

export function StepSummary({
  draft,
  inspection,
  t,
}: {
  draft: WizardDraft;
  inspection: ProjectInspection | null;
  t: Translate;
}) {
  return (
    <div className="space-y-2 rounded-lg border p-4 text-sm">
      <b>{t('projects.wizardSummary')}</b>
      <div>
        {t('projects.nameLabel')}: {draft.name}
      </div>
      <div>
        {t('projects.pathLabel')}: {draft.path}
      </div>
      <div>
        {t('projects.branchLabel')}: {draft.branch}
      </div>
      <div>
        {t('projects.wizardIntegration')}:{' '}
        {draft.integration ? t('common.yes') : t('common.no')}
      </div>
      <div>
        {t('projects.wizardSkipInstall')}:{' '}
        {draft.skipInstall ? t('common.yes') : t('common.no')}
      </div>
      <div>
        {t('projects.wizardSkipHooks')}:{' '}
        {draft.skipHooks ? t('common.yes') : t('common.no')}
      </div>
      {draft.sensitive && (
        <div>
          {t('projects.wizardSensitive')}: {t('common.yes')}
        </div>
      )}
      {draft.checks.length > 0 && (
        <div>
          {t('projects.wizardChecks')}: {draft.checks.map((c) => c.name).join(', ')}
        </div>
      )}
      {draft.references.length > 0 && (
        <div>
          {t('projects.sectionReferencesTitle')}:{' '}
          {draft.references.map((r) => r.name || r.path).join(', ')}
        </div>
      )}
      {draft.agentsDraft && (
        <div>
          {t('projects.wizardAgentsDraft')}: {t('common.yes')}
        </div>
      )}
      {draft.pinMemory && draft.contextApproved && (
        <div>
          {t('projects.wizardPinMemory')}: {t('common.yes')}
        </div>
      )}
      {draft.selectedSessions.length > 0 && draft.contextApproved && (
        <div>
          {t('projects.wizardSessions')}:{' '}
          {draft.selectedSessions.length} {t('projects.wizardSessionsSelected')}
        </div>
      )}
      <div>
        {t('projects.brainMode')}: {draft.settings.brain.mode}
      </div>
      <div>
        {t('projects.telegramContent')}:{' '}
        {draft.settings.notifications.telegramContent}
      </div>
      {inspection && (
        <div className="text-xs text-[var(--t-text-3)]">
          {t('projects.wizardLanguage')}: {inspection.language}
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Main Wizard component                                              */
/* ------------------------------------------------------------------ */

export function ProjectWizard({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState<WizardDraft>(() => {
    try {
      return { ...emptyDraft(), ...JSON.parse(localStorage.getItem('agenthub.projectWizard') || '{}') };
    } catch {
      return emptyDraft();
    }
  });

  const update = (patch: Partial<WizardDraft>) => {
    setError(null);
    setDraft((old) => ({ ...old, ...patch }));
  };

  const inspectMutation = useMutation({
    mutationFn: () => inspectProject(draft.path),
    onSuccess: (value) => {
      setInspection(value);
      setDraft((old) => ({
        ...old,
        branch:
          value.currentBranch || value.branches[0] || old.branch,
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
      // Apply sensitive project defaults
      const brainSettings = draft.sensitive
        ? { ...draft.settings.brain, permissions: 'standard' as const }
        : draft.settings.brain;

      const notificationSettings = draft.sensitive
        ? { ...draft.settings.notifications, telegramContent: 'minimal' as const }
        : draft.settings.notifications;

      const settings: ProjectSettings = {
        ...draft.settings,
        brain: brainSettings,
        worktree: {
          ...draft.settings.worktree,
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
        references: draft.references.filter((r) => r.name && r.path),
        notifications: notificationSettings,
      };

      return draft.mode === 'new'
        ? createNewProject({
            name: draft.name,
            path: draft.path,
            defaultBranch: draft.branch,
            checks: draft.checks,
            settings,
          })
        : createProject({
            name: draft.name,
            path: draft.path,
            defaultBranch: draft.branch,
            checks: draft.checks,
            settings,
          });
    },
    onSuccess: async (project) => {
      // Only pin memory/sessions when user approved
      if (draft.contextApproved) {
        if (draft.pinMemory && inspection?.memoryPreview) {
          await addProjectKnowledge(project.id, {
            content: inspection.memoryPreview,
            pinned: true,
          });
        }
        // Pin selected session names as knowledge for brain to summarize
        if (draft.selectedSessions.length > 0) {
          await createTask({
            project: project.id,
            slug: 'summarize-previous-context',
            title: 'Review and summarize previous Claude Code context',
            body: `Read the selected previous session files and summarize durable project knowledge.\n\nSelected sessions:\n${draft.selectedSessions.join('\n')}\n\nPresent the proposed knowledge for user approval before pinning it.`,
            level: 'easy',
            start: true,
          });
        }
      }
      if (draft.agentsDraft && draft.agentsApproved && draft.agentsContent.trim()) {
        await writeProjectGuidance(project.id, draft.agentsContent.trim());
      }
      localStorage.removeItem('agenthub.projectWizard');
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      onClose();
    },
    onError: (cause: Error) => setError(cause.message),
  });

  useEffect(() => {
    localStorage.setItem('agenthub.projectWizard', JSON.stringify(draft));
  }, [draft]);

  const canNext = useMemo(
    () =>
      step === 0 ||
      (step === 1 && Boolean(draft.name.trim() && draft.path.trim())) ||
      step !== 1,
    [step, draft.name, draft.path],
  );

  const next = () => {
    setError(null);
    if (step === 1 && draft.mode !== 'new') {
      inspectMutation.mutate();
      return;
    }
    if (step === 1) setInspection(null);
    setStep(Math.min(6, step + 1));
  };

  return (
    <Card
      data-testid="project-wizard"
      data-tour="modal-project-wizard"
      className="space-y-5 p-6"
    >
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-base font-bold">{t('projects.wizardTitle')}</h2>
          <p className="text-sm text-[var(--t-text-3)]">
            {t(`projects.wizardWhy${step}`)}
          </p>
        </div>
        <Button type="button" variant="secondary" size="sm" onClick={onClose}>
          {t('common.close')}
        </Button>
      </div>

      {/* Progress bar */}
      <div className="flex gap-1" aria-label={t('projects.wizardProgress')}>
        {[0, 1, 2, 3, 4, 5, 6].map((item) => (
          <div
            key={item}
            className={`h-1 flex-1 rounded ${
              item <= step
                ? 'bg-[var(--t-accent)]'
                : 'bg-[var(--t-border)]'
            }`}
          />
        ))}
      </div>

      {/* Error */}
      {error && (
        <div role="alert" className="rounded-lg p-3 text-sm text-[var(--t-crit)]">
          {error}
        </div>
      )}

      {/* Steps */}
      {step === 0 && <StepMode draft={draft} update={update} t={t} />}
      {step === 1 && <StepPath draft={draft} update={update} t={t} />}
      {step === 2 && (
        <StepInspect
          inspection={inspection}
          draft={draft}
          update={update}
          t={t}
        />
      )}
      {step === 3 && (
        <StepSuggestions
          inspection={inspection}
          draft={draft}
          update={update}
          t={t}
        />
      )}
      {step === 4 && (
        <StepContext
          inspection={inspection}
          draft={draft}
          update={update}
          t={t}
        />
      )}
      {step === 5 && <StepBrain draft={draft} update={update} t={t} />}
      {step === 6 && (
        <StepSummary draft={draft} inspection={inspection} t={t} />
      )}

      {/* Navigation */}
      <div className="flex justify-between">
        <Button
          type="button"
          variant="secondary"
          size="sm"
          disabled={step === 0}
          onClick={() => setStep(Math.max(0, step - 1))}
        >
          {t('projects.wizardBack')}
        </Button>
        {step < 6 ? (
          <Button
            type="button"
            size="sm"
            onClick={next}
            disabled={!canNext || inspectMutation.isPending}
            loading={inspectMutation.isPending}
          >
            {t('projects.wizardNext')}
          </Button>
        ) : (
          <Button
            type="button"
            size="sm"
            onClick={() => createMutation.mutate()}
            loading={createMutation.isPending}
          >
            {t('projects.wizardCreate')}
          </Button>
        )}
      </div>
    </Card>
  );
}
