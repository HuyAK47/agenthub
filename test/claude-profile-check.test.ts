import { describe, it, expect, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';

describe('Kiểm tra hồ sơ Claude', () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });

  it('dùng cấu hình Claude của hồ sơ, không gọi Codex CLI', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-check-'));
    const prevHome = process.env.AGENTHUB_HOME;
    const prevCodex = process.env.AGENTHUB_CODEX_BIN;
    process.env.AGENTHUB_HOME = tmp;
    // A fake codex that leaves a marker: the Claude check must never run it.
    const marker = path.join(tmp, 'codex-called');
    const fakeCodex = path.join(tmp, 'codex');
    fs.writeFileSync(fakeCodex, `#!/bin/sh\ntouch ${marker}\necho "Logged in using ChatGPT"\n`, { mode: 0o755 });
    process.env.AGENTHUB_CODEX_BIN = fakeCodex;

    const config = loadConfig(tmp);
    config.agyHomesDir = path.join(tmp, 'agy-homes');
    const token = getOrCreateToken(config.tokenPath);
    const fake = new FakeEngine() as unknown as Engine;
    const ctx = createContext(config, new Map([['agy', fake], ['codex', fake]]));
    const server = await createServer(ctx.service, config, ctx.chatService);
    await server.ready();
    cleanups.push(async () => {
      await server.close();
      closeContext(ctx);
      fs.rmSync(tmp, { recursive: true, force: true });
      if (prevHome === undefined) delete process.env.AGENTHUB_HOME; else process.env.AGENTHUB_HOME = prevHome;
      if (prevCodex === undefined) delete process.env.AGENTHUB_CODEX_BIN; else process.env.AGENTHUB_CODEX_BIN = prevCodex;
    });

    const home = path.join(tmp, 'claude-homes', 'claude-a');
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, '.claude.json'), JSON.stringify({ oauthAccount: { emailAddress: 'claude-user@example.com', billingType: 'stripe_subscription' } }));
    fs.writeFileSync(path.join(home, '.credentials.json'), '{}');
    ctx.profileRepo.upsert({ name: 'claude-a', engine: 'claude', kind: 'isolated', home, email: null, enabled: 1, authState: null, authMessage: null, verifyUrl: null });

    const res = await server.inject({ method: 'POST', url: '/api/profiles/claude-a/check', headers: { Authorization: `Bearer ${token}`, Host: '127.0.0.1:7700' } });
    expect(res.statusCode).toBe(202);
    for (let i = 0; i < 50 && ctx.profileRepo.get('claude-a')?.authState !== 'ok'; i++) await new Promise((r) => setTimeout(r, 50));

    expect(ctx.profileRepo.get('claude-a')).toMatchObject({ authState: 'ok', email: 'claude-user@example.com' });
    expect(fs.existsSync(marker)).toBe(false);
  });
});
