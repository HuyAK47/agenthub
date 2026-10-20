import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { mergeTaskIntoBase, MergeError } from '../src/merge.js';

const tempDirs: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
}

function fixture(): { root: string; integration: string; branch: string; before: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-merge-'));
  tempDirs.push(root);
  git(root, 'init');
  git(root, 'checkout', '-b', 'main');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'AgentHub Test');
  fs.writeFileSync(path.join(root, 'file.txt'), 'base\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-m', 'base');
  git(root, 'branch', 'agenthub/task');
  git(root, 'checkout', 'agenthub/task');
  git(root, 'worktree', 'add', path.join(root, 'integration'), 'main');
  const branch = 'agenthub/task';
  fs.writeFileSync(path.join(root, 'file.txt'), 'worker\n');
  git(root, 'add', 'file.txt');
  git(root, 'commit', '-m', 'worker change');
  const before = git(path.join(root, 'integration'), 'rev-parse', 'HEAD');
  return { root, integration: path.join(root, 'integration'), branch, before };
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('mergeTaskIntoBase', () => {
  it('merges cleanly and runs configured checks', async () => {
    const f = fixture();
    const result = await mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['node -e "process.exit(0)"'], timeoutSec: 30 }) },
    );
    expect(result.mergeCommit).not.toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
    expect(git(f.integration, 'log', '-1', '--pretty=%s')).toContain('Merge branch');
  });

  it('aborts a conflict and leaves the integration worktree clean', async () => {
    const f = fixture();
    git(f.integration, 'checkout', '-b', 'integration-change');
    fs.writeFileSync(path.join(f.integration, 'file.txt'), 'integration\n');
    git(f.integration, 'add', 'file.txt');
    git(f.integration, 'commit', '-m', 'integration change');
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: [], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({ statusCode: 409 });
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
    expect(git(f.integration, 'rev-parse', 'HEAD')).not.toBe(f.before);
  });

  it('rolls back only the merge commit when checks fail', async () => {
    const f = fixture();
    await expect(mergeTaskIntoBase(
      { slug: 'task', branch: f.branch, baseRef: 'main' },
      { defaultBranch: 'main', merge: JSON.stringify({ enabled: true, worktrees: { main: f.integration }, checks: ['node -e "process.exit(1)"'], timeoutSec: 30 }) },
    )).rejects.toMatchObject<Partial<MergeError>>({ statusCode: 422 });
    expect(git(f.integration, 'rev-parse', 'HEAD')).toBe(f.before);
    expect(git(f.integration, 'status', '--porcelain')).toBe('');
  });
});
