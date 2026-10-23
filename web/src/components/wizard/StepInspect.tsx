import type { StepWithInspectionProps } from './types';

export function StepInspect({
  inspection,
  draft,
  update,
  t,
}: StepWithInspectionProps) {
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
