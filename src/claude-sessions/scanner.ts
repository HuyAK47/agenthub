import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import Database from 'better-sqlite3';
import { attributeTurn, taskRefsFromToolInput } from './attribution.js';
import { ClaudeSessionRepo } from './repo.js';
import { ClaudeFailoverState } from '../chat/failover.js';

export interface ClaudeScanOptions {
  dir: string;
  maxAgeDays?: number;
  include?: string[];
  hubHome?: string;
  worktreesDir?: string;
  weights?: { cacheCreation?: number; cacheRead?: number };
  failoverState?: ClaudeFailoverState;
}

export class ClaudeSessionScanner {
  private timer?: NodeJS.Timeout;
  private readonly weights: { cacheCreation: number; cacheRead: number };
  constructor(private db: Database.Database, private options: ClaudeScanOptions) {
    this.weights = { cacheCreation: options.weights?.cacheCreation ?? 1.25, cacheRead: options.weights?.cacheRead ?? 0.1 };
  }
  start() {
    void this.scan().catch(() => undefined);
    this.timer = setInterval(() => void this.scan().catch(() => undefined), 60_000);
    this.timer.unref?.();
  }
  stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }
  async scan() {
    const repo = new ClaudeSessionRepo(this.db);
    const tasks = this.db.prepare('SELECT id,slug FROM tasks').all() as Array<{ id: string; slug: string }>;
    const files = findTranscriptFiles(this.options.dir, this.options.maxAgeDays ?? 14);
    for (const file of files) await this.scanFile(file, repo, tasks);
  }
  private async scanFile(file: string, repo: ClaudeSessionRepo, tasks: Array<{ id: string; slug: string }>) {
    let stat: fs.Stats;
    try { stat = await fs.promises.stat(file); } catch { return; }
    const existing = this.db.prepare('SELECT * FROM claude_scan_state WHERE path=?').get(file) as { inode:number;size:number;offset:number;turnId:string;turnTasks:string;eligible:number } | undefined;
    const reset = !existing || existing.inode !== stat.ino || stat.size < existing.size;
    const start = reset ? 0 : existing.offset;
    let offset = start;
    let sessionId = path.basename(file, '.jsonl');
    let eligible = reset ? (!!repo.get(sessionId) || this.isHubChat(sessionId)) : existing.eligible === 1;
    let turnId = reset ? `${sessionId}:initial` : (existing.turnId || `${sessionId}:initial`);
    let turnTasks = new Set<string>(reset ? [] : parseTaskState(existing.turnTasks));
    const records: Array<{ event: ClaudeTranscriptEvent; sessionId: string; turnId: string; tasks: string[] }> = [];
    const turns = new Map<string, Set<string>>();
    const stream = fs.createReadStream(file, { start, encoding: 'utf8' });
    const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        const raw = line as string;
        const bytes = Buffer.byteLength(raw + '\n');
        offset += bytes;
        let event: ClaudeTranscriptEvent;
        try { event = JSON.parse(raw); } catch { offset -= bytes; break; }
        if (!event || typeof event !== 'object') continue;
        if (typeof event.sessionId === 'string') sessionId = event.sessionId;
        if (!eligible && this.isAllowed(event, sessionId)) eligible = true;
        if (!eligible) continue;
        if (event.type === 'user' && !hasToolResult(event)) { turnId = `${sessionId}:${event.uuid || offset}`; turnTasks = new Set(); }
        if (event.type === 'ai-title' && typeof event.aiTitle === 'string') repo.upsert({ sessionId, cwd: String(event.cwd || ''), title: event.aiTitle.slice(0, 120) });
        if (event.type !== 'assistant' || !event.message) continue;
        const toolBlocks = Array.isArray(event.message.content)
          ? event.message.content.filter((block): block is { type: string; input?: unknown } => isRecord(block) && block.type === 'tool_use')
          : [];
        for (const block of toolBlocks) for (const id of taskRefsFromToolInput(block.input, tasks)) turnTasks.add(id);
        records.push({ event, sessionId, turnId, tasks: [...turnTasks] });
        turns.set(turnId, new Set(turnTasks));
      }
    } finally { lines.close(); stream.close(); }
    if (eligible && records.length) {
      const tx = this.db.transaction(() => {
        for (const record of records) {
          const event = record.event;
          const usage = event.message?.usage || {};
          const input = integer(usage.input_tokens); const output = integer(usage.output_tokens);
          const cacheCreation = integer(usage.cache_creation_input_tokens); const cacheRead = integer(usage.cache_read_input_tokens);
          const effective = input + output + cacheCreation * this.weights.cacheCreation + cacheRead * this.weights.cacheRead;
          const ts = typeof event.timestamp === 'string' ? event.timestamp : new Date().toISOString();
          const model = typeof event.message?.model === 'string' ? event.message.model : null;
          const messageId = String(event.message?.id || event.requestId || `${record.sessionId}:${offset}`);
          repo.addUsage({ sessionId: record.sessionId, messageId, ts, turnId: record.turnId, model, input, output, cacheCreation, cacheRead, effective, isSidechain: event.isSidechain ? 1 : 0 });
          if (event.quotaLimits) repo.setQuota({ status: String(event.quotaLimits.status || ''), resetsAt: numberOrNull(event.quotaLimits.resetsAt), rateLimitType: typeof event.quotaLimits.rateLimitType === 'string' ? event.quotaLimits.rateLimitType : null, isUsingOverage: event.quotaLimits.isUsingOverage === true, observedAt: ts });
        }
        for (const [id, refs] of turns) {
          const total = repo.turnTotal(sessionId, id).effective;
          repo.setTasks(sessionId, id, attributeTurn(total, [...refs]));
        }
        const totals = this.db.prepare('SELECT COUNT(*) messages, COALESCE(SUM(input),0) input, COALESCE(SUM(output),0) output, COALESCE(SUM(cacheCreation),0) creation, COALESCE(SUM(cacheRead),0) read, COALESCE(SUM(effective),0) effective, MIN(ts) firstAt, MAX(ts) lastAt FROM claude_usage WHERE sessionId=?').get(sessionId) as { messages:number; input:number; output:number; creation:number; read:number; effective:number; firstAt:string|null; lastAt:string|null };
        const last = records.at(-1)?.event;
        repo.upsert({ sessionId, cwd: String(last?.cwd || ''), firstAt: totals.firstAt, lastAt: totals.lastAt, model: typeof last?.message?.model === 'string' ? last.message.model : null, messages: totals.messages, inputTokens: totals.input, outputTokens: totals.output, cacheCreationTokens: totals.creation, cacheReadTokens: totals.read, effectiveTokens: totals.effective, isHubChat: this.isHubChat(sessionId) ? 1 : 0 });
      });
      tx();
      const quota = repo.quota();
      if (quota?.resetsAt && quota.resetsAt > Date.now() / 1000 && Date.parse(quota.observedAt) >= Date.now() - 10 * 60_000 && isClaudeQuotaLimited(quota.status || undefined)) this.options.failoverState?.activate(Math.ceil(quota.resetsAt - Date.now() / 1000), 'claude_usage_limit');
    }
    this.db.prepare('INSERT OR REPLACE INTO claude_scan_state (path,inode,size,offset,mtime,turnId,turnTasks,eligible) VALUES (?,?,?,?,?,?,?,?)').run(file, stat.ino, stat.size, offset, stat.mtimeMs, turnId, JSON.stringify([...turnTasks]), eligible ? 1 : 0);
  }
  private isHubChat(sessionId: string) { return !!this.db.prepare('SELECT 1 FROM chat_sessions WHERE claudeSessionId=?').get(sessionId); }
  private isAllowed(event: ClaudeTranscriptEvent, sessionId: string): boolean {
    if (this.isHubChat(sessionId)) return true;
    if (typeof event.cwd !== 'string' || event.cwd.length === 0) return false;
    const roots = [
      ...(this.options.include || []),
      this.options.hubHome,
      this.options.worktreesDir,
      ...(this.db.prepare('SELECT path FROM projects').all() as Array<{ path: string }>).map((project) => project.path),
    ].filter((root): root is string => typeof root === 'string' && root.length > 0);
    return roots.some((root) => isWithin(event.cwd!, root));
  }
}

function integer(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0; }
function numberOrNull(value: unknown) { return typeof value === 'number' && Number.isFinite(value) ? value : null; }
type ClaudeTranscriptEvent = {
  type?: string;
  sessionId?: string;
  cwd?: string;
  timestamp?: string;
  uuid?: string;
  requestId?: string;
  aiTitle?: string;
  isSidechain?: boolean;
  quotaLimits?: { status?: unknown; resetsAt?: unknown; rateLimitType?: unknown; isUsingOverage?: unknown };
  message?: { id?: unknown; model?: unknown; usage?: Record<string, unknown>; content?: unknown };
  content?: unknown;
};
function hasToolResult(event: ClaudeTranscriptEvent) { return JSON.stringify(event.message?.content || event.content || '').includes('tool_result'); }
function isRecord(value: unknown): value is Record<string, unknown> { return !!value && typeof value === 'object'; }
export function isClaudeQuotaLimited(status?: string): boolean {
  const normalized = status?.trim() || '';
  return normalized.length > 0 && (/^(rejected|limited|exhausted)$/i.test(normalized) || !/^allowed(?:$|[_-])/i.test(normalized));
}
function parseTaskState(value: string | undefined): string[] { try { const parsed = JSON.parse(value || '[]'); return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []; } catch { return []; } }
function isWithin(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}
function findTranscriptFiles(dir: string, maxAgeDays: number): string[] {
  const cutoff = Date.now() - maxAgeDays * 86_400_000; const files: string[] = [];
  let projects: string[]; try { projects = fs.readdirSync(dir); } catch { return files; }
  for (const project of projects) {
    const projectDir = path.join(dir, project); let entries: fs.Dirent[];
    try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) if (entry.isFile() && entry.name.endsWith('.jsonl')) { const file = path.join(projectDir, entry.name); try { if (fs.statSync(file).mtimeMs >= cutoff) files.push(file); } catch { /* raced */ } }
  }
  return files;
}
