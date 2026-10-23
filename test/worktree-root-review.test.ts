import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorktreeService } from '../src/worktrees/index.js';
import { projectWorktreeRoots, validateProjectWorktreeRoot } from '../src/projects/paths.js';
import { ensureIntegrationWorktree, getIntegrationPath, removeIntegrationWorktree } from '../src/projects/integration.js';

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

  it('creates and removes the integration worktree under a configured root', () => {
    const fixture = repoFixture();
    const project = { ...fixture.project, defaultBranch: 'main' };
    expect(getIntegrationPath(project, fixture.hubHome)).toBe(path.join(fixture.configuredRoot, '.integration'));
    expect(ensureIntegrationWorktree(project, fixture.hubHome)).toBe(path.join(fixture.configuredRoot, '.integration'));
    expect(removeIntegrationWorktree(project, fixture.hubHome)).toBeNull();
    expect(fs.existsSync(path.join(fixture.configuredRoot, '.integration'))).toBe(false);
  });

  it('does not create a configured worktree root when the mount is unavailable', () => {
    const fixture = repoFixture();
    const missingRoot = path.join(fixture.root, 'not-mounted');
    const project = { ...fixture.project, settings: JSON.stringify({ worktree: { root: missingRoot } }) };
    const service = new WorktreeService(fixture.config);
    expect(() => service.create({
      projectPath: fixture.repo,
      projectId: project.id,
      projectSettings: project.settings,
      slug: 'waiting-task',
      branch: 'agenthub/waiting-task',
      baseRef: 'main',
    })).toThrow(/root không truy cập được/);
    expect(fs.existsSync(missingRoot)).toBe(false);
    expect(() => ensureIntegrationWorktree({ ...project, defaultBranch: 'main' }, fixture.hubHome)).toThrow(/root không truy cập được/);
    expect(fs.existsSync(missingRoot)).toBe(false);
  });

  it('refuses to remove an integration symlink that escapes the configured root', () => {
    const fixture = repoFixture();
    const outside = path.join(fixture.root, 'outside');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, path.join(fixture.configuredRoot, '.integration'));
    const project = { ...fixture.project, defaultBranch: 'main' };
    expect(removeIntegrationWorktree(project, fixture.hubHome)).toMatch(/không an toàn/);
    expect(fs.existsSync(outside)).toBe(true);
  });

  it('validates dangerous, unignored, and ignored roots without using the real HOME', () => {
    const fixture = repoFixture();
    const fakeHome = path.join(fixture.root, 'home');
    fs.mkdirSync(fakeHome);
    const homedir = vi.spyOn(os, 'homedir').mockReturnValue(fakeHome);
    try {
      const check = (root: string) => expect(() => validateProjectWorktreeRoot(root, fixture.repo, path.join(fixture.root, 'other-hub'))).toThrow();
      check(fakeHome);
      check(path.join(fixture.root, 'other-hub'));
      check(path.parse(fixture.root).root);
      check(fixture.root);
      check(path.join(fixture.repo, 'unignored-root'));

      const fileRoot = path.join(fixture.root, 'not-a-directory');
      fs.writeFileSync(fileRoot, 'not a directory');
      check(fileRoot);

      fs.writeFileSync(path.join(fixture.repo, '.gitignore'), 'ignored-root/\n');
      const ignoredRoot = path.join(fixture.repo, 'ignored-root');
      fs.mkdirSync(ignoredRoot);
      expect(() => validateProjectWorktreeRoot(ignoredRoot, fixture.repo, path.join(fixture.root, 'other-hub'))).not.toThrow();
    } finally {
      homedir.mockRestore();
    }
  });
});
