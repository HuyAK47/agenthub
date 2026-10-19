import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { loadConfig, saveConfig, updateConfigInMemory } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('Stall & Looping Detection (g-no-commit-watch)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let fakeEngine: FakeEngine;
  let projectPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-stall-watch-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    projectPath = path.join(tmpDir, 'repo');
    fs.mkdirSync(projectPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Main Repo');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'initial commit', '--allow-empty'], {
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
      id: 'p-test',
      name: 'Project Test',
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

  it('1. Config stall: giá trị mặc định là 45 phút và 6 lần lặp, lưu và cập nhật đúng', () => {
    expect(config.stall.noCommitMin).toBe(45);
    expect(config.stall.loopThreshold).toBe(6);

    updateConfigInMemory(config, {
      stall: { noCommitMin: 30, loopThreshold: 5 },
    });
    expect(config.stall.noCommitMin).toBe(30);
    expect(config.stall.loopThreshold).toBe(5);

    saveConfig(tmpDir, {
      stall: { noCommitMin: 60, loopThreshold: 8 },
    });
    const reloaded = loadConfig(tmpDir);
    expect(reloaded.stall.noCommitMin).toBe(60);
    expect(reloaded.stall.loopThreshold).toBe(8);
  });

  it('2. Giả lập nhánh không commit: phát event task.no_commit sau ngưỡng, ghi nhắc nhở vào task.md và hiển thị trên API', async () => {
    const branchName = 'agenthub/t1';
    execFileSync('git', ['branch', branchName], { cwd: projectPath });

    const worktreePath = path.join(tmpDir, 'worktrees', 'p-test_t1');
    fs.mkdirSync(path.join(worktreePath, '.agenthub'), { recursive: true });
    const taskMdPath = path.join(worktreePath, '.agenthub', 'task.md');
    fs.writeFileSync(taskMdPath, '# Đề bài task\n\nLàm tính năng foo.', 'utf-8');

    const taskId = 'p-test/t1';
    ctx.taskRepo.insert({
      id: taskId,
      projectId: 'p-test',
      slug: 't1',
      title: 'Task Không Commit',
      status: 'running',
      baseRef: 'main',
      branch: branchName,
      worktreePath,
    });

    const now = Date.now();
    // Giả lập worker chạy từ 50 phút trước
    const startTime = now - 50 * 60 * 1000;
    const running = ctx.scheduler.getRunning();
    running.set(taskId, {
      runId: 'run-1',
      taskId,
      pid: 12345,
      pidStart: null,
      profileName: 'p1',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime,
      timeoutMs: 3600000,
      timeoutAt: startTime + 3600000,
      retryCount: 0,
      projectId: 'p-test',
      lastOutputAt: startTime,
      lastActivityAt: startTime,
      activitySource: 'log',
      activityCheckedAt: 0,
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
      lastCommitCheckAt: startTime,
    });

    // Chạy kiểm tra commit
    await ctx.scheduler.checkTaskCommits(taskId, undefined, now, true);

    // Kiểm tra event task.no_commit được phát
    const events = ctx.eventRepo.getByTask(taskId);
    const noCommitEvent = events.find((e) => e.type === 'task.no_commit');
    expect(noCommitEvent).toBeDefined();
    const payload = JSON.parse(noCommitEvent!.payload as string);
    expect(payload.minutes).toBe(50);
    expect(payload.commits).toBe(0);

    // Kiểm tra nội dung .agenthub/task.md được ghi thêm dòng nhắc nhở
    const taskMdContent = fs.readFileSync(taskMdPath, 'utf-8');
    expect(taskMdContent).toContain('Hãy commit phần đã xong và thu hẹp phạm vi.');

    // Kiểm tra API getTask và getStatus trả về noCommitMinutes
    const taskData = await ctx.service.getTask(taskId);
    expect(taskData.currentRun?.noCommitMinutes).toBe(50);

    const statusData = ctx.service.getStatus();
    const worker = statusData.running.find((w) => w.taskId === taskId);
    expect(worker?.noCommitMinutes).toBe(50);

    // Kiểm tra 1 lần mỗi ngưỡng: ở phút 55 (vẫn trong ngưỡng tier 1: 55/45 = 1), không phát thêm event
    const eventsBefore = ctx.eventRepo.getByTask(taskId).length;
    await ctx.scheduler.checkTaskCommits(taskId, undefined, now + 5 * 60 * 1000, true);
    const eventsAfter = ctx.eventRepo.getByTask(taskId).length;
    expect(eventsAfter).toBe(eventsBefore);

    // Giả lập commit mới trên nhánh
    execFileSync('git', ['checkout', branchName], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'work.txt'), 'done part 1');
    execFileSync('git', ['add', '.'], { cwd: projectPath });
    execFileSync('git', ['commit', '-m', 'feat: part 1'], {
      cwd: projectPath,
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 'test',
        GIT_AUTHOR_EMAIL: 'test@test.com',
        GIT_COMMITTER_NAME: 'test',
        GIT_COMMITTER_EMAIL: 'test@test.com',
      },
    });

    // Chạy lại kiểm tra commit sau khi vừa commit (now + 6 * 60 * 1000)
    await ctx.scheduler.checkTaskCommits(taskId, undefined, now + 6 * 60 * 1000, true);
    const rt = ctx.scheduler.getRunning().get(taskId);
    expect(rt?.noCommitMinutes).toBeUndefined();

    const taskDataAfterCommit = await ctx.service.getTask(taskId);
    expect(taskDataAfterCommit.currentRun?.noCommitMinutes).toBeNull();
  });

  it('3. Giả lập log lặp lệnh: phát hiện cùng một lệnh playwright test / pnpm test:ui chạy > 6 lần trong 30 phút → event task.looping, không kill task', async () => {
    const taskId = 'p-test/t2';
    ctx.taskRepo.insert({
      id: taskId,
      projectId: 'p-test',
      slug: 't2',
      title: 'Task Lặp Lệnh',
      status: 'running',
    });

    const runId = 'run-loop-1';
    const logDir = path.join(tmpDir, 'logs', 'p-test_t2');
    fs.mkdirSync(logDir, { recursive: true });
    const logPath = path.join(logDir, `${runId}.log`);

    ctx.runRepo.insert({
      id: runId,
      taskId,
      engine: 'agy',
      model: 'gemini-3.8-flash-high',
      profileName: 'p1',
      logPath,
    });

    const now = Date.now();
    const running = ctx.scheduler.getRunning();
    running.set(taskId, {
      runId,
      taskId,
      pid: 23456,
      pidStart: null,
      profileName: 'p1',
      model: 'gemini-3.8-flash-high',
      engine: fakeEngine,
      startTime: now - 20 * 60 * 1000,
      timeoutMs: 3600000,
      timeoutAt: now + 3600000,
      retryCount: 0,
      projectId: 'p-test',
      lastOutputAt: now,
      lastActivityAt: now,
      activitySource: 'log',
      activityCheckedAt: 0,
      cachedConversationMtime: 0,
      cachedWorktreeMtime: 0,
      usageBefore: null,
    });

    // Ghi 7 lần lệnh `npx playwright test spec/auth.spec.ts` vào log
    const cmdLine = '$ npx playwright test spec/auth.spec.ts\noutput line\n';
    fs.writeFileSync(logPath, cmdLine.repeat(7), 'utf-8');

    // Chạy kiểm tra lặp lệnh
    ctx.scheduler.checkTaskLooping(taskId, undefined, now);

    // Kiểm tra event task.looping được phát
    const events = ctx.eventRepo.getByTask(taskId);
    const loopEvent = events.find((e) => e.type === 'task.looping');
    expect(loopEvent).toBeDefined();
    const payload = JSON.parse(loopEvent!.payload as string);
    expect(payload.command).toBe('npx playwright test spec/auth.spec.ts');
    expect(payload.count).toBe(7);

    // KHÔNG tự kill task: task vẫn ở trạng thái running
    expect(ctx.scheduler.getRunning().has(taskId)).toBe(true);
    const taskRow = ctx.taskRepo.get(taskId);
    expect(taskRow?.status).toBe('running');

    // Kiểm tra API trả về isLooping = true
    const taskData = await ctx.service.getTask(taskId);
    expect(taskData.currentRun?.isLooping).toBe(true);
    expect(taskData.currentRun?.loopingCommand).toBe('npx playwright test spec/auth.spec.ts');

    const statusData = ctx.service.getStatus();
    const worker = statusData.running.find((w) => w.taskId === taskId);
    expect(worker?.isLooping).toBe(true);

    // Kiểm tra không phát event lặp lại nếu vẫn đang ở trạng thái looping
    const countBefore = ctx.eventRepo.getByTask(taskId).length;
    ctx.scheduler.checkTaskLooping(taskId, undefined, now);
    const countAfter = ctx.eventRepo.getByTask(taskId).length;
    expect(countAfter).toBe(countBefore);

    // Khi 35 phút trôi qua (ngoài cửa sổ 30 phút), trạng thái looping được xóa
    ctx.scheduler.checkTaskLooping(taskId, undefined, now + 35 * 60 * 1000);
    const taskDataAfterWindow = await ctx.service.getTask(taskId);
    expect(taskDataAfterWindow.currentRun?.isLooping).toBe(false);
  });
});
