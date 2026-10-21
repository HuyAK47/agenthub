import crypto from 'node:crypto';
import path from 'node:path';
import { ChatPermissionRepo, ChatPermissionRow, ChatSessionRepo, PermissionRuleRepo, ProjectRepo } from '../db/index.js';
import { BrainPolicy } from '../brain/policy.js';

export type PermissionDecision = 'allow' | 'deny' | 'allow_always';
export interface PermissionRequestInput { sessionId: string; messageId?: string | null; toolName: string; input: Record<string, unknown>; kind?: 'brain' | 'user' }
interface PendingRequest { row: ChatPermissionRow; resolve: (result: PermissionResult) => void; timer: NodeJS.Timeout }
export interface PermissionResult { behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }
export type PermissionEvent = (request: ChatPermissionRow) => void;

const FILE_TOOLS = new Set(['Write', 'Edit', 'Read', 'NotebookEdit', 'Glob', 'Grep']);
const DANGEROUS = /(^|\s)(systemctl|launchctl|sudo|su|docker|podman)(\s|$)|\brm\s+-[a-z]*r[a-z]*f|\brm\s+-[a-z]*f[a-z]*r|\bgit\s+reset\s+--hard|\bgit\s+push\s+(?:[^;&|]*\s)?(?:-f|--force)(?:\s|$)|\bchmod\s+-[a-z]*R|\bchown\s+-[a-z]*R|\bmkfs(?:\.|\s)|\bdd\s+if=/i;

function shellSegments(command: string): string[] {
  const result: string[] = []; let start = 0; let quote = ''; let depth = 0;
  for (let i = 0; i < command.length; i++) { const ch = command[i];
    if (quote) { if (ch === quote && command[i - 1] !== '\\') quote = ''; continue; }
    if (ch === "'" || ch === '"') { quote = ch; continue; }
    if (ch === '$' && command[i + 1] === '(') depth++;
    if (ch === ')' && depth) depth--;
    if (!depth && (ch === ';' || ch === '|' || ch === '&')) { const segment = command.slice(start, i).trim(); if (segment) result.push(segment); if (command[i + 1] === ch) i++; start = i + 1; }
  }
  const tail = command.slice(start).trim(); if (tail) result.push(tail); return result;
}
function words(command: string): string[] { return command.match(/(?:[^\s"']+|"(?:\\.|[^"\\])*"|'[^']*')+/g)?.map((word) => word.replace(/^(['"])(.*)\1$/, '$2')) || []; }
function isWithin(file: string, root: string): boolean { const relative = path.relative(root, path.resolve(file)); return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative)); }
function segmentPrefix(segment: string): string | null {
  const tokens = words(segment).filter((token) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)); if (!tokens.length) return null;
  const command = path.basename(tokens[0]); const args = tokens.slice(1);
  if (command === 'git' || command === 'gh') return [command, ...args.filter((x) => !x.startsWith('-')).slice(0, command === 'gh' ? 2 : 1)].join(' ');
  if (command === 'npm' || command === 'pnpm' || command === 'yarn') { const i = args.findIndex((x) => !x.startsWith('-')); return i < 0 ? command : [command, args[i], ...(args[i] === 'run' && args[i + 1] ? [args[i + 1]] : [])].join(' '); }
  if (command === 'npx') return [command, args.find((x) => !x.startsWith('-')) || ''].join(' ').trim();
  if ((command === 'python' || command === 'python3') && args[0] === '-m' && args[1]) return `${command} -m ${args[1]}`;
  if (command === 'node' && args[0] && !args[0].startsWith('-')) return `${command} ${args[0]}`;
  return command;
}
export interface CommandPermissionInfo { patterns: string[]; dynamic: boolean; dangerous: boolean; exact: string }
export function commandPermissionInfo(command: string): CommandPermissionInfo {
  const segments = shellSegments(command); const dynamic = /\$\(|`|<\(|<<-?\s*['"]?\w+|>\s*(?![./~])/.test(command);
  const dangerous = DANGEROUS.test(command) || /\b(?:curl|wget)\b[^;&|]*(?:\||&&)\s*(?:sh|bash|zsh)\b/i.test(command);
  return { patterns: segments.map(segmentPrefix).filter((x): x is string => Boolean(x)).map((x) => `command:${x}`), dynamic, dangerous, exact: `command-exact:${command}` };
}
export function permissionPattern(input: Record<string, unknown>): string | null {
  if (typeof input.command === 'string' && input.command) return commandPermissionInfo(input.command).patterns[0] || null;
  for (const key of ['file_path', 'path']) if (typeof input[key] === 'string' && input[key]) return `${key}:${input[key]}`;
  return null;
}

export class PermissionBroker {
  private pending = new Map<string, PendingRequest>();
  constructor(private repo: ChatPermissionRepo, private timeoutSec = 600, private onRequest?: PermissionEvent, private brainPolicy?: BrainPolicy | ((sessionId: string) => BrainPolicy | undefined), private sessionRepo?: ChatSessionRepo, private ruleRepo?: PermissionRuleRepo, private projectRepo?: ProjectRepo) {}
  listPending(sessionId?: string): ChatPermissionRow[] { return this.repo.listPending(sessionId); }
  get(id: string): ChatPermissionRow | undefined { return this.repo.get(id); }
  getLatest(sessionId: string, messageId: string | null | undefined, toolName: string): ChatPermissionRow | undefined { return this.repo.getLatest(sessionId, messageId, toolName); }
  listRules() { return this.ruleRepo?.listAll() || []; }
  deleteRule(id: string): boolean { return this.ruleRepo?.delete(id) || false; }
  private context(sessionId: string): { projectId: string | null; projectPath?: string } { const session = this.sessionRepo?.get(sessionId); const projectId = session?.projectId || null; return { projectId, projectPath: projectId ? this.projectRepo?.get(projectId)?.path : undefined }; }
  private patterns(input: Record<string, unknown>, toolName: string, ctx: { projectId: string | null; projectPath?: string }): string[] {
    if (typeof input.command === 'string') { const info = commandPermissionInfo(input.command); return info.dangerous ? [] : info.patterns.concat(info.dynamic ? [info.exact] : []); }
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
    if (file && FILE_TOOLS.has(toolName)) return [`path:${path.resolve(ctx.projectPath || path.dirname(path.resolve(file)))}`];
    const pattern = permissionPattern(input); return pattern ? [pattern] : [];
  }
  private allowed(input: Record<string, unknown>, toolName: string, sessionId: string): boolean {
    if (!this.ruleRepo) {
      const current = permissionPattern(input);
      return Boolean(current && this.repo.listAlways(sessionId, toolName).some((row) => permissionPattern(JSON.parse(row.input) as Record<string, unknown>) === current));
    }
    const ctx = this.context(sessionId); const info = typeof input.command === 'string' ? commandPermissionInfo(input.command) : null; if (info?.dangerous) return false;
    const rules = this.ruleRepo.list({ sessionId, projectId: ctx.projectId || undefined, toolName });
    if (info) return (info.dynamic && rules.some((r) => r.pattern === info.exact)) || info.patterns.every((p) => rules.some((r) => r.pattern === p));
    const file = typeof input.file_path === 'string' ? input.file_path : typeof input.path === 'string' ? input.path : null;
    if (file && FILE_TOOLS.has(toolName) && ctx.projectPath && !isWithin(file, ctx.projectPath)) return false;
    return rules.some((r) => this.patterns(input, toolName, ctx).includes(r.pattern));
  }
  request(input: PermissionRequestInput): Promise<PermissionResult> {
    const sessionKind = this.sessionRepo?.get(input.sessionId)?.kind; const policy = typeof this.brainPolicy === 'function' ? this.brainPolicy(input.sessionId) : this.brainPolicy;
    if (sessionKind === 'brain' && policy) { const decision = policy.decide(input); if (decision) { const id = crypto.randomUUID(); this.repo.insert({ id, sessionId: input.sessionId, messageId: input.messageId || null, toolName: input.toolName, input: JSON.stringify(input.input), status: 'pending' }); this.repo.resolve(id, decision.action, decision.message, decision.reason); return Promise.resolve(decision.action === 'allow' ? { behavior: 'allow', updatedInput: input.input } : { behavior: 'deny', message: decision.message }); } }
    if (this.allowed(input.input, input.toolName, input.sessionId)) return Promise.resolve({ behavior: 'allow', updatedInput: input.input });
    const id = crypto.randomUUID(); const row = this.repo.insert({ id, sessionId: input.sessionId, messageId: input.messageId || null, toolName: input.toolName, input: JSON.stringify(input.input), status: 'pending' }); this.onRequest?.(row);
    return new Promise((resolve) => { const timer = setTimeout(() => this.resolve(id, 'deny', 'Hết thời gian chờ cấp quyền'), Math.max(1, this.timeoutSec) * 1000); this.pending.set(id, { row, resolve, timer }); });
  }
  resolve(id: string, decision: PermissionDecision, message?: string): boolean {
    const pending = this.pending.get(id); const row = this.repo.get(id); if (!pending || !row || row.status !== 'pending') return false; clearTimeout(pending.timer); const input = JSON.parse(row.input) as Record<string, unknown>;
    if (decision === 'allow_always' && this.ruleRepo) { const ctx = this.context(row.sessionId); const info = typeof input.command === 'string' ? commandPermissionInfo(input.command) : null; const patterns = info?.dangerous ? [] : info ? (info.dynamic ? [info.exact] : info.patterns) : this.patterns(input, row.toolName, ctx); const scope = ctx.projectId ? 'project' : 'session'; for (const pattern of patterns) this.ruleRepo.insert({ id: crypto.randomUUID(), scope, sessionId: scope === 'session' ? row.sessionId : null, projectId: scope === 'project' ? ctx.projectId : null, toolName: row.toolName, pattern, createdBy: 'user' }); }
    this.repo.resolve(id, decision, message || null, 'user'); this.pending.delete(id); pending.resolve(decision === 'deny' ? { behavior: 'deny', message: message || 'Quyền công cụ bị từ chối' } : { behavior: 'allow', updatedInput: input }); return true;
  }
  stop(): void { for (const id of this.pending.keys()) this.resolve(id, 'deny', 'AgentHub đã dừng'); }
}
