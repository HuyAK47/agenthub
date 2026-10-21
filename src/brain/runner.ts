import crypto from 'node:crypto';
import type { BrainConfig } from '../config.js';
import { BrainTurnRepo, ChatSessionRepo } from '../db/index.js';
import type { ChatService } from '../chat/service.js';
import { EventBus } from '../scheduler/index.js';

const EVENT_TYPES = new Set([
  'task.review_ready', 'task.failed', 'task.blocked', 'task.done',
  'batch.created', 'batch.dispatched', 'merge.failed', 'merge.conflict',
  'quota.exhausted', 'claude.quota_exhausted', 'disk.low', 'load.high',
]);

export interface BrainRunnerOptions {
  config: BrainConfig;
  eventBus: EventBus;
  chatService: Pick<ChatService, 'getOrCreateSession' | 'sendMessage'>;
  chatSessionRepo: ChatSessionRepo;
  turnRepo: BrainTurnRepo;
  debounceMs?: number;
  now?: () => number;
}

export interface BrainQueuedEvent {
  type: string;
  taskId?: string;
  payload?: unknown;
}

/** Keeps the one resident Claude session fed without overlapping turns. */
export class BrainRunner {
  readonly sessionId = 'brain';
  private readonly debounceMs: number;
  private readonly now: () => number;
  private pending: BrainQueuedEvent[] = [];
  private timer?: NodeJS.Timeout;
  private activeTurn = false;
  private activeTurnId?: string;
  private activeEvents: BrainQueuedEvent[] = [];
  private started = false;
  private bound = (type: string, taskId?: string, payload?: unknown) => this.onEvent(type, taskId, payload);

  constructor(private readonly opts: BrainRunnerOptions) {
    this.debounceMs = opts.debounceMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    this.ensureSession();
    this.opts.eventBus.on('*', this.bound);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.opts.eventBus.off('*', this.bound);
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  getQueuedEvents(): BrainQueuedEvent[] {
    return [...this.pending];
  }

  /** Exposed for deterministic tests and for a daemon wake-up after a user turn. */
  flush(): void {
    if (!this.started || this.opts.config.mode === 'off' || this.activeTurn || this.pending.length === 0) return;
    const session = this.ensureSession();
    if (session.busy === 1 || session.state === 'running' || session.state === 'waiting_limit') return;

    const now = this.now();
    if (this.opts.turnRepo.countSince(now - 60 * 60 * 1000) >= this.opts.config.maxTurnsPerHour) {
      this.opts.eventBus.emit('brain.limited', undefined, { reason: 'maxTurnsPerHour' });
      return;
    }
    const startOfDay = new Date(now);
    startOfDay.setHours(0, 0, 0, 0);
    if (this.opts.config.dailyTokenBudget > 0 && this.opts.turnRepo.tokensSince(startOfDay.toISOString()) >= this.opts.config.dailyTokenBudget) {
      this.opts.eventBus.emit('brain.limited', undefined, { reason: 'dailyTokenBudget' });
      return;
    }

    const events = this.pending.splice(0, this.pending.length);
    const input = this.formatEvents(events);
    const turn = this.opts.turnRepo.insert({ id: crypto.randomUUID(), trigger: 'event', input });
    this.activeTurn = true;
    this.activeTurnId = turn.id;
    this.activeEvents = events;
    try {
      this.opts.chatService.sendMessage(this.sessionId, input);
    } catch (error) {
      this.activeTurn = false;
      this.activeTurnId = undefined;
      this.activeEvents = [];
      this.pending.unshift(...events);
      this.opts.turnRepo.finish(turn.id, { status: 'failed', error: error instanceof Error ? error.message : String(error) });
      this.schedule();
    }
  }

  private ensureSession() {
    const existing = this.opts.chatSessionRepo.getByKind('brain');
    if (existing) return existing;
    const legacy = this.opts.chatSessionRepo.get(this.sessionId);
    if (legacy) {
      this.opts.chatSessionRepo.updateKind(this.sessionId, 'brain');
      this.opts.chatSessionRepo.updateTitle(this.sessionId, 'Bộ não');
      this.opts.chatSessionRepo.updateModel(this.sessionId, this.opts.config.model);
      this.opts.chatSessionRepo.updateProfileName(this.sessionId, this.opts.config.claudeProfile);
      this.opts.chatSessionRepo.updatePinned(this.sessionId, 1);
      return this.opts.chatSessionRepo.get(this.sessionId)!;
    }
    this.opts.chatService.getOrCreateSession(this.sessionId, {
      title: 'Bộ não',
      mode: 'safe',
      model: this.opts.config.model,
      profileName: this.opts.config.claudeProfile,
      kind: 'brain',
    });
    this.opts.chatSessionRepo.updatePinned(this.sessionId, 1);
    return this.opts.chatSessionRepo.get(this.sessionId)!;
  }

  private onEvent(type: string, taskId?: string, payload?: unknown): void {
    if (!this.started || this.opts.config.mode === 'off') return;
    if (type === 'chat.message') {
      const data = this.asRecord(payload);
      if (data.sessionId === this.sessionId && data.role === 'user') {
        this.activeTurn = true;
      }
      return;
    }
    if (type === 'chat.done' || type === 'chat.error') {
      const data = this.asRecord(payload);
      if (data.sessionId !== this.sessionId) return;
      if (type === 'chat.error' && this.isQuota(data.message)) {
        this.activeTurn = false;
        if (this.activeTurnId) this.opts.turnRepo.finish(this.activeTurnId, { status: 'quota', error: String(data.message || 'quota') });
        this.activeTurnId = undefined;
        this.pending.unshift(...this.activeEvents);
        this.activeEvents = [];
        this.opts.eventBus.emit('brain.waiting', undefined, { reason: 'quota' });
        this.schedule();
      } else if (type === 'chat.done') {
        this.activeTurn = false;
        const usage = this.asRecord(data.usage);
        if (this.activeTurnId) this.opts.turnRepo.finish(this.activeTurnId, {
          status: 'done',
          summary: typeof data.message === 'string' ? data.message : undefined,
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0,
        });
        this.activeTurnId = undefined;
        this.activeEvents = [];
        this.schedule();
      }
      return;
    }
    if (!EVENT_TYPES.has(type)) return;
    this.pending.push({ type, taskId, payload });
    this.schedule();
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, this.debounceMs);
    this.timer.unref?.();
  }

  private formatEvents(events: BrainQueuedEvent[]): string {
    const lines = events.map((event) => {
      const payload = this.asRecord(event.payload);
      const detail = Object.keys(payload).length ? ` ${JSON.stringify(payload)}` : '';
      return `- ${event.type}${event.taskId ? ` (${event.taskId})` : ''}${detail}`;
    });
    const policy = this.opts.config.mode === 'suggest'
      ? 'Chế độ suggest: chỉ đề xuất, không tự gọi hub_review hoặc merge; chờ người dùng duyệt.'
      : 'Chế độ auto: làm theo BRAIN-PLAYBOOK khi an toàn.';
    return `Sự kiện: ${lines.join('\n')}\n${policy}`;
  }

  private asRecord(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' ? value as Record<string, unknown> : {};
  }

  private isQuota(value: unknown): boolean {
    return typeof value === 'string' && /(quota|rate.?limit|429|usage limit|limit reached)/i.test(value);
  }
}
