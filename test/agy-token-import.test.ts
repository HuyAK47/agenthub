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
    config.multiplePerProvider = true;

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
  function mockOkFetch() {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'ok_token', expires_in: 3600, token_type: 'Bearer' }),
    } as unknown as Response);
  }

  it('importAgyTokens updates the existing agy profile that already has the email, even under another name', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'g1', engine: 'agy', accountType: 'team' });
    ctx.profileRepo.upsert({ ...ctx.profileRepo.get('g1')!, email: 'owner@example.com' });

    const result = await ctx.service.importAgyTokens({ email: 'Owner@Example.com', refresh_token: 'tok' });

    expect(result.results[0]).toMatchObject({ name: 'g1', action: 'updated', status: 'ok' });
    expect(ctx.profileRepo.get('owner')).toBeUndefined();
    expect(ctx.profileRepo.get('g1')?.accountType).toBe('team');
  });

  it('importAgyTokens never writes into a profile of another engine or a keyring profile', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'cx', engine: 'codex', accountType: 'team' });

    const result = await ctx.service.importAgyTokens([{ email: 'a@example.com', refresh_token: 'tok', name: 'cx' }]);

    expect(result.results[0].status).toBe('error');
    expect(ctx.profileRepo.get('cx')?.engine).toBe('codex');
    expect(fs.existsSync(path.join(agyHomesDir, 'cx'))).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('importAgyTokens respects multiplePerProvider instead of silently enabling it', async () => {
    mockOkFetch();
    config.multiplePerProvider = false;

    const result = await ctx.service.importAgyTokens([
      { email: 'p1@example.com', refresh_token: 't1' },
      { email: 'p2@example.com', refresh_token: 't2' },
    ]);

    expect(config.multiplePerProvider).toBe(false);
    expect(result.results[1].status).toBe('error');
    expect(ctx.profileRepo.get('p2')).toBeUndefined();
  });

  it('writeAgyIsolatedToken replaces the auth log so the latest email wins', () => {
    const profileHome = path.join(agyHomesDir, 'swap');
    writeAgyIsolatedToken(profileHome, { refreshToken: 'r1' }, 'old@example.com');
    writeAgyIsolatedToken(profileHome, { refreshToken: 'r2' }, 'new@example.com');
    const log = fs.readFileSync(path.join(profileHome, '.gemini', 'antigravity-cli', 'log', 'auth.log'), 'utf8');
    expect(log).toContain('new@example.com');
    expect(log).not.toContain('old@example.com');
  });
  it('importAgyTokens signs an existing not-logged-in agy profile in by name', async () => {
    mockOkFetch();
    ctx.service.createProfile({ name: 'g5', engine: 'agy', accountType: 'personal' });

    const result = await ctx.service.importAgyTokens({
      tokens: [{ name: 'g5', email: 'g5@example.com', refresh_token: 'tok' }],
      accountType: 'personal',
    });

    expect(result.results[0]).toMatchObject({ name: 'g5', action: 'updated', status: 'ok' });
    expect(ctx.profileRepo.get('g5')).toMatchObject({ email: 'g5@example.com', authState: 'ok' });
    expect(fs.existsSync(path.join(agyHomesDir, 'g5', '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))).toBe(true);
  });

  it('importAgyTokens fetches Google user avatar and stores in database', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string | URL) => {
      const urlStr = String(url);
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: 'mock_access_token_avatar',
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        } as unknown as Response;
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            sub: '123456789',
            email: 'avatar_user@example.com',
            picture: 'https://lh3.googleusercontent.com/a/mock_avatar_img_123',
          }),
        } as unknown as Response;
      }
      return { ok: false, status: 404 } as unknown as Response;
    });

    const result = await ctx.service.importAgyTokens([
      { email: 'avatar_user@example.com', refresh_token: 'mock_rt_avatar' },
    ]);

    expect(result.success).toBe(true);
    const profile = ctx.profileRepo.get('avatar_user');
    expect(profile).toBeDefined();
    expect(profile?.avatarUrl).toBe('https://lh3.googleusercontent.com/a/mock_avatar_img_123');

    // Test syncAgyAvatar updates avatarUrl
    const synced = await ctx.service.syncAgyAvatar('avatar_user');
    expect(synced).toBe('https://lh3.googleusercontent.com/a/mock_avatar_img_123');
  });
});

