import React, { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { getConfig, updateConfig, getClaudeApiKeyStatus, setClaudeApiKey } from '../api/client';
import { Save, CheckCircle2, AlertCircle, Info, MessageSquare, Bell } from 'lucide-react';
import { useLocale } from '../context/LocaleContext';
import { TelegramCard } from '../components/TelegramCard';

export const SettingsPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();

  const [hardChain, setHardChain] = useState<string>('');
  const [easyChain, setEasyChain] = useState<string>('');
  const [timeoutHours, setTimeoutHours] = useState<number>(3);
  const [claudeBin, setClaudeBin] = useState<string>('claude');
  const [allowFullMode, setAllowFullMode] = useState<boolean>(false);
  const [chatModel, setChatModel] = useState<string>('sonnet');
  const [chatModels, setChatModels] = useState<string[]>(['opus', 'sonnet', 'haiku']);
  const [reviewerModel, setReviewerModel] = useState<string>('codex:gpt-5.6-luna');
  const [maxConcurrent, setMaxConcurrent] = useState<number>(2);
  const [autoCompactPercent, setAutoCompactPercent] = useState<number>(85);
  const [bucketGemini, setBucketGemini] = useState<number>(5_000_000);
  const [bucketClaude, setBucketClaude] = useState<number>(5_000_000);
  const [claudeFactor, setClaudeFactor] = useState<number>(0.9);
  const [claudeOverhead, setClaudeOverhead] = useState<number>(40_000);
  const [fallback, setFallback] = useState<NonNullable<NonNullable<import('../types/api').SystemConfig['brain']>['fallback']>>([]);
  const [desktopNotify, setDesktopNotify] = useState<boolean>(true);
  const [brainMode, setBrainMode] = useState<'off' | 'suggest' | 'auto'>('suggest');
  const [brainMaxConcurrent, setBrainMaxConcurrent] = useState<number>(2);
  const [quietHoursEnabled, setQuietHoursEnabled] = useState<boolean>(false);
  const [quietHoursStart, setQuietHoursStart] = useState<string>('22:00');
  const [quietHoursEnd, setQuietHoursEnd] = useState<string>('07:00');
  const [digestEnabled, setDigestEnabled] = useState<boolean>(true);
  const [digestTime, setDigestTime] = useState<string>('18:00');
  const [apiKey, setApiKey] = useState('');
  const [apiKeyConfigured, setApiKeyConfigured] = useState(false);
  // 'none' | 'large' | 'all': how much of Claude's plan the user must approve
  const [approvalMode, setApprovalMode] = useState<'none' | 'large' | 'all'>('none');
  const [approvalMinTasks, setApprovalMinTasks] = useState<number>(5);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const { data: config, isLoading, error } = useQuery({
    queryKey: ['config'],
    queryFn: getConfig,
  });

  useEffect(() => {
    if (config) {
      const hardList = config.modelChainHard || config.modelChains?.hard || [];
      const easyList = config.modelChainEasy || config.modelChains?.easy || [];
      const timeoutSec =
        config.defaultTimeout !== undefined
          ? config.defaultTimeout
          : config.runTimeoutHours
          ? config.runTimeoutHours * 3600
          : 10800;
      setHardChain(hardList.join('\n'));
      setEasyChain(easyList.join('\n'));
      setTimeoutHours(Math.max(1, Math.round(timeoutSec / 3600)));
      setClaudeBin(config.chat?.claudeBin || 'claude');
      setAllowFullMode(Boolean(config.chat?.allowFullMode));
      setChatModel(config.chat?.model || 'sonnet');
      setChatModels(config.chat?.models?.length ? config.chat.models : ['opus', 'sonnet', 'haiku']);
      setReviewerModel(config.reviewer?.model || 'codex:gpt-5.6-luna');
      setMaxConcurrent(config.chat?.maxConcurrent ?? 2);
      setAutoCompactPercent(config.chat?.autoCompactPercent ?? 85);
      setFallback(config.brain?.fallback || [{ type: 'engine', engine: 'codex' }]);
      const minTasks = config.planning?.approvalMinTasks ?? 0;
      setApprovalMode(config.planning?.requireApproval ? 'all' : minTasks > 0 ? 'large' : 'none');
      if (minTasks > 0) setApprovalMinTasks(minTasks);
      if (config.savings) {
        if (config.savings.bucketTokens?.gemini !== undefined) {
          setBucketGemini(config.savings.bucketTokens.gemini);
        }
        if (config.savings.bucketTokens?.claude !== undefined) {
          setBucketClaude(config.savings.bucketTokens.claude);
        }
        if (config.savings.claudeFactor !== undefined) {
          setClaudeFactor(config.savings.claudeFactor);
        }
        if (config.savings.claudeOverheadPerTask !== undefined) {
          setClaudeOverhead(config.savings.claudeOverheadPerTask);
        }
      }
      setDesktopNotify(config.notifications?.desktop ?? true);
      setBrainMode(config.brain?.mode ?? 'suggest');
      setBrainMaxConcurrent(config.brain?.maxConcurrent ?? 2);
      setQuietHoursEnabled(Boolean(config.notifications?.quietHours?.enabled));
      setQuietHoursStart(config.notifications?.quietHours?.start || '22:00');
      setQuietHoursEnd(config.notifications?.quietHours?.end || '07:00');
      setDigestEnabled(config.brain?.digest?.enabled ?? true);
      setDigestTime(config.brain?.digest?.time || '18:00');
    }
  }, [config]);

  const { data: apiKeyStatus } = useQuery({ queryKey: ['claude-api-key'], queryFn: getClaudeApiKeyStatus });
  useEffect(() => setApiKeyConfigured(Boolean(apiKeyStatus?.configured)), [apiKeyStatus]);

  const mutation = useMutation({
    mutationFn: updateConfig,
    onSuccess: (updated) => {
      queryClient.setQueryData(['config'], updated);
      if (apiKey.trim()) {
        setClaudeApiKey(apiKey).then(() => { setApiKey(''); setApiKeyConfigured(true); }).catch(() => undefined);
      }
      setSaveSuccess(true);
      setSaveError(null);
      setTimeout(() => setSaveSuccess(false), 3000);
    },
    onError: (err: any) => {
      setSaveError(err.message || t('settings.saveError'));
      setSaveSuccess(false);
    },
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setSaveSuccess(false);
    setSaveError(null);

    const hardModels = hardChain
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    const easyModels = easyChain
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);

    if (hardModels.length === 0) {
      setSaveError(t('settings.hardChainRequired'));
      return;
    }
    if (easyModels.length === 0) {
      setSaveError(t('settings.easyChainRequired'));
      return;
    }

    const hours = Number(timeoutHours) || 3;
    const defaultTimeout = hours * 3600;

    mutation.mutate({
      modelChainHard: hardModels,
      modelChainEasy: easyModels,
      defaultTimeout,
      modelChains: {
        hard: hardModels,
        easy: easyModels,
      },
      runTimeoutHours: hours,
      chat: {
        claudeBin: claudeBin.trim() || 'claude',
        allowFullMode,
        maxConcurrent: Number(maxConcurrent) || 2,
        model: chatModel,
        autoCompactPercent: Number(autoCompactPercent) || 85,
        models: chatModels,
      },
      reviewer: { model: reviewerModel },
      savings: {
        bucketTokens: {
          gemini: Number(bucketGemini) || 5_000_000,
          claude: Number(bucketClaude) || 5_000_000,
        },
        claudeFactor: Number(claudeFactor) || 0.9,
        claudeOverheadPerTask: Number(claudeOverhead) || 40_000,
      },
      brain: {
        mode: brainMode,
        maxConcurrent: Number(brainMaxConcurrent) || 2,
        digest: {
          enabled: digestEnabled,
          time: digestTime.trim() || '18:00',
        },
        fallback,
      },
      notifications: {
        desktop: desktopNotify,
        quietHours: {
          enabled: quietHoursEnabled,
          start: quietHoursStart.trim() || '22:00',
          end: quietHoursEnd.trim() || '07:00',
        },
      },
      planning: {
        requireApproval: approvalMode === 'all',
        approvalMinTasks: approvalMode === 'large' ? Math.max(1, Number(approvalMinTasks) || 5) : 0,
      },
    });
  };

  const handleToggleFullMode = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    if (checked) {
      const confirmed = window.confirm(
        t('extra.fullModeConfirm'),
      );
      if (confirmed) {
        setAllowFullMode(true);
      } else {
        setAllowFullMode(false);
      }
    } else {
      setAllowFullMode(false);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">{t('settings.title')}</h1>
        <p className="text-sm text-[var(--t-text-3)]">
          {t('extra.settingsSubtitle')}
        </p>
      </div>

      {saveSuccess && (
        <div className="p-4 rounded-xl bg-[color-mix(in_srgb,var(--t-ok)_15%,transparent)] border border-[var(--t-ok)] text-[var(--t-ok)] text-sm flex items-center gap-2">
          <CheckCircle2 className="w-5 h-5 text-[var(--t-ok)] shrink-0" />
          <span>{t('settings.saveSuccess')}</span>
        </div>
      )}

      {saveError && (
        <div className="p-4 rounded-xl bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] border border-[var(--t-crit)] text-[var(--t-crit)] text-sm flex items-center gap-2">
          <AlertCircle className="w-5 h-5 text-[var(--t-crit)] shrink-0" />
          <span>{saveError}</span>
        </div>
      )}

      {isLoading ? (
        <div className="flex items-center justify-center p-12">
          <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
        </div>
      ) : error ? (
        <div className="p-8 text-center text-[var(--t-crit)] text-sm">{t('settings.loadError')}</div>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-6">
          <div id="planning-approval" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-3 shadow-xs" data-testid="planning-approval">
            <h2 className="text-sm font-semibold">{t('extra.planningApprovalTitle')}</h2>
            <p className="text-xs text-[var(--t-text-3)]">{t('extra.planningApprovalHint')}</p>
            {(['none', 'large', 'all'] as const).map((mode) => (
              <label key={mode} className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="radio" name="approvalMode" value={mode} checked={approvalMode === mode} onChange={() => setApprovalMode(mode)} />
                <span>{t(mode === 'none' ? 'extra.planningApprovalNone' : mode === 'large' ? 'extra.planningApprovalLarge' : 'extra.planningApprovalAll')}</span>
                {mode === 'large' && (
                  <input type="number" min={1} max={100} aria-label={t('extra.planningApprovalMinTasks')} value={approvalMinTasks}
                    onChange={(e) => setApprovalMinTasks(Number(e.target.value))} disabled={approvalMode !== 'large'}
                    className="w-16 text-sm rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] px-2 py-0.5" />
                )}
              </label>
            ))}
          </div>
          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs">
            {/* Info notice */}
            <div className="p-4 rounded-lg bg-[var(--t-accent-bg)] border border-[var(--t-accent)] text-[var(--t-accent)] text-xs flex items-start gap-2.5">
              <Info className="w-4 h-4 shrink-0 mt-0.5" />
              <div>
                {t('settings.infoChain')}
              </div>
            </div>

            {/* Hard chain */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                {t('settings.hardChainLabel')}
              </label>
              <textarea
                rows={4}
                value={hardChain}
                onChange={(e) => setHardChain(e.target.value)}
                placeholder="codex:gpt-5.6-luna&#10;gemini-3.8-flash-high"
                className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
              <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                {t('settings.hardChainHint')}
              </p>
            </div>

            {/* Easy chain */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                {t('settings.easyChainLabel')}
              </label>
              <textarea
                rows={3}
                value={easyChain}
                onChange={(e) => setEasyChain(e.target.value)}
                placeholder="gemini-3.8-flash-medium&#10;codex:gpt-5.6-luna"
                className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] p-3 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
              <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                {t('settings.easyChainHint')}
              </p>
            </div>

            {/* Timeout */}
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                {t('settings.timeoutLabel')}
              </label>
              <input
                type="number"
                min={1}
                max={24}
                value={timeoutHours}
                onChange={(e) => setTimeoutHours(parseInt(e.target.value, 10) || 1)}
                className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
              />
            </div>

            {/* Claude Chat section */}
            <div className="pt-6 border-t border-[var(--t-border)] space-y-4">
              <div className="flex items-center gap-2">
                <MessageSquare className="w-4 h-4 text-[var(--t-accent)]" />
                <h3 className="text-sm font-semibold text-[var(--t-text)]">
                  {t('extra.chatSettings')}
                </h3>
              </div>

              {/* claudeBin field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.claudeBin')}
                </label>
                <input
                  type="text"
                  value={claudeBin}
                  onChange={(e) => setClaudeBin(e.target.value)}
                  placeholder={t('settings.claudeBinPlaceholder')}
                  className="w-full text-xs font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeBinHint')}
                </p>
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.claudeVersion')}: {config?.chat?.claudeVersion || t('extra.unknown')}
                </p>
              </div>

              {/* maxConcurrent field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.maxConcurrent')}
                </label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={maxConcurrent}
                  onChange={(e) => setMaxConcurrent(parseInt(e.target.value, 10) || 1)}
                  className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
              </div>

              {/* autoCompactPercent field */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text)] mb-1">
                  {t('extra.autoCompactPercent')}
                </label>
                <input
                  type="number"
                  min={10}
                  max={95}
                  value={autoCompactPercent}
                  onChange={(e) => setAutoCompactPercent(parseInt(e.target.value, 10) || 85)}
                  className="w-32 text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"
                />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">
                  {t('extra.autoCompactPercentHint')}
                </p>
              </div>

              {/* allowFullMode selector */}
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-[var(--t-text-2)] mb-1">{t('extra.chatModel')}</label>
                <input value={chatModel} onChange={(e) => setChatModel(e.target.value)} className="w-full max-w-sm text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] px-3 py-2 text-[var(--t-text)]" />
                <p className="text-[11px] text-[var(--t-text-3)] mt-1">Model chat mặc định. Danh sách chọn: {chatModels.join(', ')}</p>
                <input value={chatModels.join(', ')} onChange={(e) => setChatModels(e.target.value.split(',').map((model) => model.trim()).filter(Boolean))} className="mt-2 w-full max-w-sm text-xs font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)]" aria-label="Danh sách model chat" />
              </div>

              {/* allowFullMode toggle */}
              <div className="pt-2">
                <label className="flex items-start gap-3 p-3.5 rounded-xl border border-[var(--t-border)] bg-[var(--t-surface-2)] cursor-pointer hover:bg-[var(--t-surface-2)] transition-colors">
                  <input
                    type="checkbox"
                    checked={allowFullMode}
                    onChange={handleToggleFullMode}
                    className="mt-0.5 rounded text-[var(--t-crit)] focus:ring-[var(--t-crit)] w-4 h-4 cursor-pointer"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-semibold text-[var(--t-text)]">
                        {t('extra.allowFullMode')}
                      </span>
                      {allowFullMode && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-[color-mix(in_srgb,var(--t-crit)_15%,transparent)] text-[var(--t-crit)] font-bold border border-[var(--t-crit)]">
                          {t('extra.enabled')}
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-[var(--t-crit)] mt-1">
                      {t('extra.fullModeWarning')}
                    </p>
                  </div>
                </label>
              </div>
            </div>
          </div>

          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-2 shadow-xs">
            <h2 className="text-base font-semibold text-[var(--t-text)]">Reviewer</h2>
            <label className="block text-xs font-semibold text-[var(--t-text)]">Model reviewer</label>
            <input value={reviewerModel} onChange={(e) => setReviewerModel(e.target.value)} className="w-full text-sm font-mono rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)]" />
          </div>

          <div className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-4 shadow-xs">
            <div>
              <h2 className="text-base font-semibold text-[var(--t-text)]">Claude fallback chain</h2>
              <p className="text-xs text-[var(--t-text-3)]">Drag steps to reorder. The API key is write-only.</p>
            </div>
            {fallback.map((step, index) => (
              <div key={`${step.type}-${index}`} draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => { const from = Number(event.dataTransfer.getData('text/plain')); if (!Number.isInteger(from) || from === index) return; const next = [...fallback]; const [moved] = next.splice(from, 1); next.splice(index, 0, moved); setFallback(next); }} className="flex items-center gap-2 p-2 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] cursor-grab">
                <span className="text-xs text-[var(--t-text-3)]">⠿</span>
                <select value={step.type} onChange={(event) => { const next = [...fallback]; const type = event.target.value; next[index] = type === 'model' ? { type: 'model', model: 'sonnet' } : type === 'apiKey' ? { type: 'apiKey', dailyCapUSD: 5 } : type === 'profile' ? { type: 'profile', profile: '' } : type === 'wait' ? { type: 'wait' } : { type: 'engine', engine: 'codex' }; setFallback(next); }} className="text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1 text-[var(--t-text)]">
                  <option value="profile">profile</option><option value="model">model</option><option value="apiKey">apiKey</option><option value="engine">engine: codex</option><option value="wait">wait</option>
                </select>
                {step.type === 'profile' && <input value={step.profile || ''} onChange={(event) => { const next = [...fallback]; next[index] = { ...step, profile: event.target.value }; setFallback(next); }} placeholder="profile name" className="flex-1 text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1 text-[var(--t-text)]" />}
                {step.type === 'model' && <input value={step.model} onChange={(event) => { const next = [...fallback]; next[index] = { ...step, model: event.target.value }; setFallback(next); }} placeholder="sonnet" className="flex-1 text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1 text-[var(--t-text)]" />}
                {step.type === 'apiKey' && <input type="number" min={0.01} step={0.01} value={step.dailyCapUSD} onChange={(event) => { const next = [...fallback]; next[index] = { ...step, dailyCapUSD: Number(event.target.value) }; setFallback(next); }} className="w-24 text-xs rounded border border-[var(--t-border)] bg-[var(--t-surface)] p-1 text-[var(--t-text)]" />}
                <button type="button" onClick={() => setFallback(fallback.filter((_, itemIndex) => itemIndex !== index))} className="text-xs text-[var(--t-crit)]">Remove</button>
              </div>
            ))}
            <button type="button" onClick={() => setFallback([...fallback, { type: 'wait' }])} className="text-xs px-3 py-2 rounded border border-[var(--t-border)] text-[var(--t-text)]">Add step</button>
            <div className="pt-3 border-t border-[var(--t-border)]">
              <label className="block text-xs font-semibold text-[var(--t-text)] mb-1">Anthropic API key</label>
              <input type="password" value={apiKey} onChange={(event) => setApiKey(event.target.value)} placeholder={apiKeyConfigured ? 'Configured (enter to replace)' : 'sk-ant-…'} autoComplete="new-password" className="w-full text-xs font-mono rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2 text-[var(--t-text)]" />
            </div>
          </div>

          {/* Savings config block */}
          <div className="bg-white dark:bg-gray-900 rounded-xl border border-gray-200 dark:border-gray-800 p-6 space-y-6 shadow-xs">
            <div>
              <h2 className="text-base font-semibold text-[var(--text-primary)]">
                {t('settings.savingsSectionTitle')}
              </h2>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {t('extra.savingsSettings')}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1">
                  {t('settings.geminiBucketLabel')}
                </label>
                <input
                  type="number"
                  min={100_000}
                  step={100_000}
                  value={bucketGemini}
                  onChange={(e) => setBucketGemini(Number(e.target.value))}
                  className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {t('extra.geminiBucketHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1">
                  {t('settings.claudeBucketLabel')}
                </label>
                <input
                  type="number"
                  min={100_000}
                  step={100_000}
                  value={bucketClaude}
                  onChange={(e) => setBucketClaude(Number(e.target.value))}
                  className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {t('extra.claudeBucketHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1">
                  {t('extra.claudeFactor')}
                </label>
                <input
                  type="number"
                  min={0.1}
                  max={2.0}
                  step={0.05}
                  value={claudeFactor}
                  onChange={(e) => setClaudeFactor(parseFloat(e.target.value) || 0.9)}
                  className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {t('extra.claudeFactorHint')}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1">
                  {t('extra.claudeOverhead')}
                </label>
                <input
                  type="number"
                  min={0}
                  step={5_000}
                  value={claudeOverhead}
                  onChange={(e) => setClaudeOverhead(Number(e.target.value) || 0)}
                  className="w-full text-sm rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
                <p className="text-[11px] text-gray-400 mt-1">
                  {t('extra.claudeOverheadHint')}
                </p>
              </div>
            </div>
          </div>

          <section data-testid="notifications-settings" className="bg-[var(--t-surface)] rounded-xl border border-[var(--t-border)] p-6 space-y-6 shadow-xs">
            <div className="flex items-start justify-between gap-4">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-lg bg-[color-mix(in_srgb,var(--t-accent)_15%,transparent)] text-[var(--t-accent)]">
                  <Bell className="w-5 h-5" />
                </div>
                <div>
                  <h2 className="text-base font-semibold text-[var(--t-text)]">
                    {t('settings.notificationsTitle')}
                  </h2>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.notificationsDescription')}
                  </p>
                </div>
              </div>
            </div>

            <div className="flex items-center justify-between py-2 border-b border-[var(--t-border)]">
              <div>
                <label className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.desktopNotifyLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('settings.desktopNotifyHint')}
                </p>
              </div>
              <input
                type="checkbox"
                data-testid="desktop-notify-toggle"
                checked={desktopNotify}
                onChange={(e) => setDesktopNotify(e.target.checked)}
                className="rounded border-[var(--t-border)]"
              />
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-2">
              <div>
                <label className="text-sm font-semibold text-[var(--t-text)]">
                  {t('settings.brainModeLabel')}
                </label>
                <p className="text-xs text-[var(--t-text-3)]">
                  {t('settings.brainModeHint')}
                </p>
              </div>
              <div className="flex gap-4">
                {(['off', 'suggest', 'auto'] as const).map((mode) => (
                  <label key={mode} className="flex items-center gap-2 text-xs text-[var(--t-text)] cursor-pointer">
                    <input
                      type="radio"
                      name="brainMode"
                      value={mode}
                      checked={brainMode === mode}
                      onChange={() => setBrainMode(mode)}
                    />
                    <span>{t(`settings.brainMode.${mode}`)}</span>
                  </label>
                ))}
              </div>
              <label className="flex items-center gap-3 text-xs text-[var(--t-text)]">
                <span>{t('settings.brainMaxConcurrent')}</span>
                <input data-testid="brain-max-concurrent" type="number" min={1} max={20} value={brainMaxConcurrent} onChange={(e) => setBrainMaxConcurrent(parseInt(e.target.value, 10) || 1)} className="w-24 rounded border border-[var(--t-border)] bg-[var(--t-surface-2)] p-2" />
              </label>
            </div>

            <div className="py-2 border-b border-[var(--t-border)] space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-semibold text-[var(--t-text)]">
                    {t('settings.quietHoursTitle')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.quietHoursHint')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  data-testid="quiet-hours-toggle"
                  checked={quietHoursEnabled}
                  onChange={(e) => setQuietHoursEnabled(e.target.checked)}
                  className="rounded border-[var(--t-border)]"
                />
              </div>
              {quietHoursEnabled && (
                <div className="grid grid-cols-2 gap-4 pt-2">
                  <div>
                    <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                      {t('settings.quietHoursStart')}
                    </label>
                    <input
                      type="time"
                      value={quietHoursStart}
                      onChange={(e) => setQuietHoursStart(e.target.value)}
                      className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                      {t('settings.quietHoursEnd')}
                    </label>
                    <input
                      type="time"
                      value={quietHoursEnd}
                      onChange={(e) => setQuietHoursEnd(e.target.value)}
                      className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                    />
                  </div>
                </div>
              )}
            </div>

            <div className="py-2 space-y-3">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-sm font-semibold text-[var(--t-text)]">
                    {t('settings.digestTitle')}
                  </label>
                  <p className="text-xs text-[var(--t-text-3)]">
                    {t('settings.digestHint')}
                  </p>
                </div>
                <input
                  type="checkbox"
                  data-testid="digest-toggle"
                  checked={digestEnabled}
                  onChange={(e) => setDigestEnabled(e.target.checked)}
                  className="rounded border-[var(--t-border)]"
                />
              </div>
              {digestEnabled && (
                <div className="pt-2 max-w-xs">
                  <label className="block text-xs font-semibold text-[var(--t-text-2)] mb-1">
                    {t('settings.digestTime')}
                  </label>
                  <input
                    type="time"
                    value={digestTime}
                    onChange={(e) => setDigestTime(e.target.value)}
                    className="w-full text-sm rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-[var(--t-text)] font-mono"
                  />
                </div>
              )}
            </div>
          </section>

          <TelegramCard />

          <div className="flex justify-end">
            <button
              type="submit"
              disabled={mutation.isPending}
              className="px-5 py-2 rounded-lg bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white text-xs font-semibold inline-flex items-center gap-2 shadow-xs cursor-pointer disabled:opacity-50"
            >
              <Save className="w-4 h-4" />
              <span>{mutation.isPending ? t('common.loading') : t('settings.saveConfigBtn')}</span>
            </button>
          </div>
        </form>
      )}
    </div>
  );
};
