import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import { HttpError } from '../src/errors.js';
import { getIntegrationStatus } from '../src/projects/integration.js';

vi.mock('../src/projects/integration.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/projects/integration.js')>();
  return { ...actual, getIntegrationStatus: vi.fn(actual.getIntegrationStatus) };
});

describe('Integration branch and cross-project dependencies', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;

  function initGitRepo(repoPath: string, branch = 'main'): void {
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync('git', ['init'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: repoPath });
    execFileSync('git', ['config', 'user.name', 'AgentHub Test'], { cwd: repoPath });
    fs.writeFileSync(path.join(repoPath, 'README.md'), '# Initial Repo\n');
    execFileSync('git', ['add', '.'], { cwd: repoPath });
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoPath });
    execFileSync('git', ['checkout', '-B', branch], { cwd: repoPath });
  }

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-integration-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });

    const config = loadConfig(tmpDir);
    config.port = 0;
    const engines = new Map<string, Engine>([
      ['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))],
    ]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    const profileHome = path.join(tmpDir, 'profile-home');
    fs.mkdirSync(profileHome, { recursive: true });
    ctx.profileRepo.upsert({
      name: 'test-profile',
      engine: 'agy',
      kind: 'isolated',
      home: profileHome,
      email: null,
      enabled: 1,
    });
  });

  afterEach(() => {
    delete process.env.FAKE_MODE;
    ctx.scheduler.stop();
    ctx.scheduler.cancelAll();
    ctx.db.close();
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('cross-project dependency: task FE creates worktree from defaultBranch of FE, waits for BE, and deps.md records BE project/repo and diff summary', async () => {
    // The test simulates the BE worker finishing (commit + DONE below). Set before any task is
    // created: createTask(start: true) can trigger a tick that spawns the worker right away, and a
    // fake worker in 'done' mode would record its own DONE first.
    process.env.FAKE_MODE = 'sleep-loop';
    const beRepo = path.join(tmpDir, 'be-repo');
    const feRepo = path.join(tmpDir, 'fe-repo');
    initGitRepo(beRepo, 'main');
    initGitRepo(feRepo, 'main');

    ctx.service.createProject({
      id: 'be',
      name: 'Backend Project',
      path: beRepo,
      defaultBranch: 'main',
    });
    ctx.service.createProject({
      id: 'fe',
      name: 'Frontend Project',
      path: feRepo,
      defaultBranch: 'main',
    });

    // Create BE task
    ctx.service.createTask({
      project: 'be',
      slug: 'api-v1',
      title: 'BE API v1',
      body: 'Implement auth API endpoint',
      level: 'easy',
      start: true,
    });

    // Create FE task depending on BE task
    ctx.service.createTask({
      project: 'fe',
      slug: 'ui-v1',
      title: 'FE UI v1',
      body: 'Implement auth UI using BE API',
      level: 'easy',
      dependsOn: ['be/api-v1'],
      start: true,
    });

    // 1st tick: BE task should start, FE task must wait
    ctx.scheduler.tick();

    const beTask = ctx.taskRepo.get('be/api-v1')!;
    const feTask = ctx.taskRepo.get('fe/ui-v1')!;

    expect(beTask.status).toBe('running');
    expect(feTask.status).toBe('queued');

    // Simulate BE task completing: commit in worktree, write DONE, and diffStat
    const beWorktree = beTask.worktreePath!;
    fs.writeFileSync(path.join(beWorktree, 'auth-api.json'), JSON.stringify({ endpoint: '/api/v1/auth' }));
    execFileSync('git', ['-C', beWorktree, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', beWorktree, 'commit', '-m', 'Add auth API endpoint'], { encoding: 'utf8' });

    fs.mkdirSync(path.join(beWorktree, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(beWorktree, '.agenthub', 'DONE'), 'Tóm tắt: Đã tạo endpoint /api/v1/auth\nSố test: 5 pass');

    // Transition BE task to review and approve it
    ctx.taskRepo.update('be/api-v1', { status: 'review' });
    await ctx.service.reviewTask('be/api-v1', { verdict: 'approved', feedback: 'BE looks good' });
    expect(ctx.taskRepo.get('be/api-v1')!.status).toBe('done');

    // 2nd tick: FE task should now start
    ctx.scheduler.tick();

    const runningFeTask = ctx.taskRepo.get('fe/ui-v1')!;
    expect(runningFeTask.status).toBe('running');
    expect(runningFeTask.worktreePath).toBeDefined();

    // Verify FE worktree was created from FE's defaultBranch ('main'), NOT from BE's branch
    const feWorktree = runningFeTask.worktreePath!;
    const feHeadRef = execFileSync('git', ['-C', feWorktree, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const feMainRef = execFileSync('git', ['-C', feRepo, 'rev-parse', 'main'], { encoding: 'utf8' }).trim();
    expect(feHeadRef).toBe(feMainRef);

    // Verify deps.md contains BE project, repo, DONE summary and diff stat
    const depsMdPath = path.join(feWorktree, '.agenthub', 'context', 'deps.md');
    expect(fs.existsSync(depsMdPath)).toBe(true);
    const depsMdContent = fs.readFileSync(depsMdPath, 'utf8');

    expect(depsMdContent).toContain('## BE API v1 (be/api-v1)');
    expect(depsMdContent).toContain('Backend Project (be)');
    expect(depsMdContent).toContain(beRepo);
    expect(depsMdContent).toContain('Tóm tắt: Đã tạo endpoint /api/v1/auth');
    expect(depsMdContent).toContain('approved — BE looks good');
  });

  it('same-project dependency: inherits branch from nearest same-project dependency, ignoring cross-project dependencies', () => {
    const beRepo = path.join(tmpDir, 'be-repo-2');
    const feRepo = path.join(tmpDir, 'fe-repo-2');
    initGitRepo(beRepo, 'main');
    initGitRepo(feRepo, 'main');

    ctx.service.createProject({ id: 'be2', name: 'BE', path: beRepo, defaultBranch: 'main' });
    ctx.service.createProject({ id: 'fe2', name: 'FE', path: feRepo, defaultBranch: 'main' });

    // BE task done
    ctx.taskRepo.insert({
      id: 'be2/task-0',
      projectId: 'be2',
      slug: 'task-0',
      title: 'BE Task 0',
      body: 'BE Task',
      branch: 'agenthub/be-branch',
      status: 'done',
    });

    // FE task 1 done
    ctx.taskRepo.insert({
      id: 'fe2/task-1',
      projectId: 'fe2',
      slug: 'task-1',
      title: 'FE Task 1',
      body: 'FE Task 1',
      branch: 'agenthub/fe-task-1',
      status: 'done',
    });

    // Create branch in feRepo so worktree add can branch from it
    execFileSync('git', ['-C', feRepo, 'branch', 'agenthub/fe-task-1', 'main']);

    // FE task 2 depends on both BE task and FE task 1 (with BE task listed last)
    ctx.service.createTask({
      project: 'fe2',
      slug: 'task-2',
      title: 'FE Task 2',
      body: 'FE Task 2',
      level: 'easy',
      dependsOn: ['fe2/task-1', 'be2/task-0'],
      start: true,
    });

    ctx.scheduler.tick();

    const feTask2 = ctx.taskRepo.get('fe2/task-2')!;
    expect(feTask2.status).toBe('running');
    expect(feTask2.worktreePath).toBeDefined();

    // Verify FE task 2 branched from agenthub/fe-task-1, NOT from agenthub/be-branch
    const branchPoint = execFileSync('git', ['-C', feTask2.worktreePath!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const feTask1Commit = execFileSync('git', ['-C', feRepo, 'rev-parse', 'agenthub/fe-task-1'], { encoding: 'utf8' }).trim();
    expect(branchPoint).toBe(feTask1Commit);
  });

  it('integration enabled: worktree created on integration branch, merges into it, subsequent task branches from integration branch', async () => {
    const repo = path.join(tmpDir, 'int-repo');
    initGitRepo(repo, 'main');

    // Create project with integration enabled
    ctx.service.createProject({
      id: 'int-proj',
      name: 'Integration Project',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: {
          enabled: true,
          branch: 'agenthub/integration',
        },
      },
      merge: {
        enabled: true,
        worktrees: {},
        checks: ['node -e "process.exit(0)"'],
        timeoutSec: 30,
      },
    });

    // Verify integration worktree was created at <hubHome>/integration/int-proj
    const intPath = path.join(tmpDir, 'integration', 'int-proj');
    expect(fs.existsSync(intPath)).toBe(true);

    const intBranch = execFileSync('git', ['-C', intPath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(intBranch).toBe('agenthub/integration');

    // User repository must NOT have checked out agenthub/integration
    const userRepoBranch = execFileSync('git', ['-C', repo, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(userRepoBranch).toBe('main');

    // Create task 1
    ctx.service.createTask({
      project: 'int-proj',
      slug: 'feat-1',
      title: 'Feature 1',
      body: 'Do feature 1',
      level: 'easy',
      start: true,
    });

    ctx.scheduler.tick();

    const t1 = ctx.taskRepo.get('int-proj/feat-1')!;
    expect(t1.status).toBe('running');
    expect(t1.worktreePath).toBeDefined();

    // Verify task 1's worktree branched from agenthub/integration
    const t1Head = execFileSync('git', ['-C', t1.worktreePath!, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    const intHead = execFileSync('git', ['-C', intPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(t1Head).toBe(intHead);

    // Make a commit in Task 1's worktree
    fs.writeFileSync(path.join(t1.worktreePath!, 'feat1.txt'), 'feature 1 content\n');
    execFileSync('git', ['-C', t1.worktreePath!, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', t1.worktreePath!, 'commit', '-m', 'feat: add feature 1'], { encoding: 'utf8' });
    fs.mkdirSync(path.join(t1.worktreePath!, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(t1.worktreePath!, '.agenthub', 'DONE'), 'feat 1 done');

    // Review and merge task 1
    ctx.taskRepo.update('int-proj/feat-1', { status: 'review' });
    await ctx.service.reviewTask('int-proj/feat-1', {
      verdict: 'approved',
      feedback: 'Good to merge',
      merge: true,
    });

    expect(ctx.taskRepo.get('int-proj/feat-1')!.status).toBe('done');

    // Verify feat1.txt is now in the integration worktree
    expect(fs.existsSync(path.join(intPath, 'feat1.txt'))).toBe(true);

    // Create task 2 without baseRef and without same-project dependency
    ctx.service.createTask({
      project: 'int-proj',
      slug: 'feat-2',
      title: 'Feature 2',
      body: 'Do feature 2',
      level: 'easy',
      start: true,
    });

    ctx.scheduler.tick();

    const t2 = ctx.taskRepo.get('int-proj/feat-2')!;
    expect(t2.status).toBe('running');
    expect(t2.worktreePath).toBeDefined();

    // Task 2's worktree must have feat1.txt because it branched from the updated integration branch!
    expect(fs.existsSync(path.join(t2.worktreePath!, 'feat1.txt'))).toBe(true);
  });

  it('auto-merges only after a Codex approval when the project opted in', async () => {
    const repo = path.join(tmpDir, 'auto-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'auto-proj',
      name: 'Auto merge',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true } },
      merge: { enabled: true, worktrees: {}, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 },
    });
    const intPath = path.join(tmpDir, 'integration', 'auto-proj');
    ctx.service.createTask({ project: 'auto-proj', slug: 'feat', title: 'Feature', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('auto-proj/feat')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'auto.txt'), 'auto\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: auto']);
    ctx.taskRepo.update(task.id, { status: 'review' });

    // No Codex approval yet: nothing merges.
    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('review');

    ctx.reviewRepo.insert({ id: 'codex-ok', taskId: task.id, verdict: 'approved', feedback: 'ok', actor: 'codex-reviewer' });
    await ctx.service.autoMergeReviewedTask(task.id);
    expect(ctx.taskRepo.get(task.id)!.status).toBe('done');
    expect(fs.existsSync(path.join(intPath, 'auto.txt'))).toBe(true);
  });

  it('hands an auto-merge conflict back to the worker', async () => {
    const repo = path.join(tmpDir, 'conflict-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'conflict-proj',
      name: 'Conflict',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/integration', autoMerge: true } },
      merge: { enabled: true, worktrees: {}, checks: [], timeoutSec: 30 },
    });
    const intPath = path.join(tmpDir, 'integration', 'conflict-proj');
    ctx.service.createTask({ project: 'conflict-proj', slug: 'feat', title: 'Feature', body: 'Do it', level: 'easy', start: true });
    ctx.scheduler.tick();
    const task = ctx.taskRepo.get('conflict-proj/feat')!;
    fs.writeFileSync(path.join(task.worktreePath!, 'same.txt'), 'from task\n');
    execFileSync('git', ['-C', task.worktreePath!, 'add', '.']);
    execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'feat: task side']);
    fs.writeFileSync(path.join(intPath, 'same.txt'), 'from integration\n');
    execFileSync('git', ['-C', intPath, 'add', '.']);
    execFileSync('git', ['-C', intPath, 'commit', '-m', 'feat: integration side']);
    ctx.taskRepo.update(task.id, { status: 'review' });
    ctx.reviewRepo.insert({ id: 'codex-ok-conflict', taskId: task.id, verdict: 'approved', feedback: 'ok', actor: 'codex-reviewer' });

    await ctx.service.autoMergeReviewedTask(task.id);
    const after = ctx.taskRepo.get(task.id)!;
    expect(after.status).not.toBe('review');
    expect(after.status).not.toBe('done');
    expect(ctx.reviewRepo.getByTask(task.id).at(-1)?.feedback).toContain('xung đột');
  });

  it('sends an escalated review back once on the strongest model when no auto brain is running', async () => {
    const repo = path.join(tmpDir, 'esc-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({ id: 'esc-proj', name: 'Escalation', path: repo, defaultBranch: 'main' });
    ctx.service.createTask({ project: 'esc-proj', slug: 'feat', title: 'Feature', body: 'Do it', level: 'hard', start: false, modelChain: ['codex:gpt-5.6-luna'] });
    const id = 'esc-proj/feat';
    const escalate = () => {
      ctx.taskRepo.update(id, { status: 'review', reviewerEscalated: 1, reviewerChangesRequested: 2 });
      ctx.scheduler.getEventBus().emit('review.escalated', id, { actor: 'codex-reviewer', reason: 'reviewer_changes_limit', feedback: 'Còn thiếu test' });
    };

    escalate();
    await vi.waitFor(() => expect(ctx.taskRepo.get(id)!.status).not.toBe('review'));
    const retried = ctx.taskRepo.get(id)!;
    expect(JSON.parse(retried.modelChain!)).toEqual(['claude-opus-4-6-thinking', 'codex:gpt-5.6-luna']);
    expect(retried.reviewerEscalated).toBe(0);

    // A second escalation is left for a person.
    escalate();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ctx.taskRepo.get(id)!.status).toBe('review');
    expect(ctx.taskRepo.get(id)!.reviewerEscalated).toBe(1);
  });

  it('runs merge-time checks in integration worktree and rolls back on failure', async () => {
    const repo = path.join(tmpDir, 'checks-fail-repo');
    initGitRepo(repo, 'main');

    ctx.service.createProject({
      id: 'checks-proj',
      name: 'Checks Project',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: {
          enabled: true,
          branch: 'agenthub/integration',
        },
      },
      merge: {
        enabled: true,
        worktrees: {},
        checks: ['node -e "process.exit(1)"'],
        timeoutSec: 30,
      },
    });

    const intPath = path.join(tmpDir, 'integration', 'checks-proj');
    const beforeHead = execFileSync('git', ['-C', intPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

    ctx.service.createTask({
      project: 'checks-proj',
      slug: 'failing-check-task',
      title: 'Failing Check Task',
      body: 'Body',
      level: 'easy',
      start: true,
    });

    ctx.scheduler.tick();

    const t = ctx.taskRepo.get('checks-proj/failing-check-task')!;
    fs.writeFileSync(path.join(t.worktreePath!, 'code.txt'), 'bad code\n');
    execFileSync('git', ['-C', t.worktreePath!, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', t.worktreePath!, 'commit', '-m', 'bad commit'], { encoding: 'utf8' });
    fs.mkdirSync(path.join(t.worktreePath!, '.agenthub'), { recursive: true });
    fs.writeFileSync(path.join(t.worktreePath!, '.agenthub', 'DONE'), 'done');

    ctx.taskRepo.update('checks-proj/failing-check-task', { status: 'review' });
    ctx.taskRepo.insert({
      id: 'checks-proj/failing-check-task-fix-test',
      projectId: 'checks-proj',
      slug: 'failing-check-task-fix-test',
      title: 'Existing test fix',
      status: 'queued',
      sourceRef: JSON.stringify({ taskId: t.id, checkName: 'test', excerptHash: 'test' }),
    });

    await expect(ctx.service.reviewTask('checks-proj/failing-check-task', {
      verdict: 'approved',
      feedback: 'Approved but checks will fail',
      merge: true,
    })).rejects.toMatchObject({ statusCode: 422 });

    // Integration worktree must be rolled back to beforeHead and clean
    const afterHead = execFileSync('git', ['-C', intPath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    expect(afterHead).toBe(beforeHead);
    const status = execFileSync('git', ['-C', intPath, 'status', '--porcelain'], { encoding: 'utf8' }).trim();
    expect(status).toBe('');
    expect(ctx.taskRepo.get('checks-proj/failing-check-task-fix-test')?.status).toBe('queued');
    expect(ctx.taskRepo.getAll().filter((task) => task.slug.endsWith('-fix-merge'))).toHaveLength(1);
  });

  it('rejects invalid branch names and main/master collisions', () => {
    const repo = path.join(tmpDir, 'validation-repo');
    initGitRepo(repo, 'main');

    // Invalid git ref format
    expect(() => {
      ctx.service.createProject({
        id: 'bad-branch-1',
        name: 'Bad Branch',
        path: repo,
        defaultBranch: 'main',
        settings: {
          integration: {
            enabled: true,
            branch: 'invalid..branch',
          },
        },
      });
    }).toThrow(HttpError);

    // Collision with main
    expect(() => {
      ctx.service.createProject({
        id: 'main-collision',
        name: 'Main Collision',
        path: repo,
        defaultBranch: 'main',
        settings: {
          integration: {
            enabled: true,
            branch: 'main',
          },
        },
      });
    }).toThrow(/Tên nhánh tích hợp không được trùng với defaultBranch/);

    // Collision with master when defaultBranch is master
    const masterRepo = path.join(tmpDir, 'master-repo');
    initGitRepo(masterRepo, 'master');

    expect(() => {
      ctx.service.createProject({
        id: 'master-collision',
        name: 'Master Collision',
        path: masterRepo,
        defaultBranch: 'master',
        settings: {
          integration: {
            enabled: true,
            branch: 'master',
          },
        },
      });
    }).toThrow(/Tên nhánh tích hợp không được trùng với defaultBranch/);
  });

  it('reports integrationStatus with ahead / behind and removes worktree without deleting branch on delete', () => {
    const repo = path.join(tmpDir, 'status-repo');
    initGitRepo(repo, 'main');

    ctx.service.createProject({
      id: 'stat-proj',
      name: 'Status Project',
      path: repo,
      defaultBranch: 'main',
      settings: {
        integration: {
          enabled: true,
          branch: 'agenthub/integration',
        },
      },
    });

    const intPath = path.join(tmpDir, 'integration', 'stat-proj');

    // Initial status: exists: true, ahead: 0, behind: 0
    let proj = ctx.service.getProject('stat-proj');
    expect(proj.integrationStatus).toEqual({
      path: intPath,
      branch: 'agenthub/integration',
      exists: true,
      currentBranch: 'agenthub/integration',
      dirty: false,
      ahead: 0,
      behind: 0,
    });

    // Make a commit in the integration worktree
    fs.writeFileSync(path.join(intPath, 'int-change.txt'), 'integrated\n');
    execFileSync('git', ['-C', intPath, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', intPath, 'commit', '-m', 'integration commit'], { encoding: 'utf8' });

    proj = ctx.service.getProject('stat-proj');
    expect(proj.integrationStatus?.ahead).toBe(1);
    expect(proj.integrationStatus?.behind).toBe(0);

    // Make a commit on main in user's repo
    fs.writeFileSync(path.join(repo, 'main-update.txt'), 'main update\n');
    execFileSync('git', ['-C', repo, 'add', '.'], { encoding: 'utf8' });
    execFileSync('git', ['-C', repo, 'commit', '-m', 'main commit'], { encoding: 'utf8' });

    proj = ctx.service.getProject('stat-proj');
    expect(proj.integrationStatus?.ahead).toBe(1);
    expect(proj.integrationStatus?.behind).toBe(1);

    // Delete project: removes worktree at intPath, but branch agenthub/integration remains
    ctx.service.deleteProject('stat-proj');
    expect(fs.existsSync(intPath)).toBe(false);

    const branchCheck = execFileSync(
      'git',
      ['-C', repo, 'show-ref', '--verify', 'refs/heads/agenthub/integration'],
      { encoding: 'utf8' },
    ).trim();
    expect(branchCheck).toContain('refs/heads/agenthub/integration');
  });

  it('does not inspect git for integrationStatus when integration is disabled', () => {
    const repo = path.join(tmpDir, 'disabled-status-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'disabled-status',
      name: 'Disabled Status',
      path: repo,
      defaultBranch: 'main',
    });

    const gitSpy = vi.mocked(getIntegrationStatus);
    gitSpy.mockClear();
    expect(ctx.service.getProject('disabled-status').integrationStatus).toBeNull();
    expect(ctx.service.listProjects().find((project) => project.id === 'disabled-status')?.integrationStatus).toBeNull();
    expect(gitSpy).not.toHaveBeenCalled();
  });

  it('does not delete an unusable integration directory', () => {
    const repo = path.join(tmpDir, 'unusable-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'unusable-proj',
      name: 'Unusable Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/integration' } },
    });

    const intPath = path.join(tmpDir, 'integration', 'unusable-proj');
    const marker = path.join(intPath, 'keep-me.txt');
    fs.writeFileSync(marker, 'do not delete\n');
    fs.writeFileSync(path.join(intPath, '.git'), 'not a gitfile\n');

    expect(() => ctx.service.updateProject('unusable-proj', {
      settings: { integration: { branch: 'agenthub/integration' } },
    })).toThrow(/không sử dụng được/);
    expect(fs.existsSync(marker)).toBe(true);
  });

  it('keeps a dirty integration worktree when deleting a project and returns a warning', () => {
    const repo = path.join(tmpDir, 'dirty-delete-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'dirty-delete',
      name: 'Dirty Delete',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/integration' } },
    });
    const intPath = path.join(tmpDir, 'integration', 'dirty-delete');
    fs.writeFileSync(path.join(intPath, 'uncommitted.txt'), 'keep me\n');

    const result = ctx.service.deleteProject('dirty-delete');
    expect(result.warnings?.[0]).toContain('thay đổi chưa commit');
    expect(fs.existsSync(path.join(intPath, 'uncommitted.txt'))).toBe(true);
  });

  it('switches a clean integration worktree to a changed configured branch and rejects a dirty one', () => {
    const repo = path.join(tmpDir, 'switch-repo');
    initGitRepo(repo, 'main');
    ctx.service.createProject({
      id: 'switch-proj',
      name: 'Switch Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/old' } },
    });
    const intPath = path.join(tmpDir, 'integration', 'switch-proj');

    ctx.service.updateProject('switch-proj', { settings: { integration: { branch: 'agenthub/new' } } });
    expect(execFileSync('git', ['-C', intPath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('agenthub/new');

    fs.writeFileSync(path.join(intPath, 'uncommitted.txt'), 'keep me\n');
    expect(() => ctx.service.updateProject('switch-proj', { settings: { integration: { branch: 'agenthub/another' } } })).toThrow(/thay đổi chưa commit/);
    expect(execFileSync('git', ['-C', intPath, 'symbolic-ref', '--short', 'HEAD'], { encoding: 'utf8' }).trim()).toBe('agenthub/new');
  });

  it('reports a clear error when the integration branch is checked out elsewhere', () => {
    const repo = path.join(tmpDir, 'checked-out-repo');
    const otherWorktree = path.join(tmpDir, 'checked-out-worktree');
    initGitRepo(repo, 'main');
    execFileSync('git', ['-C', repo, 'worktree', 'add', '-b', 'agenthub/taken', otherWorktree, 'main']);

    expect(() => ctx.service.createProject({
      id: 'taken-proj',
      name: 'Taken Project',
      path: repo,
      defaultBranch: 'main',
      settings: { integration: { enabled: true, branch: 'agenthub/taken' } },
    })).toThrow(/Nhánh agenthub\/taken đang được checkout tại/);
  });

  it('guarantees hub NEVER calls git push', async () => {
    // 1. Git wrapper in PATH that records any call with "push"
    const gitLog = path.join(tmpDir, 'git-calls.log');
    const binDir = path.join(tmpDir, 'bin');
    fs.mkdirSync(binDir, { recursive: true });

    const wrapperScript = path.join(binDir, 'git');
    fs.writeFileSync(
      wrapperScript,
      `#!/usr/bin/env bash
for arg in "$@"; do
  if [ "$arg" = "push" ]; then
    echo "PUSH CALLED: $@" >> "${gitLog}"
  fi
done
exec /usr/bin/git "$@"
`,
      { mode: 0o755 },
    );

    const savedPath = process.env.PATH;
    process.env.PATH = `${binDir}:${savedPath}`;

    try {
      const repo = path.join(tmpDir, 'no-push-repo');
      initGitRepo(repo, 'main');

      ctx.service.createProject({
        id: 'no-push-proj',
        name: 'No Push Project',
        path: repo,
        defaultBranch: 'main',
        settings: {
          integration: {
            enabled: true,
            branch: 'agenthub/integration',
          },
        },
      });

      ctx.service.createTask({
        project: 'no-push-proj',
        slug: 'np-task',
        title: 'No Push Task',
        body: 'Body',
        level: 'easy',
        start: true,
      });

      ctx.scheduler.tick();

      const task = ctx.taskRepo.get('no-push-proj/np-task')!;
      fs.writeFileSync(path.join(task.worktreePath!, 'work.txt'), 'done\n');
      execFileSync('git', ['-C', task.worktreePath!, 'add', '.'], { encoding: 'utf8' });
      execFileSync('git', ['-C', task.worktreePath!, 'commit', '-m', 'work commit'], { encoding: 'utf8' });
      fs.mkdirSync(path.join(task.worktreePath!, '.agenthub'), { recursive: true });
      fs.writeFileSync(path.join(task.worktreePath!, '.agenthub', 'DONE'), 'done');

      ctx.taskRepo.update('no-push-proj/np-task', { status: 'review' });
      await ctx.service.reviewTask('no-push-proj/np-task', {
        verdict: 'approved',
        feedback: 'LGTM',
        merge: true,
      });

      ctx.service.getProject('no-push-proj');

      // Also verify deleteProject doesn't push
      const emptyRepo = path.join(tmpDir, 'empty-repo');
      initGitRepo(emptyRepo, 'main');
      ctx.service.createProject({
        id: 'no-push-empty',
        name: 'Empty No Push',
        path: emptyRepo,
        defaultBranch: 'main',
        settings: {
          integration: {
            enabled: true,
          },
        },
      });
      ctx.service.deleteProject('no-push-empty');

      expect(fs.existsSync(gitLog)).toBe(false);
    } finally {
      process.env.PATH = savedPath;
    }

    // 2. Static check across all files in src/ to ensure no git push command exists
    const srcDir = path.join(process.cwd(), 'src');
    const readAllFiles = (dir: string): string[] => {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      const files: string[] = [];
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) files.push(...readAllFiles(full));
        else if (/\.(ts|js|mjs)$/.test(entry.name)) files.push(full);
      }
      return files;
    };

    const allSrcFiles = readAllFiles(srcDir);
    const gitPushUsages: { file: string; line: number; text: string }[] = [];

    for (const file of allSrcFiles) {
      const content = fs.readFileSync(file, 'utf8');
      const lines = content.split('\n');
      lines.forEach((line, idx) => {
        if (/'push'|"push"/.test(line) && /git/i.test(line) && !/policy|DENY|deny/i.test(line)) {
          gitPushUsages.push({ file: path.relative(process.cwd(), file), line: idx + 1, text: line.trim() });
        }
      });
    }

    expect(gitPushUsages).toEqual([]);
  });
});
