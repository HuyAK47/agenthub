import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployService, isRunningHubCheckout } from '../src/deploy.js';

const dirs: string[] = [];

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-deploy-'));
  dirs.push(root);
  const integration = path.join(root, 'integration');
  fs.mkdirSync(integration);
  const events: Array<{ type: string; payload: unknown }> = [];
  return { root, integration, events };
}

afterEach(() => {
  vi.useRealTimers();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  const p = (process.env.PATH || '')
    .split(path.delimiter)
    .filter((d) => !d.includes(`${path.sep}shims${path.sep}worker`))
    .join(path.delimiter);
  return { ...process.env, PATH: p };
}

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, env: cleanEnv(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function initRepo(repo: string, remote?: string): string {
  fs.mkdirSync(repo, { recursive: true });
  git(repo, ['init']);
  git(repo, ['checkout', '-b', 'main']);
  git(repo, ['config', 'user.email', 'test@example.com']);
  git(repo, ['config', 'user.name', 'Deploy Test']);
  fs.writeFileSync(path.join(repo, 'file.txt'), 'initial\n');
  git(repo, ['add', 'file.txt']);
  git(repo, ['commit', '-m', 'initial']);
  if (remote) git(repo, ['remote', 'add', 'origin', remote]);
  return git(repo, ['rev-parse', 'HEAD']);
}

const testGitRunner = async (cwd: string, args: string[]) => {
  try {
    const output = git(cwd, args);
    return { code: 0, output };
  } catch (err: unknown) {
    const error = err as { status?: number; message?: string };
    return { code: error.status ?? 1, output: error.message ?? String(err) };
  }
};

function deployEventBus(events: Array<{ type: string; payload: unknown }>) {
  return {
    emit: (type: string, _id?: string, payload?: unknown) => { events.push({ type, payload }); return true; },
    on: vi.fn(),
  };
}

describe('DeployService', () => {
  it('restartHub uses launchctl kickstart on Darwin', () => {
    const f = setup();
    const calls: Array<{ command: string; args: string[] }> = [];
    const originalPlatform = process.platform;
    const originalLaunchctl = process.env.AGENTHUB_LAUNCHCTL;
    Object.defineProperty(process, 'platform', { configurable: true, value: 'darwin' });
    process.env.AGENTHUB_LAUNCHCTL = '/fake/launchctl';
    try {
      const service = new DeployService(
        { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: {} } as never,
        {} as never,
        deployEventBus(f.events) as never,
        0,
        undefined,
        undefined,
        (command, args) => { calls.push({ command, args }); return undefined; },
      );
      (service as unknown as { restartHub: (status: unknown) => void }).restartHub({ projectId: 'demo', commit: 'abc', logPath: '/tmp/deploy.log' });

      expect(calls).toEqual([{ command: '/fake/launchctl', args: ['kickstart', '-k', `gui/${process.getuid?.() ?? os.userInfo().uid}/dev.agenthub`] }]);
      expect(fs.existsSync(path.join(f.root, 'deploy-restart.json'))).toBe(true);
    } finally {
      Object.defineProperty(process, 'platform', { configurable: true, value: originalPlatform });
      if (originalLaunchctl === undefined) delete process.env.AGENTHUB_LAUNCHCTL;
      else process.env.AGENTHUB_LAUNCHCTL = originalLaunchctl;
    }
  });

  it('waits for checks and workers before restart, then emits the waiting status', async () => {
    vi.useFakeTimers();
    const f = setup();
    let busy = true;
    const restarts: string[][] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: {} } as never,
      {} as never,
      deployEventBus(f.events) as never,
      0, undefined, undefined,
      (command, args) => { restarts.push([command, ...args]); },
      { snapshot: () => busy ? { checks: 2, editing: 1 } : { checks: 0, editing: 0 } },
    );
    const restarting = (service as unknown as { restartHub: (status: unknown) => Promise<void> }).restartHub({ projectId: 'demo', commit: 'abc' });
    await vi.advanceTimersByTimeAsync(1000);
    busy = false;
    await vi.advanceTimersByTimeAsync(1000);
    await restarting;
    expect(restarts).toHaveLength(1);
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'deploy.restart_waiting',
      payload: expect.objectContaining({ checks: 2, editing: 1, message: expect.stringContaining('2 lượt kiểm tra, 1 worker') }),
    }));
  });

  it('restarts after restartMaxWaitMin even if a worker remains busy', async () => {
    const f = setup();
    const restarts: string[][] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: true, restartMaxWaitMin: 0 } } } as never,
      {} as never,
      deployEventBus(f.events) as never,
      0, undefined, undefined,
      (command, args) => { restarts.push([command, ...args]); },
      { snapshot: () => ({ checks: 1, editing: 1 }) },
    );
    await (service as unknown as { restartHub: (status: unknown) => Promise<void> }).restartHub({ projectId: 'demo', commit: 'abc' });
    expect(restarts).toHaveLength(1);
  });

  it('stages the web install and promotes it only immediately before restart', async () => {
    const f = setup();
    const target = path.join(f.root, 'web');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'version'), 'old');
    let snapshots = 0;
    let duringInstall = '';
    let atRestart = '';
    const service = new DeployService(
      {
        hubHome: f.root,
        logsDir: path.join(f.root, 'logs'),
        deploy: { demo: { steps: [['node', 'scripts/install-web.mjs']], timeoutSec: 2, restartHub: true, restartMaxWaitMin: 1 } },
      } as never,
      { get: () => ({ id: 'demo', path: process.cwd(), defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: process.cwd() } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async (_command, _args, options) => {
        const staging = options.env.AGENTHUB_WEB_STAGING_DIR!;
        fs.mkdirSync(staging, { recursive: true });
        fs.writeFileSync(path.join(staging, 'version'), 'new');
        duringInstall = fs.readFileSync(path.join(target, 'version'), 'utf8');
        return { code: 0, output: '' };
      },
      (command, args) => {
        atRestart = fs.readFileSync(path.join(target, 'version'), 'utf8');
        expect(command).toBe(process.env.AGENTHUB_SYSTEMCTL || 'systemctl');
        expect(args).toContain('restart');
      },
      { snapshot: () => snapshots++ === 0 ? { checks: 1, editing: 0 } : { checks: 0, editing: 0 } },
    );

    const result = await service.run('demo', 'abc');
    expect(result.status).toBe('restarting');
    expect(duringInstall).toBe('old');
    expect(atRestart).toBe('new');
  });

  it('runs configured argv steps in order, logs them, and emits success', async () => {
    const f = setup();
    const calls: string[] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['first'], ['second']], timeoutSec: 2, restartHub: false } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      { emit: (type: string, _id?: string, payload?: unknown) => { f.events.push({ type, payload }); return true; }, on: vi.fn() } as never,
      0,
      undefined,
      async (command, args) => { calls.push([command, ...args].join(' ')); return { code: 0, output: 'ok' }; },
    );
    const result = await service.run('demo', 'abc');
    expect(result.status).toBe('succeeded');
    expect(calls).toEqual(['first', 'second']);
    expect(f.events.map((event) => event.type)).toEqual(['deploy.started', 'deploy.succeeded']);
    const log = fs.readFileSync(result.logPath!, 'utf8');
    expect(log).toContain('step 1');
  });

  it('stops after a failed step and reports an incident', async () => {
    const f = setup();
    const calls: string[] = [];
    const service = new DeployService({ hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['bad'], ['never']], timeoutSec: 2, restartHub: false } } } as never, { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never, { emit: (type: string, _id?: string, payload?: unknown) => { f.events.push({ type, payload }); return true; }, on: vi.fn() } as never, 0, undefined, async (command) => { calls.push(command); return { code: 1, output: 'nope' }; });
    const result = await service.run('demo');
    expect(result.status).toBe('failed');
    expect(calls).toEqual(['bad']);
    expect(f.events[1]).toMatchObject({ type: 'deploy.failed', payload: { level: 'incident' } });
  });

  it('queues reruns without waiting for the previous deployment', async () => {
    const f = setup();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const service = new DeployService({ hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false } } } as never, { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never, { emit: vi.fn(() => true), on: vi.fn() } as never, 0, undefined, async () => { await gate; return { code: 0, output: '' }; });
    const first = service.run('demo');
    await vi.waitFor(() => expect(service.getStatus('demo')?.status).toBe('running'));
    expect(service.rerun('demo').status).toBe('queued');
    release();
    await first;
    await vi.waitFor(() => expect(service.getStatus('demo')?.status).toBe('succeeded'));
  });

  it('continues with the next queued deployment after an outer execution error', async () => {
    const f = setup();
    let lookups = 0;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false } } } as never,
      { get: () => { if (lookups++ === 0) throw new Error('temporary lookup failure'); return { id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }; } } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'skipped' });
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'succeeded' });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('debounces merged events and deploys only the latest commit', async () => {
    vi.useFakeTimers();
    const f = setup();
    const calls: string[] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      deployEventBus(f.events) as never,
      20,
      undefined,
      async () => { calls.push('step'); return { code: 0, output: '' }; },
    );
    service.schedule('demo', 'one');
    service.schedule('demo', 'two');
    service.schedule('demo', 'three');
    await vi.advanceTimersByTimeAsync(20);
    expect(calls).toEqual(['step']);
    expect(service.getStatus('demo')).toMatchObject({ status: 'succeeded', commit: 'three' });
  });

  it('skips a project without an explicitly configured merge worktree', async () => {
    const f = setup();
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main' }) } as never,
      deployEventBus(f.events) as never,
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'skipped', error: expect.stringContaining('worktree') });
  });

  it('pushes the configured source ref fast-forward only', async () => {
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    const commit = initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'succeeded' });
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit);
  });

  it('reports a non-fast-forward push failure and leaves the remote branch unchanged', async () => {
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);
    git(repo, ['push', 'origin', 'main:release']);
    const alternate = path.join(f.root, 'alternate');
    git(f.root, ['clone', '-b', 'release', bare, alternate]);
    git(alternate, ['config', 'user.email', 'test@example.com']);
    git(alternate, ['config', 'user.name', 'Deploy Test']);
    fs.writeFileSync(path.join(alternate, 'file.txt'), 'remote change\n');
    git(alternate, ['add', 'file.txt']);
    git(alternate, ['commit', '-m', 'remote change']);
    git(alternate, ['push', 'origin', 'HEAD:release']);
    const remoteCommit = git(bare, ['rev-parse', 'refs/heads/release']);
    fs.writeFileSync(path.join(repo, 'file.txt'), 'local change\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'local change']);
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
    );
    const result = await service.run('demo');
    expect(result.status).toBe('failed');
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(remoteCommit);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'deploy.failed', payload: expect.objectContaining({ level: 'incident' }) }));
  });

  it('returns status failed when push fails, even if previous deployment succeeded', async () => {
    const f = setup();
    const repo = path.join(f.root, 'repo');
    initRepo(repo);
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      async () => ({ code: 1, output: 'push rejected' }),
      async () => ({ code: 0, output: '' }),
    );

    (service as unknown as { latest: Map<string, unknown> }).latest.set('demo', {
      projectId: 'demo',
      status: 'succeeded',
      commit: 'abc',
    });

    const result = await service.pushNow('demo');
    expect(result.status).toBe('failed');
    expect(result.error).toContain('exit 1');
    expect(service.getStatus('demo')?.status).toBe('failed');
    expect(f.events).toContainEqual(expect.objectContaining({
      type: 'deploy.failed',
      payload: expect.objectContaining({ projectId: 'demo', level: 'incident' }),
    }));
  });

  it('writes a restart marker and invokes the platform restart command only for the hub project', async () => {
    const f = setup();
    const restarts: string[][] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: true } } } as never,
      { get: () => ({ id: 'demo', path: process.cwd(), defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
      (command, args) => restarts.push([command, ...args]),
    );
    const result = await service.run('demo', 'abc');
    expect(result.status).toBe('restarting');
    expect(restarts).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(f.root, 'deploy-restart.json'), 'utf8'))).toMatchObject({ projectId: 'demo', commit: 'abc' });
  });

  it('does not restart when restartHub is enabled for a non-hub project', async () => {
    const f = setup();
    const restarts: string[][] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: true } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
      (command, args) => { restarts.push([command, ...args]); },
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'succeeded' });
    expect(restarts).toHaveLength(0);
    expect(fs.existsSync(path.join(f.root, 'deploy-restart.json'))).toBe(false);
  });

  it('reports restart runner errors as incidents and removes the marker', async () => {
    const f = setup();
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: true } } } as never,
      { get: () => ({ id: 'demo', path: process.cwd(), defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
      () => { throw new Error('restart unavailable'); },
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'failed', error: 'restart unavailable' });
    expect(fs.existsSync(path.join(f.root, 'deploy-restart.json'))).toBe(false);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'deploy.failed', payload: expect.objectContaining({ level: 'incident', error: 'restart unavailable' }) }));
  });

  it('reports marker write errors as failed deployments', async () => {
    const f = setup();
    fs.mkdirSync(path.join(f.root, 'deploy-restart.json'));
    const restarts: string[][] = [];
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: true } } } as never,
      { get: () => ({ id: 'demo', path: process.cwd(), defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      undefined,
      async () => ({ code: 0, output: '' }),
      (command, args) => { restarts.push([command, ...args]); },
    );
    await expect(service.run('demo')).resolves.toMatchObject({ status: 'failed' });
    expect(restarts).toHaveLength(0);
    expect(f.events).toContainEqual(expect.objectContaining({ type: 'deploy.failed', payload: expect.objectContaining({ level: 'incident' }) }));
  });

  it('restores and removes a valid restart marker, while ignoring a malformed one', () => {
    const f = setup();
    fs.writeFileSync(path.join(f.root, 'deploy-restart.json'), JSON.stringify({ projectId: 'demo', commit: 'abc' }));
    const events: Array<{ type: string; payload: unknown }> = [];
    const service = new DeployService({ hubHome: f.root, logsDir: path.join(f.root, 'logs') } as never, { get: vi.fn() } as never, deployEventBus(events) as never);
    service.start();
    expect(service.getStatus('demo')).toMatchObject({ status: 'succeeded', commit: 'abc' });
    expect(fs.existsSync(path.join(f.root, 'deploy-restart.json'))).toBe(false);
    expect(events).toContainEqual(expect.objectContaining({ type: 'deploy.succeeded', payload: expect.objectContaining({ afterRestart: true }) }));

    fs.writeFileSync(path.join(f.root, 'deploy-restart.json'), '{broken');
    expect(() => new DeployService({ hubHome: f.root, logsDir: path.join(f.root, 'logs') } as never, { get: vi.fn() } as never, deployEventBus([]) as never).start()).not.toThrow();
  });

  it('defers push when within minIntervalMin and displays pending status', async () => {
    vi.useFakeTimers();
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    const commit1 = initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);

    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      testGitRunner,
      async () => ({ code: 0, output: '' }),
    );

    // First deploy -> pushes immediately because no prior push
    const res1 = await service.run('demo', 'c1');
    expect(res1.status).toBe('succeeded');
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);
    expect(res1.pushStatus).toMatch(/^push lúc \d\d:\d\d$/);

    // Make commit 2 in repo
    fs.writeFileSync(path.join(repo, 'file.txt'), 'second\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'second']);

    // Advance 5 minutes
    await vi.advanceTimersByTimeAsync(5 * 60_000);

    // Second deploy runs -> should defer push
    const res2 = await service.run('demo', 'c2');
    expect(res2.status).toBe('succeeded');
    expect(res2.pushStatus).toMatch(/^push đang chờ tới \d\d:\d\d$/);
    // Remote release branch is STILL at commit1!
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);
    service.stop();
  });

  it('automatically pushes when deferred timer expires without rebuilding', async () => {
    vi.useFakeTimers();
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    const commit1 = initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);

    let stepRuns = 0;
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      testGitRunner,
      async () => { stepRuns++; return { code: 0, output: '' }; },
    );

    await service.run('demo');
    expect(stepRuns).toBe(1);
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);

    fs.writeFileSync(path.join(repo, 'file.txt'), 'second\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'second']);
    const commit2 = git(repo, ['rev-parse', 'HEAD']);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.run('demo');
    expect(stepRuns).toBe(2);
    // Remote still at commit1
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);

    // Advance 25 minutes (to complete the 30 minute interval)
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    await service.waitForQueue();

    // Remote should now be at commit2!
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit2);
    // Steps were NOT re-run (still 2)!
    expect(stepRuns).toBe(2);
    expect(service.getStatus('demo')?.pushStatus).toMatch(/^push lúc \d\d:\d\d$/);
    service.stop();
  });

  it('pushNow pushes immediately and cancels deferred schedule', async () => {
    vi.useFakeTimers();
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    const commit1 = initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);

    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      testGitRunner,
      async () => ({ code: 0, output: '' }),
    );

    await service.run('demo');

    fs.writeFileSync(path.join(repo, 'file.txt'), 'second\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'second']);
    const commit2 = git(repo, ['rev-parse', 'HEAD']);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.run('demo');
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);

    // Call pushNow
    const nowRes = await service.pushNow('demo');
    expect(nowRes.status).toBe('succeeded');
    expect(nowRes.pushStatus).toMatch(/^push lúc \d\d:\d\d$/);
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit2);

    // Further timer advance does not cause error or extra push
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit2);
    service.stop();
  });

  it('batches multiple merges within interval into a single push', async () => {
    vi.useFakeTimers();
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);

    let pushCount = 0;
    const service = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      async () => {
        pushCount++;
        return { code: 0, output: '' };
      },
      async () => ({ code: 0, output: '' }),
    );

    // Initial deploy at T0
    await service.run('demo');
    expect(pushCount).toBe(1);

    // Merge 1 at T+5m
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.run('demo');
    expect(pushCount).toBe(1);

    // Merge 2 at T+10m
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.run('demo');
    expect(pushCount).toBe(1);

    // Merge 3 at T+15m
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service.run('demo');
    expect(pushCount).toBe(1);

    // Advance to T+30m: deferred timer fires once
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    await service.waitForQueue();
    expect(pushCount).toBe(2);

    // Further time advance -> no extra pushes
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(pushCount).toBe(2);
    service.stop();
  });

  it('preserves scheduled push across service restarts', async () => {
    vi.useFakeTimers();
    const f = setup();
    const bare = path.join(f.root, 'remote.git');
    fs.mkdirSync(bare);
    git(bare, ['init', '--bare']);
    const repo = path.join(f.root, 'repo');
    const commit1 = initRepo(repo, bare);
    git(repo, ['push', 'origin', 'main']);

    const service1 = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      testGitRunner,
      async () => ({ code: 0, output: '' }),
    );

    await service1.run('demo');
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);

    fs.writeFileSync(path.join(repo, 'file.txt'), 'second\n');
    git(repo, ['add', 'file.txt']);
    git(repo, ['commit', '-m', 'second']);
    const commit2 = git(repo, ['rev-parse', 'HEAD']);

    await vi.advanceTimersByTimeAsync(5 * 60_000);
    await service1.run('demo');

    // State file was written to disk
    const stateFile = path.join(f.root, 'deploy-push-state.json');
    expect(fs.existsSync(stateFile)).toBe(true);

    // Stop service1
    service1.stop();

    // Start service2
    const service2 = new DeployService(
      { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false, push: { remote: 'origin', from: 'main', to: 'release', ffOnly: true, minIntervalMin: 30 } } } } as never,
      { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: repo } }) }) } as never,
      deployEventBus(f.events) as never,
      0,
      testGitRunner,
      async () => ({ code: 0, output: '' }),
    );
    service2.start();

    // Check status in service2 shows pending push
    expect(service2.getStatus('demo')?.pushStatus).toMatch(/^push đang chờ tới \d\d:\d\d$/);
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit1);

    // Advance 25 minutes
    await vi.advanceTimersByTimeAsync(25 * 60_000);
    await service2.waitForQueue();

    // service2 pushed commit2!
    expect(git(bare, ['rev-parse', 'refs/heads/release'])).toBe(commit2);
    expect(service2.getStatus('demo')?.pushStatus).toMatch(/^push lúc \d\d:\d\d$/);
    service2.stop();
  });

  it('preserves a pending deploy debounce across service restarts', async () => {
    vi.useFakeTimers();
    const f = setup();
    const serviceConfig = { hubHome: f.root, logsDir: path.join(f.root, 'logs'), deploy: { demo: { steps: [['step']], timeoutSec: 2, restartHub: false } } } as never;
    const projectRepo = { get: () => ({ id: 'demo', path: f.root, defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration } }) }) } as never;
    const service1 = new DeployService(serviceConfig, projectRepo, deployEventBus(f.events), 10_000, undefined, async () => ({ code: 0, output: '' }));

    service1.schedule('demo', 'pending-commit');
    service1.stop();
    expect(fs.existsSync(path.join(f.root, 'deploy-pending-state.json'))).toBe(true);

    let stepRuns = 0;
    const service2 = new DeployService(serviceConfig, projectRepo, deployEventBus(f.events), 10_000, undefined, async () => {
      stepRuns++;
      return { code: 0, output: '' };
    });
    service2.start();
    expect(service2.getStatus('demo')).toMatchObject({ status: 'queued', commit: 'pending-commit' });
    await vi.advanceTimersByTimeAsync(10_000);
    await service2.waitForQueue();
    expect(stepRuns).toBe(1);
    expect(service2.getStatus('demo')).toMatchObject({ status: 'succeeded', commit: 'pending-commit' });
    service2.stop();
  });
});

describe('isRunningHubCheckout', () => {
  it('recognises the hub when it runs from the deployed worktree rather than the project path', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hubroot-'));
    const main = path.join(root, 'main');
    const worktree = path.join(root, 'integration');
    fs.mkdirSync(main);
    fs.mkdirSync(worktree);
    try {
      expect(isRunningHubCheckout([worktree, main], worktree)).toBe(true);
      expect(isRunningHubCheckout([path.join(worktree, '.'), main], worktree)).toBe(true);
      expect(isRunningHubCheckout([main], worktree)).toBe(false);
      expect(isRunningHubCheckout([undefined, path.join(root, 'missing')], worktree)).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
