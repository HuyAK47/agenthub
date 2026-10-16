import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import type { AddressInfo } from 'node:net';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let port: number;

describe('AgentHub PTY Login and WebSocket', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-pty-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 0;
    token = getOrCreateToken(config.tokenPath);

    ctx = createContext(config);
    server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    port = (server.server.address() as AddressInfo).port;
    config.port = port;
  });

  afterEach(async () => {
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
  });

  it('spawns interactive PTY session, streams over WebSocket, updates email, and wakes waiting_quota', async () => {
    // Stop scheduler to prevent it from immediately picking up queued task with fake path '/tmp'
    ctx.scheduler.stop();

    // 1. Insert a waiting_quota task to verify it gets woken up upon login exit
    ctx.projectRepo.insert({
      id: 'pty-proj',
      name: 'PTY Project',
      path: '/tmp',
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({
      id: 'pty-proj/task1',
      projectId: 'pty-proj',
      slug: 'task1',
      title: 'Task 1',
      status: 'waiting_quota',
    });

    // 2. POST /api/profiles/testuser/login
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/profiles/testuser/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(loginRes.status).toBe(200);
    const { sessionId } = (await loginRes.json()) as { sessionId: string };
    expect(sessionId).toBeDefined();

    // 3. Connect via WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty/${sessionId}?token=${token}`);

    let wsOutput = '';
    ws.on('open', () => {
      // Send input to PTY to trigger exit
      ws.send(JSON.stringify({ type: 'input', data: 'hello\r\n' }));
    });

    ws.on('message', (data) => {
      wsOutput += data.toString();
    });

    await vi.waitFor(() => {
      expect(
        wsOutput.includes('authenticated successfully as test@example.com') ||
        wsOutput.includes('Fake agy login'),
      ).toBe(true);
    }, { timeout: 5000 });

    ws.close();

    // 4. Wait for ptyProcess exit handler to complete and profile to be updated
    await vi.waitFor(() => {
      const profile = ctx.profileRepo.get('testuser');
      expect(profile?.email).toBe('test@example.com');
      const task = ctx.taskRepo.get('pty-proj/task1');
      expect(['queued', 'running']).toContain(task?.status);
    }, { timeout: 5000 });
  });

  it('re-reads email after WebSocket closes when fake agy logs are written with 1 second delay', async () => {
    ctx.scheduler.stop();
    process.env.FAKE_AGY_LOG_DELAY_MS = '1000';

    // 1. POST /api/profiles/delayeduser/login
    const loginRes = await fetch(`http://127.0.0.1:${port}/api/profiles/delayeduser/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(loginRes.status).toBe(200);
    const { sessionId } = (await loginRes.json()) as { sessionId: string };

    // 2. Connect via WebSocket
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty/${sessionId}?token=${token}`);

    await new Promise<void>((resolve, reject) => {
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'input', data: '/exit\r\n' }));
        setTimeout(() => {
          ws.close();
          resolve();
        }, 100);
      });
      ws.on('error', reject);
    });

    // 3. Immediately after close: log has not been written yet (delay is 1s)
    const profileImmediate = ctx.profileRepo.get('delayeduser');
    expect(profileImmediate?.email).toBeNull();

    // 4. Wait for the scheduled refresh to update the profile email
    await vi.waitFor(() => {
      const profileDelayed = ctx.profileRepo.get('delayeduser');
      expect(profileDelayed?.email).toBe('test@example.com');
    }, { timeout: 5000 });

    delete process.env.FAKE_AGY_LOG_DELAY_MS;
  });
});
