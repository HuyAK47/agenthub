import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MIGRATIONS, openDatabase } from '../src/db/index.js';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('database migrations', () => {
  it('adds chat state when reopening a database at the previous latest schema version', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-state-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    for (let version = 0; version < MIGRATIONS.length - 1; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
    }
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").pluck().get()).toBe(String(MIGRATIONS.length - 1));
    expect(db.prepare('PRAGMA table_info(chat_sessions)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: 'state' })]),
    );
    db.close();
  });

  it('migrates a populated schema 0-6 database without breaking check_results foreign keys', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-migration-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');
    const oldDb = new Database(dbPath);
    oldDb.pragma('foreign_keys = ON');

    for (let version = 0; version <= 6; version += 1) {
      oldDb.exec(MIGRATIONS[version]);
      oldDb.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(String(version));
      if (version === 0) {
        oldDb.prepare('INSERT INTO projects (id, name, path) VALUES (?, ?, ?)').run('p', 'Project', dir);
        oldDb.prepare('INSERT INTO profiles (name, engine, kind) VALUES (?, ?, ?)').run('profile', 'agy', 'isolated');
        oldDb.prepare('INSERT INTO tasks (id, projectId, slug, title) VALUES (?, ?, ?, ?)').run('p/task', 'p', 'task', 'Task');
        oldDb.prepare('INSERT INTO runs (id, taskId, engine, model, profileName) VALUES (?, ?, ?, ?, ?)').run('run-1', 'p/task', 'agy', 'gemini-3.8-flash-low', 'profile');
      }
      if (version === 2) {
        oldDb.prepare('INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt) VALUES (?, ?, ?, ?, ?, ?)').run('profile', 'gemini', '5h', 50, 100, 100);
      }
      if (version === 3) {
        oldDb.prepare('INSERT INTO check_results (taskId, runId, name, ok, exitCode, durationMs, outputTail) VALUES (?, ?, ?, ?, ?, ?, ?)').run('p/task', 'run-1', 'lint', 1, 0, 10, 'ok');
      }
      if (version === 5) {
        oldDb.prepare('INSERT INTO chat_sessions (id, projectId) VALUES (?, ?)').run('session-1', 'p');
        oldDb.prepare('INSERT INTO chat_messages (id, sessionId, role, content) VALUES (?, ?, ?, ?)').run('message-1', 'session-1', 'user', 'hello');
      }
    }
    oldDb.close();

    const db = openDatabase(dbPath);
    expect(db.prepare('SELECT value FROM meta WHERE key = \'schema_version\'').pluck().get()).toBe(String(MIGRATIONS.length - 1));
    expect(db.prepare('SELECT COUNT(*) AS count FROM projects').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM tasks').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT COUNT(*) AS count FROM runs').get()).toMatchObject({ count: 1 });
    expect(db.prepare('SELECT outcome, reason FROM runs WHERE id = \'run-1\'').get()).toEqual({ outcome: null, reason: null });
    expect(db.prepare('SELECT waitReason FROM tasks WHERE id = \'p/task\'').get()).toEqual({ waitReason: null });
    expect(db.prepare('SELECT COUNT(*) AS count FROM check_results').get()).toMatchObject({ count: 1 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_key_list(check_results)').all()).toEqual(
      expect.arrayContaining([expect.objectContaining({ table: 'runs' })]),
    );
    db.close();
  });
});
