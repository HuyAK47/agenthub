import fs from 'node:fs';
import { DEFAULT_PROJECT_SETTINGS, mergeProjectSettings, ProjectSettingsInputSchema, projectSettings } from '../projects/settings.js';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { z, ZodError } from 'zod';
import { AgentHubConfig, TelegramChat, saveConfig, updateConfigInMemory } from '../config.js';
import {
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  ReviewRepo,
  EventRepo,
  TaskNoteRepo,
  TaskNoteRow,
  ProjectRow,
  ProfileRow,
  TaskRow,
  QuotaMarkRow,
  KnowledgeRepo,
  KnowledgeEntryRow,
  TaskBatchRepo,
  TaskBatchRow,
} from '../db/index.js';
import { BulletinService } from '../bulletin.js';
import { ProfileService as CoreProfileService, accountKey, isProfileLoggedIn } from '../profiles/index.js';
import { Scheduler } from '../scheduler/index.js';
import { CodexEngine } from '../engines/index.js';
import { QuotaUsageService } from '../quota/usage.js';
import { ProfileLockService } from '../profiles/locks.js';
import { CheckRunner } from '../checks.js';
import { BrainService } from '../brain.js';
import { toApiTime } from '../db/time.js';
import { ChatService } from '../chat/service.js';
import { getDiskSpaceSync, getMonitoredDisks } from '../disk.js';
import { WorktreeService } from '../worktrees/index.js';
import { parseAuthState, parseCodexLoginStatus } from '../profiles/auth.js';
import { SavingsService } from '../savings.js';
import { getDailyUsageReport } from '../daily-usage.js';
import { ClaudeSessionRepo } from '../claude-sessions/repo.js';
import { isClaudeProcessOpen, isClaudeQuotaLimited, ClaudeSessionScanner } from '../claude-sessions/scanner.js';
import { findClaudeBin, getClaudeVersion } from '../chat/claude.js';
import { listAllWorktreeProcesses, reapSyncForWorktree } from '../reaper.js';
import { mergeTaskIntoBase, MergeError } from '../merge.js';
import { computeTaskGraph, filterTasksForGraph, detectCycle, parseDependsOn } from './dag.js';
import { excerptHash, extractFileLocations, toMarkdownCodeBlock, truncateExcerpt } from '../task-capture.js';
import type { TelegramBotService } from '../telegram.js';
import { ReviewChainSchema, parseReviewChain } from '../review-chain.js';
import { isKnownModel } from '../quota/index.js';
import { SetupManager } from '../tools/setup.js';

const execFileAsync = promisify(execFile);

function apiProject(project: ProjectRow): ProjectRow {
  let merge: unknown = null;
  if (project.merge) {
    try { merge = JSON.parse(project.merge); } catch { merge = null; }
  }
  let reviewChain: unknown = null;
  if (project.reviewChain) {
    try { reviewChain = JSON.parse(project.reviewChain); } catch { reviewChain = null; }
  }
  let review: unknown = null;
  if (project.review) {
    try { review = JSON.parse(project.review); } catch { review = null; }
  } else if (reviewChain) {
    review = { chain: reviewChain, maxRounds: 2 };
  }
  return { ...project, merge, reviewChain, review, settings: projectSettings(project), createdAt: toApiTime(project.createdAt)! } as unknown as ProjectRow;
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

export function apiTaskNote(note: TaskNoteRow): TaskNoteRow {
  return {
    ...note,
    createdAt: toApiTime(note.createdAt) || note.createdAt,
  };
}

export function apiKnowledgeEntry(entry: KnowledgeEntryRow): KnowledgeEntryRow {
  return { ...entry, createdAt: toApiTime(entry.createdAt) || entry.createdAt };
}

export function apiBatch(batch: TaskBatchRow): TaskBatchRow {
  return {
    ...batch,
    createdAt: toApiTime(batch.createdAt) || batch.createdAt,
  };
}

export function extractKnowledgeSection(doneContent: string): string | null {
  const heading = /^##\s+Ghi chú cho task sau\s*$/m.exec(doneContent);
  if (!heading) return null;
  const start = heading.index + heading[0].length;
  const remainder = doneContent.slice(start).replace(/^\r?\n/, '');
  const nextHeading = /^##\s/m.exec(remainder);
  const content = remainder.slice(0, nextHeading?.index ?? remainder.length).trim();
  return content ? content : null;
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
const taskModelValidator = z.string().trim().min(1, 'Model không được để trống');

export const ProjectHooksSchema = z.object({
  onWorktreeRemoved: z.array(z.string()).optional(),
});
export type ProjectHooks = z.infer<typeof ProjectHooksSchema>;

export const ProjectHooksInputSchema = z.union([
  ProjectHooksSchema,
  z.string().transform((val, ctx) => {
    if (!val.trim()) return null;
    try {
      const parsed = JSON.parse(val);
      return ProjectHooksSchema.parse(parsed);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `Invalid hooks JSON: ${msg}` });
      return z.NEVER;
    }
  }),
]);

export const ProjectMergeSchema = z.object({
  enabled: z.boolean().default(false),
  worktrees: z.record(z.string().min(1), z.string().min(1)).default({}),
  checks: z.array(z.string().min(1)).default([]),
  timeoutSec: z.number().int().positive().default(600),
});
export type ProjectMerge = z.infer<typeof ProjectMergeSchema>;
export const ProjectReviewSchema = z.object({
  chain: ReviewChainSchema.default([]),
  maxRounds: z.number().int().positive().default(2),
});

export const CreateProjectSchema = z.object({
  id: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/).optional(),
  name: z.string().min(1),
  path: z.string().min(1),
  defaultBranch: z.string().default('main'),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().default(3),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
  hooks: ProjectHooksInputSchema.nullable().optional(),
  merge: ProjectMergeSchema.nullable().optional(),
  reviewChain: ReviewChainSchema.nullable().optional(),
  review: ProjectReviewSchema.nullable().optional(),
  settings: ProjectSettingsInputSchema.optional(),
});

export const UpdateProjectSchema = z.object({
  name: z.string().min(1).optional(),
  defaultBranch: z.string().min(1).optional(),
  envTemplate: z.string().nullable().optional(),
  maxParallel: z.number().int().positive().optional(),
  checks: z.array(z.object({ name: z.string().min(1), cmd: z.array(z.string()).min(1), timeoutSec: z.number().int().positive().optional() })).nullable().optional(),
  hooks: ProjectHooksInputSchema.nullable().optional(),
  merge: ProjectMergeSchema.nullable().optional(),
  reviewChain: ReviewChainSchema.nullable().optional(),
  review: ProjectReviewSchema.nullable().optional(),
  settings: ProjectSettingsInputSchema.optional(),
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
  modelChain: z.array(taskModelValidator).optional(),
  sourceRef: z.object({ taskId: z.string(), runId: z.string().nullable().optional(), checkName: z.string().nullable().optional(), excerptHash: z.string() }).optional(),
  start: z.boolean().optional(),
  fromClaude: z.boolean().optional(),
  batchId: z.string().optional(),
});

export const BatchTaskInputSchema = z.object({
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  modelChain: z.array(modelValidator).optional(),
  dependsOn: z.array(z.string()).optional(),
});

export const CreateBatchSchema = z.object({
  project: z.string().min(1),
  title: z.string().min(1),
  goal: z.string().optional(),
  tasks: z.array(BatchTaskInputSchema).min(1),
  createdBy: z.string().optional(),
});

export const UpdateBatchSchema = z.object({
  title: z.string().min(1).optional(),
  goal: z.string().nullable().optional(),
  status: z.enum(['draft', 'dispatched', 'discarded']).optional(),
});

export const CaptureTaskSchema = z.object({
  sourceTaskId: z.string().min(1),
  runId: z.string().min(1).optional(),
  checkName: z.string().min(1).optional(),
  excerpt: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  title: z.string().min(1).optional(),
  body: z.string().optional(),
  level: z.enum(['easy', 'hard']).default('easy'),
  start: z.boolean().optional(),
});

export const UpdateTaskSchema = z.object({
  modelChain: z.array(taskModelValidator).nullable().optional(),
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
  merge: z.boolean().optional().default(false),
}).refine(
  (d) => d.verdict !== 'changes_requested' || (typeof d.feedback === 'string' && d.feedback.trim().length > 0),
  { message: 'Feedback là bắt buộc khi changes_requested' },
);

export const RetryTaskSchema = z.object({
  note: z.string().optional(),
});

export const CreateTaskNoteSchema = z.object({
  content: z.string().min(1, 'Nội dung ghi chú không được để trống'),
  kind: z.enum(['note', 'overlap']).optional().default('note'),
});

export const CreateKnowledgeSchema = z.object({
  content: z.string().min(1, 'Nội dung kiến thức không được để trống'),
  taskId: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

export const UpdateKnowledgeSchema = z.object({
  content: z.string().min(1).optional(),
  pinned: z.boolean().optional(),
});

export const CreateProfileSchema = z.object({
  name: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
  engine: z.enum(['agy', 'claude', 'codex']).default('agy'),
  accountType: z.enum(['personal', 'team', 'api']).default('personal'),
});

export const RenameProfileSchema = z.object({
  newName: z.string().min(1).regex(/^[a-zA-Z0-9_-]+$/),
});

export const UpdateProfileSchema = z.object({
  enabled: z.union([z.boolean(), z.number().int().min(0).max(1)]).optional(),
  label: z.string().nullable().optional(),
  notes: z.string().nullable().optional(),
  priority: z.number().int().optional(),
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
  context: z.object({
    overlapCheckSec: z.number().positive().optional(),
    depsMaxChars: z.number().int().positive().optional(),
    knowledgeMaxChars: z.number().int().positive().optional(),
    knowledgeFile: z.string().optional(),
  }).optional(),
  slotsPerAgyProfile: z.number().int().positive().optional(),
  slotsPerCodexProfile: z.number().int().positive().optional(),
  multiplePerProvider: z.boolean().optional(),
  planning: z.object({
    requireApproval: z.boolean().optional(),
    approvalMinTasks: z.number().int().min(0).max(100).optional(),
  }).optional(),
  watchdog: z.object({
    stallMinutes: z.number().positive().optional(),
    waitingMinutes: z.number().positive().optional(),
  }).optional(),
  autoFixOnFail: z.boolean().optional(),
  tools: z.object({ installers: z.record(z.object({
    package: z.string().regex(/^(@[a-z0-9-~][a-z0-9._~]*\/[a-z0-9-~][a-z0-9._~]*|[a-z0-9-~][a-z0-9._~]*)(@[\w.^~<>=*-]+)?$/).refine((value) => !value.startsWith('-'), 'Tên package npm không hợp lệ').optional(),
    versionArgs: z.array(z.string()).optional(),
    docsUrl: z.string().url().optional(),
  })) }).optional(),
  chat: z
    .object({
      claudeBin: z.string().optional(),
      disableToolSearch: z.boolean().optional(),
      allowFullMode: z.boolean().optional(),
      maxConcurrent: z.number().int().positive().optional(),
      idleTimeoutSec: z.number().int().positive().optional(),
      permissionTimeoutSec: z.number().int().positive().optional(),
      model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
      models: z.array(z.string().trim().min(1)).min(1).optional(),
      autoCompactPercent: z.number().min(0).max(100).optional(),
    })
    .optional(),
  reviewer: z.object({
    enabled: z.boolean().optional(),
    model: modelValidator.optional(),
    timeoutSec: z.number().int().positive().optional(),
    failoverSec: z.number().int().positive().optional(),
    maxChangesRequested: z.number().int().positive().optional(),
  }).optional(),
  brain: z.object({
    fallback: z.array(z.discriminatedUnion('type', [
      z.object({ type: z.literal('profile'), profile: z.string().min(1).optional() }),
      z.object({ type: z.literal('model'), model: z.string().min(1) }),
      z.object({ type: z.literal('apiKey'), dailyCapUSD: z.number().positive() }),
      z.object({ type: z.literal('engine'), engine: z.literal('codex') }),
      z.object({ type: z.literal('wait') }),
    ])).max(10),
    policy: z.array(z.string().min(1)).max(100).optional(),
    claudeProfile: z.string().min(1).optional(),
    model: z.enum(['', 'opus', 'sonnet', 'haiku']).optional(),
    mode: z.enum(['off', 'suggest', 'auto']).optional(),
    maxTurnsPerHour: z.number().int().positive().optional(),
    dailyTokenBudget: z.number().int().nonnegative().optional(),
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
    }).optional(),
  load: z.object({
    enabled: z.boolean().optional(),
    high: z.number().positive().optional(),
    ok: z.number().positive().optional(),
    minFreeMemGB: z.number().positive().optional(),
    recoverAfterSec: z.number().int().positive().optional(),
  }).optional(),
  stall: z.object({
    noCommitMin: z.number().positive().optional(),
    loopThreshold: z.number().int().positive().optional(),
  }).optional(),
  disk: z.object({
    minFreeGB: z.number().positive().optional(),
    extraPaths: z.array(z.object({ path: z.string().min(1), minFreeGB: z.number().positive(), label: z.string().min(1) })).optional(),
  }).optional(),
  telegram: z.object({
    enabled: z.boolean().optional(),
    botTokenFile: z.string().optional(),
    allowedChatIds: z.array(z.number()).optional(),
    notify: z.object({
      reviewReady: z.boolean().optional(),
      failed: z.boolean().optional(),
      blocked: z.boolean().optional(),
      quota: z.boolean().optional(),
      fallback: z.boolean().optional(),
    }).optional(),
  }).optional(),
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

    case 'task.paused':
      return p.reason === 'load'
        ? `${taskLabel} tạm dừng do quá tải`
        : `${taskLabel} đã tạm dừng`;

    case 'task.resumed':
      return `${taskLabel} tiếp tục chạy`;

    case 'load.task_paused':
      return `${taskLabel} tạm dừng do quá tải`;

    case 'load.task_resumed':
      return `${taskLabel} tiếp tục chạy sau khi tải giảm`;

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

    case 'disk.docker_low': {
      const free = p && (p as Record<string, unknown>).freeGB !== undefined ? `${(p as Record<string, unknown>).freeGB}GB` : '';
      return free ? `Ổ đĩa Docker gần đầy (còn ${free})` : 'Ổ đĩa Docker gần đầy';
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

    case 'task.overlap': {
      const file = (p.file || p.filename) as string | undefined;
      const other = p.otherTaskId
        ? (String(p.otherTaskId).includes('/') ? String(p.otherTaskId).split('/')[1] : String(p.otherTaskId))
        : undefined;
      if (file && other) {
        return `Cảnh báo trùng file ${file} giữa ${taskLabel} và ${other}`;
      }
      return `${taskLabel} cảnh báo trùng sửa file`;
    }

    case 'task.note': {
      const content = typeof p.content === 'string' ? p.content : '';
      return `${taskLabel} ghi chú: ${content.length > 50 ? content.slice(0, 50) + '...' : content}`;
    }

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
    public taskNoteRepo?: TaskNoteRepo,
    public bulletinService?: BulletinService,
    public telegramBotService?: TelegramBotService,
    public knowledgeRepo?: KnowledgeRepo,
    public taskBatchRepo?: TaskBatchRepo,
    public setupManager?: SetupManager,
  ) {}

  async getSetupStatus() {
    if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng');
    const tools = await this.setupManager.status();
    const profiles = this.listProfiles();
    let gitVersion: string | null = null;
    try { gitVersion = execFileSync('git', ['--version'], { encoding: 'utf8', timeout: 5000 }).trim(); } catch { /* optional */ }
    let mcpRegistered = false;
    try { mcpRegistered = fs.readFileSync(path.join(os.homedir(), '.claude.json'), 'utf8').includes('agenthub'); } catch { /* optional */ }
    return { node: { version: process.versions.node, ok: Number(process.versions.node.split('.')[0]) >= 22 }, git: { version: gitVersion, installed: Boolean(gitVersion) }, tools, profiles, mcpRegistered, serviceRunning: true, ...this.setupManager.getSetupState() };
  }
  installSetupTool(tool: string) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.install(tool); }
  getSetupLogPath(tool: string) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.getLogPath(tool); }
  completeSetup(skip = false) { if (!this.setupManager) throw new HttpError(500, 'internal_error', 'Setup service chưa sẵn sàng'); return this.setupManager.complete(skip); }

  listClaudeSessions(activeWithinMin?: number) {
    if (!this.claudeSessionRepo) return [];
    const min = typeof activeWithinMin === 'number' && !Number.isNaN(activeWithinMin) ? activeWithinMin : (this.config.claudeSessions?.activeWithinMin ?? 10);
    const cutoff = Date.now() - min * 60_000;
    return this.claudeSessionRepo.list().map((session) => {
      const active = (!!session.lastAt && Date.parse(session.lastAt) >= cutoff) || (!!session.cwd && isClaudeProcessOpen(session.cwd));
      const title = session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId);
      return {
        ...session,
        title,
        active,
        topTasks: this.claudeSessionRepo!.topTasks(session.sessionId),
      };
    });
  }
  getClaudeSession(id: string, activeWithinMin?: number) {
    if (!this.claudeSessionRepo) throw new HttpError(500, 'internal_error', 'Claude session service chưa sẵn sàng');
    const session = this.claudeSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Claude session "${id}" không tồn tại`);
    const db = this.scheduler.getDatabase();
    if (!db) throw new HttpError(500, 'internal_error', 'Database chưa sẵn sàng');
    const min = typeof activeWithinMin === 'number' && !Number.isNaN(activeWithinMin) ? activeWithinMin : (this.config.claudeSessions?.activeWithinMin ?? 10);
    const cutoff = Date.now() - min * 60_000;
    const active = (!!session.lastAt && Date.parse(session.lastAt) >= cutoff) || (!!session.cwd && isClaudeProcessOpen(session.cwd));
    const title = session.title || (session.sessionId.length > 8 ? session.sessionId.slice(0, 8) : session.sessionId);
    const turns = db.prepare(`SELECT turnId, MIN(ts) ts, SUM(input) input, SUM(output) output, SUM(cacheCreation) cacheCreation, SUM(cacheRead) cacheRead, SUM(effective) effectiveTokens FROM claude_usage WHERE sessionId=? GROUP BY turnId ORDER BY ts`).all(id) as Array<{ turnId: string; ts: string; input: number; output: number; cacheCreation: number; cacheRead: number; effectiveTokens: number }>;
    return { ...session, title, active, turns: turns.map((turn) => ({ ...turn, tasks: db.prepare('SELECT taskId,effectiveTokens FROM claude_task_usage WHERE sessionId=? AND turnId=?').all(id, turn.turnId) })) };
  }
  setClaudeAutoResume(id: string, enabled: boolean) {
    if (!this.claudeSessionRepo) throw new HttpError(500, 'internal_error', 'Claude session service chưa sẵn sàng');
    const session = this.claudeSessionRepo.get(id);
    if (!session) throw new HttpError(404, 'not_found', `Claude session "${id}" không tồn tại`);
    return this.claudeSessionRepo.setAutoResume(id, enabled);
  }
  async rescanClaudeSessions() { await this.claudeScanner?.scan(); return { ok: true }; }
  getClaudeQuota() { const quota = this.claudeSessionRepo?.quota() || { status: null, resetsAt: null, rateLimitType: null, observedAt: null }; return { ...quota, limited: isClaudeQuotaLimited(quota.status || undefined) }; }
  getClaudeFailover() { return this.chatService?.getClaudeFailover() || { active: false, until: null, reason: null, activatedAt: null, evidence: null, lastActivityAt: null }; }
  clearClaudeFailover() {
    if (!this.chatService) throw new HttpError(500, 'internal_error', 'ChatService chưa sẵn sàng');
    return this.chatService.clearClaudeFailover();
  }
  getClaudeToday() {
    const db = this.scheduler.getDatabase();
    if (!db) return { effectiveTokens: 0, sessions: 0, tasks: [] as Array<{ taskId: string; effectiveTokens: number }> };
    const since = new Date(); since.setHours(0, 0, 0, 0);
    const sessions = db.prepare('SELECT DISTINCT sessionId FROM claude_usage WHERE ts >= ?').all(since.toISOString()) as Array<{ sessionId: string }>;
    const tasks = db.prepare('SELECT ctu.taskId, SUM(ctu.effectiveTokens) effectiveTokens FROM claude_task_usage ctu JOIN (SELECT DISTINCT sessionId,turnId FROM claude_usage WHERE ts >= ?) cu ON cu.sessionId=ctu.sessionId AND cu.turnId=ctu.turnId GROUP BY ctu.taskId ORDER BY effectiveTokens DESC LIMIT 5').all(since.toISOString()) as Array<{ taskId: string; effectiveTokens: number }>;
    const total = db.prepare('SELECT COALESCE(SUM(effective),0) effectiveTokens FROM claude_usage WHERE ts >= ?').get(since.toISOString()) as { effectiveTokens: number };
    return { effectiveTokens: total.effectiveTokens, sessions: sessions.length, tasks };
  }

  getClaudeTokenTotals() {
    const db = this.scheduler.getDatabase();
    if (!db) return { today: 0, week: 0 };
    const now = new Date();
    const today = new Date(now); today.setHours(0, 0, 0, 0);
    const week = new Date(today); week.setDate(week.getDate() - 6);
    const row = db.prepare(`
      SELECT
        COALESCE(SUM(CASE WHEN ts >= ? THEN effective ELSE 0 END), 0) AS today,
        COALESCE(SUM(CASE WHEN ts >= ? THEN effective ELSE 0 END), 0) AS week
      FROM claude_usage
    `).get(today.toISOString(), week.toISOString()) as { today: number; week: number };
    return { today: row.today, week: row.week };
  }

  getClaudeProfileLimitedSessions(profile: ProfileRow) {
    if (!this.claudeSessionRepo) return [];
    const db = this.scheduler.getDatabase();
    if (!db) return [];

    const limitedRows = db.prepare(`
      SELECT sessionId, cwd, title, limitResetAt, autoResumeEnabled
      FROM claude_sessions
      WHERE limitResetAt IS NOT NULL
      ORDER BY limitResetAt ASC
    `).all() as Array<{ sessionId: string; cwd: string; title: string | null; limitResetAt: number; autoResumeEnabled: number }>;

    if (limitedRows.length === 0) return [];

    const scanRows = db.prepare('SELECT path FROM claude_scan_state').all() as Array<{ path: string }>;
    const sessionConfigDirs = new Map<string, string>();
    for (const row of scanRows) {
      const sid = path.basename(row.path, '.jsonl');
      const configDir = path.dirname(path.dirname(path.dirname(row.path)));
      sessionConfigDirs.set(sid, path.resolve(configDir));
    }

    const defaultClaudeConfigDir = path.resolve(os.homedir(), '.claude');
    const isSystemProfile = profile.kind === 'system' || !profile.home || path.resolve(profile.home) === path.resolve(os.homedir()) || path.resolve(profile.home) === defaultClaudeConfigDir;
    const profileHome = profile.home ? path.resolve(profile.home) : null;
    const profileClaudeDir = profileHome ? path.join(profileHome, '.claude') : null;

    const matched = limitedRows.filter((row) => {
      const configDir = sessionConfigDirs.get(row.sessionId);
      if (isSystemProfile) {
        return !configDir || configDir === defaultClaudeConfigDir;
      }
      if (!configDir || !profileHome) return false;
      return configDir === profileHome || configDir === profileClaudeDir;
    });

    return matched.map((row) => ({
      sessionId: row.sessionId,
      title: row.title || (row.sessionId.length > 8 ? row.sessionId.slice(0, 8) : row.sessionId),
      cwd: row.cwd,
      limitResetAt: row.limitResetAt,
      autoResumeEnabled: row.autoResumeEnabled === 1,
    }));
  }

  // --- Savings ---
  getSavings(query?: { project?: string; since?: string }) {
    if (!this.savingsService) {
      throw new HttpError(500, 'internal_error', 'SavingsService chưa được khởi tạo');
    }
    return this.savingsService.getSavings(query);
  }

  // --- Daily Usage ---
  getDailyUsage(days = 7) {
    const db = this.scheduler.getDatabase();
    if (!db) {
      throw new HttpError(500, 'internal_error', 'Database chưa sẵn sàng');
    }
    return getDailyUsageReport({
      days,
      db,
      profileRepo: this.profileRepo,
      quotaMarkRepo: this.quotaMarkRepo,
      scheduler: this.scheduler,
      config: this.config,
    });
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
        noCommitMinutes: r.noCommitMinutes ?? null,
        isLooping: r.isLooping ?? false,
        loopingCommand: r.loopingCommand ?? null,
        title: task?.title ?? '',
        projectId: task?.projectId ?? (r.projectId || (r.taskId.includes('/') ? r.taskId.split('/')[0] : '')),
        slug: task?.slug ?? (r.taskId.includes('/') ? r.taskId.slice(r.taskId.indexOf('/') + 1) : r.taskId),
        worktreePath: task?.worktreePath ?? null,
        rss: r.rss ?? 0,
        cpu: r.cpu ?? 0,
        paused: Boolean(r.paused),
        pauseReason: r.pauseReason ?? null,
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
        ...(p.engine === 'claude' ? {
          claudeTokens: this.getClaudeTokenTotals(),
          limitedSessions: this.getClaudeProfileLimitedSessions(p),
        } : {}),
        duplicateWarning: dupes.has(accountKey(p) || ''),
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
    const disks = getMonitoredDisks(this.config.worktreesDir, this.config.disk.minFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test');
    const runningTaskIds = runningTasks.map((r) => r.taskId);
    const overlaps = this.taskNoteRepo
      ? this.taskNoteRepo.getActiveOverlaps(runningTaskIds).map(apiTaskNote)
      : [];

    return {
      tasks: byStatus,
      tasksByProject,
      profiles: profilesStatus,
      running: runningTasks,
      overlaps,
      claudeFailover: this.chatService?.getClaudeFailover(),
      codexReviewer: this.scheduler.getReviewerStatus(),
      recentEvents,
      brain: this.brainService?.getStatus(),
      schedulerPaused: this.scheduler.isPaused(),
      disk: {
        freeGB: disk.freeGB,
        totalGB: disk.totalGB,
        minFreeGB: this.config.disk.minFreeGB,
      },
      disks,
      load: this.scheduler.getLoadStatus(),
      telegram: {
        enabled: this.config.telegram?.enabled ?? false,
        allowedChatsCount: this.config.telegram?.allowedChatIds?.length ?? 0,
        hasToken: Boolean(this.telegramBotService?.hasValidToken()),
      },
      tools: this.config.tools,
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

    if (!path.isAbsolute(parsed.path)) {
      throw new HttpError(400, 'bad_request', `Đường dẫn repo phải là đường dẫn tuyệt đối: ${parsed.path}`);
    }

    const resolvedPath = path.resolve(parsed.path);
    if (!fs.existsSync(resolvedPath)) {
      throw new HttpError(400, 'bad_request', `Thư mục repo không tồn tại: ${resolvedPath}`);
    }

    let isGitRepo = false;
    if (fs.existsSync(path.join(resolvedPath, '.git'))) {
      isGitRepo = true;
    } else {
      try {
        const topLevel = execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--show-toplevel'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (topLevel) {
          isGitRepo = true;
        }
      } catch {
        isGitRepo = false;
      }
    }
    if (!isGitRepo) {
      throw new HttpError(400, 'bad_request', `Thư mục không phải là git repository: ${resolvedPath}`);
    }

    let branchExists = false;
    try {
      execFileSync('git', ['-C', resolvedPath, 'rev-parse', '--verify', parsed.defaultBranch], {
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      branchExists = true;
    } catch {
      try {
        const headBranch = execFileSync('git', ['-C', resolvedPath, 'symbolic-ref', '--short', 'HEAD'], {
          encoding: 'utf-8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (headBranch === parsed.defaultBranch) {
          branchExists = true;
        }
      } catch {
        branchExists = false;
      }
    }
    if (!branchExists) {
      throw new HttpError(400, 'bad_request', `Nhánh mặc định "${parsed.defaultBranch}" không tồn tại trong repository`);
    }

    this.projectRepo.insert({
      id,
      name: parsed.name,
      path: resolvedPath,
      defaultBranch: parsed.defaultBranch,
      envTemplate: parsed.envTemplate || null,
      maxParallel: parsed.maxParallel,
      checks: parsed.checks ? JSON.stringify(parsed.checks) : null,
      hooks: parsed.hooks ? JSON.stringify(parsed.hooks) : null,
      merge: parsed.merge ? JSON.stringify(parsed.merge) : null,
      reviewChain: parsed.reviewChain ? JSON.stringify(parsed.reviewChain) : null,
      review: parsed.review ? JSON.stringify(parsed.review) : null,
      settings: parsed.settings ? JSON.stringify(mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, parsed.settings)) : null,
    });

    this.invalidateOutOfScopeClaudeScanStates();
    return this.getProject(id);
  }

  updateProject(id: string, raw: unknown): ProjectRow {
    this.getProject(id);
    const parsed = UpdateProjectSchema.parse(raw);
    const current = this.projectRepo.get(id);
    this.projectRepo.update(id, {
      ...parsed,
      // Partial settings merge over what is stored, so callers can change one switch at a time.
      settings: parsed.settings === undefined ? undefined : JSON.stringify(mergeProjectSettings(projectSettings(current), parsed.settings)),
      checks: parsed.checks === undefined ? undefined : parsed.checks ? JSON.stringify(parsed.checks) : null,
      hooks: parsed.hooks === undefined ? undefined : parsed.hooks ? JSON.stringify(parsed.hooks) : null,
      merge: parsed.merge === undefined ? undefined : parsed.merge ? JSON.stringify(parsed.merge) : null,
      reviewChain: parsed.reviewChain === undefined ? undefined : parsed.reviewChain ? JSON.stringify(parsed.reviewChain) : null,
      review: parsed.review === undefined ? undefined : parsed.review ? JSON.stringify(parsed.review) : null,
    });
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
    if (!profile) return null;

    if (profile.engine === 'claude') {
      const account = this.coreProfileService.readClaudeAccount(profile.home || os.homedir());
      if (account?.email && account.email !== profile.email) {
        this.profileRepo.upsert({ ...profile, email: account.email });
        this.scheduler.getEventBus().emit('profile.updated', undefined, { name: profile.name, email: account.email });
      }
      return account?.email || profile.email || null;
    }

    const logDir =
      profile.kind === 'keyring'
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
        const duplicateWarning = dupes.has(`${profile.engine}:${email}`);
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
      if (p.engine === 'claude') {
        const account = this.coreProfileService.readClaudeAccount(p.home || os.homedir());
        if (account?.email && account.email !== p.email) {
          this.profileRepo.upsert({ ...p, email: account.email });
          p.email = account.email;
        }
      }
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
      if (p.engine === 'codex' && !p.email && this.isProfileLoggedIn(p)) {
        const lastCheck = this.emailCheckCache.get(p.name) || 0;
        if (now - lastCheck > 30_000) {
          this.emailCheckCache.set(p.name, now);
          const email = this.refreshCodexEmail(p);
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
      const claudeAccount = p.engine === 'claude' ? this.coreProfileService.readClaudeAccount(p.home || os.homedir()) : null;
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
        ...(p.engine === 'claude' ? {
          claudeTokens: this.getClaudeTokenTotals(),
          limitedSessions: this.getClaudeProfileLimitedSessions(p),
        } : {}),
        duplicateWarning: dupes.has(accountKey(p) || ''),
        ...(claudeAccount?.plan ? { claudePlan: claudeAccount.plan } : {}),
      };
    });
  }

  createProfile(raw: unknown): ProfileRow {
    const parsed = CreateProfileSchema.parse(raw);
    if (!this.config.multiplePerProvider && parsed.accountType === 'personal') {
      const existing = this.profileRepo.getAll().find((profile) => profile.engine === parsed.engine && profile.accountType === 'personal');
      if (existing) {
        throw new HttpError(409, 'provider_policy', `Đã có hồ sơ cá nhân cho engine ${parsed.engine}; hãy dùng hồ sơ API/Team hoặc bật multiplePerProvider`);
      }
    }
    if (this.profileRepo.get(parsed.name)) {
      if (!this.profileRepo.isDeleted(parsed.name)) {
        throw new HttpError(409, 'conflict', `Hồ sơ "${parsed.name}" đã tồn tại`);
      }
      // Re-adding a deleted profile brings the same name back.
      this.profileRepo.restore(parsed.name);
    }

    this.coreProfileService.createProfile(parsed.name, parsed.engine, parsed.accountType);
    this.scheduler.getEventBus().emit('profile.created', undefined, { name: parsed.name });
    this.scheduler.wakeWaitingQuotaTasks('profile_created');

    return apiProfile(this.profileRepo.get(parsed.name)!);
  }

  deleteProfile(name: string, purgeHome = false): { ok: boolean } {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    if (profile.kind === 'system' || profile.kind === 'keyring') {
      throw new HttpError(400, 'bad_request', 'Không thể xóa hồ sơ hệ thống hoặc keyring');
    }

    const runningMap = this.scheduler.getRunning();
    const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === name);
    const hasReviewer = this.scheduler.reviewerRunsForProfile(name);
    if (isBusy || hasReviewer) {
      throw new HttpError(409, 'conflict', `Không thể xóa hồ sơ "${name}" đang chạy task`);
    }

    try {
      this.coreProfileService.deleteProfile(name, purgeHome);
    } catch (error) {
      throw new HttpError(400, 'bad_request', error instanceof Error ? error.message : String(error));
    }
    this.emailCheckCache.delete(name);
    this.profileChecks.delete(name);
    this.scheduler.getEventBus().emit('profile.deleted', undefined, { name });
    return { ok: true };
  }

  renameProfile(name: string, raw: unknown): ProfileRow {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }

    const parsed = RenameProfileSchema.parse(raw);
    const newName = parsed.newName;
    if (newName === name) {
      return apiProfile(profile);
    }

    const existing = this.profileRepo.get(newName);
    if (existing) {
      throw new HttpError(409, 'conflict', `Hồ sơ "${newName}" đã tồn tại`);
    }

    const runningMap = this.scheduler.getRunning();
    const isBusy = Array.from(runningMap.values()).some((r) => r.profileName === name);
    const hasReviewer = this.scheduler.reviewerRunsForProfile(name);
    if (isBusy || hasReviewer) {
      throw new HttpError(409, 'conflict', `Không thể đổi tên hồ sơ "${name}" đang chạy task`);
    }

    let newHome: string | undefined;
    let oldHomeToRollback: string | undefined;

    if (profile.home && fs.existsSync(profile.home)) {
      const managedRoots = [
        path.resolve(this.config.agyHomesDir),
        path.resolve(this.config.hubHome, 'codex-homes'),
        path.resolve(this.config.hubHome, 'claude-homes'),
      ];

      let realHome: string;
      try {
        realHome = fs.realpathSync(profile.home);
      } catch {
        realHome = path.resolve(profile.home);
      }

      const matchedRoot = managedRoots.find((rootPath) => {
        try {
          const realRoot = fs.existsSync(rootPath) ? fs.realpathSync(rootPath) : rootPath;
          if (realHome === realRoot) return false;
          const rel = path.relative(realRoot, realHome);
          return !!rel && rel !== '.' && rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
        } catch {
          return false;
        }
      });

      if (matchedRoot) {
        const targetDir = path.join(path.dirname(profile.home), newName);
        if (fs.existsSync(targetDir)) {
          throw new HttpError(409, 'conflict', `Thư mục "${targetDir}" đã tồn tại trên đĩa`);
        }
        try {
          fs.renameSync(profile.home, targetDir);
          newHome = targetDir;
          oldHomeToRollback = profile.home;
        } catch (err) {
          throw new HttpError(500, 'internal_error', `Không thể đổi tên thư mục: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }

    try {
      this.profileRepo.rename(name, newName, newHome);
    } catch (err) {
      if (oldHomeToRollback && newHome) {
        try {
          fs.renameSync(newHome, oldHomeToRollback);
        } catch {
          // ignore rollback failure
        }
      }
      throw err;
    }

    this.emailCheckCache.delete(name);
    this.profileChecks.delete(name);

    this.scheduler.getEventBus().emit('profile.updated', undefined, { name: newName, oldName: name });

    return apiProfile(this.profileRepo.get(newName)!);
  }

  private refreshCodexEmail(profile: ProfileRow): string | null {
    if (profile.engine !== 'codex') return null;
    const codexPath = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
    if (!codexPath) return null;
    const checkEnv: NodeJS.ProcessEnv = { ...process.env };
    if (profile.kind === 'isolated' && profile.home) {
      checkEnv.CODEX_HOME = profile.home;
    }
    try {
      const res = execFileSync(codexPath, ['login', 'status'], { env: checkEnv, timeout: 5000, encoding: 'utf8' });
      const parsed = parseCodexLoginStatus(res);
      if (parsed.email && parsed.email !== profile.email) {
        this.profileRepo.upsert({ ...profile, email: parsed.email });
        return parsed.email;
      }
    } catch {
      // ignore
    }
    return null;
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
      } else if (profile.engine === 'claude') {
        // Claude profiles: login state comes from the Claude config dir, not from the Codex CLI.
        const account = this.coreProfileService.readClaudeAccount(profile.home || os.homedir());
        if (!isProfileLoggedIn(profile)) {
          message = 'Chưa đăng nhập Claude';
          // Drop an email left by an earlier wrong check (it used to report the Codex/ChatGPT login).
          if (profile.email) {
            this.profileRepo.upsert({ ...profile, email: null });
            email = undefined;
          }
          this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
        } else {
          ok = true;
          if (account?.email) {
            email = account.email;
            if (account.email !== profile.email) this.profileRepo.upsert({ ...profile, email: account.email });
          }
          this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
          const usage = await this.usageService.collectClaude(profile, true);
          message = account?.plan ? `Đã đăng nhập Claude (${account.plan})` : 'Đã đăng nhập Claude';
          if (usage.length === 0) message += ' · chưa đọc được quota /usage';
        }
      } else {
        const codexPath = process.env.AGENTHUB_CODEX_BIN || CodexEngine.findCodexPath();
        if (!codexPath) {
          message = 'Không tìm thấy Codex CLI';
          this.profileRepo.updateAuthState(profile.name, 'error', message, null);
        } else {
          const checkEnv: NodeJS.ProcessEnv = { ...process.env };
          if (profile.kind === 'isolated' && profile.home) {
            checkEnv.CODEX_HOME = profile.home;
          }
          try {
            const result = await execFileAsync(codexPath, ['login', 'status'], {
              env: checkEnv,
              timeout: 20_000,
            });
            output = `${result.stdout}${result.stderr}`;
            const parsed = parseCodexLoginStatus(output);
            if (parsed.notLoggedIn) {
              ok = false;
              message = 'Chưa đăng nhập';
              this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
            } else {
              ok = true;
              message = parsed.plan ? `Đã đăng nhập (${parsed.plan})` : 'Đã đăng nhập';
              if (parsed.email) {
                email = parsed.email;
                this.profileRepo.upsert({ ...profile, email: parsed.email });
              }
              this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
            }
          } catch (execErr) {
            const err = execErr as { stdout?: string; stderr?: string; message?: string };
            output = `${err.stdout || ''}${err.stderr || ''}`;
            const parsed = parseCodexLoginStatus(output);
            if (parsed.notLoggedIn) {
              ok = false;
              message = 'Chưa đăng nhập';
              this.profileRepo.updateAuthState(profile.name, 'not_logged_in', message, null);
            } else {
              try {
                const verResult = await execFileAsync(codexPath, ['--version'], { env: checkEnv, timeout: 5000 });
                output = `${verResult.stdout}${verResult.stderr}`;
                ok = true;
                message = output.trim() || 'Codex CLI sẵn sàng';
                this.profileRepo.updateAuthState(profile.name, 'ok', null, null);
              } catch {
                ok = false;
                message = err.message || 'Kiểm tra thất bại';
                this.profileRepo.updateAuthState(profile.name, 'error', message, null);
              }
            }
          }
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
    if (profile.engine === 'codex') this.usageService.collectCodex(profile);
    else if (profile.engine === 'claude') await this.usageService.collectClaude(profile, true);
    else await this.usageService.collect(profile);
    this.refreshProfileEmail(profile.name);
    return this.listProfiles().find((p) => p.name === name);
  }

  updateProfile(name: string, raw: unknown): ProfileRow {
    const profile = this.profileRepo.get(name);
    if (!profile || profile.deletedAt) {
      throw new HttpError(404, 'not_found', `Hồ sơ "${name}" không tồn tại`);
    }

    const parsed = UpdateProfileSchema.parse(raw);
    const updates: Partial<Pick<ProfileRow, 'label' | 'notes' | 'priority' | 'enabled'>> = {};

    let wasDisabled = false;
    let enabledNum: number | undefined;
    if (parsed.enabled !== undefined) {
      enabledNum = typeof parsed.enabled === 'boolean' ? (parsed.enabled ? 1 : 0) : parsed.enabled;
      updates.enabled = enabledNum;
      wasDisabled = profile.enabled === 0;
    }
    if (parsed.label !== undefined) {
      updates.label = parsed.label;
    }
    if (parsed.notes !== undefined) {
      updates.notes = parsed.notes;
    }
    if (parsed.priority !== undefined) {
      updates.priority = parsed.priority;
    }

    this.profileRepo.update(name, updates);

    this.scheduler.getEventBus().emit('profile.updated', undefined, {
      name,
      ...(enabledNum !== undefined ? { enabled: enabledNum } : {}),
      ...(parsed.label !== undefined ? { label: parsed.label } : {}),
      ...(parsed.notes !== undefined ? { notes: parsed.notes } : {}),
      ...(parsed.priority !== undefined ? { priority: parsed.priority } : {}),
    });

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
      const project = this.projectRepo.get(task.projectId);
      let reviewChain = parseReviewChain(project?.reviewChain);
      if (project?.review) {
        try { reviewChain = parseReviewChain(JSON.stringify((JSON.parse(project.review) as { chain?: unknown }).chain || [])); } catch { /* invalid settings are ignored */ }
      }
      return {
        ...apiTask(task),
        reviewChain,
        checks: this.scheduler.getCheckResults(task.id),
        paused: Boolean(run?.paused),
        pauseReason: run?.pauseReason ?? null,
        currentRun: run ? {
          startedAt: new Date(run.startTime).toISOString(),
          lastOutputAt: new Date(run.lastOutputAt).toISOString(),
          lastActivityAt: new Date(run.lastActivityAt).toISOString(),
          activitySource: run.activitySource,
          noCommitMinutes: run.noCommitMinutes ?? null,
          isLooping: run.isLooping ?? false,
          loopingCommand: run.loopingCommand ?? null,
          paused: Boolean(run.paused),
          pauseReason: run.pauseReason ?? null,
          rss: run.rss ?? 0,
          cpu: run.cpu ?? 0,
        } : null,
      };
    }) as TaskRow[];
  }

  getTasksGraph(options?: { project?: string; includeDone?: string | boolean }) {
    const tasks = this.listTasks({ project: options?.project });
    const filtered = filterTasksForGraph(tasks, options);
    return computeTaskGraph(filtered);
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

    if (task.doneReport !== null && task.doneReport !== undefined) {
      doneContent = task.doneReport;
    } else if (task.worktreePath && fs.existsSync(task.worktreePath)) {
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
    const reviewSettings = project?.review ? (() => {
      try { return JSON.parse(project.review!) as { chain?: unknown; maxRounds?: number }; } catch { return null; }
    })() : null;
    let commits: string[] = [];
    if (project && task.branch) {
      const baseRef = task.baseRef || project.defaultBranch;
      commits = await getGitCommits(project.path, baseRef, task.branch);
    }

    const activeRun = this.scheduler.getRunning().get(taskId);
    let modelWarnings: string[] = [];
    try {
      const chain = task.modelChain ? JSON.parse(task.modelChain) as unknown : [];
      if (Array.isArray(chain)) {
        modelWarnings = chain.filter((model): model is string => typeof model === 'string' && !isKnownModel(model));
      }
    } catch {
      modelWarnings = ['modelChain không phải JSON hợp lệ'];
    }
    return {
      ...apiTask(task),
      paused: Boolean(activeRun?.paused),
      pauseReason: activeRun?.pauseReason ?? null,
      currentRun: activeRun ? {
        startedAt: new Date(activeRun.startTime).toISOString(),
        lastOutputAt: new Date(activeRun.lastOutputAt).toISOString(),
        lastActivityAt: new Date(activeRun.lastActivityAt).toISOString(),
        activitySource: activeRun.activitySource,
        noCommitMinutes: activeRun.noCommitMinutes ?? null,
        isLooping: activeRun.isLooping ?? false,
        loopingCommand: activeRun.loopingCommand ?? null,
        paused: Boolean(activeRun.paused),
        pauseReason: activeRun.pauseReason ?? null,
        rss: activeRun.rss ?? 0,
        cpu: activeRun.cpu ?? 0,
      } : null,
      runs: runs.map(apiRun),
      reviews: reviews.map(apiReview),
      reviewChain: reviewSettings?.chain || parseReviewChain(project?.reviewChain),
      reviewStep: task.reviewStep ?? 0,
      reviewMaxRounds: reviewSettings?.maxRounds || 2,
      doneContent,
      blockedContent,
      modelWarnings,
      commits,
      worktreePath: task.worktreePath,
      checks: this.scheduler.getCheckResults(taskId),
      sourceRef: task.sourceRef ? JSON.parse(task.sourceRef) : null,
      derivedTasks: this.taskRepo.getDerivedFrom(taskId).map(apiTask),
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

    let initialStatus = parsed.start ? 'queued' : 'draft';
    let batchId = parsed.batchId || null;

    if (parsed.fromClaude && this.config.planning?.requireApproval) {
      initialStatus = 'draft';
      if (!batchId && this.taskBatchRepo) {
        const existingDraftBatches = this.taskBatchRepo.list(parsed.project, 'draft')
          .filter((b) => b.createdBy === 'claude');
        if (existingDraftBatches.length > 0) {
          batchId = existingDraftBatches[0].id;
        } else {
          const newBatchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
          this.taskBatchRepo.create({
            id: newBatchId,
            projectId: parsed.project,
            title: `Kế hoạch đề xuất: ${parsed.title}`,
            goal: `Tạo từ Claude qua hub_create_task`,
            status: 'draft',
            createdBy: 'claude',
          });
          batchId = newBatchId;
          const payload = {
            batchId: newBatchId,
            projectId: parsed.project,
            title: `Kế hoạch đề xuất: ${parsed.title}`,
            taskCount: 1,
            createdBy: 'claude',
          };
          this.eventRepo.insert('batch.created', undefined, payload);
          this.scheduler.getEventBus().emit('batch.created', undefined, payload);
        }
      }
    }

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
      sourceRef: parsed.sourceRef ? JSON.stringify(parsed.sourceRef) : null,
      batchId,
    });

    if (initialStatus === 'queued') {
      this.scheduler.getEventBus().emit('task.queued', taskId);
      this.scheduler.triggerTick();
    }

    return this.taskRepo.get(taskId)!;
  }

  captureTask(raw: unknown): TaskRow {
    const parsed = CaptureTaskSchema.parse(raw);
    const sourceTaskId = toTaskId(parsed.sourceTaskId);
    const source = this.taskRepo.get(sourceTaskId);
    if (!source) throw new HttpError(404, 'not_found', `Task nguồn "${sourceTaskId}" không tồn tại`);
    const project = this.projectRepo.get(source.projectId);
    if (!project) throw new HttpError(404, 'not_found', `Project "${source.projectId}" không tồn tại`);
    const excerpt = truncateExcerpt(parsed.excerpt);
    const location = extractFileLocations(excerpt)[0];
    const sourceRef = {
      taskId: source.id,
      runId: parsed.runId || null,
      checkName: parsed.checkName || null,
      excerptHash: excerptHash(excerpt),
    };
    const body = parsed.body || [
      `## Lỗi phát sinh từ ${source.id}`,
      '',
      `- Check: ${parsed.checkName || 'log'}`,
      `- Nhánh nguồn: ${source.branch || source.baseRef || project.defaultBranch}`,
      location ? `- Vị trí: ${location.file}:${location.line}` : '- Vị trí: không trích xuất được từ stack trace',
      '',
      toMarkdownCodeBlock(excerpt),
    ].join('\n');
    const baseRef = source.status === 'done' ? (source.baseRef || project.defaultBranch) : (source.branch || source.baseRef || project.defaultBranch);
    return this.createTask({
      project: source.projectId,
      slug: parsed.slug,
      title: parsed.title || `${parsed.checkName || 'Lỗi'}: ${excerpt.split(/\r?\n/).find((line) => line.trim())?.trim().slice(0, 100) || source.title}`,
      body,
      level: parsed.level,
      baseRef,
      sourceRef,
      start: parsed.start,
    });
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
        let normId = toTaskId(depId);
        let depTask = this.taskRepo.get(normId);
        if (!depTask && !normId.includes('/') && task.projectId) {
          const qualified = `${task.projectId}/${normId}`;
          if (this.taskRepo.get(qualified)) {
            normId = qualified;
            depTask = this.taskRepo.get(qualified);
          }
        }
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

  createBatch(raw: unknown): TaskBatchRow & { tasks: TaskRow[] } {
    const parsed = CreateBatchSchema.parse(raw);
    const project = this.projectRepo.get(parsed.project);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${parsed.project}" không tồn tại`);
    }
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }

    const slugs = new Set<string>();
    for (const t of parsed.tasks) {
      if (slugs.has(t.slug)) {
        throw new HttpError(400, 'bad_request', `Trùng slug "${t.slug}" trong cùng đợt`);
      }
      slugs.add(t.slug);
      const taskId = `${parsed.project}/${t.slug}`;
      if (this.taskRepo.get(taskId)) {
        throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
      }
    }

    const batchId = `batch-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const createdBy = parsed.createdBy || 'claude';
    this.taskBatchRepo.create({
      id: batchId,
      projectId: parsed.project,
      title: parsed.title,
      goal: parsed.goal || null,
      status: 'draft',
      createdBy,
    });

    const createdTasks: TaskRow[] = [];
    const taskDepsToPopulate: Array<{ taskId: string; deps: string[] }> = [];

    for (const t of parsed.tasks) {
      const taskId = `${parsed.project}/${t.slug}`;
      const normalizedDeps: string[] = (t.dependsOn || []).map((dep) => {
        if (!dep.includes('/') && !dep.includes('~')) {
          return `${parsed.project}/${dep}`;
        }
        return toTaskId(dep);
      });

      this.taskRepo.insert({
        id: taskId,
        projectId: parsed.project,
        slug: t.slug,
        title: t.title,
        body: t.body,
        level: t.level,
        modelChain: t.modelChain ? JSON.stringify(t.modelChain) : undefined,
        dependsOn: normalizedDeps,
        status: 'draft',
        batchId,
        skipDeps: true,
      });
      taskDepsToPopulate.push({ taskId, deps: normalizedDeps });
      createdTasks.push(apiTask(this.taskRepo.get(taskId)!));
    }

    // Phase 2: populate task_deps now that all tasks exist in DB
    for (const item of taskDepsToPopulate) {
      this.taskRepo.populateDeps(item.taskId, item.deps);
    }

    const payload = {
      batchId,
      projectId: parsed.project,
      title: parsed.title,
      goal: parsed.goal || null,
      taskCount: createdTasks.length,
      createdBy,
    };
    this.eventRepo.insert('batch.created', undefined, payload);
    this.scheduler.getEventBus().emit('batch.created', undefined, payload);

    const batchRow = apiBatch(this.taskBatchRepo.get(batchId)!);
    return { ...batchRow, tasks: createdTasks };
  }

  getBatch(id: string): TaskBatchRow & { tasks: TaskRow[] } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    const tasks = this.taskRepo.getByBatch(id).map(apiTask);
    return { ...apiBatch(batch), tasks };
  }

  listBatches(params?: { project?: string; status?: string }): TaskBatchRow[] {
    if (!this.taskBatchRepo) return [];
    return this.taskBatchRepo.list(params?.project, params?.status).map(apiBatch);
  }

  dispatchBatch(id: string): { ok: boolean; batchId: string; dispatchedCount: number } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể giao đợt ở trạng thái draft (hiện tại: ${batch.status})`);
    }
    const tasks = this.taskRepo.getByBatch(id);
    const draftTasks = tasks.filter((t) => t.status === 'draft');
    if (draftTasks.length === 0) {
      throw new HttpError(400, 'bad_request', `Đợt "${id}" không có task nào ở trạng thái draft`);
    }

    const projectTasks = this.taskRepo.getByProject(batch.projectId);
    const cycle = detectCycle(projectTasks);
    if (cycle) {
      throw new HttpError(400, 'cycle_detected', `Phát hiện vòng phụ thuộc: ${cycle.join(' -> ')}`);
    }

    for (const task of draftTasks) {
      this.taskRepo.updateStatus(task.id, 'queued');
      this.eventRepo.insert('task.queued', task.id, { fromBatch: id });
      this.scheduler.getEventBus().emit('task.queued', task.id);
    }

    this.taskBatchRepo.updateStatus(id, 'dispatched');
    const payload = { batchId: id, projectId: batch.projectId, dispatchedCount: draftTasks.length };
    this.eventRepo.insert('batch.dispatched', undefined, payload);
    this.scheduler.getEventBus().emit('batch.dispatched', undefined, payload);
    this.scheduler.triggerTick();

    return { ok: true, batchId: id, dispatchedCount: draftTasks.length };
  }

  discardBatch(id: string): { ok: boolean; batchId: string } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(id);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${id}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể huỷ đợt ở trạng thái draft (hiện tại: ${batch.status})`);
    }
    const tasks = this.taskRepo.getByBatch(id);
    for (const task of tasks) {
      if (task.status === 'draft') {
        this.taskRepo.updateStatus(task.id, 'cancelled');
      }
    }
    this.taskBatchRepo.updateStatus(id, 'discarded');
    const payload = { batchId: id, projectId: batch.projectId };
    this.eventRepo.insert('batch.discarded', undefined, payload);
    this.scheduler.getEventBus().emit('batch.discarded', undefined, payload);

    return { ok: true, batchId: id };
  }

  addTaskToBatch(batchId: string, raw: unknown): TaskRow {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${batchId}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể thêm task vào đợt ở trạng thái draft`);
    }

    const parsed = BatchTaskInputSchema.parse(raw);
    const taskId = `${batch.projectId}/${parsed.slug}`;
    if (this.taskRepo.get(taskId)) {
      throw new HttpError(409, 'conflict', `Task "${taskId}" đã tồn tại`);
    }

    const normalizedDeps: string[] = (parsed.dependsOn || []).map((dep) => {
      if (!dep.includes('/') && !dep.includes('~')) {
        return `${batch.projectId}/${dep}`;
      }
      return toTaskId(dep);
    });

    this.taskRepo.insert({
      id: taskId,
      projectId: batch.projectId,
      slug: parsed.slug,
      title: parsed.title,
      body: parsed.body,
      level: parsed.level,
      modelChain: parsed.modelChain ? JSON.stringify(parsed.modelChain) : undefined,
      dependsOn: normalizedDeps,
      status: 'draft',
      batchId,
    });

    return apiTask(this.taskRepo.get(taskId)!);
  }

  removeTaskFromBatch(batchId: string, idParam: string): { ok: boolean } {
    if (!this.taskBatchRepo) {
      throw new HttpError(500, 'internal_error', 'TaskBatchRepo chưa được khởi tạo');
    }
    const batch = this.taskBatchRepo.get(batchId);
    if (!batch) {
      throw new HttpError(404, 'not_found', `Đợt "${batchId}" không tồn tại`);
    }
    if (batch.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể bỏ task khỏi đợt ở trạng thái draft`);
    }

    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.batchId !== batchId) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không thuộc đợt "${batchId}"`);
    }
    if (task.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể bỏ task ở trạng thái draft (hiện tại: ${task.status})`);
    }

    this.taskRepo.delete(taskId);

    const batchTasks = this.taskRepo.getByBatch(batchId);
    for (const otherTask of batchTasks) {
      let deps = parseDependsOn(otherTask.dependsOn);
      if (deps.includes(taskId) || deps.includes(task.slug)) {
        deps = deps.filter((d: string) => d !== taskId && d !== task.slug);
        this.taskRepo.update(otherTask.id, { dependsOn: JSON.stringify(deps) });
      }
    }

    return { ok: true };
  }

  deleteTask(idParam: string): { ok: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'draft') {
      throw new HttpError(400, 'bad_request', `Chỉ có thể xoá task ở trạng thái draft (hiện tại: ${task.status})`);
    }
    this.taskRepo.delete(taskId);
    return { ok: true };
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

  pauseTask(idParam: string): { ok: boolean; paused: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    const rt = this.scheduler.getRunning().get(taskId);
    if (!rt) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái running`);
    }
    this.scheduler.pauseTask(taskId, 'manual');
    return { ok: true, paused: true };
  }

  resumeTask(idParam: string): { ok: boolean; paused: boolean } {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    const rt = this.scheduler.getRunning().get(taskId);
    if (!rt) {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái running`);
    }
    this.scheduler.resumeTask(taskId);
    return { ok: true, paused: false };
  }

  async reviewTask(idParam: string, raw: unknown): Promise<TaskRow> {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }
    if (task.status !== 'review') {
      throw new HttpError(400, 'bad_request', `Task "${taskId}" không ở trạng thái review (hiện tại: ${task.status})`);
    }

    const parsed = ReviewTaskSchema.parse(raw);

    let mergeResult: { mergeCommit: string; checks: string[] } | undefined;
    if (parsed.verdict === 'approved' && parsed.merge) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) throw new HttpError(404, 'not_found', `Project "${task.projectId}" không tồn tại`);
      try {
        mergeResult = await mergeTaskIntoBase(task, project);
      } catch (error) {
        if (error instanceof MergeError) {
          this.createMergeFailureDraft(task, error.message);
          throw new HttpError(error.statusCode, error.error, error.message);
        }
        throw error;
      }
    }

    const reviewId = crypto.randomUUID();
    this.reviewRepo.insert({
      id: reviewId,
      taskId,
      verdict: parsed.verdict,
      feedback: parsed.feedback || null,
      actor: parsed.by || 'claude',
    });

    this.scheduler.reviewTask(taskId, parsed.verdict, parsed.feedback, parsed.by);
    if (parsed.verdict === 'approved' && this.knowledgeRepo) {
      const completed = this.taskRepo.get(taskId);
      const donePath = completed?.worktreePath ? path.join(completed.worktreePath, '.agenthub', 'DONE') : null;
      const doneContent = completed?.doneReport || (donePath && fs.existsSync(donePath) ? fs.readFileSync(donePath, 'utf-8') : '');
      const knowledge = extractKnowledgeSection(doneContent);
      if (knowledge) this.knowledgeRepo.insert({ projectId: task.projectId, taskId, content: knowledge });
    }
    if (mergeResult) {
      this.exportKnowledgeFile(task.projectId);
      this.scheduler.getEventBus().emit('task.merged', taskId, mergeResult);
    }
    return this.taskRepo.get(taskId)!;
  }

  private createMergeFailureDraft(source: TaskRow, output: string): TaskRow | null {
    const slugBase = `${source.slug}-fix-merge`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 60);
    let slug = slugBase;
    for (let index = 2; this.taskRepo.get(`${source.projectId}/${slug}`); index += 1) slug = `${slugBase}-${index}`;
    try {
      return this.captureTask({
        sourceTaskId: source.id,
        slug,
        checkName: 'merge',
        excerpt: output,
        title: `Sửa lỗi merge: ${source.title}`,
        level: 'easy',
        start: false,
      });
    } catch {
      return null;
    }
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
      let hooks = null;
      if (project?.hooks) {
        try {
          hooks = JSON.parse(project.hooks);
        } catch {
          // ignore invalid json
        }
      }
      // Chỉ xóa đường dẫn nằm hẳn trong worktreesDir và không phải gốc project (sự cố 16/10).
      const removed = new WorktreeService(this.config, this.scheduler.getEventBus()).remove(
        project?.path ?? null,
        task.worktreePath,
        {
          slot: task.slot,
          slug: task.slug,
          projectId: task.projectId,
          taskId: task.id,
          hooks,
        },
      );
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

  // --- Task Notes ---
  createTaskNote(idParam: string, raw: unknown): TaskNoteRow {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const parsed = CreateTaskNoteSchema.parse(raw);
    if (!this.taskNoteRepo) {
      throw new HttpError(500, 'internal_error', 'TaskNoteRepo chưa được khởi tạo');
    }

    const note = this.taskNoteRepo.insert({
      projectId: task.projectId,
      taskId: task.id,
      kind: parsed.kind,
      content: parsed.content,
    });

    if (this.bulletinService) {
      this.bulletinService.updateBulletinsForProject(task.projectId);
    }

    this.scheduler.getEventBus().emit(
      parsed.kind === 'overlap' ? 'task.overlap' : 'task.note',
      task.id,
      {
        id: note.id,
        content: note.content,
        projectId: task.projectId,
      },
    );

    return apiTaskNote(note);
  }

  getProjectNotes(
    projectId: string,
    query?: { since?: string; runningOnly?: string; taskId?: string },
  ): TaskNoteRow[] {
    const project = this.projectRepo.get(projectId);
    if (!project) {
      throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    }

    const sinceId = query?.since ? parseInt(query.since, 10) : undefined;
    let notes = this.taskNoteRepo ? this.taskNoteRepo.getByProject(projectId, sinceId) : [];

    if (query?.taskId) {
      const filterTaskId = toTaskId(query.taskId);
      notes = notes.filter((n) => n.taskId === filterTaskId);
    }

    if (query?.runningOnly === 'true' || query?.runningOnly === '1') {
      const runningTaskIds = new Set(this.taskRepo.getByStatus('running').map((t) => t.id));
      notes = notes.filter((n) => runningTaskIds.has(n.taskId));
    }

    return notes.map(apiTaskNote);
  }

  getTaskNotes(idParam: string): TaskNoteRow[] {
    const taskId = toTaskId(idParam);
    const task = this.taskRepo.get(taskId);
    if (!task) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không tồn tại`);
    }

    const notes = this.taskNoteRepo ? this.taskNoteRepo.getByTask(taskId) : [];
    return notes.map(apiTaskNote);
  }

  listKnowledge(projectId: string): KnowledgeEntryRow[] {
    if (!this.projectRepo.get(projectId)) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    return this.knowledgeRepo?.getByProject(projectId).map(apiKnowledgeEntry) || [];
  }

  addKnowledge(projectId: string, raw: unknown): KnowledgeEntryRow {
    if (!this.projectRepo.get(projectId)) throw new HttpError(404, 'not_found', `Project "${projectId}" không tồn tại`);
    const parsed = CreateKnowledgeSchema.parse(raw);
    const taskId = parsed.taskId ? toTaskId(parsed.taskId) : `manual/${projectId}`;
    if (parsed.taskId && (!this.taskRepo.get(taskId) || this.taskRepo.get(taskId)!.projectId !== projectId)) {
      throw new HttpError(404, 'not_found', `Task "${taskId}" không thuộc project`);
    }
    if (!this.knowledgeRepo) throw new HttpError(500, 'internal_error', 'KnowledgeRepo chưa được khởi tạo');
    return apiKnowledgeEntry(this.knowledgeRepo.insert({ projectId, taskId, content: parsed.content, pinned: parsed.pinned }));
  }

  updateKnowledge(projectId: string, id: string, raw: unknown): KnowledgeEntryRow {
    const entryId = Number(id);
    const entry = this.knowledgeRepo?.get(entryId);
    if (!entry || entry.projectId !== projectId) throw new HttpError(404, 'not_found', 'Mục kiến thức không tồn tại');
    const parsed = UpdateKnowledgeSchema.parse(raw);
    const updated = this.knowledgeRepo!.update(entryId, parsed);
    return apiKnowledgeEntry(updated!);
  }

  deleteKnowledge(projectId: string, id: string): { ok: boolean } {
    const entryId = Number(id);
    const entry = this.knowledgeRepo?.get(entryId);
    if (!entry || entry.projectId !== projectId) throw new HttpError(404, 'not_found', 'Mục kiến thức không tồn tại');
    this.knowledgeRepo!.delete(entryId);
    return { ok: true };
  }

  private exportKnowledgeFile(projectId: string): void {
    const target = this.config.context.knowledgeFile;
    const project = this.projectRepo.get(projectId);
    if (!target || !project || !this.knowledgeRepo) return;
    const entries = this.knowledgeRepo.getByProject(projectId);
    const content = ['# Sổ kiến thức dự án', '', ...entries.map((entry) => `- ${entry.content} _(task: ${entry.taskId})`)].join('\n') + '\n';
    const filePath = path.resolve(project.path, target);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf-8');
  }

  // --- Scheduler control ---
  pauseScheduler(): { ok: boolean; paused: boolean } {
    this.scheduler.pause();
    return { ok: true, paused: true };
  }

  resumeScheduler(): { ok: boolean; paused: boolean } {
    this.scheduler.resume();
    return { ok: true, paused: false };
  }

  isSchedulerPaused(): boolean {
    return this.scheduler.isPaused();
  }

  // --- Telegram ---
  setTelegramBotService(botService: TelegramBotService): void {
    this.telegramBotService = botService;
  }

  getTelegramStatus() {
    return {
      enabled: this.config.telegram.enabled,
      hasToken: Boolean(this.telegramBotService?.hasValidToken()),
      chats: this.config.telegram.chats || [],
      allowedChatIds: this.config.telegram.allowedChatIds,
      notify: this.config.telegram.notify,
    };
  }

  getTelegramPairingCode(refresh = false): { code: string; expiresInSec: number; enabled: boolean; allowedChatIds: number[]; chats: TelegramChat[] } {
    if (!this.telegramBotService) {
      throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    }
    const pairing = this.telegramBotService.getPairingCode(refresh);
    return {
      ...pairing,
      enabled: this.config.telegram?.enabled ?? false,
      allowedChatIds: this.config.telegram?.allowedChatIds ?? [],
      chats: this.config.telegram?.chats ?? [],
    };
  }

  saveTelegramToken(token: string): { hasToken: boolean } {
    const value = token.trim();
    if (!value) throw new HttpError(400, 'bad_request', 'Bot token không được để trống');
    const tokenPath = this.config.telegram.botTokenFile;
    fs.mkdirSync(path.dirname(tokenPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(tokenPath, `${value}\n`, { mode: 0o600 });
    fs.chmodSync(tokenPath, 0o600);
    this.telegramBotService?.setToken(value);
    return { hasToken: true };
  }

  async testTelegram(): Promise<{ ok: boolean; bot: { id: number; name: string; username?: string } }> {
    if (!this.telegramBotService) throw new HttpError(500, 'internal_error', 'Telegram bot service chưa sẵn sàng');
    try {
      return { ok: true, bot: await this.telegramBotService.testConnection() };
    } catch (error) {
      throw new HttpError(502, 'telegram_error', error instanceof Error ? error.message : 'Không thể kết nối Telegram');
    }
  }

  removeTelegramChat(chatId: number): { ok: boolean } {
    this.config.telegram.allowedChatIds = this.config.telegram.allowedChatIds.filter((id) => id !== chatId);
    this.config.telegram.chats = (this.config.telegram.chats || []).filter((chat) => chat.id !== chatId);
    updateConfigInMemory(this.config, { telegram: this.config.telegram });
    saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    return { ok: true };
  }

  // --- Config ---
  getConfig() {
    return {
      modelChainHard: this.config.defaultModelChains.hard,
      modelChainEasy: this.config.defaultModelChains.easy,
      defaultTimeout: this.config.defaultTimeout,
      slotsPerAgyProfile: this.config.slotsPerAgyProfile,
      multiplePerProvider: this.config.multiplePerProvider,
      planning: this.config.planning,
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
        permissionTimeoutSec: this.config.chat.permissionTimeoutSec,
        model: this.config.chat.model,
        autoCompactPercent: this.config.chat.autoCompactPercent ?? 85,
        models: this.config.chat.models,
      },
      brain: {
        mode: this.config.brain.mode,
        digest: this.config.brain.digest,
        fallback: this.config.brain.fallback,
        policy: this.config.brain.policy,
      },
      reviewer: this.config.reviewer,
      notifications: this.config.notifications,
      savings: this.config.savings,
      load: this.config.load,
      stall: this.config.stall,
      disk: this.config.disk,
      context: this.config.context,
      telegram: {
        enabled: this.config.telegram.enabled,
        botTokenFile: this.config.telegram.botTokenFile,
        allowedChatIds: this.config.telegram.allowedChatIds,
        chats: this.config.telegram.chats,
        notify: this.config.telegram.notify,
      },
    };
  }

  getModelOptions() {
    const profiles = this.profileRepo.getAll().filter((profile) => Boolean(profile.enabled));
    const suggestions = new Set<string>();
    for (const profile of profiles) {
      if (profile.engine === 'agy') {
        for (const model of VALID_AGY_MODELS) suggestions.add(model);
      } else if (profile.engine === 'codex') {
        suggestions.add('codex:gpt-5.6-luna');
      }
    }
    const configured = [...this.config.defaultModelChains.hard, ...this.config.defaultModelChains.easy, this.config.reviewer.model];
    const configuredModels = [...new Set(configured.filter(Boolean))];
    return { suggestions: [...suggestions].sort(), configured: configuredModels };
  }

  updateConfig(raw: unknown) {
    const parsed = UpdateConfigSchema.parse(raw);

    // Apply in-memory
    updateConfigInMemory(this.config, parsed);
    if (parsed.brain?.fallback) this.chatService?.configureFailoverSteps(this.config.brain.fallback);
    if (parsed.brain?.policy) this.config.brain.policy = [...parsed.brain.policy];

    // Save to config.json
    saveConfig(this.config.hubHome, parsed);

    if (parsed.telegram?.enabled !== undefined && this.telegramBotService) {
      if (parsed.telegram.enabled) {
        this.telegramBotService.start();
      } else {
        void this.telegramBotService.stop();
      }
    }

    this.scheduler.getEventBus().emit('config.updated', undefined, parsed);

    return this.getConfig();
  }

  getClaudeApiKeyStatus() {
    return { configured: this.chatService?.getClaudeApiKeyStatus().configured || false };
  }

  setClaudeApiKey(value: string) {
    if (!this.chatService) throw new HttpError(503, 'unavailable', 'Chat service chưa sẵn sàng');
    this.chatService.setClaudeApiKey(value);
    this.scheduler.getEventBus().emit('config.updated', undefined, { brain: { apiKey: 'configured' } });
    return this.getClaudeApiKeyStatus();
  }
}
