import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentHubConfig } from './config.js';
import {
  openDatabase,
  ProjectRepo,
  ProfileRepo,
  QuotaMarkRepo,
  TaskRepo,
  RunRepo,
  ReviewRepo,
  EventRepo,
  QuotaUsageRepo,
  ChatSessionRepo,
  ChatMessageRepo,
  ChatPermissionRepo,
  PermissionRuleRepo,
  ChatRetryRepo,
  RunMetricsRepo,
  TaskNoteRepo,
  KnowledgeRepo,
  TaskBatchRepo,
  BrainTurnRepo,
  CiRepo,
} from './db/index.js';
import { CiWatchService } from './ci.js';
import { ProfileService } from './profiles/index.js';
import { Scheduler } from './scheduler/index.js';
import { Engine, AgyEngine, CodexEngine, FakeEngine } from './engines/index.js';
import { AppService } from './services/index.js';
import { createServer } from './api/server.js';
import { QuotaUsageService } from './quota/usage.js';
import { ProfileLockService } from './profiles/locks.js';
import { BrainRepo, BrainService } from './brain.js';
import { ChatService } from './chat/service.js';
import { NotificationService } from './notify.js';
import { SavingsService } from './savings.js';
import { ClaudeFailoverState } from './chat/failover.js';
import { ClaudeSessionRepo } from './claude-sessions/repo.js';
import { ClaudeSessionScanner } from './claude-sessions/scanner.js';
import { BulletinService } from './bulletin.js';
import { TelegramBotService } from './telegram.js';
import { PermissionBroker } from './chat/permissions.js';
import { findClaudeBin } from './chat/claude.js';
import { stopProcessGroups } from './priority.js';
import fs from 'node:fs';
import { SetupManager } from './tools/setup.js';
import { BrainPolicy, projectBrainPolicy } from './brain/policy.js';
import { BrainRunner } from './brain/runner.js';
import { type DiskSpace } from './disk.js';
import { DeployService } from './deploy.js';

export interface DaemonContext {
  config: AgentHubConfig;
  db: ReturnType<typeof openDatabase>;
  projectRepo: ProjectRepo;
  profileRepo: ProfileRepo;
  quotaMarkRepo: QuotaMarkRepo;
  taskRepo: TaskRepo;
  runRepo: RunRepo;
  runMetricsRepo: RunMetricsRepo;
  reviewRepo: ReviewRepo;
  eventRepo: EventRepo;
  taskNoteRepo: TaskNoteRepo;
  knowledgeRepo: KnowledgeRepo;
  chatSessionRepo: ChatSessionRepo;
  chatMessageRepo: ChatMessageRepo;
  chatPermissionRepo: ChatPermissionRepo;
  chatRetryRepo: ChatRetryRepo;
  permissionBroker: PermissionBroker;
  profileService: ProfileService;
  scheduler: Scheduler;
  service: AppService;
  chatService: ChatService;
  usageService: QuotaUsageService;
  brainRepo: BrainRepo;
  brainService: BrainService;
  notifier: NotificationService;
  bulletinService: BulletinService;
  savingsService: SavingsService;
  claudeSessionRepo: ClaudeSessionRepo;
  claudeScanner: ClaudeSessionScanner;
  usageRepo: QuotaUsageRepo;
  telegramService: TelegramBotService;
  brainRunner: BrainRunner;
  deployService: DeployService;
  ciRepo: CiRepo;
  ciService: CiWatchService;
}

export interface CreateContextOptions {
  diskSpace?: (path: string) => DiskSpace;
}

export function createContext(
  config: AgentHubConfig,
  engineOverrides?: Map<string, Engine> | CreateContextOptions,
  diskReader?: ((p: string) => DiskSpace) | CreateContextOptions,
): DaemonContext {
  let enginesOverride: Map<string, Engine> | undefined;
  let diskFn: ((p: string) => DiskSpace) | undefined;

  if (engineOverrides instanceof Map) {
    enginesOverride = engineOverrides;
  } else if (engineOverrides && typeof engineOverrides === 'object') {
    diskFn = engineOverrides.diskSpace;
  }

  if (typeof diskReader === 'function') {
    diskFn = diskReader;
  } else if (diskReader && typeof diskReader === 'object') {
    diskFn = diskReader.diskSpace;
  }
  const db = openDatabase(config.dbPath);
  const projectRepo = new ProjectRepo(db);
  const profileRepo = new ProfileRepo(db);
  const quotaMarkRepo = new QuotaMarkRepo(db);
  const taskRepo = new TaskRepo(db);
  const runRepo = new RunRepo(db);
  const runMetricsRepo = new RunMetricsRepo(db);
  const reviewRepo = new ReviewRepo(db);
  const eventRepo = new EventRepo(db);
  const taskNoteRepo = new TaskNoteRepo(db);
  const knowledgeRepo = new KnowledgeRepo(db);
  const taskBatchRepo = new TaskBatchRepo(db);
  const usageRepo = new QuotaUsageRepo(db);
  const chatSessionRepo = new ChatSessionRepo(db);
  const chatMessageRepo = new ChatMessageRepo(db);
  const chatPermissionRepo = new ChatPermissionRepo(db);
  const permissionRuleRepo = new PermissionRuleRepo(db);
  const chatRetryRepo = new ChatRetryRepo(db);
  const brainTurnRepo = new BrainTurnRepo(db);
  chatPermissionRepo.expirePending();
  const systemBrainPolicy = new BrainPolicy({
    roots: [process.cwd(), config.hubHome, config.worktreesDir],
    extraPatterns: config.brain.policy.flatMap((pattern) => {
      try { return [new RegExp(pattern)]; } catch { return []; }
    }),
    mode: config.brain.mode === 'auto' ? 'auto' : 'suggest',
  });
  const permissionBroker = new PermissionBroker(chatPermissionRepo, config.chat.permissionTimeoutSec, (request) => {
    eventRepo.insert('chat.permission_request', request.sessionId, request as unknown as Record<string, unknown>);
    scheduler?.getEventBus?.().emit('chat.permission_request', request.sessionId, request as unknown as Record<string, unknown>);
  }, (sessionId) => {
    const session = chatSessionRepo.get(sessionId);
    if (!session?.projectId) return systemBrainPolicy;
    const project = projectRepo.get(session.projectId);
    if (!project) return systemBrainPolicy;
    return projectBrainPolicy(project, config);
  }, chatSessionRepo, permissionRuleRepo, projectRepo);
  const claudeSessionRepo = new ClaudeSessionRepo(db);
  const failoverState = new ClaudeFailoverState(path.join(config.hubHome, 'claude-failover.json'), undefined, {
    steps: config.brain.fallback,
    apiKeyPath: path.join(config.hubHome, 'secrets', 'anthropic.key'),
  });
  const claudeScanner = new ClaudeSessionScanner(db, { ...config.claudeSessions, hubHome: config.hubHome, worktreesDir: config.worktreesDir, failoverState, autoResume: { ...config.claudeSessions.autoResume, claudeBin: config.chat.claudeBin, profileName: config.chat.claudeProfile || null } });
  usageRepo.deleteForEngine('codex');

  const profileService = new ProfileService(config, profileRepo, quotaMarkRepo);
  const locks = new ProfileLockService(path.join(config.agyHomesDir, '.state'), config.slotsPerAgyProfile, config.slotsPerCodexProfile);
  const usageService = new QuotaUsageService(profileRepo, usageRepo, quotaMarkRepo);
  const savingsService = new SavingsService(
    config,
    taskRepo,
    runRepo,
    runMetricsRepo,
    reviewRepo,
    profileRepo,
    projectRepo,
    claudeSessionRepo,
  );

  const engines = new Map<string, Engine>();
  if (enginesOverride) {
    for (const [k, v] of enginesOverride) engines.set(k, v);
  } else if (process.env.AGENTHUB_FAKE_ENGINE === '1') {
    const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const fakeScript =
      process.env.AGENTHUB_FAKE_SCRIPT ||
      path.join(rootDir, 'test', 'fixtures', 'fake-agent.mjs');
    const fakeEngine = new FakeEngine(fakeScript);
    engines.set('agy', fakeEngine);
    const fakeCodex = new FakeEngine(fakeScript);
    (fakeCodex as { id: 'agy' | 'codex' }).id = 'codex';
    engines.set('codex', fakeCodex);
  } else {
    engines.set('agy', new AgyEngine());
    const codexPath = CodexEngine.findCodexPath();
    if (codexPath) {
      engines.set('codex', new CodexEngine(codexPath, config.workers?.codexSandbox || 'off'));
    }
  }

  const scheduler = new Scheduler(
    config,
    taskRepo,
    runRepo,
    eventRepo,
    projectRepo,
    profileRepo,
    quotaMarkRepo,
    engines,
    usageService,
    locks,
    db,
    runMetricsRepo,
    knowledgeRepo,
    diskFn ? { diskSpace: diskFn } : undefined,
  );
  usageService.setEventBus(scheduler.getEventBus());
  const setupManager = new SetupManager(config, scheduler.getEventBus(), (tool) => {
    profileService.registerAll();
    scheduler.refreshEngines();
    scheduler.getEventBus().emit('profile.updated', undefined, { source: 'setup', tool });
  });
  scheduler.configureReviewer(reviewRepo, failoverState);
  claudeScanner.setEventBus(scheduler.getEventBus());

  const brainRepo = new BrainRepo(db);
  const brainService = new BrainService(brainRepo, eventRepo, () => scheduler.getEventBus(), claudeSessionRepo, db);
  const chatService = new ChatService(
    config,
    chatSessionRepo,
    chatMessageRepo,
    permissionBroker,
    projectRepo,
    scheduler.getEventBus(),
    taskRepo,
    runRepo,
    profileRepo,
    quotaMarkRepo,
    usageRepo,
    eventRepo,
    { failoverState, retryRepo: chatRetryRepo },
  );
  scheduler.getEventBus().on('claude.quota_available', (_taskId, payload) => {
    const data = payload && typeof payload === 'object' ? payload as { profileName?: unknown; observedAt?: unknown } : {};
    if (typeof data.profileName !== 'string') return;
    if (typeof data.observedAt === 'string') claudeSessionRepo.markAllowedAfter(data.profileName, data.observedAt);
    chatService.retryWaitingForProfile(data.profileName);
  });
  const brainRunner = new BrainRunner({
    config: config.brain,
    eventBus: scheduler.getEventBus(),
    chatService,
    chatSessionRepo,
    profileRepo,
    taskRepo,
    turnRepo: brainTurnRepo,
    projectRepo,
  });

  const deployService = new DeployService(config, projectRepo, scheduler.getEventBus());
  deployService.start();

  const bulletinService = new BulletinService({
    config,
    taskRepo,
    projectRepo,
    taskNoteRepo,
    eventBus: scheduler.getEventBus(),
  });
  scheduler.configureBulletinService(bulletinService);

  const service = new AppService(
    config,
    projectRepo,
    profileRepo,
    quotaMarkRepo,
    taskRepo,
    runRepo,
    reviewRepo,
    eventRepo,
    profileService,
    scheduler,
    usageService,
    locks,
    brainService,
    chatService,
    savingsService,
    claudeSessionRepo,
    claudeScanner,
    taskNoteRepo,
    bulletinService,
    undefined,
    knowledgeRepo,
    taskBatchRepo,
    setupManager,
    brainRunner,
  );
  service.deployService = deployService;

  const ciRepo = new CiRepo(db);
  const ciService = new CiWatchService({
    config,
    projectRepo,
    ciRepo,
    eventBus: scheduler.getEventBus(),
  });
  service.ciRepo = ciRepo;
  service.ciService = ciService;

  const notifier = new NotificationService({
    eventBus: scheduler.getEventBus(),
    config,
    taskRepo,
    profileRepo,
    quotaMarkRepo,
    projectRepo,
    ciRepo,
  });

  const telegramService = new TelegramBotService({
    config,
    service,
    eventBus: scheduler.getEventBus(),
    taskRepo,
    projectRepo,
    profileRepo,
    quotaMarkRepo,
    chatService,
    brainSession: true,
    ciRepo,
  });
  service.setTelegramBotService(telegramService);

  return {
    config,
    db,
    projectRepo,
    profileRepo,
    quotaMarkRepo,
    taskRepo,
    runRepo,
    runMetricsRepo,
    reviewRepo,
    eventRepo,
    taskNoteRepo,
    knowledgeRepo,
    chatSessionRepo,
    chatMessageRepo,
    chatPermissionRepo,
    chatRetryRepo,
    permissionBroker,
    profileService,
    scheduler,
    service,
    chatService,
    usageService,
    brainRepo,
    brainService,
    notifier,
    bulletinService,
    savingsService,
    claudeSessionRepo,
    claudeScanner,
    usageRepo,
    telegramService,
    brainRunner,
    deployService,
    ciRepo,
    ciService,
  };
}

export function closeContext(ctx: DaemonContext): void {
  try {
    ctx.brainRunner?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.notifier?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.bulletinService?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.ciService?.stop();
  } catch {
    // ignore
  }
  try {
    stopProcessGroups('SIGTERM');
  } catch {
    // ignore
  }
  try {
    ctx.scheduler?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.usageService?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.claudeScanner?.stop();
  } catch {
    // ignore
  }
  try {
    void ctx.telegramService?.stop();
  } catch {
    // ignore
  }
  try {
    ctx.db?.close();
  } catch {
    // ignore
  }
}

export async function startDaemon(
  config: AgentHubConfig,
  engineOverrides?: Map<string, Engine>,
): Promise<{
  fastify: Awaited<ReturnType<typeof createServer>>;
  ctx: DaemonContext;
  shutdown: () => Promise<void>;
}> {
  const ctx = createContext(config, engineOverrides);

  // Register profiles on startup
  ctx.profileService.registerAll();
  // Claude /usage opens the real Claude Code CLI; never do that from the test suite.
  if (!process.env.VITEST) {
    ctx.usageService.configureClaude({
      bin: () => findClaudeBin(ctx.config.chat.claudeBin),
      cwd: path.join(ctx.config.hubHome, 'claude-usage-cwd'),
    });
  }
  ctx.usageService.start();

  // Start scheduler
  ctx.scheduler.start();

  // Start notification service and claude transcript scanner
  ctx.notifier.start();
  ctx.claudeScanner.start();
  ctx.bulletinService.start();
  ctx.brainRunner.start();
  ctx.ciService.start();

  // Start Telegram bot if enabled
  if (config.telegram?.enabled) {
    ctx.telegramService.start();
  }

  // Start Fastify HTTP server with security and API endpoints
  const fastify = await createServer(ctx.service, config);

  const port = config.port;
  try {
    await fastify.listen({ port, host: '127.0.0.1' });
    console.log(`AgentHub daemon running on http://127.0.0.1:${port}`);
  } catch (err) {
    console.error('Failed to start daemon:', err);
    process.exit(1);
  }

  // Graceful shutdown
  let isShuttingDown = false;
  const shutdown = async () => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    process.removeListener('SIGINT', shutdown);
    process.removeListener('SIGTERM', onTerm);

    const startTime = Date.now();
    console.log('Shutting down...');

    const forceTimer = setTimeout(() => {
      console.warn('Shutdown timed out after 5s, forcing exit');
      process.exit(0);
    }, 5000);
    forceTimer.unref();

    try {
      // Dừng nhận request trước, rồi mới đóng scheduler và DB
      await fastify.close();
      closeContext(ctx);
    } catch (err) {
      console.error('Error during shutdown:', err);
    } finally {
      clearTimeout(forceTimer);
      const elapsed = Date.now() - startTime;
      console.log(`Shutdown completed in ${elapsed}ms`);
      process.exit(0);
    }
  };

  const onTerm = () => {
    const workersRunning = ctx.scheduler.getRunning().size > 0 || ctx.scheduler.getReviewerStatus().running.length > 0;
    let parentIsServiceManager = false;
    try {
      parentIsServiceManager = /^(?:systemd|launchd)$/i.test(fs.readFileSync(`/proc/${process.ppid}/comm`, 'utf8').trim());
    } catch { /* platform does not expose the parent name */ }
    if (workersRunning && !parentIsServiceManager) ctx.eventRepo.insert('daemon.stop_requested', undefined, { senderPid: process.ppid || null });
    void shutdown();
  };

  // Last line of defence: log stray async errors instead of taking the whole hub down.
  process.on('unhandledRejection', (reason) => {
    console.error('[daemon] unhandled rejection:', reason instanceof Error ? reason.stack || reason.message : reason);
  });
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', onTerm);

  return { fastify, ctx, shutdown };
}

