import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadConfig } from '../src/config.js';
import { createContext, closeContext } from '../src/daemon.js';
import { createServer } from '../src/api/server.js';
import { getOrCreateToken } from '../src/auth.js';
import { FakeEngine, Engine } from '../src/engines/index.js';
import {
  TelegramBotService,
  readTelegramToken,
  isProjectMergeEnabled,
  redactTelegramToken,
} from '../src/telegram.js';

interface RecordedFetchCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
}

const fakeClaudeBin = path.resolve(__dirname, 'fixtures', 'fake-claude.mjs');

describe('Telegram Bot Remote Control (c-telegram-bot)', () => {
  let tmpDir: string;
  let config: ReturnType<typeof loadConfig>;
  let ctx: ReturnType<typeof createContext>;
  let server: Awaited<ReturnType<typeof createServer>>;
  let token: string;
  let fakeEngine: FakeEngine;

  let recordedCalls: RecordedFetchCall[];
  let fakeFetch: typeof fetch;
  let currentTime: number;

  function authHeaders() {
    return {
      host: '127.0.0.1:7795',
      authorization: `Bearer ${token}`,
    };
  }

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-telegram-test-'));
    const agyHomesDir = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(agyHomesDir, { recursive: true });

    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = agyHomesDir;

    // Create secrets directory and token file
    const secretsDir = path.join(tmpDir, 'secrets');
    fs.mkdirSync(secretsDir, { recursive: true });
    const tokenFile = path.join(secretsDir, 'telegram.token');
    fs.writeFileSync(tokenFile, 'test-bot-token-123456\n', { mode: 0o600 });

    config = loadConfig(tmpDir);
    config.port = 7795;
    config.telegram = {
      enabled: true,
      botTokenFile: tokenFile,
      allowedChatIds: [],
      notify: {
        reviewReady: true,
        failed: true,
        blocked: true,
        quota: true,
        fallback: true,
      },
    };

    token = getOrCreateToken(config.tokenPath);

    fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);

    ctx = createContext(config, engines);
    ctx.scheduler.stop();

    // Mock fetch for Telegram API
    recordedCalls = [];
    currentTime = 1_700_000_000_000;

    fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const urlStr = typeof input === 'string' ? input : input.toString();
      const bodyStr = typeof init?.body === 'string' ? init.body : undefined;
      const bodyObj = bodyStr ? JSON.parse(bodyStr) : undefined;

      recordedCalls.push({
        url: urlStr,
        method: init?.method,
        headers: init?.headers as Record<string, string>,
        body: bodyObj,
      });

      if (urlStr.endsWith('/getUpdates')) {
        return new Response(JSON.stringify({ ok: true, result: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response(JSON.stringify({ ok: true, result: { message_id: 101 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    server = await createServer(ctx.service, config);
    await server.ready();
  });

  afterEach(async () => {
    await server.close();
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  function createTestBotService(opts?: { allowedChatIds?: number[]; execStdout?: string; chatService?: typeof ctx.chatService }) {
    config.telegram.allowedChatIds = opts?.allowedChatIds ? [...opts.allowedChatIds] : [];
    return new TelegramBotService({
      config,
      service: ctx.service,
      eventBus: ctx.scheduler.getEventBus(),
      taskRepo: ctx.taskRepo,
      projectRepo: ctx.projectRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      fetch: fakeFetch,
      now: () => currentTime,
      sleepFn: async () => {},
      execFile: async () => ({ stdout: opts?.execStdout || '1 file changed, 10 insertions(+)' }),
      tokenOverride: 'test-bot-token-123456',
      chatService: opts?.chatService,
    });
  }

  describe('1. Token reading and config security', () => {
    it('readTelegramToken reads trimmed token and enforces 0600 mode', () => {
      const p = path.join(tmpDir, 'secrets', 'custom.token');
      fs.writeFileSync(p, '  my-custom-token \n', { mode: 0o644 });

      const tokenValue = readTelegramToken(p);
      expect(tokenValue).toBe('my-custom-token');

      const stat = fs.statSync(p);
      expect((stat.mode & 0o777)).toBe(0o600);
    });

    it('readTelegramToken returns null if file does not exist or empty', () => {
      expect(readTelegramToken(path.join(tmpDir, 'nonexistent.token'))).toBeNull();

      const emptyPath = path.join(tmpDir, 'secrets', 'empty.token');
      fs.writeFileSync(emptyPath, '   \n');
      expect(readTelegramToken(emptyPath)).toBeNull();
    });

    it('isProjectMergeEnabled parses JSON or returns boolean', () => {
      expect(isProjectMergeEnabled(null)).toBe(false);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: '{"enabled":true}' })).toBe(true);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: '{"enabled":false}' })).toBe(false);
      expect(isProjectMergeEnabled({ id: 'p', name: 'P', path: '', defaultBranch: 'main', envTemplate: null, maxParallel: 1, checks: null, hooks: null, createdAt: '', merge: 'invalid-json' })).toBe(false);
    });
  });

  describe('2. Pairing flow and unauthorized chat rejection', () => {
    it('rejects unrecognized chat when no code or wrong code is provided (silent ignore)', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });

      // Unrecognized chat sends random text
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: 'Hello bot',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      // Unrecognized chat sends /start with wrong code
      await bot.handleUpdate({
        update_id: 2,
        message: {
          message_id: 2,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: '/start 000000',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
      expect(config.telegram.allowedChatIds).not.toContain(999);
    });

    it('pairs successfully with active 6-digit code and ignores subsequent attempts with same code', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      expect(code).toMatch(/^\d{6}$/);

      // Send correct /start <code>
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 3,
          date: 123456,
          chat: { id: 888, type: 'private' },
          text: `/start ${code}`,
        },
      });

      expect(config.telegram.allowedChatIds).toContain(888);
      const sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(sendCalls).toHaveLength(1);
      expect(sendCalls[0].body?.chat_id).toBe(888);
      expect(sendCalls[0].body?.text).toContain('Ghép đôi thành công');

      // Another chat cannot reuse the same consumed code
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 4,
          date: 123456,
          chat: { id: 777, type: 'private' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(777);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);
    });

    it('pairing code expires after 10 minutes', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();

      // Fast forward time by 11 minutes
      currentTime += 11 * 60 * 1000;

      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 5,
          date: 123456,
          chat: { id: 888, type: 'private' },
          text: `/start ${code}`,
        },
      });

      expect(config.telegram.allowedChatIds).not.toContain(888);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('cancels the pairing code after five invalid attempts and records a dashboard event', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      const pairingFailed = vi.fn();
      ctx.scheduler.getEventBus().on('telegram.pairing_failed', pairingFailed);

      for (let attempt = 0; attempt < 5; attempt += 1) {
        await bot.handleUpdate({
          update_id: 20 + attempt,
          message: {
            message_id: 20 + attempt,
            date: 123456,
            chat: { id: 900 + attempt, type: 'private' },
            text: `/start ${code === '000000' ? '000001' : '000000'}`,
          },
        });
      }

      expect(pairingFailed).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          reason: 'too_many_invalid_attempts',
          message: expect.stringContaining('đã bị huỷ'),
        }),
      );

      await bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 30,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(999);
    });

    it('limits invalid pairing attempts from one chat to three per ten minutes', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();
      const pairingFailed = vi.fn();
      ctx.scheduler.getEventBus().on('telegram.pairing_failed', pairingFailed);

      for (let attempt = 0; attempt < 4; attempt += 1) {
        await bot.handleUpdate({
          update_id: 40 + attempt,
          message: {
            message_id: 40 + attempt,
            date: 123456,
            chat: { id: 901, type: 'private' },
            text: '/start 000000',
          },
        });
      }
      expect(pairingFailed).not.toHaveBeenCalled();

      for (let attempt = 0; attempt < 2; attempt += 1) {
        await bot.handleUpdate({
          update_id: 50 + attempt,
          message: {
            message_id: 50 + attempt,
            date: 123456,
            chat: { id: 902 + attempt, type: 'private' },
            text: '/start 000000',
          },
        });
      }
      expect(pairingFailed).toHaveBeenCalledTimes(1);
      expect(code).toMatch(/^\d{6}$/);
    });

    it('does not pair a group chat even with the correct code', async () => {
      const bot = createTestBotService({ allowedChatIds: [] });
      const { code } = bot.getPairingCode();

      await bot.handleUpdate({
        update_id: 60,
        message: {
          message_id: 60,
          date: 123456,
          chat: { id: -123, type: 'group' },
          text: `/start ${code}`,
        },
      });
      expect(config.telegram.allowedChatIds).not.toContain(-123);
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('ignores commands and callback queries from unauthorized chats', async () => {
      const bot = createTestBotService({ allowedChatIds: [12345] });

      // Chat 999 is not in allowedChatIds
      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 6,
          date: 123456,
          chat: { id: 999, type: 'private' },
          text: '/status',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);

      await bot.handleUpdate({
        update_id: 7,
        callback_query: {
          id: 'cb-1',
          from: { id: 999 },
          message: {
            message_id: 7,
            chat: { id: 999 },
          },
          data: 'cancel:confirm:test-task',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });

    it('requires the callback sender to be the paired private chat', async () => {
      const bot = createTestBotService({ allowedChatIds: [12345] });
      await bot.handleUpdate({
        update_id: 8,
        callback_query: {
          id: 'cb-group-user',
          from: { id: 999 },
          message: { message_id: 8, chat: { id: 12345 } },
          data: 'task:retry:missing-task',
        },
      });
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    });
  });

  describe('7. Telegram token redaction', () => {
    it('redacts tokens from fetch errors before they reach callers', async () => {
      config.telegram.allowedChatIds = [12345];
      expect(redactTelegramToken(new Error('fetch failed https://api.telegram.org/bottest-bot-token-123456/sendMessage'), 'test-bot-token-123456'))
        .toContain('bot<redacted>');
      expect(redactTelegramToken(new Error('https://api.telegram.org/bottest-bot-token-123456/sendMessage'), 'test-bot-token-123456'))
        .toContain('<redacted>');

      fakeFetch = vi.fn(async () => {
        throw new Error('fetch failed: https://api.telegram.org/bottest-bot-token-123456/sendMessage');
      }) as unknown as typeof fetch;
      const failingBot = new TelegramBotService({
        config,
        service: ctx.service,
        eventBus: ctx.scheduler.getEventBus(),
        taskRepo: ctx.taskRepo,
        projectRepo: ctx.projectRepo,
        quotaMarkRepo: ctx.quotaMarkRepo,
        fetch: fakeFetch,
        now: () => currentTime,
        sleep: async () => {},
        tokenOverride: 'test-bot-token-123456',
      });

      await expect(failingBot.handleUpdate({
        update_id: 70,
        message: {
          message_id: 70,
          date: 123456,
          chat: { id: 12345, type: 'private' },
          text: '/help',
        },
      })).rejects.toThrow('<redacted>');
    });
  });

  describe('3. Allowed chat commands', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'p1',
        name: 'Project 1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });
      ctx.projectRepo.insert({
        id: 'p2',
        name: 'Project 2',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: true }),
      });

      ctx.taskRepo.insert({
        id: 'p1/task-rev',
        projectId: 'p1',
        slug: 'task-rev',
        title: 'Task chờ review',
        body: 'Yêu cầu 1',
        status: 'review',
        level: 'easy',
        branch: 'task/rev',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-fail',
        projectId: 'p1',
        slug: 'task-fail',
        title: 'Task thất bại',
        body: 'Yêu cầu 2',
        status: 'failed',
        level: 'easy',
        branch: 'task/fail',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-run',
        projectId: 'p1',
        slug: 'task-run',
        title: 'Task đang chạy',
        body: 'Yêu cầu 3',
        status: 'running',
        level: 'easy',
        branch: 'task/run',
        baseRef: 'main',
      });

      // Two tasks with the same slug across projects to test ambiguity
      ctx.taskRepo.insert({
        id: 'p1/duplicate-slug',
        projectId: 'p1',
        slug: 'duplicate-slug',
        title: 'Task trùng 1',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/d1',
        baseRef: 'main',
      });
      ctx.taskRepo.insert({
        id: 'p2/duplicate-slug',
        projectId: 'p2',
        slug: 'duplicate-slug',
        title: 'Task trùng 2',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/d2',
        baseRef: 'main',
      });

      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('/help lists all available commands', async () => {
      await bot.handleUpdate({
        update_id: 10,
        message: {
          message_id: 10,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/help',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('/status');
      expect(calls[0].body?.text).toContain('/tasks');
      expect(calls[0].body?.text).toContain('/task');
      expect(calls[0].body?.text).toContain('&lt;id&gt;');
      expect(calls[0].body?.text).toContain('/approve');
      expect(calls[0].body?.text).toContain('/reject');
      expect(calls[0].body?.text).toContain('/pause');
      expect(calls[0].body?.text).toContain('/resume');
    });

    it('/status returns task overview and scheduler state', async () => {
      await bot.handleUpdate({
        update_id: 11,
        message: {
          message_id: 11,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/status',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Tổng quan trạng thái AgentHub');
      expect(text).toContain('Điều phối');
      expect(text).toContain('Tasks:');
    });

    it('/brain renders transcript session status, request, and last tool', async () => {
      ctx.claudeSessionRepo.upsert({
        sessionId: 'telegram-brain-session', cwd: tmpDir, title: 'Sửa lỗi Telegram',
        lastAt: new Date(Date.now() - 6 * 60_000).toISOString(),
        lastUserRequest: 'Kiểm tra trạng thái bot', lastToolName: 'Bash',
        lastToolSummary: 'Bash: git status --short', lastEventKind: 'assistant_text', fiveHourTokens: 321,
      });

      await bot.handleUpdate({
        update_id: 111,
        message: {
          message_id: 111,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/brain',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Claude · Điều phối');
      expect(text).toContain('chờ bạn trả lời');
      expect(text).toContain('Kiểm tra trạng thái bot');
      expect(text).toContain('Bash: git status --short');
    });

    it('notifies brain waiting only once until the session becomes active again', () => {
      currentTime = Date.now();
      ctx.claudeSessionRepo.upsert({
        sessionId: 'telegram-waiting-once', cwd: tmpDir, title: 'Chờ phản hồi',
        lastAt: new Date(currentTime - 6 * 60_000).toISOString(), lastEventKind: 'assistant_text',
      });
      const handleChatEvent = (bot as unknown as { handleEvent(type: string, taskId?: string, payload?: unknown): void }).handleEvent.bind(bot);

      handleChatEvent('brain.updated');
      handleChatEvent('brain.updated');

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Claude đang chờ bạn trả lời');
    });

    it('/tasks lists tasks and filters by status', async () => {
      // List all tasks
      await bot.handleUpdate({
        update_id: 12,
        message: {
          message_id: 12,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/tasks',
        },
      });
      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Danh sách task');
      expect(calls[0].body?.text).toContain('p1/task-rev');

      // Filter by review status
      recordedCalls = [];
      await bot.handleUpdate({
        update_id: 13,
        message: {
          message_id: 13,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/tasks review',
        },
      });
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Danh sách task (review)');
      expect(calls[0].body?.text).toContain('p1/task-rev');
      expect(calls[0].body?.text).not.toContain('p1/task-fail');
    });

    it('/task shows summary, checks, link, and interactive buttons', async () => {
      await bot.handleUpdate({
        update_id: 14,
        message: {
          message_id: 14,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/task task-rev',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      const text = String(calls[0].body?.text);
      expect(text).toContain('Task: p1/task-rev');
      expect(text).toContain('Task chờ review');
      expect(text).toContain('Mở trên Dashboard');

      // Check inline buttons for review task
      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard).toBeDefined();
      expect(markup.inline_keyboard[0][0].text).toContain('Duyệt & merge');
      expect(markup.inline_keyboard[0][1].text).toContain('Trả về');
      expect(markup.inline_keyboard[1][0].text).toContain('diff');
    });

    it('/task handles ambiguous slug warning', async () => {
      await bot.handleUpdate({
        update_id: 15,
        message: {
          message_id: 15,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/task duplicate-slug',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Có nhiều task trùng slug');
      expect(calls[0].body?.text).toContain('p1/duplicate-slug');
      expect(calls[0].body?.text).toContain('p2/duplicate-slug');
    });

    it('/pause and /resume controls scheduler dispatch', async () => {
      expect(ctx.service.isSchedulerPaused()).toBe(false);

      await bot.handleUpdate({
        update_id: 16,
        message: {
          message_id: 16,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/pause',
        },
      });
      expect(ctx.service.isSchedulerPaused()).toBe(true);

      await bot.handleUpdate({
        update_id: 17,
        message: {
          message_id: 17,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/resume',
        },
      });
      expect(ctx.service.isSchedulerPaused()).toBe(false);
    });

    it('/cancel sends confirmation prompt with inline buttons', async () => {
      await bot.handleUpdate({
        update_id: 18,
        message: {
          message_id: 18,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/cancel p1/task-run',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Bạn có chắc muốn hủy task');
      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('cancel:confirm:p1/task-run');
      expect(markup.inline_keyboard[0][1].callback_data).toBe('cancel:abort:p1/task-run');
    });

    it('/approve approves task and checks project merge config', async () => {
      await bot.handleUpdate({
        update_id: 19,
        message: {
          message_id: 19,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/approve p1/task-rev',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('done');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã duyệt task p1/task-rev');
    });

    it('/reject with inline feedback rejects task', async () => {
      await bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 20,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/reject p1/task-rev Cần viết thêm unit test',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('queued');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã trả về task p1/task-rev với nhận xét');
      expect(calls[0].body?.text).toContain('Cần viết thêm unit test');
    });

    it('/reject without feedback prompts user and waits for input', async () => {
      await bot.handleUpdate({
        update_id: 21,
        message: {
          message_id: 21,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/reject p1/task-rev',
        },
      });

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Vui lòng gửi nhận xét');

      // User replies with feedback
      recordedCalls = [];
      await bot.handleUpdate({
        update_id: 22,
        message: {
          message_id: 22,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Phải sửa lại tên biến',
        },
      });

      const task = ctx.taskRepo.get('p1/task-rev');
      expect(task?.status).toBe('queued');
      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã trả về task p1/task-rev với nhận xét');
      expect(calls[0].body?.text).toContain('Phải sửa lại tên biến');
    });

    it('/retry retries failed task', async () => {
      await bot.handleUpdate({
        update_id: 23,
        message: {
          message_id: 23,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/retry p1/task-fail',
        },
      });

      const task = ctx.taskRepo.get('p1/task-fail');
      expect(['queued', 'waiting_quota']).toContain(task?.status);
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã đưa task p1/task-fail vào hàng đợi');
    });
  });

  describe('4. Inline button callbacks', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'p1',
        name: 'P1',
        path: tmpDir,
        defaultBranch: 'main',
        envTemplate: null,
        maxParallel: 2,
        merge: JSON.stringify({ enabled: false }),
      });

      ctx.taskRepo.insert({
        id: 'p1/task-cb-rev',
        projectId: 'p1',
        slug: 'task-cb-rev',
        title: 'Task CB Review',
        body: '',
        status: 'review',
        level: 'easy',
        branch: 'task/cbrev',
        baseRef: 'main',
      });

      ctx.taskRepo.insert({
        id: 'p1/task-cb-run',
        projectId: 'p1',
        slug: 'task-cb-run',
        title: 'Task CB Running',
        body: '',
        status: 'running',
        level: 'easy',
        branch: 'task/cbrun',
        baseRef: 'main',
      });

      bot = createTestBotService({ allowedChatIds: [CHAT_ID], execStdout: '2 files changed, 15 insertions(+)' });
    });

    it('cancel:confirm cancels task', async () => {
      await bot.handleUpdate({
        update_id: 30,
        callback_query: {
          id: 'cb-cancel',
          from: { id: CHAT_ID },
          message: {
            message_id: 30,
            chat: { id: CHAT_ID },
          },
          data: 'cancel:confirm:p1/task-cb-run',
        },
      });

      const task = ctx.taskRepo.get('p1/task-cb-run');
      expect(task?.status).toBe('cancelled');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã hủy task p1/task-cb-run');
    });

    it('review:approve approves task', async () => {
      await bot.handleUpdate({
        update_id: 31,
        callback_query: {
          id: 'cb-approve',
          from: { id: CHAT_ID },
          message: {
            message_id: 31,
            chat: { id: CHAT_ID },
          },
          data: 'review:approve:p1/task-cb-rev',
        },
      });

      const task = ctx.taskRepo.get('p1/task-cb-rev');
      expect(task?.status).toBe('done');
      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Đã duyệt task p1/task-cb-rev');
    });

    it('task:diff fetches diff summary', async () => {
      await bot.handleUpdate({
        update_id: 32,
        callback_query: {
          id: 'cb-diff',
          from: { id: CHAT_ID },
          message: {
            message_id: 32,
            chat: { id: CHAT_ID },
          },
          data: 'task:diff:p1/task-cb-rev',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Diff tóm tắt');
      expect(calls[0].body?.text).toContain('2 files changed, 15 insertions(+)');
    });
  });

  describe('5. EventBus notifications and deduplication', () => {
    let bot: TelegramBotService;
    const CHAT_ID = 12345;

    beforeEach(() => {
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
      bot.start();
    });

    afterEach(async () => {
      await bot.stop();
    });

    it('broadcasts review_ready with inline keyboard', async () => {
      ctx.scheduler.getEventBus().emit('task.review_ready', 'p1/task-test', {
        title: 'Tính năng mới',
        checksPassed: true,
      });

      // Flush queue
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
      expect(calls[0].body?.text).toContain('Task chờ review');
      expect(calls[0].body?.text).toContain('Tính năng mới');
      expect(calls[0].body?.text).toContain('Checks: ✓ Đạt');

      const markup = calls[0].body?.reply_markup as { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
      expect(markup.inline_keyboard[0][0].callback_data).toBe('review:approve:p1/task-test');
      expect(markup.inline_keyboard[0][1].callback_data).toBe('review:reject_prompt:p1/task-test');
      expect(markup.inline_keyboard[1][0].callback_data).toBe('task:diff:p1/task-test');
    });

    it('broadcasts task.failed and task.blocked with retry/log buttons', async () => {
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-f', { title: 'Bị lỗi compile' });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Task thất bại');
      expect(calls[0].body?.text).toContain('Bị lỗi compile');

      recordedCalls = [];
      currentTime += 15_000; // pass deduplication window
      ctx.scheduler.getEventBus().emit('task.blocked', 'p1/task-b', { title: 'Thiếu key' });
      await bot.flushQueue(CHAT_ID);

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Task bị chặn');
      expect(calls[0].body?.text).toContain('Thiếu key');
    });

    it('suppresses duplicate event notifications within 10 seconds', async () => {
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-dedup', { title: 'Lỗi' });
      ctx.scheduler.getEventBus().emit('task.failed', 'p1/task-dedup', { title: 'Lỗi' });
      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls).toHaveLength(1);
    });

    it('broadcasts quota.exhausted and disk alerts', async () => {
      ctx.scheduler.getEventBus().emit('quota.exhausted', undefined, {
        profile: 'g1',
        family: 'gemini-pro',
        time: '18:30',
      });
      await bot.flushQueue(CHAT_ID);

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Hết Quota');
      expect(calls[0].body?.text).toContain('g1');

      recordedCalls = [];
      currentTime += 15_000;
      ctx.scheduler.getEventBus().emit('disk.low', undefined, { freeGB: 2, minFreeGB: 5 });
      await bot.flushQueue(CHAT_ID);

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[0].body?.text).toContain('Ổ đĩa thấp');
    });
  });

  describe('6. Claude chat bridge', () => {
    it('routes ordinary messages to one telegram:<chatId> session and supports /new and /stop', async () => {
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });

      await bot.handleUpdate({ update_id: 1000, message: {
        message_id: 1000, date: 1, chat: { id: 321, type: 'private' }, text: 'Xin chào',
      } });
      await vi.waitFor(() => expect(ctx.chatSessionRepo.get('telegram:321')?.busy).toBe(0), { timeout: 10_000 });
      expect(ctx.chatMessageRepo.getBySession('telegram:321', 10).some((m) => m.content === 'Xin chào')).toBe(true);

      await bot.handleUpdate({ update_id: 1001, message: {
        message_id: 1001, date: 1, chat: { id: 321, type: 'private' }, text: '/new',
      } });
      const sessions = ctx.chatSessionRepo.getAll({ archived: null });
      expect(sessions.filter((session) => session.id.startsWith('telegram:321:'))).toHaveLength(1);

      await bot.handleUpdate({ update_id: 1002, message: {
        message_id: 1002, date: 1, chat: { id: 321, type: 'private' }, text: '/stop',
      } });
      expect(recordedCalls.some((call) => call.body?.text === '⏹ Đã dừng lượt chat hiện tại.')).toBe(true);
    });

    it('keeps newlines, rate-limits progress edits, and splits long final replies', async () => {
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });
      const botAny = bot as unknown as { chatProgressText(text: string): string };
      expect(botAny.chatProgressText('a\nb')).toBe('a\nb');

      const editTimes: number[] = [];
      const originalFetch = fakeFetch;
      fakeFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.includes('/editMessageText')) editTimes.push(currentTime);
        return originalFetch(input, init);
      }) as unknown as typeof fetch;
      (bot as unknown as { fetchFn: typeof fetch }).fetchFn = fakeFetch;

      (bot as unknown as { chatReplies: Map<string, unknown> }).chatReplies.set('telegram:321', {
        chatId: 321, messageId: 1010, text: '⏳ Đang xử lý…', lastEditAt: currentTime, editing: false,
      });
      const handleChatEvent = (type: string, payload: unknown) => (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent(type, undefined, payload);
      handleChatEvent('chat.delta', { sessionId: 'telegram:321', text: 'x\ny' });
      handleChatEvent('chat.delta', { sessionId: 'telegram:321', text: 'z' });
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(editTimes.length).toBeLessThanOrEqual(1);

      const longText = 'x'.repeat(8_001);
      const chunks = (bot as unknown as { splitTelegramText(text: string): string[] }).splitTelegramText(longText);
      expect(chunks).toHaveLength(3);
      expect(chunks.every((chunk) => chunk.length).valueOf()).toBe(true);
    });

    it('renders permission buttons and sends the selected decision to ChatService', async () => {
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      const bot = createTestBotService({ allowedChatIds: [321], chatService: ctx.chatService });
      await bot.handleUpdate({ update_id: 1020, message: {
        message_id: 1020, date: 1, chat: { id: 321, type: 'private' }, text: 'permission',
      } });
      const pendingPermission = ctx.chatService.permissionBroker.request({
        sessionId: 'telegram:321', messageId: null, toolName: 'Bash', input: { command: 'git status' },
      });
      const permissionId = ctx.chatPermissionRepo.listPending('telegram:321')[0].id;
      (bot as unknown as { handleChatEvent(type: string, taskId?: string, payload?: unknown): void }).handleChatEvent('chat.permission_request', undefined, {
        id: permissionId, sessionId: 'telegram:321', toolName: 'Bash', input: { command: 'git status' },
      });
      await vi.waitFor(() => expect(recordedCalls.some((call) => {
        const keyboard = call.body?.reply_markup as { inline_keyboard?: Array<Array<{ callback_data?: string }>> } | undefined;
        return keyboard?.inline_keyboard?.[0]?.some((button) => button.callback_data?.startsWith('permission:'));
      })).toBe(true), { timeout: 5_000 });

      await bot.handleUpdate({ update_id: 1021, callback_query: {
        id: 'callback-1', from: { id: 321 }, message: { message_id: 1, chat: { id: 321 } }, data: `permission:allow:${permissionId}`,
      } });
      expect(ctx.chatService.permissionBroker.get(permissionId)?.status).toBe('allow');
      ctx.chatService.stop();
      await pendingPermission;
    });
  });

  describe('7. HTTP API Endpoints for Telegram', () => {
    it('GET /api/telegram/pairing-code returns active code and remaining seconds', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/telegram/pairing-code',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.code).toMatch(/^\d{6}$/);
      expect(json.expiresInSec).toBeGreaterThan(0);
      expect(json.enabled).toBe(true);
      expect(Array.isArray(json.allowedChatIds)).toBe(true);

      const code1 = json.code;

      // Repeat GET returns identical unexpired code
      const res2 = await server.inject({
        method: 'GET',
        url: '/api/telegram/pairing-code',
        headers: authHeaders(),
      });
      expect(JSON.parse(res2.body).code).toBe(code1);

      // Refresh generates a new code
      const res3 = await server.inject({
        method: 'POST',
        url: '/api/telegram/pairing-code/refresh',
        headers: authHeaders(),
      });
      expect(res3.statusCode).toBe(200);
      expect(JSON.parse(res3.body).code).toMatch(/^\d{6}$/);
    });

    it('GET /api/telegram/status returns telegram configuration and token presence', async () => {
      const res = await server.inject({
        method: 'GET',
        url: '/api/telegram/status',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const json = JSON.parse(res.body);
      expect(json.enabled).toBe(true);
      expect(json.hasToken).toBe(true);
      expect(json.notify).toBeDefined();
    });
  });
});
