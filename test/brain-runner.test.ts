import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BrainRunner } from '../src/brain/runner.js';
import { BrainTurnRepo, ChatSessionRepo, ProfileRepo, openDatabase } from '../src/db/index.js';
import { EventBus } from '../src/scheduler/index.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function setup(mode: 'suggest' | 'auto' = 'suggest') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-runner-'));
  dirs.push(dir);
  const db = openDatabase(path.join(dir, 'hub.db'));
  const sessions = new ChatSessionRepo(db);
  const turns = new BrainTurnRepo(db);
  const profiles = new ProfileRepo(db);
  const events = new EventBus({ insert: () => 0 } as never);
  const sent: string[] = [];
  const chat = {
    getOrCreateSession(id: string, body: { title?: string; mode?: 'safe' | 'full'; model?: string; profileName?: string; kind?: 'chat' | 'brain' }) {
      if (!sessions.get(id)) sessions.insert({ id, title: body.title, mode: body.mode, model: body.model, profileName: body.profileName, kind: body.kind });
      return sessions.get(id)!;
    },
    sendMessage(_id: string, text: string) { sent.push(text); return { userMessageId: 'u', assistantMessageId: 'a' }; },
  };
  const runner = new BrainRunner({
    config: { fallback: [], policy: [], claudeProfile: 'p', model: 'opus', mode, maxTurnsPerHour: 20, dailyTokenBudget: 0 },
    eventBus: events,
    chatService: chat,
    chatSessionRepo: sessions,
    profileRepo: profiles,
    turnRepo: turns,
    debounceMs: 60_000,
  });
  return { db, sessions, turns, profiles, events, sent, runner };
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
});
