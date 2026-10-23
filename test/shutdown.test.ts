import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createContext, startDaemon } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

function initGitRepo(repoPath: string) {
  fs.mkdirSync(repoPath, { recursive: true });
  execFileSync('git', ['init'], { cwd: repoPath });
  execFileSync('git', ['checkout', '-b', 'main'], { cwd: repoPath });
  fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
  execFileSync('git', ['add', '.'], { cwd: repoPath });
  execFileSync('git', ['commit', '-m', 'chore: initial commit', '--allow-empty'], {
    cwd: repoPath,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    },
  });
}

describe('Daemon and server shutdown', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let token: string;
  let engines: Map<string, Engine>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-shutdown-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    engines = new Map<string, Engine>([['agy', fakeEngine]]);
  });

  afterEach(() => {
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('closes server in less than 2 seconds when an active SSE connection is open', async () => {
    ctx = createContext(config, engines);
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    let sseConnected = false;
    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        if (res.statusCode === 200) {
          sseConnected = true;
        }
      },
    );
    req.end();

    const eventBus = ctx.scheduler.getEventBus();
    await vi.waitFor(() => {
      expect(sseConnected).toBe(true);
      expect(eventBus.listenerCount('*')).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const startTime = Date.now();
    await server.close();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(2000);
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('closes connected websocket clients with code 1001 on server close', async () => {
    ctx = createContext(config, engines);
    ctx.service.createProfile({ name: 'testprofile' });
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/profiles/testprofile/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(loginRes.status).toBe(200);
    const { sessionId } = (await loginRes.json()) as { sessionId: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty/${sessionId}?token=${token}`);
    let closeCode: number | null = null;
    let closeReason = '';
    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });

    await vi.waitFor(() => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    }, { timeout: 3000 });

    const startTime = Date.now();
    await server.close();
    const duration = Date.now() - startTime;

    await vi.waitFor(() => {
      expect(closeCode).toBe(1001);
    }, { timeout: 3000 });

    expect(duration).toBeLessThan(2000);
    expect(closeCode).toBe(1001);
    expect(closeReason).toContain('Going Away');
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('shutdown() is idempotent and executes only once', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const daemon = await startDaemon(config, engines);

    const closeSpy = vi.spyOn(daemon.fastify, 'close');

    // Call shutdown twice
    await Promise.all([daemon.shutdown(), daemon.shutdown()]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('shutdown() logs shutdown duration', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const daemon = await startDaemon(config, engines);
    await daemon.shutdown();

    const loggedTiming = consoleSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && /Shutdown completed in \d+ms/.test(arg)),
    );
    expect(loggedTiming).toBe(true);
  });

  it('shutdown() forces exit on 5s timeout if closing hangs', async () => {
    vi.useFakeTimers();
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const daemon = await startDaemon(config, engines);

      // Simulate hanging fastify.close
      vi.spyOn(daemon.fastify, 'close').mockImplementation(() => new Promise(() => {}));

      // Trigger shutdown without awaiting (since it will hang until timer)
      void daemon.shutdown();

      // Fast-forward past 5 seconds
      await vi.advanceTimersByTimeAsync(5100);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Shutdown timed out after 5s'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('POST /api/hub/shutdown requires authentication', async () => {
    ctx = createContext(config, engines);
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/api/hub/shutdown`, {
      method: 'POST',
      headers: { host: `127.0.0.1:${port}`, 'content-type': 'application/json' },
      body: JSON.stringify({ disable: false }),
    });
    expect(res.status).toBe(401);

    await server.close();
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('POST /api/hub/shutdown puts running and checking tasks into queued with resume=1, marks reviewer runs user_stop, and retains review status', async () => {
    ctx = createContext(config, engines);
    const repoPath = path.join(tmpDir, 'repo');
    initGitRepo(repoPath);

    ctx.projectRepo.insert({
      id: 'testproj',
      name: 'Test Project',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });
    ctx.profileRepo.upsert({
      name: 'profile-1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'home1'),
      email: 'a@b.c',
      enabled: 1,
      authState: 'ok',
      authMessage: null,
      verifyUrl: null,
      label: null,
      notes: null,
      priority: 1,
      deletedAt: null,
      accountType: null,
      avatarUrl: null,
    });

    // Task 1: running
    ctx.taskRepo.insert({
      id: 'testproj/task-1',
      projectId: 'testproj',
      slug: 'task-1',
      title: 'Running Task',
      status: 'running',
    });
    ctx.runRepo.insert({
      id: 'run-1',
      taskId: 'testproj/task-1',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'profile-1',
      pid: process.pid,
    });
    ctx.scheduler.getRunning().set('testproj/task-1', {
      taskId: 'testproj/task-1',
      runId: 'run-1',
      pid: process.pid,
      profileName: 'profile-1',
      engine: engines.get('agy')!,
      startedAt: Date.now(),
      timeout: setTimeout(() => {}, 100_000),
    });

    // Task 2: checking
    ctx.taskRepo.insert({
      id: 'testproj/task-2',
      projectId: 'testproj',
      slug: 'task-2',
      title: 'Checking Task',
      status: 'checking',
    });
    (ctx.scheduler as unknown as { checkingActive: Map<string, unknown> }).checkingActive.set('testproj/task-2', {
      taskId: 'testproj/task-2',
      runId: 'fake-run-2',
      worktreePath: repoPath,
      branch: 'task-2',
      resolve: () => {},
    });

    // Task 3: review with active reviewer run
    ctx.taskRepo.insert({
      id: 'testproj/task-3',
      projectId: 'testproj',
      slug: 'task-3',
      title: 'Review Task',
      status: 'review',
    });
    ctx.runRepo.insert({
      id: 'run-rev-1',
      taskId: 'testproj/task-3',
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'profile-1',
      pid: process.pid,
      kind: 'reviewer',
    });
    (ctx.scheduler as unknown as { reviewerRuns: Map<string, unknown> }).reviewerRuns.set('testproj/task-3', {
      taskId: 'testproj/task-3',
      runId: 'run-rev-1',
      pid: process.pid,
      profileName: 'profile-1',
      engine: engines.get('agy')!,
      actor: 'primary',
      outputPath: path.join(tmpDir, 'rev.out'),
      startedAt: Date.now(),
      timeout: setTimeout(() => {}, 100_000),
    });

    const queuedEvents: Array<{ taskId?: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('task.queued', (taskId, payload) => {
      queuedEvents.push({ taskId, payload: payload as Record<string, unknown> });
    });

    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/api/hub/shutdown`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ disable: false }),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; queued: number; reviewers: number; daemonPid: number; childPids: number[] };
    expect(body.ok).toBe(true);
    expect(body.queued).toBe(2);
    expect(body.reviewers).toBe(1);
    expect(body.daemonPid).toBe(process.pid);
    expect(Array.isArray(body.childPids)).toBe(true);

    // Verify task 1 (was running) -> queued with resume=1 and crashed with user_stop
    const updated1 = ctx.taskRepo.get('testproj/task-1');
    expect(updated1?.status).toBe('queued');
    expect(updated1?.resume).toBe(1);
    const updatedRun1 = ctx.runRepo.get('run-1');
    expect(updatedRun1?.outcome).toBe('crashed');
    expect(updatedRun1?.reason).toBe('user_stop');

    // Verify task 2 (was checking) -> queued with resume=1
    const updated2 = ctx.taskRepo.get('testproj/task-2');
    expect(updated2?.status).toBe('queued');
    expect(updated2?.resume).toBe(1);

    // Verify task 3 (was review) -> remains review, reviewer run crashed with user_stop
    const updated3 = ctx.taskRepo.get('testproj/task-3');
    expect(updated3?.status).toBe('review');
    const updatedRevRun = ctx.runRepo.get('run-rev-1');
    expect(updatedRevRun?.outcome).toBe('crashed');
    expect(updatedRevRun?.reason).toBe('user_stop');

    // Events emitted with note 'dừng bởi người dùng' and reason 'user_stop'
    expect(queuedEvents.some((e) => e.taskId === 'testproj/task-1' && e.payload?.note === 'dừng bởi người dùng')).toBe(true);
    expect(queuedEvents.some((e) => e.taskId === 'testproj/task-2' && e.payload?.note === 'dừng bởi người dùng')).toBe(true);

    await server.close();
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('resumes queued task after starting a new daemon', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const repoPath = path.join(tmpDir, 'repo-resume');
    initGitRepo(repoPath);

    // Initial setup: create project and a queued task with resume=1
    const initCtx = createContext(config, engines);
    initCtx.projectRepo.insert({
      id: 'resumeproj',
      name: 'Resume Project',
      path: repoPath,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 2,
    });
    initCtx.profileRepo.upsert({
      name: 'profile-1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(tmpDir, 'home1'),
      email: 'a@b.c',
      enabled: 1,
      authState: 'ok',
      authMessage: null,
      verifyUrl: null,
      label: null,
      notes: null,
      priority: 1,
      deletedAt: null,
      accountType: null,
      avatarUrl: null,
    });
    initCtx.taskRepo.insert({
      id: 'resumeproj/t-resume',
      projectId: 'resumeproj',
      slug: 't-resume',
      title: 'Task to Resume',
      body: 'Do work',
      status: 'queued',
      level: 'easy',
      modelChain: JSON.stringify(['gemini-3.8-flash-high']),
    });
    initCtx.taskRepo.update('resumeproj/t-resume', { resume: 1 });
    initCtx.scheduler.stop();
    initCtx.db.close();

    // Start a fresh daemon
    const daemon = await startDaemon(config, engines);

    // Verify scheduler picks up the task and starts running it
    await vi.waitFor(() => {
      const running = daemon.ctx.scheduler.getRunning();
      expect(running.has('resumeproj/t-resume')).toBe(true);
      const currentTask = daemon.ctx.taskRepo.get('resumeproj/t-resume');
      expect(currentTask?.status).toBe('running');
    }, { timeout: 5000 });

    await daemon.shutdown();
  });

  it('POST /api/hub/shutdown with disable: true notifies onShutdown callback', async () => {
    ctx = createContext(config, engines);
    let disabledPassed: boolean | undefined;
    const server = await createServer(ctx.service, config, {
      onShutdown: (disable) => {
        disabledPassed = disable;
      },
    });
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    const res = await fetch(`http://127.0.0.1:${port}/api/hub/shutdown`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ disable: true }),
    });

    expect(res.status).toBe(200);
    expect(disabledPassed).toBe(true);

    await server.close();
    ctx.scheduler.stop();
    ctx.db.close();
  });
});
