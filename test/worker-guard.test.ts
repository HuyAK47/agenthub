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

  it('disables git hooks when gitHooks=skip and leaves them active when run', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-hooks-test-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);

    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'file.txt'), 'hello');

    // Add a failing pre-commit hook
    const hooksDir = path.join(repo, '.git', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const preCommit = path.join(hooksDir, 'pre-commit');
    fs.writeFileSync(preCommit, '#!/bin/sh\necho "hook failed" >&2\nexit 1\n', { mode: 0o755 });

    const gitAuthorEnv = {
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    };

    execFileSync('git', ['add', '.'], { cwd: repo });

    // 1. With project with default / gitHooks='run': commit should fail because hook exits 1
    const runEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv }, {
      project: { settings: JSON.stringify({ worktree: { gitHooks: 'run' } }) },
    });
    expect(() => execFileSync('git', ['commit', '-m', 'test-run'], { cwd: repo, env: runEnv, encoding: 'utf8', stdio: 'pipe' })).toThrow();

    // 2. With project with gitHooks='skip': commit succeeds because hooks are disabled
    const skipEnv = workerEnvironment(hub, { ...process.env, ...gitAuthorEnv }, {
      project: { settings: JSON.stringify({ worktree: { gitHooks: 'skip' } }) },
    });
    expect(skipEnv.HUSKY).toBe('0');
    expect(skipEnv.GIT_CONFIG_COUNT).toBe('1');
    expect(skipEnv.GIT_CONFIG_KEY_0).toBe('core.hooksPath');
    expect(skipEnv.GIT_CONFIG_VALUE_0).toBe(path.join(hub, 'empty-hooks'));
    expect(fs.existsSync(path.join(hub, 'empty-hooks'))).toBe(true);

    expect(() => execFileSync('git', ['commit', '-m', 'test-skip'], { cwd: repo, env: skipEnv, encoding: 'utf8' })).not.toThrow();

    fs.rmSync(root, { recursive: true, force: true });
  });
});
