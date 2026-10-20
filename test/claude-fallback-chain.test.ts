import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ClaudeFailoverState, normalizeFallbackSteps } from '../src/chat/failover.js';
import { loadConfig } from '../src/config.js';

describe('Claude fallback chain', () => {
  it('normalizes supported steps and drops malformed entries', () => {
    expect(normalizeFallbackSteps([
      { type: 'profile', profile: 'claude-b' },
      { type: 'model', model: 'sonnet' },
      { type: 'apiKey', dailyCapUSD: 5 },
      { type: 'engine', engine: 'codex' },
      { type: 'unknown' },
    ])).toEqual([
      { type: 'profile', profile: 'claude-b' }, { type: 'model', model: 'sonnet' },
      { type: 'apiKey', dailyCapUSD: 5 }, { type: 'engine', engine: 'codex' },
    ]);
  });

  it('advances through steps without persisting the API key', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fallback-chain-'));
    const state = new ClaudeFailoverState(path.join(root, 'state.json'), () => 1, {
      steps: [{ type: 'model', model: 'haiku' }, { type: 'wait' }, { type: 'engine', engine: 'codex' }],
      apiKeyPath: path.join(root, 'secrets', 'anthropic.key'),
    });
    state.activate(3600, 'quota');
    expect(state.snapshot().step).toEqual({ type: 'model', model: 'haiku' });
    expect(state.advance().step).toEqual({ type: 'wait' });
    expect(state.advance().step).toEqual({ type: 'engine', engine: 'codex' });
    state.setApiKey('sk-secret');
    expect(fs.readFileSync(path.join(root, 'state.json'), 'utf8')).not.toContain('sk-secret');
    expect(state.snapshot().apiKeyConfigured).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('tracks daily API-key spend and resets on a new day', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fallback-cost-'));
    let now = Date.UTC(2026, 0, 1) / 1000;
    const state = new ClaudeFailoverState(path.join(root, 'state.json'), () => now, { steps: [{ type: 'apiKey', dailyCapUSD: 5 }] });
    state.recordCost(1.25);
    expect(state.snapshot().dailyCostUSD).toBe(1.25);
    now += 24 * 60 * 60;
    expect(state.snapshot().dailyCostUSD).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('writes the API key with restrictive permissions and never exposes it in status', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fallback-key-'));
    const keyPath = path.join(root, 'secrets', 'anthropic.key');
    const state = new ClaudeFailoverState(path.join(root, 'state.json'), () => 1, { apiKeyPath: keyPath });
    state.setApiKey('sk-test-secret');
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    expect(state.snapshot()).not.toHaveProperty('apiKey');
    expect(state.getApiKey()).toBe('sk-test-secret');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('loads brain fallback settings while preserving the legacy default', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-fallback-config-'));
    expect(loadConfig(root).brain.fallback).toEqual([{ type: 'engine', engine: 'codex' }]);
    fs.writeFileSync(path.join(root, 'config.json'), JSON.stringify({ brain: { fallback: [{ type: 'wait' }] } }));
    expect(loadConfig(root).brain.fallback).toEqual([{ type: 'wait' }]);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
