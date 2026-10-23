import { describe, expect, it, afterEach } from 'vitest';
import { openDatabase, EventRepo, ProjectRepo, TaskRepo, CiRepo } from '../src/db/index.js';

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

  it('uses the selected sort value when continuing a cursor', () => {
    const { repo, db } = setup();
    const first = repo.page({ limit: 1, sort: 'slug' });
    expect(first.items.map((task) => task.slug)).toEqual(['c']);
    db.prepare("INSERT INTO tasks (id, projectId, slug, title, level, dependsOn, createdAt, updatedAt) VALUES ('p1~z', 'p1', 'z', 'New', 'easy', '[]', '2026-02-01', '2026-02-01')").run();
    const second = repo.page({ limit: 1, sort: 'slug', cursor: first.nextCursor! });
    expect(second.items.map((task) => task.slug)).toEqual(['b']);
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

  it('supports an offset for the first event page before switching to a cursor', () => {
    const db = openDatabase(':memory:');
    databases.push(db);
    const repo = new EventRepo(db);
    for (let index = 0; index < 3; index += 1) repo.insert(`event.${index}`);

    const offsetPage = repo.page({ limit: 1, offset: 1 });
    expect(offsetPage.total).toBe(3);
    expect(offsetPage.items.map((event) => event.type)).toEqual(['event.1']);

    const cursorPage = repo.page({ limit: 1, cursor: offsetPage.nextCursor! });
    expect(cursorPage.items.map((event) => event.type)).toEqual(['event.0']);
  });
});

describe('CiRepo.pageByProject', () => {
  it('uses a stable run cursor and reports the filtered total', () => {
    const db = openDatabase(':memory:');
    const repo = new CiRepo(db);
    const projects = new ProjectRepo(db);
    for (const id of ['p1', 'p2']) projects.insert({ id, name: id, path: `/tmp/${id}`, defaultBranch: 'main', envTemplate: null, maxParallel: 1 });
    for (const runId of [1, 2, 3]) {
      repo.insert({ projectId: 'p1', runId, workflow: 'ci', sha: `sha-${runId}`, status: 'completed', conclusion: 'success', jobs: '[]', completedAt: '2026-01-01' });
    }
    repo.insert({ projectId: 'p2', runId: 99, workflow: 'ci', sha: 'other', status: 'completed', conclusion: 'success', jobs: '[]', completedAt: '2026-01-01' });
    const first = repo.pageByProject('p1', { limit: 1 });
    expect(first.total).toBe(3);
    expect(first.items.map((row) => row.runId)).toEqual([3]);
    const page = repo.pageByProject('p1', { limit: 1, cursor: first.nextCursor! });
    expect(page.items.map((row) => row.runId)).toEqual([2]);
    expect(() => repo.pageByProject('p1', { limit: 1, cursor: 'broken' })).toThrow('Invalid pagination cursor');
    db.close();
  });
});
