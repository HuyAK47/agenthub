import React from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Download, ExternalLink, Loader2 } from 'lucide-react';
import { completeSetup, getSetupStatus, installSetupMcp, installSetupTool } from '../api/client';

export const SetupPage: React.FC = () => {
  const queryClient = useQueryClient();
  const { data, isLoading } = useQuery({ queryKey: ['setup-status'], queryFn: getSetupStatus, refetchInterval: 3000 });
  const install = useMutation({ mutationFn: installSetupTool, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }) });
  const finish = useMutation({ mutationFn: completeSetup, onSuccess: () => queryClient.invalidateQueries({ queryKey: ['setup-status'] }) });
  const mcp = useMutation({ mutationFn: installSetupMcp });
  if (isLoading || !data) return <div className="p-8">Đang kiểm tra môi trường…</div>;
  const missing = data.tools.filter((tool) => !tool.installed && !tool.manual);
  const checks: Array<{ label: string; ok: boolean; tool?: (typeof data.tools)[number] }> = [
    { label: `Node.js ${data.node.version}`, ok: data.node.ok },
    { label: `Git${data.git.version ? ` (${data.git.version})` : ''}`, ok: data.git.installed },
    ...data.tools.map((tool) => ({ label: tool.id === 'agy' ? 'Antigravity CLI' : tool.id === 'codex' ? 'Codex CLI' : 'Claude Code', ok: tool.installed, tool })),
  ];
  return <div className="max-w-3xl space-y-6">
    <div><h2 className="text-2xl font-bold">Bắt đầu với AgentHub</h2><p className="text-[var(--t-text-2)] mt-1">Chuẩn bị các công cụ cần thiết để bạn có thể dùng ngay.</p></div>
    <div className="space-y-2">
      {checks.map((item) => <div key={item.label} className="flex items-center justify-between rounded-lg border border-[var(--t-border)] p-4 bg-[var(--t-surface)]"><span>{item.label}</span><span className={item.ok ? 'text-[var(--t-ok)]' : 'text-[var(--t-warn)]'}>{item.ok ? <Check size={18} /> : item.tool?.manual ? <a href={item.tool.docsUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1">Hướng dẫn <ExternalLink size={14} /></a> : item.tool ? <button onClick={() => install.mutate(item.tool!.id)} disabled={install.isPending} className="inline-flex items-center gap-1 rounded-md bg-[var(--t-accent)] px-3 py-1.5 text-white"><Download size={14} /> Cài đặt</button> : <span>Cần kiểm tra</span>}</span></div>)}
    </div>
    {missing.length > 0 && <button onClick={() => missing.forEach((tool) => install.mutate(tool.id))} disabled={install.isPending} className="rounded-lg bg-[var(--t-accent)] px-4 py-2 text-white">{install.isPending ? <Loader2 className="inline animate-spin" size={16} /> : 'Cài tất cả công cụ còn thiếu'}</button>}
    <div className="flex flex-wrap gap-3"><button onClick={() => mcp.mutate()} disabled={mcp.isPending} className="rounded-lg border border-[var(--t-border)] px-4 py-2">Đăng ký MCP với Claude Code</button><button onClick={() => finish.mutate(true)} className="rounded-lg border border-[var(--t-border)] px-4 py-2">Bỏ qua, làm sau</button><button onClick={() => finish.mutate(false)} className="rounded-lg bg-[var(--t-ok)] px-4 py-2 text-white">Hoàn tất</button></div>
  </div>;
};
