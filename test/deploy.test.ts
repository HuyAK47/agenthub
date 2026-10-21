import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
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
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

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
});
