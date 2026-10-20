import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile, execFileSync, type ChildProcess } from 'node:child_process';
import { promisify } from 'node:util';
import { getMonitoredDisks, type MonitoredDisk } from '../disk.js';
import {
  TaskRepo,
  RunRepo,
  EventRepo,
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  ReviewRepo,
  RunMetricsRepo,
  TaskRow,
  ProfileRow,
} from '../db/index.js';
import { Engine, AgyEngine, CodexEngine } from '../engines/index.js';
import { getModelFamily, getModelEngine, QuotaService } from '../quota/index.js';
import { WorktreeService } from '../worktrees/index.js';
import { ensureWorktreeNodeModules } from '../cache.js';
import { AgentHubConfig } from '../config.js';
import { ProfileLockService } from '../profiles/locks.js';
import { QuotaUsageService } from '../quota/usage.js';
import { CheckRunner, getCheckResults } from '../checks.js';
import { parseDbTime } from '../db/time.js';
import type Database from 'better-sqlite3';
import { parseCodexTokens, parseShortstat, recalculateTaskLines, measureTaskLines } from '../savings.js';

const execFileAsync = promisify(execFile);
import { ClaudeFailoverState } from '../chat/failover.js';
import { buildReviewerPrompt, parseReviewerOutput, ReviewerVerdict } from '../reviewer.js';
import { listAllWorktreeProcesses, reap, reapSyncForWorktree } from '../reaper.js';
import { LoadGuard, LoadSnapshot } from '../load.js';

type ActivitySource = 'log' | 'conversation' | 'worktree';

const PROTOCOL_PROMPT = `Đọc \`.agenthub/task.md\` và thực hiện. Đọc thêm AGENTS.md / CLAUDE.md / GEMINI.md của project nếu có. Làm trên nhánh hiện tại, commit nhỏ theo Conventional Commits. KHÔNG dùng subagent / agent con; tự làm tuần tự trong phiên này. Tránh đọc lại file lớn không cần thiết. \`node_modules\` đã được chuẩn bị sẵn, KHÔNG chạy \`npm ci\`/\`npm install\` trừ khi bạn sửa \`package.json\`. KHÔNG chạy test/lệnh ở chế độ nền (background) rồi chờ: luôn chạy trực tiếp (foreground) và bọc \`timeout 300\`; test dùng \`--run\`, không watch. KHÔNG sửa file ngoài phạm vi task. Khi xong tạo \`.agenthub/DONE\` (tóm tắt, kết quả lint/test, việc còn thiếu); nếu bị chặn tạo \`.agenthub/BLOCKED\` (lý do). Chỉ tạo marker ở bước cuối.`;

export class EventBus extends EventEmitter {
  constructor(private eventRepo: EventRepo) {
    super();
  }

  emit(type: string, taskId?: string, payload?: unknown): boolean {
    this.eventRepo.insert(type, taskId, payload);
    super.emit('*', type, taskId, payload);
    return super.emit(type, taskId, payload);
  }

  emitEphemeral(type: string, taskId?: string, payload?: unknown): boolean {
    super.emit('*', type, taskId, payload);
    return super.emit(type, taskId, payload);
  }
}

interface RunningTask {
  runId: string;
  taskId: string;
  pid: number;
  pidStart: number | null;
  profileName: string;
  model: string;
  engine: Engine;
  startTime: number;
  timeoutMs: number;
  timeoutAt: number;
  retryCount: number;
  projectId: string;
  lastOutputAt: number;
  lastActivityAt: number;
  activitySource: ActivitySource;
  activityCheckedAt: number;
  cachedConversationMtime: number;
  cachedWorktreeMtime: number;
  usageBefore: number | null;
  lockFile?: string;
  lockSlot?: number;
  child?: ChildProcess;
  exitCode?: number | null;
  // Stall & looping detection
  lastCommitCheckAt?: number;
  lastCommitCount?: number;
  lastNoCommitThresholdEmitted?: number;
  noCommitMinutes?: number;
  isLooping?: boolean;
  loopingCommand?: string;
  commandOccurrences?: Array<{ command: string; timestamp: number }>;
  lastLogOffset?: number;
}

interface StartingTask {
  projectId: string;
  profileName: string;
}

interface ReviewerRun {
  taskId: string;
  runId: string;
  pid: number;
  profileName: string;
  engine: Engine;
  outputPath: string;
  lockSlot: number;
  lockFile?: string;
  startedAt: number;
  timeout: NodeJS.Timeout;
  exitTimeout?: NodeJS.Timeout;
}

const STALL_NOTE = 'Lượt trước bị kẹt khi chờ tác vụ nền. Chạy lệnh trực tiếp với timeout.';

export class Scheduler {
  private running: Map<string, RunningTask> = new Map(); // taskId -> RunningTask
  // Reservations made synchronously before startTask reaches its first await.
  // This closes the dispatch race where several queued tasks are started in one tick.
  private starting: Map<string, StartingTask> = new Map();
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;
  private skipSchedulingOnce = false;
  private diskLow = false;
  private dockerDiskLow = false;
  private tasksWaitingForDisk = new Set<string>();
  private eventBus: EventBus;
  private quotaService: QuotaService;
  private worktreeService: WorktreeService;
  private engines: Map<string, Engine> = new Map();
  private locks: ProfileLockService;
  private checkRunner?: CheckRunner;
  private db?: Database.Database;
  private runMetricsRepo?: RunMetricsRepo;
  private reviewRepo?: ReviewRepo;
  private failoverState?: ClaudeFailoverState;
  private reviewerRuns = new Map<string, ReviewerRun>();
  private failoverWasActive = false;
  private lastOrphanScan = 0;
  private recheckWaitingOnDiskOk = true;
  private loadGuard: LoadGuard;
  private lastLoadOverloaded = false;

  constructor(
    private config: AgentHubConfig,
    private taskRepo: TaskRepo,
    private runRepo: RunRepo,
    private eventRepo: EventRepo,
    private projectRepo: ProjectRepo,
    private profileRepo: ProfileRepo,
    private quotaMarkRepo: QuotaMarkRepo,
    engineOverrides?: Map<string, Engine>,
    private usageService?: QuotaUsageService,
    locks?: ProfileLockService,
    db?: Database.Database,
    runMetricsRepo?: RunMetricsRepo,
  ) {
    this.eventBus = new EventBus(eventRepo);
    this.quotaService = new QuotaService(quotaMarkRepo, profileRepo);
    this.worktreeService = new WorktreeService(config, this.eventBus);
    this.loadGuard = new LoadGuard(config.load);
    this.locks = locks || new ProfileLockService(path.join(config.agyHomesDir, '.state'), config.slotsPerAgyProfile, config.slotsPerCodexProfile);
    this.db = db;
    this.runMetricsRepo = runMetricsRepo;
    if (db) this.checkRunner = new CheckRunner(db);

    if (engineOverrides) {
      this.engines = engineOverrides;
    } else {
      this.engines.set('agy', new AgyEngine());
      const codexPath = CodexEngine.findCodexPath();
      if (codexPath) {
        this.engines.set('codex', new CodexEngine(codexPath));
      }
    }

    this.eventBus.on('profile.created', () => this.wakeWaitingQuotaTasks('profile_created'));
    this.eventBus.on('profile.updated', () => this.wakeWaitingQuotaTasks('profile_updated'));
    this.eventBus.on('quota.cleared', () => this.wakeWaitingQuotaTasks('quota_cleared'));
    this.eventBus.on('task.done', (taskId) => this.onTaskDoneOrCancelled(taskId));
    this.eventBus.on('task.cancelled', (taskId) => this.onTaskDoneOrCancelled(taskId));
  }

  getCheckResults(taskId: string) { return this.db ? getCheckResults(this.db, taskId) : []; }
  getDatabase(): Database.Database | undefined { return this.db; }

  configureReviewer(reviewRepo: ReviewRepo, failoverState: ClaudeFailoverState): void {
    this.reviewRepo = reviewRepo;
    this.failoverState = failoverState;
  }

  getReviewerStatus(): { active: boolean; running: string[]; waiting: number } {
    const active = this.failoverState?.snapshot().active === true;
    return { active, running: [...this.reviewerRuns.keys()], waiting: active ? Math.max(0, this.taskRepo.getByStatus('review').length - this.reviewerRuns.size) : 0 };
  }

  getEventBus(): EventBus {
    return this.eventBus;
  }

  getRunning(): Map<string, RunningTask> {
    for (const runningTask of this.running.values()) this.refreshActivity(runningTask);
    return this.running;
  }

  effectiveParallel(project: { maxParallel: number }): number {
    return this.loadGuard.effectiveParallel(project.maxParallel);
  }

  getLoadStatus(): LoadSnapshot {
    return this.loadGuard.getStatus();
  }

  private paused = false;

  pause(): void {
    this.paused = true;
    this.eventBus.emit('scheduler.paused', undefined, { paused: true });
  }

  resume(): void {
    this.paused = false;
    this.eventBus.emit('scheduler.resumed', undefined, { paused: false });
    this.triggerTick();
  }

  isPaused(): boolean {
    return this.paused;
  }

  start(): void {
    this.stopped = false;
    // The orphan pass is periodic; do not scan and potentially reap processes
    // during daemon startup while tests or callers are still preparing state.
    this.lastOrphanScan = Date.now();
    // Recover crashed runs on startup
    this.recoverOnStartup();
    this.skipSchedulingOnce = true;

    // Start the scheduler loop (every 2 seconds)
    this.timer = setInterval(() => this.tick(), 2000);
    // Also run immediately
    this.tick();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    this.stopped = true;
    this.starting.clear();

    for (const run of this.reviewerRuns.values()) {
      clearTimeout(run.timeout);
      if (run.exitTimeout) {
        clearTimeout(run.exitTimeout);
      }
      if (run.lockFile) {
        this.locks.release(run.profileName, run.lockFile);
      }
    }
    this.reviewerRuns.clear();
    this.locks.clearReservations();
  }

  cancelAll(): void {
    for (const taskId of [...this.running.keys()]) {
      this.killTask(taskId, 'cancelled');
    }
  }

  /**
   * On startup: mark any runs that were "running" but whose pid is no longer alive as crashed.
   * Re-queue their tasks.
   */
  private recoverOnStartup(): void {
    const runningRuns = this.runRepo.getRunning();
    for (const run of runningRuns) {
      if (run.kind === 'reviewer') {
        // Reviewer runs are durable for audit/recovery only. Never restore one
        // into the worker map: after a daemon restart it is safer to stop the
        // old read-only process and schedule a fresh review.
        if (run.pid && this.isProcessAlive(run.pid, run.pidStart)) this.killProcessGroup(run.pid);
        this.runRepo.finish(run.id, 'crashed', undefined, 'reviewer interrupted during restart');
        if (this.taskRepo.get(run.taskId)?.status === 'review') {
          this.eventBus.emit('review.failed', run.taskId, { actor: 'codex-reviewer', reason: 'restart_recovery', runId: run.id });
        }
        continue;
      }
      if (!this.isProcessAlive(run.pid, run.pidStart)) {
        this.runRepo.finish(run.id, 'crashed');
        this.taskRepo.update(run.taskId, { status: 'queued', resume: 1 });
        this.eventBus.emit('run.crashed', run.taskId, { runId: run.id });
        this.eventBus.emit('task.queued', run.taskId);
        continue;
      }

      const task = this.taskRepo.get(run.taskId);
      const engine = this.engines.get(run.engine);
      if (!task || !engine || !run.pid) continue;
      const startTime = parseDbTime(run.startedAt);
      const timeoutMs = this.config.defaultTimeout * 1000;
      const timeoutAt = Math.max(startTime + timeoutMs, Date.now() + 30 * 60 * 1000);
      if (timeoutAt > startTime + timeoutMs) {
        console.warn(`[scheduler] deferred timeout for recovered run ${run.id} until ${new Date(timeoutAt).toISOString()}`);
        this.eventBus.emit('run.timeout_deferred', run.taskId, { runId: run.id, timeoutAt: new Date(timeoutAt).toISOString() });
      }
      this.running.set(run.taskId, {
        runId: run.id,
        taskId: run.taskId,
        pid: run.pid,
        pidStart: run.pidStart,
        profileName: run.profileName,
        model: run.model,
        engine,
        startTime: Number.isNaN(startTime) ? Date.now() : startTime,
        timeoutMs,
        timeoutAt: Number.isNaN(startTime) ? Date.now() + timeoutMs : timeoutAt,
        retryCount: task.transientRetries,
        projectId: task.projectId,
        lastOutputAt: this.getLogMtime(run.logPath) || startTime,
        lastActivityAt: this.getLogMtime(run.logPath) || startTime,
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore: null,
      });
    }

    // Re-check tasks that were in 'checking' status when daemon restarted
    void this.recoverCheckingTasks();
  }

  async recoverCheckingTasks(): Promise<void> {
    const checkingTasks = this.taskRepo.getByStatus('checking');
    for (const task of checkingTasks) {
      const runs = this.runRepo.getByTask(task.id);
      const runId = runs[runs.length - 1]?.id || 'recovered';
      await this.runChecksForTask(task.id, runId);
    }
  }

  async runChecksForTask(taskId: string, runId: string): Promise<void> {
    const task = this.taskRepo.get(taskId);
    if (!task) return;
    this.taskRepo.update(taskId, { status: 'checking' });
    this.eventBus.emit('task.checking', taskId);

    const project = this.projectRepo.get(task.projectId);
    const checks = this.checkRunner && project
      ? await this.checkRunner.run(task, project, runId)
      : { passed: true, failed: [], results: [] };

    // Check if task status was changed (e.g. cancelled) during checks
    const currentTask = this.taskRepo.get(taskId);
    if (!currentTask || currentTask.status !== 'checking') return;

    if (!checks.passed && this.config.autoFixOnFail && currentTask.checkFixAttempts < 2) {
      const feedback = checks.results
        .filter((result) => !result.ok)
        .map((result) => `### ${result.name}\n\n${result.outputTail.split('\n').slice(-60).join('\n')}`)
        .join('\n\n');
      const newBody = `${currentTask.body || currentTask.title}\n\n## Feedback tự sửa lần ${currentTask.checkFixAttempts + 1}\n\nCác kiểm tra sau thất bại:\n\n${feedback}`;
      this.taskRepo.update(taskId, {
        status: 'queued',
        resume: 1,
        checkFixAttempts: currentTask.checkFixAttempts + 1,
        body: newBody,
      });
      if (currentTask.worktreePath) {
        const donePath = path.join(currentTask.worktreePath, '.agenthub', 'DONE');
        if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
        this.worktreeService.writeTaskFile(currentTask.worktreePath, newBody, true, feedback);
      }
      this.eventBus.emit('task.queued', taskId, { reason: 'checks_failed_autofix', failed: checks.failed });
    } else {
      this.taskRepo.update(taskId, { status: 'review', transientRetries: 0, notBefore: null });
      if (this.runMetricsRepo) {
        await recalculateTaskLines(
          this.taskRepo,
          this.projectRepo,
          this.runRepo,
          this.runMetricsRepo,
          taskId,
        );
      }
      this.eventBus.emit('task.review_ready', taskId, { checksPassed: checks.passed, failed: checks.failed });
    }
    if (!this.stopped) this.triggerTick();
  }

  /**
   * Main scheduler tick
   */
  tick(): void {
    this.loadGuard.setConfig(this.config.load);
    const load = this.loadGuard.update();
    if (load.overloaded !== this.lastLoadOverloaded) {
      this.lastLoadOverloaded = load.overloaded;
      this.eventBus.emit(load.overloaded ? 'load.high' : 'load.ok', undefined, load);
    }
    // 0. Check disk space: if sufficient, resume any tasks waiting for disk
    const disks = this.getMonitoredDisks();
    const blockedDisk = disks.find((disk) => disk.low);
    if (blockedDisk) {
      this.markDiskLow(blockedDisk);
      const dockerDisk = disks.find((disk) => disk.label === 'Docker' && disk.low);
      if (dockerDisk && this.running.size > 0) this.markDockerDiskLow(dockerDisk);
    } else {
      const diskSpace = disks.find((disk) => disk.source === 'worktrees')!;
      this.dockerDiskLow = false;
      if (this.diskLow) {
        this.diskLow = false;
        this.eventBus.emit('disk.ok', undefined, {
          freeGB: diskSpace.freeGB,
          minFreeGB: this.config.disk.minFreeGB,
        });
      }
      if (this.tasksWaitingForDisk.size > 0) {
        for (const taskId of [...this.tasksWaitingForDisk]) {
          const task = this.taskRepo.get(taskId);
          if (task && (task.status === 'waiting_quota' || (task.status as string) === 'waiting_disk')) {
            this.taskRepo.updateStatus(taskId, 'queued');
            this.eventBus.emit('task.queued', taskId, { reason: 'disk_ready' });
          }
        }
        this.tasksWaitingForDisk.clear();
      }
      const diskWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'disk');
      for (const t of diskWaiters) {
        this.taskRepo.updateStatus(t.id, 'queued');
        this.eventBus.emit('task.queued', t.id, { reason: 'disk_ready' });
      }
      if (this.recheckWaitingOnDiskOk) {
        // tasksWaitingForDisk chỉ nằm trong bộ nhớ: sau khi daemon restart, task đã vào
        // waiting_quota vì đĩa sẽ kẹt mãi. Đánh thức lại một lần; task thật sự hết quota
        // sẽ được dispatch đưa về waiting_quota như cũ.
        this.recheckWaitingOnDiskOk = false;
        this.wakeWaitingQuotaTasks('startup_recheck');
      }
    }

    // 0b. Resume parallel waiters if project slot is available
    const parallelWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'parallel');
    for (const task of parallelWaiters) {
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;
      const runningInProject = Array.from(this.running.values()).filter((r) => r.projectId === task.projectId).length;
      const startingInProject = Array.from(this.starting.values()).filter((r) => r.projectId === task.projectId).length;
      if (runningInProject + startingInProject < project.maxParallel) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'parallel_available' });
      }
    }

    // 0c. Resume busy profile waiters if a matching profile became available
    const busyProfileWaiters = this.taskRepo.getByStatus('waiting_quota').filter((t) => t.waitReason === 'profile_busy');
    for (const task of busyProfileWaiters) {
      if (!this.hasBusyMatchingProfile(task) || Boolean(this.findModelProfilePair(task))) {
        this.taskRepo.updateStatus(task.id, 'queued');
        this.eventBus.emit('task.queued', task.id, { reason: 'profile_available' });
      }
    }

    // 1. Check quota expiry → move waiting_quota tasks back to queued
    this.checkQuotaExpiry();

    // 2. Check running tasks for completion
    void this.checkRunningTasks().catch(() => {});

    // 3. Start new tasks if possible
    this.scheduleNewTasks();

    // 3b. Claude failover reviews tasks that are waiting for review.
    this.scheduleReviews();

    // 4. Prune expired worktrees for completed tasks
    this.cleanExpiredWorktrees();
    if (Date.now() - this.lastOrphanScan >= 10 * 60 * 1000) {
      this.lastOrphanScan = Date.now();
      this.reapOrphans();
    }
  }

  /** Reap worker descendants left behind after a worktree is deleted or a task stops. */
  reapOrphans(): void {
    const tasks = this.taskRepo.getAll();
    const oldProcessCutoff = Date.now() - 30 * 60 * 1000;
    const processes = listAllWorktreeProcesses({ worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    for (const info of processes) {
      const dir = info.cwd.replace(/ \(deleted\)$/, '');
      if (info.cwd.endsWith(' (deleted)')) {
        reapSyncForWorktree(dir, { worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
        continue;
      }

      const task = tasks.find((candidate) => {
        if (!candidate.worktreePath) return false;
        const worktreePath = path.resolve(candidate.worktreePath);
        const cwd = path.resolve(info.cwd);
        return cwd === worktreePath || cwd.startsWith(worktreePath + path.sep);
      });
      const taskCanBeReaped = task && (task.status === 'done' || task.status === 'cancelled');
      if (info.startedAt > oldProcessCutoff) continue;
      if (task && !taskCanBeReaped) continue;
      reapSyncForWorktree(dir, { worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    }
  }

  /**
   * Force an immediate tick (for event-driven scheduling)
   */
  triggerTick(): void {
    this.tick();
  }

  wakeWaitingQuotaTasks(reason = 'quota_unblocked'): void {
    const waitingTasks = this.taskRepo.getByStatus('waiting_quota');
    for (const task of waitingTasks) {
      if (reason !== 'startup_recheck' && task.waitReason === 'disk') {
        if (this.getMonitoredDisks().some((disk) => disk.low)) continue;
      }
      this.taskRepo.updateStatus(task.id, 'queued');
      this.eventBus.emit('task.queued', task.id, { reason });
    }
    if (waitingTasks.length > 0 && !this.stopped) {
      this.triggerTick();
    }
  }

  private checkQuotaExpiry(): void {
    const expired = this.quotaService.cleanupExpired();
    if (expired.length > 0) {
      this.wakeWaitingQuotaTasks('quota_expired');
    }
  }

  private async checkRunningTasks(): Promise<void> {
    if (this.running.size === 0) return;
    const now = Date.now();
    for (const [taskId, rt] of this.running) {
      // Check timeout
      if (now > rt.timeoutAt) {
        this.killTask(taskId, 'timeout');
        continue;
      }

      // Check if process is still alive
      if (!this.isProcessAlive(rt.pid, rt.pidStart)) {
        // Process has ended, check results
        void this.handleRunCompletion(taskId, rt);
        continue;
      }

      if (this.isStalled(rt)) {
        this.handleStall(taskId, rt);
        continue;
      }

      // Check no-commit watch every 5 minutes
      if (!rt.lastCommitCheckAt || now - rt.lastCommitCheckAt >= 5 * 60 * 1000) {
        await this.checkTaskCommits(taskId, rt, now);
        rt.lastCommitCheckAt = now;
      }

      // Check looping detection
      this.checkTaskLooping(taskId, rt, now);
    }
  }

  async checkTaskCommits(taskId: string, runningTask?: RunningTask, now = Date.now(), force = false): Promise<void> {
    const rt = runningTask || this.running.get(taskId);
    if (!rt) return;
    if (!force && rt.lastCommitCheckAt && now - rt.lastCommitCheckAt < 5 * 60 * 1000) {
      return;
    }

    const task = this.taskRepo.get(taskId);
    if (!task) return;
    const project = this.projectRepo.get(task.projectId);
    const baseRef = task.baseRef || project?.defaultBranch || 'main';
    const branch = task.branch || `agenthub/${task.slug}`;

    const repoPath = (task.worktreePath && fs.existsSync(path.join(task.worktreePath, '.git')))
      ? task.worktreePath
      : (project?.path && fs.existsSync(project.path) ? project.path : undefined);

    if (!repoPath) return;

    let timestamps: number[] = [];
    try {
      const { stdout } = await execFileAsync('git', ['log', '--format=%ct', `${baseRef}..${branch}`], {
        cwd: repoPath,
      });
      timestamps = stdout
        .trim()
        .split('\n')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => parseInt(s, 10) * 1000)
        .filter((n) => !isNaN(n));
    } catch {
      timestamps = [];
    }

    const commitCount = timestamps.length;
    rt.lastCommitCount = commitCount;

    const lastCommitTime = commitCount > 0 ? timestamps[0] : rt.startTime;
    const elapsedMs = Math.max(0, now - lastCommitTime);
    const elapsedMinutes = Math.floor(elapsedMs / (60 * 1000));

    const thresholdMin = this.config.stall?.noCommitMin ?? 45;
    if (elapsedMinutes > thresholdMin) {
      rt.noCommitMinutes = elapsedMinutes;
      const thresholdTier = Math.floor(elapsedMinutes / thresholdMin);
      if ((rt.lastNoCommitThresholdEmitted || 0) < thresholdTier) {
        rt.lastNoCommitThresholdEmitted = thresholdTier;
        this.eventBus.emit('task.no_commit', taskId, {
          minutes: elapsedMinutes,
          commits: commitCount,
          lastCommitAt: commitCount > 0 ? new Date(timestamps[0]).toISOString() : null,
        });

        if (task.worktreePath && fs.existsSync(task.worktreePath)) {
          const taskMdPath = path.join(task.worktreePath, '.agenthub', 'task.md');
          if (fs.existsSync(taskMdPath)) {
            try {
              const content = fs.readFileSync(taskMdPath, 'utf-8');
              const reminder = 'Hãy commit phần đã xong và thu hẹp phạm vi.';
              if (!content.includes('Hãy commit phần đã xong và thu hẹp phạm vi')) {
                const separator = content.endsWith('\n') ? '\n' : '\n\n';
                fs.writeFileSync(taskMdPath, content + separator + reminder + '\n', 'utf-8');
              }
            } catch {
              // ignore write error
            }
          }
        }
      }
    } else {
      rt.noCommitMinutes = undefined;
      rt.lastNoCommitThresholdEmitted = 0;
    }
  }

  checkTaskLooping(taskId: string, runningTask?: RunningTask, now = Date.now()): void {
    const rt = runningTask || this.running.get(taskId);
    if (!rt) return;

    const run = this.runRepo.get(rt.runId);
    if (!run?.logPath || !fs.existsSync(run.logPath)) return;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(run.logPath);
    } catch {
      return;
    }

    if (!rt.commandOccurrences) {
      rt.commandOccurrences = [];
    }

    const lastOffset = rt.lastLogOffset || 0;
    if (stat.size < lastOffset) {
      rt.lastLogOffset = 0;
      rt.commandOccurrences = [];
    }

    const currentOffset = rt.lastLogOffset || 0;
    if (stat.size > currentOffset) {
      try {
        const fd = fs.openSync(run.logPath, 'r');
        const bytesToRead = stat.size - currentOffset;
        const buf = Buffer.alloc(bytesToRead);
        fs.readSync(fd, buf, 0, bytesToRead, currentOffset);
        fs.closeSync(fd);
        rt.lastLogOffset = stat.size;

        const newChunk = buf.toString('utf-8');
        const lines = newChunk.split('\n');

        for (const rawLine of lines) {
          // eslint-disable-next-line no-control-regex
          const cleanLine = rawLine.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '');
          if (cleanLine.includes('playwright test') || cleanLine.includes('pnpm test:ui')) {
            const matchTs = cleanLine.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)\]?/);
            let lineTime = matchTs ? Date.parse(matchTs[1]) : NaN;
            if (isNaN(lineTime)) {
              lineTime = now;
            }
            const cmd = cleanLine
              .replace(/^\[[^\]]+\]\s*/, '')
              .replace(/^[$>#]\s*/, '')
              .trim();

            if (cmd) {
              rt.commandOccurrences.push({ command: cmd, timestamp: lineTime });
            }
          }
        }
      } catch {
        // ignore read error
      }
    }

    const windowMs = 30 * 60 * 1000;
    const cutoff = now - windowMs;
    rt.commandOccurrences = rt.commandOccurrences.filter((entry) => entry.timestamp >= cutoff);

    const counts = new Map<string, number>();
    for (const entry of rt.commandOccurrences) {
      counts.set(entry.command, (counts.get(entry.command) || 0) + 1);
    }

    const threshold = this.config.stall?.loopThreshold ?? 6;
    let loopingCmd: string | undefined;
    let maxCount = 0;

    for (const [cmd, count] of counts.entries()) {
      if (count > threshold && count > maxCount) {
        loopingCmd = cmd;
        maxCount = count;
      }
    }

    if (loopingCmd) {
      rt.loopingCommand = loopingCmd;
      if (!rt.isLooping) {
        rt.isLooping = true;
        this.eventBus.emit('task.looping', taskId, {
          command: loopingCmd,
          count: maxCount,
          runId: rt.runId,
        });
      }
    } else {
      rt.isLooping = false;
      rt.loopingCommand = undefined;
    }
  }

  private isStalled(rt: RunningTask): boolean {
    const run = this.runRepo.get(rt.runId);
    this.refreshActivity(rt, run?.logPath);
    const silentMs = Date.now() - rt.lastActivityAt;
    const stallMs = this.config.watchdog.stallMinutes * 60 * 1000;
    if (silentMs > stallMs) return true;
    if (silentMs <= this.config.watchdog.waitingMinutes * 60 * 1000) return false;
    if (!this.logTail(run?.logPath, 20).includes('waiting up to')) return false;
    const waitingMs = this.config.watchdog.waitingMinutes * 60 * 1000;
    const logSilent = Date.now() - this.getLogMtime(run?.logPath) > waitingMs;
    const conversation = this.getConversationMtime(rt);
    const conversationSilent = conversation === 0 || Date.now() - conversation > waitingMs;
    return logSilent && (rt.engine.id !== 'agy' || conversationSilent);
  }

  private handleStall(taskId: string, rt: RunningTask): void {
    this.killProcessGroup(rt.pid);
    const stalledTask = this.taskRepo.get(taskId);
    if (stalledTask?.worktreePath) {
      reapSyncForWorktree(stalledTask.worktreePath, { worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    }
    this.running.delete(taskId);
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    this.locks.invalidate(rt.profileName);
    this.runRepo.finish(rt.runId, 'crashed', undefined, 'stalled');
    this.eventBus.emit('run.stalled', taskId, { runId: rt.runId });

    const stalledCount = this.runRepo.getByTask(taskId).filter((run) => run.reason === 'stalled').length;
    if (stalledCount <= 2) {
      const task = this.taskRepo.get(taskId);
      if (!task) return;
      const body = `${task.body || task.title}\n\n${STALL_NOTE}`;
      this.taskRepo.update(taskId, { status: 'queued', resume: 1, body });
      this.eventBus.emit('task.queued', taskId, { reason: 'stalled_retry', note: STALL_NOTE });
    } else {
      this.taskRepo.updateStatus(taskId, 'failed');
      this.eventBus.emit('task.failed', taskId, { reason: 'stalled_limit' });
    }
  }

  private getLogMtime(logPath: string | null | undefined): number {
    if (!logPath) return 0;
    try { return fs.statSync(logPath).mtimeMs; } catch { return 0; }
  }

  private getConversationMtime(rt: RunningTask): number {
    if (rt.engine.id !== 'agy') return 0;
    const profile = this.profileRepo.get(rt.profileName);
    const home = profile?.kind === 'keyring' ? process.env.HOME || '' : profile?.home || '';
    if (!home) return 0;
    const dir = path.join(home, '.gemini', 'antigravity-cli', 'conversations');
    let latest = 0;
    try {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (!entry.isFile() || !/\.db(?:-wal)?$/.test(entry.name)) continue;
        const mtime = fs.statSync(path.join(dir, entry.name)).mtimeMs;
        if (mtime > rt.startTime && mtime > latest) latest = mtime;
      }
    } catch { /* Conversation directory may not exist yet. */ }
    // A profile may have two slots; without a conversation id, use the newest DB.
    return latest;
  }

  private getWorktreeMtime(worktreePath: string | null | undefined, startedAt: number, cachedMtime = 0): number {
    if (!worktreePath) return cachedMtime;
    const ignored = ['node_modules', '.git/objects', 'dist'];
    let latest = 0;
    let seen = 0;
    const visit = (dir: string, relative = ''): boolean => {
      if (seen >= 5000) return false;
      let entries: fs.Dirent[];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }
      for (const entry of entries) {
        if (seen >= 5000) return false;
        const rel = relative ? `${relative}/${entry.name}` : entry.name;
        if (ignored.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
        const full = path.join(dir, entry.name);
        seen++;
        try {
          const stat = fs.statSync(full);
          if (stat.isDirectory()) {
            if (visit(full, rel)) return true;
          }
          else if (stat.mtimeMs > startedAt && stat.mtimeMs > latest) {
            latest = stat.mtimeMs;
            if (latest > cachedMtime) return true;
          }
        } catch { /* Files can disappear while a worker edits them. */ }
      }
      return false;
    };
    visit(worktreePath);
    return Math.max(latest, cachedMtime);
  }

  private refreshActivity(rt: RunningTask, logPath?: string | null): void {
    const run = logPath === undefined ? this.runRepo.get(rt.runId) : undefined;
    const actualLogPath = logPath === undefined ? run?.logPath : logPath;
    const logMtime = this.getLogMtime(actualLogPath);
    if (logMtime > rt.lastActivityAt) {
      rt.lastActivityAt = logMtime;
      rt.lastOutputAt = logMtime;
      rt.activitySource = 'log';
    }

    const now = Date.now();
    if (now - rt.activityCheckedAt < 30_000) return;

    // Conversation and worktree scans are deliberately cached: a scheduler tick
    // runs every two seconds, while a recursive scan can inspect thousands of files.
    const conversationMtime = this.getConversationMtime(rt);
    rt.cachedConversationMtime = Math.max(rt.cachedConversationMtime, conversationMtime);
    const task = this.taskRepo.get(rt.taskId);
    const worktreePath = task?.worktreePath;
    let worktreeMtime = 0;
    if (worktreePath) {
      try {
        const indexMtime = fs.statSync(path.join(worktreePath, '.git', 'index')).mtimeMs;
        worktreeMtime = Math.max(worktreeMtime, indexMtime > rt.startTime ? indexMtime : 0);
      } catch { /* Worktrees without an index are still checked recursively. */ }
      if (worktreeMtime <= rt.cachedConversationMtime && conversationMtime <= rt.lastActivityAt) {
        worktreeMtime = this.getWorktreeMtime(worktreePath, rt.startTime, rt.cachedWorktreeMtime);
      }
    }
    rt.cachedWorktreeMtime = Math.max(rt.cachedWorktreeMtime, worktreeMtime);
    rt.activityCheckedAt = now;

    const candidates: Array<{ source: ActivitySource; mtime: number }> = [
      { source: 'log', mtime: logMtime },
      { source: 'conversation', mtime: rt.cachedConversationMtime },
      { source: 'worktree', mtime: rt.cachedWorktreeMtime },
    ];
    const activity = candidates.reduce((best, candidate) => candidate.mtime > best.mtime ? candidate : best, { source: 'log' as ActivitySource, mtime: rt.startTime });
    rt.lastActivityAt = activity.mtime || rt.startTime;
    rt.activitySource = activity.source;
    rt.lastOutputAt = rt.lastActivityAt;
  }

  private logTail(logPath: string | null | undefined, lines: number): string {
    if (!logPath || !fs.existsSync(logPath)) return '';
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      return content.split('\n').slice(-lines).join('\n');
    } catch { return ''; }
  }

  private async handleRunCompletion(taskId: string, rt: RunningTask): Promise<void> {
    this.running.delete(taskId);
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    try {
      this.locks.invalidate(rt.profileName);
      const completedProfile = this.profileRepo.get(rt.profileName);
      if (completedProfile && this.usageService) {
        try {
          await this.usageService.collect(completedProfile);
        } catch {
          // ignore
        }
      }

      if (this.stopped) return;
      const task = this.taskRepo.get(taskId);
      if (!task) return;

      if (task.worktreePath) {
        await reap(task.worktreePath, { worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
      }

    // Read log tail for quota detection
    const run = this.runRepo.get(rt.runId);
    let logTail = '';
    let fullLog = '';
    if (run?.logPath && fs.existsSync(run.logPath)) {
      try {
        fullLog = fs.readFileSync(run.logPath, 'utf-8');
        const fd = fs.openSync(run.logPath, 'r');
        const stat = fs.fstatSync(fd);
        const size = Math.min(stat.size, 16 * 1024);
        const buffer = Buffer.alloc(size);
        fs.readSync(fd, buffer, 0, size, stat.size - size);
        fs.closeSync(fd);
        logTail = buffer.toString('utf-8');
      } catch {
        // ignore
      }
    }

    // Check worktree markers
    let markers = { done: false, blocked: false, doneContent: '', blockedContent: '' };
    if (task.worktreePath) {
      markers = this.worktreeService.checkMarkers(task.worktreePath) as typeof markers;
    }

    // Measure diff stats if moving to review
    let diffStats = { linesAdded: 0, linesDeleted: 0, filesChanged: 0 };
    if (markers.done) {
      const project = this.projectRepo.get(task.projectId);
      const baseRef = task.baseRef || project?.defaultBranch || 'main';
      const branch = task.branch || `agenthub/${task.slug}`;
      if (project?.path) {
        const stats = await measureTaskLines(project.path, baseRef, branch);
        if (stats) diffStats = stats;
      }
      if (diffStats.filesChanged === 0 && task.worktreePath && fs.existsSync(task.worktreePath)) {
        try {
          const { stdout } = await execFileAsync('git', ['diff', '--shortstat', `${baseRef}...${branch}`], {
            cwd: task.worktreePath,
            timeout: 10_000,
          });
          const parsed = parseShortstat(stdout);
          if (parsed.filesChanged > 0) diffStats = parsed;
        } catch {
          // ignore
        }
      }
    }

    // Get usageAfter
    let usageAfter: number | null = null;
    if (rt.engine.id === 'agy' && this.usageService) {
      const family = getModelFamily(rt.model);
      const grp = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
      if (grp) {
        const usages = this.usageService.getForProfile(rt.profileName);
        const u5h = usages.find((u) => u.window === '5h' && u.grp === grp);
        if (u5h) usageAfter = u5h.remainingPct;
      }
    }

    // Tokens used for codex
    let tokensUsed: number | null = null;
    if (rt.engine.id === 'codex') {
      tokensUsed = parseCodexTokens(fullLog);
    }

    const durationMs = Date.now() - rt.startTime;
    if (this.runMetricsRepo) {
      this.runMetricsRepo.upsert({
        runId: rt.runId,
        taskId,
        engine: rt.engine.id,
        model: rt.model,
        profileName: rt.profileName,
        tokensUsed,
        usageBefore: rt.usageBefore,
        usageAfter,
        linesAdded: diffStats.linesAdded,
        linesDeleted: diffStats.linesDeleted,
        filesChanged: diffStats.filesChanged,
        durationMs,
      });
    }

    if (markers.done) {
      this.runRepo.finish(rt.runId, 'done');
      await this.runChecksForTask(taskId, rt.runId);
    } else if (markers.blocked) {
      this.runRepo.finish(rt.runId, 'blocked');
      this.taskRepo.update(taskId, { status: 'blocked', transientRetries: 0, notBefore: null });
      this.eventBus.emit('task.blocked', taskId);
    } else {
      const exitCode = rt.exitCode ?? rt.child?.exitCode ?? null;
      const isLockBusy = durationMs < 3000 && fullLog.trim() === '' && Boolean(rt.lockFile) && exitCode === 1;

      if (isLockBusy) {
        this.runRepo.finish(rt.runId, 'crashed', undefined, 'lock_busy');
        this.taskRepo.update(taskId, {
          status: 'queued',
          notBefore: Math.floor(Date.now() / 1000) + 5,
        });
        this.eventBus.emit('task.queued', taskId, { reason: 'lock_busy' });
      } else {
        // Check for quota exhaustion
        const quotaResult = rt.engine.detectQuota(logTail);
        if (quotaResult.exhausted) {
          const family = getModelFamily(rt.model);
          const resetSeconds = quotaResult.resetSeconds || 18000;
          this.runRepo.finish(rt.runId, 'quota', Math.floor(Date.now() / 1000) + resetSeconds);

          // Mark quota for profile and same-email profiles
          this.quotaService.mark(rt.profileName, family, resetSeconds, `quota exhausted on ${rt.model}`);
          this.eventBus.emit('quota.exhausted', taskId, { profile: rt.profileName, family });

          // Try to find another profile/model
          const attempt = (task.attempt || 0) + 1;
          this.taskRepo.update(taskId, { status: 'queued', attempt, resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, { reason: 'quota_retry' });
        } else if (rt.engine.detectAuthError(logTail).expired) {
          this.runRepo.finish(rt.runId, 'crashed', undefined, 'auth');
          this.markProfileAuthExpired(rt.profileName);

          const attempt = (task.attempt || 0) + 1;
          this.taskRepo.update(taskId, { status: 'queued', attempt, resume: 1, transientRetries: 0, notBefore: null });
          this.eventBus.emit('task.queued', taskId, { reason: 'auth_retry', profile: rt.profileName });
        } else {
          // Check for transient errors
          if (rt.engine.detectTransientError(logTail) && task.transientRetries < 3) {
            const delays = [60000, 120000, 180000];
            const delay = delays[task.transientRetries] || 180000;
            this.runRepo.finish(rt.runId, 'crashed');
            this.taskRepo.update(taskId, {
              status: 'queued',
              notBefore: Math.floor(Date.now() / 1000) + Math.ceil(delay / 1000),
              transientRetries: task.transientRetries + 1,
            });
            this.eventBus.emit('task.queued', taskId, { reason: 'transient_retry', delay });
          } else {
            // Failed
            this.runRepo.finish(rt.runId, 'crashed');
            this.taskRepo.updateStatus(taskId, 'failed');
            this.eventBus.emit('task.failed', taskId);
          }
        }
      }
    }
    if (!this.stopped) this.triggerTick();
    } catch {
      // safely ignore if DB closed during teardown
    }
  }

  private scheduleNewTasks(): void {
    if (this.paused) {
      return;
    }
    if (this.skipSchedulingOnce) {
      this.skipSchedulingOnce = false;
      return;
    }
    const queuedTasks = this.taskRepo.getByStatus('queued');

    for (const task of queuedTasks) {
      if (task.notBefore != null && task.notBefore > Math.floor(Date.now() / 1000)) continue;
      // Check dependencies
      if (!this.areDependenciesMet(task)) continue;

      // Check project parallel limit
      const project = this.projectRepo.get(task.projectId);
      if (!project) continue;

      const runningInProject = Array.from(this.running.values()).filter((r) => r.projectId === task.projectId).length;
      const startingInProject = Array.from(this.starting.values()).filter((r) => r.projectId === task.projectId).length;

      if (runningInProject + startingInProject >= this.effectiveParallel(project)) {
        this.markQueuedWaiting(task, 'parallel');
        continue;
      }

      // Find a suitable (model, profile) pair
      const pair = this.findModelProfilePair(task);
      if (pair) {
        const disk = this.getBlockingDisk();
        if (disk) {
          this.tasksWaitingForDisk.add(task.id);
          this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
          this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
          this.markDiskLow(disk);
          continue;
        }
        void this.startTask(task, pair.model, pair.profileName)
          .catch((error) => {
            console.error(`[scheduler] failed to start task ${task.id}:`, error);
          })
          .finally(() => {
            // A failed start can happen before the run is inserted or after an
            // unexpected exception. Never leave a stale capacity reservation.
            if (!this.running.has(task.id)) this.starting.delete(task.id);
          });
      } else if (this.hasBusyMatchingProfile(task)) {
        this.markQueuedWaiting(task, 'profile_busy');
        continue;
      } else if (this.allMatchingProfilesNeedLogin(task)) {
        this.taskRepo.updateStatus(task.id, 'failed');
        this.eventBus.emit('task.failed', task.id, { reason: 'auth_expired', message: 'Tất cả hồ sơ phù hợp đều cần đăng nhập lại' });
      } else {
        // Every matching profile is quota-exhausted, or no matching profile exists.
        this.taskRepo.updateStatus(task.id, 'waiting_quota', 'quota');
        this.eventBus.emit('task.waiting_quota', task.id, { reason: 'quota' });
      }
    }
  }

  private scheduleReviews(): void {
    const state = this.failoverState;
    if (!state || !this.reviewRepo || this.config.reviewer?.enabled === false) return;
    const snapshot = state.snapshot();
    if (this.failoverWasActive && !snapshot.active) {
      this.eventBus.emit('claude.failover_cleared', undefined);
    }
    this.failoverWasActive = snapshot.active;
    if (!snapshot.active) return;

    const codex = this.engines.get('codex');
    if (!codex) return;
    for (const task of this.taskRepo.getByStatus('review')) {
      if (this.reviewerRuns.has(task.id)) continue;
      if (task.reviewerEscalated) continue;
      if (this.getCheckResults(task.id).length === 0) {
        this.escalateReview(task.id, 'missing_autocheck_results', 'Không có kết quả autocheck đã lưu; cần người xác minh trước khi tiếp tục.');
        continue;
      }
      const profile = this.profileRepo.getEnabled().find((p) => p.engine === 'codex' &&
        !this.quotaService.isExhausted(p.name, 'codex') &&
        !this.reviewerRunsForProfile(p.name) && this.locks.findFreeSlotSync(p) !== null);
      if (!profile || !task.worktreePath) continue;
      this.startReview(task, profile.name, codex);
    }
  }

  private reviewerRunsForProfile(profileName: string): boolean {
    return [...this.reviewerRuns.values()].some((run) => run.profileName === profileName);
  }

  private startReview(task: TaskRow, profileName: string, engine: Engine): void {
    const profile = this.profileRepo.get(profileName);
    if (!profile || !task.worktreePath || this.reviewerRuns.has(task.id)) return;
    const lockSlot = this.locks.findFreeSlotSync(profile);
    if (lockSlot === null) return;
    const lockFile = this.locks.lockPath(profile, lockSlot);
    this.locks.reserve(profile.name, lockFile);
    const runId = crypto.randomUUID();
    const logDir = path.join(this.config.logsDir, task.id.replace('/', '_'));
    const logPath = path.join(logDir, `${runId}.log`);
    const outputPath = path.join(logDir, `${runId}.final.json`);
    const reviewerModel = this.config.reviewer?.model || 'codex:gpt-5.6-luna';
    this.runRepo.insert({ id: runId, taskId: task.id, engine: 'codex', model: reviewerModel, profileName, logPath, kind: 'reviewer' });
    let child;
    try {
      const checks = this.getCheckResults(task.id).map((check) => ({
        name: check.name,
        ok: check.ok,
        outputTail: check.outputTail,
        runId: check.runId || 'unknown',
        runStartedAt: check.runStartedAt || 'unknown',
      }));
      child = engine.spawn({ profile, model: reviewerModel, cwd: task.worktreePath, prompt: buildReviewerPrompt(task.body || task.title, task.worktreePath, checks), logPath, outputPath, readOnly: true, lockFile });
      if (!child.pid) throw new Error('reviewer process has no pid');
      this.runRepo.updatePid(runId, child.pid, this.getProcessStartTime(child.pid));
    } catch (error) {
      this.locks.release(profile.name, lockFile);
      this.runRepo.finish(runId, 'crashed', undefined, String(error));
      this.eventBus.emit('review.failed', task.id, { actor: 'codex-reviewer', reason: 'spawn_failed' });
      return;
    }
    const timeout = setTimeout(() => {
      if (!this.reviewerRuns.has(task.id)) return;
      this.killProcessGroup(child.pid!);
      this.finishReview(task.id, runId, profileName, 'timeout');
    }, (this.config.reviewer?.timeoutSec || 900) * 1000);
    this.reviewerRuns.set(task.id, { taskId: task.id, runId, pid: child.pid, profileName, engine, outputPath, lockSlot, lockFile, startedAt: Date.now(), timeout });
    this.locks.invalidate(profileName);
    child.unref();
    this.eventBus.emit('review.started', task.id, { actor: 'codex-reviewer', model: reviewerModel, profile: profileName, runId });
    child.once('error', () => {
      if (!this.stopped) this.finishReview(task.id, runId, profileName, 'error', null);
    });
    child.once('exit', (code) => {
      if (this.stopped) return;
      const run = this.reviewerRuns.get(task.id);
      const exitTimeout = setTimeout(() => this.finishReview(task.id, runId, profileName, 'exit', code), 10);
      if (run) run.exitTimeout = exitTimeout;
    });
  }

  private finishReview(taskId: string, runId: string, profileName: string, reason: 'exit' | 'timeout' | 'error', exitCode: number | null = 0): void {
    if (this.stopped) return;
    const active = this.reviewerRuns.get(taskId);
    if (!active || active.runId !== runId) return;
    clearTimeout(active.timeout);
    if (active.exitTimeout) clearTimeout(active.exitTimeout);
    this.reviewerRuns.delete(taskId);
    if (active.lockFile) {
      this.locks.release(profileName, active.lockFile);
    }
    this.locks.invalidate(profileName);
    const run = this.runRepo.get(runId);
    let output = '';
    let logOutput = '';
    if (run?.logPath) {
      try { logOutput = fs.readFileSync(run.logPath, 'utf8'); } catch { logOutput = ''; }
    }
    try { output = fs.readFileSync(active.outputPath, 'utf8'); } catch { output = ''; }
    const quota = active.engine.detectQuota(logOutput).exhausted;
    const duration = Date.now() - active.startedAt;
    const isLockBusy = duration < 3000 && logOutput.trim() === '' && Boolean(active.lockFile) && exitCode === 1;
    if (isLockBusy) {
      this.runRepo.finish(runId, 'crashed', undefined, 'lock_busy');
      this.eventBus.emit('review.waiting', taskId, { actor: 'codex-reviewer', reason: 'lock_busy' });
      return;
    }
    if (reason === 'timeout' || reason === 'error' || exitCode !== 0 || quota) {
      this.runRepo.finish(runId, quota ? 'quota' : reason === 'timeout' ? 'timeout' : 'crashed');
      if (quota) this.quotaService.mark(profileName, 'codex', this.config.reviewer?.failoverSec || 5 * 60 * 60, 'codex reviewer quota');
      this.eventBus.emit('review.waiting', taskId, { actor: 'codex-reviewer', reason: quota ? 'quota' : reason === 'timeout' ? 'timeout' : 'crash' });
      return;
    }
    const task = this.taskRepo.get(taskId);
    const checks = this.getCheckResults(taskId);
    if (checks.length === 0) {
      this.runRepo.finish(runId, 'done', undefined, 'reviewer had no persisted autocheck results');
      this.escalateReview(taskId, 'missing_autocheck_results', 'Không có kết quả autocheck đã lưu; cần người xác minh trước khi tiếp tục.');
      return;
    }
    const result = parseReviewerOutput(output);
    if (!result) {
      this.runRepo.finish(runId, 'crashed', undefined, 'malformed reviewer output');
      this.eventBus.emit('review.failed', taskId, { actor: 'codex-reviewer', reason: 'malformed_output' });
      return;
    }
    if (this.isReadOnlyEnvironmentFeedback(result.verdict, result.feedback)) {
      this.runRepo.finish(runId, 'done', undefined, 'reviewer read-only environment error');
      this.escalateReview(taskId, 'reviewer_environment', result.feedback);
      return;
    }
    if (result.verdict === 'approved' && task?.worktreePath) {
      try {
        const status = execFileSync('git', ['-C', task.worktreePath, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
        if (status) {
          this.runRepo.finish(runId, 'crashed', undefined, 'uncommitted changes');
          this.eventBus.emit('review.failed', taskId, { actor: 'codex-reviewer', reason: 'uncommitted_changes' });
          return;
        }
      } catch {
        this.runRepo.finish(runId, 'crashed', undefined, 'unable to read git status');
        this.eventBus.emit('review.failed', taskId, { actor: 'codex-reviewer', reason: 'git_unreadable' });
        return;
      }
    }
    this.runRepo.finish(runId, 'done');
    this.reviewTask(taskId, result.verdict, result.feedback, 'codex-reviewer');
    this.eventBus.emit('review.completed', taskId, { actor: 'codex-reviewer', verdict: result.verdict, model: this.config.reviewer?.model || 'codex:gpt-5.6-luna', runId });
    if (!this.stopped) this.triggerTick();
  }

  private isReadOnlyEnvironmentFeedback(verdict: ReviewerVerdict, feedback: string): boolean {
    if (verdict !== 'changes_requested') return false;
    const environmentError = /(?:EROFS|read[- ]only filesystem|filesystem is read-only|permission denied|EACCES)/i;
    if (!environmentError.test(feedback)) return false;
    const remaining = feedback
      .split(/(?:\r?\n|(?<=[.!?。！？])\s+)/)
      .filter((sentence) => !environmentError.test(sentence))
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return remaining.length <= 80;
  }

  private escalateReview(taskId: string, reason: string, feedback: string): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.reviewerEscalated) return;
    this.taskRepo.update(taskId, {
      status: 'review',
      reviewerEscalated: 1,
      reviewerEscalatedAt: new Date().toISOString(),
      reviewerEscalationReason: reason,
    });
    this.eventBus.emit('review.escalated', taskId, { actor: 'codex-reviewer', reason, feedback, title: task.title });
  }

  private areDependenciesMet(task: TaskRow): boolean {
    const deps: string[] = JSON.parse(task.dependsOn);
    for (const depId of deps) {
      const dep = this.taskRepo.get(depId);
      if (!dep || dep.status !== 'done') return false;
    }
    return true;
  }

  private getEmailRunningCount(profile: ProfileRow): number {
    const targetEmail = profile.email;
    const sameEmailProfileNames = new Set<string>();
    sameEmailProfileNames.add(profile.name);

    if (targetEmail) {
      for (const p of this.profileRepo.getAll()) {
        if (p.email === targetEmail) {
          sameEmailProfileNames.add(p.name);
        }
      }
    }

    const seenRunIds = new Set<string>();
    let count = 0;

    for (const rt of this.running.values()) {
      seenRunIds.add(rt.runId);
      if (sameEmailProfileNames.has(rt.profileName)) {
        count++;
      }
    }

    for (const starting of this.starting.values()) {
      if (sameEmailProfileNames.has(starting.profileName)) {
        count++;
      }
    }

    for (const rr of this.reviewerRuns.values()) {
      seenRunIds.add(rr.runId);
      if (sameEmailProfileNames.has(rr.profileName)) {
        count++;
      }
    }

    for (const run of this.runRepo.getRunning()) {
      if (!seenRunIds.has(run.id)) {
        seenRunIds.add(run.id);
        if (sameEmailProfileNames.has(run.profileName)) {
          count++;
        }
      }
    }

    return count;
  }

  private getQuotaRemainingPct(profile: ProfileRow, family: string): number {
    if (this.usageService) {
      const remaining = this.usageService.bestRemaining(profile, family);
      if (remaining !== null && remaining !== undefined) {
        return remaining;
      }
    }
    if (this.db) {
      if (profile.engine === 'agy') {
        const group = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
        if (group) {
          const names = profile.email
            ? this.profileRepo.getAll().filter((p) => p.email === profile.email).map((p) => p.name)
            : [profile.name];
          if (names.length > 0) {
            const placeholders = names.map(() => '?').join(',');
            try {
              const row = this.db.prepare(
                `SELECT MAX(remainingPct) as best FROM quota_usage WHERE profileName IN (${placeholders}) AND grp = ? AND window = '5h'`
              ).get(...names, group) as { best: number | null } | undefined;
              if (row?.best != null) {
                return row.best;
              }
            } catch {
              // ignore
            }
          }
        }
      }
    }
    return 50;
  }

  /** Task chờ slot/tài khoản vẫn ở `queued`; chỉ ghi DB và phát sự kiện khi lý do chờ đổi. */
  private markQueuedWaiting(task: TaskRow, reason: 'parallel' | 'profile_busy'): void {
    if (task.status === 'queued' && task.waitReason === reason) return;
    this.taskRepo.update(task.id, { status: 'queued', waitReason: reason });
    this.eventBus.emit('task.queued', task.id, { reason });
  }

  private findModelProfilePair(
    task: TaskRow,
  ): { model: string; profileName: string } | null {
    const chain = this.getModelChain(task);

    for (const model of chain) {
      const family = getModelFamily(model);
      const engineId = getModelEngine(model);

      // Find suitable profiles
      const profiles = this.profileRepo.getEnabled().filter((p) => !p.authState || p.authState === 'ok');
      const eligibleProfiles = profiles.filter((profile) => {
        if (profile.engine !== engineId) return false;
        if (this.quotaService.isExhausted(profile.name, family)) return false;
        if (this.isProfileBusy(profile.name)) return false;
        if (this.locks.getSlotsSync(profile).busy) return false;
        return true;
      });

      if (eligibleProfiles.length === 0) continue;

      const ranked = eligibleProfiles.map((profile, originalIndex) => ({
        profile,
        originalIndex,
        emailRuns: this.getEmailRunningCount(profile),
        quotaRemaining: this.getQuotaRemainingPct(profile, family),
      }));

      ranked.sort((a, b) => {
        if (a.emailRuns !== b.emailRuns) {
          return a.emailRuns - b.emailRuns;
        }
        if (a.quotaRemaining !== b.quotaRemaining) {
          return b.quotaRemaining - a.quotaRemaining;
        }
        return a.originalIndex - b.originalIndex;
      });

      return { model, profileName: ranked[0].profile.name };
    }

    return null;
  }

  private hasBusyMatchingProfile(task: TaskRow): boolean {
    for (const model of this.getModelChain(task)) {
      const engineId = getModelEngine(model);
      const family = getModelFamily(model);
      for (const profile of this.profileRepo.getEnabled()) {
        if (profile.authState && profile.authState !== 'ok') continue;
        if (
          profile.engine === engineId &&
          !this.quotaService.isExhausted(profile.name, family) &&
          (this.isProfileBusy(profile.name) || this.locks.getSlotsSync(profile).busy)
        ) {
          return true;
        }
      }
    }
    return false;
  }

  private allMatchingProfilesNeedLogin(task: TaskRow): boolean {
    let matching = 0;
    let unavailable = 0;
    for (const model of this.getModelChain(task)) {
      const engineId = getModelEngine(model);
      for (const profile of this.profileRepo.getEnabled()) {
        if (profile.engine !== engineId) continue;
        matching += 1;
        if (profile.authState != null && profile.authState !== 'ok') unavailable += 1;
      }
    }
    return matching > 0 && matching === unavailable;
  }

  private markProfileAuthExpired(profileName: string): void {
    const profile = this.profileRepo.get(profileName);
    if (!profile) return;
    const related = profile.email
      ? this.profileRepo.getAll().filter((candidate) => candidate.email === profile.email)
      : [profile];
    for (const candidate of related) {
      this.profileRepo.updateAuthState(candidate.name, 'not_logged_in', 'Phiên đăng nhập hết hạn (401) – cần đăng nhập lại', null);
      this.eventBus.emit('profile.auth_expired', undefined, { name: candidate.name, email: candidate.email });
    }
  }

  private getModelChain(task: TaskRow): string[] {
    if (task.modelChain) {
      return JSON.parse(task.modelChain) as string[];
    }
    return task.level === 'hard'
      ? this.config.defaultModelChains.hard
      : this.config.defaultModelChains.easy;
  }

  private isProfileBusy(profileName: string): boolean {
    const profile = this.profileRepo.get(profileName);
    if (!profile) return true;
    const running = Array.from(this.running.values()).filter((r) => r.profileName === profileName).length;
    const starting = Array.from(this.starting.values()).filter((task) => task.profileName === profileName).length;
    return running + starting >= this.locks.slotsTotal(profile) || this.locks.getSlotsSync(profile).busy;
  }

  async startTask(task: TaskRow, model: string, profileName: string, retryCount = 0): Promise<void> {
    const disk = this.getBlockingDisk();
    if (disk) {
      this.tasksWaitingForDisk.add(task.id);
      this.taskRepo.updateStatus(task.id, 'waiting_quota', 'disk');
      this.eventBus.emit('task.waiting_quota', task.id, { reason: 'disk', label: disk.label, freeGB: disk.freeGB, minFreeGB: disk.minFreeGB, message: this.diskWaitMessage(disk) });
      this.markDiskLow(disk);
      return;
    }

    const profile = this.profileRepo.get(profileName);
    if (!profile) return;
    const lockSlot = this.locks.findFreeSlotSync(profile);
    if (lockSlot == null) return;
    const lockFile = this.locks.lockPath(profile, lockSlot);
    this.locks.reserve(profile.name, lockFile);

    const project = this.projectRepo.get(task.projectId);
    if (!project) {
      this.locks.release(profile.name, lockFile);
      return;
    }

    const engineId = getModelEngine(model);
    const engine = this.engines.get(engineId);
    if (!engine) {
      this.locks.release(profile.name, lockFile);
      return;
    }

    this.starting.set(task.id, { projectId: task.projectId, profileName });

    // Create worktree if needed
    let worktreePath = task.worktreePath;
    if (!worktreePath) {
      let slot: number;
      try {
        slot = this.worktreeService.allocateSlot(task.projectId, this.taskRepo.getUsedSlots(task.projectId));
      } catch {
        // All slots are occupied; leave the task queued for a later tick.
        this.locks.release(profile.name, lockFile);
        return;
      }
      const branch = task.branch || `agenthub/${task.slug}`;
      const baseRef = this.resolveBaseRef(task, project);
      try {
        worktreePath = this.worktreeService.create({
          projectPath: project.path,
          projectId: project.id,
          slug: task.slug,
          branch,
          baseRef,
        });
      } catch (e) {
        this.locks.release(profile.name, lockFile);
        this.taskRepo.updateStatus(task.id, 'failed');
        this.eventBus.emit('task.failed', task.id, { error: String(e) });
        return;
      }

      this.taskRepo.update(task.id, {
        worktreePath,
        branch,
        slot,
        status: 'running',
      });
      task.slot = slot;

      // Dependency installation can take minutes. Keep the task out of the
      // queue while it runs, but never let a cache/native-module failure stop
      // the worker from starting with its own install.
      const hasDependencyLock = (dir: string): boolean =>
        fs.existsSync(path.join(dir, 'package-lock.json')) || fs.existsSync(path.join(dir, 'pnpm-lock.yaml'));
      if (hasDependencyLock(worktreePath) || hasDependencyLock(path.join(worktreePath, 'web'))) {
        try {
          await ensureWorktreeNodeModules(worktreePath, project.path, this.config.cacheDir);
        } catch (error) {
          this.locks.release(profile.name, lockFile);
          this.taskRepo.update(task.id, { status: 'failed' });
          this.eventBus.emit('task.failed', task.id, {
            error: `Failed to prepare node_modules before worker start: ${String(error)}`,
          });
          return;
        }
      }

      // Generate env file if needed
      if (project.envTemplate) {
        try {
          const tmpl = JSON.parse(project.envTemplate);
          this.worktreeService.generateEnvFile(worktreePath, tmpl, slot, task.slug);
        } catch (e) {
          this.locks.release(profile.name, lockFile);
          this.taskRepo.update(task.id, { status: 'failed' });
          this.eventBus.emit('task.failed', task.id, { error: String(e) });
          return;
        }
      }

    }

    if (task.slot == null) {
      try {
        const slot = this.worktreeService.allocateSlot(task.projectId, this.taskRepo.getUsedSlots(task.projectId));
        this.taskRepo.update(task.id, { slot });
      } catch {
        this.locks.release(profile.name, lockFile);
        return;
      }
    }

    // Write task.md
    let prompt = PROTOCOL_PROMPT;
    if (task.resume) {
      prompt += '\n\nTask đã làm dở – kiểm tra git log/status rồi làm tiếp, không làm lại.';
    }

    this.worktreeService.writeTaskFile(worktreePath, task.body || task.title, !!task.resume);

    // Create run record
    const runId = crypto.randomUUID();
    const logDir = path.join(this.config.logsDir, task.id.replace('/', '_'));
    const logPath = path.join(logDir, `${runId}.log`);

    let usageBefore: number | null = null;
    if (engineId === 'agy' && this.usageService) {
      const family = getModelFamily(model);
      const grp = family === 'gemini' ? 'Gemini Models' : (family === 'claude' || family === 'gpt' ? 'Claude and GPT models' : null);
      if (grp) {
        const usages = this.usageService.getForProfile(profileName);
        const u5h = usages.find((u) => u.window === '5h' && u.grp === grp);
        if (u5h) usageBefore = u5h.remainingPct;
      }
    }

    this.runRepo.insert({
      id: runId,
      taskId: task.id,
      engine: engineId,
      model,
      profileName,
      logPath,
    });

    // Spawn the engine
    try {
      const child = engine.spawn({
        profile,
        model,
        cwd: worktreePath,
        prompt,
        logPath,
        lockFile,
      });

      const pid = child.pid!;
      const pidStart = this.getProcessStartTime(pid);
      this.runRepo.updatePid(runId, pid, pidStart);

      // Update task status
      this.taskRepo.update(task.id, { status: 'running' });

      // Track the running task
      const rt: RunningTask = {
        runId,
        taskId: task.id,
        pid,
        pidStart,
        profileName,
        model,
        engine,
        child,
        exitCode: child.exitCode ?? null,
        lockFile,
        lockSlot,
        startTime: Date.now(),
        timeoutMs: this.config.defaultTimeout * 1000,
        timeoutAt: Date.now() + this.config.defaultTimeout * 1000,
        retryCount,
        projectId: task.projectId,
        lastOutputAt: Date.now(),
        lastActivityAt: Date.now(),
        activitySource: 'log',
        activityCheckedAt: 0,
        cachedConversationMtime: 0,
        cachedWorktreeMtime: 0,
        usageBefore,
        lastCommitCheckAt: Date.now(),
        lastCommitCount: 0,
        lastNoCommitThresholdEmitted: 0,
        commandOccurrences: [],
        lastLogOffset: 0,
      };
      this.running.set(task.id, rt);
      this.starting.delete(task.id);
      this.locks.invalidate(profileName);

      // Unref so the child doesn't prevent daemon from exiting
      child.unref();

      this.eventBus.emit('task.running', task.id, { runId, model, profile: profileName });

      // Listen for exit
      child.on('exit', (code) => {
        rt.exitCode = code;
        if (this.stopped) return;
        // Trigger immediate check
        setTimeout(() => {
          if (!this.stopped) void this.checkRunningTasks().catch(() => {});
        }, 500);
      });
    } catch (e) {
      this.locks.release(profile.name, lockFile);
      this.runRepo.finish(runId, 'crashed');
      this.taskRepo.updateStatus(task.id, 'failed');
      this.eventBus.emit('task.failed', task.id, { error: String(e) });
    }
  }

  private resolveBaseRef(task: TaskRow, project: { defaultBranch: string }): string {
    if (task.baseRef) return task.baseRef;

    // If task has dependencies, use the last dependency's branch
    const deps: string[] = JSON.parse(task.dependsOn);
    if (deps.length > 0) {
      const lastDep = this.taskRepo.get(deps[deps.length - 1]);
      if (lastDep?.branch) return lastDep.branch;
    }

    return project.defaultBranch;
  }

  /**
   * Cancel a running task
   */
  cancelTask(taskId: string): void {
    const rt = this.running.get(taskId);
    if (rt) {
      this.killTask(taskId, 'cancelled');
    } else {
      this.taskRepo.updateStatus(taskId, 'cancelled');
      this.eventBus.emit('task.cancelled', taskId);
    }
  }

  /**
   * Review a task
   */
  reviewTask(taskId: string, verdict: 'approved' | 'changes_requested', feedback?: string, by?: string): void {
    const task = this.taskRepo.get(taskId);
    if (!task || task.status !== 'review') return;

    if (verdict === 'approved') {
      if (by === 'codex-reviewer' && (!feedback || feedback.trim() === '')) return;
      if (by === 'codex-reviewer' && this.reviewRepo) this.reviewRepo.insert({ id: crypto.randomUUID(), taskId, verdict, feedback: feedback || null, actor: by });
      if (by !== 'codex-reviewer') this.resetReviewerEscalation(taskId);
      this.taskRepo.updateStatus(taskId, 'done');
      if (this.runMetricsRepo) {
        recalculateTaskLines(
          this.taskRepo,
          this.projectRepo,
          this.runRepo,
          this.runMetricsRepo,
          taskId,
        ).catch(() => {});
      }
      this.eventBus.emit('task.done', taskId, by ? { by, verdict } : undefined);
    } else {
      if (!feedback || feedback.trim() === '') {
        throw new Error('Feedback is required when requesting changes');
      }
      if (by === 'codex-reviewer' && this.reviewRepo) this.reviewRepo.insert({ id: crypto.randomUUID(), taskId, verdict, feedback, actor: by });
      if (by === 'codex-reviewer') {
        const count = (task.reviewerChangesRequested || 0) + 1;
        const max = this.config.reviewer?.maxChangesRequested || 2;
        if (count > max) {
          this.escalateReview(taskId, 'reviewer_changes_limit', feedback);
          return;
        }
        this.taskRepo.update(taskId, { reviewerChangesRequested: count });
      } else {
        this.resetReviewerEscalation(taskId);
      }
      // Append feedback to task body
      if (task.worktreePath) {
        const newBody = (task.body || '') + '\n\n## Feedback review\n\n' + feedback;
        this.taskRepo.update(taskId, {
          body: newBody,
          status: 'queued',
          resume: 1,
        });

        // Remove markers
        const agentHubDir = path.join(task.worktreePath, '.agenthub');
        const donePath = path.join(agentHubDir, 'DONE');
        const blockedPath = path.join(agentHubDir, 'BLOCKED');
        if (fs.existsSync(donePath)) fs.unlinkSync(donePath);
        if (fs.existsSync(blockedPath)) fs.unlinkSync(blockedPath);

        // Re-write task.md with feedback
        this.worktreeService.writeTaskFile(task.worktreePath, newBody, true, feedback);
      } else {
        this.taskRepo.update(taskId, { status: 'queued', resume: 1 });
      }
      this.eventBus.emit(
        'task.queued',
        taskId,
        by ? { reason: 'changes_requested', by, verdict } : { reason: 'changes_requested' },
      );
    }
  }

  private resetReviewerEscalation(taskId: string): void {
    this.taskRepo.update(taskId, {
      reviewerChangesRequested: 0,
      reviewerEscalated: 0,
      reviewerEscalatedAt: null,
      reviewerEscalationReason: null,
    });
  }

  private killTask(taskId: string, outcome: string): void {
    const rt = this.running.get(taskId);
    if (!rt) return;

    this.killProcessGroup(rt.pid);
    const task = this.taskRepo.get(taskId);
    if (task?.worktreePath) {
      reapSyncForWorktree(task.worktreePath, { worktreesDir: this.config.worktreesDir, protectedPaths: [this.config.hubHome] });
    }

    this.running.delete(taskId);
    if (rt.lockFile) this.locks.release(rt.profileName, rt.lockFile);
    this.locks.invalidate(rt.profileName);
    this.runRepo.finish(rt.runId, outcome);

    const durationMs = Date.now() - rt.startTime;
    if (this.runMetricsRepo) {
      this.runMetricsRepo.upsert({
        runId: rt.runId,
        taskId,
        engine: rt.engine.id,
        model: rt.model,
        profileName: rt.profileName,
        tokensUsed: null,
        usageBefore: rt.usageBefore,
        usageAfter: null,
        linesAdded: 0,
        linesDeleted: 0,
        filesChanged: 0,
        durationMs,
      });
    }

    if (outcome === 'cancelled') {
      this.taskRepo.updateStatus(taskId, 'cancelled');
      this.eventBus.emit('task.cancelled', taskId);
    } else if (outcome === 'timeout') {
      this.taskRepo.updateStatus(taskId, 'failed');
      this.eventBus.emit('task.timeout', taskId);
    }
    if (!this.stopped) this.triggerTick();
  }

  private killProcessGroup(pid: number): void {
    try {
      process.kill(-pid, 'SIGKILL');
    } catch {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already dead */ }
    }
  }

  private getProcessStartTime(pid: number): number | null {
    try {
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const afterComm = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      return Number(afterComm[19]) || null;
    } catch {
      return null;
    }
  }

  private isProcessAlive(pid: number | null, expectedStart?: number | null): boolean {
    if (!pid) return false;
    try {
      process.kill(pid, 0);
      if (expectedStart != null) {
        return this.getProcessStartTime(pid) === expectedStart;
      }
      return true;
    } catch {
      return false;
    }
  }

  private getMonitoredDisks(): MonitoredDisk[] {
    return getMonitoredDisks(this.config.worktreesDir, this.config.disk.minFreeGB, this.config.disk.extraPaths, process.env.NODE_ENV !== 'test');
  }

  private getBlockingDisk(): MonitoredDisk | undefined {
    return this.getMonitoredDisks().find((disk) => disk.low);
  }

  private diskWaitMessage(disk: MonitoredDisk): string {
    return `Chờ ${disk.label} (còn ${disk.freeGB} GB / cần ${disk.minFreeGB} GB)`;
  }

  private markDiskLow(disk: MonitoredDisk): void {
    if (this.diskLow) return;
    this.diskLow = true;
    this.eventBus.emit('disk.low', undefined, {
      label: disk.label,
      freeGB: disk.freeGB,
      minFreeGB: disk.minFreeGB,
    });
  }

  private markDockerDiskLow(disk: MonitoredDisk): void {
    if (this.dockerDiskLow) return;
    this.dockerDiskLow = true;
    this.eventBus.emit('disk.docker_low', undefined, {
      label: disk.label,
      path: disk.path,
      freeGB: disk.freeGB,
      totalGB: disk.totalGB,
      minFreeGB: disk.minFreeGB,
    });
    const warning = 'KHÔNG chạy docker build/pull/compose up – ổ Docker sắp đầy';
    for (const running of this.running.values()) {
      const task = this.taskRepo.get(running.taskId);
      if (!task?.worktreePath) continue;
      const taskFile = path.join(task.worktreePath, '.agenthub', 'task.md');
      try {
        const current = fs.readFileSync(taskFile, 'utf8');
        if (!current.includes(warning)) fs.appendFileSync(taskFile, `\n\n⚠️ ${warning}\n`);
      } catch {
        // The task can finish while the warning is being written.
      }
    }
  }

  private onTaskDoneOrCancelled(taskId: string): void {
    if (!this.config.cleanup?.nodeModulesOnDone) return;
    const task = this.taskRepo.get(taskId);
    if (!task || !task.worktreePath) return;
    this.worktreeService.cleanNodeModules(task.worktreePath);
  }

  private cleanExpiredWorktrees(): void {
    const afterHours = this.config.cleanup?.worktreeOnDoneAfterHours ?? 24;
    if (afterHours <= 0) return;

    const thresholdMs = afterHours * 60 * 60 * 1000;
    const now = Date.now();

    const doneTasks = this.taskRepo.getByStatus('done');
    for (const task of doneTasks) {
      // STRICT SAFETY: Never delete worktree of non-done tasks
      if (task.status !== 'done') continue;
      if (!task.worktreePath) continue;

      const updatedAt = parseDbTime(task.updatedAt);
      if (isNaN(updatedAt)) continue;

      if (now - updatedAt >= thresholdMs) {
        const project = this.projectRepo.get(task.projectId);
        let hooks = null;
        if (project?.hooks) {
          try {
            hooks = JSON.parse(project.hooks);
          } catch {
            // ignore
          }
        }
        try {
          // remove() refuses anything outside worktreesDir or overlapping a project root.
          this.worktreeService.remove(project?.path ?? null, task.worktreePath, {
            slot: task.slot,
            slug: task.slug,
            projectId: task.projectId,
            taskId: task.id,
            hooks,
          });
        } catch {
          // ignore
        }

        this.taskRepo.update(task.id, { worktreePath: null, slot: null });
        this.eventBus.emit('worktree.cleaned', task.id, { worktreePath: task.worktreePath });
      }
    }
  }
}
