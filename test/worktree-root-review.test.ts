import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { WorktreeService } from '../src/worktrees/index.js';
import { projectWorktreeRoots } from '../src/projects/paths.js';

const dirs: string[] = [];

function repoFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-worktree-root-review-'));
  dirs.push(root);
  const repo = path.join(root, 'repo');
  const hubHome = path.join(root, 'hub');
  const worktreesDir = path.join(hubHome, 'worktrees');
  const configuredRoot = path.join(root, 'encrypted-worktrees');
  fs.mkdirSync(repo, { recursive: true });
  fs.mkdirSync(worktreesDir, { recursive: true });
  fs.mkdirSync(configuredRoot, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  const config = { hubHome, worktreesDir } as never;
  const project = { id: 'demo', path: repo, settings: JSON.stringify({ worktree: { root: configuredRoot } }) };
  return { root, repo, hubHome, worktreesDir, configuredRoot, config, project };
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe('configured worktree root review regressions', () => {
  it('creates in the configured root and can remove a legacy worktree after a root change', () => {
    const fixture = repoFixture();
    const service = new WorktreeService(fixture.config);
    const created = service.create({
      projectPath: fixture.repo,
      projectId: fixture.project.id,
      projectSettings: fixture.project.settings,
      slug: 'new-task',
      branch: 'agenthub/new-task',
      baseRef: 'main',
    });
    expect(created).toBe(path.join(fixture.configuredRoot, 'new-task'));

    const legacy = path.join(fixture.worktreesDir, fixture.project.id, 'old-task');
    fs.mkdirSync(path.dirname(legacy), { recursive: true });
    execFileSync('git', ['-C', fixture.repo, 'worktree', 'add', legacy, '-b', 'agenthub/old-task', 'main']);
    expect(service.remove(fixture.repo, legacy, undefined, projectWorktreeRoots(fixture.project, fixture.hubHome, fixture.worktreesDir))).toBe(true);
    expect(fs.existsSync(legacy)).toBe(false);
  });

  it('rejects reserved directory names before touching git', () => {
    const fixture = repoFixture();
    const service = new WorktreeService(fixture.config);
    expect(() => service.create({
      projectPath: fixture.repo,
      projectId: fixture.project.id,
      projectSettings: fixture.project.settings,
      slug: '.logs',
      branch: 'agenthub/logs',
      baseRef: 'main',
    })).toThrow(/tên dành riêng/);
  });
});
