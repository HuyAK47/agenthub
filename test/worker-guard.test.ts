import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { assertWorkerMayControlHub, workerEnvironment, WORKER_SERVICE_MESSAGE } from '../src/worker-guard.js';

describe('worker service guard', () => {
  it('blocks hub service control but forwards unrelated systemctl commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-worker-guard-'));
    const bin = path.join(root, 'bin');
    const hub = path.join(root, 'hub');
    fs.mkdirSync(bin);
    const real = path.join(bin, 'systemctl');
    fs.writeFileSync(real, '#!/bin/sh\nprintf "real:%s\\n" "$*"\n', { mode: 0o700 });
    const env = workerEnvironment(hub, { PATH: bin });
    const shim = path.join(hub, 'shims', 'systemctl');
    expect(() => execFileSync(shim, ['--user', 'stop', 'agenthub'], { env, encoding: 'utf8', stdio: 'pipe' })).toThrow(WORKER_SERVICE_MESSAGE);
    expect(execFileSync(shim, ['--user', 'status', 'foo'], { env, encoding: 'utf8' })).toContain('real:--user status foo');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('sets worker environment and refuses service commands for the real hub', () => {
    const previousWorker = process.env.AGENTHUB_WORKER;
    const previousHome = process.env.AGENTHUB_HOME;
    process.env.AGENTHUB_WORKER = '1';
    delete process.env.AGENTHUB_HOME;
    expect(() => assertWorkerMayControlHub('install-service')).toThrow(WORKER_SERVICE_MESSAGE);
    const env = workerEnvironment(fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-worker-env-')), {});
    expect(env.AGENTHUB_WORKER).toBe('1');
    if (previousWorker === undefined) delete process.env.AGENTHUB_WORKER; else process.env.AGENTHUB_WORKER = previousWorker;
    if (previousHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = previousHome;
  });
});
