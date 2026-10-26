import fs from 'node:fs';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DepartmentRepo, ProjectRepo, openDatabase } from '../src/db/index.js';
import { makeTestTempDir } from './temp.js';

const databases: Array<{ close: () => void }> = [];
const tempDirs: string[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function createDb() {
  const dir = makeTestTempDir('agenthub-department-');
  tempDirs.push(dir);
  const db = openDatabase(path.join(dir, 'hub.db'));
  databases.push(db);
  return db;
}

describe('departments', () => {
  it('creates the Chung default and assigns existing projects to it', () => {
    const db = createDb();
    const departments = new DepartmentRepo(db);
    const projects = new ProjectRepo(db);
    expect(departments.get('chung')).toMatchObject({ name: 'Chung' });
    expect(departments.get('chung')?.maxParallel).toBe(0);
    projects.insert({ id: 'p1', name: 'P1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 1 });
    expect(projects.get('p1')?.departmentId).toBe('chung');
  });

  it('migrates an untouched Chung limit of 3 to unlimited', () => {
    const db = createDb();
    db.prepare("UPDATE departments SET maxParallel = 3 WHERE id = 'chung'").run();
    db.prepare("UPDATE meta SET value = ? WHERE key = 'schema_version'").run(String(55));
    db.close();
    databases.pop();
    const reopened = openDatabase(path.join(tempDirs[0], 'hub.db'));
    databases.push(reopened);
    expect(new DepartmentRepo(reopened).get('chung')?.maxParallel).toBe(0);
  });

  it('manages profile assignments and moves projects back before deletion', () => {
    const db = createDb();
    const departments = new DepartmentRepo(db);
    const projects = new ProjectRepo(db);
    db.prepare("INSERT INTO profiles (name, engine, kind) VALUES ('worker', 'agy', 'isolated')").run();
    departments.insert({ id: 'eng', name: 'Engineering', priority: 2, maxParallel: 4, claudeDailyTokenBudget: 1000, telegramTopicId: null });
    departments.setProfiles('eng', [{ profileName: 'worker', share: 0.5 }]);
    expect(departments.profiles('eng')).toEqual([{ departmentId: 'eng', profileName: 'worker', share: 0.5 }]);
    projects.insert({ id: 'p1', name: 'P1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 1, departmentId: 'eng' });
    departments.delete('eng');
    expect(projects.get('p1')?.departmentId).toBe('chung');
  });

  it('counts Claude task usage for the current day by department', () => {
    const db = createDb();
    const departments = new DepartmentRepo(db);
    const projects = new ProjectRepo(db);
    departments.insert({ id: 'eng', name: 'Engineering', priority: 0, maxParallel: 2, claudeDailyTokenBudget: 100, telegramTopicId: null });
    projects.insert({ id: 'p1', name: 'P1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 1, departmentId: 'eng' });
    db.prepare("INSERT INTO tasks (id, projectId, slug, title) VALUES ('p1/task', 'p1', 'task', 'Task')").run();
    db.prepare("INSERT INTO claude_usage (sessionId, messageId, ts, turnId, model, input, output, cacheCreation, cacheRead, effective) VALUES ('s', 'm', datetime('now'), 'turn', 'claude', 0, 0, 0, 0, 75)").run();
    db.prepare("INSERT INTO claude_task_usage (taskId, sessionId, turnId, effectiveTokens) VALUES ('p1/task', 's', 'turn', 75)").run();
    expect(departments.claudeUsageToday('eng')).toBe(75);
    expect(departments.claudeUsageToday('chung')).toBe(0);
  });
});
