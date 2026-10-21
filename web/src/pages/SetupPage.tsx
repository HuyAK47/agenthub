import React, { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ExternalLink, Loader2 } from 'lucide-react';
import { completeSetup, getSetupStatus, installSetupMcp, installSetupTool } from '../api/client';
import { subscribeToEvents } from '../api/sse';
import { useLocale } from '../context/LocaleContext';

export const SetupPage: React.FC = () => {
  const { t } = useLocale();
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, refetchInterval: 3000 });
  const [logs, setLogs] = useState<Record<string, string>>({});
  const [installingTool, setInstallingTool] = useState<string | null>(null);
  const [installResult, setInstallResult] = useState<Record<string, boolean>>({});
  const install = useMutation({ mutationFn: installSetupTool });
  const finish = useMutation({ mutationFn: completeSetup, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }) });
  const mcp = useMutation({ mutationFn: installSetupMcp, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }) });

  useEffect(() => subscribeToEvents((event) => {
    if (!event.type.startsWith('setup.install_') || !event.payload?.tool) return;
    const tool = String(event.payload.tool);
    if (event.type === 'setup.install_progress') setLogs((old) => ({ ...old, [tool]: `${old[tool] || ''}${event.payload.line || ''}` }));
    if (event.type === 'setup.install_done') {
      setInstallResult((old) => ({ ...old, [tool]: Boolean(event.payload.ok) }));
      queryClient.invalidateQueries({ queryKey: ['setup-status'] });
    }
  }), [queryClient]);

  const missing = useMemo(() => data?.tools.filter((tool) => !tool.installed && !tool.manual) || [], [data]);
  const installOne = async (tool: string) => {
    setInstallingTool(tool);
    setLogs((old) => ({ ...old, [tool]: '' }));
    let stop: (() => void) | undefined;
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = subscribeToEvents((event) => {
        if (event.type === 'setup.install_done' && event.payload?.tool === tool) { unsubscribe(); resolve(); }
      });
      stop = unsubscribe;
    });
    try { await install.mutateAsync(tool); await completed; } finally { stop?.(); setInstallingTool(null); }
  };
  const installAll = async () => { for (const tool of missing) await installOne(tool.id); };
  if (isLoading || !data) return <div className="p-8">{t('setup.loading')}</div>;
  const toolLabel = (id: string) => t(`setup.${id}`);
  const checks: Array<{ key: string; label: string; ok: boolean; action?: React.ReactNode }> = [
    { key: 'node', label: t('setup.node', { version: data.node.version }), ok: data.node.ok },
    { key: 'git', label: t('setup.git', { version: data.git.version ? ` (${data.git.version})` : '' }), ok: data.git.installed },
    ...data.tools.map((tool) => ({ key: tool.id, label: toolLabel(tool.id), ok: tool.installed, action: tool.manual ? <a href={tool.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">{t('setup.manualGuide')} <ExternalLink size={14} /></a> : <button onClick={() => installOne(tool.id)} disabled={installingTool !== null} className="inline-flex items-center gap-1 rounded-md bg-[var(--t-accent)] px-3 py-1.5 text-white"><Download size={14} /> {installingTool === tool.id ? t('setup.running') : t('setup.install')}</button> })),
    { key: 'service', label: t('setup.service'), ok: data.serviceRunning },
    { key: 'mcp', label: t('setup.mcp'), ok: data.mcpRegistered, action: !data.mcpRegistered ? <button onClick={() => mcp.mutate()} disabled={mcp.isPending} className="rounded-md border px-3 py-1.5">{mcp.isPending ? t('setup.running') : t('setup.install')}</button> : undefined },
  ];
  return <div className="max-w-3xl space-y-6">
    <div><h2 className="text-2xl font-bold">{t('setup.title')}</h2><p className="text-[var(--t-text-2)] mt-1">{t('setup.subtitle')}</p></div>
    <div className="space-y-2">{checks.map((item) => <div key={item.key} className="rounded-lg border border-[var(--t-border)] p-4 bg-[var(--t-surface)]"><div className="flex items-center justify-between"><span>{item.label}</span><span className={item.ok ? 'text-[var(--t-ok)]' : 'text-[var(--t-warn)]'}>{item.ok ? <Check size={18} /> : item.action || <span>{t('setup.needsCheck')}</span>}</span></div>{item.key !== 'node' && item.key !== 'git' && logs[item.key] !== undefined && <><pre className="mt-3 max-h-32 overflow-auto rounded bg-black/10 p-2 text-xs">{logs[item.key]}</pre><a className="mt-2 inline-block text-xs underline" href={`/api/setup/log/${encodeURIComponent(item.key)}`} target="_blank" rel="noreferrer">{t('setup.log')}</a></>}</div>)}</div>
    {data.profiles.length > 0 && <div className="rounded-lg border border-[var(--t-border)] p-4 bg-[var(--t-surface)]"><h3 className="font-semibold">{t('setup.accounts')}</h3><div className="mt-2 space-y-2">{data.profiles.map((profile) => <div key={profile.name} className="flex items-center justify-between"><span>{t('setup.account', { name: profile.name })}</span>{profile.loggedIn ? <Check className="text-[var(--t-ok)]" size={18} /> : <Link className="underline" to={`/profiles#profile-${encodeURIComponent(profile.name)}`}>{t('setup.login')}</Link>}</div>)}</div></div>}
    {missing.length > 0 && <button onClick={installAll} disabled={install.isPending || installingTool !== null} className="rounded-lg bg-[var(--t-accent)] px-4 py-2 text-white">{installingTool ? <><Loader2 className="inline animate-spin" size={16} /> {t('setup.installing')}</> : <><Download className="inline" size={16} /> {t('setup.installAll')}</>}</button>}
    {Object.entries(installResult).map(([tool, ok]) => <div key={tool} className={ok ? 'text-[var(--t-ok)]' : 'text-[var(--t-warn)]'}>{toolLabel(tool)}: {ok ? t('setup.done') : t('setup.installFailed')}</div>)}
    <div className="flex flex-wrap gap-3"><button onClick={() => finish.mutate(true)} className="rounded-lg border border-[var(--t-border)] px-4 py-2">{t('setup.skip')}</button><button onClick={() => finish.mutate(false)} className="rounded-lg bg-[var(--t-ok)] px-4 py-2 text-white">{t('setup.complete')}</button></div>
  </div>;
};
