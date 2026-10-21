import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DeployService } from '../src/deploy.js';

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

function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
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

function deployEventBus(events: Array<{ type: string; payload: unknown }>) {
  return {
    emit: (type: string, _id?: string, payload?: unknown) => { events.push({ type, payload }); return true; },
    on: vi.fn(),
  };
}

describe('DeployService', () => {
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
});
