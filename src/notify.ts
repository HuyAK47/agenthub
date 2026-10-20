import { execFile } from 'node:child_process';
import { AgentHubConfig } from './config.js';
import { EventBus } from './scheduler/index.js';
import { QuotaMarkRepo, TaskRepo } from './db/index.js';
import { toTaskId } from './services/index.js';

export type NotifyExecFn = (
  file: string,
  args: string[],
  callback?: (error: Error | null, stdout: string, stderr: string) => void,
) => unknown;

export interface NotificationServiceOptions {
  eventBus: EventBus;
  config: AgentHubConfig;
  taskRepo?: TaskRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  exec?: NotifyExecFn;
  now?: () => number;
}

export class NotificationService {
  private eventBus: EventBus;
  private config: AgentHubConfig;
  private taskRepo?: TaskRepo;
  private quotaMarkRepo?: QuotaMarkRepo;
  private execFn?: NotifyExecFn;
  private now: () => number;
  private lastSent = new Map<string, number>();
  private boundHandler: ((type: string, taskId?: string, payload?: unknown) => void) | null = null;

  constructor(opts: NotificationServiceOptions) {
    this.eventBus = opts.eventBus;
    this.config = opts.config;
    this.taskRepo = opts.taskRepo;
    this.quotaMarkRepo = opts.quotaMarkRepo;
    this.execFn = opts.exec;
    this.now = opts.now || (() => Date.now());
  }

  start(): void {
    if (this.boundHandler) return;
    this.boundHandler = (type: string, taskId?: string, payload?: unknown) => {
      this.handleEvent(type, taskId, payload);
    };
    this.eventBus.on('*', this.boundHandler);
  }

  stop(): void {
    if (this.boundHandler) {
      this.eventBus.off('*', this.boundHandler);
      this.boundHandler = null;
    }
  }

  handleEvent(type: string, taskId?: string, payload?: unknown): void {
    if (!this.config.notifications || this.config.notifications.desktop === false) {
      return;
    }

    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    switch (type) {
      case 'task.review_ready': {
        const title = this.resolveTaskTitle(taskId, p);
        let msg = `AgentHub: ${title} chờ review`;
        if ('checksPassed' in p) {
          msg += ` (${p.checksPassed ? '✓' : '✗'} checks)`;
        }
        this.notify(msg, 'normal');
        break;
      }

      case 'task.failed': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`AgentHub: ${title} thất bại`, 'critical');
        break;
      }

      case 'task.blocked': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`AgentHub: ${title} bị chặn`, 'normal');
        break;
      }

      case 'review.escalated': {
        const title = this.resolveTaskTitle(taskId, p);
        this.notify(`Cần người duyệt: ${title}`, 'normal');
        break;
      }

      case 'disk.low': {
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 0;
        this.notify(`Ổ đĩa còn ${freeGB} GB (< ${minFreeGB} GB): tạm dừng khởi chạy task`, 'normal');
        break;
      }

      case 'disk.ok': {
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        this.notify(`Ổ đĩa đã đủ chỗ (${freeGB} GB): tiếp tục chạy task`, 'normal');
        break;
      }

      case 'disk.docker_low': {
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 5;
        this.notify(`Ổ đĩa Docker còn ${freeGB} GB (< ${minFreeGB} GB): không chạy docker build/pull/compose up`, 'critical');
        break;
      }

      case 'quota.exhausted': {
        const name = (p.profile || p.worker || p.profileName || 'Hồ sơ') as string;
        const family = (p.family || p.model || '') as string;
        const resetTimeStr = this.resolveResetTime(p, name, family);
        const msg = resetTimeStr
          ? `Hồ sơ ${name} hết quota ${family} tới ${resetTimeStr}`
          : `Hồ sơ ${name} hết quota ${family}`;
        this.notify(msg, 'normal');
        break;
      }

      case 'profile.auth_expired': {
        const name = typeof p.name === 'string' ? p.name : 'tài khoản';
        this.notify(`Hồ sơ ${name} cần đăng nhập lại`, 'normal');
        break;
      }
    }
  }

  private resolveTaskTitle(taskId?: string, payload?: Record<string, unknown>): string {
    if (payload?.title && typeof payload.title === 'string') {
      return payload.title;
    }
    if (taskId) {
      const task = this.taskRepo?.get(taskId) || this.taskRepo?.get(toTaskId(taskId));
      if (task?.title) return task.title;
      return taskId;
    }
    return 'Task';
  }

  private resolveResetTime(p: Record<string, unknown>, profile: string, family: string): string {
    if (typeof p.time === 'string') return p.time;
    if (typeof p.untilStr === 'string') return p.untilStr;
    if (typeof p.until === 'string' && p.until.includes(':')) return p.until;

    let epochSec: number | undefined;
    if (typeof p.until === 'number') {
      epochSec = p.until > 1e11 ? Math.floor(p.until / 1000) : p.until;
    } else if (typeof p.resetAt === 'number') {
      epochSec = p.resetAt > 1e11 ? Math.floor(p.resetAt / 1000) : p.resetAt;
    } else if (typeof p.resetSeconds === 'number') {
      epochSec = Math.floor(this.now() / 1000) + p.resetSeconds;
    } else if (typeof p.duration === 'number') {
      epochSec = Math.floor(this.now() / 1000) + p.duration;
    } else if (this.quotaMarkRepo && profile && family) {
      const marks = this.quotaMarkRepo.getActive();
      const mark = marks.find((m) => m.profileName === profile && m.family === family);
      if (mark) epochSec = mark.until;
    }

    if (epochSec !== undefined) {
      const d = new Date(epochSec * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }

    return '';
  }

  private notify(message: string, urgency: 'normal' | 'critical' = 'normal'): void {
    const key = `${urgency}:${message}`;
    const now = this.now();
    const last = this.lastSent.get(key);
    if (last !== undefined && now - last < 30_000) {
      return;
    }
    this.lastSent.set(key, now);

    const args = urgency === 'critical'
      ? ['-u', 'critical', '-t', '10000', '-a', 'AgentHub', message]
      : ['-t', '10000', '-a', 'AgentHub', message];

    try {
      if (this.execFn) {
        const res = this.execFn('notify-send', args, () => {});
        if (res && typeof (res as Promise<unknown>).catch === 'function') {
          (res as Promise<unknown>).catch(() => {});
        }
      } else {
        execFile('notify-send', args, () => {});
      }
    } catch {
      // Ignore if notify-send is missing or fails
    }
  }
}
