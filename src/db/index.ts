import Database from 'better-sqlite3';

export const MIGRATIONS: string[] = [
  // Migration 0: initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    defaultBranch TEXT NOT NULL DEFAULT 'main',
    envTemplate TEXT, -- JSON
    maxParallel INTEGER NOT NULL DEFAULT 3,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS profiles (
    name TEXT PRIMARY KEY,
    engine TEXT NOT NULL CHECK(engine IN ('agy', 'codex')),
    kind TEXT NOT NULL CHECK(kind IN ('keyring', 'isolated', 'codex')),
    home TEXT,
    email TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS quota_marks (
    profileName TEXT NOT NULL,
    family TEXT NOT NULL,
    until INTEGER NOT NULL, -- epoch seconds
    reason TEXT,
    PRIMARY KEY (profileName, family),
    FOREIGN KEY (profileName) REFERENCES profiles(name)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY, -- projectId/slug
    projectId TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy', 'hard')),
    modelChain TEXT, -- JSON array or null
    baseRef TEXT,
    branch TEXT,
    worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota')),
    dependsOn TEXT NOT NULL DEFAULT '[]', -- JSON array of task ids
    attempt INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS task_deps (
    taskId TEXT NOT NULL,
    dependsOnId TEXT NOT NULL,
    PRIMARY KEY (taskId, dependsOnId),
    FOREIGN KEY (taskId) REFERENCES tasks(id),
    FOREIGN KEY (dependsOnId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    profileName TEXT NOT NULL,
    pid INTEGER,
    startedAt TEXT NOT NULL DEFAULT (datetime('now')),
    endedAt TEXT,
    outcome TEXT CHECK(outcome IN ('done','blocked','quota','crashed','cancelled','timeout','stalled')),
    logPath TEXT,
    resetAt INTEGER,
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS reviews (
    id TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    verdict TEXT NOT NULL CHECK(verdict IN ('approved', 'changes_requested')),
    feedback TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );

  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts TEXT NOT NULL DEFAULT (datetime('now')),
    type TEXT NOT NULL,
    taskId TEXT,
    payload TEXT -- JSON
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  INSERT OR IGNORE INTO meta (key, value) VALUES ('schema_version', '0');
  `,
  // Migration 1: scheduler recovery, retry and slot state
  `
  ALTER TABLE tasks ADD COLUMN notBefore INTEGER;
  ALTER TABLE tasks ADD COLUMN transientRetries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN slot INTEGER;
  ALTER TABLE runs ADD COLUMN pidStart INTEGER;
  `,
  // Migration 2: live quota usage snapshots
  `
  CREATE TABLE IF NOT EXISTS quota_usage (
    profileName TEXT NOT NULL,
    grp TEXT NOT NULL,
    window TEXT NOT NULL CHECK(window IN ('5h', 'week')),
    remainingPct INTEGER NOT NULL,
    resetAt INTEGER NOT NULL,
    fetchedAt INTEGER NOT NULL,
    PRIMARY KEY (profileName, grp, window),
    FOREIGN KEY (profileName) REFERENCES profiles(name)
  );
  `,
  // Migration 3: project checks and persisted results
  `
  ALTER TABLE projects ADD COLUMN checks TEXT;
  ALTER TABLE tasks ADD COLUMN checkFixAttempts INTEGER NOT NULL DEFAULT 0;
  CREATE TABLE IF NOT EXISTS check_results (taskId TEXT NOT NULL, runId TEXT NOT NULL, name TEXT NOT NULL, ok INTEGER NOT NULL, exitCode INTEGER, durationMs INTEGER NOT NULL, outputTail TEXT NOT NULL, FOREIGN KEY (taskId) REFERENCES tasks(id), FOREIGN KEY (runId) REFERENCES runs(id));
  `,
  // Migration 4: brain status
  `
  CREATE TABLE IF NOT EXISTS brain_status (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    activity TEXT NOT NULL,
    detail TEXT NOT NULL,
    taskId TEXT,
    updatedAt TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT OR IGNORE INTO brain_status (id, activity, detail, taskId, updatedAt)
  VALUES (1, 'idle', '', NULL, datetime('now'));
  `,
  // Migration 5: chat sessions and messages
  `
  CREATE TABLE IF NOT EXISTS chat_sessions (
    id TEXT PRIMARY KEY,
    projectId TEXT,
    claudeSessionId TEXT,
    title TEXT,
    mode TEXT NOT NULL DEFAULT 'safe' CHECK(mode IN ('safe','full')),
    busy INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );

  CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user','assistant','tool','error')),
    content TEXT NOT NULL,
    meta TEXT, -- JSON
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  `,
  // Migration 6: chat model per session
  `
  ALTER TABLE chat_sessions ADD COLUMN model TEXT NOT NULL DEFAULT '';
  `,
  // Migration 7: preserve foreign keys while recording stalled runs
  `
  ALTER TABLE runs ADD COLUMN reason TEXT;
  `,
  // Migration 8: profile auth state and verification URL
  `
  ALTER TABLE profiles ADD COLUMN authState TEXT CHECK(authState IS NULL OR authState IN ('ok', 'not_logged_in', 'needs_verification', 'error'));
  ALTER TABLE profiles ADD COLUMN authMessage TEXT;
  ALTER TABLE profiles ADD COLUMN verifyUrl TEXT;
  `,
  // Migration 9: checking status in tasks
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    slug TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT,
    level TEXT NOT NULL DEFAULT 'easy' CHECK(level IN ('easy', 'hard')),
    modelChain TEXT,
    baseRef TEXT,
    branch TEXT,
    worktreePath TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','queued','running','checking','review','done','blocked','failed','cancelled','waiting_quota')),
    dependsOn TEXT NOT NULL DEFAULT '[]',
    attempt INTEGER NOT NULL DEFAULT 0,
    resume INTEGER NOT NULL DEFAULT 0,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    updatedAt TEXT NOT NULL DEFAULT (datetime('now')),
    notBefore INTEGER,
    transientRetries INTEGER NOT NULL DEFAULT 0,
    slot INTEGER,
    checkFixAttempts INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  INSERT INTO tasks_new (id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath, status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot, checkFixAttempts)
    SELECT id, projectId, slug, title, body, level, modelChain, baseRef, branch, worktreePath, status, dependsOn, attempt, resume, createdAt, updatedAt, notBefore, transientRetries, slot, checkFixAttempts FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;
  PRAGMA foreign_keys = ON;
  `,
  // Migration 10: identify the reviewer that produced each decision
  `
  ALTER TABLE reviews ADD COLUMN actor TEXT NOT NULL DEFAULT 'claude';
  `,
  // Migration 11: distinguish durable reviewer runs from worker runs
  `
  ALTER TABLE runs ADD COLUMN kind TEXT NOT NULL DEFAULT 'worker' CHECK(kind IN ('worker', 'reviewer'));
  `,
  // Migration 12: persist reviewer loop protection and manual escalation state
  `
  ALTER TABLE tasks ADD COLUMN reviewerChangesRequested INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reviewerEscalated INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN reviewerEscalatedAt TEXT;
  ALTER TABLE tasks ADD COLUMN reviewerEscalationReason TEXT;
  `,
  // Migration 13: run metrics for savings calculation
  `
  CREATE TABLE IF NOT EXISTS run_metrics (
    runId TEXT PRIMARY KEY,
    taskId TEXT NOT NULL,
    engine TEXT NOT NULL,
    model TEXT NOT NULL,
    profileName TEXT NOT NULL,
    tokensUsed INTEGER,
    usageBefore INTEGER,
    usageAfter INTEGER,
    linesAdded INTEGER NOT NULL DEFAULT 0,
    linesDeleted INTEGER NOT NULL DEFAULT 0,
    filesChanged INTEGER NOT NULL DEFAULT 0,
    durationMs INTEGER,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (runId) REFERENCES runs(id),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
  `,
  // Migration 14: Claude Code session usage
  `
  CREATE TABLE IF NOT EXISTS claude_scan_state (
    path TEXT PRIMARY KEY, inode INTEGER NOT NULL, size INTEGER NOT NULL,
    offset INTEGER NOT NULL, mtime INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS claude_sessions (
    sessionId TEXT PRIMARY KEY, cwd TEXT NOT NULL, title TEXT, firstAt TEXT,
    lastAt TEXT, model TEXT, messages INTEGER NOT NULL DEFAULT 0,
    inputTokens INTEGER NOT NULL DEFAULT 0, outputTokens INTEGER NOT NULL DEFAULT 0,
    cacheCreationTokens INTEGER NOT NULL DEFAULT 0, cacheReadTokens INTEGER NOT NULL DEFAULT 0,
    effectiveTokens REAL NOT NULL DEFAULT 0, isHubChat INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS claude_usage (
    sessionId TEXT NOT NULL, messageId TEXT NOT NULL, ts TEXT NOT NULL,
    turnId TEXT NOT NULL, model TEXT, input INTEGER NOT NULL, output INTEGER NOT NULL,
    cacheCreation INTEGER NOT NULL, cacheRead INTEGER NOT NULL, effective REAL NOT NULL,
    isSidechain INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(sessionId, messageId)
  );
  CREATE TABLE IF NOT EXISTS claude_task_usage (
    taskId TEXT NOT NULL, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
    effectiveTokens REAL NOT NULL, PRIMARY KEY(taskId, sessionId, turnId)
  );
  CREATE TABLE IF NOT EXISTS claude_quota (
    id INTEGER PRIMARY KEY CHECK(id = 1), status TEXT, resetsAt INTEGER,
    rateLimitType TEXT, isUsingOverage INTEGER NOT NULL DEFAULT 0, observedAt TEXT NOT NULL
  );
  `,
  // Migration 15: resume attribution state without splitting an in-progress turn
  `
  ALTER TABLE claude_scan_state ADD COLUMN turnId TEXT NOT NULL DEFAULT '';
  ALTER TABLE claude_scan_state ADD COLUMN turnTasks TEXT NOT NULL DEFAULT '[]';
  ALTER TABLE claude_scan_state ADD COLUMN eligible INTEGER NOT NULL DEFAULT 1;
  `,
  // Migration 16: task wait reason
  `
  ALTER TABLE tasks ADD COLUMN waitReason TEXT CHECK(waitReason IS NULL OR waitReason IN ('disk', 'quota', 'parallel', 'profile_busy'));
  `,
  // Migration 17: project hooks (e.g. onWorktreeRemoved)
  `
  ALTER TABLE projects ADD COLUMN hooks TEXT;
  `,
  // Migration 18: automatic merge configuration
  `
  ALTER TABLE projects ADD COLUMN merge TEXT;
  `,
  // Migration 19: explicit chat lifecycle state
  `
  ALTER TABLE chat_sessions ADD COLUMN state TEXT NOT NULL DEFAULT 'idle'
    CHECK(state IN ('idle','running','waiting_permission','error'));
  `,
  // Migration 20: Claude Code profiles and chat account selection
  `
  PRAGMA foreign_keys = OFF;
  CREATE TABLE profiles_new (
    name TEXT PRIMARY KEY,
    engine TEXT NOT NULL CHECK(engine IN ('agy', 'codex', 'claude')),
    kind TEXT NOT NULL CHECK(kind IN ('keyring', 'isolated', 'codex', 'system')),
    home TEXT,
    email TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    authState TEXT CHECK(authState IS NULL OR authState IN ('ok', 'not_logged_in', 'needs_verification', 'error')),
    authMessage TEXT,
    verifyUrl TEXT
  );
  INSERT INTO profiles_new (name, engine, kind, home, email, enabled, createdAt, authState, authMessage, verifyUrl)
    SELECT name, engine, kind, home, email, enabled, createdAt, authState, authMessage, verifyUrl FROM profiles;
  DROP TABLE profiles;
  ALTER TABLE profiles_new RENAME TO profiles;
  PRAGMA foreign_keys = ON;
  ALTER TABLE chat_sessions ADD COLUMN profileName TEXT;
  `,
  // Migration 21: chat permission requests
  `
  CREATE TABLE IF NOT EXISTS chat_permissions (
    id TEXT PRIMARY KEY,
    sessionId TEXT NOT NULL,
    messageId TEXT,
    toolName TEXT NOT NULL,
    input TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('pending','allow','deny','allow_always')),
    message TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    resolvedAt TEXT,
    FOREIGN KEY (sessionId) REFERENCES chat_sessions(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS chat_permissions_pending_idx ON chat_permissions(sessionId, status, createdAt);
  `,
  // Migration 22: chat session metadata, token tracking, and message indexing
  `
  ALTER TABLE chat_sessions ADD COLUMN pinned INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN lastMessageAt TEXT;
  ALTER TABLE chat_sessions ADD COLUMN inputTokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN outputTokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE chat_sessions ADD COLUMN contextTokens INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX IF NOT EXISTS idx_chat_messages_session_created ON chat_messages(sessionId, createdAt);
  UPDATE chat_sessions SET lastMessageAt = (SELECT MAX(createdAt) FROM chat_messages WHERE sessionId = chat_sessions.id);
  `,
  // Migration 23: soft-deleted profiles (hidden and never scheduled; run history keeps the name)
  `
  ALTER TABLE profiles ADD COLUMN deletedAt TEXT;
  `,
  // Migration 24: task notes and overlaps
  `
  CREATE TABLE IF NOT EXISTS task_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('note', 'overlap')),
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id),
    FOREIGN KEY (taskId) REFERENCES tasks(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_notes_project ON task_notes(projectId, id);
  CREATE INDEX IF NOT EXISTS idx_task_notes_task ON task_notes(taskId, id);
  `,
  // Migration 25: persist dependency context before worktrees are cleaned up
  `
  ALTER TABLE tasks ADD COLUMN doneReport TEXT;
  ALTER TABLE tasks ADD COLUMN diffStat TEXT;
  `,
  // Migration 26: task provenance for captured errors
  `ALTER TABLE tasks ADD COLUMN sourceRef TEXT;`,
  // Migration 27: project knowledge entries
  `
  CREATE TABLE IF NOT EXISTS knowledge_entries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    projectId TEXT NOT NULL,
    taskId TEXT NOT NULL,
    content TEXT NOT NULL,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    pinned INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (projectId) REFERENCES projects(id),
    CHECK (length(taskId) > 0)
  );
  CREATE INDEX IF NOT EXISTS idx_knowledge_project ON knowledge_entries(projectId, pinned DESC, createdAt DESC);
  `,
  // Migration 28: task batches and batchId for tasks
  `
  CREATE TABLE IF NOT EXISTS task_batches (
    id TEXT PRIMARY KEY,
    projectId TEXT NOT NULL,
    title TEXT NOT NULL,
    goal TEXT,
    status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'dispatched', 'discarded')),
    createdBy TEXT,
    createdAt TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (projectId) REFERENCES projects(id)
  );
  CREATE INDEX IF NOT EXISTS idx_task_batches_project ON task_batches(projectId, createdAt DESC);
  ALTER TABLE tasks ADD COLUMN batchId TEXT;
  CREATE INDEX IF NOT EXISTS idx_tasks_batch ON tasks(batchId);
  `,
];

export function openDatabase(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Run migrations
  const versionRow = (() => {
    try {
      return db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get() as
        | { value: string }
        | undefined;
    } catch {
      return undefined;
    }
  })();

  const currentVersion = versionRow ? parseInt(versionRow.value, 10) : -1;

  for (let i = currentVersion + 1; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)").run(
      String(i),
    );
  }

  return db;
}

// Repository helpers
export interface ProjectHooks {
  onWorktreeRemoved?: string[];
}

export interface ProjectRow {
  id: string;
  name: string;
  path: string;
  defaultBranch: string;
  envTemplate: string | null;
  maxParallel: number;
  checks: string | null;
  hooks: string | null;
  merge?: string | null;
  createdAt: string;
}

export type ProfileAuthState = 'ok' | 'not_logged_in' | 'needs_verification' | 'error';

export interface ProfileRow {
  name: string;
  engine: 'agy' | 'codex' | 'claude';
  kind: 'keyring' | 'isolated' | 'codex' | 'system';
  home: string | null;
  email: string | null;
  enabled: number;
  createdAt: string;
  authState?: ProfileAuthState | null;
  authMessage?: string | null;
  verifyUrl?: string | null;
}

export interface QuotaMarkRow {
  profileName: string;
  family: string;
  until: number;
  reason: string | null;
}

export interface QuotaUsageRow {
  profileName: string;
  grp: string;
  window: '5h' | 'week';
  remainingPct: number;
  resetAt: number;
  fetchedAt: number;
}

export type WaitReason = 'disk' | 'quota' | 'parallel' | 'profile_busy' | null;

export interface TaskRow {
  id: string;
  projectId: string;
  slug: string;
  title: string;
  body: string | null;
  level: string;
  modelChain: string | null;
  baseRef: string | null;
  branch: string | null;
  worktreePath: string | null;
  sourceRef?: string | null;
  status: string;
  waitReason?: WaitReason;
  dependsOn: string;
  attempt: number;
  resume: number;
  notBefore: number | null;
  transientRetries: number;
  checkFixAttempts: number;
  reviewerChangesRequested?: number;
  reviewerEscalated?: number;
  reviewerEscalatedAt?: string | null;
  reviewerEscalationReason?: string | null;
  doneReport?: string | null;
  diffStat?: string | null;
  slot: number | null;
  batchId?: string | null;
  createdAt: string;
  updatedAt: string;
}

export type BatchStatus = 'draft' | 'dispatched' | 'discarded';

export interface TaskBatchRow {
  id: string;
  projectId: string;
  title: string;
  goal: string | null;
  status: BatchStatus;
  createdBy: string | null;
  createdAt: string;
}

export interface RunRow {
  id: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  pid: number | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string | null;
  reason: string | null;
  logPath: string | null;
  resetAt: number | null;
  pidStart: number | null;
  kind: 'worker' | 'reviewer';
}

export interface EventRow {
  id: number;
  ts: string;
  type: string;
  taskId: string | null;
  payload: string | null;
}

export class ProjectRepo {
  constructor(private db: Database.Database) {}

  getAll(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY id').all() as ProjectRow[];
  }

  get(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  insert(
    row: Omit<ProjectRow, 'createdAt' | 'checks' | 'hooks' | 'merge'> & {
      checks?: string | null;
      hooks?: string | null;
      merge?: string | null;
    },
  ): void {
    this.db
      .prepare(
        'INSERT INTO projects (id, name, path, defaultBranch, envTemplate, maxParallel, checks, hooks, merge) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.name,
        row.path,
        row.defaultBranch,
        row.envTemplate,
        row.maxParallel,
        row.checks || null,
        row.hooks || null,
        row.merge || null,
      );
  }

  update(
    id: string,
    fields: Partial<Pick<ProjectRow, 'name' | 'defaultBranch' | 'envTemplate' | 'maxParallel' | 'checks' | 'hooks' | 'merge'>>,
  ): void {
    const sets: string[] = [];
    const values: unknown[] = [];
    for (const [key, value] of Object.entries(fields)) {
      // A partial update must not clear columns the caller did not send.
      if (value === undefined) continue;
      sets.push(`${key} = ?`);
      values.push(value);
    }
    if (sets.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
  }
}

export class ProfileRepo {
  constructor(private db: Database.Database) {}

  getAll(): ProfileRow[] {
    return this.db.prepare('SELECT * FROM profiles WHERE deletedAt IS NULL ORDER BY name').all() as ProfileRow[];
  }

  get(name: string): ProfileRow | undefined {
    return this.db.prepare('SELECT * FROM profiles WHERE name = ?').get(name) as
      | ProfileRow
      | undefined;
  }

  upsert(row: Omit<ProfileRow, 'createdAt'>): void {
    this.db
      .prepare(
        `INSERT INTO profiles (name, engine, kind, home, email, enabled, authState, authMessage, verifyUrl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(name) DO UPDATE SET
           engine=excluded.engine,
           kind=excluded.kind,
           home=excluded.home,
           email=excluded.email,
           authState=COALESCE(excluded.authState, profiles.authState),
           authMessage=COALESCE(excluded.authMessage, profiles.authMessage),
           verifyUrl=COALESCE(excluded.verifyUrl, profiles.verifyUrl)`,
      )
      .run(
        row.name,
        row.engine,
        row.kind,
        row.home,
        row.email,
        row.enabled,
        row.authState ?? null,
        row.authMessage ?? null,
        row.verifyUrl ?? null,
      );
  }

  updateAuthState(
    name: string,
    authState: ProfileAuthState | null,
    authMessage: string | null = null,
    verifyUrl: string | null = null,
  ): void {
    this.db
      .prepare('UPDATE profiles SET authState = ?, authMessage = ?, verifyUrl = ? WHERE name = ?')
      .run(authState, authMessage, verifyUrl, name);
  }

  delete(name: string): void {
    this.db.prepare('DELETE FROM quota_marks WHERE profileName = ?').run(name);
    this.db.prepare('DELETE FROM quota_usage WHERE profileName = ?').run(name);
    this.db.prepare('DELETE FROM profiles WHERE name = ?').run(name);
  }

  /** Hide a profile without touching run history (runs.profileName references it). */
  softDelete(name: string): void {
    this.db.prepare("UPDATE profiles SET deletedAt = datetime('now'), enabled = 0 WHERE name = ?").run(name);
  }

  restore(name: string): void {
    this.db.prepare('UPDATE profiles SET deletedAt = NULL, enabled = 1 WHERE name = ?').run(name);
  }

  isDeleted(name: string): boolean {
    const row = this.db.prepare('SELECT deletedAt FROM profiles WHERE name = ?').get(name) as { deletedAt: string | null } | undefined;
    return !!row?.deletedAt;
  }

  updateEnabled(name: string, enabled: number): void {
    this.db.prepare('UPDATE profiles SET enabled = ? WHERE name = ?').run(enabled, name);
  }

  getEnabled(): ProfileRow[] {
    return this.db
      .prepare('SELECT * FROM profiles WHERE enabled = 1 AND deletedAt IS NULL ORDER BY name')
      .all() as ProfileRow[];
  }
}

export class QuotaMarkRepo {
  constructor(private db: Database.Database) {}

  getAll(): QuotaMarkRow[] {
    return this.db.prepare('SELECT * FROM quota_marks').all() as QuotaMarkRow[];
  }

  getActive(): QuotaMarkRow[] {
    const now = Math.floor(Date.now() / 1000);
    return this.db
      .prepare('SELECT * FROM quota_marks WHERE until > ?')
      .all(now) as QuotaMarkRow[];
  }

  mark(profileName: string, family: string, until: number, reason?: string): void {
    this.db
      .prepare(
        `INSERT INTO quota_marks (profileName, family, until, reason)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profileName, family) DO UPDATE SET until=excluded.until, reason=excluded.reason`,
      )
      .run(profileName, family, until, reason || null);
  }

  clear(profileName: string, family: string): void {
    this.db
      .prepare('DELETE FROM quota_marks WHERE profileName = ? AND family = ?')
      .run(profileName, family);
  }

  isExhausted(profileName: string, family: string): boolean {
    const now = Math.floor(Date.now() / 1000);
    const row = this.db
      .prepare('SELECT 1 FROM quota_marks WHERE profileName = ? AND family = ? AND until > ?')
      .get(profileName, family, now);
    return !!row;
  }
}

export class QuotaUsageRepo {
  constructor(private db: Database.Database) {}

  getForProfile(profileName: string): QuotaUsageRow[] {
    return this.db.prepare('SELECT * FROM quota_usage WHERE profileName = ? ORDER BY grp, window')
      .all(profileName) as QuotaUsageRow[];
  }

  getAll(): QuotaUsageRow[] {
    return this.db.prepare('SELECT * FROM quota_usage ORDER BY profileName, grp, window')
      .all() as QuotaUsageRow[];
  }

  deleteForProfile(profileName: string): void {
    this.db.prepare('DELETE FROM quota_usage WHERE profileName = ?').run(profileName);
  }

  deleteForEngine(engine: string): void {
    this.db.prepare(`
      DELETE FROM quota_usage
      WHERE profileName IN (SELECT name FROM profiles WHERE engine = ?)
         OR profileName = ?
    `).run(engine, engine);
  }

  upsert(row: QuotaUsageRow): void {
    this.db.prepare(`
      INSERT INTO quota_usage (profileName, grp, window, remainingPct, resetAt, fetchedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(profileName, grp, window) DO UPDATE SET
        remainingPct=excluded.remainingPct, resetAt=excluded.resetAt, fetchedAt=excluded.fetchedAt
    `).run(row.profileName, row.grp, row.window, row.remainingPct, row.resetAt, row.fetchedAt);
  }
}

export class TaskRepo {
  constructor(private db: Database.Database) {}

  getAll(): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks ORDER BY createdAt').all() as TaskRow[];
  }

  getByProject(projectId: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE projectId = ? ORDER BY createdAt')
      .all(projectId) as TaskRow[];
  }

  getByStatus(status: string): TaskRow[] {
    return this.db
      .prepare('SELECT * FROM tasks WHERE status = ? ORDER BY createdAt')
      .all(status) as TaskRow[];
  }

  getByBatch(batchId: string): TaskRow[] {
    return this.db.prepare('SELECT * FROM tasks WHERE batchId = ? ORDER BY createdAt').all(batchId) as TaskRow[];
  }

  get(id: string): TaskRow | undefined {
    return this.db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | undefined;
  }

  getDerivedFrom(sourceTaskId: string): TaskRow[] {
    return this.db.prepare("SELECT * FROM tasks WHERE json_extract(sourceRef, '$.taskId') = ? ORDER BY createdAt").all(sourceTaskId) as TaskRow[];
  }

  insert(row: {
    id: string;
    projectId: string;
    slug: string;
    title: string;
    body?: string;
    level?: string;
    modelChain?: string;
    baseRef?: string;
    branch?: string;
    dependsOn?: string[];
    status?: string;
    waitReason?: WaitReason;
    worktreePath?: string | null;
    doneReport?: string | null;
    diffStat?: string | null;
    sourceRef?: string | null;
    batchId?: string | null;
    skipDeps?: boolean;
  }): void {
    const deps = JSON.stringify(row.dependsOn || []);
    this.db
      .prepare(
        `INSERT INTO tasks (id, projectId, slug, title, body, level, modelChain, baseRef, branch, dependsOn, status, waitReason, worktreePath, doneReport, diffStat, sourceRef, batchId)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        row.id,
        row.projectId,
        row.slug,
        row.title,
        row.body || null,
        row.level || 'easy',
        row.modelChain || null,
        row.baseRef || null,
        row.branch || null,
        deps,
        row.status || 'draft',
        row.waitReason || null,
        row.worktreePath || null,
        row.doneReport || null,
        row.diffStat || null,
        row.sourceRef || null,
        row.batchId || null,
      );

    // Populate task_deps
    if (!row.skipDeps && row.dependsOn && row.dependsOn.length > 0) {
      const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
      for (const dep of row.dependsOn) {
        stmt.run(row.id, dep);
      }
    }
  }

  populateDeps(taskId: string, dependsOn: string[]): void {
    if (!dependsOn || dependsOn.length === 0) return;
    const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
    for (const dep of dependsOn) {
      stmt.run(taskId, dep);
    }
  }

  updateStatus(id: string, status: string, waitReason: WaitReason = null): void {
    if (status === 'waiting_quota') {
      this.db
        .prepare("UPDATE tasks SET status = ?, waitReason = ?, updatedAt = datetime('now') WHERE id = ?")
        .run(status, waitReason, id);
    } else {
      this.db
        .prepare("UPDATE tasks SET status = ?, waitReason = NULL, updatedAt = datetime('now') WHERE id = ?")
        .run(status, id);
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_deps WHERE taskId = ? OR dependsOnId = ?').run(id, id);
    this.db.prepare('DELETE FROM tasks WHERE id = ?').run(id);
  }

  setBatchId(id: string, batchId: string | null): void {
    this.db.prepare("UPDATE tasks SET batchId = ?, updatedAt = datetime('now') WHERE id = ?").run(batchId, id);
  }

  update(
    id: string,
    fields: Partial<Pick<TaskRow, 'status' | 'waitReason' | 'worktreePath' | 'attempt' | 'resume' | 'branch' | 'body' | 'notBefore' | 'transientRetries' | 'checkFixAttempts' | 'slot' | 'reviewerChangesRequested' | 'reviewerEscalated' | 'reviewerEscalatedAt' | 'reviewerEscalationReason' | 'doneReport' | 'diffStat' | 'title' | 'level' | 'modelChain' | 'dependsOn' | 'batchId'>>,
  ): void {
    const sets: string[] = ["updatedAt = datetime('now')"];
    const values: unknown[] = [];
    const fieldsToApply = { ...fields };
    if ('status' in fieldsToApply && fieldsToApply.status !== 'waiting_quota' && fieldsToApply.waitReason === undefined) {
      fieldsToApply.waitReason = null;
    }
    for (const [key, value] of Object.entries(fieldsToApply)) {
      sets.push(`${key} = ?`);
      values.push(value);
    }
    values.push(id);
    this.db.prepare(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);

    if ('dependsOn' in fields && fields.dependsOn !== undefined) {
      this.db.prepare('DELETE FROM task_deps WHERE taskId = ?').run(id);
      try {
        const deps = JSON.parse(fields.dependsOn);
        if (Array.isArray(deps) && deps.length > 0) {
          const stmt = this.db.prepare('INSERT INTO task_deps (taskId, dependsOnId) VALUES (?, ?)');
          for (const dep of deps) {
            stmt.run(id, dep);
          }
        }
      } catch {
        // ignore
      }
    }
  }

  getUsedSlots(projectId: string): number[] {
    const rows = this.db
      .prepare("SELECT slot FROM tasks WHERE projectId = ? AND slot IS NOT NULL AND status NOT IN ('done', 'cancelled')")
      .all(projectId) as Array<{ slot: number }>;
    return rows.map((row) => row.slot);
  }
}

export class TaskBatchRepo {
  constructor(private db: Database.Database) {}

  create(row: {
    id: string;
    projectId: string;
    title: string;
    goal?: string | null;
    status?: BatchStatus;
    createdBy?: string | null;
  }): void {
    this.db
      .prepare(
        'INSERT INTO task_batches (id, projectId, title, goal, status, createdBy) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(
        row.id,
        row.projectId,
        row.title,
        row.goal || null,
        row.status || 'draft',
        row.createdBy || null,
      );
  }

  get(id: string): TaskBatchRow | undefined {
    return this.db.prepare('SELECT * FROM task_batches WHERE id = ?').get(id) as TaskBatchRow | undefined;
  }

  list(projectId?: string, status?: string): TaskBatchRow[] {
    let query = 'SELECT * FROM task_batches';
    const params: unknown[] = [];
    const conditions: string[] = [];
    if (projectId && projectId !== 'all') {
      conditions.push('projectId = ?');
      params.push(projectId);
    }
    if (status && status !== 'all') {
      conditions.push('status = ?');
      params.push(status);
    }
    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }
    query += ' ORDER BY createdAt DESC';
    return this.db.prepare(query).all(...params) as TaskBatchRow[];
  }

  updateStatus(id: string, status: BatchStatus): void {
    this.db.prepare('UPDATE task_batches SET status = ? WHERE id = ?').run(status, id);
  }

  update(
    id: string,
    fields: Partial<{ title: string; goal: string | null; status: BatchStatus }>,
  ): void {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (fields.title !== undefined) {
      sets.push('title = ?');
      params.push(fields.title);
    }
    if (fields.goal !== undefined) {
      sets.push('goal = ?');
      params.push(fields.goal);
    }
    if (fields.status !== undefined) {
      sets.push('status = ?');
      params.push(fields.status);
    }
    if (sets.length > 0) {
      this.db.prepare(`UPDATE task_batches SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    }
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM task_batches WHERE id = ?').run(id);
  }
}

export class RunRepo {
  constructor(private db: Database.Database) {}

  getByTask(taskId: string): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE taskId = ? ORDER BY startedAt')
      .all(taskId) as RunRow[];
  }

  getRunning(): RunRow[] {
    return this.db
      .prepare('SELECT * FROM runs WHERE outcome IS NULL')
      .all() as RunRow[];
  }

  get(id: string): RunRow | undefined {
    return this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id) as RunRow | undefined;
  }

  insert(row: {
    id: string;
    taskId: string;
    engine: string;
    model: string;
    profileName: string;
    pid?: number;
    logPath?: string;
    pidStart?: number;
    kind?: 'worker' | 'reviewer';
  }): void {
    this.db
      .prepare(
        'INSERT INTO runs (id, taskId, engine, model, profileName, pid, logPath, pidStart, kind) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(row.id, row.taskId, row.engine, row.model, row.profileName, row.pid || null, row.logPath || null, row.pidStart || null, row.kind || 'worker');
  }

  finish(id: string, outcome: string, resetAt?: number, reason?: string): void {
    this.db
      .prepare("UPDATE runs SET outcome = ?, endedAt = datetime('now'), resetAt = ?, reason = ? WHERE id = ?")
      .run(outcome, resetAt || null, reason || null, id);
  }

  updatePid(id: string, pid: number, pidStart?: number | null): void {
    this.db.prepare('UPDATE runs SET pid = ?, pidStart = ? WHERE id = ?').run(pid, pidStart || null, id);
  }
}

export class EventRepo {
  constructor(private db: Database.Database) {}

  insert(type: string, taskId?: string, payload?: unknown): number {
    const result = this.db
      .prepare('INSERT INTO events (type, taskId, payload) VALUES (?, ?, ?)')
      .run(type, taskId || null, payload ? JSON.stringify(payload) : null);
    return result.lastInsertRowid as number;
  }

  getRecent(limit = 50): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events ORDER BY id DESC LIMIT ?')
      .all(limit) as EventRow[];
  }

  getSince(afterId: number): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE id > ? ORDER BY id')
      .all(afterId) as EventRow[];
  }

  getByTask(taskId: string): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE taskId = ? ORDER BY id')
      .all(taskId) as EventRow[];
  }
}

export interface ReviewRow {
  id: string;
  taskId: string;
  verdict: string;
  feedback: string | null;
  createdAt: string;
  actor: string;
}

export class ReviewRepo {
  constructor(private db: Database.Database) {}

  getByTask(taskId: string): ReviewRow[] {
    return this.db
      .prepare('SELECT * FROM reviews WHERE taskId = ? ORDER BY createdAt')
      .all(taskId) as ReviewRow[];
  }

  insert(row: { id: string; taskId: string; verdict: string; feedback?: string | null; actor?: string }): void {
    this.db
      .prepare(
        'INSERT INTO reviews (id, taskId, verdict, feedback, actor) VALUES (?, ?, ?, ?, ?)',
      )
      .run(row.id, row.taskId, row.verdict, row.feedback || null, row.actor || 'claude');
  }
}

export interface ChatSessionRow {
  id: string;
  projectId: string | null;
  claudeSessionId: string | null;
  title: string | null;
  mode: 'safe' | 'full';
  model: string;
  profileName: string | null;
  busy: number;
  state: 'idle' | 'running' | 'waiting_permission' | 'error';
  pinned: number;
  archived: number;
  lastMessageAt: string | null;
  inputTokens: number;
  outputTokens: number;
  contextTokens: number;
  createdAt: string;
  updatedAt: string;
}

export interface ChatMessageRow {
  id: string;
  sessionId: string;
  role: 'user' | 'assistant' | 'tool' | 'error';
  content: string;
  meta: string | null;
  createdAt: string;
}

export class ChatSessionRepo {
  constructor(private db: Database.Database) {}

  getAll(options?: { archived?: number | null }): ChatSessionRow[] {
    const archived = options?.archived !== undefined ? options.archived : 0;
    if (archived === null) {
      return this.db
        .prepare('SELECT * FROM chat_sessions ORDER BY pinned DESC, updatedAt DESC, createdAt DESC')
        .all() as ChatSessionRow[];
    }
    return this.db
      .prepare('SELECT * FROM chat_sessions WHERE archived = ? ORDER BY pinned DESC, updatedAt DESC, createdAt DESC')
      .all(archived) as ChatSessionRow[];
  }

  search(query: string, options?: { archived?: number | null }): ChatSessionRow[] {
    const trimmed = query.trim();
    const archived = options?.archived !== undefined ? options.archived : 0;
    if (!trimmed) {
      return this.getAll(options);
    }
    const escaped = trimmed.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_');
    const pattern = `%${escaped}%`;
    if (archived === null) {
      return this.db
        .prepare(
          `SELECT DISTINCT s.* FROM chat_sessions s
           LEFT JOIN chat_messages m ON m.sessionId = s.id
           WHERE (s.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
           ORDER BY s.pinned DESC, s.updatedAt DESC, s.createdAt DESC`
        )
        .all(pattern, pattern) as ChatSessionRow[];
    }
    return this.db
      .prepare(
        `SELECT DISTINCT s.* FROM chat_sessions s
         LEFT JOIN chat_messages m ON m.sessionId = s.id
         WHERE s.archived = ? AND (s.title LIKE ? ESCAPE '\\' OR m.content LIKE ? ESCAPE '\\')
         ORDER BY s.pinned DESC, s.updatedAt DESC, s.createdAt DESC`
      )
      .all(archived, pattern, pattern) as ChatSessionRow[];
  }

  get(id: string): ChatSessionRow | undefined {
    return this.db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id) as
      | ChatSessionRow
      | undefined;
  }

  insert(row: {
    id: string;
    projectId?: string | null;
    claudeSessionId?: string | null;
    title?: string | null;
    mode?: 'safe' | 'full';
    model?: string;
    profileName?: string | null;
    busy?: number;
    state?: ChatSessionRow['state'];
    pinned?: number;
    archived?: number;
    lastMessageAt?: string | null;
    inputTokens?: number;
    outputTokens?: number;
    contextTokens?: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_sessions (id, projectId, claudeSessionId, title, mode, busy, model, profileName, state, pinned, archived, lastMessageAt, inputTokens, outputTokens, contextTokens)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        row.id,
        row.projectId || null,
        row.claudeSessionId || null,
        row.title || null,
        row.mode || 'safe',
        row.busy ?? 0,
        row.model || '',
        row.profileName || null,
        row.state || 'idle',
        row.pinned ?? 0,
        row.archived ?? 0,
        row.lastMessageAt || null,
        row.inputTokens ?? 0,
        row.outputTokens ?? 0,
        row.contextTokens ?? 0,
      );
  }

  updateProfileName(id: string, profileName: string | null): void {
    this.db.prepare("UPDATE chat_sessions SET profileName = ?, updatedAt = datetime('now') WHERE id = ?").run(profileName, id);
  }

  updateModel(id: string, model: string): void {
    this.db.prepare("UPDATE chat_sessions SET model = ?, updatedAt = datetime('now') WHERE id = ?").run(model, id);
  }

  updateTitle(id: string, title: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET title = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(title, id);
  }

  updatePinned(id: string, pinned: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET pinned = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(pinned ? 1 : 0, id);
  }

  updateArchived(id: string, archived: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET archived = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(archived ? 1 : 0, id);
  }

  touchLastMessage(id: string, timestamp?: string): void {
    this.db
      .prepare(
        "UPDATE chat_sessions SET lastMessageAt = COALESCE(?, datetime('now')), updatedAt = datetime('now') WHERE id = ?"
      )
      .run(timestamp || null, id);
  }

  addUsage(
    id: string,
    usage: { inputTokens: number; outputTokens: number; contextTokens?: number },
  ): void {
    this.db
      .prepare(
        `UPDATE chat_sessions
         SET inputTokens = inputTokens + ?,
             outputTokens = outputTokens + ?,
             contextTokens = COALESCE(?, contextTokens),
             lastMessageAt = datetime('now'),
             updatedAt = datetime('now')
         WHERE id = ?`
      )
      .run(usage.inputTokens, usage.outputTokens, usage.contextTokens ?? null, id);
  }

  updateClaudeSessionId(id: string, claudeSessionId: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET claudeSessionId = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(claudeSessionId, id);
  }

  setBusy(id: string, busy: number): void {
    this.db
      .prepare("UPDATE chat_sessions SET busy = ?, updatedAt = datetime('now') WHERE id = ?")
      .run(busy, id);
  }

  updateState(id: string, state: ChatSessionRow['state']): void {
    this.db.prepare("UPDATE chat_sessions SET state = ?, updatedAt = datetime('now') WHERE id = ?").run(state, id);
  }

  clearClaudeSessionId(id: string): void {
    this.db.prepare("UPDATE chat_sessions SET claudeSessionId = NULL, updatedAt = datetime('now') WHERE id = ?").run(id);
  }

  touchUpdatedAt(id: string): void {
    this.db
      .prepare("UPDATE chat_sessions SET updatedAt = datetime('now') WHERE id = ?")
      .run(id);
  }

  resetAllBusy(): void {
    this.db.prepare("UPDATE chat_sessions SET busy = 0, state = 'idle' WHERE busy != 0 OR state != 'idle'").run();
  }

  delete(id: string): void {
    this.db.prepare('DELETE FROM chat_messages WHERE sessionId = ?').run(id);
    this.db.prepare('DELETE FROM chat_sessions WHERE id = ?').run(id);
  }
}

export interface ChatPermissionRow {
  id: string;
  sessionId: string;
  messageId: string | null;
  toolName: string;
  input: string;
  status: 'pending' | 'allow' | 'deny' | 'allow_always';
  message: string | null;
  createdAt: string;
  resolvedAt: string | null;
}

export class ChatPermissionRepo {
  constructor(private db: Database.Database) {}

  insert(row: { id: string; sessionId: string; messageId?: string | null; toolName: string; input: string; status?: ChatPermissionRow['status'] }): ChatPermissionRow {
    this.db.prepare('INSERT INTO chat_permissions (id, sessionId, messageId, toolName, input, status) VALUES (?, ?, ?, ?, ?, ?)')
      .run(row.id, row.sessionId, row.messageId || null, row.toolName, row.input, row.status || 'pending');
    return this.get(row.id)!;
  }

  get(id: string): ChatPermissionRow | undefined {
    return this.db.prepare('SELECT * FROM chat_permissions WHERE id = ?').get(id) as ChatPermissionRow | undefined;
  }

  listPending(sessionId?: string): ChatPermissionRow[] {
    return (sessionId
      ? this.db.prepare("SELECT * FROM chat_permissions WHERE sessionId = ? AND status = 'pending' ORDER BY createdAt").all(sessionId)
      : this.db.prepare("SELECT * FROM chat_permissions WHERE status = 'pending' ORDER BY createdAt").all()) as ChatPermissionRow[];
  }

  expirePending(message = 'AgentHub khởi động lại'): number {
    const result = this.db.prepare("UPDATE chat_permissions SET status = 'deny', message = ?, resolvedAt = datetime('now') WHERE status = 'pending'").run(message);
    return result.changes;
  }

  getLatest(sessionId: string, messageId: string | null | undefined, toolName: string): ChatPermissionRow | undefined {
    return this.db.prepare('SELECT * FROM chat_permissions WHERE sessionId = ? AND messageId IS ? AND toolName = ? ORDER BY createdAt DESC LIMIT 1')
      .get(sessionId, messageId || null, toolName) as ChatPermissionRow | undefined;
  }

  resolve(id: string, status: Exclude<ChatPermissionRow['status'], 'pending'>, message: string | null): ChatPermissionRow | undefined {
    this.db.prepare("UPDATE chat_permissions SET status = ?, message = ?, resolvedAt = datetime('now') WHERE id = ? AND status = 'pending'")
      .run(status, message, id);
    return this.get(id);
  }
}

export class ChatMessageRepo {
  constructor(private db: Database.Database) {}

  getBySession(sessionId: string, limit = 200): ChatMessageRow[] {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt ASC, rowid ASC LIMIT ?')
      .all(sessionId, limit) as ChatMessageRow[];
  }

  getPaginated(
    sessionId: string,
    before?: string,
    limit = 50,
  ): { messages: ChatMessageRow[]; hasMore: boolean } {
    const safeLimit = Math.max(1, limit);
    let rows: ChatMessageRow[];

    if (before) {
      const target = this.db
        .prepare('SELECT rowid, createdAt FROM chat_messages WHERE id = ? AND sessionId = ?')
        .get(before, sessionId) as { rowid: number; createdAt: string } | undefined;

      if (!target) {
        return { messages: [], hasMore: false };
      }

      rows = this.db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE sessionId = ? AND (createdAt < ? OR (createdAt = ? AND rowid < ?))
           ORDER BY createdAt DESC, rowid DESC
           LIMIT ?`
        )
        .all(sessionId, target.createdAt, target.createdAt, target.rowid, safeLimit + 1) as ChatMessageRow[];
    } else {
      rows = this.db
        .prepare(
          `SELECT * FROM chat_messages
           WHERE sessionId = ?
           ORDER BY createdAt DESC, rowid DESC
           LIMIT ?`
        )
        .all(sessionId, safeLimit + 1) as ChatMessageRow[];
    }

    const hasMore = rows.length > safeLimit;
    const paginated = hasMore ? rows.slice(0, safeLimit) : rows;
    paginated.reverse();

    return { messages: paginated, hasMore };
  }

  getLastBySession(sessionId: string): ChatMessageRow | undefined {
    return this.db
      .prepare('SELECT * FROM chat_messages WHERE sessionId = ? ORDER BY createdAt DESC, rowid DESC LIMIT 1')
      .get(sessionId) as ChatMessageRow | undefined;
  }

  insert(row: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'error';
    content: string;
    meta?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, sessionId, role, content, meta)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(row.id, row.sessionId, row.role, row.content, row.meta || null);
  }

  upsert(row: {
    id: string;
    sessionId: string;
    role: 'user' | 'assistant' | 'tool' | 'error';
    content: string;
    meta?: string | null;
  }): void {
    this.db
      .prepare(
        `INSERT INTO chat_messages (id, sessionId, role, content, meta)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET role = excluded.role, content = excluded.content, meta = excluded.meta`
      )
      .run(row.id, row.sessionId, row.role, row.content, row.meta || null);
  }

  deleteBySession(sessionId: string): void {
    this.db.prepare('DELETE FROM chat_messages WHERE sessionId = ?').run(sessionId);
  }
}

export interface RunMetricsRow {
  runId: string;
  taskId: string;
  engine: string;
  model: string;
  profileName: string;
  tokensUsed: number | null;
  usageBefore: number | null;
  usageAfter: number | null;
  linesAdded: number;
  linesDeleted: number;
  filesChanged: number;
  durationMs: number | null;
  createdAt: string;
}

export class RunMetricsRepo {
  constructor(private db: Database.Database) {}

  get(runId: string): RunMetricsRow | undefined {
    return this.db.prepare('SELECT * FROM run_metrics WHERE runId = ?').get(runId) as
      | RunMetricsRow
      | undefined;
  }

  getByTask(taskId: string): RunMetricsRow[] {
    return this.db
      .prepare('SELECT * FROM run_metrics WHERE taskId = ? ORDER BY createdAt')
      .all(taskId) as RunMetricsRow[];
  }

  getAll(): RunMetricsRow[] {
    return this.db
      .prepare('SELECT * FROM run_metrics ORDER BY createdAt')
      .all() as RunMetricsRow[];
  }

  upsert(row: Omit<RunMetricsRow, 'createdAt'> & { createdAt?: string }): void {
    this.db
      .prepare(
        `INSERT INTO run_metrics (runId, taskId, engine, model, profileName, tokensUsed, usageBefore, usageAfter, linesAdded, linesDeleted, filesChanged, durationMs)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(runId) DO UPDATE SET
           taskId = excluded.taskId,
           engine = excluded.engine,
           model = excluded.model,
           profileName = excluded.profileName,
           tokensUsed = excluded.tokensUsed,
           usageBefore = excluded.usageBefore,
           usageAfter = excluded.usageAfter,
           linesAdded = excluded.linesAdded,
           linesDeleted = excluded.linesDeleted,
           filesChanged = excluded.filesChanged,
           durationMs = excluded.durationMs`,
      )
      .run(
        row.runId,
        row.taskId,
        row.engine,
        row.model,
        row.profileName,
        row.tokensUsed ?? null,
        row.usageBefore ?? null,
        row.usageAfter ?? null,
        row.linesAdded ?? 0,
        row.linesDeleted ?? 0,
        row.filesChanged ?? 0,
        row.durationMs ?? null,
      );
  }

  updateLines(runId: string, linesAdded: number, linesDeleted: number, filesChanged: number): void {
    this.db
      .prepare(
        `UPDATE run_metrics
         SET linesAdded = ?, linesDeleted = ?, filesChanged = ?
         WHERE runId = ?`,
      )
      .run(linesAdded, linesDeleted, filesChanged, runId);
  }

  clearOtherRunsLines(taskId: string, keepRunId: string): void {
    this.db
      .prepare(
        `UPDATE run_metrics
         SET linesAdded = 0, linesDeleted = 0, filesChanged = 0
         WHERE taskId = ? AND runId != ?`,
      )
      .run(taskId, keepRunId);
  }
}

export type TaskNoteKind = 'note' | 'overlap';

export interface TaskNoteRow {
  id: number;
  projectId: string;
  taskId: string;
  kind: TaskNoteKind;
  content: string;
  createdAt: string;
}

export interface KnowledgeEntryRow {
  id: number;
  projectId: string;
  taskId: string;
  content: string;
  createdAt: string;
  pinned: number;
}

export class KnowledgeRepo {
  constructor(private db: Database.Database) {}

  getByProject(projectId: string): KnowledgeEntryRow[] {
    return this.db
      .prepare('SELECT * FROM knowledge_entries WHERE projectId = ? ORDER BY pinned DESC, createdAt DESC, id DESC')
      .all(projectId) as KnowledgeEntryRow[];
  }

  get(id: number): KnowledgeEntryRow | undefined {
    return this.db.prepare('SELECT * FROM knowledge_entries WHERE id = ?').get(id) as KnowledgeEntryRow | undefined;
  }

  insert(row: { projectId: string; taskId: string; content: string; pinned?: boolean }): KnowledgeEntryRow {
    const result = this.db
      .prepare('INSERT INTO knowledge_entries (projectId, taskId, content, pinned) VALUES (?, ?, ?, ?)')
      .run(row.projectId, row.taskId, row.content, row.pinned ? 1 : 0);
    return this.get(result.lastInsertRowid as number)!;
  }

  update(id: number, fields: { content?: string; pinned?: boolean }): KnowledgeEntryRow | undefined {
    const sets: string[] = [];
    const values: unknown[] = [];
    if (fields.content !== undefined) { sets.push('content = ?'); values.push(fields.content); }
    if (fields.pinned !== undefined) { sets.push('pinned = ?'); values.push(fields.pinned ? 1 : 0); }
    if (sets.length > 0) {
      values.push(id);
      this.db.prepare(`UPDATE knowledge_entries SET ${sets.join(', ')} WHERE id = ?`).run(...values);
    }
    return this.get(id);
  }

  delete(id: number): void {
    this.db.prepare('DELETE FROM knowledge_entries WHERE id = ?').run(id);
  }
}

export class TaskNoteRepo {
  constructor(private db: Database.Database) {}

  insert(row: {
    projectId: string;
    taskId: string;
    kind: TaskNoteKind;
    content: string;
  }): TaskNoteRow {
    const info = this.db
      .prepare(
        'INSERT INTO task_notes (projectId, taskId, kind, content) VALUES (?, ?, ?, ?)',
      )
      .run(row.projectId, row.taskId, row.kind, row.content);
    return this.get(info.lastInsertRowid as number)!;
  }

  get(id: number): TaskNoteRow | undefined {
    return this.db
      .prepare('SELECT * FROM task_notes WHERE id = ?')
      .get(id) as TaskNoteRow | undefined;
  }

  getByProject(projectId: string, sinceId?: number): TaskNoteRow[] {
    if (sinceId !== undefined && !Number.isNaN(sinceId)) {
      return this.db
        .prepare('SELECT * FROM task_notes WHERE projectId = ? AND id > ? ORDER BY id ASC')
        .all(projectId, sinceId) as TaskNoteRow[];
    }
    return this.db
      .prepare('SELECT * FROM task_notes WHERE projectId = ? ORDER BY id ASC')
      .all(projectId) as TaskNoteRow[];
  }

  getByTask(taskId: string): TaskNoteRow[] {
    return this.db
      .prepare('SELECT * FROM task_notes WHERE taskId = ? ORDER BY id ASC')
      .all(taskId) as TaskNoteRow[];
  }

  hasOverlap(taskId: string, otherTaskId: string, file: string): boolean {
    const row = this.db
      .prepare(
        "SELECT id FROM task_notes WHERE taskId = ? AND kind = 'overlap' AND content LIKE ? LIMIT 1",
      )
      .get(taskId, `%${file}%${otherTaskId}%`);
    return Boolean(row);
  }

  getActiveOverlaps(runningTaskIds: string[]): TaskNoteRow[] {
    if (runningTaskIds.length === 0) return [];
    const placeholders = runningTaskIds.map(() => '?').join(', ');
    return this.db
      .prepare(
        `SELECT * FROM task_notes
         WHERE kind = 'overlap' AND taskId IN (${placeholders})
         ORDER BY id DESC LIMIT 50`,
      )
      .all(...runningTaskIds) as TaskNoteRow[];
  }
}


