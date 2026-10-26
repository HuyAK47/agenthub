import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { isValidHost, isValidOrigin } from '../src/auth.js';

const envKeys = ['AGENTHUB_HOST', 'AGENTHUB_ALLOWED_HOSTS'] as const;

afterEach(() => {
  for (const key of envKeys) delete process.env[key];
});

describe('LAN dashboard access', () => {
  it('keeps localhost-only security by default and accepts configured hosts', () => {
    expect(isValidHost('127.0.0.1:7700', 7700)).toBe(true);
    expect(isValidHost('192.168.111.15:7700', 7700)).toBe(false);
    expect(isValidOrigin('http://127.0.0.1:7700', 7700)).toBe(true);
    expect(isValidOrigin('http://192.168.111.15:7700', 7700)).toBe(false);

    const allowedHosts = ['192.168.111.15'];
    expect(isValidHost('192.168.111.15:7700', 7700, allowedHosts)).toBe(true);
    expect(isValidHost('192.168.111.16:7700', 7700, allowedHosts)).toBe(false);
    expect(isValidOrigin('http://192.168.111.15:7700', 7700, allowedHosts)).toBe(true);
    expect(isValidOrigin('http://192.168.111.16:7700', 7700, allowedHosts)).toBe(false);
  });

  it('loads host and allowedHosts from environment with precedence and trimming', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lan-config-'));
    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        host: '10.0.0.2',
        allowedHosts: ['10.0.0.2', ' dashboard.local '],
      }));
      process.env.AGENTHUB_HOST = '0.0.0.0';
      process.env.AGENTHUB_ALLOWED_HOSTS = ' 192.168.111.15, dashboard.local ,, ';
      const config = loadConfig(home);
      expect(config.host).toBe('0.0.0.0');
      expect(config.allowedHosts).toEqual(['192.168.111.15', 'dashboard.local']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });

  it('loads host and allowedHosts from user config when env is absent', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-lan-config-'));
    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({
        host: '10.0.0.2',
        allowedHosts: ['10.0.0.2', ' dashboard.local '],
      }));
      const config = loadConfig(home);
      expect(config.host).toBe('10.0.0.2');
      expect(config.allowedHosts).toEqual(['10.0.0.2', 'dashboard.local']);
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
