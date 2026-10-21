import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { openDatabase, TaskRepo, QuotaMarkRepo, EventRepo, ProjectRepo, ProfileRepo } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';
import { NotificationService } from '../src/notify.js';

describe('NotificationService (Desktop Notifications)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let profileRepo: ProfileRepo;
  let taskRepo: TaskRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let eventRepo: EventRepo;
  let eventBus: EventBus;
  let config: ReturnType<typeof loadConfig>;
  let execCalls: Array<{ file: string; args: string[] }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-notify-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);

    db = openDatabase(config.dbPath);
    projectRepo = new ProjectRepo(db);
    profileRepo = new ProfileRepo(db);
    taskRepo = new TaskRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    eventRepo = new EventRepo(db);
    eventBus = new EventBus(eventRepo);

    projectRepo.insert({ id: 'proj', name: 'Proj', path: tmpDir, defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    profileRepo.upsert({ name: 'g1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    profileRepo.upsert({ name: 'chinh', engine: 'agy', kind: 'keyring', home: tmpDir, email: null, enabled: 1 });

    execCalls = [];
  });

  afterEach(() => {
    db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
  });

  const fakeExec = (file: string, args: string[]) => {
    execCalls.push({ file, args });
  };

  it('notifies on task.review_ready with title and optional checks indicator', () => {
    taskRepo.insert({
      id: 'proj/task-1',
      projectId: 'proj',
      slug: 'task-1',
      title: 'Fix issue with login',
      status: 'review',
    });

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // 1. Without checksPassed
    eventBus.emit('task.review_ready', 'proj/task-1');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review'],
    });

    // 2. With checksPassed: true (different key so not deduped)
    eventBus.emit('task.review_ready', 'proj/task-1', { checksPassed: true });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review (✓ checks)'],
    });

    // 3. With checksPassed: false
    eventBus.emit('task.review_ready', 'proj/task-1', { checksPassed: false });
    expect(execCalls).toHaveLength(3);
    expect(execCalls[2]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Fix issue with login chờ review (✗ checks)'],
    });

    notifier.stop();
  });

  it('notifies when Claude changes fallback step without including credentials', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();
    eventBus.emit('claude.fallback_changed', undefined, { step: { type: 'apiKey' }, reason: 'quota' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('Claude fallback: đang dùng API key');
    expect(execCalls.join(' ')).not.toContain('sk-');
  });

  it('uses critical urgency only for task.failed', () => {
    taskRepo.insert({
      id: 'proj/task-fail',
      projectId: 'proj',
      slug: 'task-fail',
      title: 'Build task',
      status: 'failed',
    });
    taskRepo.insert({
      id: 'proj/task-block',
      projectId: 'proj',
      slug: 'task-block',
      title: 'Auth task',
      status: 'blocked',
    });

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    eventBus.emit('task.failed', 'proj/task-fail');
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-u', 'critical', '-t', '10000', '-a', 'AgentHub', 'AgentHub: Build task thất bại'],
    });

    eventBus.emit('task.blocked', 'proj/task-block');
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'AgentHub: Auth task bị chặn'],
    });

    notifier.stop();
  });

  it('notifies when a task is escalated to a human reviewer', () => {
    taskRepo.insert({
      id: 'proj/task-escalated',
      projectId: 'proj',
      slug: 'task-escalated',
      title: 'Needs human review',
      status: 'review',
    });
    const notifier = new NotificationService({ eventBus, config, taskRepo, exec: fakeExec });
    notifier.start();

    eventBus.emit('review.escalated', 'proj/task-escalated');

    expect(execCalls[0].file).toBe('notify-send');
    expect(execCalls[0].args).toEqual(['-t', '10000', '-a', 'AgentHub', 'Cần người duyệt: Needs human review']);
    notifier.stop();
  });

  it('notifies on quota.exhausted with profile, family, and reset time HH:MM', () => {
    const resetEpoch = Math.floor(Date.now() / 1000) + 3600;
    const expectedD = new Date(resetEpoch * 1000);
    const expectedTime = `${String(expectedD.getHours()).padStart(2, '0')}:${String(expectedD.getMinutes()).padStart(2, '0')}`;

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // From payload resetAt
    eventBus.emit('quota.exhausted', undefined, {
      profile: 'g1',
      family: 'gemini',
      resetAt: resetEpoch,
    });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', `Hồ sơ g1 hết quota gemini tới ${expectedTime}`],
    });

    // From active quota mark
    quotaMarkRepo.mark('chinh', 'claude', resetEpoch, 'test');
    eventBus.emit('quota.exhausted', undefined, {
      profile: 'chinh',
      family: 'claude',
    });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', `Hồ sơ chinh hết quota claude tới ${expectedTime}`],
    });

    notifier.stop();
  });

  it('notifies when a profile authentication expires', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();
    eventBus.emit('profile.auth_expired', undefined, { name: 'g3' });
    expect(execCalls[0]).toEqual({
      file: 'notify-send',
      args: ['-t', '10000', '-a', 'AgentHub', 'Hồ sơ g3 cần đăng nhập lại'],
    });
    notifier.stop();
  });

  it('notifies on disk.low and disk.ok with normal urgency', () => {
    const notifier = new NotificationService({ eventBus, config, exec: fakeExec });
    notifier.start();

    eventBus.emit('disk.low', undefined, { freeGB: 1.25, minFreeGB: 3 });
    eventBus.emit('disk.ok', undefined, { freeGB: 10 });

    expect(execCalls.map((call) => call.args)).toEqual([
      ['-t', '10000', '-a', 'AgentHub', 'Ổ đĩa còn 1.25 GB (< 3 GB): tạm dừng khởi chạy task'],
      ['-t', '10000', '-a', 'AgentHub', 'Ổ đĩa đã đủ chỗ (10 GB): tiếp tục chạy task'],
    ]);

    notifier.stop();
  });

  it('deduplicates identical notifications within 30 seconds', () => {
    let mockCurrentTime = 1_000_000;
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
      now: () => mockCurrentTime,
    });
    notifier.start();

    // First event at t=1,000,000
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(1);

    // Same event at t=1,010,000 (10s later, within 30s) -> ignored
    mockCurrentTime += 10_000;
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(1);

    // Same event at t=1,031,000 (31s later, >30s) -> sent
    mockCurrentTime += 21_000;
    eventBus.emit('task.failed', 'task-x', { title: 'X' });
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('respects config notifications.desktop toggle (enabled by default, can be disabled)', () => {
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // Default enabled
    eventBus.emit('task.failed', 'task-1', { title: 'T1' });
    expect(execCalls).toHaveLength(1);

    // Disabled via config
    config.notifications.desktop = false;
    eventBus.emit('task.failed', 'task-2', { title: 'T2' });
    expect(execCalls).toHaveLength(1);

    // Re-enabled
    config.notifications.desktop = true;
    eventBus.emit('task.failed', 'task-3', { title: 'T3' });
    expect(execCalls).toHaveLength(2);

    notifier.stop();
  });

  it('silently ignores errors if exec fails without throwing or crashing', () => {
    const failingExec = () => {
      const err = new Error('spawn notify-send ENOENT') as Error & { code?: string };
      err.code = 'ENOENT';
      throw err;
    };

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      quotaMarkRepo,
      exec: failingExec,
    });
    notifier.start();

    expect(() => {
      eventBus.emit('task.review_ready', 't', { title: 'T' });
    }).not.toThrow();

    notifier.stop();
  });

  it('in brain auto mode, suppresses raw task notifications and only notifies brain.notify and system incidents', () => {
    config.brain.mode = 'auto';
    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      exec: fakeExec,
    });
    notifier.start();

    // 1. Raw task events should be suppressed
    eventBus.emit('task.review_ready', 'task-1', { title: 'T1' });
    eventBus.emit('task.failed', 'task-2', { title: 'T2' });
    eventBus.emit('task.blocked', 'task-3', { title: 'T3' });
    eventBus.emit('batch.created', undefined, { taskCount: 3 });
    // Single quota exhaustion when another profile is free should be suppressed
    quotaMarkRepo.mark('g1', 'gemini', Math.floor(Date.now() / 1000) + 3600);
    eventBus.emit('quota.exhausted', undefined, { profile: 'g1', family: 'gemini' });
    expect(execCalls).toHaveLength(0);

    // 2. brain.notify should be sent
    eventBus.emit('brain.notify', undefined, { text: 'Cần xác nhận từ người dùng', level: 'decision' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('📌 Cần quyết định: Cần xác nhận từ người dùng');

    // 3. System incidents should be sent
    eventBus.emit('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
    expect(execCalls).toHaveLength(2);
    expect(execCalls[1].args.at(-1)).toContain('Ổ đĩa còn 1 GB');

    // 4. All profiles quota exhausted is a system incident and should be notified
    quotaMarkRepo.mark('chinh', 'claude', Math.floor(Date.now() / 1000) + 3600);
    eventBus.emit('quota.exhausted', undefined, { profile: 'chinh', family: 'claude' });
    expect(execCalls).toHaveLength(3);
    expect(execCalls[2].args.at(-1)).toBe('AgentHub: Mọi tài khoản đều đã hết quota');

    notifier.stop();
  });

  it('during quiet hours, defers non-incident notifications and sends only incidents', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };

    // 23:30 is in quiet hours
    const mockNightTime = new Date();
    mockNightTime.setHours(23, 30, 0, 0);
    const currentMockTime = mockNightTime.getTime();

    const notifier = new NotificationService({
      eventBus,
      config,
      taskRepo,
      profileRepo,
      quotaMarkRepo,
      exec: fakeExec,
      now: () => currentMockTime,
    });
    notifier.start();

    // 1. Normal/info notifications should be queued into quietHoursQueue and not sent to exec
    eventBus.emit('brain.notify', undefined, { text: 'Bản cập nhật thường', level: 'info' });
    eventBus.emit('task.review_ready', 'task-1', { title: 'T1' });
    expect(execCalls).toHaveLength(0);
    expect(notifier.getQuietHoursQueue()).toHaveLength(2);

    // 2. Incident notification should bypass quiet hours and be sent immediately
    eventBus.emit('brain.notify', undefined, { text: 'Sự cố khẩn cấp', level: 'incident' });
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('🚨 Sự cố AgentHub: Sự cố khẩn cấp');

    // 3. Disk low is an incident and should bypass quiet hours
    eventBus.emit('disk.low', undefined, { freeGB: 0.5, minFreeGB: 3 });
    expect(execCalls).toHaveLength(2);

    // 4. Flush quiet hours queue returns the accumulated items
    const flushed = notifier.flushQuietHoursQueue();
    expect(flushed).toHaveLength(2);
    expect(notifier.getQuietHoursQueue()).toHaveLength(0);

    notifier.stop();
  });

  it('caps quietHoursQueue at 200 items, dropping oldest', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };
    const mockNightTime = new Date();
    mockNightTime.setHours(23, 0, 0, 0);

    const notifier = new NotificationService({
      eventBus,
      config,
      exec: fakeExec,
      now: () => mockNightTime.getTime(),
    });
    notifier.start();

    for (let i = 1; i <= 250; i++) {
      eventBus.emit('brain.notify', undefined, { text: `Notice ${i}`, level: 'info' });
    }

    const queue = notifier.getQuietHoursQueue();
    expect(queue).toHaveLength(200);
    expect((queue[0].payload as { text: string }).text).toBe('Notice 51');
    expect((queue[199].payload as { text: string }).text).toBe('Notice 250');

    notifier.stop();
  });

  it('when quiet hours end, sends grouped summary "N thông báo trong đêm" and flushes queue', () => {
    config.notifications.quietHours = {
      enabled: true,
      start: '22:00',
      end: '07:00',
    };
    let mockTime = new Date();
    mockTime.setHours(23, 0, 0, 0);

    const notifier = new NotificationService({
      eventBus,
      config,
      exec: fakeExec,
      now: () => mockTime.getTime(),
    });
    notifier.start();

    // Accumulate 3 notifications in the night
    eventBus.emit('brain.notify', undefined, { text: 'N1', level: 'info' });
    eventBus.emit('brain.notify', undefined, { text: 'N2', level: 'info' });
    eventBus.emit('brain.notify', undefined, { text: 'N3', level: 'info' });
    expect(execCalls).toHaveLength(0);
    expect(notifier.getQuietHoursQueue()).toHaveLength(3);

    // Advance time to 07:00 (quiet hours end)
    mockTime = new Date();
    mockTime.setHours(7, 0, 0, 0);

    // Calling checkQuietHoursEnd triggers the flush
    const flushed = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushed).toBe(true);
    expect(execCalls).toHaveLength(1);
    expect(execCalls[0].args.at(-1)).toBe('AgentHub: 3 thông báo trong đêm');
    expect(notifier.getQuietHoursQueue()).toHaveLength(0);

    // Subsequent call does not duplicate
    const flushedAgain = notifier.checkQuietHoursEnd(mockTime.getTime());
    expect(flushedAgain).toBe(false);
    expect(execCalls).toHaveLength(1);

    notifier.stop();
  });
});
