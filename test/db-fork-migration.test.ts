import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { MIGRATIONS, openDatabase } from '../src/db/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function columns(db: Database.Database, table: string): string[] {
  return (db.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map((r) => r.name);
}

describe('DB migrated by the fork (avatarUrl used migration number 41)', () => {
  it('re-runs upstream migration 41 and keeps avatars', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fork-db-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    // Trạng thái DB sau khi chạy bản fork: migration 0..40 của upstream + avatarUrl ghi là 41.
    const legacy = new Database(dbPath);
    for (let i = 0; i <= 40; i++) legacy.exec(MIGRATIONS[i]);
    legacy.exec('ALTER TABLE profiles ADD COLUMN avatarUrl TEXT');
    legacy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '41')").run();
    legacy.prepare("INSERT INTO profiles (name, engine, kind, avatarUrl) VALUES ('g1', 'agy', 'isolated', 'https://x/a.png')").run();
    legacy.close();

    const db = openDatabase(dbPath);
    expect(columns(db, 'projects')).toContain('settings');
    expect(columns(db, 'brain_turns')).toContain('projectId');
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(MIGRATIONS.length - 1) });
    expect(db.prepare("SELECT avatarUrl FROM profiles WHERE name = 'g1'").get()).toEqual({ avatarUrl: 'https://x/a.png' });
    db.close();
  });

  it('adds avatarUrl to a fresh upstream DB without taking a migration number', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fresh-db-'));
    dirs.push(dir);
    const db = openDatabase(path.join(dir, 'hub.db'));
    expect(columns(db, 'profiles')).toContain('avatarUrl');
    expect(MIGRATIONS.some((sql) => sql.includes('avatarUrl'))).toBe(false);
    db.close();
  });
});
