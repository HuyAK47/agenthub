import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DepartmentRepo, ProjectRepo, openDatabase } from '../src/db/index.js';

const databases: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function createDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-department-'));
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
    projects.insert({ id: 'p1', name: 'P1', path: '/tmp/p1', defaultBranch: 'main', maxParallel: 1 });
    expect(projects.get('p1')?.departmentId).toBe('chung');
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
});
