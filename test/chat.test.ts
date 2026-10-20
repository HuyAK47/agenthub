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

    // 5b. result with usage
    const resultWithUsage = parseStreamJsonLine(
      JSON.stringify({
        type: 'result',
        session_id: 'sess-usage',
        is_error: false,
        usage: {
          input_tokens: 150,
          output_tokens: 35,
        },
      }),
    );
    expect(resultWithUsage).toEqual([
      {
        type: 'result',
        sessionId: 'sess-usage',
        isError: false,
        usage: {
          inputTokens: 150,
          outputTokens: 35,
        },
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
    const { messages, hasMore } = JSON.parse(msgRes.body);
    expect(hasMore).toBe(false);
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
    const { messages } = JSON.parse(msgRes.body);
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

  it('supports cursor pagination for messages with default limit 50 and hasMore flag', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Pagination Test' },
    });
    const session = JSON.parse(sRes.body);

    // Insert 60 messages directly via repo to test pagination
    for (let i = 1; i <= 60; i++) {
      const msgId = `msg-${String(i).padStart(3, '0')}`;
      ctx.chatMessageRepo.insert({
        id: msgId,
        sessionId: session.id,
        role: i % 2 === 1 ? 'user' : 'assistant',
        content: `Tin nhắn số ${i}`,
      });
    }

    // 1. Default request (no before, default limit = 50)
    // Should return 50 newest messages (messages 11 to 60) and hasMore = true
    const p1Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
    });
    expect(p1Res.statusCode).toBe(200);
    const p1 = JSON.parse(p1Res.body);
    expect(p1.hasMore).toBe(true);
    expect(p1.messages).toHaveLength(50);
    expect(p1.messages[0].id).toBe('msg-011');
    expect(p1.messages[49].id).toBe('msg-060');

    // 2. Fetch older messages with before = msg-011 and default limit 50
    // Should return remaining 10 messages (messages 1 to 10) and hasMore = false
    const p2Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?before=msg-011`,
      headers: authHeaders(),
    });
    expect(p2Res.statusCode).toBe(200);
    const p2 = JSON.parse(p2Res.body);
    expect(p2.hasMore).toBe(false);
    expect(p2.messages).toHaveLength(10);
    expect(p2.messages[0].id).toBe('msg-001');
    expect(p2.messages[9].id).toBe('msg-010');

    // 3. Custom limit: ?limit=5
    const p3Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?limit=5`,
      headers: authHeaders(),
    });
    expect(p3Res.statusCode).toBe(200);
    const p3 = JSON.parse(p3Res.body);
    expect(p3.hasMore).toBe(true);
    expect(p3.messages).toHaveLength(5);
    expect(p3.messages[0].id).toBe('msg-056');
    expect(p3.messages[4].id).toBe('msg-060');

    // 4. Invalid before messageId
    const p4Res = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/messages?before=non-existent-id`,
      headers: authHeaders(),
    });
    expect(p4Res.statusCode).toBe(200);
    const p4 = JSON.parse(p4Res.body);
    expect(p4.hasMore).toBe(false);
    expect(p4.messages).toHaveLength(0);
  });

  it('searches sessions by title and message content with pinned priority', async () => {
    // Create 3 sessions
    const s1Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Docker containerization guide' },
    });
    const s1 = JSON.parse(s1Res.body);

    const s2Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'General discussion' },
    });
    const s2 = JSON.parse(s2Res.body);

    const s3Res = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Kubernetes orchestration' },
    });
    const s3 = JSON.parse(s3Res.body);

    // Add message with unique keyword to s2
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: s2.id,
      role: 'user',
      content: 'Tối ưu hóa thuật toán Dijkstra',
    });

    // 1. Search by title
    const searchTitleRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Docker',
      headers: authHeaders(),
    });
    expect(searchTitleRes.statusCode).toBe(200);
    const titleMatches = JSON.parse(searchTitleRes.body);
    expect(titleMatches.some((s: { id: string }) => s.id === s1.id)).toBe(true);
    expect(titleMatches.some((s: { id: string }) => s.id === s2.id)).toBe(false);
    expect(titleMatches.some((s: { id: string }) => s.id === s3.id)).toBe(false);

    // 2. Search by message content
    const searchContentRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=Dijkstra',
      headers: authHeaders(),
    });
    expect(searchContentRes.statusCode).toBe(200);
    const contentMatches = JSON.parse(searchContentRes.body);
    expect(contentMatches.some((s: { id: string }) => s.id === s2.id)).toBe(true);
    expect(contentMatches.some((s: { id: string }) => s.id === s1.id)).toBe(false);

    // 3. Search with no matches
    const noMatchRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions?search=khong_the_tim_thay_9999',
      headers: authHeaders(),
    });
    expect(noMatchRes.statusCode).toBe(200);
    expect(JSON.parse(noMatchRes.body)).toHaveLength(0);

    // 4. Pin s2 and verify pinned priority
    await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${s2.id}`,
      headers: authHeaders(),
      payload: { pinned: true },
    });

    const allSessionsRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions',
      headers: authHeaders(),
    });
    const allSessions = JSON.parse(allSessionsRes.body);
    expect(allSessions[0].id).toBe(s2.id);
    expect(allSessions[0].pinned).toBe(1);
  });

  it('exports session to Markdown format', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Phiên export mẫu' },
    });
    const session = JSON.parse(sRes.body);

    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: 'Chào Claude, hãy viết test.',
    });
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'tool',
      content: 'Read src/chat/service.ts',
      meta: JSON.stringify({ name: 'Read', input: { path: 'src/chat/service.ts' } }),
    });
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'assistant',
      content: 'Đây là các bài test hoàn chỉnh.',
    });

    // 1. Export existing session
    const expRes = await server.inject({
      method: 'GET',
      url: `/api/chat/sessions/${session.id}/export`,
      headers: authHeaders(),
    });
    expect(expRes.statusCode).toBe(200);
    expect(expRes.headers['content-type']).toContain('text/markdown');
    const md = expRes.body;
    expect(md).toContain('# Phiên export mẫu');
    expect(md).toContain(`- **ID:** \`${session.id}\``);
    expect(md).toContain('### User');
    expect(md).toContain('Chào Claude, hãy viết test.');
    expect(md).toContain('### Tool: Read');
    expect(md).toContain('Read src/chat/service.ts');
    expect(md).toContain('### Assistant');
    expect(md).toContain('Đây là các bài test hoàn chỉnh.');

    // 2. Export non-existent session -> 404
    const notFoundRes = await server.inject({
      method: 'GET',
      url: '/api/chat/sessions/non-existent-session-id/export',
      headers: authHeaders(),
    });
    expect(notFoundRes.statusCode).toBe(404);
  });

  it('accumulates tokens from stream-json result.usage into session and sets contextTokens', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Token accumulation session' },
    });
    const session = JSON.parse(sRes.body);

    let firstDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      firstDone = true;
    });

    // Turn 1: request with usage:150:40
    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn 1 usage:150:40' },
    });

    await vi.waitFor(() => {
      expect(firstDone).toBe(true);
    }, { timeout: 10_000 });

    let sessRow = ctx.chatSessionRepo.get(session.id);
    expect(sessRow?.inputTokens).toBe(150);
    expect(sessRow?.outputTokens).toBe(40);
    expect(sessRow?.contextTokens).toBe(150);

    // Turn 2: request with usage:220:60
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Turn 2 usage:220:60' },
    });

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
    }, { timeout: 10_000 });

    sessRow = ctx.chatSessionRepo.get(session.id);
    // Accumulated: 150 + 220 = 370 input, 40 + 60 = 100 output
    expect(sessRow?.inputTokens).toBe(370);
    expect(sessRow?.outputTokens).toBe(100);
    // contextTokens should be the input tokens of the latest turn (220)
    expect(sessRow?.contextTokens).toBe(220);
  });

  it('automatically sets session title from first user message up to 60 characters', async () => {
    // 1. Session created without title
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: {},
    });
    const session = JSON.parse(sRes.body);

    const longMessage = 'Xây dựng một hệ thống phân tán chịu lỗi cao với kiến trúc vi dịch vụ và message queue Apache Kafka';
    // longMessage is 100 chars, first 60 chars:
    const expectedTitle = longMessage.slice(0, 60);

    let done = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      done = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: longMessage },
    });

    await vi.waitFor(() => {
      expect(done).toBe(true);
    }, { timeout: 10_000 });

    const sessRow = ctx.chatSessionRepo.get(session.id);
    expect(sessRow?.title).toBe(expectedTitle);
    expect(sessRow?.title?.length).toBe(60);

    // 2. Second message should NOT overwrite the auto-generated title
    let secondDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      secondDone = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${session.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn thứ 2 ngắn gọn' },
    });

    await vi.waitFor(() => {
      expect(secondDone).toBe(true);
    }, { timeout: 10_000 });

    const sessRow2 = ctx.chatSessionRepo.get(session.id);
    expect(sessRow2?.title).toBe(expectedTitle);

    // 3. Session created with explicit title should NOT be overwritten
    const explicitRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Tiêu đề cố định không đổi' },
    });
    const explicitSession = JSON.parse(explicitRes.body);

    let explicitDone = false;
    ctx.scheduler.getEventBus().on('chat.done', () => {
      explicitDone = true;
    });

    await server.inject({
      method: 'POST',
      url: `/api/chat/sessions/${explicitSession.id}/messages`,
      headers: authHeaders(),
      payload: { text: 'Tin nhắn đầu tiên của phiên có tiêu đề sẵn' },
    });

    await vi.waitFor(() => {
      expect(explicitDone).toBe(true);
    }, { timeout: 10_000 });

    const explicitRow = ctx.chatSessionRepo.get(explicitSession.id);
    expect(explicitRow?.title).toBe('Tiêu đề cố định không đổi');
  });

  it('supports PATCH for title, pinned, and archived, and DELETE cleans up session and messages', async () => {
    const sRes = await server.inject({
      method: 'POST',
      url: '/api/chat/sessions',
      headers: authHeaders(),
      payload: { title: 'Initial Title' },
    });
    const session = JSON.parse(sRes.body);

    // 1. PATCH title, pinned, archived
    const patchRes1 = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
      payload: { title: 'Updated Title', pinned: true, archived: true },
    });
    expect(patchRes1.statusCode).toBe(200);
    const patched1 = JSON.parse(patchRes1.body);
    expect(patched1.title).toBe('Updated Title');
    expect(patched1.pinned).toBe(1);
    expect(patched1.archived).toBe(1);

    // 2. PATCH unpin and unarchive
    const patchRes2 = await server.inject({
      method: 'PATCH',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
      payload: { pinned: false, archived: false },
    });
    expect(patchRes2.statusCode).toBe(200);
    const patched2 = JSON.parse(patchRes2.body);
    expect(patched2.pinned).toBe(0);
    expect(patched2.archived).toBe(0);

    // 3. DELETE removes session and messages
    ctx.chatMessageRepo.insert({
      id: crypto.randomUUID(),
      sessionId: session.id,
      role: 'user',
      content: 'Will be deleted',
    });

    const delRes = await server.inject({
      method: 'DELETE',
      url: `/api/chat/sessions/${session.id}`,
      headers: authHeaders(),
    });
    expect(delRes.statusCode).toBe(200);
    expect(JSON.parse(delRes.body).ok).toBe(true);

    expect(ctx.chatSessionRepo.get(session.id)).toBeUndefined();
    expect(ctx.chatMessageRepo.getBySession(session.id)).toHaveLength(0);
  });
});
