import Database from 'better-sqlite3';
import path from 'node:path';
import { z } from 'zod';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentHubConfig } from './config.js';
import { openDatabase, EventRepo } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { readExistingToken, getTokenPath } from './auth.js';
import { ClaudeSessionRepo } from './claude-sessions/repo.js';
import { generateDigest } from './brain/digest.js';
import { AppService, HttpError } from './services/index.js';

export const BRAIN_ACTIVITIES = [
  'planning',
  'dispatching',
  'reviewing',
  'merging',
  'deploying',
  'waiting',
  'idle',
  'talking',
] as const;

export type BrainActivity = (typeof BRAIN_ACTIVITIES)[number];

export interface BrainStatusRow {
  id?: number;
  activity: BrainActivity;
  detail: string;
  taskId: string | null;
  updatedAt: string;
}

export interface BrainStatus {
  activity: BrainActivity;
  detail: string;
  taskId?: string | null;
  updatedAt: string;
  stale: boolean;
  source: 'manual' | 'transcript';
  sessions: BrainSession[];
  state: 'working' | 'waiting' | 'inactive';
}

export interface BrainSession {
  sessionId: string;
  title: string;
  cwd: string;
  lastActivityAt: string;
  lastUserRequest: string | null;
  lastTool: { name: string; summary: string } | null;
  state: 'working' | 'waiting' | 'inactive';
  tokens5h: number | null;
  link: string;
}

export const UpdateBrainSchema = z.object({
  activity: z.enum(BRAIN_ACTIVITIES, {
    errorMap: () => ({
      message: `activity phải thuộc một trong các giá trị: ${BRAIN_ACTIVITIES.join(', ')}`,
    }),
  }),
  detail: z.string().max(300, { message: 'detail tối đa 300 ký tự' }),
  taskId: z.string().nullable().optional(),
});

export const BrainNotifySchema = z.object({
  text: z.string().min(1).max(4000),
  level: z.enum(['info', 'decision', 'incident']).default('info'),
});

export type UpdateBrainInput = z.infer<typeof UpdateBrainSchema>;

export function parseDbTimestamp(ts: string): number {
  if (ts.includes('T')) {
    return new Date(ts).getTime();
  }
  return new Date(ts.replace(' ', 'T') + 'Z').getTime();
}

export function isBrainStale(updatedAt: string, now = Date.now(), thresholdMs = 15 * 60 * 1000): boolean {
  const ts = parseDbTimestamp(updatedAt);
  if (isNaN(ts)) return true;
  return now - ts > thresholdMs;
}

export class BrainRepo {
  constructor(private db: Database.Database) {}

  get(): BrainStatusRow | undefined {
    return this.db.prepare('SELECT * FROM brain_status WHERE id = 1').get() as
      | BrainStatusRow
      | undefined;
  }

  upsert(
    activity: BrainActivity,
    detail: string,
    taskId?: string | null,
    updatedAt?: string,
  ): BrainStatusRow {
    const ts = updatedAt || new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO brain_status (id, activity, detail, taskId, updatedAt)
         VALUES (1, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           activity = excluded.activity,
           detail = excluded.detail,
           taskId = excluded.taskId,
           updatedAt = excluded.updatedAt`,
      )
      .run(activity, detail, taskId || null, ts);

    return {
      id: 1,
      activity,
      detail,
      taskId: taskId || null,
      updatedAt: ts,
    };
  }
}

export class BrainService {
  constructor(
    private brainRepo: BrainRepo,
    private eventRepo: EventRepo,
    private getEventBus?: () => EventBus | undefined,
    private claudeSessionRepo?: ClaudeSessionRepo,
    private db?: Database.Database,
  ) {}

  getStatus(now = Date.now()): BrainStatus {
    const row = this.brainRepo.get();
    const sessions = this.getSessions(now);
    if (!row) {
      const defaultTs = new Date().toISOString();
      return {
        activity: 'idle',
        detail: '',
        taskId: null,
        updatedAt: defaultTs,
        stale: false,
        source: sessions.length ? 'transcript' : 'manual',
        sessions,
        state: sessions.some((s) => s.state === 'working') ? 'working' : sessions.some((s) => s.state === 'waiting') ? 'waiting' : 'inactive',
      };
    }

    const hasManualValue = row.activity !== 'idle' || row.detail !== '' || row.taskId !== null
      || this.eventRepo.getRecent(1000).some((event) => event.type === 'brain.status');
    const manualFresh = hasManualValue && !isBrainStale(row.updatedAt, now);
    if (!manualFresh && sessions.length === 0) {
      return { activity: row.activity, detail: row.detail, taskId: row.taskId || null, updatedAt: row.updatedAt, stale: true, source: 'manual', sessions, state: 'inactive' };
    }
    const activeSession = sessions.find((session) => session.state !== 'inactive');
    const stale = manualFresh ? false : !activeSession;
    return {
      activity: manualFresh ? row.activity : activeSession?.state === 'working' ? 'planning' : activeSession?.state === 'waiting' ? 'waiting' : 'idle',
      detail: manualFresh ? row.detail : activeSession ? `${activeSession.title} · ${activeSession.state === 'waiting' ? 'chờ bạn trả lời' : 'đang làm'}` : 'Claude không hoạt động',
      taskId: manualFresh ? row.taskId || null : null,
      updatedAt: manualFresh ? row.updatedAt : sessions[0]?.lastActivityAt || row.updatedAt,
      stale,
      source: manualFresh ? 'manual' : 'transcript',
      sessions,
      state: manualFresh ? row.activity === 'waiting' ? 'waiting' : row.activity === 'idle' ? 'inactive' : 'working' : activeSession?.state || 'inactive',
    };
  }

  private getSessions(now: number): BrainSession[] {
    if (!this.claudeSessionRepo) return [];
    const projects = (this.db?.prepare('SELECT path FROM projects').all() as Array<{ path: string }> | undefined) || [];
    const rows = this.claudeSessionRepo.list().filter((row) => row.lastAt && now - Date.parse(row.lastAt) <= 10 * 60_000 && projects.some((p) => isWithin(row.cwd, p.path)));
    return rows.sort((a, b) => Date.parse(b.lastAt || '') - Date.parse(a.lastAt || '')).slice(0, 3).map((row) => ({
      sessionId: row.sessionId,
      title: row.title || row.sessionId,
      cwd: row.cwd,
      lastActivityAt: row.lastAt!,
      lastUserRequest: row.lastUserRequest,
      lastTool: row.lastToolName ? { name: row.lastToolName, summary: row.lastToolSummary || '' } : null,
      state: row.lastEventKind === 'assistant_text' ? 'waiting' : 'working',
      tokens5h: row.fiveHourTokens,
      link: `/claude-sessions/${encodeURIComponent(row.sessionId)}`,
    }));
  }

  updateStatus(input: unknown): BrainStatus {
    const parsed = UpdateBrainSchema.parse(input);
    const nowIso = new Date().toISOString();
    const updated = this.brainRepo.upsert(
      parsed.activity,
      parsed.detail,
      parsed.taskId,
      nowIso,
    );

    // Record into events table
    this.eventRepo.insert('brain.status', parsed.taskId || undefined, {
      activity: parsed.activity,
      detail: parsed.detail,
      taskId: parsed.taskId || null,
      updatedAt: nowIso,
    });

    // Emit SSE event via EventBus if available
    try {
      const eventBus = this.getEventBus?.();
      if (eventBus) {
        eventBus.emit('brain.status', parsed.taskId || undefined, {
          activity: parsed.activity,
          detail: parsed.detail,
          taskId: parsed.taskId || null,
          updatedAt: nowIso,
          stale: false,
        });
      }
    } catch {
      // ignore event emission failure
    }

    return {
      activity: updated.activity,
      detail: updated.detail,
      taskId: updated.taskId,
      updatedAt: updated.updatedAt,
      stale: false,
      source: 'manual',
      sessions: this.getSessions(Date.now()),
      state: parsed.activity === 'waiting' ? 'waiting' : parsed.activity === 'idle' ? 'inactive' : 'working',
    };
  }

  notify(input: unknown): { text: string; level: 'info' | 'decision' | 'incident' } {
    const parsed = BrainNotifySchema.parse(input);
    const eventBus = this.getEventBus?.();
    if (eventBus) eventBus.emit('brain.notify', undefined, parsed);
    else this.eventRepo.insert('brain.notify', undefined, parsed);
    return parsed;
  }
}

function isWithin(child: string, root: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(child));
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

export function registerBrainRoutes(
  fastify: FastifyInstance,
  brainService: BrainService,
  appService?: AppService,
): void {
  fastify.get('/api/brain', async () => {
    return brainService.getStatus();
  });

  fastify.put('/api/brain', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = brainService.updateStatus(req.body);
    return reply.status(200).send(result);
  });
  fastify.post('/api/brain/notify', async (req: FastifyRequest) => brainService.notify(req.body));

  fastify.get('/api/brain/digest', async () => {
    if (!appService) {
      throw new HttpError(503, 'unavailable', 'AppService chưa sẵn sàng');
    }
    const digest = appService.telegramBotService?.buildCurrentDigest() ?? generateDigest({
      taskRepo: appService.taskRepo,
      projectRepo: appService.projectRepo,
      profileRepo: appService.profileRepo,
      quotaMarkRepo: appService.quotaMarkRepo,
      eventRepo: appService.eventRepo,
      decisionTracker: appService.telegramBotService?.getDecisionTracker(),
      port: appService.config.port,
    });
    return digest;
  });

  fastify.post('/api/brain/digest', async () => {
    if (!appService) {
      throw new HttpError(503, 'unavailable', 'AppService chưa sẵn sàng');
    }
    const digest = appService.telegramBotService?.buildCurrentDigest() ?? generateDigest({
      taskRepo: appService.taskRepo,
      projectRepo: appService.projectRepo,
      profileRepo: appService.profileRepo,
      quotaMarkRepo: appService.quotaMarkRepo,
      eventRepo: appService.eventRepo,
      decisionTracker: appService.telegramBotService?.getDecisionTracker(),
      port: appService.config.port,
    });
    appService.scheduler.getEventBus().emit('brain.digest', undefined, digest);
    if (appService.telegramBotService) {
      appService.telegramBotService.broadcastMessage(digest.text, {
        inline_keyboard: [[{ text: '🌐 Xem dashboard', url: appService.telegramBotService.getDashboardUrl() }]],
      });
    }
    return digest;
  });

  fastify.get('/api/brain/decisions', async () => {
    const tracker = appService?.telegramBotService?.getDecisionTracker();
    const decisions = tracker ? tracker.getPendingDecisions() : [];
    return { decisions };
  });

  fastify.post('/api/brain/decisions/:id/answer', async (req: FastifyRequest) => {
    const tracker = appService?.telegramBotService?.getDecisionTracker();
    const { id } = req.params as { id: string };
    const body = req.body as { answer?: 'agree' | 'reject' } | undefined;
    const answer = body?.answer;
    if (!answer || (answer !== 'agree' && answer !== 'reject')) {
      throw new HttpError(400, 'bad_request', 'answer must be agree or reject');
    }
    const updated = tracker?.answerDecision(id, answer);
    if (!updated) {
      throw new HttpError(404, 'not_found', `Decision ${id} not found`);
    }
    appService?.scheduler.getEventBus().emit('decision.answered', undefined, {
      decisionId: id,
      action: answer,
      answer,
      text: updated.text,
    });
    return { ok: true, decision: updated };
  });
}

export async function cmdBrain(
  config: AgentHubConfig,
  arg1?: string | string[],
  arg2?: string,
  extraArgs: string[] = [],
): Promise<BrainStatus> {
  const allArgs = Array.isArray(arg1)
    ? arg1
    : [arg1, arg2, ...extraArgs].filter((x): x is string => x !== undefined);

  let activity: string | undefined;
  let detail: string | undefined;
  let taskId: string | undefined;

  for (let i = 0; i < allArgs.length; i++) {
    const a = allArgs[i];
    if (a === '--task' && i + 1 < allArgs.length) {
      taskId = allArgs[i + 1];
      i++;
    } else if (a.startsWith('--task=')) {
      taskId = a.slice('--task='.length);
    } else if (!activity) {
      activity = a;
    } else if (detail === undefined) {
      detail = a;
    }
  }

  if (!activity || detail === undefined) {
    console.error('Cách dùng: agenthub brain <activity> "<detail>" [--task id]');
    console.error(`Các activity hợp lệ: ${BRAIN_ACTIVITIES.join(', ')}`);
    process.exitCode = 1;
    throw new Error('Thiếu tham số activity hoặc detail');
  }

  const parseResult = UpdateBrainSchema.safeParse({
    activity,
    detail,
    taskId: taskId || null,
  });

  if (!parseResult.success) {
    const msg = parseResult.error.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ');
    console.error(`Lỗi dữ liệu: ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }

  const payload = parseResult.data;

  // Try calling HTTP API if daemon is running
  const port = config.port || 7700;
  const token = readExistingToken(config.tokenPath || getTokenPath());
  if (token) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/brain`, {
        method: 'PUT',
        headers: {
          Host: `127.0.0.1:${port}`,
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) {
        const data = (await res.json()) as BrainStatus;
        console.log(
          `✓ Đã cập nhật trạng thái Claude: [${data.activity}] "${data.detail}"${data.taskId ? ` (task: ${data.taskId})` : ''}`,
        );
        return data;
      }
    } catch {
      // Daemon may not be running, fall back to direct DB update
    }
  }

  // Fallback: direct DB update
  const db = openDatabase(config.dbPath);
  try {
    const brainRepo = new BrainRepo(db);
    const eventRepo = new EventRepo(db);
    const service = new BrainService(brainRepo, eventRepo);
    const result = service.updateStatus(payload);
    console.log(
      `✓ Đã cập nhật trạng thái Claude: [${result.activity}] "${result.detail}"${result.taskId ? ` (task: ${result.taskId})` : ''}`,
    );
    return result;
  } finally {
    db.close();
  }
}
