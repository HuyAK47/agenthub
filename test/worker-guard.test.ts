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

  it('blocks network and container commands with informative message and exit 1', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-blocked-cmds-'));
    const hub = path.join(root, 'hub');
    const env = workerEnvironment(hub, { PATH: process.env.PATH });

    for (const cmd of ['ssh', 'scp', 'sftp', 'docker', 'docker-compose', 'podman']) {
      const shimPath = path.join(hub, 'shims', cmd);
      expect(fs.existsSync(shimPath)).toBe(true);

      // Calling through shim directly
      expect(() => execFileSync(shimPath, ['some-arg'], { env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(`AgentHub: worker không được chạy lệnh '${cmd}'`);

      // Calling by command name with PATH set to worker env
      expect(() => execFileSync(cmd, ['test'], { env, encoding: 'utf8', stdio: 'pipe' }))
        .toThrow(`AgentHub: worker không được chạy lệnh '${cmd}'`);
    }

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('git wrapper blocks git push and git remote set-url while allowing safe commands', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-git-wrapper-'));
    const hub = path.join(root, 'hub');
    const repo = path.join(root, 'repo');
    fs.mkdirSync(repo);

    execFileSync('git', ['init'], { cwd: repo });
    execFileSync('git', ['checkout', '-b', 'main'], { cwd: repo });
    fs.writeFileSync(path.join(repo, 'a.txt'), 'content');

    const env = workerEnvironment(hub, {
      ...process.env,
      GIT_AUTHOR_NAME: 'test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
    });

    const gitShim = path.join(hub, 'shims', 'git');
    expect(fs.existsSync(gitShim)).toBe(true);

    // 1. git push is blocked
    expect(() => execFileSync(gitShim, ['push', 'origin', 'main'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    expect(() => execFileSync('git', ['-C', repo, 'push'], { env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    expect(() => execFileSync('git', ['--no-pager', 'push'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git push'");

    // 2. git remote set-url is blocked
    expect(() => execFileSync('git', ['remote', 'set-url', 'origin', 'https://example.com/repo.git'], { cwd: repo, env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git remote set-url'");

    expect(() => execFileSync('git', ['-C', repo, 'remote', 'set-url', 'origin', 'https://example.com/repo.git'], { env, encoding: 'utf8', stdio: 'pipe' }))
      .toThrow("AgentHub: worker không được chạy lệnh 'git remote set-url'");

    // 3. safe git commands run normally
    // git status
    const statusOut = execFileSync('git', ['status', '--porcelain'], { cwd: repo, env, encoding: 'utf8' });
    expect(statusOut).toContain('?? a.txt');

    // git add
    execFileSync('git', ['add', '.'], { cwd: repo, env });

    // git commit with message containing "push" (should NOT be blocked)
    execFileSync('git', ['commit', '-m', 'feat: push notification support'], { cwd: repo, env });

    // git log
    const logOut = execFileSync('git', ['log', '-1', '--oneline'], { cwd: repo, env, encoding: 'utf8' });
    expect(logOut).toContain('push notification support');

    // git remote add (should NOT be blocked)
    execFileSync('git', ['remote', 'add', 'origin', 'https://example.com/test.git'], { cwd: repo, env });

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('can disable worker command guards for hub git operations while keeping service shims', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-hub-env-'));
    const hub = path.join(root, 'hub');
    const bin = path.join(root, 'bin');
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(path.join(bin, 'systemctl'), '#!/bin/sh\nprintf "real:%s\\n" "$*"\n', { mode: 0o700 });
    const env = workerEnvironment(hub, { PATH: bin }, { guards: false });

    expect(env.PATH?.split(path.delimiter)[0]).toBe(path.join(hub, 'shims'));
    expect(fs.existsSync(path.join(hub, 'shims', 'git'))).toBe(false);
    expect(fs.existsSync(path.join(hub, 'shims', 'ssh'))).toBe(false);
    expect(execFileSync('systemctl', ['status', 'agenthub'], { env, encoding: 'utf8' })).toContain('real:status agenthub');

    fs.rmSync(root, { recursive: true, force: true });
  });

  it('exposes AGENTHUB_REF_<NAME> environment variables for project references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-ref-env-'));
    const hub = path.join(root, 'hub');

    const env = workerEnvironment(hub, {}, {
      project: {
        settings: JSON.stringify({
          references: [
            { name: 'glossary', path: '/docs/glossary.md', inject: true },
            { name: 'shared_lib', path: '/libs/shared', inject: false },
            { name: 'api-spec', path: '/specs/api.json', inject: false },
          ],
        }),
      },
    });

    expect(env.AGENTHUB_REF_GLOSSARY).toBe('/docs/glossary.md');
    expect(env.AGENTHUB_REF_SHARED_LIB).toBe('/libs/shared');
    expect(env.AGENTHUB_REF_API_SPEC).toBe('/specs/api.json');

    fs.rmSync(root, { recursive: true, force: true });
  });
});
