import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, ChatPermissionRepo, ChatSessionRepo, PermissionRuleRepo, ProjectRepo } from '../src/db/index.js';
import { PermissionBroker, commandPermissionInfo } from '../src/chat/permissions.js';
import { BrainPolicy } from '../src/brain/policy.js';

describe('PermissionBroker', () => {
  let dir: string;
  let db: ReturnType<typeof openDatabase>;

  afterEach(() => {
    vi.useRealTimers();
    db?.close();
    if (dir) fs.rmSync(dir, { recursive: true, force: true });
  });

  function makeBroker(timeoutSec = 600) {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-permission-'));
    db = openDatabase(path.join(dir, 'hub.db'));
    new ChatSessionRepo(db).insert({ id: 'session-1', title: 'Test' });
    return new PermissionBroker(new ChatPermissionRepo(db), timeoutSec);
  }

  it('resolves allow and deny decisions', async () => {
    const broker = makeBroker();
    const allowed = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'git status' } });
    const request = broker.listPending()[0];
    expect(request.toolName).toBe('Bash');
    expect(broker.resolve(request.id, 'allow')).toBe(true);
    await expect(allowed).resolves.toEqual({ behavior: 'allow', updatedInput: { command: 'git status' } });

    const denied = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'rm -i x' } });
    const deniedRequest = broker.listPending()[0];
    broker.resolve(deniedRequest.id, 'deny', 'Không an toàn');
    await expect(denied).resolves.toEqual({ behavior: 'deny', message: 'Không an toàn' });
  });

  it('remembers allow_always for the same session, tool and command pattern', async () => {
    const broker = makeBroker();
    const first = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'npm test --run' } });
    const request = broker.listPending()[0];
    broker.resolve(request.id, 'allow_always');
    await expect(first).resolves.toMatchObject({ behavior: 'allow' });
    await expect(broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'npm test --run' } }))
      .resolves.toMatchObject({ behavior: 'allow' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('denies a request after the configured timeout', async () => {
    vi.useFakeTimers();
    const broker = makeBroker(2);
    const pending = broker.request({ sessionId: 'session-1', toolName: 'Read', input: { file_path: 'secret.txt' } });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(pending).resolves.toEqual({ behavior: 'deny', message: 'Hết thời gian chờ cấp quyền' });
    expect(broker.listPending()).toHaveLength(0);
  });

  it('expires pending requests left by a daemon restart', () => {
    const broker = makeBroker();
    new ChatPermissionRepo(db).insert({ id: 'stale', sessionId: 'session-1', toolName: 'Bash', input: JSON.stringify({ command: 'git status' }) });
    expect(broker.listPending()).toHaveLength(1);
    expect(new ChatPermissionRepo(db).expirePending()).toBe(1);
    expect(broker.listPending()).toHaveLength(0);
    broker.stop();
  });

  it('derives brain policy from stored session kind, not request input', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-permission-'));
    db = openDatabase(path.join(dir, 'hub.db'));
    const sessions = new ChatSessionRepo(db);
    sessions.insert({ id: 'brain-session', title: 'Brain', kind: 'brain' });
    sessions.insert({ id: 'chat-session', title: 'Chat', kind: 'chat' });
    const root = fs.mkdtempSync(path.join(dir, 'root-'));
    const policy = new BrainPolicy({ roots: [root] });
    const broker = new PermissionBroker(new ChatPermissionRepo(db), 1, undefined, policy, sessions);

    await expect(broker.request({ sessionId: 'brain-session', kind: 'user', toolName: 'Bash', input: { command: 'git status', cwd: root } }))
      .resolves.toMatchObject({ behavior: 'allow' });
    const ordinary = broker.request({ sessionId: 'chat-session', kind: 'brain', toolName: 'Bash', input: { command: 'git status', cwd: root } });
    expect(broker.listPending('chat-session')).toHaveLength(1);
    broker.resolve(broker.listPending('chat-session')[0].id, 'deny');
    await expect(ordinary).resolves.toMatchObject({ behavior: 'deny' });
  });

  it('uses stable command prefixes and requires every shell segment', async () => {
    expect(commandPermissionInfo('git log --oneline').patterns).toEqual(['command:git log']);
    expect(commandPermissionInfo('npm run test -- --run').patterns).toEqual(['command:npm run test']);
    expect(commandPermissionInfo('npx vite build').patterns).toEqual(['command:npx vite']);
    expect(commandPermissionInfo('gh pr checks 12').patterns).toEqual(['command:gh pr checks']);
    expect(commandPermissionInfo('python3 -m pytest -q').patterns).toEqual(['command:python3 -m pytest']);
    expect(commandPermissionInfo('curl https://example.test').patterns).toEqual(['command:curl']);

    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-permission-'));
    db = openDatabase(path.join(dir, 'hub.db'));
    const sessions = new ChatSessionRepo(db);
    sessions.insert({ id: 'session-1', title: 'Test' });
    const rules = new PermissionRuleRepo(db);
    const broker = new PermissionBroker(new ChatPermissionRepo(db), 1, undefined, undefined, sessions, rules);
    const first = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'git status --short' } });
    broker.resolve(broker.listPending()[0].id, 'allow_always');
    await first;
    await expect(broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'git status --porcelain' } })).resolves.toMatchObject({ behavior: 'allow' });
    const chained = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'git status && curl https://example.test' } });
    expect(broker.listPending()).toHaveLength(1);
    broker.resolve(broker.listPending()[0].id, 'deny');
    await chained;
    const dangerous = broker.request({ sessionId: 'session-1', toolName: 'Bash', input: { command: 'rm -rf /tmp/nope' } });
    expect(broker.listPending()).toHaveLength(1);
    broker.resolve(broker.listPending()[0].id, 'allow_always');
    await dangerous;
    expect(rules.listAll()).toHaveLength(1);
  });

  it('persists project rules and does not cross project boundaries', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-permission-'));
    db = openDatabase(path.join(dir, 'hub.db'));
    const projects = new ProjectRepo(db); projects.insert({ id: 'p1', name: 'P1', path: path.join(dir, 'p1'), defaultBranch: 'main', maxParallel: 1 }); projects.insert({ id: 'p2', name: 'P2', path: path.join(dir, 'p2'), defaultBranch: 'main', maxParallel: 1 });
    const sessions = new ChatSessionRepo(db); sessions.insert({ id: 's1', title: 'one', projectId: 'p1' }); sessions.insert({ id: 's2', title: 'two', projectId: 'p1' }); sessions.insert({ id: 's3', title: 'three', projectId: 'p2' });
    const ruleRepo = new PermissionRuleRepo(db); const requestRepo = new ChatPermissionRepo(db);
    const broker = new PermissionBroker(requestRepo, 1, undefined, undefined, sessions, ruleRepo, projects);
    const pending = broker.request({ sessionId: 's1', toolName: 'Bash', input: { command: 'npm run build' } }); broker.resolve(broker.listPending()[0].id, 'allow_always'); await pending;
    const restarted = new PermissionBroker(requestRepo, 1, undefined, undefined, sessions, ruleRepo, projects);
    await expect(restarted.request({ sessionId: 's2', toolName: 'Bash', input: { command: 'npm run build --silent' } })).resolves.toMatchObject({ behavior: 'allow' });
    const other = restarted.request({ sessionId: 's3', toolName: 'Bash', input: { command: 'npm run build' } }); expect(restarted.listPending()).toHaveLength(1); restarted.resolve(restarted.listPending()[0].id, 'deny'); await other;
  });
});
