const PROGRESS_EVENT_RE = /^(?:task\.(?:queued|running|started|resumed|done|cancelled|failed|blocked)|run\.|load\.|ci\.)/;

export interface NotificationDedupeOptions {
  windowMs?: number;
  now?: () => number;
}

/** In-memory event deduplication shared by desktop and Telegram notification paths. */
export class NotificationDeduper {
  private readonly seen = new Map<string, number>();
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(options: NotificationDedupeOptions = {}) {
    this.windowMs = options.windowMs ?? 30 * 60 * 1000;
    this.now = options.now ?? (() => Date.now());
  }

  shouldSend(type: string, taskId?: string, payload?: unknown): boolean {
    if (!taskId || PROGRESS_EVENT_RE.test(type)) return true;
    if (type === 'task.review_ready' && payload && typeof payload === 'object' && 'checksPassed' in payload) return true;
    const key = `${type}:${taskId}`;
    const now = this.now();
    const previous = this.seen.get(key);
    if (previous !== undefined && now - previous < this.windowMs) return false;
    this.seen.set(key, now);
    if (this.seen.size > 1000) {
      for (const [entry, timestamp] of this.seen) {
        if (now - timestamp >= this.windowMs) this.seen.delete(entry);
      }
    }
    return true;
  }
}
