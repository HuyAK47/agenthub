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

describe('Migration 44 (assistant sessions + brain_directives)', () => {
  it('preserves existing sessions and messages after table rebuild', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-mig44-'));
    dirs.push(dir);
    const dbPath = path.join(dir, 'hub.db');

    // Build DB up to migration 43 (schema_version = 43).
    const legacy = new Database(dbPath);
    legacy.pragma('journal_mode = WAL');
    legacy.pragma('foreign_keys = ON');
    for (let i = 0; i <= 43; i++) legacy.exec(MIGRATIONS[i]);
    legacy.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', '43')").run();

    // Insert a project, a session, and a message that depends on the session via CASCADE.
    legacy.prepare("INSERT INTO projects (id, name, path) VALUES ('p1', 'proj', '/tmp/proj')").run();
    legacy.prepare(
      `INSERT INTO chat_sessions (id, projectId, claudeSessionId, title, mode, busy, model, state, profileName, pinned, archived, lastMessageAt, inputTokens, outputTokens, contextTokens, waitingLimitResetAt, kind)
       VALUES ('s1', 'p1', 'cs1', 'Test Session', 'safe', 0, 'sonnet', 'idle', 'default', 0, 0, '2026-01-01', 100, 200, 300, NULL, 'chat')`,
    ).run();
    legacy.prepare(
      "INSERT INTO chat_messages (id, sessionId, role, content) VALUES ('m1', 's1', 'user', 'hello world')",
    ).run();
    legacy.close();

    // Open with openDatabase which runs remaining migrations (44).
    const db = openDatabase(dbPath);
    const version = db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as { value: string };
    expect(Number(version.value)).toBe(MIGRATIONS.length - 1);

    // Session survived the rebuild.
    const session = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get('s1') as Record<string, unknown>;
    expect(session).toBeDefined();
    expect(session.title).toBe('Test Session');
    expect(session.projectId).toBe('p1');
    expect(session.kind).toBe('chat');
    expect(session.inputTokens).toBe(100);
    expect(session.outputTokens).toBe(200);
    expect(session.contextTokens).toBe(300);
    expect(session.model).toBe('sonnet');

    // Message survived (ON DELETE CASCADE kept it because the session survived).
    const msg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get('m1') as Record<string, unknown>;
    expect(msg).toBeDefined();
    expect(msg.content).toBe('hello world');
    expect(msg.sessionId).toBe('s1');

    // kind = 'assistant' can now be inserted.
    db.prepare(
      `INSERT INTO chat_sessions (id, projectId, title, mode, model, kind)
       VALUES ('s2', 'p1', 'Assistant', 'safe', 'sonnet', 'assistant')`,
    ).run();
    const assistant = db.prepare('SELECT kind FROM chat_sessions WHERE id = ?').get('s2') as { kind: string };
    expect(assistant.kind).toBe('assistant');

    // brain_directives table exists and accepts rows.
    db.prepare(
      "INSERT INTO brain_directives (id, projectId, text, createdBy) VALUES ('d1', 'p1', 'test directive', 'user')",
    ).run();
    const directive = db.prepare('SELECT * FROM brain_directives WHERE id = ?').get('d1') as Record<string, unknown>;
    expect(directive).toBeDefined();
    expect(directive.text).toBe('test directive');

    db.close();
  });
});
