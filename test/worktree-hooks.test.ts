import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { WorktreeService } from '../src/worktrees/index.js';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

import { AgentHubConfig } from '../src/config.js';

describe('Worktree Cleanup Hooks', () => {
  let tmpDir: string;
  let worktreesDir: string;
  let projectPath: string;
  let service: WorktreeService;
  let emittedEvents: Array<{ type: string; taskId?: string; payload?: Record<string, unknown> }>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-wt-hooks-test-'));
    worktreesDir = path.join(tmpDir, 'worktrees');
    projectPath = path.join(tmpDir, 'project');

    fs.mkdirSync(worktreesDir, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });

    // Initialize git repo for project
    execFileSync('git', ['init'], { cwd: projectPath });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: projectPath });
    fs.writeFileSync(path.join(projectPath, 'README.md'), '# Project');
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

    emittedEvents = [];
    const eventBus = {
      emit: (type: string, taskId?: string, payload?: unknown) => {
        emittedEvents.push({ type, taskId, payload: payload as Record<string, unknown> });
        return true;
      },
    };

    service = new WorktreeService(
      { worktreesDir, hubHome: tmpDir } as unknown as AgentHubConfig,
      eventBus,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('hook được gọi đúng biến ({slot}, {slug}, {slug_underscored}, {worktree}, {project})', () => {
    const slug = 't-migrate-db';
    const worktreePath = path.join(worktreesDir, 'myproject', slug);
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', `agenthub/${slug}`, 'main']);
    expect(fs.existsSync(worktreePath)).toBe(true);

    const outputFile = path.join(projectPath, 'hook-result.txt');
    const command = `echo "slot={slot} slug={slug} slug_u={slug_underscored} wt={worktree} proj={project}" > "${outputFile}"`;

    const removed = service.remove(projectPath, worktreePath, {
      slot: 3,
      slug,
      projectId: 'myproject',
      taskId: 'myproject/t-migrate-db',
      hooks: {
        onWorktreeRemoved: [command],
      },
    });

    expect(removed).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Verify command was run with cwd = projectPath and variables replaced correctly
    expect(fs.existsSync(outputFile)).toBe(true);
    const content = fs.readFileSync(outputFile, 'utf8').trim();
    expect(content).toBe(`slot=3 slug=t-migrate-db slug_u=t_migrate_db wt=${worktreePath} proj=myproject`);

    // Verify event was emitted
    const hookEvents = emittedEvents.filter((e) => e.type === 'worktree.hook');
    expect(hookEvents.length).toBe(1);
    expect(hookEvents[0].taskId).toBe('myproject/t-migrate-db');
    expect(hookEvents[0].payload.ok).toBe(true);
    expect(hookEvents[0].payload.exitCode).toBe(0);
    expect(hookEvents[0].payload.cmd).toContain('slug=t-migrate-db');
    expect(hookEvents[0].payload.cmd).toContain('slug_u=t_migrate_db');
  });

  it('slug có ký tự lạ → từ chối chạy hook', () => {
    const validWorktree = path.join(worktreesDir, 'myproject', 'valid-slug');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', validWorktree, '-b', 'agenthub/valid-slug', 'main']);

    const probeFile = path.join(projectPath, 'should-not-exist.txt');
    const maliciousCommand = `touch "${probeFile}"`;

    const invalidSlugs = [
      't;rm -rf /',
      'slug&evil',
      'slug|pipe',
      'slug$VAR',
      'slug`whoami`',
      'invalid/path',
      'slug with spaces',
      'SLUG_UPPERCASE_ONLY', // [a-z0-9_-] only allows lowercase a-z
    ];

    for (const badSlug of invalidSlugs) {
      emittedEvents = [];
      const testWorktree = path.join(worktreesDir, 'myproject', `wt-${Math.random().toString(36).slice(2)}`);
      fs.mkdirSync(testWorktree, { recursive: true });

      const removed = service.remove(projectPath, testWorktree, {
        slug: badSlug,
        projectId: 'myproject',
        hooks: {
          onWorktreeRemoved: [maliciousCommand],
        },
      });

      expect(removed).toBe(true);
      expect(fs.existsSync(testWorktree)).toBe(false);

      // Hook must NOT execute
      expect(fs.existsSync(probeFile)).toBe(false);

      // Event must record rejection
      const hookEvents = emittedEvents.filter((e) => e.type === 'worktree.hook');
      expect(hookEvents.length).toBe(1);
      expect(hookEvents[0].payload.ok).toBe(false);
      expect(hookEvents[0].payload.error).toContain('contains invalid characters');
    }
  });

  it('lỗi hook không chặn remove worktree', () => {
    const slug = 't-failing-hook';
    const worktreePath = path.join(worktreesDir, 'myproject', slug);
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', `agenthub/${slug}`, 'main']);
    expect(fs.existsSync(worktreePath)).toBe(true);

    const markerAfterFail = path.join(projectPath, 'ran-after-fail.txt');

    const removed = service.remove(projectPath, worktreePath, {
      slot: 1,
      slug,
      projectId: 'myproject',
      taskId: 'myproject/t-failing-hook',
      hooks: {
        onWorktreeRemoved: [
          'sh -c "exit 42"', // failing command
          `touch "${markerAfterFail}"`, // next command should still run
        ],
      },
    });

    // Worktree must still be removed and remove() returns true
    expect(removed).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);

    // Second command still ran despite first failing
    expect(fs.existsSync(markerAfterFail)).toBe(true);

    // Events recorded for both
    const hookEvents = emittedEvents.filter((e) => e.type === 'worktree.hook');
    expect(hookEvents.length).toBe(2);
    expect(hookEvents[0].payload.ok).toBe(false);
    expect(hookEvents[0].payload.exitCode).toBe(42);
    expect(hookEvents[1].payload.ok).toBe(true);
    expect(hookEvents[1].payload.exitCode).toBe(0);
  });

  it('tích hợp deleteWorktree API thực thi hooks', () => {
    const config = loadConfig(tmpDir);
    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    const ctx = createContext(config, engines);
    ctx.scheduler.stop();

    const probeFile = path.join(projectPath, 'api-deleted.txt');

    ctx.projectRepo.insert({
      id: 'proj',
      name: 'Project',
      path: projectPath,
      defaultBranch: 'main',
      maxParallel: 2,
      hooks: JSON.stringify({
        onWorktreeRemoved: [`echo "{slug_underscored}" > "${probeFile}"`],
      }),
    });

    const worktreePath = path.join(config.worktreesDir, 'proj', 'task-api');
    execFileSync('git', ['-C', projectPath, 'worktree', 'add', worktreePath, '-b', 'agenthub/task-api', 'main']);

    ctx.taskRepo.insert({
      id: 'proj/task-api',
      projectId: 'proj',
      slug: 'task-api',
      title: 'Task API',
      status: 'done',
      level: 'easy',
    });
    ctx.taskRepo.update('proj/task-api', { worktreePath, slot: 2 });

    const result = ctx.service.deleteWorktree('proj/task-api');
    expect(result.ok).toBe(true);
    expect(fs.existsSync(worktreePath)).toBe(false);
    expect(fs.existsSync(probeFile)).toBe(true);
    expect(fs.readFileSync(probeFile, 'utf8').trim()).toBe('task_api');

    // Check event recorded in db events table
    const events = ctx.eventRepo.getByTask('proj/task-api');
    const hookEvent = events.find((e) => e.type === 'worktree.hook');
    expect(hookEvent).toBeDefined();

    ctx.db.close();
  });
});
