import { describe, expect, it, afterEach } from 'vitest';
import { openDatabase, ProjectRepo, TaskRepo } from '../src/db/index.js';

describe('TaskRepo.page', () => {
  const databases: ReturnType<typeof openDatabase>[] = [];

  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  function setup() {
    const db = openDatabase(':memory:');
    databases.push(db);
    new ProjectRepo(db).insert({ id: 'p1', name: 'Project', path: '/tmp/project', defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    const repo = new TaskRepo(db);
    for (const [index, row] of [
      ['a', 'queued', 'Đăng nhập tài khoản'],
      ['b', 'running', 'Build frontend'],
      ['c', 'done', 'Đăng xuất tài khoản'],
    ].entries()) {
      repo.insert({ id: `p1~${row[0]}`, projectId: 'p1', slug: row[0], title: row[2], status: row[1] });
      db.prepare('UPDATE tasks SET createdAt = ?, updatedAt = ? WHERE id = ?').run(`2026-01-0${index + 1}`, `2026-01-0${index + 1}`, `p1~${row[0]}`);
    }
    return { db, repo };
  }

  it('paginates with a stable cursor and total', () => {
    const { repo, db } = setup();
    const first = repo.page({ limit: 1 });
    expect(first.total).toBe(3);
    expect(first.items.map((task) => task.id)).toEqual(['p1~c']);
    db.prepare("INSERT INTO tasks (id, projectId, slug, title, level, dependsOn, createdAt, updatedAt) VALUES ('p1~new', 'p1', 'new', 'New', 'easy', '[]', '2026-02-01', '2026-02-01')").run();
    const second = repo.page({ limit: 1, cursor: first.nextCursor! });
    expect(second.items.map((task) => task.id)).toEqual(['p1~b']);
  });

  it('filters project/status and accent-insensitive escaped search', () => {
    const { repo, db } = setup();
    new ProjectRepo(db).insert({ id: 'p2', name: 'Other project', path: '/tmp/other-project', defaultBranch: 'main', envTemplate: null, maxParallel: 2 });
    repo.insert({ id: 'p2~same-slug', projectId: 'p2', slug: 'same-slug', title: 'Same slug in another project', status: 'running' });
    db.prepare("INSERT INTO tasks (id, projectId, slug, title, level, dependsOn) VALUES ('p1~underscore', 'p1', 'underscore', 'x_y literal', 'easy', '[]')").run();
    expect(repo.page({ project: 'p1', limit: 20 }).items.every((task) => task.projectId === 'p1')).toBe(true);
    expect(repo.page({ status: 'running', limit: 20 }).items.map((task) => task.id)).toEqual(['p2~same-slug', 'p1~b']);
    expect(repo.page({ search: 'dang nhap', limit: 20 }).items.map((task) => task.id)).toEqual(['p1~a']);
    expect(repo.page({ search: '%', limit: 20 }).items).toHaveLength(0);
    expect(repo.page({ search: '_', limit: 20 }).items.map((task) => task.slug)).toEqual(['underscore']);
  });

  it('rejects malformed cursors and keeps legacy list behavior separate', () => {
    const { repo } = setup();
    expect(() => repo.page({ limit: 1, cursor: 'not-a-cursor' })).toThrow('Invalid pagination cursor');
    expect(repo.list()).toHaveLength(3);
  });
});
