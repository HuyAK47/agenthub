import crypto from 'node:crypto';
import type { BrainConfig } from '../config.js';
import { BrainDirectiveRepo, BrainTurnRepo, ChatSessionRepo, DepartmentRepo, KnowledgeRepo, ProfileRepo, TaskRepo } from '../db/index.js';
import { resolveClaudeProfile, resolveCodexProfile } from '../profiles/index.js';
import type { ChatService } from '../chat/service.js';
import { EventBus } from '../scheduler/index.js';
import { effectiveBrainMode, effectiveBrainPermission, type EffectiveBrainMode } from './mode.js';
import { projectSettings } from '../projects/settings.js';
import { buildProjectKnowledgeContext } from '../projects/knowledge-context.js';
import { effectiveBrainCodexProfile, effectiveBrainEngine } from './engine.js';

const EVENT_TYPES = new Set(['task.review_ready', 'task.failed', 'task.blocked', 'task.done', 'batch.created', 'batch.dispatched', 'merge.failed', 'merge.conflict', 'quota.exhausted', 'claude.quota_exhausted', 'disk.low', 'load.high', 'brain.directive_added', 'ci.failed', 'brain.trust_changed', 'config.updated']);
const SYSTEM_EVENTS = new Set(['quota.exhausted', 'claude.quota_exhausted', 'disk.low', 'load.high']);
const MAX_RETRIES = 3;

export interface BrainRunnerOptions {
  config: BrainConfig;
  eventBus: EventBus;
  chatService: Pick<ChatService, 'getOrCreateSession' | 'sendMessage'>;
  chatSessionRepo: ChatSessionRepo;
  profileRepo?: Pick<ProfileRepo, 'getAll'>;
  taskRepo?: Pick<TaskRepo, 'get'>;
  turnRepo: BrainTurnRepo;
  projectRepo?: { get(id: string): { id: string; name: string; path: string; departmentId?: string; settings?: string | null } | undefined; getAll?: () => Array<{ id: string }> };
  departmentRepo?: DepartmentRepo;
  directiveRepo?: BrainDirectiveRepo;
  knowledgeRepo?: KnowledgeRepo;
  debounceMs?: number;
  now?: () => number;
}

export interface BrainQueuedEvent { id?: string; type: string; taskId?: string; projectId?: string | null; payload?: unknown; priority?: boolean; }
interface ActiveTurn { id: string; events: BrainQueuedEvent[]; retries: number; knowledgeHash?: string; departmentId?: string; timer?: NodeJS.Timeout; }

/** Routes resident-brain turns by project while retaining the system brain for incidents. */
export class BrainRunner {
  readonly sessionId = 'brain';
  private readonly debounceMs: number;
  private readonly now: () => number;
  private pending: BrainQueuedEvent[] = [];
  private timer?: NodeJS.Timeout;
  private active = new Map<string, ActiveTurn>();
  private userBusy = new Set<string>();
  private retryCounts = new Map<string, number>();
  private roundRobinCursor = 0;
  private started = false;
  private sentKnowledgeHash = new Map<string, string>();
  private bound = (type: string, taskId?: string, payload?: unknown) => this.onEvent(type, taskId, payload);

  constructor(private readonly opts: BrainRunnerOptions) {
    this.debounceMs = opts.debounceMs ?? 30_000;
    this.now = opts.now ?? (() => Date.now());
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    if (this.opts.config.mode !== 'off' || this.opts.config.director?.enabled) this.ensureSession(null);
    this.opts.eventBus.on('*', this.bound);
  }

  stop(): void {
    if (!this.started) return;
    this.started = false;
    this.opts.eventBus.off('*', this.bound);
    if (this.timer) clearTimeout(this.timer);
    for (const turn of this.active.values()) if (turn.timer) clearTimeout(turn.timer);
    this.timer = undefined;
  }

  stopProject(projectId: string): void {
    this.pending = this.pending.filter((event) => (event.projectId ?? null) !== projectId);
    const sessionId = this.sessionIdFor(projectId);
    const turn = this.active.get(sessionId);
    if (turn?.timer) clearTimeout(turn.timer);
    this.active.delete(sessionId);
    this.userBusy.delete(sessionId);
    this.retryCounts.delete(sessionId);
  }

  getQueuedEvents(): BrainQueuedEvent[] { return [...this.pending]; }
  isQueued(projectId: string | null): boolean { return this.pending.some((event) => (event.projectId ?? null) === projectId); }
  getUsage(projectId: string | null): { queued: boolean; lastTurnAt: string | null; tokensToday: number } {
    const day = new Date(this.now());
    day.setHours(0, 0, 0, 0);
    const latest = this.opts.turnRepo.latest(projectId);
    return { queued: this.isQueued(projectId), lastTurnAt: latest?.finishedAt || latest?.startedAt || null, tokensToday: this.opts.turnRepo.tokensSince(day.toISOString(), projectId) };
  }

  flush(): void {
    if (!this.started || this.pending.length === 0) return;
    const maxConcurrent = Math.max(1, this.opts.config.maxConcurrent || 2);
    while (this.active.size < maxConcurrent && this.pending.length > 0) {
      const projects = this.pendingProjects();
      if (projects.length === 0) return;
      let selected: { projectId: string | null; index: number } | undefined;
      let globalLimited = false;
      for (let offset = 0; offset < projects.length; offset += 1) {
        const index = (this.roundRobinCursor + offset) % projects.length;
        const projectId = projects[index];
        const result = this.canStart(projectId);
        if (result === 'global_limited') { globalLimited = true; break; }
        if (result === 'ready') { selected = { projectId, index }; break; }
      }
      if (globalLimited || !selected) return;
      this.roundRobinCursor = (selected.index + 1) % projects.length;
      this.startProjectTurn(selected.projectId);
    }
  }

  private pendingProjects(): Array<string | null> {
    const seen = new Set<string>();
    const result: Array<string | null> = [];
    for (const event of this.pending) {
      const projectId = event.projectId ?? null;
      const key = this.sessionIdFor(projectId);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(projectId);
    }
    return result;
  }

  private canStart(projectId: string | null): 'ready' | 'busy' | 'limited' | 'global_limited' {
    const sessionId = this.sessionIdFor(projectId);
    const mode = this.mode(projectId);
    if (mode === 'off' || mode === 'external') { this.dropProjectEvents(projectId); return 'busy'; }
    const session = this.ensureSession(projectId);
    if (session.busy === 1 || session.state === 'running' || session.state === 'waiting_limit' || this.active.has(sessionId) || this.userBusy.has(sessionId)) return 'busy';
    const now = this.now();
    const day = new Date(now);
    day.setHours(0, 0, 0, 0);
    const settings = this.projectSettings(projectId);
    const department = this.department(projectId);
    const departmentId = department?.id;
    const maxTurns = departmentId ? (department.brainMaxTurnsPerHour || this.opts.config.maxTurnsPerHour) : (settings.brain.maxTurnsPerHour ?? this.opts.config.maxTurnsPerHour);
    const budget = departmentId ? (department.brainDailyTokenBudget || this.opts.config.dailyTokenBudget) : (settings.brain.dailyTokenBudget ?? this.opts.config.dailyTokenBudget);
    const count = departmentId ? this.opts.turnRepo.countSinceDepartment(now - 3600000, departmentId) : this.opts.turnRepo.countSince(now - 3600000, projectId);
    const tokens = departmentId ? this.opts.turnRepo.tokensSinceDepartment(day.toISOString(), departmentId) : this.opts.turnRepo.tokensSince(day.toISOString(), projectId);
    if (count >= maxTurns || (budget > 0 && tokens >= budget)) {
      this.opts.eventBus.emit('brain.limited', projectId || undefined, { reason: 'budget' });
      return 'limited';
    }
    if (this.opts.config.dailyTokenBudget > 0 && this.opts.turnRepo.tokensSince(day.toISOString()) >= this.opts.config.dailyTokenBudget) {
      this.opts.eventBus.emit('brain.limited', projectId || undefined, { reason: 'budget', scope: 'global' });
      return 'global_limited';
    }
    return 'ready';
  }

  private startProjectTurn(projectId: string | null): void {
    const sessionId = this.sessionIdFor(projectId);
    const projectEvents = this.pending.filter((event) => this.sessionIdFor(event.projectId ?? null) === sessionId);
    const priority = projectEvents.find((event) => event.priority);
    const events = priority ? [priority] : projectEvents;
    this.pending = this.pending.filter((event) => this.sessionIdFor(event.projectId ?? null) !== sessionId || (priority ? event !== priority : false));
    const formatted = priority
      ? { text: this.formatDirectiveAcknowledgement(priority, projectId) }
      : this.formatEvents(events, this.mode(projectId), projectId);
    const input = formatted.text;
    const departmentId = this.department(projectId)?.id;
    const turn = this.opts.turnRepo.insert({ id: crypto.randomUUID(), trigger: 'event', input, projectId: departmentId ? null : projectId, departmentId });
    const active: ActiveTurn = { id: turn.id, events, retries: Math.max(0, ...events.map((event) => this.retryCounts.get(event.id || '') || 0)), knowledgeHash: formatted.knowledgeHash, departmentId };
    this.active.set(sessionId, active);
    try {
      this.opts.chatService.sendMessage(sessionId, input);
      if (active.knowledgeHash) this.sentKnowledgeHash.set(sessionId, active.knowledgeHash);
      active.timer = setTimeout(() => this.failActive(sessionId, 'brain turn timeout'), (this.opts.config.turnTimeoutSec ?? 1200) * 1000);
      active.timer.unref?.();
    } catch (error) {
      this.failActive(sessionId, error instanceof Error ? error.message : String(error));
    }
  }

  private dropProjectEvents(projectId: string | null): void {
    const sessionId = this.sessionIdFor(projectId);
    this.pending = this.pending.filter((event) => this.sessionIdFor(event.projectId ?? null) !== sessionId);
  }
  private projectSettings(projectId: string | null) { return projectSettings(projectId ? this.opts.projectRepo?.get(projectId) : null); }
  private department(projectId: string | null) {
    const project = projectId ? this.opts.projectRepo?.get(projectId) : undefined;
    return project?.departmentId ? this.opts.departmentRepo?.get(project.departmentId) : undefined;
  }
  private mode(projectId: string | null): EffectiveBrainMode {
    if (this.opts.config.mode === 'off') return 'off';
    const project = projectId ? this.opts.projectRepo?.get(projectId) : null;
    const projectMode = effectiveBrainMode(projectId, project, this.opts.config);
    const departmentMode = this.department(projectId)?.brainMode;
    return departmentMode && departmentMode !== 'inherit' && projectSettings(project).brain.mode === 'inherit' ? departmentMode : projectMode;
  }
  private sessionIdFor(projectId: string | null): string {
    const department = this.department(projectId);
    if (department && this.opts.departmentRepo) return `brain:department:${department.id}`;
    if (projectId) return `brain:${projectId}`;
    return this.opts.config.director?.enabled ? 'brain:director' : 'brain';
  }

  ensureSession(projectId: string | null) {
    const id = this.sessionIdFor(projectId);
    const project = projectId ? this.opts.projectRepo?.get(projectId) : undefined;
    const department = this.department(projectId);
    const permission = department?.brainPermissions && department.brainPermissions !== 'inherit'
      ? department.brainPermissions : effectiveBrainPermission(project, this.opts.config);
    const director = !projectId ? this.opts.config.director : undefined;
    const effectivePermission = director?.permissions || permission;
    const mode = effectivePermission === 'full' ? 'full' : 'safe';
    const existing = this.opts.chatSessionRepo.get(id) || this.opts.chatSessionRepo.getByKind('brain', projectId);
    if (existing) {
      if (existing.mode !== mode && existing.busy !== 1) {
        const chatService = this.opts.chatService as ChatService & { setSessionMode?: (id: string, mode: 'safe' | 'full') => unknown };
        try {
          if (typeof chatService.setSessionMode === 'function') {
            chatService.setSessionMode(existing.id, mode);
          } else {
            this.opts.chatSessionRepo.updateMode(existing.id, mode);
          }
        } catch {
          // A running turn can outlive the session's busy flag. Keep the old
          // mode and retry synchronization on the next runner event.
        }
      }
      return this.opts.chatSessionRepo.get(existing.id) || existing;
    }
    const engine = effectiveBrainEngine(project, this.opts.config);
    const resolvedEngine = director?.engine || department?.brainEngine || engine;
    const resolvedModel = director?.model || department?.brainModel || (resolvedEngine === 'codex' ? (this.opts.config.codexModel || 'gpt-5.6-luna') : this.opts.config.model);
    this.opts.chatService.getOrCreateSession(id, {
      title: department ? `Bộ não · ${department.name}` : project ? `Bộ não · ${project.name}` : director ? 'Bộ não Giám đốc' : 'Bộ não', mode,
      model: resolvedModel,
      profileName: resolvedEngine === 'codex' ? this.codexProfile(project, director?.codexProfile || department?.brainCodexProfile || undefined) : this.profileName(), kind: 'brain', projectId: department ? null : projectId,
    } as never);
    this.opts.chatSessionRepo.updatePinned(id, 1);
    return this.opts.chatSessionRepo.get(id)!;
  }

  private profileName(): string { return resolveClaudeProfile(this.opts.profileRepo || { getAll: () => [] }, this.opts.config.claudeProfile, this.opts.config.claudeProfileExplicit); }

  private codexProfile(project?: { settings?: string | null }, override?: string): string | null {
    return resolveCodexProfile(
      this.opts.profileRepo || { getAll: () => [] },
      effectiveBrainCodexProfile(
        project,
        { ...this.opts.config, codexProfile: override || this.opts.config.codexProfile },
      ),
    );
  }

  private onEvent(type: string, taskId?: string, payload?: unknown): void {
    const data = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {};
    if (type === 'brain.trust_changed' || type === 'config.updated') {
      if (type === 'config.updated' && (!data.brain || typeof data.brain !== 'object' || !('permissions' in data.brain))) return;
      const projectId = typeof data.projectId === 'string' ? data.projectId : null;
      if (projectId !== null) {
        if (this.opts.chatSessionRepo.get(this.sessionIdFor(projectId))) this.ensureSession(projectId);
      }
      else {
        this.ensureSession(null);
        for (const project of this.opts.projectRepo?.getAll?.() || []) {
          if (this.opts.chatSessionRepo.get(this.sessionIdFor(project.id))) this.ensureSession(project.id);
        }
      }
      return;
    }
    if (type === 'chat.compacted') {
      if (typeof data.sessionId === 'string') this.sentKnowledgeHash.delete(data.sessionId);
      return;
    }
    if (type === 'chat.message') {
      const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
      if (data.role === 'user') this.userBusy.add(sessionId);
      return;
    }
    if (type === 'chat.done' || type === 'chat.error') { this.finishChatEvent(type, data); return; }
    if (!this.started || !EVENT_TYPES.has(type)) return;
    if (SYSTEM_EVENTS.has(type) && (type === 'quota.exhausted' || type === 'claude.quota_exhausted') && this.opts.taskRepo) {
      const affectedTask = taskId ? this.opts.taskRepo.get(taskId) : undefined;
      if (!affectedTask || (affectedTask.status !== 'running' && affectedTask.status !== 'queued')) return;
    }
    const candidate = typeof data.projectId === 'string' ? data.projectId : taskId?.includes('/') ? taskId.slice(0, taskId.indexOf('/')) : null;
    const projectId = SYSTEM_EVENTS.has(type) ? null : (candidate && this.opts.projectRepo?.get(candidate) ? candidate : null);
    if (this.mode(projectId) === 'off' || this.mode(projectId) === 'external') return;
    this.pending.push({ id: crypto.randomUUID(), type, taskId, projectId, payload, priority: type === 'brain.directive_added' });
    this.schedule();
  }

  private finishChatEvent(type: string, data: Record<string, unknown>): void {
    const sessionId = typeof data.sessionId === 'string' ? data.sessionId : '';
    this.userBusy.delete(sessionId);
    const active = this.active.get(sessionId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    const usage = data.usage && typeof data.usage === 'object' ? data.usage as Record<string, unknown> : {};
    const quota = type === 'chat.error' && /quota|rate.?limit|429|usage limit|limit reached/i.test(String(data.message || ''));
    this.opts.turnRepo.finish(active.id, { status: type === 'chat.done' ? 'done' : quota ? 'quota' : 'failed', summary: typeof data.message === 'string' ? data.message : undefined, inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : 0, outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : 0, error: type === 'chat.error' ? String(data.message || 'brain turn failed') : undefined });
    this.active.delete(sessionId);
    const session = this.opts.chatSessionRepo.get(sessionId);
    if (type === 'chat.done') for (const event of active.events) this.retryCounts.delete(event.id || '');
    if (quota) {
      this.pending.unshift(...active.events);
      this.opts.eventBus.emit('brain.waiting', sessionId === 'brain' ? undefined : sessionId.slice('brain:'.length), { reason: 'quota' });
      this.schedule();
      if (session?.kind === 'brain') this.ensureSession(session.projectId);
      return;
    }
    if (type === 'chat.error') {
      this.retryFailedEvents(active, String(data.message || 'brain turn failed'));
      if (session?.kind === 'brain') this.ensureSession(session.projectId);
      return;
    }
    this.flush();
    if (session?.kind === 'brain') this.ensureSession(session.projectId);
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, this.debounceMs);
    this.timer.unref?.();
  }

  private formatEvents(events: BrainQueuedEvent[], mode: EffectiveBrainMode, projectId: string | null): { text: string; knowledgeHash?: string } {
    const project = projectId ? this.opts.projectRepo?.get(projectId) : undefined;
    const department = this.department(projectId);
    const context = department
      ? `Bạn là bộ não của phòng ban ${department.name}. Điều phối các project thuộc phòng này; đọc AGENTS.md/CLAUDE.md của từng repo khi cần.`
      : project ? `Bạn là bộ não của dự án ${project.name} (${project.path}). Chỉ xử lý dự án này. Đọc AGENTS.md/CLAUDE.md của repo.` : 'Bạn là bộ não hệ thống; chỉ xử lý sự cố hệ thống.';
    const seenQuota = new Set<string>();
    const lines = events.filter((event) => {
      if (event.type !== 'quota.exhausted' && event.type !== 'claude.quota_exhausted') return true;
      const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
      const key = `${event.type}:${String(payload.profile ?? '')}:${String(payload.family ?? '')}`;
      if (seenQuota.has(key)) return false;
      seenQuota.add(key);
      return true;
    }).slice(0, 30).map((event) => `- ${event.type}${event.taskId ? ` (${event.taskId})` : ''}${event.payload ? ` ${JSON.stringify(event.payload).slice(0, 500)}` : ''}`);
    const directives = this.opts.directiveRepo?.list(projectId).map((directive) => `- ${directive.text}`).join('\n') || '- Không có';
    const settings = projectId ? this.projectSettings(projectId) : null;
    const knowledgeProjects = [...new Set(events.map((event) => event.projectId).filter((id): id is string => typeof id === 'string'))];
    const knowledgeContexts = this.opts.knowledgeRepo
      ? (knowledgeProjects.length ? knowledgeProjects : projectId ? [projectId] : []).map((id) => {
          const item = this.opts.projectRepo?.get(id);
          const itemSettings = this.projectSettings(id);
          return buildProjectKnowledgeContext(this.opts.knowledgeRepo!.getByProject(id), itemSettings.references || [], undefined, item?.path);
        })
      : [];
    const knowledge = knowledgeContexts.length
      ? { text: knowledgeContexts.map((item) => item.text).join('\n\n'), hash: crypto.createHash('sha256').update(knowledgeContexts.map((item) => item.hash).join(':')).digest('hex') }
      : null;
    const key = this.sessionIdFor(projectId);
    let knowledgePrompt = 'KIẾN THỨC DỰ ÁN không đổi; hãy tiếp tục áp dụng kiến thức đã nhận.';
    let knowledgeHash: string | undefined;
    if (knowledge && this.sentKnowledgeHash.get(key) !== knowledge.hash) {
      knowledgePrompt = knowledge.text;
      knowledgeHash = knowledge.hash;
    }
    const checklist = settings?.reviewChecklist.length
      ? `\nCHECKLIST KHI DUYỆT (BẮT BUỘC):\n${settings.reviewChecklist.map((item) => `- ${item}`).join('\n')}\nKhi review phải liệt kê mục vi phạm hoặc ghi rõ “đã đối chiếu checklist: không vi phạm”.`
      : '';
    return { text: `${context}\n${knowledgePrompt}${checklist}\nCHỈ THỊ CỦA NGƯỜI DÙNG (bắt buộc tuân theo):\n${directives}\nSự kiện: ${lines.join('\n')}\n${mode === 'suggest' ? 'Chế độ suggest: chỉ đề xuất, chờ người dùng duyệt.' : 'Chế độ auto: làm theo BRAIN-PLAYBOOK khi an toàn.'}`, knowledgeHash };
  }

  private formatDirectiveAcknowledgement(event: BrainQueuedEvent, projectId: string | null): string {
    const project = projectId ? this.opts.projectRepo?.get(projectId) : undefined;
    const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
    return `${project ? `Bạn là bộ não của dự án ${project.name} (${project.path}).` : 'Bạn là bộ não hệ thống.'}\nCHỈ THỊ MỚI CỦA NGƯỜI DÙNG (bắt buộc tuân theo):\n- ${typeof payload.text === 'string' ? payload.text : 'Đã có chỉ thị mới.'}\nHãy xác nhận đã nhận và áp dụng chỉ thị này trong các lượt sau; chưa xử lý sự kiện nào khác.`;
  }

  private failActive(sessionId: string, error: string): void {
    const active = this.active.get(sessionId);
    if (!active) return;
    if (active.timer) clearTimeout(active.timer);
    this.opts.turnRepo.finish(active.id, { status: 'failed', error });
    this.active.delete(sessionId);
    this.retryFailedEvents(active, error);
  }

  private retryFailedEvents(active: ActiveTurn, error: string): void {
    active.retries += 1;
    for (const event of active.events) this.retryCounts.set(event.id || '', active.retries);
    if (active.retries >= MAX_RETRIES) {
      this.opts.eventBus.emit('brain.notify', undefined, { level: 'incident', text: `Bộ não không xử lý được sự kiện sau ${MAX_RETRIES} lần: ${error}` });
      this.flush();
      return;
    }
    this.pending.unshift(...active.events);
    this.schedule();
  }
}
