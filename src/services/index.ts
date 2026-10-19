import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { z, ZodError } from 'zod';
import { AgentHubConfig, saveConfig, updateConfigInMemory } from '../config.js';
import {
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  ReviewRepo,
  EventRepo,
  ProjectRow,
  ProfileRow,
  TaskRow,
  QuotaMarkRow,
} from '../db/index.js';
import { ProfileService as CoreProfileService, isProfileLoggedIn } from '../profiles/index.js';
import { Scheduler } from '../scheduler/index.js';
import { CodexEngine } from '../engines/index.js';
import { QuotaUsageService } from '../quota/usage.js';
import { ProfileLockService } from '../profiles/locks.js';
import { CheckRunner } from '../checks.js';
import { BrainService } from '../brain.js';
import { toApiTime } from '../db/time.js';
import { ChatService } from '../chat/service.js';
import { getDiskSpaceSync } from '../disk.js';
import { WorktreeService } from '../worktrees/index.js';
import { parseAuthState } from '../profiles/auth.js';
import { SavingsService } from '../savings.js';
import { ClaudeSessionRepo } from '../claude-sessions/repo.js';
import { isClaudeQuotaLimited } from '../claude-sessions/scanner.js';
import { ClaudeSessionScanner } from '../claude-sessions/scanner.js';
import { findClaudeBin, getClaudeVersion } from '../chat/claude.js';
import { listAllWorktreeProcesses, reapSyncForWorktree } from '../reaper.js';

const execFileAsync = promisify(execFile);

function apiProject(project: ProjectRow): ProjectRow {
  return { ...project, createdAt: toApiTime(project.createdAt)! };
}

function apiProfile(profile: ProfileRow): ProfileRow {
  return {
    ...profile,
    createdAt: toApiTime(profile.createdAt)!,
    authState: profile.authState ?? null,
    authMessage: profile.authMessage ?? null,
    verifyUrl: profile.verifyUrl ?? null,
  };
}

function apiTask(task: TaskRow): TaskRow {
  return {
    ...task,
    waitReason: task.waitReason ?? null,
    createdAt: toApiTime(task.createdAt)!,
    updatedAt: toApiTime(task.updatedAt)!,
  };
}

function apiRun<T extends { startedAt: string; endedAt: string | null }>(run: T): T {
  return { ...run, startedAt: toApiTime(run.startedAt)!, endedAt: toApiTime(run.endedAt) };
}

function apiReview<T extends { createdAt: string }>(review: T): T {
  return { ...review, createdAt: toApiTime(review.createdAt)! };
}

export const VALID_AGY_MODELS = new Set([
  'gemini-3.8-flash-high',
  'gemini-3.8-flash-medium',
  'gemini-3.8-flash-low',
  'claude-sonnet-4-6',
  'claude-opus-4-6-thinking',
  'gpt-oss-120b-medium',
]);

export const modelValidator = z.string().refine(
  (m) => (m.startsWith('codex:') && m.length > 6) || VALID_AGY_MODELS.has(m),
  { message: 'Mỗi model phải là id agy hợp lệ hoặc có tiền tố codex:' },
);

export const CreateProjectSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().default('main'),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().default(3),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().optional(),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
});

export const CreateTaskSchema = z.object({
  project: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  dependsOn: z.array(z.string()).optional(),
  baseRef: z.string().optional(),
  branch: z.string().optional(),
  modelChain: z.array(modelValidator).optional(),
  start: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  modelChain: z.array(modelValidator).nullable().optional(),
  dependsOn: z.array(z.string()).optional(),
  level: z.enum(['easy', 'hard']).optional(),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  appendBody: z.string().optional(),
});

export const ReviewTaskSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']),
  feedback: z.string().optional(),
  by: z.string().optional(),
}).refine(
  (d) => d.verdict !== 'changes_requested' || (typeof d.feedback === 'string' && d.feedback.trim().length > 0),
  { message: 'Feedback là bắt buộc khi changes_requested' },
);

export const RetryTaskSchema = z.object({
  note: z.string().optional(),
});

export const CreateProfileSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
});

export const UpdateProfileSchema = z.object({
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]),
});

export const MarkQuotaSchema = z.object({
  family: z.string().min(1),
  seconds: z.number().int().positive().optional(),
  reason: z.string().optional(),
});

export const UpdateConfigSchema = z.object({
  modelChainHard: z.array(modelValidator).min(1).optional(),
  modelChainEasy: z.array(modelValidator).min(1).optional(),
  defaultTimeout: z.number().int().positive().optional(),
  slotsPerAgyProfile: z.number().int().positive().optional(),
  slotsPerCodexProfile: z.number().int().positive().optional(),
  watchdog: z.object({
    stallMinutes: z.number().positive().optional(),
    waitingMinutes: z.number().positive().optional(),
  }).optional(),
  autoFixOnFail: z.boolean().optional(),
  chat: z
    .object({
      claudeBin: z.string().optional(),
      disableToolSearch: z.boolean().optional(),
      allowFullMode: z.boolean().optional(),
      maxConcurrent: z.number().int().positive().optional(),
      idleTimeoutSec: z.number().int().positive().optional(),
      model: z.enum(['', 'sonnet', 'haiku']).optional(),
    })
    .optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: modelValidator.optional(),
    timeoutSec: z.number().int().positive().optional(),
    failoverSec: z.number().int().positive().optional(),
    maxChangesRequested: z.number().int().positive().optional(),
  }).optional(),
  notifications: z.object({
    desktop: z.boolean(),
  }).optional(),
  savings: z
    .object({
      bucketTokens: z
        .object({
          gemini: z.number().positive().optional(),
          claude: z.number().positive().optional(),
        })
        .optional(),
      claudeFactor: z.number().positive().optional(),
      claudeOverheadPerTask: z.number().nonnegative().optional(),
    })
    .optional(),
});

export function toTaskId(idOrParam: string): string {
  return idOrParam.includes('~') ? idOrParam.replace('~', '/') : idOrParam;
}

export function toRouteId(taskId: string): string {
  return taskId.replace('/', '~');
}

export function readLogTail(filePath: string, tailKB = 512): string {
  if (!fs.existsSync(filePath)) return '';
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const stat = fs.fstatSync(fd);
      const maxBytes = Math.min(Math.max(1, tailKB), 512) * 1024;
      const bytesToRead = Math.min(stat.size, maxBytes);
      const buffer = Buffer.alloc(bytesToRead);
      fs.readSync(fd, buffer, 0, bytesToRead, stat.size - bytesToRead);
      return buffer.toString('utf-8');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return '';
  }
}

export async function getGitCommits(
  repoPath: string,
  baseRef: string,
  branch: string,
): Promise<string[]> {
  if (!fs.existsSync(repoPath) || !baseRef || !branch) return [];
  try {
    const { stdout } = await execFileAsync('git', ['log', '--oneline', `${baseRef}..${branch}`], {
      cwd: repoPath,
    });
    return stdout.trim().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

export class HttpError extends Error {
  constructor(public statusCode: number, public error: string, message: string) {
    super(message);
    this.name = 'HttpError';
  }
}

export function formatEventSummary(
  type: string,
  payload: unknown,
  taskId?: string | null,
  activeMarks?: QuotaMarkRow[],
): string {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;
  const taskLabel = taskId
    ? (taskId.includes('/') ? taskId.split('/')[1] : taskId.includes('~') ? taskId.split('~')[1] : taskId)
    : 'Task';

  switch (type) {
    case 'task.updated':
      return `${taskLabel} đã được cập nhật`;

    case 'task.review_ready':
    case 'task.review':
      return `${taskLabel} chuyển sang chờ review`;

    case 'review.escalated':
      return `${taskLabel} chờ người xử lý escalation reviewer`;

    case 'task.checking':
      return `${taskLabel} đang kiểm tra`;

    case 'task.queued': {
      const reason = p.reason;
      if (reason === 'quota_retry') {
        return `${taskLabel} được đưa vào hàng đợi (thử lại do hết quota)`;
      }
      if (reason === 'transient_retry') {
        return `${taskLabel} được đưa vào hàng đợi (thử lại sau lỗi tạm thời)`;
      }
      if (reason === 'changes_requested') {
        return `${taskLabel} được đưa vào hàng đợi (yêu cầu sửa đổi)`;
      }
      if (reason === 'retry') {
        return `${taskLabel} được đưa vào hàng đợi để thử lại`;
      }
      return `${taskLabel} được đưa vào hàng đợi`;
    }

    case 'task.running':
    case 'task.started': {
      const model = p.model as string | undefined;
      const worker = (p.profile || p.worker) as string | undefined;
      if (model && worker) {
        return `${taskLabel} đang chạy (${model}@${worker})`;
      }
      return `${taskLabel} bắt đầu chạy`;
    }

    case 'task.blocked':
      return `${taskLabel} bị chặn`;

    case 'task.failed':
      return `${taskLabel} thất bại`;

    case 'task.done':
      return `${taskLabel} hoàn thành`;

    case 'task.cancelled':
      return `${taskLabel} đã bị hủy`;

    case 'task.timeout':
      return `${taskLabel} hết thời gian chạy`;

    case 'task.waiting_quota': {
      const reason = p && (p as Record<string, unknown>).reason;
      if (reason === 'disk') {
        return `${taskLabel} chờ dung lượng ổ đĩa`;
      }
      if (reason === 'parallel') {
        return `${taskLabel} chờ slot song song`;
      }
      if (reason === 'profile_busy') {
        return `${taskLabel} chờ tài khoản rảnh`;
      }
      return `${taskLabel} chờ quota khả dụng`;
    }

    case 'disk.low': {
      const free = p && (p as Record<string, unknown>).freeGB !== undefined ? `${(p as Record<string, unknown>).freeGB}GB` : '';
      return free ? `Ổ đĩa gần đầy (còn ${free})` : 'Ổ đĩa gần đầy';
    }

    case 'run.crashed':
      return `${taskLabel} bị dừng đột ngột`;

    case 'run.stalled':
      return `${taskLabel} bị kẹt khi chờ tác vụ nền`;

    case 'quota.exhausted':
    case 'quota.marked': {
      const profile = (p.profile || p.worker || 'Hồ sơ') as string;
      const family = (p.family || p.model || '') as string;

      let resetTimeStr = '';
      if (typeof p.time === 'string') {
        resetTimeStr = p.time;
      } else if (typeof p.untilStr === 'string') {
        resetTimeStr = p.untilStr;
      } else if (typeof p.until === 'string' && p.until.includes(':')) {
        resetTimeStr = p.until;
      } else {
        let epochSec: number | undefined;
        if (typeof p.until === 'number') {
          epochSec = p.until > 1e11 ? Math.floor(p.until / 1000) : p.until;
        } else if (typeof p.resetAt === 'number') {
          epochSec = p.resetAt > 1e11 ? Math.floor(p.resetAt / 1000) : p.resetAt;
        } else if (typeof p.resetSeconds === 'number') {
          epochSec = Math.floor(Date.now() / 1000) + p.resetSeconds;
        } else if (typeof p.duration === 'number') {
          epochSec = Math.floor(Date.now() / 1000) + p.duration;
        } else if (activeMarks && profile && family) {
          const mark = activeMarks.find((m) => m.profileName === profile && m.family === family);
          if (mark) {
            epochSec = mark.until;
          }
        }

        if (epochSec !== undefined) {
          const d = new Date(epochSec * 1000);
          const hh = String(d.getHours()).padStart(2, '0');
          const mm = String(d.getMinutes()).padStart(2, '0');
          resetTimeStr = `${hh}:${mm}`;
        }
      }

      if (family && resetTimeStr) {
        return `${profile} hết quota ${family} tới ${resetTimeStr}`;
      }
      if (resetTimeStr) {
        return `${profile} hết quota tới ${resetTimeStr}`;
      }
      if (family) {
        return `${profile} hết quota ${family}`;
      }
      return `${profile} hết quota`;
    }

    case 'quota.cleared': {
      const profile = (p.profile || 'Hồ sơ') as string;
      const family = p.family ? ` ${p.family}` : '';
      return `${profile} đã được xóa đánh dấu quota${family}`;
    }

    case 'profile.created': {
      const name = (p.name || '') as string;
      return name ? `Tạo mới hồ sơ ${name}` : 'Tạo mới hồ sơ';
    }

    case 'profile.updated': {
      const name = (p.name || p.profile || '') as string;
      return name ? `Cập nhật hồ sơ ${name}` : 'Cập nhật hồ sơ';
    }

    case 'config.updated':
      return 'Cập nhật cấu hình hệ thống';

    default:
      if (taskId) {
        return `${taskLabel}: ${type}`;
      }
      return type;
  }
}

export class AppService {
  private profileChecks = new Set<string>();
  constructor(
    public config: AgentHubConfig,
    public projectRepo: ProjectRepo,
    public profileRepo: ProfileRepo,
    public quotaMarkRepo: QuotaMarkRepo,
    public taskRepo: TaskRepo,
    public runRepo: RunRepo,
    public reviewRepo: ReviewRepo,
    public eventRepo: EventRepo,
    public coreProfileService: CoreProfileService,
    public scheduler: Scheduler,
    public usageService: QuotaUsageService,
    public lockService: ProfileLockService,
    public brainService?: BrainService,
    public chatService?: ChatService,
    public savingsService?: SavingsService,
    public claudeSessionRepo?: ClaudeSessionRepo,
    public claudeScanner?: ClaudeSessionScanner,
  ) {}

  listClaudeSessions(activeWithinMin = 5) {
    if (!this.claudeSessionRepo) return [];
    const cutoff = Date.now() - activeWithinMin * 60_000;
    return this.claudeSessionRepo.list().map((session) => ({ ...session, active: !!session.lastAt && Date.parse(session.lastAt) >= cutoff, topTasks: this.claudeSessionRepo!.topTasks(session.sessionId) }));
  }
  getClaudeSession(id: string) {
    if (!this.claudeSessionRepo) throw new HttpError(500, 'internal_error', 'Claude session service chưa sẵn sàng');
    const session = this.claudeSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Claude session "${id}" không tồn tại`);
    const db = this.scheduler.getDatabase();
    if (!db) throw new HttpError(500, 'internal_error', 'Database chưa sẵn sàng');
    const turns = db.prepare(`SELECT turnId, MIN(ts) ts, SUM(input) input, SUM(output) output, SUM(cacheCreation) cacheCreation, SUM(cacheRead) cacheRead, SUM(effective) effectiveTokens FROM claude_usage WHERE sessionId=? GROUP BY turnId ORDER BY ts`).all(id) as Array<{ turnId: string; ts: string; input: number; output: number; cacheCreation: number; cacheRead: number; effectiveTokens: number }>;
    return { ...session, turns: turns.map((turn) => ({ ...turn, tasks: db.prepare('SELECT taskId,effectiveTokens FROM claude_task_usage WHERE sessionId=? AND turnId=?').all(id, turn.turnId) })) };
  }
  async rescanClaudeSessions() { await this.claudeScanner?.scan(); return { ok: true }; }
  getClaudeQuota() { const quota = this.claudeSessionRepo?.quota() || { status: null, resetsAt: null, rateLimitType: null, observedAt: null }; return { ...quota, limited: isClaudeQuotaLimited(quota.status || undefined) }; }
  getClaudeToday() {
    const db = this.scheduler.getDatabase();
    if (!db) return { effectiveTokens: 0, sessions: 0, tasks: [] as Array<{ taskId: string; effectiveTokens: number }> };
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const sessions = db.prepare('SELECT DISTINCT sessionId FROM claude_usage WHERE ts >= ?').all(since.toISOString()) as Array<{ sessionId: string }>;
    const tasks = db.prepare('SELECT ctu.taskId, SUM(ctu.effectiveTokens) effectiveTokens FROM claude_task_usage ctu JOIN (SELECT DISTINCT sessionId,turnId FROM claude_usage WHERE ts >= ?) cu ON cu.sessionId=ctu.sessionId AND cu.turnId=ctu.turnId GROUP BY ctu.taskId ORDER BY effectiveTokens DESC LIMIT 5').all(since.toISOString()) as Array<{ taskId: string; effectiveTokens: number }>;
    const total = db.prepare('SELECT COALESCE(SUM(effective),0) effectiveTokens FROM claude_usage WHERE ts >= ?').get(since.toISOString()) as { effectiveTokens: number };
    return { effectiveTokens: total.effectiveTokens, sessions: sessions.length, tasks };
  }

  // --- Savings ---
  getSavings(query?: { project?: string; since?: string }) {
    if (!this.savingsService) {
      throw new HttpError(500, 'internal_error', 'SavingsService chưa được khởi tạo');
    }
    return this.savingsService.getSavings(query);
  }

  // --- Status ---
  getStatus() {
    const tasks = this.taskRepo.getAll();
    const profiles = this.profileRepo.getAll();
    const quotaMarks = this.quotaMarkRepo.getActive();
    const dupes = this.coreProfileService.getDuplicateEmails();
    const runningMap = this.scheduler.getRunning();
    const projects = this.projectRepo.getAll();

    const byStatus: Record<string, number> = {
      running: 0,
      checking: 0,
      review: 0,
      waiting_quota: 0,
      failed: 0,
      queued: 0,
      draft: 0,
      done: 0,
      blocked: 0,
      cancelled: 0,
    };

    const tasksByProject: Record<string, Record<string, number>> = {};
    for (const p of projects) {
      tasksByProject[p.id] = {
        draft: 0,
        queued: 0,
        running: 0,
        checking: 0,
        review: 0,
        done: 0,
        blocked: 0,
        failed: 0,
        cancelled: 0,
        waiting_quota: 0,
      };
    }

    for (const t of tasks) {
      byStatus[t.status] = (byStatus[t.status] || 0) + 1;
      if (!tasksByProject[t.projectId]) {
        tasksByProject[t.projectId] = {
          draft: 0,
          queued: 0,
          running: 0,
          checking: 0,
          review: 0,
          done: 0,
          blocked: 0,
          failed: 0,
          cancelled: 0,
          waiting_quota: 0,
        };
      }
      tasksByProject[t.projectId][t.status] = (tasksByProject[t.projectId][t.status] || 0) + 1;
    }

    const taskMap = new Map(tasks.map((t) => [t.id, t]));

    const runningTasks = Array.from(runningMap.values()).map((r) => {
      const task = taskMap.get(r.taskId) || taskMap.get(toTaskId(r.taskId)) || taskMap.get(r.taskId.replace('/', '~'));
      return {
        taskId: r.taskId,
        runId: r.runId,
        profileName: r.profileName,
        model: r.model,
        engine: r.engine.id,
        startedAt: new Date(r.startTime).toISOString(),
        elapsedMs: Date.now() - r.startTime,
        lastActivityAt: new Date(r.lastActivityAt).toISOString(),
        activitySource: r.activitySource,
        title: task?.title ?? '',
        projectId: task?.projectId ?? (r.projectId || (r.taskId.includes('/') ? r.taskId.split('/')[0] : '')),
        slug: task?.slug ?? (r.taskId.includes('/') ? r.taskId.slice(r.taskId.indexOf('/') + 1) : r.taskId),
        worktreePath: task?.worktreePath ?? null,
      };
    });

    const profilesStatus = profiles.map((p) => {
      const marks = quotaMarks.filter((m) => m.profileName === p.name);
      const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === p.name);
      const slots = this.lockService.getSlotsSync(p);
      return {
        ...apiProfile(p),
        quotaMarks: marks,
        slotsUsed: Math.max(slots.slotsUsed, isBusy ? 1 : 0),
        slotsTotal: slots.slotsTotal,
        busy: slots.busy || isBusy,
        usage: this.usageService.getForProfile(p.name),
        duplicateWarning: p.email ? dupes.has(p.email) : false,
      };
    });

    const recentRows = this.eventRepo.getRecent(30);
    const recentEvents = recentRows.map((e) => {
      let parsedPayload: unknown = null;
      if (e.payload) {
        try {
          parsedPayload = JSON.parse(e.payload);
        } catch {
          parsedPayload = e.payload;
        }
      }
      return {
        id: e.id,
        ts: toApiTime(e.ts)!,
        type: e.type,
        taskId: e.taskId,
        summary: formatEventSummary(e.type, parsedPayload, e.taskId, quotaMarks),
      };
    });

    const disk = getDiskSpaceSync(this.config.worktreesDir);

    return {
      tasks: byStatus,
      tasksByProject,
      profiles: profilesStatus,
      running: runningTasks,
      claudeFailover: this.chatService?.getClaudeFailover(),
      codexReviewer: this.scheduler.getReviewerStatus(),
      recentEvents,
      brain: this.brainService?.getStatus(),
      disk: {
        freeGB: disk.freeGB,
        totalGB: disk.totalGB,
        minFreeGB: this.config.disk.minFreeGB,
      },
    };
  }

  getOrphans() {
    const tasks = this.taskRepo.getAll();
    const running = new Set(this.scheduler.getRunning().keys());
    const projects = this.projectRepo.getAll();
    const protectedPaths = [this.config.hubHome, ...projects.map((project) => project.path)];
    const processes = listAllWorktreeProcesses({ worktreesDir: this.config.worktreesDir, protectedPaths });
    return processes
      .map((process) => {
        const cwd = process.cwd.replace(/ \(deleted\)$/, '');
        const task = tasks.find((candidate) => candidate.worktreePath && (cwd === candidate.worktreePath || cwd.startsWith(candidate.worktreePath + path.sep)));
        return { ...process, task: task ? { id: task.id, title: task.title, status: task.status } : null, active: task ? running.has(task.id) : false };
      })
      .filter((process) => !process.active);
  }

  reapOrphans() {
    const orphans = this.getOrphans();
    const projects = this.projectRepo.getAll();
    const protectedPaths = [this.config.hubHome, ...projects.map((project) => project.path)];
    const reaped: number[] = [];
    for (const orphan of orphans) {
      reaped.push(...reapSyncForWorktree(orphan.cwd.replace(/ \(deleted\)$/, ''), {
        worktreesDir: this.config.worktreesDir,
        protectedPaths,
      }));
    }
    return { ok: true, reaped: [...new Set(reaped)] };
  }

  // --- Projects ---
  listProjects(): ProjectRow[] {
    return this.projectRepo.getAll().map(apiProject);
  }

  getProject(id: string): ProjectRow {
    const proj = this.projectRepo.get(id);
    if (!proj) {
      throw new HttpError(404, 'not_found', `Project "${id}" không tồn tại`);
    }
    return apiProject(proj);
  }

  createProject(raw: unknown): ProjectRow {
    const parsed = CreateProjectSchema.parse(raw);
    const id = parsed.id || parsed.name.toLowerCase().replace(/[^a-z0-9_-]/g, '-');
    if (this.projectRepo.get(id)) {
      throw new HttpError(409, 'conflict', `Project ID "${id}" đã tồn tại`);
    }

    const resolvedPath = path.resolve(parsed.path);
    if (!fs.existsSync(resolvedPath)) {
      throw new HttpError(400, 'bad_request', `Thư mục repo không tồn tại: ${resolvedPath}`);
    }

    this.projectRepo.insert({
      id,
      name: parsed.name,
      path: resolvedPath,
      defaultBranch: parsed.defaultBranch,
      envTemplate: parsed.envTemplate || null,
      maxParallel: parsed.maxParallel,
      checks: parsed.checks ? JSON.stringify(parsed.checks) : null,
    });

    this.invalidateOutOfScopeClaudeScanStates();
    return this.getProject(id);
  }

  updateProject(id: string, raw: unknown): ProjectRow {
    this.getProject(id);
    const parsed = UpdateProjectSchema.parse(raw);
    this.projectRepo.update(id, { ...parsed, checks: parsed.checks === undefined ? undefined : parsed.checks ? JSON.stringify(parsed.checks) : null });
    this.invalidateOutOfScopeClaudeScanStates();
    return this.getProject(id);
  }

  deleteProject(id: string): { ok: boolean } {
    this.getProject(id);

    // Check if any task in this project is currently running
    const runningMap = this.scheduler.getRunning();
    const hasRunningTask = Array.from(runningMap.values()).some((r) => r.projectId === id);
    if (hasRunningTask) {
      throw new HttpError(409, 'conflict', `Không thể xóa project khi còn task đang chạy`);
    }

    this.projectRepo.delete(id);
    this.invalidateOutOfScopeClaudeScanStates();
    return { ok: true };
  }

  private invalidateOutOfScopeClaudeScanStates() {
    try { this.scheduler.getDatabase()?.prepare('DELETE FROM claude_scan_state WHERE eligible=0').run(); } catch { /* migration may not exist yet */ }
  }

  private emailCheckCache = new Map<string, number>();

  refreshProfileEmail(name: string): string | null {
    let profile: ProfileRow | undefined;
    try {
      profile = this.profileRepo.get(name);
    } catch {
      return null;
    }
    if (!profile || profile.engine !== 'agy') return null;

    const logDir =
      profile.name === 'chinh'
        ? this.config.defaultLogDir
        : path.join(
            profile.home || path.join(this.config.agyHomesDir, profile.name),
            '.gemini',
            'antigravity-cli',
            'log',
          );

    const email = this.coreProfileService.readEmailFromLog(logDir);
    if (email) {
      if (email !== profile.email) {
        try {
          this.profileRepo.upsert({ ...profile, email });
        } catch {
          return email;
        }
        const dupes = this.coreProfileService.getDuplicateEmails();
        const duplicateWarning = dupes.has(email);
        this.scheduler.getEventBus().emit('profile.updated', undefined, {
          name: profile.name,
          email,
          duplicateWarning,
        });
        this.scheduler.wakeWaitingQuotaTasks('profile_login');
      }
      this.emailCheckCache.set(name, Date.now());
      return email;
    }
    return profile.email || null;
  }

  // --- Profiles ---
  listProfiles() {
    const profiles = this.profileRepo.getAll();
    const now = Date.now();
    for (const p of profiles) {
      if (p.engine === 'agy' && !p.email && this.isProfileLoggedIn(p)) {
        const lastCheck = this.emailCheckCache.get(p.name) || 0;
        if (now - lastCheck > 30_000) {
          this.emailCheckCache.set(p.name, now);
          const email = this.refreshProfileEmail(p.name);
          if (email) {
            p.email = email;
          }
        }
      }
    }

    const quotaMarks = this.quotaMarkRepo.getActive();
    const dupes = this.coreProfileService.getDuplicateEmails();
    const runningMap = this.scheduler.getRunning();

    return profiles.map((p) => {
      const marks = quotaMarks.filter((m) => m.profileName === p.name);
      const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === p.name);
      const slots = this.lockService.getSlotsSync(p);
      return {
        ...apiProfile(p),
        loggedIn: this.isProfileLoggedIn(p),
        quotaMarks: marks,
        slotsUsed: Math.max(slots.slotsUsed, isBusy ? 1 : 0),
        slotsTotal: slots.slotsTotal,
        busy: slots.busy || isBusy,
        usage: this.usageService.getForProfile(p.name),
        duplicateWarning: p.email ? dupes.has(p.email) : false,
      };
    });
  }

  createProfile(raw: unknown): ProfileRow {
    const parsed = CreateProfileSchema.parse(raw);
    if (this.profileRepo.get(parsed.name)) {
      throw new HttpError(409, 'conflict', `Hồ sơ "${parsed.name}" đã tồn tại`);
    }

    this.coreProfileService.createProfile(parsed.name);
    this.scheduler.getEventBus().emit('profile.created', undefined, { name: parsed.name });
    this.scheduler.wakeWaitingQuotaTasks('profile_created');

    return apiProfile(this.profileRepo.get(parsed.name)!);
  }

  startProfileCheck(name: string): { started: true } {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    if (this.profileChecks.has(name)) {
      throw new HttpError(409, 'conflict', `Hồ sơ "${name}" đang được kiểm tra`);
    }
    this.profileChecks.add(name);
    void this.runProfileCheck(profile).finally(() => this.profileChecks.delete(name));
    return { started: true };
  }

  private async runProfileCheck(profile: ProfileRow): Promise<void> {
    const startedAt = Date.now();
    let ok = false;
    let message = '';
    let output = '';
    let email = profile.email || undefined;

    try {
      if (profile.engine === 'agy') {
        const result = await this.usageService.check(profile);
        output = result.output;
        const auth = parseAuthState(output, result.entries.length > 0);
        this.profileRepo.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
        ok = auth.authState === 'ok';
        if (result.error && /timed out|timeout/i.test(result.error)) {
          message = 'Kiểm tra /usage quá thời gian 60 giây';
        } else if (auth.authState === 'needs_verification') {
          message = 'Cần xác minh tài khoản';
        } else if (auth.authState === 'not_logged_in') {
          message = 'Hồ sơ chưa đăng nhập hoặc xác thực thất bại';
        } else if (!ok) {
          message = result.error || 'Kiểm tra thất bại';
        } else {
          message = 'Kiểm tra thành công';
        }
        const refreshedEmail = this.refreshProfileEmail(profile.name);
        if (refreshedEmail) email = refreshedEmail;
      } else {
        const codexPath = CodexEngine.findCodexPath();
        if (!codexPath) {
          message = 'Không tìm thấy Codex CLI';
          this.profileRepo.updateAuthState(profile.name, 'error', message, null);
        } else {
          const result = await execFileAsync(codexPath, ['--version'], { timeout: 20_000 });
          output = `${result.stdout}${result.stderr}`;
          ok = true;
          message = output.trim() || 'Codex CLI sẵn sàng';
          this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
        }
      }
    } catch (error) {
      const err = error as { message?: string; stdout?: string; stderr?: string };
      output = `${err.stdout || ''}${err.stderr || ''}`;
      const auth = parseAuthState(output, false);
      this.profileRepo.updateAuthState(profile.name, auth.authState, auth.authMessage, auth.verifyUrl);
      message = /timed out|timeout/i.test(err.message || '')
        ? 'Kiểm tra quá thời gian cho phép'
        : err.message || 'Kiểm tra thất bại';
    }

    const updatedProfile = this.profileRepo.get(profile.name);
    this.scheduler.getEventBus().emit('profile.check', undefined, {
      name: profile.name,
      ok,
      message: message || (ok ? 'Kiểm tra thành công' : 'Kiểm tra thất bại'),
      ...(email ? { email } : {}),
      durationMs: Date.now() - startedAt,
      authState: updatedProfile?.authState ?? null,
      verifyUrl: updatedProfile?.verifyUrl ?? null,
    });
    this.scheduler.getEventBus().emit('profile.updated', undefined, {
      name: profile.name,
      email: updatedProfile?.email ?? null,
      authState: updatedProfile?.authState ?? null,
      authMessage: updatedProfile?.authMessage ?? null,
      verifyUrl: updatedProfile?.verifyUrl ?? null,
    });
  }

  private isProfileLoggedIn(profile: ProfileRow): boolean {
    return isProfileLoggedIn(profile);
  }

  async refreshUsage(name: string) {
    const profile = this.profileRepo.get(name);
    if (!profile) throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    await this.usageService.collect(profile);
    this.refreshProfileEmail(profile.name);
    return this.listProfiles().find((p) => p.name === name);
  }

  updateProfile(name: string, raw: unknown): ProfileRow {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }

    const parsed = UpdateProfileSchema.parse(raw);
    const enabledNum = typeof parsed.enabled === 'boolean' ? (parsed.enabled ? 1 : 0) : parsed.enabled;

    const wasDisabled = profile.enabled === 0;
    this.profileRepo.updateEnabled(name, enabledNum);

    this.scheduler.getEventBus().emit('profile.updated', undefined, { name, enabled: enabledNum });

    // When re-enabling a profile, wake up waiting_quota tasks
    if (wasDisabled && enabledNum === 1) {
      this.scheduler.wakeWaitingQuotaTasks('profile_enabled');
    }

    return apiProfile(this.profileRepo.get(name)!);
  }

  markQuota(name: string, raw: unknown) {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    const parsed = MarkQuotaSchema.parse(raw);
    const seconds = parsed.seconds || 5 * 3600;
    this.coreProfileService.markQuota(name, parsed.family, seconds, parsed.reason);
    this.scheduler.getEventBus().emit('quota.exhausted', undefined, {
      profile: name,
      family: parsed.family,
    });
    return { ok: true };
  }

  clearQuota(name: string, family: string) {
    const profile = this.profileRepo.get(name);
    if (!profile) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }
    this.quotaMarkRepo.clear(name, family);
    this.scheduler.getEventBus().emit('quota.cleared', undefined, { profile: name, family });
    this.scheduler.wakeWaitingQuotaTasks('quota_cleared');
    return { ok: true };
  }

  // --- Tasks ---
  listTasks(filter?: { project?: string; status?: string }): TaskRow[] {
    let tasks = this.taskRepo.getAll();
    if (filter?.project) {
      tasks = tasks.filter((t) => t.projectId === filter.project);
    }
    if (filter?.status) {
      tasks = tasks.filter((t) => t.status === filter.status);
    }
    const running = this.scheduler.getRunning();
    return tasks.map((task) => {
      const run = running.get(task.id);
      return {
        ...apiTask(task),
        checks: this.scheduler.getCheckResults(task.id),
        currentRun: run ? { startedAt: new Date(run.startTime).toISOString(), lastOutputAt: new Date(run.lastOutputAt).toISOString(), lastActivityAt: new Date(run.lastActivityAt).toISOString(), activitySource: run.activitySource } : null,
      };
    }) as TaskRow[];
  }

  async getTask(idParam: string) {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const runs = this.runRepo.getByTask(taskId);
    const reviews = this.reviewRepo.getByTask(taskId);

    let doneContent: string | null = null;
    let blockedContent: string | null = null;

    if (task.worktreePath && fs.existsSync(task.worktreePath)) {
      const donePath = path.join(task.worktreePath, '.agenthub', 'DONE');
      const blockedPath = path.join(task.worktreePath, '.agenthub', 'BLOCKED');
      if (fs.existsSync(donePath)) {
        try {
          doneContent = fs.readFileSync(donePath, 'utf-8');
        } catch {
          // ignore
        }
      }
      if (fs.existsSync(blockedPath)) {
        try {
          blockedContent = fs.readFileSync(blockedPath, 'utf-8');
        } catch {
          // ignore
        }
      }
    }

    const project = this.projectRepo.get(task.projectId);
    let commits: string[] = [];
    if (project && task.branch) {
      const baseRef = task.baseRef || project.defaultBranch;
      commits = await getGitCommits(project.path, baseRef, task.branch);
    }

    const activeRun = this.scheduler.getRunning().get(taskId);
    return {
      ...apiTask(task),
      currentRun: activeRun ? { startedAt: new Date(activeRun.startTime).toISOString(), lastOutputAt: new Date(activeRun.lastOutputAt).toISOString(), lastActivityAt: new Date(activeRun.lastActivityAt).toISOString(), activitySource: activeRun.activitySource } : null,
      runs: runs.map(apiRun),
      reviews: reviews.map(apiReview),
      doneContent,
      blockedContent,
      commits,
      worktreePath: task.worktreePath,
      checks: this.scheduler.getCheckResults(taskId),
      claudeCost: (() => { const measured = this.claudeSessionRepo?.taskCost(taskId); return measured ? { measured: measured.effectiveTokens > 0, ...measured } : { measured: false, effectiveTokens: 0, sessions: 0 }; })(),
    };
  }

  createTask(raw: unknown): TaskRow {
    const parsed = CreateTaskSchema.parse(raw);
    const project = this.projectRepo.get(parsed.project);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${parsed.project}" không tồn tại`);
    }

    const taskId = `${parsed.project}/${parsed.slug}`;
    if (this.taskRepo.get(taskId)) {
      throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
    }

    const initialStatus = parsed.start ? 'queued' : 'draft';
    this.taskRepo.insert({
      id: taskId,
      projectId: parsed.project,
      slug: parsed.slug,
      title: parsed.title,
      body: parsed.body,
      level: parsed.level,
      modelChain: parsed.modelChain ? JSON.stringify(parsed.modelChain) : undefined,
      baseRef: parsed.baseRef,
      branch: parsed.branch,
      dependsOn: parsed.dependsOn,
      status: initialStatus,
    });

    if (parsed.start) {
      this.scheduler.getEventBus().emit('task.queued', taskId);
      this.scheduler.triggerTick();
    }

    return this.taskRepo.get(taskId)!;
  }

  updateTask(idParam: string, raw: unknown): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    if (!['draft', 'queued', 'waiting_quota', 'failed'].includes(task.status)) {
      throw new HttpError(
        409,
        'conflict',
        `Chỉ có thể sửa task ở trạng thái draft, queued, waiting_quota hoặc failed (hiện tại: ${task.status})`,
      );
    }

    let parsed: z.infer<typeof UpdateTaskSchema>;
    try {
      parsed = UpdateTaskSchema.parse(raw);
    } catch (err) {
      if (err instanceof ZodError) {
        throw new HttpError(
          422,
          'unprocessable_entity',
          err.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; '),
        );
      }
      throw err;
    }

    const updateFields: Parameters<typeof this.taskRepo.update>[1] = {};

    if (parsed.title !== undefined) {
      updateFields.title = parsed.title;
    }

    if (parsed.level !== undefined) {
      updateFields.level = parsed.level;
    }

    if (parsed.modelChain !== undefined) {
      updateFields.modelChain =
        parsed.modelChain && parsed.modelChain.length > 0 ? JSON.stringify(parsed.modelChain) : null;
    }

    let newBody: string | undefined = undefined;
    if (parsed.body !== undefined) {
      newBody = parsed.body;
    }
    if (parsed.appendBody !== undefined) {
      const current = newBody !== undefined ? newBody : (task.body ?? '');
      if (!current) {
        newBody = parsed.appendBody;
      } else if (current.endsWith('\n') || parsed.appendBody.startsWith('\n')) {
        newBody = `${current}${parsed.appendBody}`;
      } else {
        newBody = `${current}\n${parsed.appendBody}`;
      }
    }
    if (newBody !== undefined) {
      updateFields.body = newBody;
    }

    if (parsed.dependsOn !== undefined) {
      const normalizedDeps: string[] = [];
      for (const depId of parsed.dependsOn) {
        const normId = toTaskId(depId);
        const depTask = this.taskRepo.get(normId);
        if (!depTask) {
          throw new HttpError(422, 'unprocessable_entity', `Task phụ thuộc "${depId}" không tồn tại`);
        }
        normalizedDeps.push(normId);
      }

      // Check for dependency cycles
      const visited = new Set<string>();
      const recStack = new Set<string>();

      const checkCycle = (currId: string): boolean => {
        visited.add(currId);
        recStack.add(currId);

        let nextDeps: string[] = [];
        if (currId === taskId) {
          nextDeps = normalizedDeps;
        } else {
          const t = this.taskRepo.get(currId);
          if (t?.dependsOn) {
            try {
              const p = JSON.parse(t.dependsOn);
              if (Array.isArray(p)) {
                nextDeps = p.map(toTaskId);
              }
            } catch {
              nextDeps = [];
            }
          }
        }

        for (const next of nextDeps) {
          if (!visited.has(next)) {
            if (checkCycle(next)) return true;
          } else if (recStack.has(next)) {
            return true;
          }
        }

        recStack.delete(currId);
        return false;
      };

      if (checkCycle(taskId)) {
        throw new HttpError(422, 'unprocessable_entity', 'Danh sách dependsOn tạo vòng phụ thuộc');
      }

      updateFields.dependsOn = JSON.stringify(normalizedDeps);
    }

    this.taskRepo.update(taskId, updateFields);

    const updatedTask = this.taskRepo.get(taskId)!;

    if (updatedTask.worktreePath) {
      const taskMdPath = path.join(updatedTask.worktreePath, '.agenthub', 'task.md');
      if (fs.existsSync(taskMdPath) && newBody !== undefined) {
        try {
          fs.writeFileSync(taskMdPath, newBody, 'utf-8');
        } catch {
          // ignore
        }
      }
    }

    this.scheduler.getEventBus().emit('task.updated', taskId, {
      id: taskId,
      title: updatedTask.title,
      level: updatedTask.level,
      status: updatedTask.status,
      modelChain: updatedTask.modelChain,
      dependsOn: updatedTask.dependsOn,
    });

    if (updatedTask.status === 'queued') {
      this.scheduler.triggerTick();
    }

    return updatedTask;
  }

  startTask(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    this.taskRepo.updateStatus(taskId, 'queued');
    this.scheduler.getEventBus().emit('task.queued', taskId);
    this.scheduler.triggerTick();

    return this.taskRepo.get(taskId)!;
  }

  cancelTask(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    this.scheduler.cancelTask(taskId);
    return this.taskRepo.get(taskId)!;
  }

  reviewTask(idParam: string, raw: unknown): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'review') {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái review (hiện tại: ${task.status})`);
    }

    const parsed = ReviewTaskSchema.parse(raw);

    const reviewId = crypto.randomUUID();
    this.reviewRepo.insert({
      id: reviewId,
      taskId,
      verdict: parsed.verdict,
      feedback: parsed.feedback || null,
      actor: parsed.by || 'claude',
    });

    this.scheduler.reviewTask(taskId, parsed.verdict, parsed.feedback, parsed.by);
    return this.taskRepo.get(taskId)!;
  }

  retryTask(idParam: string, raw: unknown): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'failed' && task.status !== 'blocked') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể retry task ở trạng thái failed hoặc blocked (hiện tại: ${task.status})`);
    }

    const parsed = RetryTaskSchema.parse(raw || {});
    const newBody = parsed.note ? `${task.body || ''}\n\n## Retry Note\n\n${parsed.note}` : task.body;

    this.taskRepo.update(taskId, {
      status: 'queued',
      resume: 1,
      attempt: task.attempt + 1,
      transientRetries: 0,
      notBefore: null,
      body: newBody,
      reviewerChangesRequested: 0,
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });

    this.scheduler.getEventBus().emit('task.queued', taskId, { reason: 'retry', note: parsed.note });
    this.scheduler.triggerTick();

    return this.taskRepo.get(taskId)!;
  }

  retryReviewer(idParam: string): TaskRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'review' || !task.reviewerEscalated) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái chờ người duyệt`);
    }

    this.taskRepo.update(taskId, {
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });
    this.scheduler.getEventBus().emit('task.review_ready', taskId, { reason: 'reviewer_retry' });
    this.scheduler.triggerTick();
    return this.taskRepo.get(taskId)!;
  }

  deleteWorktree(idParam: string): { ok: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'done' && task.status !== 'cancelled') {
      throw new HttpError(
        409,
        'conflict',
        `Chỉ có thể xóa worktree của task đã done hoặc cancelled (hiện tại: ${task.status})`,
      );
    }

    if (task.worktreePath) {
      const project = this.projectRepo.get(task.projectId);
      // Chỉ xóa đường dẫn nằm hẳn trong worktreesDir và không phải gốc project (sự cố 16/10).
      const removed = new WorktreeService(this.config).remove(project?.path ?? null, task.worktreePath);
      if (!removed) {
        throw new HttpError(
          422,
          'unprocessable_entity',
          `Từ chối xóa ${task.worktreePath}: nằm ngoài ${this.config.worktreesDir} hoặc là thư mục project`,
        );
      }
      this.taskRepo.update(taskId, { worktreePath: null, slot: null });
    }

    return { ok: true };
  }

  getTaskLog(idParam: string, query?: { run?: string; tail?: string | number }): string {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const runs = this.runRepo.getByTask(taskId);
    const runId = query?.run;
    const targetRun = runId ? runs.find((r) => r.id === runId) : runs[runs.length - 1];

    if (!targetRun?.logPath || !fs.existsSync(targetRun.logPath)) {
      return '';
    }

    const tailKB = query?.tail ? parseInt(String(query.tail), 10) : 512;
    return readLogTail(targetRun.logPath, isNaN(tailKB) ? 512 : tailKB);
  }

  async rerunChecks(idParam: string) {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    const project = this.projectRepo.get(task.projectId);
    const run = this.runRepo.getByTask(taskId).at(-1);
    if (!project || !run) throw new HttpError(400, 'bad_request', 'Task chưa có run để lưu kết quả kiểm tra');
    const db = this.scheduler.getDatabase();
    if (!db) throw new HttpError(500, 'internal_server_error', 'Check database chưa sẵn sàng');
    return new CheckRunner(db).run(task, project, run.id);
  }

  // --- Config ---
  getConfig() {
    return {
      modelChainHard: this.config.defaultModelChains.hard,
      modelChainEasy: this.config.defaultModelChains.easy,
      defaultTimeout: this.config.defaultTimeout,
      slotsPerAgyProfile: this.config.slotsPerAgyProfile,
      slotsPerCodexProfile: this.config.slotsPerCodexProfile,
      watchdog: this.config.watchdog,
      autoFixOnFail: this.config.autoFixOnFail,
      chat: {
        claudeBin: this.config.chat.claudeBin,
        resolvedClaudeBin: findClaudeBin(this.config.chat.claudeBin),
        claudeVersion: getClaudeVersion(this.config.chat.claudeBin),
        disableToolSearch: this.config.chat.disableToolSearch,
        allowFullMode: this.config.chat.allowFullMode,
        maxConcurrent: this.config.chat.maxConcurrent,
        idleTimeoutSec: this.config.chat.idleTimeoutSec,
        model: this.config.chat.model,
      },
      reviewer: this.config.reviewer,
      notifications: this.config.notifications,
      savings: this.config.savings,
    };
  }

  updateConfig(raw: unknown) {
    const parsed = UpdateConfigSchema.parse(raw);

    // Apply in-memory
    updateConfigInMemory(this.config, parsed);

    // Save to config.json
    saveConfig(this.config.hubHome, parsed);

    this.scheduler.getEventBus().emit('config.updated', undefined, parsed);

    return this.getConfig();
  }
}
