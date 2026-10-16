import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let port: number;

function authHeaders() {
  return {
    host: `127.0.0.1:${port}`,
    authorization: `Bearer ${token}`,
  };
}

describe('Brain API Endpoints (/api/brain)', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-test-'));
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

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    server = await createServer(ctx.service, config);
    await server['listen']({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    port = addr.port;
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

  it('PUT /api/brain with invalid activity returns 400', async () => {
    const res = await server.inject({
      method: 'PUT',
      url: '/api/brain',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      payload: {
        activity: 'invalid_activity',
        detail: 'Học bài',
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_request');
  });

  it('PUT /api/brain with detail > 300 characters returns 400', async () => {
    const longDetail = 'a'.repeat(301);
    const res = await server.inject({
      method: 'PUT',
      url: '/api/brain',
      headers: {
        ...authHeaders(),
        'content-type': 'application/json',
      },
      payload: {
        activity: 'planning',
        detail: longDetail,
      },
    });

    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('bad_request');
    expect(body.message).toContain('300');
  });

  it('PUT /api/brain with valid data updates status, records event, and emits SSE', async () => {
    // 1. Connect SSE client
    const eventsReceived: Array<{ type: string; payload?: Record<string, unknown> | null }> = [];
    let sseReq: http.ClientRequest | null = null;

    const eventBus = ctx.scheduler.getEventBus();
    const initialCount = eventBus.listenerCount('*');

    sseReq = http.request(
      {
        hostname: '127.0.0.1',
        port,
        path: `/api/events?token=${token}`,
        method: 'GET',
        headers: {
          Accept: 'text/event-stream',
          Host: `127.0.0.1:${port}`,
        },
      },
      (res) => {
        let buffer = '';
        res.on('data', (chunk) => {
          buffer += chunk.toString('utf-8');
          const lines = buffer.split('\n\n');
          buffer = lines.pop() || '';
          for (const block of lines) {
            const dataMatch = block.match(/^data: (.*)$/m);
            if (dataMatch) {
              try {
                const ev = JSON.parse(dataMatch[1]);
                eventsReceived.push(ev);
              } catch {
                // ignore non-json
              }
            }
          }
        });
      },
    );
    sseReq.end();

    try {
      // Give SSE connection a moment to establish
      await vi.waitFor(() => {
        expect(eventBus.listenerCount('*')).toBe(initialCount + 1);
      }, { timeout: 3000 });

      // 2. Perform valid PUT /api/brain
      const putRes = await server.inject({
        method: 'PUT',
        url: '/api/brain',
        headers: {
          ...authHeaders(),
          'content-type': 'application/json',
        },
        payload: {
          activity: 'reviewing',
          detail: 'Đang review task agenthub/task-1',
          taskId: 'agenthub/task-1',
        },
      });

      expect(putRes.statusCode).toBe(200);
      const updated = JSON.parse(putRes.body);
      expect(updated.activity).toBe('reviewing');
      expect(updated.detail).toBe('Đang review task agenthub/task-1');
      expect(updated.taskId).toBe('agenthub/task-1');
      expect(updated.stale).toBe(false);

      // 3. Verify SSE event arrived
      await vi.waitFor(() => {
        expect(eventsReceived.some((e) => e.type === 'brain.status')).toBe(true);
      }, { timeout: 10_000 });
    } finally {
      if (sseReq) {
        (sseReq as http.ClientRequest).destroy();
      }
    }

    const brainEvent = eventsReceived.find((e) => e.type === 'brain.status');
    expect(brainEvent).toBeDefined();
    expect(brainEvent?.payload?.activity).toBe('reviewing');
    expect(brainEvent?.payload?.taskId).toBe('agenthub/task-1');

    // 4. Verify recorded in events table
    const recentEvents = ctx.eventRepo.getRecent(5);
    const recorded = recentEvents.find((e) => e.type === 'brain.status');
    expect(recorded).toBeDefined();
    expect(recorded?.taskId).toBe('agenthub/task-1');
  });

  it('GET /api/brain returns stale: true when updatedAt is older than 15 minutes', async () => {
    // Manually set brain_status updatedAt to 20 minutes ago
    const twentyMinsAgo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    ctx.brainRepo.upsert('waiting', 'Đang chờ worker chạy xong', 'proj/t-1', twentyMinsAgo);

    const getRes = await server.inject({
      method: 'GET',
      url: '/api/brain',
      headers: authHeaders(),
    });

    expect(getRes.statusCode).toBe(200);
    const body = JSON.parse(getRes.body);
    expect(body.activity).toBe('waiting');
    expect(body.detail).toBe('Đang chờ worker chạy xong');
    expect(body.taskId).toBe('proj/t-1');
    expect(body.stale).toBe(true);
  });

  it('GET /api/status includes brain object', async () => {
    ctx.brainRepo.upsert('talking', 'Trao đổi về kiến trúc mới', null);

    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: authHeaders(),
    });

    expect(res.statusCode).toBe(200);
    const status = JSON.parse(res.body);
    expect(status.brain).toBeDefined();
    expect(status.brain.activity).toBe('talking');
    expect(status.brain.detail).toBe('Trao đổi về kiến trúc mới');
    expect(status.brain.stale).toBe(false);
  });
});
