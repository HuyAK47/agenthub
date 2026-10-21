import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { exchangeAgyRefreshToken, writeAgyIsolatedToken } from '../src/profiles/agyToken.js';
import { createContext } from '../src/daemon.js';

describe('Antigravity Token Import from Cockpit', () => {
  let tmpDir: string;
  let agyHomesDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-agy-import-test-'));
    agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;

    ctx = createContext(config);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    try {
      ctx.db.close();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  it('exchangeAgyRefreshToken exchanges valid refresh token for access token', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'mock_access_token_xyz',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const res = await exchangeAgyRefreshToken('mock_refresh_token_abc');
    expect(res.accessToken).toBe('mock_access_token_xyz');
    expect(res.tokenType).toBe('Bearer');
    expect(res.refreshToken).toBe('mock_refresh_token_abc');
    expect(typeof res.expiry).toBe('string');
  });

  it('exchangeAgyRefreshToken throws descriptive error on invalid_grant', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: async () => ({
        error: 'invalid_grant',
        error_description: 'Token has been revoked or expired',
      }),
    } as unknown as Response);

    await expect(exchangeAgyRefreshToken('bad_token')).rejects.toThrow(
      /Refresh token không hợp lệ hoặc đã bị thu hồi\/hết hạn/,
    );
  });

  it('writeAgyIsolatedToken creates token file with 0600 permissions and auth log', () => {
    const profileHome = path.join(agyHomesDir, 'test_user');
    fs.mkdirSync(profileHome, { recursive: true });

    writeAgyIsolatedToken(
      profileHome,
      {
        accessToken: 'access_123',
        refreshToken: 'refresh_123',
        tokenType: 'Bearer',
        expiry: '2026-12-31T00:00:00.000Z',
      },
      'test_user@example.com',
    );

    const tokenFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    expect(fs.existsSync(tokenFile)).toBe(true);

    const stat = fs.statSync(tokenFile);
    expect(stat.mode & 0o777).toBe(0o600);

    const logFile = path.join(profileHome, '.gemini', 'antigravity-cli', 'log', 'auth.log');
    expect(fs.existsSync(logFile)).toBe(true);
    const logContent = fs.readFileSync(logFile, 'utf8');
    expect(logContent).toContain('authenticated successfully as test_user@example.com');
  });

  it('importAgyTokens successfully imports single and array Cockpit tokens into database without leaking secrets', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'live_access_token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    const input = [
      {
        email: 'huy1071718@gmail.com',
        refresh_token: '1//mock_refresh_token_huy',
      },
      {
        email: 'second_user@example.com',
        refresh_token: '1//mock_refresh_token_second',
      },
    ];

    const result = await ctx.service.importAgyTokens(input);

    expect(result.success).toBe(true);
    expect(result.total).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.failedCount).toBe(0);

    // Ensure secrets are never exposed in result
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain('1//mock_refresh_token_huy');
    expect(serialized).not.toContain('live_access_token');

    // Verify profiles in database
    const prof1 = ctx.profileRepo.get('huy1071718');
    expect(prof1).toBeDefined();
    expect(prof1?.email).toBe('huy1071718@gmail.com');
    expect(prof1?.engine).toBe('agy');
    expect(prof1?.authState).toBe('ok');

    const prof2 = ctx.profileRepo.get('second_user');
    expect(prof2).toBeDefined();
    expect(prof2?.email).toBe('second_user@example.com');
    expect(prof2?.authState).toBe('ok');
  });

  it('importAgyTokens updates token for existing profile with the same email without duplicating', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({
        access_token: 'updated_token',
        expires_in: 3600,
        token_type: 'Bearer',
      }),
    } as unknown as Response);

    // First import
    await ctx.service.importAgyTokens({
      email: 'my_account@gmail.com',
      refresh_token: 'token_v1',
    });

    expect(ctx.profileRepo.get('my_account')?.email).toBe('my_account@gmail.com');

    // Second import with new token
    const result2 = await ctx.service.importAgyTokens({
      email: 'my_account@gmail.com',
      refresh_token: 'token_v2',
    });

    expect(result2.successCount).toBe(1);
    expect(result2.results[0].action).toBe('updated');
    expect(result2.results[0].name).toBe('my_account');
  });

  it('importAgyTokens isolates errors per item', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (_url, init) => {
      const body = String(init?.body || '');
      if (body.includes('bad_token')) {
        return {
          ok: false,
          status: 400,
          json: async () => ({ error: 'invalid_grant' }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: 'good_token',
          expires_in: 3600,
          token_type: 'Bearer',
        }),
      } as unknown as Response;
    });

    const result = await ctx.service.importAgyTokens([
      { email: 'bad@example.com', refresh_token: 'bad_token' },
      { email: 'good@example.com', refresh_token: 'good_token' },
    ]);

    expect(result.total).toBe(2);
    expect(result.successCount).toBe(1);
    expect(result.failedCount).toBe(1);

    expect(ctx.profileRepo.get('bad')).toBeUndefined();
    expect(ctx.profileRepo.get('good')).toBeDefined();
  });
});
