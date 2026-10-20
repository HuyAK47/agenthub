import React, { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { addProjectKnowledge, createProject, deleteProject, deleteProjectKnowledge, getProjectKnowledge, getProjects, updateProject, updateProjectKnowledge } from '../api/client';
import { FolderGit2, Plus, Trash2, CheckCircle2, AlertCircle, Code, BookOpen, Pin } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { Project } from '../types/api';

function getProjectHooksString(proj: Project): string {
  if (!proj.hooks) return '';
  if (typeof proj.hooks === 'string') {
    try {
      const parsed = JSON.parse(proj.hooks);
      return Array.isArray(parsed?.onWorktreeRemoved) ? parsed.onWorktreeRemoved.join('\n') : '';
    } catch {
      return '';
    }
  }
  return Array.isArray(proj.hooks.onWorktreeRemoved) ? proj.hooks.onWorktreeRemoved.join('\n') : '';
}

export const ProjectsPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();

  const [showAddForm, setShowAddForm] = useState(false);
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [defaultBranch, setDefaultBranch] = useState('main');
  const [maxParallel, setMaxParallel] = useState(3);
  const [envTemplate, setEnvTemplate] = useState('');
  const [checksJson, setChecksJson] = useState('');
  const [hooksText, setHooksText] = useState('');
  const [projectChecks, setProjectChecks] = useState<Record<string, string>>({});
  const [projectHooks, setProjectHooks] = useState<Record<string, string>>({});
  const [projectReview, setProjectReview] = useState<Record<string, string>>({});
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [knowledgeProject, setKnowledgeProject] = useState<string | null>(null);
  const [knowledgeDraft, setKnowledgeDraft] = useState('');

  const { data: projects = [], isLoading, error } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
  });

  const createMutation = useMutation({
    mutationFn: createProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
      setShowAddForm(false);
      resetForm();
    },
    onError: (err: any) => {
      setFormError(err.message || t('projects.createError'));
    },
  });

  const deleteMutation = useMutation({
    mutationFn: deleteProject,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['projects'] });
    },
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, checks }: { id: string; checks: string }) => updateProject(id, { checks: checks.trim() ? JSON.parse(checks) : null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const updateHooksMutation = useMutation({
    mutationFn: ({ id, hooks }: { id: string; hooks: string }) => {
      const lines = hooks.split('\n').map((l) => l.trim()).filter(Boolean);
      return updateProject(id, { hooks: lines.length > 0 ? { onWorktreeRemoved: lines } : null });
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const updateReviewMutation = useMutation({
    mutationFn: ({ id, review }: { id: string; review: string }) => updateProject(id, { review: review.trim() ? JSON.parse(review) : null }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['projects'] }),
  });

  const knowledgeQuery = useQuery({
    queryKey: ['project-knowledge', knowledgeProject],
    queryFn: () => getProjectKnowledge(knowledgeProject!),
    enabled: knowledgeProject !== null,
  });
  const addKnowledgeMutation = useMutation({
    mutationFn: () => addProjectKnowledge(knowledgeProject!, { content: knowledgeDraft.trim() }),
    onSuccess: () => { setKnowledgeDraft(''); queryClient.invalidateQueries({ queryKey: ['project-knowledge', knowledgeProject] }); },
  });
  const updateKnowledgeMutation = useMutation({
    mutationFn: ({ id, content, pinned }: { id: number; content?: string; pinned?: boolean }) => updateProjectKnowledge(knowledgeProject!, id, { content, pinned }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-knowledge', knowledgeProject] }),
  });
  const deleteKnowledgeMutation = useMutation({
    mutationFn: (id: number) => deleteProjectKnowledge(knowledgeProject!, id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['project-knowledge', knowledgeProject] }),
  });

  const resetForm = () => {
    setName('');
    setPath('');
    setDefaultBranch('main');
    setMaxParallel(3);
    setEnvTemplate('');
    setChecksJson('');
    setHooksText('');
    setJsonError(null);
    setFormError(null);
  };

  const handleEnvTemplateChange = (val: string) => {
    setEnvTemplate(val);
    if (!val.trim()) {
      setJsonError(null);
      return;
    }
    try {
      JSON.parse(val);
      setJsonError(null);
    } catch (err: any) {
      setJsonError(t('projects.invalidJson', { error: err.message }));
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setFormError(null);

    if (!name.trim()) {
      setFormError(t('projects.nameRequired'));
      return;
    }
    if (!path.trim()) {
      setFormError(t('projects.pathRequired'));
      return;
    }

    if (envTemplate.trim()) {
      try {
        JSON.parse(envTemplate);
      } catch (err: any) {
        setJsonError(t('projects.invalidJson', { error: err.message }));
        return;
      }
    }
    let checks: unknown = null;
    if (checksJson.trim()) {
      try {
        checks = JSON.parse(checksJson);
        if (!Array.isArray(checks)) throw new Error('checks must be an array');
      } catch (err: any) {
        setFormError(t('projects.invalidChecks', { error: err.message }));
        return;
      }
    }

    const hookLines = hooksText.split('\n').map((l) => l.trim()).filter(Boolean);
    createMutation.mutate({
      name: name.trim(),
      path: path.trim(),
      defaultBranch: defaultBranch.trim() || 'main',
      maxParallel: Number(maxParallel) || 3,
      envTemplate: envTemplate.trim() ? envTemplate.trim() : null,
      checks: checks as any,
      ...(hookLines.length > 0 ? { hooks: { onWorktreeRemoved: hookLines } } : {}),
    });
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">{t('projects.title')}</h1>
          <p className="text-sm text-[var(--t-text-3)]">
            {t('projects.subtitle')}
          </p>
        </div>

        <button
          type="button"
          onClick={() => {
            resetForm();
            setShowAddForm(!showAddForm);
          }}
          className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold shadow-xs cursor-pointer"
        >
          <Plus className="w-4 h-4" />
          <span>{showAddForm ? t('projects.closeFormBtn') : t('projects.registerBtn')}</span>
        </button>
      </div>

      {/* Registration Form */}
      {showAddForm && (
        <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 shadow-xs space-y-4">
          <h2 className="text-base font-bold">{t('projects.formTitle')}</h2>

          {formError && (
            <div className="p-3 rounded-lg bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] text-xs">
              {formError}
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.nameLabel')}
                </label>
                <input
                  type="text"
                  placeholder={t('projects.namePlaceholder')}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.pathLabel')}
                </label>
                <input
                  type="text"
                  placeholder={t('projects.pathPlaceholder')}
                  value={path}
                  onChange={(e) => setPath(e.target.value)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.branchLabel')}
                </label>
                <input
                  type="text"
                  placeholder="main"
                  value={defaultBranch}
                  onChange={(e) => setDefaultBranch(e.target.value)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('projects.maxParallelLabel')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={maxParallel}
                  onChange={(e) => setMaxParallel(parseInt(e.target.value, 10) || 1)}
                  className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>
            </div>

            {/* envTemplate JSON with Validation */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)]">
                  {t('projects.envLabel')}
                </label>
                {envTemplate.trim() && !jsonError && (
                  <span className="text-xs text-[var(--t-ok)] font-medium flex items-center gap-1">
                    <CheckCircle2 className="w-3.5 h-3.5" /> {t('projects.validJson')}
                  </span>
                )}
              </div>
              <textarea
                data-testid="env-template-textarea"
                rows={4}
                placeholder={'{\n  "PORT": 3000,\n  "DATABASE_URL": "postgres://..."\n}'}
                value={envTemplate}
                onChange={(e) => handleEnvTemplateChange(e.target.value)}
                className={`w-full text-xs font-mono rounded-lg border p-2.5 bg-[var(--t-surface-2)] text-[var(--t-text)] focus:outline-none focus:ring-2 ${
                  jsonError
                    ? 'border-[var(--t-crit)] focus:ring-[var(--t-crit)]'
                    : 'border-[var(--t-border)] focus:ring-[var(--t-accent)]'
                }`}
              />
              {jsonError && (
                <p data-testid="json-error-msg" className="text-xs text-[var(--t-crit)] mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3.5 h-3.5" />
                  {jsonError}
                </p>
              )}
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">{t('extra.hooks')}</label>
              <textarea rows={3} value={hooksText} onChange={(e) => setHooksText(e.target.value)} placeholder={'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"'} className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)]" />
            </div>

            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">{t('extra.checks')}</label>
              <textarea rows={3} value={checksJson} onChange={(e) => setChecksJson(e.target.value)} placeholder={'[{"name":"lint","cmd":["npm","run","lint"]}]'} className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] p-2.5 bg-[var(--t-surface-2)]" />
            </div>

            <div className="flex justify-end gap-3 pt-2">
              <button
                type="button"
                onClick={() => setShowAddForm(false)}
                className="px-4 py-2 rounded-lg text-xs font-medium border border-[var(--t-border)] hover:bg-[var(--t-surface-2)] cursor-pointer"
              >
                {t('common.cancel')}
              </button>
              <button
                type="submit"
                disabled={!!jsonError || createMutation.isPending}
                className="px-4 py-2 rounded-lg text-xs font-semibold bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {createMutation.isPending ? t('projects.savingBtn') : t('projects.saveBtn')}
              </button>
            </div>
          </form>
        </div>
      )}

      {/* Projects List */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {isLoading ? (
          <div className="col-span-2 flex items-center justify-center p-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
          </div>
        ) : error ? (
          <div className="col-span-2 p-8 text-center text-[var(--t-crit)] text-sm">
            {t('projects.loadError')}
          </div>
        ) : projects.length === 0 ? (
          <div className="col-span-2 p-8 text-center text-[var(--t-text-3)] text-sm">
            {t('projects.empty')}
          </div>
        ) : (
          projects.map((proj) => (
            <div
              key={proj.id}
              className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-5 shadow-xs space-y-3"
            >
              <div className="flex items-start justify-between">
                <div>
                  <h3 className="text-base font-bold text-[var(--t-text)] flex items-center gap-2">
                    <FolderGit2 className="w-4 h-4 text-[var(--t-accent)]" />
                    <span>{proj.name}</span>
                    <span className="text-xs font-mono font-normal text-[var(--t-text-3)]">({proj.id})</span>
                  </h3>
                  <p className="text-xs font-mono text-[var(--t-text-3)] mt-1 break-all">{proj.path}</p>
                </div>

                <button
                  type="button"
                  title={t('extra.deleteProject')}
                  onClick={() => {
                    if (confirm(t('projects.confirmDelete', { name: proj.name }))) {
                      deleteMutation.mutate(proj.id);
                    }
                  }}
                  className="p-1.5 rounded-lg text-[var(--t-text-3)] hover:text-[var(--t-crit)] hover:bg-[var(--t-surface-2)] cursor-pointer"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>

              <div className="grid grid-cols-2 gap-2 pt-2 border-t border-[var(--t-border)] text-xs">
                <div>
                  <span className="text-[var(--t-text-3)]">{t('projects.defaultBranchText')}</span>
                  <span className="font-mono font-medium">{proj.defaultBranch}</span>
                </div>
                <div>
                  <span className="text-[var(--t-text-3)]">{t('projects.maxParallelText')}</span>
                  <span className="font-mono font-medium">{proj.maxParallel}</span>
                </div>
              </div>

              <button type="button" onClick={() => setKnowledgeProject(knowledgeProject === proj.id ? null : proj.id)} className="inline-flex items-center gap-1 text-xs text-[var(--t-accent)]">
                <BookOpen className="w-3.5 h-3.5" /> Kiến thức
              </button>

              {knowledgeProject === proj.id && (
                <div className="pt-2 border-t border-[var(--t-border)] space-y-2">
                  <div className="flex gap-2">
                    <input value={knowledgeDraft} onChange={(e) => setKnowledgeDraft(e.target.value)} placeholder="Thêm ghi chú kiến thức..." className="min-w-0 flex-1 text-xs rounded border border-[var(--t-border)] p-2 bg-[var(--t-surface-2)]" />
                    <button type="button" disabled={!knowledgeDraft.trim() || addKnowledgeMutation.isPending} onClick={() => addKnowledgeMutation.mutate()} className="px-2 rounded bg-[var(--t-accent)] text-white text-xs">Thêm</button>
                  </div>
                  {(knowledgeQuery.data || []).map((entry) => (
                    <div key={entry.id} className="flex items-start gap-2 text-xs">
                      <button type="button" title="Ghim/bỏ ghim" onClick={() => updateKnowledgeMutation.mutate({ id: entry.id, pinned: !entry.pinned })} className={entry.pinned ? 'text-[var(--t-accent)]' : 'text-[var(--t-text-3)]'}>
                        <Pin className="w-3.5 h-3.5 mt-0.5" />
                      </button>
                      <textarea defaultValue={entry.content} onBlur={(e) => { if (e.target.value !== entry.content) updateKnowledgeMutation.mutate({ id: entry.id, content: e.target.value }); }} rows={2} className="min-w-0 flex-1 rounded border border-[var(--t-border)] p-1.5 bg-[var(--t-surface-2)]" />
                      <button type="button" onClick={() => deleteKnowledgeMutation.mutate(entry.id)} className="text-[var(--t-crit)]">×</button>
                    </div>
                  ))}
                </div>
              )}

              {proj.envTemplate && (
                <div className="pt-2">
                  <div className="flex items-center gap-1 text-[11px] font-semibold text-[var(--t-text-3)] mb-1">
                    <Code className="w-3.5 h-3.5" />
                    <span>envTemplate:</span>
                  </div>
                  <pre className="text-[11px] font-mono p-2 rounded bg-[var(--t-surface-2)] overflow-x-auto text-[var(--t-text)]">
                    {proj.envTemplate}
                  </pre>
                </div>
              )}

              <div className="pt-2 border-t border-[var(--t-border)]">
                <label className="block text-[11px] font-semibold text-[var(--t-text-3)] mb-1">{t('extra.hooks')}</label>
                <textarea
                  rows={2}
                  value={projectHooks[proj.id] ?? getProjectHooksString(proj)}
                  onChange={(e) => setProjectHooks((current) => ({ ...current, [proj.id]: e.target.value }))}
                  placeholder={'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"'}
                  className="w-full text-[11px] font-mono rounded border border-[var(--t-border)] p-2 bg-[var(--t-surface-2)]"
                />
                <button
                  type="button"
                  onClick={() => updateHooksMutation.mutate({ id: proj.id, hooks: projectHooks[proj.id] ?? getProjectHooksString(proj) })}
                  disabled={updateHooksMutation.isPending}
                  className="mt-1 px-2 py-1 rounded bg-[var(--t-surface-2)] text-[11px]"
                >
                  {t('extra.saveHooks')}
                </button>
              </div>

              <div className="pt-2 border-t border-[var(--t-border)]">
                <label className="block text-[11px] font-semibold text-[var(--t-text-3)] mb-1">{t('extra.checks')}</label>
                <textarea rows={2} value={projectChecks[proj.id] ?? (typeof proj.checks === 'string' ? proj.checks : proj.checks ? JSON.stringify(proj.checks) : '')} onChange={(e) => setProjectChecks((current) => ({ ...current, [proj.id]: e.target.value }))} className="w-full text-[11px] font-mono rounded border border-[var(--t-border)] p-2 bg-[var(--t-surface-2)]" />
                <button type="button" onClick={() => updateMutation.mutate({ id: proj.id, checks: projectChecks[proj.id] ?? '' })} disabled={updateMutation.isPending} className="mt-1 px-2 py-1 rounded bg-[var(--t-surface-2)] text-[11px]">{t('extra.saveChecks')}</button>
              </div>

              <div className="pt-2 border-t border-[var(--t-border)]">
                <label className="block text-[11px] font-semibold text-[var(--t-text-3)] mb-1">{t('extra.reviewChainLabel')}</label>
                <textarea
                  rows={3}
                  value={projectReview[proj.id] ?? (typeof proj.review === 'string' ? proj.review : proj.review ? JSON.stringify(proj.review, null, 2) : '')}
                  onChange={(e) => setProjectReview((current) => ({ ...current, [proj.id]: e.target.value }))}
                  placeholder={'{"chain":[{"reviewer":"codex:gpt-5.6-luna","mode":"gate"},{"reviewer":"claude","mode":"final"}],"maxRounds":2}' }
                  className="w-full text-[11px] font-mono rounded border border-[var(--t-border)] p-2 bg-[var(--t-surface-2)]"
                />
                <button type="button" onClick={() => updateReviewMutation.mutate({ id: proj.id, review: projectReview[proj.id] ?? '' })} disabled={updateReviewMutation.isPending} className="mt-1 px-2 py-1 rounded bg-[var(--t-surface-2)] text-[11px]">{t('extra.saveReviewChain')}</button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
};
