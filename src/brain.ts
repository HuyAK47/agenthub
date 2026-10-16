import Database from 'better-sqlite3';
import { z } from 'zod';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentHubConfig } from './config.js';
import { openDatabase, EventRepo } from './db/index.js';
import { EventBus } from './scheduler/index.js';
import { readExistingToken, getTokenPath } from './auth.js';

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
  ) {}

  getStatus(now = Date.now()): BrainStatus {
    const row = this.brainRepo.get();
    if (!row) {
      const defaultTs = new Date().toISOString();
      return {
        activity: 'idle',
        detail: '',
        taskId: null,
        updatedAt: defaultTs,
        stale: false,
      };
    }

    const stale = isBrainStale(row.updatedAt, now);
    return {
      activity: row.activity,
      detail: row.detail,
      taskId: row.taskId || null,
      updatedAt: row.updatedAt,
      stale,
    };
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
    };
  }
}

export function registerBrainRoutes(
  fastify: FastifyInstance,
  brainService: BrainService,
): void {
  fastify.get('/api/brain', async () => {
    return brainService.getStatus();
  });

  fastify.put('/api/brain', async (req: FastifyRequest, reply: FastifyReply) => {
    const result = brainService.updateStatus(req.body);
    return reply.status(200).send(result);
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
