import crypto from 'node:crypto';
import { ChatPermissionRepo, ChatPermissionRow, ChatSessionRepo } from '../db/index.js';
import { BrainPolicy } from '../brain/policy.js';

export type PermissionDecision = 'allow' | 'deny' | 'allow_always';

export interface PermissionRequestInput {
  sessionId: string;
  messageId?: string | null;
  toolName: string;
  input: Record<string, unknown>;
  kind?: 'brain' | 'user';
}

interface PendingRequest {
  row: ChatPermissionRow;
  resolve: (result: PermissionResult) => void;
  timer: NodeJS.Timeout;
}

export interface PermissionResult {
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  message?: string;
}

export type PermissionEvent = (request: ChatPermissionRow) => void;

export class PermissionBroker {
  private pending = new Map<string, PendingRequest>();
  private always = new Map<string, Set<string>>();

  constructor(
    private repo: ChatPermissionRepo,
    private timeoutSec = 600,
    private onRequest?: PermissionEvent,
    private brainPolicy?: BrainPolicy,
    private sessionRepo?: ChatSessionRepo,
  ) {}

  listPending(sessionId?: string): ChatPermissionRow[] {
    return this.repo.listPending(sessionId);
  }

  get(id: string): ChatPermissionRow | undefined {
    return this.repo.get(id);
  }

  getLatest(sessionId: string, messageId: string | null | undefined, toolName: string): ChatPermissionRow | undefined {
    return this.repo.getLatest(sessionId, messageId, toolName);
  }

  request(input: PermissionRequestInput): Promise<PermissionResult> {
    const sessionKind = this.sessionRepo?.get(input.sessionId)?.kind;
    if (sessionKind === 'brain' && this.brainPolicy) {
      const decision = this.brainPolicy.decide(input);
      if (decision) {
        const id = crypto.randomUUID();
        this.repo.insert({ id, sessionId: input.sessionId, messageId: input.messageId || null, toolName: input.toolName, input: JSON.stringify(input.input), status: 'pending' });
        this.repo.resolve(id, decision.action, decision.message, decision.reason);
        return Promise.resolve(decision.action === 'allow'
          ? { behavior: 'allow', updatedInput: input.input }
          : { behavior: 'deny', message: decision.message });
      }
    }
    const pattern = permissionPattern(input.input);
    const key = `${input.sessionId}:${input.toolName}`;
    if (pattern && this.always.get(key)?.has(pattern)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input.input });
    }

    const id = crypto.randomUUID();
    const row = this.repo.insert({
      id,
      sessionId: input.sessionId,
      messageId: input.messageId || null,
      toolName: input.toolName,
      input: JSON.stringify(input.input),
      status: 'pending',
    });
    this.onRequest?.(row);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.resolve(id, 'deny', 'Hết thời gian chờ cấp quyền');
      }, Math.max(1, this.timeoutSec) * 1000);
      this.pending.set(id, { row, resolve, timer });
    });
  }

  resolve(id: string, decision: PermissionDecision, message?: string): boolean {
    const pending = this.pending.get(id);
    const row = this.repo.get(id);
    if (!pending || !row || row.status !== 'pending') return false;
    clearTimeout(pending.timer);
    const result = this.repo.resolve(id, decision, message || null, 'user');
    this.pending.delete(id);
    if (decision === 'allow_always') {
      const pattern = permissionPattern(JSON.parse(row.input) as Record<string, unknown>);
      if (pattern) {
        const key = `${row.sessionId}:${row.toolName}`;
        const patterns = this.always.get(key) || new Set<string>();
        patterns.add(pattern);
        this.always.set(key, patterns);
      }
    }
    pending.resolve(decision === 'deny'
      ? { behavior: 'deny', message: message || 'Quyền công cụ bị từ chối' }
      : { behavior: 'allow', updatedInput: JSON.parse(row.input) as Record<string, unknown> });
    return Boolean(result);
  }

  stop(): void {
    for (const id of this.pending.keys()) this.resolve(id, 'deny', 'AgentHub đã dừng');
  }
}

export function permissionPattern(input: Record<string, unknown>): string | null {
  for (const key of ['command', 'file_path', 'path']) {
    if (typeof input[key] === 'string' && input[key]) return `${key}:${input[key]}`;
  }
  return null;
}
