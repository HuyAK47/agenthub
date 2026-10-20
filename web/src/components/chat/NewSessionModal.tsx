import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { getProjects, getConfig, getProfiles } from '../../api/client';
import { ChatMode, Profile } from '../../types/api';
import { X, ShieldCheck, AlertTriangle, Sparkles } from 'lucide-react';
import { useLocale } from '../../context/LocaleContext';
import { useFocusTrap } from '../ui/useFocusTrap';

interface NewSessionModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSubmit: (data: { projectId?: string | null; title?: string; mode: ChatMode; model?: string; profileName?: string | null }) => void;
  isSubmitting?: boolean;
}

export const NewSessionModal: React.FC<NewSessionModalProps> = ({
  isOpen,
  onClose,
  onSubmit,
  isSubmitting = false,
}) => {
  const { t } = useLocale();
  const containerRef = useFocusTrap<HTMLDivElement>({ isOpen, onClose });
  const [projectId, setProjectId] = useState<string>('');
  const [title, setTitle] = useState<string>('');
  const [mode, setMode] = useState<ChatMode>('safe');
  const [model, setModel] = useState<string>('');
  const [profileName, setProfileName] = useState<string>('');

  const { data: projects = [] } = useQuery({
    queryKey: ['projects'],
    queryFn: getProjects,
    enabled: isOpen,
  });

  const { data: config } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
    enabled: isOpen,
  });

  const allowFullMode = Boolean(config?.chat?.allowFullMode);
  const { data: profiles = [] } = useQuery({ queryKey: ['profiles'], queryFn: getProfiles, enabled: isOpen });
  const claudeProfiles = profiles.filter((profile: Profile) => profile.engine === 'claude');

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSubmit({
      projectId: projectId || null,
      title: title.trim() || undefined,
      mode,
      model: model || undefined,
      profileName: profileName || config?.chat?.claudeProfile || undefined,
    });
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="new-session-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-xs"
    >
      <div
        ref={containerRef}
        tabIndex={-1}
        className="bg-[var(--bg-surface)] border border-[var(--border-default)] rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden text-[var(--text-primary)] outline-hidden"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border-default)]">
          <div className="flex items-center gap-2">
            <div className="p-1.5 rounded-lg bg-[var(--t-accent)]/10 text-[var(--t-accent)]">
              <Sparkles className="w-5 h-5" />
            </div>
            <h2 id="new-session-modal-title" className="text-base font-semibold">
              {t('extra.newChat')}
            </h2>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label={t('common.close')}
            className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-surface-hover)] cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6 space-y-5">
          {/* Project selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
              {t('extra.projectOptional')}
            </label>
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="w-full text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-2 text-[var(--text-primary)] focus:outline-hidden focus:ring-2 focus:ring-[var(--t-accent)]/30 focus:border-[var(--t-accent)]"
            >
              <option value="">-- {t('extra.noProject')} --</option>
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.id})
                </option>
              ))}
            </select>
          </div>

          {/* Title */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">
              {t('extra.chatTitle')}
            </label>
            <input
              type="text"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t('extra.chatTitlePlaceholder')}
              className="w-full text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-2 text-[var(--text-primary)] focus:outline-hidden focus:ring-2 focus:ring-[var(--t-accent)]/30 focus:border-[var(--t-accent)]"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">Claude profile</label>
            <select value={profileName} onChange={(e) => setProfileName(e.target.value)} className="w-full text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-2 text-[var(--text-primary)]">
              {claudeProfiles.map((profile) => <option key={profile.name} value={profile.name}>{profile.name}{profile.email ? ` · ${profile.email}` : ''}</option>)}
            </select>
          </div>

          {/* Mode Selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-1.5">{t('extra.claudeModel')}</label>
            <select value={model} onChange={(e) => setModel(e.target.value)} className="w-full text-sm rounded-lg border border-[var(--border-default)] bg-[var(--bg-surface-subtle)] px-3 py-2 text-[var(--text-primary)]">
              <option value="">{t('extra.claudeDefault')}</option>
              {(config?.chat?.models || ['opus', 'sonnet', 'haiku']).map((item) => <option key={item} value={item}>{item}</option>)}
            </select>
          </div>

          {/* Mode Selector */}
          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-secondary)] mb-2">
              {t('extra.operationMode')}
            </label>
            <div className="space-y-3">
              {/* Safe Mode */}
              <label
                className={`flex items-start gap-3 p-3.5 rounded-xl border cursor-pointer transition-colors ${
                  mode === 'safe'
                    ? 'border-[var(--t-accent)]/70 bg-[var(--t-selected)]'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-surface-hover)]'
                }`}
              >
                <input
                  type="radio"
                  name="chat-mode"
                  value="safe"
                  checked={mode === 'safe'}
                  onChange={() => setMode('safe')}
                  className="mt-1 accent-[var(--t-accent)]"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-1.5 font-medium text-sm">
                    <ShieldCheck className="w-4 h-4 text-[var(--t-ok)]" />
                    <span>{t('extra.safeMode')}</span>
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-[var(--t-ok)]/10 text-[var(--t-ok)] font-normal">
                      {t('extra.default')}
                    </span>
                  </div>
                  <p className="text-xs text-[var(--text-secondary)] mt-1">
                    {t('extra.safeModeDesc')}
                  </p>
                </div>
              </label>

              {/* Full Mode */}
              <label
                className={`flex items-start gap-3 p-3.5 rounded-xl border transition-colors ${
                  !allowFullMode
                    ? 'opacity-50 cursor-not-allowed border-[var(--border-default)] bg-[var(--bg-surface-subtle)]'
                    : mode === 'full'
                    ? 'border-[var(--t-crit)]/70 bg-[var(--t-crit)]/5 cursor-pointer'
                    : 'border-[var(--border-default)] bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-surface-hover)] cursor-pointer'
                }`}
              >
                <input
                  type="radio"
                  name="chat-mode"
                  value="full"
                  disabled={!allowFullMode}
                  checked={mode === 'full'}
                  onChange={() => allowFullMode && setMode('full')}
                  className="mt-1 accent-[var(--t-crit)]"
                />
                <div className="flex-1">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-1.5 font-medium text-sm text-[var(--t-crit)]">
                      <AlertTriangle className="w-4 h-4 text-[var(--t-crit)]" />
                      <span>{t('extra.fullMode')}</span>
                    </div>
                    {!allowFullMode && (
                      <span className="text-[11px] text-[var(--text-muted)] italic">
                        ({t('extra.enabledInSettings')})
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-[var(--t-crit)]/80 mt-1">
                    {t('extra.fullModeWarning')}
                  </p>
                </div>
              </label>
            </div>
          </div>

          {/* Action buttons */}
          <div className="flex items-center justify-end gap-3 pt-3 border-t border-[var(--border-default)]">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="px-4 py-2 text-xs font-medium rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)] cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
            >
              {t('common.cancel')}
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting ? true : undefined}
              className="px-4 py-2 text-xs font-semibold rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white shadow-xs disabled:opacity-50 cursor-pointer focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)]"
            >
              {isSubmitting ? t('common.loading') : t('extra.createChat')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
