import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { ChildProcess } from 'node:child_process';
import { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { AgentHubConfig } from '../config.js';
import {
  ChatSessionRepo,
  ChatMessageRepo,
  ProjectRepo,
  TaskRepo,
  RunRepo,
  ProfileRepo,
  QuotaMarkRepo,
  QuotaUsageRepo,
  EventRepo,
  ChatSessionRow,
} from '../db/index.js';
import { EventBus } from '../scheduler/index.js';
import { HttpError } from '../services/index.js';
import { detectClaudeQuota, ParsedStreamEvent, StreamChunkParser } from './parse.js';
import { ClaudeFailoverState } from './failover.js';
import {
  findClaudeBin,
  checkClaudePartialSupport,
  checkClaudeStreamJsonSupport,
  ensureChatMcpConfig,
  buildClaudeArgs,
  spawnClaude,
  killProcessGroup,
  interruptProcess,
  streamJsonMessage,
  buildHubSnapshot,
  readHubSnapshotFiles,
} from './claude.js';

async function setBrainActivity(activity: 'talking' | 'idle'): Promise<void> {
  try {
    const brainModulePath = '../brain.js';
    const brainModule = (await import(brainModulePath)) as { setActivity?: (act: string) => void };
    if (brainModule && typeof brainModule.setActivity === 'function') {
      brainModule.setActivity(activity);
    }
  } catch {
    // ignore if brain module does not exist
  }
}

export interface QueuedTurn {
  sessionId: string;
  messageId: string;
  text: string;
  projectId: string | null;
  mode: 'safe' | 'full';
  claudeSessionId: string | null;
  model: string;
  profileName: string | null;
}

export interface RunningTurn {
  sessionId: string;
  messageId: string;
  child: ChildProcess;
  timeoutTimer: NodeJS.Timeout;
  cancelled: boolean;
  persistent?: boolean;
  cancelTimer?: NodeJS.Timeout;
}

interface PersistentProcess {
  sessionId: string;
  child: ChildProcess;
  parser: StreamChunkParser;
  active?: RunningTurn;
  idleTimer?: NodeJS.Timeout;
  lastUsedAt: number;
  model: string;
  profileName: string | null;
  stderrOutput: string;
}

export class ChatService {
  private queue: QueuedTurn[] = [];
  private runningTurns = new Map<string, RunningTurn>();
  private claudeBinOverride?: string;
  private persistentProcesses = new Map<string, PersistentProcess>();
  private snapshotAt = new Map<string, number>();
  private snapshotEventAt = new Map<string, number>();

  constructor(
    public config: AgentHubConfig,
    public chatSessionRepo: ChatSessionRepo,
    public chatMessageRepo: ChatMessageRepo,
    public projectRepo: ProjectRepo,
    public eventBus: EventBus,
    public taskRepo?: TaskRepo,
    public runRepo?: RunRepo,
    public profileRepo?: ProfileRepo,
    public quotaMarkRepo?: QuotaMarkRepo,
    public quotaUsageRepo?: QuotaUsageRepo,
    public eventRepo?: EventRepo,
    options?: { claudeBin?: string; failoverState?: ClaudeFailoverState },
  ) {
    if (options?.claudeBin) {
      this.claudeBinOverride = options.claudeBin;
    }
    this.failoverState = options?.failoverState || new ClaudeFailoverState(path.join(config.hubHome, 'claude-failover.json'));
    // Daemon khởi động lại thì reset busy=0 cho mọi phiên
    this.chatSessionRepo.resetAllBusy();
  }

  private failoverState: ClaudeFailoverState;

  private hubSnapshot(session: ChatSessionRow, refresh = false): string {
    const project = session.projectId ? this.projectRepo.get(session.projectId) : undefined;
    const now = Date.now();
    const previousEvent = this.snapshotEventAt.get(session.id) || 0;
    const updates = refresh && this.eventRepo
      ? this.eventRepo.getSince(previousEvent).slice(-8).map((event) => event.type + (event.taskId ? ` ${event.taskId}` : '')).join(', ')
      : '';
    const files = project ? readHubSnapshotFiles(project.path) : {};
    this.snapshotAt.set(session.id, now);
    if (this.eventRepo) this.snapshotEventAt.set(session.id, this.eventRepo.getRecent(1)[0]?.id || previousEvent);
    return buildHubSnapshot({
      projects: this.projectRepo.getAll().map(({ id, name, path: projectPath, defaultBranch }) => ({ id, name, path: projectPath, defaultBranch })),
      tasks: this.taskRepo?.getAll().map(({ id, projectId, title, status }) => ({ id, projectId, title, status })) || [],
      runs: this.runRepo?.getRunning().map(({ taskId, model, outcome }) => ({ taskId, model, outcome })) || [],
      profiles: this.profileRepo?.getAll().map(({ name, engine, email, authState }) => ({ name, engine, email, authState })) || [],
      quotaUsage: this.quotaUsageRepo?.getAll() || [],
      quotaMarks: this.quotaMarkRepo?.getAll() || [],
      currentProject: project ? { id: project.id, path: project.path } : null,
      ...files,
      capturedAt: new Date(now).toISOString(),
      eventUpdate: updates,
    });
  }

  getClaudeFailover(): ReturnType<ClaudeFailoverState['snapshot']> {
    return this.failoverState.snapshot();
  }

  clearClaudeFailover(): ReturnType<ClaudeFailoverState['snapshot']> {
    this.failoverState.clear();
    this.eventBus.emit('claude.failover_cleared', undefined, { reason: 'manual' });
    return this.failoverState.snapshot();
  }

  private recordClaudeQuota(streamText: string, stderr: string, exitCode?: number | null): void {
    const result = detectClaudeQuota({ streamText, stderr, exitCode });
    if (!result.exhausted) return;
    const snapshot = this.failoverState.activate(result.resetSeconds || this.config.reviewer.failoverSec, 'claude_usage_limit');
    this.eventBus.emit('claude.quota_exhausted', undefined, {
      until: snapshot.until,
      reason: snapshot.reason,
    });
    this.eventBus.emit('claude.failover_enabled', undefined, { until: snapshot.until });
  }

  setClaudeBinOverride(bin?: string): void {
    this.claudeBinOverride = bin;
  }

  stop(): void {
    for (const turn of this.runningTurns.values()) {
      clearTimeout(turn.timeoutTimer);
      turn.cancelled = true;
      if (turn.child.pid) {
        killProcessGroup(turn.child.pid);
      }
    }
    this.runningTurns.clear();
    for (const proc of this.persistentProcesses.values()) {
      if (proc.idleTimer) clearTimeout(proc.idleTimer);
      if (proc.child.pid) killProcessGroup(proc.child.pid);
    }
    this.persistentProcesses.clear();
    this.queue = [];
  }

  listSessions(): Array<{
    id: string;
    projectId: string | null;
    title: string | null;
    mode: 'safe' | 'full';
    model: string;
    profileName: string | null;
    busy: number;
    updatedAt: string;
    lastMessage?: {
      id: string;
      role: string;
      content: string;
      createdAt: string;
    };
  }> {
    const sessions = this.chatSessionRepo.getAll();
    return sessions.map((s) => {
      const last = this.chatMessageRepo.getLastBySession(s.id);
      const res: {
        id: string;
        projectId: string | null;
        title: string | null;
        mode: 'safe' | 'full';
        model: string;
        profileName: string | null;
        busy: number;
        updatedAt: string;
        lastMessage?: {
          id: string;
          role: string;
          content: string;
          createdAt: string;
        };
      } = {
        id: s.id,
        projectId: s.projectId,
        title: s.title,
        mode: s.mode,
        model: s.model,
        profileName: s.profileName,
        busy: s.busy,
        updatedAt: s.updatedAt,
      };
      if (last) {
        res.lastMessage = {
          id: last.id,
          role: last.role,
          content: last.content,
          createdAt: last.createdAt,
        };
      }
      return res;
    });
  }

  createSession(body: {
    projectId?: string | null;
    title?: string | null;
    mode?: 'safe' | 'full';
    model?: string;
    profileName?: string | null;
  }): ChatSessionRow {
    const mode = body.mode || 'safe';
    if (mode === 'full' && this.config.chat?.allowFullMode !== true) {
      throw new HttpError(403, 'forbidden', 'Chế độ full chưa được cho phép trong cấu hình');
    }
    const model = body.model ?? this.config.chat.model;
    if (model !== '' && model !== 'sonnet' && model !== 'haiku') {
      throw new HttpError(400, 'bad_request', 'Model chat phải là mặc định, sonnet hoặc haiku');
    }

    const id = crypto.randomUUID();
    const title = body.title && body.title.trim().length > 0 ? body.title.trim() : 'Cuộc trò chuyện mới';

    this.chatSessionRepo.insert({
      id,
      projectId: body.projectId || null,
      title,
      mode,
      model,
      busy: 0,
      profileName: body.profileName ?? this.config.chat.claudeProfile ?? 'claude-may',
    });

    const session = this.chatSessionRepo.get(id)!;
    if (body.profileName && session.profileName && this.profileRepo && !this.profileRepo.get(session.profileName)) {
      throw new HttpError(400, 'bad_request', `Hồ sơ Claude "${session.profileName}" không tồn tại`);
    }
    return session;
  }

  updateSession(id: string, body: { title?: string }): ChatSessionRow {
    const session = this.chatSessionRepo.get(id);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${id}" không tồn tại`);
    }

    if (body.title !== undefined) {
      this.chatSessionRepo.updateTitle(id, body.title);
    }

    return this.chatSessionRepo.get(id)!;
  }

  deleteSession(id: string): { ok: boolean } {
    const session = this.chatSessionRepo.get(id);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${id}" không tồn tại`);
    }

    if (session.busy === 1 || this.runningTurns.has(id)) {
      throw new HttpError(409, 'conflict', 'Không thể xóa phiên đang bận');
    }

    // Remove from queue if any
    this.queue = this.queue.filter((t) => t.sessionId !== id);
    this.chatSessionRepo.delete(id);
    return { ok: true };
  }

  listMessages(
    sessionId: string,
    limit = 200,
  ): Array<{
    id: string;
    sessionId: string;
    role: string;
    content: string;
    meta: unknown;
    createdAt: string;
  }> {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    const messages = this.chatMessageRepo.getBySession(sessionId, limit);
    return messages.map((m) => {
      let parsedMeta: unknown = null;
      if (m.meta) {
        try {
          parsedMeta = JSON.parse(m.meta);
        } catch {
          parsedMeta = m.meta;
        }
      }
      return {
        id: m.id,
        sessionId: m.sessionId,
        role: m.role,
        content: m.content,
        meta: parsedMeta,
        createdAt: m.createdAt,
      };
    });
  }

  sendMessage(
    sessionId: string,
    text: string,
  ): { userMessageId: string; assistantMessageId: string } {
    if (typeof text !== 'string' || text.trim().length === 0) {
      throw new HttpError(400, 'bad_request', 'Nội dung tin nhắn không được để trống');
    }
    if (text.length > 20000) {
      throw new HttpError(400, 'bad_request', 'Nội dung tin nhắn tối đa 20.000 ký tự');
    }

    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    if (session.busy === 1 || this.runningTurns.has(sessionId)) {
      throw new HttpError(409, 'conflict', 'Phiên đang bận');
    }

    this.failoverState.noteActivity();

    const userMessageId = crypto.randomUUID();
    const assistantMessageId = crypto.randomUUID();

    // Store user message
    this.chatMessageRepo.insert({
      id: userMessageId,
      sessionId,
      role: 'user',
      content: text,
    });

    // Mark session busy
    this.chatSessionRepo.setBusy(sessionId, 1);

    // Enqueue turn
    this.enqueueTurn({
      sessionId,
      messageId: assistantMessageId,
      text,
      projectId: session.projectId,
      mode: session.mode,
      claudeSessionId: session.claudeSessionId,
      model: session.model,
      profileName: session.profileName,
    });

    return { userMessageId, assistantMessageId };
  }

  warmSession(sessionId: string): { ok: boolean; warmed: boolean } {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin || !checkClaudeStreamJsonSupport(claudeBin)) return { ok: true, warmed: false };
    return { ok: true, warmed: Boolean(this.ensurePersistentProcess(session, claudeBin)) };
  }

  cancelSession(sessionId: string): { ok: boolean } {
    const session = this.chatSessionRepo.get(sessionId);
    if (!session) {
      throw new HttpError(404, 'not_found', `Phiên trò chuyện "${sessionId}" không tồn tại`);
    }

    // Check if in queue
    const queuedIndex = this.queue.findIndex((t) => t.sessionId === sessionId);
    if (queuedIndex >= 0) {
      this.queue.splice(queuedIndex, 1);
      this.chatSessionRepo.setBusy(sessionId, 0);
      return { ok: true };
    }

    // Check if running
    const running = this.runningTurns.get(sessionId);
    if (running) {
      running.cancelled = true;
      clearTimeout(running.timeoutTimer);
      if (running.persistent && running.child.pid) {
        interruptProcess(running.child.pid);
        running.cancelTimer = setTimeout(() => {
          if (this.runningTurns.get(sessionId) === running) {
            if (running.child.pid) killProcessGroup(running.child.pid);
            this.runningTurns.delete(sessionId);
            this.chatSessionRepo.setBusy(sessionId, 0);
            this.emitChatError(sessionId, running.messageId, 'Đã hủy lượt chat');
            const proc = this.persistentProcesses.get(sessionId);
            if (proc) this.closePersistentProcess(proc);
            this.processQueue();
          }
        }, 3000);
        return { ok: true };
      }
      if (running.child.pid) {
        killProcessGroup(running.child.pid);
      }
      this.runningTurns.delete(sessionId);
      this.chatSessionRepo.setBusy(sessionId, 0);
      this.emitChatError(sessionId, running.messageId, 'Đã hủy lượt chat');
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return { ok: true };
    }

    // Session not currently running
    this.chatSessionRepo.setBusy(sessionId, 0);
    return { ok: true };
  }

  private enqueueTurn(turn: QueuedTurn): void {
    this.queue.push(turn);
    this.processQueue();
  }

  private processQueue(): void {
    const maxConcurrent = this.config.chat?.maxConcurrent ?? 2;
    while (this.runningTurns.size < maxConcurrent && this.queue.length > 0) {
      const nextTurn = this.queue.shift()!;
      const session = this.chatSessionRepo.get(nextTurn.sessionId);
      if (!session) continue;
      this.executeTurn(nextTurn);
    }
  }

  private executeTurn(turn: QueuedTurn): void {
    const claudeBin = findClaudeBin(this.claudeBinOverride || this.config.chat?.claudeBin);
    if (!claudeBin) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      const errMsg = 'Không tìm thấy lệnh claude trên hệ thống';
      this.chatMessageRepo.insert({
        id: turn.messageId,
        sessionId: turn.sessionId,
        role: 'error',
        content: errMsg,
      });
      this.emitChatError(turn.sessionId, turn.messageId, errMsg);
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return;
    }

    if (checkClaudeStreamJsonSupport(claudeBin)) {
      this.executePersistentTurn(turn, claudeBin);
      return;
    }

    // Determine cwd
    let cwd = os.homedir();
    if (turn.projectId) {
      const project = this.projectRepo.get(turn.projectId);
      if (project && project.path) {
        cwd = project.path;
      }
    }

    const mcpConfigPath = ensureChatMcpConfig(this.config.hubHome);
    const supportsPartial = checkClaudePartialSupport(claudeBin);

    const session = this.chatSessionRepo.get(turn.sessionId);
    const profile = turn.profileName && this.profileRepo ? this.profileRepo.get(turn.profileName) : undefined;
    const args = buildClaudeArgs({
      text: turn.text,
      claudeSessionId: turn.claudeSessionId,
      mode: turn.mode,
      mcpConfigPath,
      supportsPartial,
      model: turn.model,
      hubSnapshot: session ? this.hubSnapshot(session) : undefined,
    });

    setBrainActivity('talking').catch(() => {});

    let child: ChildProcess;
    try {
      child = spawnClaude(claudeBin, args, cwd, turn.text, { disableToolSearch: this.config.chat.disableToolSearch, claudeConfigDir: profile?.kind === 'isolated' ? profile.home || undefined : undefined });
    } catch (err: unknown) {
      this.chatSessionRepo.setBusy(turn.sessionId, 0);
      const errMsg = err instanceof Error ? err.message : 'Lỗi khởi chạy claude';
      this.chatMessageRepo.insert({
        id: turn.messageId,
        sessionId: turn.sessionId,
        role: 'error',
        content: errMsg,
      });
      this.emitChatError(turn.sessionId, turn.messageId, errMsg);
      setBrainActivity('idle').catch(() => {});
      this.processQueue();
      return;
    }

    // 15 minutes timeout
    const timeoutTimer = setTimeout(() => {
      const running = this.runningTurns.get(turn.sessionId);
      if (running) {
        running.cancelled = true;
        if (running.child.pid) {
          killProcessGroup(running.child.pid);
        }
        this.runningTurns.delete(turn.sessionId);
        this.chatSessionRepo.setBusy(turn.sessionId, 0);
        const timeoutMsg = 'Lượt chat bị quá thời gian (15 phút)';
        this.chatMessageRepo.insert({
          id: turn.messageId,
          sessionId: turn.sessionId,
          role: 'error',
          content: timeoutMsg,
        });
        this.emitChatError(turn.sessionId, turn.messageId, timeoutMsg);
        setBrainActivity('idle').catch(() => {});
        this.processQueue();
      }
    }, 15 * 60 * 1000);

    const runningTurn: RunningTurn = {
      sessionId: turn.sessionId,
      messageId: turn.messageId,
      child,
      timeoutTimer,
      cancelled: false,
    };
    this.runningTurns.set(turn.sessionId, runningTurn);

    const parser = new StreamChunkParser();
    let accumulatedText = '';
    let hasStreamedPartials = false;
    let resultHandled = false;
    const startTime = Date.now();

    child.stdout?.on('data', (chunk: Buffer) => {
      const events = parser.feed(chunk);
      for (const ev of events) {
        if (ev.type === 'init') {
          if (ev.sessionId) {
            const sess = this.chatSessionRepo.get(turn.sessionId);
            if (sess && !sess.claudeSessionId) {
              this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
            }
          }
        } else if (ev.type === 'text_delta') {
          hasStreamedPartials = true;
          accumulatedText += ev.text;
          this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
        } else if (ev.type === 'assistant_text') {
          if (!hasStreamedPartials) {
            accumulatedText += ev.text;
            this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
          }
        } else if (ev.type === 'tool_use') {
          this.emitChatTool(turn.sessionId, turn.messageId, ev.name, ev.summary);
          this.chatMessageRepo.insert({
            id: crypto.randomUUID(),
            sessionId: turn.sessionId,
            role: 'tool',
            content: ev.summary,
            meta: JSON.stringify({ name: ev.name, input: ev.input, id: ev.id }),
          });
        } else if (ev.type === 'result') {
          resultHandled = true;
          if (ev.result) accumulatedText += ev.result;
          if (ev.sessionId) {
            const sess = this.chatSessionRepo.get(turn.sessionId);
            if (sess && !sess.claudeSessionId) {
              this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
            }
          }

          if (ev.isError) {
            const errMsg = ev.result || 'Claude error';
            this.chatMessageRepo.insert({
              id: turn.messageId,
              sessionId: turn.sessionId,
              role: 'error',
              content: errMsg,
            });
            this.emitChatError(turn.sessionId, turn.messageId, errMsg);
          } else {
            const finalText = ev.result ?? accumulatedText;
            this.chatMessageRepo.insert({
              id: turn.messageId,
              sessionId: turn.sessionId,
              role: 'assistant',
              content: finalText,
              meta: JSON.stringify({
                costUsd: ev.costUsd,
                numTurns: ev.numTurns,
                durationMs: ev.durationMs,
              }),
            });
            this.emitChatDone(turn.sessionId, turn.messageId, {
              durationMs: ev.durationMs ?? (Date.now() - startTime),
              costUsd: ev.costUsd,
              numTurns: ev.numTurns,
            });
          }
        }
      }
    });

    let stderrOutput = '';
    child.stderr?.on('data', (chunk: Buffer) => {
      stderrOutput += chunk.toString('utf-8');
    });

    child.on('close', (code) => {
      clearTimeout(timeoutTimer);
      const flushed = parser.flush();
      for (const ev of flushed) {
        if (ev.type === 'init' && ev.sessionId) {
          const sess = this.chatSessionRepo.get(turn.sessionId);
          if (sess && !sess.claudeSessionId) {
            this.chatSessionRepo.updateClaudeSessionId(turn.sessionId, ev.sessionId);
          }
        } else if (ev.type === 'text_delta') {
          hasStreamedPartials = true;
          accumulatedText += ev.text;
          this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
        } else if (ev.type === 'assistant_text') {
          if (!hasStreamedPartials) {
            accumulatedText += ev.text;
            this.emitChatDelta(turn.sessionId, turn.messageId, ev.text);
          }
        } else if (ev.type === 'tool_use') {
          this.emitChatTool(turn.sessionId, turn.messageId, ev.name, ev.summary);
          this.chatMessageRepo.insert({
            id: crypto.randomUUID(),
            sessionId: turn.sessionId,
            role: 'tool',
            content: ev.summary,
            meta: JSON.stringify({ name: ev.name, input: ev.input, id: ev.id }),
          });
        }
      }

      const running = this.runningTurns.get(turn.sessionId);
      if (running && !running.cancelled) {
        this.recordClaudeQuota(accumulatedText, stderrOutput, code);
        if (!resultHandled) {
          if (code !== 0) {
            const errMsg = stderrOutput.trim() || `Claude process exited with code ${code}`;
            try {
              this.chatMessageRepo.insert({
                id: turn.messageId,
                sessionId: turn.sessionId,
                role: 'error',
                content: errMsg,
              });
            } catch {
              // ignore db error on shutdown
            }
            this.emitChatError(turn.sessionId, turn.messageId, errMsg);
          } else {
            try {
              this.chatMessageRepo.insert({
                id: turn.messageId,
                sessionId: turn.sessionId,
                role: 'assistant',
                content: accumulatedText,
              });
            } catch {
              // ignore db error on shutdown
            }
            this.emitChatDone(turn.sessionId, turn.messageId, {
              durationMs: Date.now() - startTime,
            });
          }
        }
        this.runningTurns.delete(turn.sessionId);
        try {
          this.chatSessionRepo.setBusy(turn.sessionId, 0);
        } catch {
          // ignore db error on shutdown
        }
        setBrainActivity('idle').catch(() => {});
        this.processQueue();
      }
    });
  }

  private executePersistentTurn(turn: QueuedTurn, claudeBin: string): void {
    const session = this.chatSessionRepo.get(turn.sessionId);
    if (!session) return;
    const proc = this.ensurePersistentProcess(session, claudeBin);
    if (!proc) {
      this.queue.unshift(turn);
      return;
    }
    const timeoutTimer = setTimeout(() => this.timeoutPersistentTurn(proc), 15 * 60 * 1000);
    const running: RunningTurn = { sessionId: turn.sessionId, messageId: turn.messageId, child: proc.child, timeoutTimer, cancelled: false, persistent: true };
    proc.active = running;
    proc.lastUsedAt = Date.now();
    this.runningTurns.set(turn.sessionId, running);
    setBrainActivity('talking').catch(() => {});
    try {
      const lastSnapshot = this.snapshotAt.get(turn.sessionId) || 0;
      const update = Date.now() - lastSnapshot > 10 * 60 * 1000 ? `Cập nhật hub: ${this.hubSnapshot(session, true)}\n\n` : '';
      proc.child.stdin?.write(streamJsonMessage(`${update}${turn.text}`));
    } catch (err) {
      this.finishPersistentError(proc, turn, err instanceof Error ? err.message : 'Không thể gửi tin nhắn tới Claude');
    }
  }

  private ensurePersistentProcess(session: ChatSessionRow, claudeBin: string): PersistentProcess | undefined {
    const existing = this.persistentProcesses.get(session.id);
    if (existing && !existing.child.killed) return existing;
    const max = this.config.chat.maxConcurrent ?? 2;
    if (this.persistentProcesses.size >= max) {
      const idle = [...this.persistentProcesses.values()].filter((p) => !p.active).sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!idle) return undefined;
      this.closePersistentProcess(idle);
    }
    let cwd = os.homedir();
    if (session.projectId) cwd = this.projectRepo.get(session.projectId)?.path || cwd;
    const profile = session.profileName && this.profileRepo ? this.profileRepo.get(session.profileName) : undefined;
    const proc = spawnClaude(claudeBin, buildClaudeArgs({
      mode: session.mode,
      claudeSessionId: session.claudeSessionId,
      mcpConfigPath: ensureChatMcpConfig(this.config.hubHome),
      supportsPartial: checkClaudePartialSupport(claudeBin),
      persistent: true,
      model: session.model,
      hubSnapshot: this.hubSnapshot(session, (this.snapshotAt.get(session.id) || 0) > 0 && Date.now() - (this.snapshotAt.get(session.id) || 0) > 10 * 60 * 1000),
    }), cwd, undefined, { disableToolSearch: this.config.chat.disableToolSearch, claudeConfigDir: profile?.kind === 'isolated' ? profile.home || undefined : undefined });
    const state: PersistentProcess = { sessionId: session.id, child: proc, parser: new StreamChunkParser(), lastUsedAt: Date.now(), model: session.model, profileName: session.profileName, stderrOutput: '' };
    this.persistentProcesses.set(session.id, state);
    proc.stdout?.on('data', (chunk: Buffer) => this.handlePersistentOutput(state, chunk));
    proc.stderr?.on('data', (chunk: Buffer) => { state.stderrOutput += chunk.toString('utf8'); });
    proc.on('close', () => this.handlePersistentClose(state));
    this.armIdleTimer(state);
    return state;
  }

  private handlePersistentOutput(proc: PersistentProcess, chunk: Buffer): void {
    for (const ev of proc.parser.feed(chunk)) {
      if ((ev.type === 'init' || ev.type === 'result') && ev.sessionId && !this.chatSessionRepo.get(proc.sessionId)?.claudeSessionId) {
        this.chatSessionRepo.updateClaudeSessionId(proc.sessionId, ev.sessionId);
      }
      if (ev.type === 'result' && proc.active) this.finishPersistentTurn(proc, ev);
      else if (ev.type === 'tool_use' && proc.active) {
        this.emitChatTool(proc.sessionId, proc.active.messageId, ev.name, ev.summary);
        this.chatMessageRepo.insert({ id: crypto.randomUUID(), sessionId: proc.sessionId, role: 'tool', content: ev.summary, meta: JSON.stringify({ name: ev.name, input: ev.input, id: ev.id }) });
      } else if ((ev.type === 'text_delta' || ev.type === 'assistant_text') && proc.active) {
        this.emitChatDelta(proc.sessionId, proc.active.messageId, ev.text);
      }
    }
  }

  private finishPersistentTurn(proc: PersistentProcess, ev: Extract<ParsedStreamEvent, { type: 'result' }>): void {
    const running = proc.active;
    if (!running) return;
    clearTimeout(running.timeoutTimer);
    if (running.cancelTimer) clearTimeout(running.cancelTimer);
    proc.active = undefined;
    this.runningTurns.delete(proc.sessionId);
    this.recordClaudeQuota(ev.result || '', proc.stderrOutput, 0);
    this.chatSessionRepo.setBusy(proc.sessionId, 0);
    if (ev.isError) {
      this.chatMessageRepo.insert({ id: running.messageId, sessionId: proc.sessionId, role: 'error', content: ev.result || 'Claude error' });
      this.emitChatError(proc.sessionId, running.messageId, ev.result || 'Claude error');
    } else {
      this.chatMessageRepo.insert({ id: running.messageId, sessionId: proc.sessionId, role: 'assistant', content: ev.result || '', meta: JSON.stringify({ costUsd: ev.costUsd, durationMs: ev.durationMs, numTurns: ev.numTurns }) });
      this.emitChatDone(proc.sessionId, running.messageId, { durationMs: ev.durationMs || 0, costUsd: ev.costUsd, numTurns: ev.numTurns });
    }
    proc.lastUsedAt = Date.now();
    this.armIdleTimer(proc);
    setBrainActivity('idle').catch(() => {});
    this.processQueue();
  }

  private finishPersistentError(proc: PersistentProcess, turn: QueuedTurn, message: string): void {
    if (proc.active) clearTimeout(proc.active.timeoutTimer);
    proc.active = undefined;
    this.runningTurns.delete(turn.sessionId);
    this.chatSessionRepo.setBusy(turn.sessionId, 0);
    this.chatMessageRepo.insert({ id: turn.messageId, sessionId: turn.sessionId, role: 'error', content: message });
    this.emitChatError(turn.sessionId, turn.messageId, message);
    this.closePersistentProcess(proc);
    this.processQueue();
  }

  private timeoutPersistentTurn(proc: PersistentProcess): void {
    const running = proc.active;
    if (!running) return;
    running.cancelled = true;
    if (proc.child.pid) killProcessGroup(proc.child.pid);
    this.finishPersistentError(proc, { sessionId: proc.sessionId, messageId: running.messageId, text: '', projectId: null, mode: 'safe', claudeSessionId: null, model: proc.model, profileName: proc.profileName }, 'Lượt chat bị quá thời gian (15 phút)');
  }

  private armIdleTimer(proc: PersistentProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    proc.idleTimer = setTimeout(() => { if (!proc.active) this.closePersistentProcess(proc); }, (this.config.chat.idleTimeoutSec || 600) * 1000);
  }

  private closePersistentProcess(proc: PersistentProcess): void {
    if (proc.idleTimer) clearTimeout(proc.idleTimer);
    this.persistentProcesses.delete(proc.sessionId);
    if (proc.child.pid) killProcessGroup(proc.child.pid);
  }

  private handlePersistentClose(proc: PersistentProcess): void {
    if (proc.active) {
      const active = proc.active;
      clearTimeout(active.timeoutTimer);
      this.runningTurns.delete(proc.sessionId);
      this.recordClaudeQuota('', proc.stderrOutput, null);
      this.chatSessionRepo.setBusy(proc.sessionId, 0);
      if (!active.cancelled) {
        this.chatMessageRepo.insert({ id: active.messageId, sessionId: proc.sessionId, role: 'error', content: 'Claude process đã dừng' });
        this.emitChatError(proc.sessionId, active.messageId, 'Claude process đã dừng');
      }
    }
    this.persistentProcesses.delete(proc.sessionId);
    this.processQueue();
  }

  private emitChatDelta(sessionId: string, messageId: string, text: string): void {
    this.emitEvent('chat.delta', { sessionId, messageId, text });
  }

  private emitChatTool(
    sessionId: string,
    messageId: string,
    name: string,
    summary: string,
  ): void {
    this.emitEvent('chat.tool', { sessionId, messageId, name, summary });
  }

  private emitChatDone(
    sessionId: string,
    messageId: string,
    data: { durationMs: number; costUsd?: number; numTurns?: number },
  ): void {
    this.emitEvent('chat.done', {
      sessionId,
      messageId,
      durationMs: data.durationMs,
      ...(data.costUsd !== undefined ? { costUsd: data.costUsd } : {}),
      ...(data.numTurns !== undefined ? { numTurns: data.numTurns } : {}),
    });
  }

  private emitChatError(sessionId: string, messageId: string, message: string): void {
    this.emitEvent('chat.error', { sessionId, messageId, message });
  }

  private emitEvent(type: string, payload: unknown): void {
    if (typeof (this.eventBus as unknown as { emitEphemeral?: (t: string, tid?: string, p?: unknown) => boolean }).emitEphemeral === 'function') {
      (this.eventBus as unknown as { emitEphemeral: (t: string, tid?: string, p?: unknown) => boolean }).emitEphemeral(
        type,
        undefined,
        payload,
      );
    } else {
      this.eventBus.emit(type, undefined, payload);
    }
  }
}

export function registerChatRoutes(fastify: FastifyInstance, chatService: ChatService): void {
  // GET /api/chat/sessions
  fastify.get('/api/chat/sessions', async () => {
    return chatService.listSessions();
  });

  // POST /api/chat/sessions
  fastify.post('/api/chat/sessions', async (req: FastifyRequest, reply: FastifyReply) => {
    const session = chatService.createSession(
      (req.body && typeof req.body === 'object' ? req.body : {}) as {
        projectId?: string | null;
        title?: string;
        mode?: 'safe' | 'full';
        model?: string;
        profileName?: string | null;
      },
    );
    return reply.status(201).send(session);
  });

  // POST /api/chat/sessions/:id/warm
  fastify.post('/api/chat/sessions/:id/warm', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.warmSession(id);
  });

  // PATCH /api/chat/sessions/:id
  fastify.patch('/api/chat/sessions/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.updateSession(
      id,
      (req.body && typeof req.body === 'object' ? req.body : {}) as { title?: string },
    );
  });

  // DELETE /api/chat/sessions/:id
  fastify.delete('/api/chat/sessions/:id', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.deleteSession(id);
  });

  // GET /api/chat/sessions/:id/messages?limit=200
  fastify.get('/api/chat/sessions/:id/messages', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    const query = req.query as { limit?: string };
    const limit = query?.limit ? parseInt(query.limit, 10) : 200;
    return chatService.listMessages(id, isNaN(limit) ? 200 : limit);
  });

  // POST /api/chat/sessions/:id/messages
  fastify.post('/api/chat/sessions/:id/messages', async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as { text?: unknown };
    const result = chatService.sendMessage(id, body.text as string);
    return reply.status(202).send(result);
  });

  // POST /api/chat/sessions/:id/cancel
  fastify.post('/api/chat/sessions/:id/cancel', async (req: FastifyRequest) => {
    const { id } = req.params as { id: string };
    return chatService.cancelSession(id);
  });
}
