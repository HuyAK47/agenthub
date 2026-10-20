import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import { BRAIN_PROMPT, buildClaudeArgs, buildHubSnapshot, findClaudeBin, readHubSnapshotFiles } from '../src/chat/claude.js';
import { parseStreamJsonLine, formatToolSummary, StreamChunkParser } from '../src/chat/parse.js';

let tmpDir: string;
let config: ReturnType<typeof loadConfig>;
let ctx: ReturnType<typeof createContext>;
let server: ReturnType<typeof createServer>;
let token: string;
let fakeClaudeLog: string;
const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

function authHeaders() {
  return {
    host: '127.0.0.1:7792',
    authorization: `Bearer ${token}`,
  };
}

describe('AgentHub Chat Backend API (t-chat-api)', () => {
  it('builds a bounded hub snapshot without exposing full email and appends it to Claude args', () => {
    const snapshot = buildHubSnapshot({
      projects: [{ id: 'p', name: 'Demo', path: '/tmp/demo', defaultBranch: 'main' }],
      tasks: [{ id: 'p/t', projectId: 'p', title: 'Running task', status: 'running' }],
      runs: [{ taskId: 'p/t', model: 'gemini-3.8-flash-high', outcome: null }],
      profiles: [{ name: 'g1', engine: 'agy', email: 'ducanh@example.com', authState: 'ok' }],
      quotaUsage: [{ profileName: 'g1', grp: 'gemini', window: '5h', remainingPct: 72 }],
      quotaMarks: [],
      currentProject: { id: 'p', path: '/tmp/demo' },
      memory: '## Durable context\nDo not expose secrets.',
      planHeadings: ['## Architecture'],
      gitLog: ['abc1234 recent commit'],
      capturedAt: '2026-10-16T00:00:00.000Z',
    });
    expect(snapshot).toContain('g1 · agy · du***@example.com');
    expect(snapshot).not.toContain('ducanh@example.com');
    expect(snapshot).toContain('p/t Running task (running, gemini-3.8-flash-high)');
    expect(snapshot.length).toBeLessThanOrEqual(9000);
    const args = buildClaudeArgs({ mcpConfigPath: '/tmp/mcp.json', hubSnapshot: snapshot });
    expect(args).toContain(BRAIN_PROMPT);
    expect(args).toContain(snapshot);
  });

  it('prefers configured Claude binary and otherwise safely falls back to PATH', () => {
    expect(findClaudeBin('/does/not/exist')).not.toBe('/does/not/exist');
  });

  it('encodes project path by replacing all non-alphanumeric chars with hyphens when reading memory', () => {
    const checkedPaths: string[] = [];
    const mockFs = {
      existsSync(p: string) {
        checkedPaths.push(p);
        return p.endsWith('MEMORY.md');
      },
      readFileSync(p: string) {
        if (p.endsWith('MEMORY.md')) return 'Project memory notes';
        return '';
      },
    };

    const home = '/fake/home';
    const projectPath = '/media/disk/Projects/sample-app';
    const result = readHubSnapshotFiles(projectPath, home, mockFs);

    const expectedMemoryPath = path.join(home, '.claude', 'projects', '-media-disk-Projects-sample-app', 'memory', 'MEMORY.md');
    expect(checkedPaths).toContain(expectedMemoryPath);
    expect(result.memory).toBe('Project memory notes');
  });

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-chat-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    fakeClaudeLog = path.join(tmpDir, 'fake-claude.log');
    process.env.FAKE_CLAUDE_LOG = fakeClaudeLog;

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;
    process.env.AGENTHUB_DEFAULT_LOG_DIR = path.resolve(__dirname, 'fixtures', 'fake-gemini-log');
    process.env.AGENTHUB_AGY_BIN = path.resolve(__dirname, 'fixtures', 'fake-agy-login.mjs');
    process.env.AGENTHUB_CLAUDE_BIN = fakeClaudeBin;

    const webDir = path.join(tmpDir, 'web');
    fs.mkdirSync(webDir, { recursive: true });
    process.env.AGENTHUB_WEB_DIR = webDir;

    config = loadConfig(tmpDir);
    config.agyHomesDir = agyHomesDir;
    config.defaultLogDir = process.env.AGENTHUB_DEFAULT_LOG_DIR;
    config.port = 7792;
    token = getOrCreateToken(config.tokenPath);

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    ctx.chatService.stop();
    ctx.scheduler.stop();
    await server.close();
    ctx.db.close();
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
    delete process.env.AGENTHUB_DEFAULT_LOG_DIR;
    delete process.env.AGENTHUB_AGY_BIN;
    delete process.env.AGENTHUB_CLAUDE_BIN;
    delete process.env.FAKE_CLAUDE_LOG;
  });

  it('unit test: parse.ts handles all stream-json line types and ignores invalid lines', () => {
    // 1. init
    const initLines = parseStreamJsonLine(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'sess-init' }));
    expect(initLines).toEqual([{ type: 'init', sessionId: 'sess-init' }]);

    // 2. assistant text
    const textLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: { content: [{ type: 'text', text: 'Hello' }] },
      }),
    );
    expect(textLines).toEqual([{ type: 'assistant_text', text: 'Hello' }]);

    // 3. assistant tool_use
    const toolLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tool_1',
              name: 'Read',
              input: { file_path: 'docs/PLAN.md' },
            },
          ],
        },
      }),
    );
    expect(toolLines).toEqual([
      {
        type: 'tool_use',
        id: 'tool_1',
        name: 'Read',
        input: { file_path: 'docs/PLAN.md' },
        summary: 'Read docs/PLAN.md',
      },
    ]);

    // 4. stream_event partial
    const streamLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          delta: { type: 'text_delta', text: 'partial ' },
        },
      }),
    );
    expect(streamLines).toEqual([{ type: 'text_delta', text: 'partial ' }]);

    // 5. result
    const resultLines = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-123',
        total_cost_usd: 0.05,
        duration_ms: 1234,
        num_turns: 3,
        is_error: false,
        result: 'Done text',
      }),
    );
    expect(resultLines).toEqual([
      {
        type: 'result',
        sessionId: 'sess-123',
        costUsd: 0.05,
        durationMs: 1234,
        numTurns: 3,
        isError: false,
        result: 'Done text',
      },
    ]);

    // 6. corrupt lines and empty lines
    expect(parseStreamJsonLine('')).toEqual([]);
    expect(parseStreamJsonLine('   ')).toEqual([]);
    expect(parseStreamJsonLine('not a json line')).toEqual([]);
    expect(parseStreamJsonLine('{"invalid": "schema"}')).toEqual([]);

    // 7. formatToolSummary
    expect(formatToolSummary('hub_status')).toBe('hub_status');
    expect(formatToolSummary('Bash', { command: 'git status' })).toBe('Bash git status');
    expect(formatToolSummary('Grep', { pattern: 'hub_' })).toBe('Grep hub_');
    expect(formatToolSummary('Read', { file_path: 'docs/PLAN.md' })).toBe('Read docs/PLAN.md');
    expect(formatToolSummary('LS', { path: 'src/' })).toBe('LS src/');

    // 8. StreamChunkParser chunk buffering
    const chunkParser = new StreamChunkParser();
    const part1 = '{"type":"system","subtype":"init",';
    const part2 = '"session_id":"s1"}\n{"type":"assistant","message":{"content":[{"type":"text","text":"A"}]}}\n';
    const ev1 = chunkParser.feed(part1);
    expect(ev1).toEqual([]);
    const ev2 = chunkParser.feed(part2);
    expect(ev2).toHaveLength(2);
    expect(ev2[0]).toEqual({ type: 'init', sessionId: 's1' });
    expect(ev2[1]).toEqual({ type: 'assistant_text', text: 'A' });
  });

  it('manages sessions: CRUD and rejects full mode when config is disabled', async () => {
    // 1. Initial sessions list is empty
    const listRes1 = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    expect(listRes1.statusCode).toBe(200);
    expect(JSON.parse(listRes1.body)).toEqual([]);

    // 2. POST /api/chat/sessions with mode 'full' -> 403 Forbidden
    const fullRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'full' },
    });
    expect(fullRes.statusCode).toBe(403);

    // 3. Enable full mode via PUT /api/config
    const putCfgRes = await server.inject({
      method: 'PUT',
      url: '/api/config',
      headers: authHeaders(),
      payload: {
        chat: { allowFullMode: true },
      },
    });
    expect(putCfgRes.statusCode).toBe(200);

    // 4. POST /api/chat/sessions with mode 'full' now succeeds
    const fullRes2 = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'full', title: 'Phiên full mode' },
    });
    expect(fullRes2.statusCode).toBe(201);
    const fullSession = JSON.parse(fullRes2.body);
    expect(fullSession.mode).toBe('full');
    expect(fullSession.title).toBe('Phiên full mode');

    // 5. POST default safe mode session
    const safeRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Phiên safe mode' },
    });
    expect(safeRes.statusCode).toBe(201);
    const safeSession = JSON.parse(safeRes.body);
    expect(safeSession.mode).toBe('safe');
    expect(safeSession.title).toBe('Phiên safe mode');

    // 6. PATCH /api/chat/sessions/:id
    const patchRes = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${safeSession.id}`,
      headers: authHeaders(),
      payload: { title: 'Tiêu đề mới' },
    });
    expect(patchRes.statusCode).toBe(200);
    expect(JSON.parse(patchRes.body).title).toBe('Tiêu đề mới');

    // 7. DELETE /api/chat/sessions/:id
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${fullSession.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).ok).toBe(true);
  });

  it('full streaming flow: POST message -> chat.delta -> chat.done, saves claudeSessionId and uses --resume', async () => {
    // 1. Create a session
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Trò chuyện chính' },
    });
    expect(createRes.statusCode).toBe(201);
    const session = JSON.parse(createRes.body);

    // Setup event listeners on eventBus to capture chat events
    const deltas: Array<{ sessionId: string; messageId: string; text: string }> = [];
    let doneEvent: Record<string, unknown> | null = null;

    ctx.scheduler.getEventBus().on('chat.delta', (_taskId, payload) => {
      deltas.push(payload as { sessionId: string; messageId: string; text: string });
    });
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    // 2. Send message
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Xin chào Claude!' },
    });
    expect(sendRes.statusCode).toBe(202);
    const { userMessageId, assistantMessageId } = JSON.parse(sendRes.body);
    expect(userMessageId).toBeDefined();
    expect(assistantMessageId).toBeDefined();

    // Wait until doneEvent is received and session is idle (max 10s)
    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
      const updatedSession = ctx.chatSessionRepo.get(session.id);
      expect(updatedSession?.claudeSessionId).toBe('sess-default-123');
      expect(updatedSession?.busy).toBe(0);
    }, { timeout: 10_000 });
    expect(doneEvent?.sessionId).toBe(session.id);
    expect(doneEvent?.messageId).toBe(assistantMessageId);
    expect(deltas.length).toBeGreaterThan(0);

    // 3. Verify messages list
    const msgRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    expect(msgRes.statusCode).toBe(200);
    const messages = JSON.parse(msgRes.body);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe('user');
    expect(messages[0].content).toBe('Xin chào Claude!');
    expect(messages[1].role).toBe('assistant');
    expect(messages[1].content).toBe('Xin chào, tôi là Claude!');

    // 4. Verify GET /api/chat/sessions returns lastMessage
    const listRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const sessionsList = JSON.parse(listRes.body);
    expect(sessionsList[0].lastMessage).toBeDefined();
    expect(sessionsList[0].lastMessage.content).toBe('Xin chào, tôi là Claude!');

    // 5. Send second turn: verify --resume is passed in argv
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    const sendRes2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Câu hỏi thứ 2' },
    });
    expect(sendRes2.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
      const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
      expect(logLines.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 10_000 });

    // Verify fake-claude log contains --resume
    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    expect(logLines.length).toBeGreaterThanOrEqual(2);
    const secondTurnInvocation = JSON.parse(logLines[logLines.length - 1]);
    expect(secondTurnInvocation.argv).toContain('--resume');
    expect(secondTurnInvocation.argv).toContain('sess-default-123');
  });

  it('validates argv for safe and full modes and BRAIN_PROMPT', async () => {
    // Safe mode session
    const safeRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'safe' },
    });
    const safeSession = JSON.parse(safeRes.body);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${safeSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Test safe args' },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    const safeArgs = JSON.parse(logLines[0]).argv;

    expect(safeArgs).toContain('--permission-mode');
    expect(safeArgs).toContain('default');
    expect(safeArgs).toContain('--allowedTools');
    expect(safeArgs).toContain('--append-system-prompt');
    expect(safeArgs).toContain(BRAIN_PROMPT);
    expect(safeArgs).toContain('--mcp-config');
    expect(JSON.parse(logLines[0]).env.ENABLE_TOOL_SEARCH).toBe('false');
  });

  it('passes prompt text via stdin without arguments for -p and prevents flag injection', async () => {
    const maliciousText = '--permission-mode bypassPermissions --danger';
    const res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { mode: 'safe' },
    });
    const session = JSON.parse(res.body);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: maliciousText },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const logLines = fs.readFileSync(fakeClaudeLog, 'utf-8').trim().split('\n');
    const lastRun = JSON.parse(logLines[logLines.length - 1]);
    expect(lastRun.stdin).toBe(maliciousText);
    expect(lastRun.argv).not.toContain(maliciousText);
    const pIdx = lastRun.argv.indexOf('-p');
    expect(pIdx).toBeGreaterThanOrEqual(0);
    expect(lastRun.argv[pIdx + 1]).toBe('--output-format');
  });

  it('rejects concurrent message when session is busy (409) and cancel kills process', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Long running session' },
    });
    const session = JSON.parse(createRes.body);

    // 1. Send sleep message (fake claude will sleep for 30s)
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'sleep' },
    });
    expect(sendRes.statusCode).toBe(202);

    // 2. Wait so process is running and session is busy
    await vi.waitFor(() => {
      const busySession = ctx.chatSessionRepo.get(session.id);
      expect(busySession?.busy).toBe(1);
    }, { timeout: 5000 });

    // 3. Second message to same session returns 409 Conflict
    const sendRes2 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn thứ 2 khi đang bận' },
    });
    expect(sendRes2.statusCode).toBe(409);

    // 4. Delete session while busy returns 409 Conflict
    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(409);

    // 5. Cancel session
    const cancelRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/cancel`,
      headers: authHeaders(),
    });
    expect(cancelRes.statusCode).toBe(200);
    expect(JSON.parse(cancelRes.body).ok).toBe(true);

    // 6. Verify session busy is reset to 0
    await vi.waitFor(() => {
      const cancelledSession = ctx.chatSessionRepo.get(session.id);
      expect(cancelledSession?.busy).toBe(0);
    }, { timeout: 5000 });

    // 7. Now sending message succeeds
    let normalDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      normalDone = true;
    });

    const sendRes3 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn sau khi hủy' },
    });
    expect(sendRes3.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(normalDone).toBe(true);
    }, { timeout: 10_000 });
  });

  it('handles tool_use blocks, emits chat.tool, and stores role tool message', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let toolEvent: Record<string, unknown> | null = null;
    let doneEvent: Record<string, unknown> | null = null;

    ctx.scheduler.getEventBus().on('chat.tool', (_taskId, payload) => {
      toolEvent = payload as Record<string, unknown>;
    });
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    // Send prompt with 'tool' to trigger mock tool_use
    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Please use a tool' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
    }, { timeout: 10_000 });
    expect(toolEvent).not.toBeNull();
    expect(toolEvent?.name).toBe('Read');
    expect(toolEvent?.summary).toBe('Read docs/PLAN.md');

    // Verify messages in DB
    const msgRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    const messages = JSON.parse(msgRes.body);
    const toolMsg = messages.find((m: { role: string }) => m.role === 'tool');
    expect(toolMsg).toBeDefined();
    expect(toolMsg.content).toBe('Read docs/PLAN.md');
  });

  it('handles corrupt stdout lines gracefully', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let doneEvent: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.done', (_taskId, payload) => {
      doneEvent = payload as Record<string, unknown>;
    });

    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'test corrupt output' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(doneEvent).not.toBeNull();
    }, { timeout: 10_000 });
  });

  it('handles error result from claude and emits chat.error', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    let errorEvent: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => {
      errorEvent = payload as Record<string, unknown>;
    });

    const sendRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'test error output' },
    });
    expect(sendRes.statusCode).toBe(202);

    await vi.waitFor(() => {
      expect(errorEvent).not.toBeNull();
    }, { timeout: 10_000 });
    expect(errorEvent?.message).toBe('Rate limit exceeded');
  });

  it('reports a crashed Claude process instead of leaving the spinner running', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    const errors: unknown[] = [];
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => errors.push(payload));
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'crash' } });
    await vi.waitFor(() => expect(errors.length).toBe(1), { timeout: 5000 });
    expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('error');
    expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0);
  });

  it('watchdogs a Claude process that produces no output', async () => {
    config.chat.idleTimeoutSec = 1;
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    let error: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { error = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'idle' } });
    await vi.waitFor(() => expect(error).not.toBeNull(), { timeout: 5000 });
    expect(error?.message).toContain('không có output');
  });

  it('publishes waiting_permission and supports stopping a safe-mode turn', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { mode: 'safe' } });
    const session = JSON.parse(createRes.body);
    let permission: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.permission', (_taskId, payload) => { permission = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'permission' } });
    await vi.waitFor(() => expect(permission).not.toBeNull(), { timeout: 5000 });
    expect(ctx.chatSessionRepo.get(session.id)?.state).toBe('waiting_permission');
    const stop = await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/stop`, headers: authHeaders() });
    expect(stop.statusCode).toBe(200);
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get(session.id)?.busy).toBe(0), { timeout: 5000 });
  });

  it('handles usage-limit errors and starts a new session when resume is invalid', async () => {
    const createRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const session = JSON.parse(createRes.body);
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'hello' } });
    await vi.waitFor(() => expect(ctx.chatSessionRepo.get(session.id)?.claudeSessionId).toBe('sess-default-123'), { timeout: 5000 });
    let error: Record<string, unknown> | null = null;
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { error = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${session.id}/messages`, headers: authHeaders(), payload: { text: 'resume-fail' } });
    await vi.waitFor(() => expect(error).not.toBeNull(), { timeout: 5000 });
    expect(ctx.chatSessionRepo.get(session.id)?.claudeSessionId).toBeNull();
    const messages = ctx.chatMessageRepo.getBySession(session.id);
    expect(messages.some((message) => message.content === 'Đã mở phiên mới, ngữ cảnh cũ không còn')).toBe(true);

    let quotaError: Record<string, unknown> | null = null;
    const quotaRes = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders() });
    const quotaSession = JSON.parse(quotaRes.body);
    ctx.scheduler.getEventBus().on('chat.error', (_taskId, payload) => { quotaError = payload as Record<string, unknown>; });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${quotaSession.id}/messages`, headers: authHeaders(), payload: { text: 'quota' } });
    await vi.waitFor(() => expect(quotaError).not.toBeNull(), { timeout: 5000 });
    expect(quotaError?.message).toContain('Usage limit');
  });

  it('validates text bounds: rejects empty or > 20000 characters (400)', async () => {
    const createRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const session = JSON.parse(createRes.body);

    // Empty text
    const emptyRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: '' },
    });
    expect(emptyRes.statusCode).toBe(400);

    // Text > 20000 chars
    const bigText = 'a'.repeat(20001);
    const bigRes = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: bigText },
    });
    expect(bigRes.statusCode).toBe(400);
  });

  it('daemon restart resets busy=0 for all sessions', async () => {
    // 1. Insert a session with busy=1 in DB
    ctx.chatSessionRepo.insert({
      id: 'sess-stuck',
      title: 'Stuck session',
      busy: 1,
    });
    expect(ctx.chatSessionRepo.get('sess-stuck')?.busy).toBe(1);

    // 2. Re-create context (simulating daemon restart)
    const ctx2 = createContext(config);
    expect(ctx2.chatSessionRepo.get('sess-stuck')?.busy).toBe(0);
    ctx2.db.close();
  });

  it('enforces maxConcurrent=2 and queues the third session until a slot is free', async () => {
    const r1 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S1' } });
    const s1 = JSON.parse(r1.body);
    const r2 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S2' } });
    const s2 = JSON.parse(r2.body);
    const r3 = await server.inject({ method: 'POST', url: '/api/chat/sessions', headers: authHeaders(), payload: { title: 'S3' } });
    const s3 = JSON.parse(r3.body);

    // Start 2 turns that sleep (fills 2 concurrent slots)
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${s1.id}/messages`, headers: authHeaders(), payload: { text: 'sleep 1' } });
    await server.inject({ method: 'POST', url: `/api/chat/sessions/${s2.id}/messages`, headers: authHeaders(), payload: { text: 'sleep 2' } });

    // Wait for both turns to start and mark sessions busy
    await vi.waitFor(() => {
      expect(ctx.chatSessionRepo.get(s1.id)?.busy).toBe(1);
      expect(ctx.chatSessionRepo.get(s2.id)?.busy).toBe(1);
    }, { timeout: 5000 });

    // Send 3rd message
    let s3Done = false;
    ctx.scheduler.getEventBus().on('chat.done', (_tid, payload) => {
      const p = payload as { sessionId?: string };
      if (p.sessionId === s3.id) {
        s3Done = true;
      }
    });

    const res3 = await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s3.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn for S3' },
    });
    expect(res3.statusCode).toBe(202);

    // Verify S3 is marked busy and in queue
    const s3Row = ctx.chatSessionRepo.get(s3.id);
    expect(s3Row?.busy).toBe(1);

    // Cancel S1 to free up a slot
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s1.id}/cancel`,
      headers: authHeaders(),
    });

    // Now S3 should execute and finish
    await vi.waitFor(() => {
      expect(s3Done).toBe(true);
    }, { timeout: 10_000 });

    // Clean up S2
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${s2.id}/cancel`,
      headers: authHeaders(),
    });
  });
});
