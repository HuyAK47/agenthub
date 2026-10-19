import fs from 'node:fs';
import path from 'node:path';

export interface ClaudeFailoverSnapshot {
  active: boolean;
  until: number | null;
  reason: string | null;
  activatedAt: number | null;
  evidence?: {
    file: string;
    line: number;
    observedAt: string;
  } | null;
  lastActivityAt?: string | null;
}

export interface ClaudeFailoverEvidence {
  file: string;
  line: number;
  observedAt: string;
}

type Clock = () => number;

/** Small durable state file; it contains no prompt, token, or credential. */
export class ClaudeFailoverState {
  private state: ClaudeFailoverSnapshot;
  private readonly now: Clock;

  constructor(private readonly filePath: string, now: Clock = () => Math.floor(Date.now() / 1000)) {
    this.now = now;
    this.state = { active: false, until: null, reason: null, activatedAt: null, evidence: null, lastActivityAt: null };
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<ClaudeFailoverSnapshot>;
      if (parsed.active && typeof parsed.until === 'number' && parsed.until > this.now()) {
        this.state = {
          active: true,
          until: parsed.until,
          reason: typeof parsed.reason === 'string' ? parsed.reason : 'usage_limit',
          activatedAt: typeof parsed.activatedAt === 'number' ? parsed.activatedAt : null,
          evidence: parsed.evidence && typeof parsed.evidence === 'object' ? parsed.evidence : null,
          lastActivityAt: typeof parsed.lastActivityAt === 'string' ? parsed.lastActivityAt : null,
        };
      }
    } catch {
      // A missing or invalid state is equivalent to Claude being available.
    }
  }

  snapshot(): ClaudeFailoverSnapshot {
    if (this.state.active && this.state.until !== null && this.state.until <= this.now()) {
      this.clear();
    }
    return { ...this.state };
  }

  activate(resetSeconds: number, reason = 'usage_limit', evidence?: ClaudeFailoverEvidence): ClaudeFailoverSnapshot {
    const now = this.now();
    this.state = { active: true, until: now + Math.max(60, resetSeconds), reason, activatedAt: now, evidence: evidence || null, lastActivityAt: null };
    this.persist();
    return this.snapshot();
  }

  noteActivity(at: string | Date = new Date()): boolean {
    const activity = at instanceof Date ? at : new Date(at);
    if (Number.isNaN(activity.getTime())) return false;
    const iso = activity.toISOString();
    this.state.lastActivityAt = iso;
    if (!this.state.active || this.state.activatedAt === null || activity.getTime() / 1000 <= this.state.activatedAt) {
      this.persist();
      return false;
    }
    this.clear();
    return true;
  }

  clear(): void {
    this.state = { active: false, until: null, reason: null, activatedAt: null, evidence: null, lastActivityAt: this.state.lastActivityAt || null };
    try { fs.unlinkSync(this.filePath); } catch { /* already absent */ }
  }

  private persist(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(this.filePath, JSON.stringify(this.state), { encoding: 'utf8', mode: 0o600 });
  }
}
