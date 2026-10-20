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
  RunMetricsRepo,
  TaskNoteRepo,
} from './db/index.js';
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
  chatSessionRepo: ChatSessionRepo;
  chatMessageRepo: ChatMessageRepo;
  chatPermissionRepo: ChatPermissionRepo;
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
  telegramService: TelegramBotService;
}

export function createContext(config: AgentHubConfig, engineOverrides?: Map<string, Engine>): DaemonContext {
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
  const usageRepo = new QuotaUsageRepo(db);
  const chatSessionRepo = new ChatSessionRepo(db);
  const chatMessageRepo = new ChatMessageRepo(db);
  const chatPermissionRepo = new ChatPermissionRepo(db);
  chatPermissionRepo.expirePending();
  const permissionBroker = new PermissionBroker(chatPermissionRepo, config.chat.permissionTimeoutSec, (request) => {
    eventRepo.insert('chat.permission_request', request.sessionId, request as unknown as Record<string, unknown>);
    scheduler?.getEventBus?.().emit('chat.permission_request', request.sessionId, request as unknown as Record<string, unknown>);
  });
  const claudeSessionRepo = new ClaudeSessionRepo(db);
  const failoverState = new ClaudeFailoverState(path.join(config.hubHome, 'claude-failover.json'), undefined, {
    steps: config.brain.fallback,
    apiKeyPath: path.join(config.hubHome, 'secrets', 'anthropic.key'),
  });
  const claudeScanner = new ClaudeSessionScanner(db, { ...config.claudeSessions, hubHome: config.hubHome, worktreesDir: config.worktreesDir, failoverState });
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
  if (engineOverrides) {
    for (const [k, v] of engineOverrides) engines.set(k, v);
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
      engines.set('codex', new CodexEngine(codexPath));
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
  );
  scheduler.configureReviewer(reviewRepo, failoverState);

  const brainRepo = new BrainRepo(db);
  const brainService = new BrainService(brainRepo, eventRepo, () => scheduler.getEventBus());
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
    { failoverState },
  );

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
  );

  const notifier = new NotificationService({
    eventBus: scheduler.getEventBus(),
    config,
    taskRepo,
    quotaMarkRepo,
  });

  const telegramService = new TelegramBotService({
    config,
    service,
    eventBus: scheduler.getEventBus(),
    taskRepo,
    projectRepo,
    quotaMarkRepo,
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
    chatSessionRepo,
    chatMessageRepo,
    chatPermissionRepo,
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
    telegramService,
  };
}

export function closeContext(ctx: DaemonContext): void {
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
    process.removeListener('SIGTERM', shutdown);

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

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  return { fastify, ctx, shutdown };
}

