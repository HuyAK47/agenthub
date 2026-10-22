import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrainRunner } from '../src/brain/runner.js';
import { BrainTurnRepo, ChatSessionRepo, ProfileRepo, ProjectRepo, openDatabase } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(mode: 'suggest' | 'auto' = 'suggest', options: { maxConcurrent?: number; dailyTokenBudget?: number; projectSettings?: Record<string, string>; permissions?: 'standard' | 'trusted' | 'full'; setSessionMode?: (id: string, mode: 'safe' | 'full') => void } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-runner-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'hub.db'));
  const sessions = new ChatSessionRepo(db);
  const turns = new BrainTurnRepo(db);
  const profiles = new ProfileRepo(db);
  const projects = new ProjectRepo(db);
  for (const id of Object.keys(options.projectSettings || {})) {
    projects.insert({ id, name: id.toUpperCase(), path: dir, defaultBranch: 'main', envTemplate: null, maxParallel: 1, settings: options.projectSettings?.[id] });
  }
  const events = new EventBus({ insert: () => 0 } as never);
  const sent: string[] = [];
  const chat = {
    getOrCreateSession(id: string, body: { title?: string; mode?: 'safe' | 'full'; model?: string; profileName?: string; kind?: 'chat' | 'brain' }) {
      if (!sessions.get(id)) sessions.insert({ id, title: body.title, mode: body.mode, model: body.model, profileName: body.profileName, kind: body.kind, projectId: id.startsWith('brain:') ? id.slice('brain:'.length) : null });
      return sessions.get(id)!;
    },
    setSessionMode: options.setSessionMode,
    sendMessage(_id: string, text: string) { sent.push(`${_id}: ${text}`); return { userMessageId: 'u', assistantMessageId: 'a' }; },
  };
  const brainConfig = { fallback: [], policy: [], claudeProfile: 'p', model: 'opus', mode, permissions: options.permissions ?? 'standard', maxConcurrent: options.maxConcurrent ?? 2, maxTurnsPerHour: 20, dailyTokenBudget: options.dailyTokenBudget ?? 0 } as const;
  const runner = new BrainRunner({
    config: brainConfig,
    eventBus: events,
    chatService: chat,
    chatSessionRepo: sessions,
    profileRepo: profiles,
    turnRepo: turns,
    debounceMs: 60_000,
    projectRepo: projects,
  });
  return { db, sessions, turns, profiles, projects, events, sent, runner };
}

describe('BrainRunner', () => {
  it('creates one pinned brain session and aggregates events', () => {
    const ctx = setup();
    ctx.runner.start();
    ctx.events.emit('task.review_ready', 'p/task', { title: 'T' });
    ctx.events.emit('task.done', 'p/other');
    ctx.runner.flush();
    expect(ctx.sessions.get('brain')).toMatchObject({ kind: 'brain', pinned: 1, model: 'opus' });
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.review_ready');
    expect(ctx.sent[0]).toContain('Chế độ suggest');
  });

  it('deduplicates quota keys in one brain turn', () => {
    const ctx = setup();
    ctx.runner.start();
    for (let i = 0; i < 30; i += 1) {
      ctx.events.emit('quota.exhausted', `p/task-${i}`, { profile: 'g1', family: 'gemini' });
    }
    ctx.runner.flush();
    const prompt = ctx.sent[0];
    expect(prompt.match(/quota\.exhausted/g)).toHaveLength(1);
  });

  it('does not overlap a user turn and preserves events after quota', () => {
    const ctx = setup('auto');
    ctx.runner.start();
    ctx.events.emit('chat.message', undefined, { sessionId: 'brain', role: 'user' });
    ctx.events.emit('task.failed', 'p/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(0);
    ctx.events.emit('chat.done', undefined, { sessionId: 'brain', usage: { inputTokens: 1, outputTokens: 1 } });
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'RESOURCE_EXHAUSTED quota' });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
  });

  it('keeps the legacy Claude system profile for a brain session without explicit config', () => {
    const ctx = setup();
    ctx.profiles.upsert({ name: 'claude-may', engine: 'claude', kind: 'system', home: os.homedir(), email: null, enabled: 1 });
    ctx.runner.start();
    expect(ctx.sessions.get('brain')?.profileName).toBe('claude-may');
  });

  it('routes project events to separate pinned sessions and system incidents to brain', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 3 });
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.events.emit('task.done', 'p2/task');
    ctx.events.emit('disk.low', undefined, { freeGB: 1 });
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(3);
    expect(ctx.sessions.get('brain:p1')).toMatchObject({ projectId: 'p1', pinned: 1, title: 'Bộ não · P1' });
    expect(ctx.sessions.get('brain:p2')).toMatchObject({ projectId: 'p2', pinned: 1, title: 'Bộ não · P2' });
    expect(ctx.sessions.get('brain')).toMatchObject({ projectId: null, pinned: 1 });
  });

  it('skips off/external projects and inherits the global mode', () => {
    const ctx = setup('auto', { projectSettings: { off: '{"brain":{"mode":"off"}}', external: '{"brain":{"mode":"external"}}', inherited: '{"brain":{"mode":"inherit"}}' }, maxConcurrent: 2 });
    ctx.runner.start();
    ctx.events.emit('task.done', 'off/task');
    ctx.events.emit('task.done', 'external/task');
    ctx.events.emit('task.done', 'inherited/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('brain:inherited');
    expect(ctx.sessions.get('brain:off')).toBeUndefined();
    expect(ctx.sessions.get('brain:external')).toBeUndefined();
  });

  it('uses round-robin scheduling when one project is busy', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, maxConcurrent: 1 });
    ctx.runner.start();
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'P1', kind: 'brain', busy: 1 });
    ctx.events.emit('task.done', 'p1/first');
    ctx.events.emit('task.done', 'p2/second');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('task.done (p2/second)');
  });

  it('applies per-project limits while allowing another project to run', () => {
    const ctx = setup('suggest', { projectSettings: { limited: '{"brain":{"maxTurnsPerHour":1}}', free: '{}' }, maxConcurrent: 1 });
    ctx.runner.start();
    const old = new Date(Date.now() - 10 * 60_000).toISOString();
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, startedAt) VALUES (?, ?, ?, ?, ?, ?)").run('old', 'event', 'old', 'limited', 'done', old);
    ctx.events.emit('task.done', 'limited/task');
    ctx.events.emit('task.done', 'free/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0]).toContain('free/task');
  });

  it('stops every project when the global token budget is exhausted', () => {
    const ctx = setup('suggest', { projectSettings: { p1: '{}', p2: '{}' }, dailyTokenBudget: 100 });
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    ctx.db.prepare("INSERT INTO brain_turns (id, trigger, input, projectId, status, inputTokens, outputTokens, startedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run('global-budget', 'event', 'old', 'p1', 'done', 60, 40, today.toISOString());
    const limited: unknown[] = [];
    ctx.events.on('brain.limited', (_taskId, payload) => limited.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.done', 'p1/task');
    ctx.events.emit('task.done', 'p2/task');
    ctx.runner.flush();
    expect(ctx.sent).toHaveLength(0);
    expect(limited).toContainEqual({ reason: 'budget', scope: 'global' });
    ctx.runner.stop();
  });

  it('drops an event after three ordinary failures and reports an incident', () => {
    const ctx = setup('auto');
    const incidents: unknown[] = [];
    ctx.events.on('brain.notify', (_taskId, payload) => incidents.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.failed');
    for (let attempt = 0; attempt < 3; attempt += 1) {
      ctx.runner.flush();
      ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'temporary failure' });
    }
    expect(ctx.runner.getQueuedEvents()).toHaveLength(0);
    expect(incidents).toContainEqual(expect.objectContaining({ level: 'incident' }));
    ctx.runner.stop();
  });

  it('keeps an event after quota failure and emits brain.waiting', () => {
    const ctx = setup('auto');
    const waiting: unknown[] = [];
    ctx.events.on('brain.waiting', (_taskId, payload) => waiting.push(payload));
    ctx.runner.start();
    ctx.events.emit('task.failed');
    ctx.runner.flush();
    ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'rate limit reached' });
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
    expect(waiting).toContainEqual({ reason: 'quota' });
    ctx.runner.stop();
  });

  it('keeps quota events pending when mode synchronization fails at chat completion', () => {
    let syncAttempts = 0;
    const ctx = setup('auto', {
      permissions: 'full',
      setSessionMode: () => {
        syncAttempts += 1;
        throw new Error('session still running');
      },
    });
    ctx.runner.start();
    ctx.events.emit('task.failed');
    ctx.runner.flush();
    ctx.sessions.updateMode('brain', 'safe');

    expect(() => ctx.events.emit('chat.error', undefined, { sessionId: 'brain', message: 'rate limit reached' })).not.toThrow();
    expect(ctx.runner.getQueuedEvents()).toHaveLength(1);
    expect(syncAttempts).toBe(1);
    ctx.runner.stop();
  });

  it('ensureSession switches idle session to full mode and leaves busy session unchanged', () => {
    const ctx = setup('auto', { projectSettings: { p1: '{"brain":{"permissions":"full"}}', p2: '{"brain":{"permissions":"full"}}' } });
    // p1 has an idle existing session with mode safe
    ctx.sessions.insert({ id: 'brain:p1', projectId: 'p1', title: 'P1', kind: 'brain', mode: 'safe', busy: 0 });
    const s1 = ctx.runner.ensureSession('p1');
    expect(s1.mode).toBe('full');

    // p2 has a busy existing session with mode safe
    ctx.sessions.insert({ id: 'brain:p2', projectId: 'p2', title: 'P2', kind: 'brain', mode: 'safe', busy: 1 });
    const s2 = ctx.runner.ensureSession('p2');
    expect(s2.mode).toBe('safe');
  });
});
