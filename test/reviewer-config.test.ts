import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { reviewerSettingsFromLegacy } from '../src/reviewer-config.js';

describe('reviewer order configuration', () => {
  it('migrates legacy Codex/Claude settings to the ordered form', () => {
    expect(reviewerSettingsFromLegacy({
      model: 'codex:gpt-5.6-luna',
      claudeFallback: false,
      claudeFallbackAfterMin: 0,
    })).toEqual({
      order: [{ engine: 'codex', model: 'gpt-5.6-luna', profiles: [] }],
      fallback: { onUnavailable: true, onBusyAfterMin: 0, onError: true },
    });
  });

  it('preserves explicit order, fallback and arbiter values when loading config', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-review-config-'));
    try {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ reviewer: {
        order: [{ engine: 'claude', model: 'sonnet', profiles: ['claude-may'] }, { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] }],
        fallback: { onUnavailable: false, onBusyAfterMin: 0, onError: false },
        arbiter: { engine: 'codex', model: 'gpt-5.6-luna' },
      }}));
      const config = loadConfig(home);
      expect(config.reviewer.order).toEqual([
        { engine: 'claude', model: 'sonnet', profiles: ['claude-may'] },
        { engine: 'codex', model: 'gpt-5.6-luna', profiles: [] },
      ]);
      expect(config.reviewer.fallback).toEqual({ onUnavailable: false, onBusyAfterMin: 0, onError: false });
      expect(config.reviewer.arbiter).toEqual({ engine: 'codex', model: 'gpt-5.6-luna' });
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  });
});
