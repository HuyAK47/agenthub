import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('Disk Guard (chống đầy ổ đĩa)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-disk-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.disk.minFreeGB = 3;

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    // Setup git repo for project
    const projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Test');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'init', '--allow-empty'], {
      cwd: projectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 2,
    });

    ctx.profileRepo.upsert({
      name: 'p1',
      engine: 'agy',
      kind: 'isolated',
      home: path.join(agyHomesDir, 'p1'),
      email: 'p1@example.com',
      enabled: 1,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    ctx.scheduler.stop();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  it('blocks task from starting when disk space is below minFreeGB', () => {
    // Mock fs.statfs to report 1GB free (less than 3GB threshold)
    vi.spyOn(fs, 'statfs').mockImplementation((_target: unknown, cb: unknown) => {
      (cb as (err: unknown, stats: unknown) => void)(null, {
        bsize: 1024 * 1024,
        bavail: 1024, // 1 GB
        blocks: 100 * 1024, // 100 GB
      });
    });

    const emittedEvents: Array<{ type: string; taskId?: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, taskId, payload) => {
      emittedEvents.push({ type, taskId, payload: payload as Record<string, unknown> });
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    // Run scheduler tick
    ctx.scheduler.tick();

    const task = ctx.taskRepo.get('proj/t1');
    expect(task).toBeDefined();
    // Task should NOT have started
    expect(task!.status).toBe('waiting_quota');

    // Should emit disk.low and task.waiting_quota with reason 'disk'
    const diskLowEvent = emittedEvents.find((e) => e.type === 'disk.low');
    expect(diskLowEvent).toBeDefined();
    expect(diskLowEvent?.payload?.minFreeGB).toBe(3);

    const waitingEvent = emittedEvents.find((e) => e.type === 'task.waiting_quota' && e.taskId === 'proj/t1');
    expect(waitingEvent).toBeDefined();
    expect(waitingEvent?.payload?.reason).toBe('disk');

    // Running tasks map should be empty
    expect(ctx.scheduler.getRunning().size).toBe(0);
  });

  it('automatically resumes waiting task when disk space recovers', () => {
    let mockFreeGB = 1; // below 3GB initially

    vi.spyOn(fs, 'statfs').mockImplementation((_target: unknown, cb: unknown) => {
      (cb as (err: unknown, stats: unknown) => void)(null, {
        bsize: 1024 * 1024,
        bavail: mockFreeGB * 1024,
        blocks: 100 * 1024,
      });
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    // Tick 1: disk is low -> task moved to waiting_quota
    ctx.scheduler.tick();
    expect(ctx.taskRepo.get('proj/t1')!.status).toBe('waiting_quota');
    expect(ctx.scheduler.getRunning().size).toBe(0);

    // Disk recovers to 10GB (>= 3GB)
    mockFreeGB = 10;

    // Tick 2: disk recovered -> task re-queued and started
    ctx.scheduler.tick();

    const taskAfter = ctx.taskRepo.get('proj/t1');
    expect(taskAfter!.status).toBe('running');
    expect(ctx.scheduler.getRunning().has('proj/t1')).toBe(true);
  });

  it('emits disk transitions once even when ticks repeat', () => {
    let mockFreeGB = 1;

    vi.spyOn(fs, 'statfs').mockImplementation((_target: unknown, cb: unknown) => {
      (cb as (err: unknown, stats: unknown) => void)(null, {
        bsize: 1024 * 1024,
        bavail: mockFreeGB * 1024,
        blocks: 100 * 1024,
      });
    });

    const diskEvents: string[] = [];
    ctx.scheduler.getEventBus().on('*', (type) => {
      if (type === 'disk.low' || type === 'disk.ok') diskEvents.push(type);
    });

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low']);

    mockFreeGB = 10;
    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low', 'disk.ok']);

    mockFreeGB = 1;
    ctx.taskRepo.insert({
      id: 'proj/t2',
      projectId: 'proj',
      slug: 't2',
      title: 'Task 2',
      status: 'queued',
      level: 'easy',
    });
    ctx.scheduler.tick();
    ctx.scheduler.tick();
    expect(diskEvents).toEqual(['disk.low', 'disk.ok', 'disk.low']);
  });

  it('works with statfsSync mock as well', () => {
    vi.spyOn(fs, 'statfsSync').mockReturnValue({
      bsize: 1024 * 1024,
      bavail: 500, // 0.5 GB (< 3GB)
      blocks: 50 * 1024,
    } as unknown as fs.StatFs);

    ctx.taskRepo.insert({
      id: 'proj/t1',
      projectId: 'proj',
      slug: 't1',
      title: 'Task 1',
      status: 'queued',
      level: 'easy',
    });

    ctx.scheduler.tick();
    expect(ctx.taskRepo.get('proj/t1')!.status).toBe('waiting_quota');
  });

  it('blocks on a configured extra disk and includes its label in the wait event', () => {
    const extraPath = path.join(tmpDir, 'shared-docker');
    fs.mkdirSync(extraPath);
    config.disk.extraPaths = [{ path: extraPath, minFreeGB: 5, label: 'Ổ Docker dùng chung' }];
    vi.spyOn(fs, 'statfs').mockImplementation((target: unknown, cb: unknown) => {
      const freeGB = target === extraPath ? 1 : 20;
      (cb as (err: unknown, stats: unknown) => void)(null, {
        bsize: 1024 * 1024,
        bavail: freeGB * 1024,
        blocks: 100 * 1024,
      });
    });

    const events: Array<{ type: string; payload?: Record<string, unknown> }> = [];
    ctx.scheduler.getEventBus().on('*', (type, _taskId, payload) => events.push({ type, payload: payload as Record<string, unknown> }));
    ctx.taskRepo.insert({ id: 'proj/t-extra', projectId: 'proj', slug: 't-extra', title: 'Extra disk', status: 'queued', level: 'easy' });

    ctx.scheduler.tick();

    expect(ctx.taskRepo.get('proj/t-extra')?.status).toBe('waiting_quota');
    expect(events.find((event) => event.type === 'task.waiting_quota')?.payload).toMatchObject({
      reason: 'disk',
      label: 'Ổ Docker dùng chung',
      freeGB: 1,
      minFreeGB: 5,
    });
  });
});
