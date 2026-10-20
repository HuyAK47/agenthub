import { afterEach, describe, expect, it, vi } from 'vitest';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';
import { openDatabase, ChatPermissionRepo, ChatSessionRepo } from '../src/db/index.js';
import { PermissionBroker } from '../src/chat/permissions.js';

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
});
