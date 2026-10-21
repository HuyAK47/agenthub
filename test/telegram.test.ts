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
  slugify,
  generateTaskSlug,
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
      sleep: async () => {},
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
      expect(calls[0].body?.text).toContain('/newtask');
      expect(calls[0].body?.text).toContain('/plan');
      expect(calls[0].body?.text).toContain('/drafts');
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
      expect(calls[0].body?.text).toContain('đang chờ bạn trả lời');
      expect(calls[0].body?.text).toContain('Chờ phản hồi');
    });

    it('does not notify for hub chat / brain sessions that already answered in Telegram', () => {
      currentTime = Date.now();
      ctx.claudeSessionRepo.upsert({
        sessionId: 'hub-chat-waiting', cwd: tmpDir, title: 'Bộ não', isHubChat: 1,
        lastAt: new Date(currentTime - 6 * 60_000).toISOString(), lastEventKind: 'assistant_text',
      });
      const handleChatEvent = (bot as unknown as { handleEvent(type: string, taskId?: string, payload?: unknown): void }).handleEvent.bind(bot);
      handleChatEvent('brain.updated');
      expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
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

  describe('8. Slug generation and collision handling', () => {
    it('slugify removes Vietnamese accents, converts to kebab-case, and handles fallback', () => {
      expect(slugify('Tạo task từ Telegram')).toBe('tao-task-tu-telegram');
      expect(slugify('Đăng nhập & xác thực 100%!')).toBe('dang-nhap-xac-thuc-100');
      expect(slugify('???')).toBe('task');
    });

    it('generateTaskSlug appends incremental counter when slug already exists', () => {
      ctx.projectRepo.insert({
        id: 'proj-1',
        name: 'Test Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });

      ctx.taskRepo.insert({
        id: 'proj-1/sua-loi-dang-nhap',
        projectId: 'proj-1',
        slug: 'sua-loi-dang-nhap',
        title: 'Sửa lỗi đăng nhập',
        level: 'easy',
        status: 'queued',
      });

      const nextSlug = generateTaskSlug('Sửa lỗi đăng nhập', 'proj-1', ctx.taskRepo);
      expect(nextSlug).toBe('sua-loi-dang-nhap-2');

      ctx.taskRepo.insert({
        id: 'proj-1/sua-loi-dang-nhap-2',
        projectId: 'proj-1',
        slug: 'sua-loi-dang-nhap-2',
        title: 'Sửa lỗi đăng nhập 2',
        level: 'easy',
        status: 'queued',
      });

      const thirdSlug = generateTaskSlug('Sửa lỗi đăng nhập', 'proj-1', ctx.taskRepo);
      expect(thirdSlug).toBe('sua-loi-dang-nhap-3');
    });
  });

  describe('9. /newtask command (wizard and quick format)', () => {
    const CHAT_ID = 555;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-shop',
        name: 'E-Commerce Shop',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('completes full step-by-step wizard to create a queued task', async () => {
      // 1. Send /newtask
      await bot.handleUpdate({
        update_id: 1,
        message: {
          message_id: 1,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask',
        },
      });

      let calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn project cho task mới');
      const projKeyboard = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(projKeyboard.inline_keyboard[0][0].callback_data).toBe('newtask:proj:proj-shop');

      // 2. Select project
      await bot.handleUpdate({
        update_id: 2,
        callback_query: {
          id: 'cb-proj',
          from: { id: CHAT_ID },
          message: { message_id: 1, chat: { id: CHAT_ID } },
          data: 'newtask:proj:proj-shop',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Vui lòng nhập <b>tiêu đề</b>');

      // 3. Send title
      await bot.handleUpdate({
        update_id: 3,
        message: {
          message_id: 2,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Tích hợp cổng VNPay',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Nhập <b>đề bài</b> cho task');

      // 4. Send body message 1
      await bot.handleUpdate({
        update_id: 4,
        message: {
          message_id: 3,
          date: 123458,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Bước 1: Tạo URL thanh toán',
        },
      });

      // 5. Send body message 2
      await bot.handleUpdate({
        update_id: 5,
        message: {
          message_id: 4,
          date: 123459,
          chat: { id: CHAT_ID, type: 'private' },
          text: 'Bước 2: Xử lý IPN callback checksum',
        },
      });

      // 6. Send /done
      await bot.handleUpdate({
        update_id: 6,
        message: {
          message_id: 5,
          date: 123460,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/done',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn <b>độ khó</b> cho task');

      // 7. Select level: hard
      await bot.handleUpdate({
        update_id: 7,
        callback_query: {
          id: 'cb-level',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:level:hard',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Chọn <b>model</b> cho task');

      // 8. Select default model
      await bot.handleUpdate({
        update_id: 8,
        callback_query: {
          id: 'cb-model',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:model:default',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const confirmText = calls[calls.length - 1].body?.text as string;
      expect(confirmText).toContain('Xác nhận tạo task');
      expect(confirmText).toContain('tich-hop-cong-vnpay');
      expect(confirmText).toContain('hard');

      // 9. Confirm: Giao ngay
      await bot.handleUpdate({
        update_id: 9,
        callback_query: {
          id: 'cb-confirm',
          from: { id: CHAT_ID },
          message: { message_id: 5, chat: { id: CHAT_ID } },
          data: 'newtask:confirm:queued',
        },
      });

      calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã giao task');

      // Verify task in DB
      const createdTask = ctx.taskRepo.get('proj-shop/tich-hop-cong-vnpay');
      expect(createdTask).toBeDefined();
      expect(['queued', 'waiting_quota']).toContain(createdTask?.status);
      expect(createdTask?.level).toBe('hard');
      expect(createdTask?.title).toBe('Tích hợp cổng VNPay');
      expect(createdTask?.body).toContain('Bước 1: Tạo URL thanh toán');
      expect(createdTask?.body).toContain('Bước 2: Xử lý IPN callback checksum');
    });

    it('creates a draft task via quick one-line format and supports Giao ngay button', async () => {
      await bot.handleUpdate({
        update_id: 20,
        message: {
          message_id: 20,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask proj-shop Đăng xuất tài khoản | Xoá session cookie khi user bấm logout',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã tạo nháp task');
      expect(calls[calls.length - 1].body?.text).toContain('proj-shop/dang-xuat-tai-khoan');

      // Task is initially draft in DB
      let task = ctx.taskRepo.get('proj-shop/dang-xuat-tai-khoan');
      expect(task).toBeDefined();
      expect(task?.status).toBe('draft');
      expect(task?.body).toBe('Xoá session cookie khi user bấm logout');

      // User clicks Giao ngay
      await bot.handleUpdate({
        update_id: 21,
        callback_query: {
          id: 'cb-start-draft',
          from: { id: CHAT_ID },
          message: { message_id: 20, chat: { id: CHAT_ID } },
          data: `draft:start:${task!.id}`,
        },
      });

      task = ctx.taskRepo.get('proj-shop/dang-xuat-tai-khoan');
      expect(['queued', 'waiting_quota']).toContain(task?.status);
    });

    it('allows cancelling wizard via /cancel', async () => {
      await bot.handleUpdate({
        update_id: 30,
        message: {
          message_id: 30,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/newtask',
        },
      });

      await bot.handleUpdate({
        update_id: 31,
        callback_query: {
          id: 'cb-proj',
          from: { id: CHAT_ID },
          message: { message_id: 30, chat: { id: CHAT_ID } },
          data: 'newtask:proj:proj-shop',
        },
      });

      // User types /cancel instead of title
      await bot.handleUpdate({
        update_id: 32,
        message: {
          message_id: 31,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/cancel',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Đã hủy thao tác.');
    });
  });

  describe('10. /plan command and batch.created notifications', () => {
    const CHAT_ID = 666;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-plan',
        name: 'Planning Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      ctx.chatService.setClaudeBinOverride(fakeClaudeBin);
      bot = createTestBotService({ allowedChatIds: [CHAT_ID], chatService: ctx.chatService });
    });

    it('/plan routes prompt with hub_create_batch instruction to Claude chat session', async () => {
      await bot.handleUpdate({
        update_id: 40,
        message: {
          message_id: 40,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/plan proj-plan Thiết kế tính năng bình luận',
        },
      });

      const messages = ctx.chatMessageRepo.getBySession(`telegram:${CHAT_ID}`, 10);
      const planMsg = messages.find((m) => m.content.includes('hub_create_batch'));
      expect(planMsg).toBeDefined();
      expect(planMsg?.content).toContain('proj-plan');
      expect(planMsg?.content).toContain('Thiết kế tính năng bình luận');

      await vi.waitFor(() => expect(ctx.chatSessionRepo.get(`telegram:${CHAT_ID}`)?.busy).toBe(0), { timeout: 10_000 });
      ctx.chatService.stop();
    });

    it('batch.created event broadcasts summary with dispatch, dashboard, and discard buttons', async () => {
      const batch = ctx.service.createBatch({
        project: 'proj-plan',
        title: 'Đợt nâng cấp bảo mật',
        goal: 'Bảo mật API',
        tasks: [
          { slug: 'task-sec-1', title: 'Thêm rate limit' },
          { slug: 'task-sec-2', title: 'Kiểm tra CSRF', dependsOn: ['task-sec-1'] },
        ],
        createdBy: 'claude',
      });

      bot.handleEvent('batch.created', undefined, {
        batchId: batch.id,
        projectId: batch.projectId,
        title: batch.title,
        taskCount: batch.tasks.length,
        createdBy: 'claude',
      });

      await bot.flushQueue(CHAT_ID);

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const batchCall = calls.find((c) => c.body?.text && (c.body.text as string).includes('Đợt nâng cấp bảo mật'));
      expect(batchCall).toBeDefined();
      const text = batchCall?.body?.text as string;
      expect(text).toContain('Đợt nâng cấp bảo mật');
      expect(text).toContain('2 task');
      expect(text).toContain('proj-plan/task-sec-1');
      expect(text).toContain('proj-plan/task-sec-2');
      expect(text).toContain('phụ thuộc: proj-plan/task-sec-1');

      const markup = batchCall?.body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(markup).toBeDefined();
      expect(markup.inline_keyboard[0][0].text).toContain('Giao cả đợt');
      expect(markup.inline_keyboard[0][0].callback_data).toBe(`batch:dispatch:${batch.id}`);
      expect(markup.inline_keyboard[0][1].text).toContain('Huỷ đợt');
      expect(markup.inline_keyboard[0][1].callback_data).toBe(`batch:discard:${batch.id}`);
      expect(markup.inline_keyboard[1][0].text).toContain('Xem trên dashboard');
      expect(markup.inline_keyboard[1][0].url).toContain(`/plans/${batch.id}`);

      // Test clicking Giao cả đợt
      await bot.handleUpdate({
        update_id: 41,
        callback_query: {
          id: 'cb-batch-dispatch',
          from: { id: CHAT_ID },
          message: { message_id: 100, chat: { id: CHAT_ID } },
          data: `batch:dispatch:${batch.id}`,
        },
      });

      const updatedBatch = ctx.service.getBatch(batch.id);
      expect(updatedBatch.status).toBe('dispatched');
      const t1 = ctx.taskRepo.get('proj-plan/task-sec-1');
      const t2 = ctx.taskRepo.get('proj-plan/task-sec-2');
      expect(['queued', 'waiting_quota']).toContain(t1?.status);
      expect(['queued', 'waiting_quota']).toContain(t2?.status);
    });

    it('batch:discard callback cancels draft tasks and marks batch as discarded', async () => {
      const batch = ctx.service.createBatch({
        project: 'proj-plan',
        title: 'Đợt thử nghiệm huỷ',
        tasks: [{ slug: 'task-disc-1', title: 'Task huỷ' }],
        createdBy: 'claude',
      });

      await bot.handleUpdate({
        update_id: 42,
        callback_query: {
          id: 'cb-batch-discard',
          from: { id: CHAT_ID },
          message: { message_id: 101, chat: { id: CHAT_ID } },
          data: `batch:discard:${batch.id}`,
        },
      });

      const updatedBatch = ctx.service.taskBatchRepo?.get(batch.id);
      expect(updatedBatch?.status).toBe('discarded');
      const t = ctx.taskRepo.get('proj-plan/task-disc-1');
      expect(t?.status).toBe('cancelled');
    });
  });

  describe('11. /drafts command', () => {
    const CHAT_ID = 777;
    let bot: TelegramBotService;

    beforeEach(() => {
      ctx.projectRepo.insert({
        id: 'proj-drafts',
        name: 'Drafts Project',
        path: tmpDir,
        defaultBranch: 'main',
        maxParallel: 2,
      });
      bot = createTestBotService({ allowedChatIds: [CHAT_ID] });
    });

    it('reports empty message when no drafts exist', async () => {
      await bot.handleUpdate({
        update_id: 50,
        message: {
          message_id: 50,
          date: 123456,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/drafts',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      expect(calls[calls.length - 1].body?.text).toContain('Hiện không có task hoặc đợt nháp nào');
    });

    it('lists draft batches and draft tasks with interactive buttons', async () => {
      // Create draft batch
      ctx.service.createBatch({
        project: 'proj-drafts',
        title: 'Đợt nháp 1',
        tasks: [{ slug: 'task-in-batch', title: 'Task in batch' }],
      });

      // Create standalone draft task
      const draftTask = ctx.service.createTask({
        project: 'proj-drafts',
        slug: 'task-standalone',
        title: 'Task standalone',
        start: false,
      });

      await bot.handleUpdate({
        update_id: 51,
        message: {
          message_id: 51,
          date: 123457,
          chat: { id: CHAT_ID, type: 'private' },
          text: '/drafts',
        },
      });

      const calls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
      const text = calls[calls.length - 1].body?.text as string;
      expect(text).toContain('Danh sách bản nháp');
      expect(text).toContain('Đợt nháp');
      expect(text).toContain('Đợt nháp 1');
      expect(text).toContain('task-standalone');

      const markup = calls[calls.length - 1].body?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
      expect(markup).toBeDefined();

      // Find delete button for draft task and click it
      await bot.handleUpdate({
        update_id: 52,
        callback_query: {
          id: 'cb-del-draft',
          from: { id: CHAT_ID },
          message: { message_id: 51, chat: { id: CHAT_ID } },
          data: `draft:delete:${draftTask.id}`,
        },
      });

      // Verify task deleted from DB
      expect(ctx.taskRepo.get(draftTask.id)).toBeUndefined();
    });
  });
});

describe('Telegram gửi lỗi mạng không làm sập daemon', () => {
  it('sendMessage bị từ chối nhưng không thành unhandled rejection khi gọi kiểu fire-and-forget', async () => {
    const { TelegramBotService } = await import('../src/telegram.js');
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    const svc = Object.create(TelegramBotService.prototype) as InstanceType<typeof TelegramBotService> & Record<string, unknown>;
    Object.assign(svc, {
      chatQueues: new Map(), chatProcessing: new Map(), chatLastSent: new Map(),
      now: () => Date.now(), sleepFn: async () => {},
      sendDirectMessage: async () => { throw new Error('Telegram sendMessage request failed: fetch failed'); },
    });
    void svc.sendMessage(1, 'hello');
    await new Promise((r) => setTimeout(r, 50));
    process.off('unhandledRejection', onUnhandled);
    expect(unhandled).toHaveLength(0);
  });
});

describe('Brain Notifications & Digest (b-brain-notify)', () => {
  let tmpDir: string;
  let ctx: TestContext;
  let config: ReturnType<typeof loadConfig>;
  let recordedCalls: Array<{ url: string; body?: Record<string, unknown> }>;
  let fakeFetch: typeof fetch;
  const CHAT_ID = 998877;
  let currentTime = 1_000_000;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agenthub-brain-notify-test-'));
    process.env.AGENTHUB_HOME = tmpDir;
    process.env.AGENTHUB_AGY_HOMES = path.join(tmpDir, 'agy-homes');
    fs.mkdirSync(process.env.AGENTHUB_AGY_HOMES, { recursive: true });
    config = loadConfig(tmpDir);
    config.telegram.enabled = true;
    config.telegram.allowedChatIds = [CHAT_ID];
    config.port = 4321;

    const fakeEngine = new FakeEngine(path.join(process.cwd(), 'test', 'fixtures', 'fake-agent.mjs'));
    const engines = new Map<string, Engine>([['agy', fakeEngine]]);
    ctx = createContext(config, engines);
    ctx.scheduler.stop();
    currentTime = new Date('2026-10-21T10:00:00Z').getTime();

    recordedCalls = [];
    fakeFetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = String(url);
      let bodyObj: Record<string, unknown> | undefined;
      if (init?.body && typeof init.body === 'string') {
        try {
          bodyObj = JSON.parse(init.body);
        } catch {
          // ignore
        }
      }
      recordedCalls.push({ url: urlStr, body: bodyObj });

      if (urlStr.includes('/getMe')) {
        return new Response(JSON.stringify({ ok: true, result: { id: 123456, is_bot: true, first_name: 'AgentHubBot', username: 'agenthub_bot' } }));
      }
      if (urlStr.includes('/sendMessage')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: recordedCalls.length, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/editMessageText')) {
        return new Response(JSON.stringify({ ok: true, result: { message_id: 123, chat: { id: CHAT_ID } } }));
      }
      if (urlStr.includes('/answerCallbackQuery')) {
        return new Response(JSON.stringify({ ok: true, result: true }));
      }
      return new Response(JSON.stringify({ ok: true, result: {} }));
    }) as unknown as typeof fetch;
  });

  afterEach(() => {
    closeContext(ctx);
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
    delete process.env.AGENTHUB_HOME;
    delete process.env.AGENTHUB_AGY_HOMES;
  });

  function createBot(brainMode: 'off' | 'suggest' | 'auto' = 'suggest') {
    config.brain.mode = brainMode;
    return new TelegramBotService({
      config,
      service: ctx.service,
      eventBus: ctx.scheduler.getEventBus(),
      taskRepo: ctx.taskRepo,
      projectRepo: ctx.projectRepo,
      profileRepo: ctx.profileRepo,
      quotaMarkRepo: ctx.quotaMarkRepo,
      fetch: fakeFetch,
      now: () => currentTime,
      sleep: async () => {},
      sleepFn: async () => {},
      tokenOverride: 'test-token',
      chatService: ctx.chatService,
    });
  }

  it('1. khi brain.mode = auto: chan cac thong bao tho theo tung task, chi gui hub_notify va su co he thong', async () => {
    const bot = createBot('auto');

    // Emit raw task events: should all be suppressed
    bot.handleEvent('task.review_ready', 'p/t-1', { title: 'T1' });
    bot.handleEvent('task.failed', 'p/t-2', { title: 'T2' });
    bot.handleEvent('task.blocked', 'p/t-3', { title: 'T3' });
    bot.handleEvent('batch.created', undefined, { taskCount: 2 });
    // Single profile quota exhausted when other profiles exist -> suppressed
    ctx.profileRepo.upsert({ name: 'p1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    ctx.profileRepo.upsert({ name: 'p2', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });
    ctx.quotaMarkRepo.mark('p1', 'gemini', Math.floor(currentTime / 1000) + 3600);
    bot.handleEvent('quota.exhausted', undefined, { profile: 'p1', family: 'gemini' });

    await bot.flushQueue(CHAT_ID);
    let sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(0);

    // Allowed: brain.notify
    bot.handleEvent('brain.notify', undefined, { text: 'Bộ não đã hoàn tất lượt chạy', level: 'info' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(1);
    expect(sendCalls[0].body?.text).toContain('Bộ não đã hoàn tất lượt chạy');

    // Allowed: disk.low
    bot.handleEvent('disk.low', undefined, { freeGB: 1, minFreeGB: 3 });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(2);
    expect(sendCalls[1].body?.text).toContain('Ổ đĩa thấp');

    // Allowed: moi tai khoan het quota
    ctx.quotaMarkRepo.mark('p2', 'gemini', Math.floor(currentTime / 1000) + 3600);
    bot.handleEvent('quota.exhausted', undefined, { profile: 'p2', family: 'gemini' });
    await bot.flushQueue(CHAT_ID);
    sendCalls = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sendCalls).toHaveLength(3);
    expect(sendCalls[2].body?.text).toContain('Mọi tài khoản đều đã hết quota');
  });

  it('2. gio yen tinh notifications.quietHours: chi gui level incident, tin khac don lai', async () => {
    config.notifications.quietHours = { enabled: true, start: '22:00', end: '07:00' };
    const quietDate = new Date();
    quietDate.setHours(23, 45, 0, 0);
    currentTime = quietDate.getTime(); // inside quiet hours

    const bot = createBot('suggest');

    // Info and normal events are deferred
    bot.handleEvent('brain.notify', undefined, { text: 'Tin thuong', level: 'info' });
    bot.handleEvent('task.review_ready', 'p/t-1', { title: 'Review ready' });
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(0);
    expect(bot.getQuietHoursQueue().length).toBeGreaterThanOrEqual(1);

    // Incident event is sent immediately
    bot.handleEvent('brain.notify', undefined, { text: 'Su co nghiem trong', level: 'incident' });
    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    expect(sends[0].body?.text).toContain('Su co nghiem trong');
  });

  it('3. tin decision luon co nut (Dong y / Khong / Xem dashboard) va phan hoi callback', async () => {
    const bot = createBot('suggest');

    bot.handleEvent('brain.notify', undefined, {
      decisionId: 'dec-123',
      text: 'Bạn có đồng ý merge đợt task này không?',
      level: 'decision',
    });
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(1);
    const msg = sends[0].body;
    expect(msg?.text).toContain('Bạn có đồng ý merge đợt task này không?');

    const markup = msg?.reply_markup as { inline_keyboard: InlineKeyboardButton[][] };
    expect(markup).toBeDefined();
    expect(markup.inline_keyboard[0][0].text).toContain('Đồng ý');
    expect(markup.inline_keyboard[0][0].callback_data).toBe('decision:agree:dec-123');
    expect(markup.inline_keyboard[0][1].text).toContain('Không');
    expect(markup.inline_keyboard[0][1].callback_data).toBe('decision:reject:dec-123');
    expect(markup.inline_keyboard[1][0].text).toContain('Xem dashboard');

    const sendSpy = vi.spyOn(ctx.chatService, 'sendMessage').mockReturnValue({
      userMessageId: 'u-1',
      assistantMessageId: 'a-1',
    });

    // Click Đồng ý
    await bot.handleUpdate({
      update_id: 1,
      callback_query: {
        id: 'cb-1',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:dec-123',
      },
    });

    const edits = recordedCalls.filter((c) => c.url.includes('/editMessageText'));
    expect(edits.length).toBeGreaterThan(0);
    expect(edits[0].body?.text).toContain('Đã phản hồi: Đồng ý');

    // Message sent to brain session
    expect(sendSpy).toHaveBeenCalledWith(
      'brain',
      'Người dùng trả lời quyết định dec-123 («Bạn có đồng ý merge đợt task này không?»): Đồng ý',
    );

    // Tracker marks decision as answered
    const decision = bot.getDecisionTracker().getDecision('dec-123');
    expect(decision?.answered).toBe(true);
    expect(decision?.answer).toBe('agree');

    // Click again: should report expired or already answered
    await bot.handleUpdate({
      update_id: 2,
      callback_query: {
        id: 'cb-2',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:dec-123',
      },
    });
    const ansCalls = recordedCalls.filter((c) => c.url.includes('/answerCallbackQuery'));
    const lastAns = ansCalls.at(-1);
    expect(lastAns?.body?.text).toContain('Quyết định đã hết hạn hoặc đã trả lời');

    // Click non-existent decision
    await bot.handleUpdate({
      update_id: 3,
      callback_query: {
        id: 'cb-3',
        from: { id: CHAT_ID },
        message: { message_id: 10, chat: { id: CHAT_ID }, text: msg?.text as string },
        data: 'decision:agree:non-existent',
      },
    });
    const lastAnsNonExistent = recordedCalls.filter((c) => c.url.includes('/answerCallbackQuery')).at(-1);
    expect(lastAnsNonExistent?.body?.text).toContain('Quyết định đã hết hạn hoặc đã trả lời');
  });

  it('4. nhac lai tin decision sau 2 gio neu chua tra loi (toi da 2 lan)', async () => {
    const bot = createBot('suggest');

    bot.handleEvent('brain.notify', undefined, {
      decisionId: 'dec-remind',
      text: 'Xác nhận xóa tài khoản cũ?',
      level: 'decision',
    });
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

    // 1 hour later: no reminder
    currentTime += 1 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    expect(recordedCalls.filter((c) => c.url.includes('/sendMessage'))).toHaveLength(1);

    // 2 hours later (total 2h from start): Reminder 1 sent
    currentTime += 1 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    let sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(2);
    expect(sends[1].body?.text).toContain('Nhắc lại quyết định (lần 1/2)');

    // Another 2 hours later: Reminder 2 sent
    currentTime += 2 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
    expect(sends[2].body?.text).toContain('Nhắc lại quyết định (lần 2/2)');

    // Another 2 hours later: No reminder 3 (max 2 times)
    currentTime += 2 * 60 * 60 * 1000;
    await bot.checkDecisionReminders();
    await bot.flushQueue(CHAT_ID);
    sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends).toHaveLength(3);
  });

  it('5. lenh /digest hien thi tom tat day du so lieu va quota', async () => {
    const bot = createBot('suggest');

    ctx.projectRepo.insert({
      id: 'p',
      name: 'Project P',
      path: tmpDir,
      defaultBranch: 'main',
      envTemplate: null,
      maxParallel: 1,
    });
    ctx.taskRepo.insert({ id: 'p/done-1', projectId: 'p', slug: 'done-1', title: 'Task xong', status: 'done' });
    ctx.taskRepo.insert({ id: 'p/run-1', projectId: 'p', slug: 'run-1', title: 'Task chay', status: 'running' });
    ctx.taskRepo.insert({ id: 'p/fail-1', projectId: 'p', slug: 'fail-1', title: 'Task loi', status: 'failed' });
    ctx.profileRepo.upsert({ name: 'agy-1', engine: 'agy', kind: 'isolated', home: tmpDir, email: null, enabled: 1 });

    await bot.handleUpdate({
      update_id: 2,
      message: { message_id: 20, chat: { id: CHAT_ID, type: 'private' }, date: Math.floor(currentTime / 1000), text: '/digest' },
    });
    await bot.flushQueue(CHAT_ID);

    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    const text = sends.at(-1)?.body?.text as string;
    expect(text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');
    expect(text).toContain('Hoàn thành: <b>1</b>');
    expect(text).toContain('Đang chạy: <b>1</b>');
    expect(text).toContain('Lỗi: <b>1</b>');
    expect(text).toContain('Quota tài khoản:');
  });

  it('6. checkScheduledDigest phat tin luc 18:00', async () => {
    config.brain.digest = { enabled: true, time: '18:00' };
    const digestDate = new Date();
    digestDate.setHours(18, 0, 0, 0);
    currentTime = digestDate.getTime();

    const bot = createBot('suggest');
    const triggered = await bot.checkScheduledDigest();
    expect(triggered).toBe(true);

    await bot.flushQueue(CHAT_ID);
    const sends = recordedCalls.filter((c) => c.url.includes('/sendMessage'));
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0].body?.text).toContain('TÓM TẮT HỆ THỐNG AGENTHUB');

    // Running again in the same day doesn't double-trigger
    const secondTrigger = await bot.checkScheduledDigest();
    expect(secondTrigger).toBe(false);
  });
});

describe('Menu lệnh Telegram', () => {
  it('mọi lệnh trong menu đều có xử lý thật và mô tả hợp lệ', async () => {
    const { TELEGRAM_BOT_COMMANDS } = await import('../src/telegram.js');
    const fsMod = await import('node:fs');
    const src = fsMod.readFileSync(new URL('../src/telegram.ts', import.meta.url), 'utf8');
    for (const { command, description } of TELEGRAM_BOT_COMMANDS) {
      expect(command).toMatch(/^[a-z0-9_]{1,32}$/);
      expect(description.length).toBeGreaterThan(2);
      expect(description.length).toBeLessThanOrEqual(256);
      expect(src).toContain(`case '/${command}'`);
    }
  });
});
