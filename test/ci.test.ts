import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { openDatabase, ProjectRepo, CiRepo, EventRepo, ProfileRepo, QuotaMarkRepo, TaskRepo, BrainTurnRepo, ChatSessionRepo } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';
import { parseGitHubRemote, CiWatchService, type GitHubRunItem, type GitHubJob, type GitHubJobAnnotation } from '../src/ci.js';
import { NotificationService } from '../src/notify.js';
import { TelegramBotService } from '../src/telegram.js';
import { BrainRunner } from '../src/brain/runner.js';

describe('GitHub Actions CI Watch (p-ci-watch)', () => {
  let tmpDir: string;
  let db: ReturnType<typeof openDatabase>;
  let projectRepo: ProjectRepo;
  let ciRepo: CiRepo;
  let eventRepo: EventRepo;
  let eventBus: EventBus;
  let profileRepo: ProfileRepo;
  let quotaMarkRepo: QuotaMarkRepo;
  let taskRepo: TaskRepo;
  let config: ReturnType<typeof loadConfig>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ci-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    config = loadConfig(tmpDir);

    db = openDatabase(config.dbPath);
    projectRepo = new ProjectRepo(db);
    ciRepo = new CiRepo(db);
    eventRepo = new EventRepo(db);
    eventBus = new EventBus(eventRepo);
    profileRepo = new ProfileRepo(db);
    quotaMarkRepo = new QuotaMarkRepo(db);
    taskRepo = new TaskRepo(db);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.GITHUB_TOKEN;
  });

  describe('parseGitHubRemote', () => {
    it('parses HTTPS URLs', () => {
      expect(parseGitHubRemote('https://github.com/my-org/my-repo.git')).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
      });
      expect(parseGitHubRemote('https://github.com/my-org/my-repo/')).toEqual({
        owner: 'my-org',
        repo: 'my-repo',
      });
    });

    it('parses SSH URLs', () => {
      expect(parseGitHubRemote('git@github.com:owner/repo.git')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
      expect(parseGitHubRemote('ssh://git@github.com/owner/repo')).toEqual({
        owner: 'owner',
        repo: 'repo',
      });
    });

    it('parses HTTPS URLs with credentials', () => {
      expect(parseGitHubRemote('https://x-access-token:ghs_secret@github.com/corp/project.git')).toEqual({
        owner: 'corp',
        repo: 'project',
      });
    });

    it('returns null for non-GitHub URLs or invalid input', () => {
      expect(parseGitHubRemote('https://gitlab.com/owner/repo.git')).toBeNull();
      expect(parseGitHubRemote('git@bitbucket.org:owner/repo.git')).toBeNull();
      expect(parseGitHubRemote('not-a-url')).toBeNull();
      expect(parseGitHubRemote('')).toBeNull();
      expect(parseGitHubRemote(null)).toBeNull();
      expect(parseGitHubRemote(undefined)).toBeNull();
    });
  });

  describe('CiWatchService configuration resolution', () => {
    it('defaults enabled to true when GitHub remote is detected and not explicitly disabled', async () => {
      projectRepo.insert({
        id: 'proj1',
        name: 'Project 1',
        path: '/tmp/proj1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        getGitRemoteUrl: async () => 'https://github.com/example/repo.git',
      });

      const project = projectRepo.get('proj1')!;
      const ciConfig = await service.getProjectCiConfig(project);
      expect(ciConfig.enabled).toBe(true);
      expect(ciConfig.branch).toBe('main');
      expect(ciConfig.remote).toEqual({ owner: 'example', repo: 'repo' });
    });

    it('respects ci.enabled=false in project settings', async () => {
      projectRepo.insert({
        id: 'proj2',
        name: 'Project 2',
        path: '/tmp/proj2',
        defaultBranch: 'develop',
        envTemplate: null,
        maxParallel: 2,
        settings: JSON.stringify({ ci: { enabled: false } }),
      });

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        getGitRemoteUrl: async () => 'https://github.com/example/repo.git',
      });

      const project = projectRepo.get('proj2')!;
      const ciConfig = await service.getProjectCiConfig(project);
      expect(ciConfig.enabled).toBe(false);
      expect(ciConfig.branch).toBe('develop');
    });

    it('respects custom branch in project settings', async () => {
      projectRepo.insert({
        id: 'proj3',
        name: 'Project 3',
        path: '/tmp/proj3',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        settings: JSON.stringify({ ci: { branch: 'staging' } }),
      });

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        getGitRemoteUrl: async () => 'https://github.com/example/repo.git',
      });

      const project = projectRepo.get('proj3')!;
      const ciConfig = await service.getProjectCiConfig(project);
      expect(ciConfig.enabled).toBe(true);
      expect(ciConfig.branch).toBe('staging');
    });

    it('returns enabled=false when remote is not GitHub', async () => {
      projectRepo.insert({
        id: 'proj4',
        name: 'Project 4',
        path: '/tmp/proj4',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        getGitRemoteUrl: async () => 'https://gitlab.com/example/repo.git',
      });

      const project = projectRepo.get('proj4')!;
      const ciConfig = await service.getProjectCiConfig(project);
      expect(ciConfig.enabled).toBe(false);
      expect(ciConfig.remote).toBeNull();
    });
  });

  describe('Polling and Event Emission', () => {
    it('handles completed success run and emits ci.passed', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      const events: Array<{ type: string; payload: unknown }> = [];
      eventBus.on('*', (type, taskId, payload) => {
        events.push({ type, payload });
      });

      const runItem: GitHubRunItem = {
        id: 101,
        name: 'CI Workflow',
        head_sha: 'abcdef1234567890',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/org/repo/actions/runs/101',
        updated_at: '2026-10-21T10:00:00Z',
        created_at: '2026-10-21T09:50:00Z',
      };

      const mockFetch: typeof fetch = async (url) => {
        expect(String(url)).toContain('/repos/org/repo/actions/runs');
        return new Response(JSON.stringify({ workflow_runs: [runItem] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            etag: '"etag-101"',
          },
        });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
      });

      await service.pollProject('p1');

      // Verify db insertion
      const saved = ciRepo.get('p1', 101);
      expect(saved).toBeDefined();
      expect(saved?.conclusion).toBe('success');
      expect(saved?.workflow).toBe('CI Workflow');

      // Verify event
      const passed = events.find((e) => e.type === 'ci.passed');
      expect(passed).toBeDefined();
      const passedPayload = passed?.payload as Record<string, unknown>;
      expect(passedPayload.recoveredFromFailure).toBe(false);
      expect(passedPayload.runId).toBe(101);
    });

    it('emits ci.passed with recoveredFromFailure=true on red-to-green transition', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      // Pre-insert an earlier failed run
      ciRepo.insert({
        projectId: 'p1',
        runId: 100,
        workflow: 'CI Workflow',
        sha: '1111111',
        status: 'completed',
        conclusion: 'failure',
        jobs: '[]',
        completedAt: '2026-10-21T09:00:00Z',
        url: 'https://github.com/org/repo/actions/runs/100',
      });

      const events: Array<{ type: string; payload: unknown }> = [];
      eventBus.on('*', (type, taskId, payload) => {
        events.push({ type, payload });
      });

      const runItem: GitHubRunItem = {
        id: 102,
        name: 'CI Workflow',
        head_sha: '2222222',
        status: 'completed',
        conclusion: 'success',
        html_url: 'https://github.com/org/repo/actions/runs/102',
        updated_at: '2026-10-21T10:00:00Z',
        created_at: '2026-10-21T09:50:00Z',
      };

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ workflow_runs: [runItem] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
      });

      await service.pollProject('p1');

      const passed = events.find((e) => e.type === 'ci.passed');
      expect(passed).toBeDefined();
      const passedPayload = passed?.payload as Record<string, unknown>;
      expect(passedPayload.recoveredFromFailure).toBe(true);
      expect(passedPayload.previousConclusion).toBe('failure');
    });

    it('handles failed run: fetches jobs and annotations, and emits ci.failed once', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      const events: Array<{ type: string; payload: unknown }> = [];
      eventBus.on('*', (type, taskId, payload) => {
        events.push({ type, payload });
      });

      const runItem: GitHubRunItem = {
        id: 201,
        name: 'Test Workflow',
        head_sha: 'deadbeef1234',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/org/repo/actions/runs/201',
        updated_at: '2026-10-21T11:00:00Z',
        created_at: '2026-10-21T10:55:00Z',
      };

      const jobItem: GitHubJob = {
        id: 501,
        name: 'unit-test',
        status: 'completed',
        conclusion: 'failure',
        html_url: 'https://github.com/org/repo/actions/runs/201/job/501',
      };

      const annotations: GitHubJobAnnotation[] = [
        {
          path: 'src/ci.ts',
          start_line: 42,
          end_line: 42,
          annotation_level: 'failure',
          message: 'SyntaxError: unexpected token',
          title: 'Syntax Error in ci.ts',
        },
      ];

      const mockFetch: typeof fetch = async (url) => {
        const urlStr = String(url);
        if (urlStr.includes('/actions/runs?')) {
          return new Response(JSON.stringify({ workflow_runs: [runItem] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes('/runs/201/jobs')) {
          return new Response(JSON.stringify({ jobs: [jobItem] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (urlStr.includes('/check-runs/501/annotations')) {
          return new Response(JSON.stringify(annotations), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('Not found', { status: 404 });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
      });

      await service.pollProject('p1');

      // Verify ci_runs stored
      const saved = ciRepo.get('p1', 201);
      expect(saved).toBeDefined();
      expect(saved?.conclusion).toBe('failure');
      const savedJobs = JSON.parse(saved?.jobs || '[]');
      expect(savedJobs.length).toBe(1);
      expect(savedJobs[0].annotations.length).toBe(1);
      expect(savedJobs[0].annotations[0].message).toBe('SyntaxError: unexpected token');

      // Verify event
      const failed = events.find((e) => e.type === 'ci.failed');
      expect(failed).toBeDefined();
      const payload = failed?.payload as Record<string, unknown> & {
        runId: number;
        jobs: GitHubJob[];
        annotations: GitHubJobAnnotation[];
      };
      expect(payload.runId).toBe(201);
      expect(payload.jobs.length).toBe(1);
      expect(payload.annotations.length).toBe(1);
      expect(payload.annotations[0].title).toBe('Syntax Error in ci.ts');

      // Poll again: should ignore already stored run and not emit second event
      events.length = 0;
      await service.pollProject('p1');
      expect(events.length).toBe(0);
    });

    it('respects ETag and handles HTTP 304 Not Modified', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      let requestCount = 0;
      let sentIfNoneMatch: string | null = null;

      const mockFetch: typeof fetch = async (_url, init) => {
        requestCount++;
        const headers = new Headers(init?.headers);
        sentIfNoneMatch = headers.get('if-none-match');

        if (requestCount === 1) {
          return new Response(JSON.stringify({ workflow_runs: [] }), {
            status: 200,
            headers: {
              'content-type': 'application/json',
              etag: 'W/"etag-abc"',
            },
          });
        }
        return new Response(null, { status: 304 });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
      });

      await service.pollProject('p1');
      expect(requestCount).toBe(1);
      expect(sentIfNoneMatch).toBeNull();

      // Second poll sends ETag
      await service.pollProject('p1');
      expect(requestCount).toBe(2);
      expect(sentIfNoneMatch).toBe('W/"etag-abc"');
    });

    it('respects rate limit headers and pauses polling when limit is reached', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      let fetchCalled = false;
      let mockNow = 1000000;

      const mockFetch: typeof fetch = async () => {
        fetchCalled = true;
        return new Response(JSON.stringify({ workflow_runs: [] }), {
          status: 200,
          headers: {
            'content-type': 'application/json',
            'x-ratelimit-remaining': '0',
            'x-ratelimit-reset': String(Math.floor(mockNow / 1000) + 3600), // 1 hour later
          },
        });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
        now: () => mockNow,
      });

      // First call hits API and parses rate limit
      await service.pollProject('p1');
      expect(fetchCalled).toBe(true);

      const state = service.getRateLimitState();
      expect(state.remaining).toBe(0);

      // Second call before reset should be aborted before fetch
      fetchCalled = false;
      await service.pollProject('p1');
      expect(fetchCalled).toBe(false);

      // Advance time past reset -> polling resumes
      mockNow += 3601 * 1000;
      await service.pollProject('p1');
      expect(fetchCalled).toBe(true);
    });

    it('adjusts polling interval based on active runs', async () => {
      projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: '/tmp/p1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      let mockNow = 10_000_000;
      let runsToReturn: GitHubRunItem[] = [];

      const mockFetch: typeof fetch = async () => {
        return new Response(JSON.stringify({ workflow_runs: runsToReturn }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };

      const service = new CiWatchService({
        config,
        projectRepo,
        ciRepo,
        eventBus,
        fetchFn: mockFetch,
        getGitRemoteUrl: async () => 'https://github.com/org/repo.git',
        now: () => mockNow,
      });

      // Initial poll with idle runs
      runsToReturn = [
        {
          id: 1,
          name: 'CI',
          head_sha: 'abc',
          status: 'completed',
          conclusion: 'success',
          html_url: '',
          updated_at: '',
          created_at: '',
        },
      ];
      const res1 = await service.pollProjectIfDue(projectRepo.get('p1')!);
      expect(res1).toBeDefined();

      // At 5 minutes later: idle interval is 15 min -> not due
      mockNow += 5 * 60 * 1000;
      const res2 = await service.pollProjectIfDue(projectRepo.get('p1')!);
      expect(res2).toBeNull();

      // Now set active run (in_progress)
      runsToReturn = [
        {
          id: 2,
          name: 'CI',
          head_sha: 'def',
          status: 'in_progress',
          conclusion: null,
          html_url: '',
          updated_at: '',
          created_at: '',
        },
      ];
      // Force poll to set active run state
      await service.pollProject('p1');

      // 4 minutes later (> 3 min active interval) -> is due
      mockNow += 4 * 60 * 1000;
      const res3 = await service.pollProjectIfDue(projectRepo.get('p1')!);
      // It polled because interval was 3 min
      expect(res3).toBeNull(); // in_progress run is not completed so nothing new saved
    });
  });

  describe('NotificationService CI integration', () => {
    it('throttles ci.failed notifications to max 1 per workflow per hour per project', () => {
      let nowTime = 10_000_000;
      const execCalls: Array<{ file: string; args: string[] }> = [];

      const notifyService = new NotificationService({
        config,
        profileRepo,
        quotaMarkRepo,
        taskRepo,
        eventBus,
        now: () => nowTime,
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      });
      notifyService.start();

      // Emit first ci.failed
      eventBus.emit('ci.failed', 'projA', {
        projectId: 'projA',
        workflow: 'Build & Test',
        sha: 'abcdef123456',
        jobs: [{ name: 'lint' }],
      });

      expect(execCalls.length).toBe(1);
      expect(execCalls[0].args.at(-1)).toContain('CI thất bại [projA]: Build & Test @ abcdef1 (lint)');

      // Immediate second emit for same project and workflow should be throttled
      eventBus.emit('ci.failed', 'projA', {
        projectId: 'projA',
        workflow: 'Build & Test',
        sha: 'abcdef123456',
        jobs: [{ name: 'lint' }],
      });
      expect(execCalls.length).toBe(1);

      // Different workflow on same project should not be throttled
      eventBus.emit('ci.failed', 'projA', {
        projectId: 'projA',
        workflow: 'E2E Tests',
        sha: 'abcdef123456',
        jobs: [],
      });
      expect(execCalls.length).toBe(2);

      // After 1 hour, original workflow is notified again
      nowTime += 3601 * 1000;
      eventBus.emit('ci.failed', 'projA', {
        projectId: 'projA',
        workflow: 'Build & Test',
        sha: 'abcdef123456',
        jobs: [{ name: 'lint' }],
      });
      expect(execCalls.length).toBe(3);

      notifyService.stop();
    });

    it('only notifies ci.passed when recovering from red', () => {
      const execCalls: Array<{ file: string; args: string[] }> = [];

      const notifyService = new NotificationService({
        config,
        profileRepo,
        quotaMarkRepo,
        taskRepo,
        eventBus,
        now: () => 10_000_000,
        exec: (file, args) => {
          execCalls.push({ file, args });
        },
      });
      notifyService.start();

      // Regular pass (not recovering from failure) -> no notification
      eventBus.emit('ci.passed', 'projA', {
        projectId: 'projA',
        workflow: 'Build',
        recoveredFromFailure: false,
        previousConclusion: 'success',
      });
      expect(execCalls.length).toBe(0);

      // Recovery pass -> notifies green
      eventBus.emit('ci.passed', 'projA', {
        projectId: 'projA',
        workflow: 'Build',
        sha: '7654321',
        recoveredFromFailure: true,
        previousConclusion: 'failure',
      });
      expect(execCalls.length).toBe(1);
      expect(execCalls[0].args.at(-1)).toContain('CI đã xanh: [projA] Build @ 7654321');

      notifyService.stop();
    });
  });

  describe('Telegram /ci Command', () => {
    it('renders project CI status with /ci command', async () => {
      projectRepo.insert({
        id: 'web-app',
        name: 'Web Application',
        path: '/tmp/web-app',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      // Insert latest run with failed job & annotation
      ciRepo.insert({
        projectId: 'web-app',
        runId: 999,
        workflow: 'CI Pipeline',
        sha: 'fedcba987654',
        status: 'completed',
        conclusion: 'failure',
        jobs: JSON.stringify([
          {
            name: 'build',
            conclusion: 'failure',
            annotations: [
              {
                path: 'src/index.ts',
                start_line: 10,
                message: 'Cannot find module ./missing',
              },
            ],
          },
        ]),
        completedAt: '2026-10-21T12:00:00Z',
        url: 'https://github.com/org/repo/actions/runs/999',
      });

      const sentBodies: Array<{
        text: string;
        reply_markup?: { inline_keyboard: Array<Array<{ text: string; url?: string }>> };
      }> = [];
      const fakeFetch: typeof fetch = async (_url, init) => {
        if (init?.body) {
          sentBodies.push(JSON.parse(String(init.body)));
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const telegramService = new TelegramBotService({
        config: {
          ...config,
          telegram: {
            ...config.telegram,
            enabled: true,
            allowedChatIds: [12345],
          },
        },
        projectRepo,
        ciRepo,
        tokenOverride: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        fetch: fakeFetch,
        sleep: async () => {},
      });

      // Execute /ci web-app
      await (
        telegramService as unknown as { handleCiCommand: (chatId: number, arg: string) => Promise<void> }
      ).handleCiCommand(12345, 'web-app');

      expect(sentBodies.length).toBe(1);
      const msg = sentBodies[0].text;
      expect(msg).toContain('Web Application');
      expect(msg).toContain('CI Pipeline');
      expect(msg).toContain('Thất bại');
      expect(msg).toContain('fedcba9');
      expect(msg).toContain('<b>build</b>');
      expect(msg).toContain('src/index.ts:10');
      expect(msg).toContain('Cannot find module ./missing');
      expect(sentBodies[0].reply_markup?.inline_keyboard?.[0]?.[0]?.url).toBe(
        'https://github.com/org/repo/actions/runs/999',
      );
    });

    it('lists all projects CI status when /ci has no argument', async () => {
      projectRepo.insert({
        id: 'proj1',
        name: 'Project One',
        path: '/tmp/proj1',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
      });

      ciRepo.insert({
        projectId: 'proj1',
        runId: 1,
        workflow: 'Build',
        sha: '1111111',
        status: 'completed',
        conclusion: 'success',
        jobs: '[]',
        completedAt: '2026-10-21T12:00:00Z',
        url: 'https://github.com/org/repo/actions/runs/1',
      });

      const sentBodies: Array<{
        text: string;
        reply_markup?: { inline_keyboard: Array<Array<{ text: string; url?: string }>> };
      }> = [];
      const fakeFetch: typeof fetch = async (_url, init) => {
        if (init?.body) {
          sentBodies.push(JSON.parse(String(init.body)));
        }
        return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      };

      const telegramService = new TelegramBotService({
        config: {
          ...config,
          telegram: {
            ...config.telegram,
            enabled: true,
            allowedChatIds: [12345],
          },
        },
        projectRepo,
        ciRepo,
        tokenOverride: '123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11',
        fetch: fakeFetch,
        sleep: async () => {},
      });

      await (
        telegramService as unknown as { handleCiCommand: (chatId: number, arg: string) => Promise<void> }
      ).handleCiCommand(12345, '');

      expect(sentBodies.length).toBe(1);
      const msg = sentBodies[0].text;
      expect(msg).toContain('Trạng thái CI các dự án:');
      expect(msg).toContain('Project One');
      expect(msg).toContain('Thành công (Build @ 1111111)');
    });
  });

  describe('BrainRunner routing of ci.failed', () => {
    it('routes ci.failed event to project brain session', () => {
      projectRepo.insert({
        id: 'proj-brain',
        name: 'Brain Project',
        path: '/tmp/proj-brain',
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        settings: JSON.stringify({ brain: { mode: 'auto' } }),
      });

      const chatSessionRepo = new ChatSessionRepo(db);
      const turnRepo = new BrainTurnRepo(db);

      const dispatchedMessages: Array<{ sessionId: string; input: string }> = [];

      const runner = new BrainRunner({
        config: { ...config.brain, mode: 'auto' },
        eventBus,
        chatService: {
          getOrCreateSession: (
            id: string,
            opts?: {
              title?: string;
              mode?: 'safe' | 'full';
              kind?: 'chat' | 'brain';
              projectId?: string | null;
            },
          ) => {
            chatSessionRepo.insert({
              id,
              title: opts?.title || id,
              mode: opts?.mode || 'safe',
              model: 'claude-3-5-sonnet',
              profileName: 'default',
              kind: opts?.kind,
              projectId: opts?.projectId,
            });
            return chatSessionRepo.get(id)!;
          },
          sendMessage: (sessionId: string, input: string) => {
            dispatchedMessages.push({ sessionId, input });
          },
        },
        chatSessionRepo,
        turnRepo,
        projectRepo,
        now: () => 10_000_000,
      });

      runner.start();

      eventBus.emit('ci.failed', 'proj-brain', {
        projectId: 'proj-brain',
        workflow: 'CI Check',
        sha: 'abc1234',
        status: 'completed',
        conclusion: 'failure',
        jobs: [{ name: 'test' }],
        annotations: [{ message: 'AssertionError: expected true to be false' }],
      });

      runner.flush();

      expect(dispatchedMessages.length).toBe(1);
      expect(dispatchedMessages[0].sessionId).toBe('brain:proj-brain');
      expect(dispatchedMessages[0].input).toContain('ci.failed');
      expect(dispatchedMessages[0].input).toContain('AssertionError');

      runner.stop();
    });
  });
});
