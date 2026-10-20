import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/index.js';
import { ClaudeSessionScanner, isClaudeQuotaLimited } from '../src/claude-sessions/scanner.js';
import { ClaudeFailoverState } from '../src/chat/failover.js';
import { attributeTurn, taskRefsFromToolInput } from '../src/claude-sessions/attribution.js';

const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function transcript(dir: string, cwd: string, timestamp: string, status = 'allowed') {
  const file = path.join(dir, 'session.jsonl');
  const event = {
    type: 'assistant', sessionId: 'session', cwd, timestamp,
    quotaLimits: { status, resetsAt: Math.floor(Date.now() / 1000) + 3600, rateLimitType: 'five_hour' },
    message: { id: 'message-1', model: 'claude-sonnet', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'text', text: 'SECRET_TRANSCRIPT_CONTENT' }] },
  };
  fs.writeFileSync(file, `${JSON.stringify(event)}\n`);
  return file;
}

function assistantEvent(sessionId: string, cwd: string, id: string, timestamp: string, input = 10, toolInput?: Record<string, unknown>) {
  return {
    type: 'assistant', sessionId, cwd, timestamp,
    message: {
      id, model: 'claude-sonnet',
      usage: { input_tokens: input, output_tokens: 5 },
      content: toolInput ? [{ type: 'tool_use', name: 'Bash', input: toolInput }] : [{ type: 'text', text: 'private transcript' }],
    },
  };
}

function addProjectAndTask(db: ReturnType<typeof openDatabase>, projectDir: string) {
  db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('proj', 'Project', projectDir);
  db.prepare("INSERT INTO tasks (id,projectId,slug,title) VALUES ('proj~alpha','proj','alpha','Alpha')").run();
}

describe('Claude session privacy and quota handling', () => {
  it('auto-resumes only a stable stopped session into a real chat session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const hitAt = new Date(Date.now() - 20 * 60_000);
    const file = path.join(transcriptDir, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({
      type: 'assistant', sessionId: 'session', cwd: projectDir, timestamp: hitAt.toISOString(),
      quotaLimits: { status: 'rejected', resetsAt: Math.floor(hitAt.getTime() / 1000) + 60, rateLimitType: 'five_hour' },
      message: { id: 'limited', model: 'claude-sonnet', usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'stopped' }] },
    })}\n`);
    fs.utimesSync(file, hitAt, hitAt);
    const scanner = new ClaudeSessionScanner(db, {
      dir: path.join(root, 'projects'),
      autoResume: { enabled: true, prompt: 'resume safely', claudeBin: fakeClaudeBin, profileName: 'claude-test' },
    });
    await scanner.scan();
    db.prepare('UPDATE claude_sessions SET autoResumeEnabled=1 WHERE sessionId=?').run('session');
    await scanner.scan();
    await new Promise((resolve) => setTimeout(resolve, 150));
    const chat = db.prepare("SELECT id,projectId,claudeSessionId,title,state FROM chat_sessions WHERE title LIKE 'Tự tiếp tục:%'").get() as { id: string; projectId: string; claudeSessionId: string; title: string; state: string };
    expect(chat).toMatchObject({ projectId: 'p', claudeSessionId: 'session', state: 'idle' });
    expect(chat.title).toContain('session');
    expect(db.prepare('SELECT role,content FROM chat_messages WHERE sessionId=?').all(chat.id)).toEqual(expect.arrayContaining([
      { role: 'user', content: 'resume safely' },
      expect.objectContaining({ role: 'assistant' }),
    ]));
    expect(db.prepare('SELECT limitResetAt FROM claude_sessions WHERE sessionId=?').get('session')).toEqual({ limitResetAt: null });
    db.close();
  });

  it('does not auto-resume when transcript cwd is missing', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); fs.mkdirSync(transcriptDir, { recursive: true });
    const db = openDatabase(path.join(root, 'hub.db')); const file = path.join(transcriptDir, 'session.jsonl');
    const hitAt = new Date(Date.now() - 20 * 60_000);
    fs.writeFileSync(file, `${JSON.stringify({ type: 'assistant', sessionId: 'session', timestamp: hitAt.toISOString(), quotaLimits: { status: 'rejected', resetsAt: Math.floor(hitAt.getTime() / 1000) - 60 }, message: { id: 'limited', content: [] } })}\n`);
    fs.utimesSync(file, hitAt, hitAt);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), autoResume: { enabled: true, prompt: 'resume', claudeBin: fakeClaudeBin } });
    await scanner.scan();
    db.prepare('UPDATE claude_sessions SET autoResumeEnabled=1 WHERE sessionId=?').run('session');
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM chat_sessions').get()).toEqual({ count: 0 });
    db.close();
  });

  it('deduplicates message ids and reads only appended transcript bytes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); fs.mkdirSync(transcriptDir, { recursive: true });
    const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const file = transcript(transcriptDir, projectDir, new Date().toISOString());
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 1 });
    fs.appendFileSync(file, `${JSON.stringify({ ...JSON.parse(fs.readFileSync(file, 'utf8')), message: { ...JSON.parse(fs.readFileSync(file, 'utf8')).message, id: 'message-2' } })}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 2 });
    await scanner.scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 2 });
    db.close();
  });

  it('splits a referenced turn evenly and supports every task reference shape', () => {
    const tasks = [{ id: 'proj~alpha', slug: 'alpha' }, { id: 'proj~beta', slug: 'beta' }];
    expect(taskRefsFromToolInput({ command: 'proj~alpha' }, tasks)).toEqual(['proj~alpha']);
    expect(taskRefsFromToolInput({ file_path: 'proj/beta' }, tasks)).toEqual(['proj~beta']);
    expect(taskRefsFromToolInput({ url: '/worktrees/proj/alpha' }, tasks)).toEqual(['proj~alpha']);
    expect(taskRefsFromToolInput({ prompt: 'docs/tasks/beta' }, tasks)).toEqual(['proj~beta']);
    expect(taskRefsFromToolInput({ body: '{"slug":"alpha"}' }, tasks)).toEqual(['proj~alpha']);
    expect(attributeTurn(100, ['proj~alpha', 'proj~beta'])).toEqual([
      { taskId: 'proj~alpha', effectiveTokens: 50 }, { taskId: 'proj~beta', effectiveTokens: 50 },
    ]);
    expect(attributeTurn(100, [])).toEqual([{ taskId: '_general', effectiveTokens: 100 }]);
  });

  it('recognizes rejected/limited/exhausted quota states but allows allowed variants', () => {
    expect(isClaudeQuotaLimited('rejected')).toBe(true);
    expect(isClaudeQuotaLimited('limited')).toBe(true);
    expect(isClaudeQuotaLimited('exhausted')).toBe(true);
    expect(isClaudeQuotaLimited('allowed')).toBe(false);
    expect(isClaudeQuotaLimited('allowed_overage')).toBe(false);
    expect(isClaudeQuotaLimited('')).toBe(false);
    expect(isClaudeQuotaLimited(undefined)).toBe(false);
  });

  it('persists rate_limit_info events from stream-json transcripts', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); fs.mkdirSync(transcriptDir, { recursive: true });
    const projectDir = path.join(root, 'project'); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    fs.writeFileSync(path.join(transcriptDir, 'session.jsonl'), `${JSON.stringify({
      type: 'rate_limit_info', cwd: projectDir, timestamp: new Date().toISOString(),
      rate_limit_info: { status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour' },
    })}\n`);
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(db.prepare('SELECT status,resetsAt,rateLimitType FROM claude_quota WHERE id=1').get()).toEqual({
      status: 'allowed_warning', resetsAt: 1_900_000_000, rateLimitType: 'five_hour',
    });
    db.close();
  });

  it('does not persist an out-of-scope transcript or its title/content', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); fs.mkdirSync(transcriptDir); fs.mkdirSync(path.join(transcriptDir, 'encoded'));
    const db = openDatabase(path.join(root, 'hub.db'));
    transcript(path.join(transcriptDir, 'encoded'), '/unregistered/project', new Date().toISOString());
    await new ClaudeSessionScanner(db, { dir: transcriptDir, hubHome: path.join(root, 'hub-home'), worktreesDir: path.join(root, 'worktrees') }).scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) count FROM sqlite_master WHERE sql LIKE '%SECRET_TRANSCRIPT_CONTENT%'").get()).toEqual({ count: 0 });
    db.close();
  });

  it('accepts a registered project and only activates failover for fresh quota observations', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects'); const projectDir = path.join(root, 'project'); fs.mkdirSync(transcriptDir); fs.mkdirSync(projectDir); fs.mkdirSync(path.join(transcriptDir, 'encoded'));
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const state = new ClaudeFailoverState(path.join(root, 'failover.json'));
    transcript(path.join(transcriptDir, 'encoded'), projectDir, new Date(Date.now() - 60 * 60_000).toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: transcriptDir, failoverState: state }).scan();
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 1 });
    expect(state.snapshot().active).toBe(false);
    const fresh = path.join(transcriptDir, 'fresh'); fs.mkdirSync(fresh);
    transcript(fresh, projectDir, new Date().toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: transcriptDir, failoverState: state }).scan();
    expect(state.snapshot().active).toBe(true);
    expect(state.snapshot().evidence?.file).toContain('fresh/session.jsonl');
    expect(state.snapshot().evidence?.line).toBe(1);
    db.close();
  });

  it('clears failover when Claude writes a later activity record', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db'));
    db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('p', 'Project', projectDir);
    const state = new ClaudeFailoverState(path.join(root, 'failover.json'));
    const file = transcript(transcriptDir, projectDir, new Date().toISOString(), 'rejected');
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), failoverState: state }).scan();
    expect(state.snapshot().active).toBe(true);
    const activity = assistantEvent('session', projectDir, 'message-2', new Date().toISOString());
    fs.appendFileSync(file, `${JSON.stringify(activity)}\n`);
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects'), failoverState: state }).scan();
    expect(state.snapshot().active).toBe(false);
    expect(state.snapshot().lastActivityAt).toBe(activity.timestamp);
    db.close();
  });

  it('attributes the complete total of a three-message turn, including after a split scan', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); addProjectAndTask(db, projectDir);
    const now = new Date().toISOString();
    const lines = [
      { type: 'user', sessionId: 'split', cwd: projectDir, uuid: 'turn-1', message: { content: 'do the task' } },
      assistantEvent('split', projectDir, 'one', now),
      assistantEvent('split', projectDir, 'two', now, 20, { command: 'proj~alpha' }),
      assistantEvent('split', projectDir, 'three', now, 30),
    ];
    const file = path.join(transcriptDir, 'split.jsonl');
    fs.writeFileSync(file, `${lines.slice(0, 3).map((line) => JSON.stringify(line)).join('\n')}\n`);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    fs.appendFileSync(file, `${JSON.stringify(lines[3])}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT SUM(effectiveTokens) effective FROM claude_task_usage WHERE taskId=?').get('proj~alpha')).toEqual({ effective: 75 });
    expect(db.prepare("SELECT COUNT(*) count FROM claude_task_usage WHERE turnId LIKE '%:initial'").get()).toEqual({ count: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM claude_usage').get()).toEqual({ count: 3 });
    db.close();
  });

  it('scans 3000 assistant messages in a valid project without quadratic work', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); const projectDir = path.join(root, 'project');
    fs.mkdirSync(transcriptDir, { recursive: true }); fs.mkdirSync(projectDir);
    const db = openDatabase(path.join(root, 'hub.db')); db.prepare('INSERT INTO projects (id,name,path) VALUES (?,?,?)').run('proj', 'Project', projectDir);
    const now = new Date().toISOString();
    const file = path.join(transcriptDir, 'large.jsonl');
    fs.writeFileSync(file, `${Array.from({ length: 3000 }, (_, index) => JSON.stringify(assistantEvent('large', projectDir, `message-${index}`, now))).join('\n')}\n`);
    const started = performance.now();
    await new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') }).scan();
    expect(performance.now() - started).toBeLessThan(2000);
    expect(db.prepare('SELECT messages FROM claude_sessions WHERE sessionId=?').get('large')).toEqual({ messages: 3000 });
    db.close();
  });

  it('stores an out-of-scope scan offset and reads only appended bytes later', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-claude-')); dirs.push(root);
    const transcriptDir = path.join(root, 'projects', 'encoded'); fs.mkdirSync(transcriptDir, { recursive: true });
    const db = openDatabase(path.join(root, 'hub.db')); const file = path.join(transcriptDir, 'outside.jsonl');
    const first = JSON.stringify(assistantEvent('outside', '/not-registered', 'one', new Date().toISOString()));
    fs.writeFileSync(file, `${first}\n`);
    const scanner = new ClaudeSessionScanner(db, { dir: path.join(root, 'projects') });
    await scanner.scan();
    const initial = db.prepare('SELECT offset,eligible FROM claude_scan_state WHERE path=?').get(file) as { offset: number; eligible: number };
    expect(initial).toEqual({ offset: Buffer.byteLength(`${first}\n`), eligible: 0 });
    const second = JSON.stringify(assistantEvent('outside', '/not-registered', 'two', new Date().toISOString()));
    fs.appendFileSync(file, `${second}\n`);
    await scanner.scan();
    expect(db.prepare('SELECT offset,eligible FROM claude_scan_state WHERE path=?').get(file)).toEqual({ offset: Buffer.byteLength(`${first}\n${second}\n`), eligible: 0 });
    expect(db.prepare('SELECT COUNT(*) count FROM claude_sessions').get()).toEqual({ count: 0 });
    db.close();
  });
});
