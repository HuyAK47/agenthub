import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { KnowledgeRepo, openDatabase } from '../src/db/index.js';
import { extractKnowledgeSection } from '../src/services/index.js';
import { WorktreeService } from '../src/worktrees/index.js';
import { buildProjectKnowledgeContext } from '../src/projects/knowledge-context.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

describe('project knowledge', () => {
  it('extracts the notes section from a DONE report', () => {
    expect(extractKnowledgeSection('## Tóm tắt\nDone\n\n## Ghi chú cho task sau\n- Dùng migration append-only.\n- Mock HTTP trong test.\n\n## Khác\nignore')).toBe('- Dùng migration append-only.\n- Mock HTTP trong test.');
    expect(extractKnowledgeSection('## Tóm tắt\nDone')).toBeNull();
  });

  it('stores, updates, pins and deletes entries', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-knowledge-')); dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    db.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
    db.prepare('INSERT INTO tasks (id, projectId, slug, title) VALUES (?, ?, ?, ?)').run('p/t', 'p', 't', 'Task');
    const repo = new KnowledgeRepo(db);
    const entry = repo.insert({ projectId: 'p', taskId: 'p/t', content: 'Important', pinned: true });
    expect(repo.getByProject('p')).toEqual([expect.objectContaining({ content: 'Important', pinned: 1 })]);
    expect(repo.update(entry.id, { content: 'Updated', pinned: false })).toEqual(expect.objectContaining({ content: 'Updated', pinned: 0 }));
    repo.delete(entry.id);
    expect(repo.getByProject('p')).toEqual([]);
    db.close();
  });

  it('writes bounded knowledge context for workers', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-knowledge-context-')); dirs.push(root);
    const service = new WorktreeService({ worktreesDir: path.join(root, 'worktrees'), hubHome: root } as never);
    const worktree = path.join(root, 'worktree'); fs.mkdirSync(worktree, { recursive: true });
    service.writeTaskFile(worktree, 'Task', false, undefined, [], 16000, [
      { taskId: 'p/t', content: 'First note', pinned: 1, createdAt: '' },
      { taskId: 'p/old', content: 'Second note', pinned: 0, createdAt: '' },
    ], 50);
    const content = fs.readFileSync(path.join(worktree, '.agenthub/context/knowledge.md'), 'utf8');
    expect(content.length).toBe(50);
    expect(content).toContain('# Sổ kiến thức');
  });

  it('writes and removes the worker review checklist context', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-checklist-context-')); dirs.push(root);
    const project = path.join(root, 'project');
    const worktree = path.join(root, 'worktree');
    fs.mkdirSync(path.join(project, 'docs'), { recursive: true });
    fs.mkdirSync(worktree, { recursive: true });
    fs.writeFileSync(path.join(project, 'docs', 'checklist.md'), 'Check migrations', 'utf8');
    const service = new WorktreeService({ worktreesDir: path.join(root, 'worktrees'), hubHome: root } as never);
    service.writeTaskFile(worktree, 'Task', false, undefined, [], 16000, [], 12000, [], project, ['docs/checklist.md']);
    const checklist = path.join(worktree, '.agenthub/context/review-checklist.md');
    expect(fs.readFileSync(checklist, 'utf8')).toContain('Check migrations');
    service.writeTaskFile(worktree, 'Task', false, undefined, [], 16000, [], 12000, [], project, []);
    expect(fs.existsSync(checklist)).toBe(false);
  });

  it('builds bounded brain context from pinned notes and injected references', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-knowledge-')); dirs.push(root);
    const reference = path.join(root, 'mistakes.md');
    fs.writeFileSync(reference, 'Không bỏ qua lỗi quota.', 'utf8');
    const result = buildProjectKnowledgeContext([
      { id: 1, projectId: 'p', taskId: 'p/t', content: 'Pinned rule', createdAt: '', pinned: 1 },
      { id: 2, projectId: 'p', taskId: 'p/u', content: 'Unpinned note', createdAt: '', pinned: 0 },
    ], [{ name: 'mistakes', path: reference, inject: true }]);
    expect(result.text).toContain('Pinned rule');
    expect(result.text).toContain('Không bỏ qua lỗi quota.');
    expect(result.text).not.toContain('Unpinned note');
    expect(result.hash).toHaveLength(64);
  });

  it('resolves relative references from the project and reports byte limits', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-knowledge-limits-')); dirs.push(root);
    fs.mkdirSync(path.join(root, 'docs'));
    fs.writeFileSync(path.join(root, 'docs', 'ok.md'), 'đúng', 'utf8');
    fs.writeFileSync(path.join(root, 'large.md'), 'x'.repeat(64 * 1024 + 1), 'utf8');
    const result = buildProjectKnowledgeContext([], [
      { name: 'ok', path: 'docs/ok.md', inject: true },
      { name: 'large', path: 'large.md', inject: true },
    ], 128 * 1024, root);
    expect(result.text).toContain('đúng');
    expect(result.text).toContain('vượt giới hạn 64KB');
    expect(result.truncated).toContain('large.md');
    expect(Buffer.byteLength(result.text, 'utf8')).toBeLessThanOrEqual(128 * 1024);
  });

  it('cuts at a UTF-8 byte boundary and changes hash when content changes', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-knowledge-utf8-')); dirs.push(root);
    const file = path.join(root, 'notes.md');
    fs.writeFileSync(file, '😀'.repeat(80), 'utf8');
    const first = buildProjectKnowledgeContext([], [{ name: 'notes', path: 'notes.md', inject: true }], 180, root);
    fs.writeFileSync(file, '😃'.repeat(80), 'utf8');
    const second = buildProjectKnowledgeContext([], [{ name: 'notes', path: 'notes.md', inject: true }], 180, root);
    expect(Buffer.byteLength(first.text, 'utf8')).toBeLessThanOrEqual(180);
    expect(first.hash).not.toBe(second.hash);
  });
});
