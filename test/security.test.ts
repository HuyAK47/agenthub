import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let validToken: string;

describe('AgentHub API Security', () => {
  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-sec-test-'));
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
    validToken = getOrCreateToken(config.tokenPath);
    ctx = createContext(config);
    server = await createServer(ctx.service, config);
    await server['listen']({ port: 0, host: '127.0.0.1' });
    const addr = server.server.address() as net.AddressInfo;
    config.port = addr.port;
  });

  afterEach(async () => {
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

  it('/health does not require token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/health',
      headers: { host: `127.0.0.1:${config.port}` },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.ok).toBe(true);
  });

  it('rejects /api request without token (401)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: { host: `127.0.0.1:${config.port}` },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unauthorized');
  });

  it('rejects /api request with invalid token (401)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        host: `127.0.0.1:${config.port}`,
        authorization: 'Bearer wrong-secret-token',
      },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unauthorized');
  });

  it('accepts /api request with valid Bearer token (200)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        host: `127.0.0.1:${config.port}`,
        authorization: `Bearer ${validToken}`,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.tasks).toBeDefined();
  });

  it('rejects forbidden Host header (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        host: `evil.com:${config.port}`,
        authorization: `Bearer ${validToken}`,
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('forbidden');
  });

  it('rejects forbidden Origin header (403)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/status',
      headers: {
        host: `127.0.0.1:${config.port}`,
        origin: 'http://evil.com',
        authorization: `Bearer ${validToken}`,
      },
    });
    expect(res.statusCode).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('forbidden');
  });

  it('rejects SSE request without token (401)', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/api/events',
      headers: { host: `127.0.0.1:${config.port}` },
    });
    expect(res.statusCode).toBe(401);
    const body = JSON.parse(res.body);
    expect(body.error).toBe('unauthorized');
  });

  it('allows token via ?token= query parameter for SSE', async () => {
    const port = config.port;

    const controller = new AbortController();
    const res = await fetch(`http://127.0.0.1:${port}/api/events?token=${validToken}`, {
      headers: { host: `127.0.0.1:${port}` },
      signal: controller.signal,
    });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    controller.abort();
  });

  it('rejects unauthenticated requests on obfuscated / encoded API paths and traversal attempts', async () => {
    function sendRaw(method: string, reqPath: string, payload?: unknown): Promise<{ statusCode: number; body: string }> {
      return new Promise((resolve, reject) => {
        const bodyStr = payload ? JSON.stringify(payload) : undefined;
        const req = http.request(
          {
            host: '127.0.0.1',
            port: config.port,
            path: reqPath,
            method,
            headers: {
              host: `127.0.0.1:${config.port}`,
              ...(bodyStr ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(bodyStr) } : {}),
            },
          },
          (res) => {
            let data = '';
            res.on('data', (c) => {
              data += c;
            });
            res.on('end', () => resolve({ statusCode: res.statusCode || 0, body: data }));
          },
        );
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
      });
    }

    const testCases: Array<{ method: string; url: string; payload?: unknown; expectedStatus: number[] }> = [
      { method: 'GET', url: '/%61pi/status', expectedStatus: [401] },
      { method: 'GET', url: '/%61%70%69/status', expectedStatus: [401] },
      { method: 'GET', url: '//api/status', expectedStatus: [400, 401, 404] },
      { method: 'GET', url: '/api%2fstatus', expectedStatus: [400] },
      { method: 'GET', url: '/./api/status', expectedStatus: [400] },
      { method: 'GET', url: '/api/../api/status', expectedStatus: [400] },
      { method: 'GET', url: '/API/status', expectedStatus: [400, 401, 404] },
      { method: 'GET', url: '/%61pi/events', expectedStatus: [401] },
      { method: 'POST', url: '/%61pi/projects', payload: { name: 'test', path: '/tmp' }, expectedStatus: [401] },
    ];

    for (const tc of testCases) {
      const res = await sendRaw(tc.method, tc.url, tc.payload);

      expect(tc.expectedStatus).toContain(res.statusCode);
      // Ensure API data is NEVER returned
      if (res.statusCode === 200) {
        throw new Error(`Expected error status for ${tc.method} ${tc.url}, but got 200: ${res.body}`);
      }
    }
  });

  it('every registered /api* route rejects unauthenticated requests with 401', async () => {
    function parseRoutesFromTree(treeText: string): Array<{ method: string; path: string }> {
      const lines = treeText.split('\n');
      const routes: Array<{ method: string; path: string }> = [];
      const stack: Array<{ depth: number; part: string }> = [];

      for (const rawLine of lines) {
        if (!rawLine.trim()) continue;
        const match = rawLine.match(/^([│\s]*[├└]──\s*)([^\s(]+)(?:\s*\(([^)]+)\))?/);
        if (!match) continue;
        const prefix = match[1];
        const part = match[2];
        const methodsStr = match[3] || '';
        const methods = methodsStr.split(',').map((m) => m.trim()).filter(Boolean);

        const depth = prefix.length;
        while (stack.length > 0 && stack[stack.length - 1].depth >= depth) {
          stack.pop();
        }
        stack.push({ depth, part });

        if (methods.length > 0) {
          const fullPath = stack.map((s) => s.part).join('').replace(/\/+/g, '/');
          for (const method of methods) {
            routes.push({ method, path: fullPath });
          }
        }
      }
      return routes;
    }

    const routeTree = server.printRoutes({ commonPrefix: false });
    const allRoutes = parseRoutesFromTree(routeTree);
    const apiRoutes = allRoutes.filter((r) => r.path.startsWith('/api'));
    expect(apiRoutes.length).toBeGreaterThan(0);

    for (const route of apiRoutes) {
      // Replace path parameters with mock identifiers
      const concreteUrl = route.path
        .replace(':id', 'mock-id')
        .replace(':name', 'mock-name')
        .replace(':sessionId', 'mock-session');

      const res = await server.inject({
        method: route.method as 'GET' | 'POST' | 'PATCH' | 'DELETE' | 'PUT' | 'HEAD',
        url: concreteUrl,
        headers: { host: `127.0.0.1:${config.port}` },
      });

      expect(res.statusCode).toBe(401);
      if (route.method !== 'HEAD') {
        const body = JSON.parse(res.body);
        expect(body.error).toBe('unauthorized');
      }
    }
  });
});

