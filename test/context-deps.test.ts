import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WorktreeService } from '../src/worktrees/index.js';

describe('dependency context in worker files', () => {
  it('writes dependency context and prepends the read instruction', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });

      service.writeTaskFile(worktree, 'Do the task.', false, undefined, [{
        id: 'project/dep',
        title: 'Dependency task',
        doneContent: 'Implemented the dependency.',
        review: 'approved — Looks good.',
        diffStat: '  src/a.ts | 2 +-',
      }], 16000);

      expect(fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8'))
        .toBe('Đọc `.agenthub/context/deps.md` trước khi bắt đầu.\n\nDo the task.');
      const context = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(context).toContain('## Dependency task (project/dep)');
      expect(context).toContain('Implemented the dependency.');
      expect(context).toContain('approved — Looks good.');
      expect(context).toContain('src/a.ts | 2 +-');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('limits each DONE, diff lines, and total context size', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(worktree, { recursive: true });
      const diff = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n');

      service.writeTaskFile(worktree, 'Task', false, undefined, [{
        id: 'project/dep',
        title: 'Dependency',
        doneContent: 'D'.repeat(5000),
        diffStat: diff,
      }], 600);

      const context = fs.readFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'utf8');
      expect(context.length).toBeLessThanOrEqual(600);
      expect(context).toContain('[Đã cắt bớt context dependency');
      expect(context).not.toContain('line-60');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not leave dependency context for a task without dependencies', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-context-'));
    try {
      const service = new WorktreeService({
        worktreesDir: path.join(root, 'worktrees'),
        hubHome: root,
      } as never);
      const worktree = path.join(root, 'worktree');
      fs.mkdirSync(path.join(worktree, '.agenthub', 'context'), { recursive: true });
      fs.writeFileSync(path.join(worktree, '.agenthub', 'context', 'deps.md'), 'stale');

      service.writeTaskFile(worktree, 'Task', false);

      expect(fs.existsSync(path.join(worktree, '.agenthub', 'context', 'deps.md'))).toBe(false);
      expect(fs.readFileSync(path.join(worktree, '.agenthub', 'task.md'), 'utf8')).toBe('Task');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
