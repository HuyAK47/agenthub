import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { createNewProject, createProject, inspectProject } from '../api/client';
import { ProjectInspection, ProjectSettings } from '../types/api';
import { useLocale } from '../context/LocaleContext';
import { Button, Card, Input } from './ui';

type WizardMode = 'existing' | 'new';
type Draft = { mode: WizardMode; name: string; path: string; branch: string; settings: ProjectSettings; skipInstall: boolean; skipHooks: boolean; integration: boolean };

const defaultSettings = (): ProjectSettings => ({
  brain: { mode: 'inherit', permissions: 'standard' }, worktree: { install: 'auto', gitHooks: 'run' },
  integration: { enabled: false }, ci: {}, references: [], reviewChecklist: [], notifications: { telegramContent: 'full' },
});

export function ProjectWizard({ onClose }: { onClose: () => void }) {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const [step, setStep] = useState(0);
  const [draft, setDraft] = useState<Draft>(() => {
    try { return { mode: 'existing', name: '', path: '', branch: 'main', settings: defaultSettings(), skipInstall: false, skipHooks: false, integration: false, ...JSON.parse(localStorage.getItem('agenthub.projectWizard') || '{}') }; } catch { return { mode: 'existing', name: '', path: '', branch: 'main', settings: defaultSettings(), skipInstall: false, skipHooks: false, integration: false }; }
  });
  const [inspection, setInspection] = useState<ProjectInspection | null>(null);
  const [error, setError] = useState<string | null>(null);
  const inspectMutation = useMutation({ mutationFn: () => inspectProject(draft.path), onSuccess: (value) => { setInspection(value); setDraft((old) => ({ ...old, branch: value.currentBranch || value.branches[0] || old.branch, skipInstall: value.suggestedSettings.skipInstall, skipHooks: value.suggestedSettings.skipGitHooks, integration: value.isGitRepo })); setStep(2); }, onError: (e: any) => setError(e.message) });
  const createMutation = useMutation({ mutationFn: () => draft.mode === 'new' ? createNewProject({ name: draft.name, path: draft.path, defaultBranch: draft.branch, settings: { ...draft.settings, worktree: { ...draft.settings.worktree, install: draft.skipInstall ? 'skip' : 'auto', gitHooks: draft.skipHooks ? 'skip' : 'run' }, integration: { ...draft.settings.integration, enabled: draft.integration } } }) : createProject({ name: draft.name, path: draft.path, defaultBranch: draft.branch, settings: { ...draft.settings, worktree: { ...draft.settings.worktree, install: draft.skipInstall ? 'skip' : 'auto', gitHooks: draft.skipHooks ? 'skip' : 'run' }, integration: { ...draft.settings.integration, enabled: draft.integration } } }), onSuccess: () => { localStorage.removeItem('agenthub.projectWizard'); queryClient.invalidateQueries({ queryKey: ['projects'] }); onClose(); }, onError: (e: any) => setError(e.message) });
  useEffect(() => { localStorage.setItem('agenthub.projectWizard', JSON.stringify(draft)); }, [draft]);
  const update = (patch: Partial<Draft>) => { setError(null); setDraft((old) => ({ ...old, ...patch })); };
  const canNext = useMemo(() => step === 0 || (step === 1 && draft.name.trim() && draft.path.trim()) || (step !== 1), [step, draft.name, draft.path]);
  const next = () => {
    setError(null);
    if (step === 1) {
      if (draft.mode === 'new') { setInspection(null); setStep(2); return; }
      inspectMutation.mutate(); return;
    }
    setStep(Math.min(6, step + 1));
  };
  return <Card data-testid="project-wizard" data-tour="modal-project-wizard" className="p-6 space-y-5">
    <div className="flex items-start justify-between gap-4"><div><h2 className="text-base font-bold">{t('projects.wizardTitle')}</h2><p className="text-sm text-[var(--t-text-3)]">{t(`projects.wizardWhy${step}` as any)}</p></div><Button variant="secondary" size="sm" onClick={onClose}>{t('common.close')}</Button></div>
    <div className="flex gap-1" aria-label={t('projects.wizardProgress')}>{[0,1,2,3,4,5,6].map((item) => <div key={item} className={`h-1 flex-1 rounded ${item <= step ? 'bg-[var(--t-accent)]' : 'bg-[var(--t-border)]'}`} />)}</div>
    {error && <div role="alert" className="rounded-lg p-3 text-sm text-[var(--t-crit)] bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)]">{error}</div>}
    {step === 0 && <div className="grid md:grid-cols-2 gap-3"><button className={`p-4 rounded-lg border text-left ${draft.mode === 'existing' ? 'border-[var(--t-accent)]' : 'border-[var(--t-border)]'}`} onClick={() => update({ mode: 'existing' })}><b>{t('projects.wizardExisting')}</b><p className="text-xs mt-1 text-[var(--t-text-3)]">{t('projects.wizardExistingDesc')}</p></button><button className={`p-4 rounded-lg border text-left ${draft.mode === 'new' ? 'border-[var(--t-accent)]' : 'border-[var(--t-border)]'}`} onClick={() => update({ mode: 'new' })}><b>{t('projects.wizardNew')}</b><p className="text-xs mt-1 text-[var(--t-text-3)]">{t('projects.wizardNewDesc')}</p></button></div>}
    {step === 1 && <div className="grid md:grid-cols-2 gap-4"><label className="text-sm">{t('projects.nameLabel')}<Input className="mt-1" value={draft.name} onChange={(e) => update({ name: e.target.value })} placeholder={t('projects.namePlaceholder')} /></label><label className="text-sm">{t('projects.pathLabel')}<Input className="mt-1" value={draft.path} onChange={(e) => update({ path: e.target.value })} placeholder={t('projects.pathPlaceholder')} /></label></div>}
    {step === 2 && <div className="space-y-3">{inspection ? <div className="grid sm:grid-cols-2 gap-2 text-sm"><span>{t('projects.wizardRepo')}: {inspection.isGitRepo ? 'Git' : t('projects.wizardNotGit')}</span><span>{t('projects.wizardLanguage')}: {inspection.language}</span><span>{t('projects.wizardBranch')}: {inspection.currentBranch || t('common.empty')}</span><span>{t('projects.wizardRemote')}: {inspection.remoteHost || t('common.empty')}</span><span>{t('projects.wizardLockfiles')}: {inspection.lockfiles.join(', ') || t('common.empty')}</span><span>{t('projects.wizardGuidance')}: {inspection.guidanceFiles.join(', ') || t('common.empty')}</span></div> : <p className="text-sm">{t('projects.wizardNewReady')}</p>}<label className="text-sm block">{t('projects.branchLabel')}<select className="mt-1 w-full rounded border p-2 bg-[var(--t-surface-2)]" value={draft.branch} onChange={(e) => update({ branch: e.target.value })}>{inspection?.branches.map((branch) => <option key={branch} value={branch}>{branch}</option>)}{!inspection && <option value={draft.branch}>{draft.branch}</option>}</select></label></div>}
    {step === 3 && <div className="space-y-3"><p className="text-sm">{t('projects.wizardSuggestionsDesc')}</p><label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.skipInstall} onChange={(e) => update({ skipInstall: e.target.checked })} />{t('projects.wizardSkipInstall')}</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.skipHooks} onChange={(e) => update({ skipHooks: e.target.checked })} />{t('projects.wizardSkipHooks')}</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.integration} onChange={(e) => update({ integration: e.target.checked })} />{t('projects.wizardIntegration')}</label>{inspection?.suggestedSettings.checks.length ? <pre className="text-xs p-3 rounded bg-[var(--t-surface-2)] overflow-auto">{JSON.stringify(inspection.suggestedSettings.checks, null, 2)}</pre> : null}</div>}
    {step === 4 && <div className="space-y-3"><p className="text-sm">{t('projects.wizardContextDesc')}</p><p className="text-sm">{inspection?.guidanceFiles.length ? t('projects.wizardGuidanceFound') : t('projects.wizardGuidanceDraft')}</p><p className="text-sm">{inspection?.claudeSessions.count ? t('projects.wizardSessionsFound', { count: inspection.claudeSessions.count }) : t('projects.wizardNoSessions')}</p><p className="text-xs text-[var(--t-text-3)]">{t('projects.wizardContextReadonly')}</p></div>}
    {step === 5 && <div className="grid md:grid-cols-2 gap-4"><label className="text-sm">{t('projects.brainMode')}<select className="mt-1 w-full rounded border p-2 bg-[var(--t-surface-2)]" value={draft.settings.brain.mode} onChange={(e) => update({ settings: { ...draft.settings, brain: { ...draft.settings.brain, mode: e.target.value as any } } })}><option value="inherit">{t('projects.brainInherit')}</option><option value="suggest">{t('projects.brainSuggest')}</option><option value="auto">{t('projects.brainAuto')}</option><option value="external">{t('projects.brainExternal')}</option></select></label><label className="text-sm">{t('projects.telegramContent')}<select className="mt-1 w-full rounded border p-2 bg-[var(--t-surface-2)]" value={draft.settings.notifications.telegramContent} onChange={(e) => update({ settings: { ...draft.settings, notifications: { telegramContent: e.target.value as any } } })}><option value="full">{t('projects.telegramFull')}</option><option value="minimal">{t('projects.telegramMinimal')}</option></select></label></div>}
    {step === 6 && <div className="rounded-lg border p-4 space-y-2 text-sm"><b>{t('projects.wizardSummary')}</b><div>{t('projects.nameLabel')}: {draft.name}</div><div>{t('projects.pathLabel')}: {draft.path}</div><div>{t('projects.branchLabel')}: {draft.branch}</div><div>{t('projects.wizardIntegration')}: {draft.integration ? t('common.yes') : t('common.no')}</div></div>}
    <div className="flex justify-between"><Button variant="secondary" size="sm" disabled={step === 0} onClick={() => setStep(Math.max(0, step - 1))}>{t('projects.wizardBack')}</Button>{step < 6 ? <Button size="sm" onClick={next} disabled={!canNext || inspectMutation.isPending} loading={inspectMutation.isPending}>{t('projects.wizardNext')}</Button> : <Button size="sm" onClick={() => createMutation.mutate()} loading={createMutation.isPending}>{t('projects.wizardCreate')}</Button>}</div>
  </Card>;
}
