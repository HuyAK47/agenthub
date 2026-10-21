import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { FakeEngine, type Engine } from '../src/engines/index.js';
import {
  DEFAULT_PROJECT_SETTINGS,
  mergeProjectSettings,
  parseProjectSettings,
  projectSettings,
} from '../src/projects/settings.js';

describe('project settings parsing', () => {
  it('defaults reproduce the behaviour from before settings existed', () => {
    expect(DEFAULT_PROJECT_SETTINGS).toEqual({
      brain: { mode: 'inherit', permissions: 'inherit' },
      worktree: { install: 'auto', gitHooks: 'run' },
      integration: { enabled: false },
      references: [],
      notifications: { telegramContent: 'full' },
    });
    expect(projectSettings(undefined)).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(projectSettings({ settings: null })).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it('never throws on broken or outdated stored JSON', () => {
    expect(parseProjectSettings('{not json')).toEqual(DEFAULT_PROJECT_SETTINGS);
    expect(parseProjectSettings(JSON.stringify({ brain: { mode: 'bogus' } }))).toEqual(DEFAULT_PROJECT_SETTINGS);
    // An older JSON with only some sections still gets defaults for the rest.
    expect(parseProjectSettings(JSON.stringify({ worktree: { install: 'skip' } }))).toEqual({
      ...DEFAULT_PROJECT_SETTINGS,
      worktree: { install: 'skip', gitHooks: 'run' },
    });
  });

  it('merges a partial update field by field and replaces reference lists', () => {
    const current = mergeProjectSettings(DEFAULT_PROJECT_SETTINGS, {
      brain: { mode: 'auto', dailyTokenBudget: 1000 },
      references: [{ name: 'old', path: '/data/old', inject: false }],
    });
    const next = mergeProjectSettings(current, {
      brain: { dailyTokenBudget: 5000 },
      references: [{ name: 'glossary', path: '/data/glossary.md', inject: true }],
    });
    expect(next.brain).toEqual({ mode: 'auto', permissions: 'inherit', dailyTokenBudget: 5000 });
    expect(next.references).toEqual([{ name: 'glossary', path: '/data/glossary.md', inject: true }]);
    expect(next.worktree).toEqual(DEFAULT_PROJECT_SETTINGS.worktree);
  });
});

describe('project settings through the service', () => {
  let tmpDir: string;
  let ctx: ReturnType<typeof createContext>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-project-settings-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    const config = loadConfig(tmpDir);
    config.port = 0;
    const engines = new Map<string, Engine>([['agy', new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'))]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    // createProject requires a real git repo whose default branch exists.
    const repo = path.join(tmpDir, 'repo');
    fs.mkdirSync(repo);
    execFileSync('git', ['init', '-q'], { cwd: repo });
    execFileSync('git', ['symbolic-ref', 'HEAD', 'refs/heads/main'], { cwd: repo });
    execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: repo });
  });

  afterEach(() => {
    ctx.scheduler.stop();
    ctx.db.close();
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('exposes defaults for a project created without settings', () => {
    const created = ctx.service.createProject({ name: 'plain', path: path.join(tmpDir, 'repo') }) as unknown as { settings: unknown };
    expect(created.settings).toEqual(DEFAULT_PROJECT_SETTINGS);
  });

  it('stores settings on create and merges partial updates', () => {
    ctx.service.createProject({
      name: 'fe',
      path: path.join(tmpDir, 'repo'),
      settings: { brain: { mode: 'external' }, worktree: { install: 'skip' } },
    });
    const updated = ctx.service.updateProject('fe', { settings: { worktree: { gitHooks: 'skip' } } }) as unknown as {
      settings: typeof DEFAULT_PROJECT_SETTINGS;
    };
    expect(updated.settings.brain.mode).toBe('external');
    expect(updated.settings.worktree).toEqual({ install: 'skip', gitHooks: 'skip' });

    // Updating other fields leaves settings untouched.
    const renamed = ctx.service.updateProject('fe', { name: 'Frontend' }) as unknown as { settings: typeof DEFAULT_PROJECT_SETTINGS };
    expect(renamed.settings.worktree).toEqual({ install: 'skip', gitHooks: 'skip' });
  });

  it('rejects invalid settings', () => {
    expect(() => ctx.service.createProject({
      name: 'bad',
      path: path.join(tmpDir, 'repo'),
      settings: { brain: { mode: 'sometimes' } },
    })).toThrow();
    expect(() => ctx.service.createProject({
      name: 'bad2',
      path: path.join(tmpDir, 'repo'),
      settings: { references: [{ name: 'has space', path: '/x' }] },
    })).toThrow();
  });
});
