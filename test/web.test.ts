import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer, resolveWebDir } from '../src/api/server.js';

describe('Web static directory resolution', () => {
  let tmpDir: string;
  let mockWebDir: string;
  let originalCwd: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-web-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    mockWebDir = path.join(tmpDir, 'custom-web');
    fs.mkdirSync(mockWebDir, { recursive: true });
    fs.writeFileSync(path.join(mockWebDir, 'index.html'), '<html><body>Dashboard Build Content</body></html>');
    originalCwd = process.cwd();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    delete process.env.AGENTHUB_WEB_DIR;
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('serves index.html when cwd is / using AGENTHUB_WEB_DIR', async () => {
    process.env.AGENTHUB_WEB_DIR = mockWebDir;
    process.chdir('/');

    const config = loadConfig(tmpDir);
    config.port = 7795;
    const ctx = createContext(config);
    const server = await createServer(ctx.service, config);
    await server.ready();

    try {
      const res = await server.inject({
        method: 'GET',
        url: '/',
        headers: { host: '127.0.0.1:7795' },
      });

      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('Dashboard Build Content');
    } finally {
      await server.close();
      ctx.db.close();
    }
  });

  it('serves index.html when cwd is changed if build exists relative to module', async () => {
    const distWebDir = path.join(tmpDir, 'dist-web');
    fs.mkdirSync(distWebDir, { recursive: true });
    fs.writeFileSync(path.join(distWebDir, 'index.html'), '<html><body>Built Web from Dist</body></html>');
    expect(resolveWebDir('file:///workspace/dist/api/server.js', {})).toBe('/workspace/dist/web');

    try {
      process.chdir('/');

      const config = loadConfig(tmpDir);
      config.port = 7796;
      const ctx = createContext(config);
      const server = await createServer(ctx.service, config, { webDir: distWebDir });
      await server.ready();

      try {
        const res = await server.inject({
          method: 'GET',
          url: '/',
          headers: { host: '127.0.0.1:7796' },
        });

        expect(res.statusCode).toBe(200);
        expect(res.body).toContain('Built Web from Dist');
      } finally {
        await server.close();
        ctx.db.close();
      }
    } finally { /* temporary directory is removed by afterEach */ }
  });
});
