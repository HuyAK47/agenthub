import { ChatMessage } from '../../types/api';

export type ToolKind = 'read' | 'search' | 'bash' | 'edit' | 'hub' | 'other';

export function getToolKind(name = ''): ToolKind {
  const value = name.toLowerCase();
  if (/edit|write|patch|replace/.test(value)) return 'edit';
  if (/grep|glob|find|search|rg/.test(value)) return 'search';
  if (/bash|shell|exec|terminal|command/.test(value)) return 'bash';
  if (/hub|task|agent|mcp/.test(value)) return 'hub';
  if (/read|cat|view|file/.test(value)) return 'read';
  return 'other';
}

export function compactPath(value: string): string {
  const normalized = value.replace(/\\/g, '/');
  const parts = normalized.split('/').filter(Boolean);
  if (parts.length <= 3) return normalized;
  return `…/${parts.slice(-3).join('/')}`;
}

export function summarizeTool(message: ChatMessage, labels?: { read: string; run: string; default: string }): string {
  const name = message.meta?.name || '';
  const summary = message.meta?.summary?.trim();
  if (summary) return summary;

  const input = message.meta?.input;
  if (name.toLowerCase().includes('read') && typeof input === 'object' && input) {
    const path = (input as Record<string, unknown>).file_path || (input as Record<string, unknown>).path;
    if (typeof path === 'string') return labels?.read.replace('{path}', compactPath(path)) || `Read ${compactPath(path)}`;
  }
  if (typeof input === 'object' && input) {
    const command = (input as Record<string, unknown>).command;
    if (typeof command === 'string') return labels?.run.replace('{command}', command.trim()) || `Run \`${command.trim()}\``;
  }
  return name || message.content || labels?.default || 'Tool';
}

export function formatToolDuration(durationMs?: number): string | null {
  if (durationMs === undefined) return null;
  if (durationMs < 1000) return `${durationMs}ms`;
  return `${(durationMs / 1000).toLocaleString('vi-VN', { maximumFractionDigits: 1 })}s`;
}
