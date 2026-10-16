import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { WebSocket } from 'ws';
import { loadConfig } from '../src/config.js';
import { createContext, startDaemon } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';

describe('Daemon and server shutdown', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let token: string;
  let engines: Map<string, Engine>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-shutdown-test-'));
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
    engines = new Map<string, Engine>([['agy', fakeEngine]]);
  });

  afterEach(() => {
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    vi.restoreAllMocks();
  });

  it('closes server in less than 2 seconds when an active SSE connection is open', async () => {
    ctx = createContext(config, engines);
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    let sseConnected = false;
    const req = http.request(
      `http://127.0.0.1:${port}/api/events?token=${token}`,
      { headers: { host: `127.0.0.1:${port}` } },
      (res) => {
        if (res.statusCode === 200) {
          sseConnected = true;
        }
      },
    );
    req.end();

    const eventBus = ctx.scheduler.getEventBus();
    await vi.waitFor(() => {
      expect(sseConnected).toBe(true);
      expect(eventBus.listenerCount('*')).toBeGreaterThan(0);
    }, { timeout: 3000 });

    const startTime = Date.now();
    await server.close();
    const duration = Date.now() - startTime;

    expect(duration).toBeLessThan(2000);
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('closes connected websocket clients with code 1001 on server close', async () => {
    ctx = createContext(config, engines);
    ctx.service.createProfile({ name: 'testprofile' });
    const server = await createServer(ctx.service, config);
    await server.listen({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    const port = addr.port;

    const loginRes = await fetch(`http://127.0.0.1:${port}/api/profiles/testprofile/login`, {
      method: 'POST',
      headers: {
        host: `127.0.0.1:${port}`,
        authorization: `Bearer ${token}`,
      },
    });
    expect(loginRes.status).toBe(200);
    const { sessionId } = (await loginRes.json()) as { sessionId: string };

    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/pty/${sessionId}?token=${token}`);
    let closeCode: number | null = null;
    let closeReason = '';
    ws.on('close', (code, reason) => {
      closeCode = code;
      closeReason = reason.toString();
    });

    await vi.waitFor(() => {
      expect(ws.readyState).toBe(WebSocket.OPEN);
    }, { timeout: 3000 });

    const startTime = Date.now();
    await server.close();
    const duration = Date.now() - startTime;

    await vi.waitFor(() => {
      expect(closeCode).toBe(1001);
    }, { timeout: 3000 });

    expect(duration).toBeLessThan(2000);
    expect(closeCode).toBe(1001);
    expect(closeReason).toContain('Going Away');
    ctx.scheduler.stop();
    ctx.db.close();
  });

  it('shutdown() is idempotent and executes only once', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const daemon = await startDaemon(config, engines);

    const closeSpy = vi.spyOn(daemon.fastify, 'close');

    // Call shutdown twice
    await Promise.all([daemon.shutdown(), daemon.shutdown()]);

    expect(closeSpy).toHaveBeenCalledTimes(1);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it('shutdown() logs shutdown duration', async () => {
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

    const daemon = await startDaemon(config, engines);
    await daemon.shutdown();

    const loggedTiming = consoleSpy.mock.calls.some((args) =>
      args.some((arg) => typeof arg === 'string' && /Shutdown completed in \d+ms/.test(arg)),
    );
    expect(loggedTiming).toBe(true);
  });

  it('shutdown() forces exit on 5s timeout if closing hangs', async () => {
    vi.useFakeTimers();
    try {
      const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {}) as never);
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const daemon = await startDaemon(config, engines);

      // Simulate hanging fastify.close
      vi.spyOn(daemon.fastify, 'close').mockImplementation(() => new Promise(() => {}));

      // Trigger shutdown without awaiting (since it will hang until timer)
      void daemon.shutdown();

      // Fast-forward past 5 seconds
      await vi.advanceTimersByTimeAsync(5100);

      expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Shutdown timed out after 5s'));
      expect(exitSpy).toHaveBeenCalledWith(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
