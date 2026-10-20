import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { AgentHubConfig, saveConfig, updateConfigInMemory } from './config.js';
import { EventBus } from './scheduler/index.js';
import { TaskRepo, ProjectRepo, TaskRow, ProjectRow, QuotaMarkRepo } from './db/index.js';
import { AppService, toTaskId, toRouteId } from './services/index.js';

const execFileAsync = promisify(execFile);

export type GitDiffFn = (
  cmd: string,
  args: string[],
  options: { cwd: string; timeout: number },
) => Promise<{ stdout: string }>;

export function isProjectMergeEnabled(project?: ProjectRow | null): boolean {
  if (!project?.merge) return false;
  try {
    const parsed = typeof project.merge === 'string' ? JSON.parse(project.merge) : project.merge;
    return Boolean(parsed && typeof parsed === 'object' && (parsed as { enabled?: boolean }).enabled);
  } catch {
    return false;
  }
}

export interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    from?: {
      id: number;
      is_bot?: boolean;
      first_name?: string;
      username?: string;
    };
    chat: {
      id: number;
      type: string;
      title?: string;
      username?: string;
    };
    date: number;
    text?: string;
  };
  callback_query?: {
    id: string;
    from: {
      id: number;
      first_name?: string;
      username?: string;
    };
    message?: {
      message_id: number;
      chat: {
        id: number;
      };
      text?: string;
    };
    data?: string;
  };
}

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface TelegramServiceOptions {
  config: AgentHubConfig;
  service: AppService;
  eventBus: EventBus;
  taskRepo: TaskRepo;
  projectRepo: ProjectRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  execFile?: GitDiffFn;
  tokenOverride?: string;
}

interface PendingChatState {
  action: 'reject_feedback';
  taskId: string;
}

interface SendQueueItem {
  chatId: number;
  text: string;
  replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] };
  resolve: (res: unknown) => void;
  reject: (err: unknown) => void;
}

export function redactTelegramToken(value: unknown, token: string | null): string {
  const text = value instanceof Error ? value.message : String(value);
  return token ? text.split(token).join('<redacted>') : text;
}

export function readTelegramToken(tokenPath: string): string | null {
  if (!fs.existsSync(tokenPath)) {
    return null;
  }
  try {
    try {
      const stat = fs.statSync(tokenPath);
      if ((stat.mode & 0o777) !== 0o600) {
        fs.chmodSync(tokenPath, 0o600);
      }
    } catch {
      // ignore
    }
    const content = fs.readFileSync(tokenPath, 'utf-8').trim();
    return content.length > 0 ? content : null;
  } catch {
    return null;
  }
}

export class TelegramBotService {
  private config: AgentHubConfig;
  private service: AppService;
  private eventBus: EventBus;
  private taskRepo: TaskRepo;
  private projectRepo: ProjectRepo;
  private quotaMarkRepo?: QuotaMarkRepo;
  private fetchFn: typeof fetch;
  private now: () => number;
  private sleepFn: (ms: number) => Promise<void>;
  private execFileFn: GitDiffFn;

  private token: string | null = null;
  private running = false;
  private pollAbortController: AbortController | null = null;
  private pollPromise: Promise<void> | null = null;

  // Pairing state (6 digits, expires in 10 minutes)
  private pairingCode: string | null = null;
  private pairingExpiresAt = 0;
  private pairingInvalidAttempts = 0;
  private pairingAttemptsByChat = new Map<number, number[]>();

  // Pending user input state per chat (e.g. entering feedback for reject)
  private chatStates = new Map<number, PendingChatState>();

  // Anti-flood: message queue per chat and last send timestamp
  private chatQueues = new Map<number, SendQueueItem[]>();
  private chatProcessing = new Map<number, boolean>();
  private chatLastSent = new Map<number, number>();

  // Deduplication for event notifications
  private lastNotificationTime = new Map<string, number>();

  // Bound handler for EventBus
  private boundEventHandler: ((type: string, taskId?: string, payload?: unknown) => void) | null = null;

  constructor(opts: TelegramServiceOptions) {
    this.config = opts.config;
    this.service = opts.service;
    this.eventBus = opts.eventBus;
    this.taskRepo = opts.taskRepo;
    this.projectRepo = opts.projectRepo;
    this.quotaMarkRepo = opts.quotaMarkRepo;
    this.fetchFn = opts.fetch || globalThis.fetch;
    this.now = opts.now || (() => Date.now());
    this.sleepFn = opts.sleep || ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.execFileFn = (opts.execFile || execFileAsync) as GitDiffFn;

    if (opts.tokenOverride) {
      this.token = opts.tokenOverride;
    } else {
      this.refreshToken();
    }
  }

  refreshToken(): void {
    const tokenFile =
      this.config.telegram?.botTokenFile ||
      path.join(this.config.hubHome, 'secrets', 'telegram.token');
    this.token = readTelegramToken(tokenFile);
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  hasValidToken(): boolean {
    return Boolean(this.token && this.token.length > 0);
  }

  /**
   * Generates or retrieves the 6-digit pairing code (valid for 10 minutes).
   */
  getPairingCode(forceNew = false): { code: string; expiresInSec: number } {
    const now = this.now();
    if (!forceNew && this.pairingCode && this.pairingExpiresAt > now) {
      return {
        code: this.pairingCode,
        expiresInSec: Math.max(0, Math.round((this.pairingExpiresAt - now) / 1000)),
      };
    }

    // Generate new 6-digit code
    this.pairingCode = crypto.randomInt(100000, 1000000).toString();
    this.pairingExpiresAt = now + 10 * 60 * 1000;
    this.pairingInvalidAttempts = 0;
    this.pairingAttemptsByChat.clear();

    return {
      code: this.pairingCode,
      expiresInSec: 600,
    };
  }

  /**
   * Add a chat ID to allowedChatIds and persist to config.json.
   */
  addAllowedChatId(chatId: number): void {
    if (!this.config.telegram.allowedChatIds.includes(chatId)) {
      this.config.telegram.allowedChatIds.push(chatId);
      updateConfigInMemory(this.config, { telegram: this.config.telegram });
      saveConfig(this.config.hubHome, { telegram: this.config.telegram });
    }
  }

  /**
   * Start the Telegram bot service: subscribes to EventBus and begins long polling.
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    // Refresh token in case it was created/updated on disk
    if (!this.token) {
      this.refreshToken();
    }

    // Subscribe to EventBus notifications
    if (!this.boundEventHandler) {
      this.boundEventHandler = (type: string, taskId?: string, payload?: unknown) => {
        this.handleEvent(type, taskId, payload);
      };
      this.eventBus.on('*', this.boundEventHandler);
    }

    // Begin long polling loop in the background
    this.pollPromise = this.startPollingLoop();
  }

  /**
   * Stop the Telegram bot service gracefully.
   */
  async stop(): Promise<void> {
    this.running = false;

    if (this.pollAbortController) {
      this.pollAbortController.abort();
      this.pollAbortController = null;
    }

    if (this.boundEventHandler) {
      this.eventBus.off('*', this.boundEventHandler);
      this.boundEventHandler = null;
    }

    if (this.pollPromise) {
      try {
        await this.pollPromise;
      } catch {
        // ignore
      }
      this.pollPromise = null;
    }
  }

  // --- Long Polling ---

  private async startPollingLoop(): Promise<void> {
    let offset = 0;
    let backoffMs = 1000;
    const MAX_BACKOFF = 30000;

    while (this.running) {
      if (!this.token) {
        // Wait and check again if token was added
        await this.sleepFn(3000);
        this.refreshToken();
        continue;
      }

      this.pollAbortController = new AbortController();
      try {
        const updates = await this.fetchUpdates(offset, 25, this.pollAbortController.signal);
        backoffMs = 1000; // Reset backoff on success

        if (updates && updates.length > 0) {
          for (const update of updates) {
            offset = Math.max(offset, update.update_id + 1);
            await this.handleUpdate(update);
          }
        }
      } catch (err: unknown) {
        if (!this.running || (err instanceof Error && err.name === 'AbortError')) {
          break;
        }
        // Network error or fetch failed -> exponential backoff
        await this.sleepFn(backoffMs);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF);
      } finally {
        this.pollAbortController = null;
      }
    }
  }

  private async fetchUpdates(offset: number, timeoutSec = 25, signal?: AbortSignal): Promise<TelegramUpdate[]> {
    if (!this.token) return [];

    const url = `https://api.telegram.org/bot${this.token}/getUpdates`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          offset,
          timeout: timeoutSec,
          allowed_updates: ['message', 'callback_query'],
        }),
        signal,
      });
    } catch (err) {
      throw new Error(`Telegram getUpdates request failed: ${redactTelegramToken(err, this.token)}`);
    }

    if (!res.ok) {
      throw new Error(`Telegram getUpdates failed with status ${res.status}`);
    }

    const data = (await res.json()) as { ok: boolean; result?: TelegramUpdate[] };
    return data.ok && Array.isArray(data.result) ? data.result : [];
  }

  /**
   * Process a list of updates directly (useful for tests and manual dispatch).
   */
  async processUpdates(updates: TelegramUpdate[]): Promise<void> {
    for (const update of updates) {
      await this.handleUpdate(update);
    }
  }

  /**
   * Dispatch a single Telegram update (message or callback query).
   */
  async handleUpdate(update: TelegramUpdate): Promise<void> {
    if (update.message) {
      await this.handleMessage(update.message);
    } else if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
    }
  }

  // --- Message Handling ---

  private async handleMessage(msg: NonNullable<TelegramUpdate['message']>): Promise<void> {
    const chatId = msg.chat.id;
    const rawText = (msg.text || '').trim();
    const isAllowed = this.config.telegram?.allowedChatIds?.includes(chatId);

    // 1. Unrecognized / non-allowed chats
    if (!isAllowed) {
      // Check for /start <mã> pairing command
      const match = rawText.match(/^\/start(?:\s+(\d{6}))?$/i);
      if (match && match[1] && msg.chat.type === 'private') {
        const code = match[1];
        const now = this.now();
        if (this.pairingCode && this.pairingCode === code && this.pairingExpiresAt > now) {
          // Success pairing!
          this.addAllowedChatId(chatId);
          this.pairingCode = null;
          this.pairingExpiresAt = 0;
          this.pairingInvalidAttempts = 0;
          this.pairingAttemptsByChat.delete(chatId);
          await this.sendDirectMessage(
            chatId,
            '✅ Ghép đôi thành công! Bạn đã được cấp quyền điều khiển AgentHub từ xa.\nGõ /help để xem danh sách các lệnh.',
          );
          return;
        }

        if (this.pairingCode && this.pairingExpiresAt > now) {
          const attempts = (this.pairingAttemptsByChat.get(chatId) || []).filter(
            (timestamp) => now - timestamp < 10 * 60 * 1000,
          );
          if (attempts.length < 3) {
            attempts.push(now);
            this.pairingAttemptsByChat.set(chatId, attempts);
            this.pairingInvalidAttempts += 1;
            if (this.pairingInvalidAttempts >= 5) {
              this.pairingCode = null;
              this.pairingExpiresAt = 0;
              this.pairingInvalidAttempts = 0;
              this.pairingAttemptsByChat.clear();
              this.eventBus.emit('telegram.pairing_failed', undefined, {
                reason: 'too_many_invalid_attempts',
                message: 'Mã ghép đôi đã bị huỷ do nhập sai quá nhiều lần.',
              });
            }
          }
        }
      }
      // REQUIREMENT 2: "Chat lạ khác bị bỏ qua (không trả lời)."
      return;
    }

    // 2. Allowed chat - check if user has a pending state (e.g. entering feedback for reject)
    const pendingState = this.chatStates.get(chatId);
    if (pendingState) {
      if (rawText.toLowerCase() === '/cancel') {
        this.chatStates.delete(chatId);
        await this.sendMessage(chatId, 'Đã hủy thao tác.');
        return;
      }

      if (pendingState.action === 'reject_feedback') {
        const taskId = pendingState.taskId;
        this.chatStates.delete(chatId);
        try {
          await this.service.reviewTask(taskId, {
            verdict: 'changes_requested',
            feedback: rawText,
            by: 'telegram',
          });
          await this.sendMessage(chatId, `↩️ Đã trả về task ${taskId} với nhận xét:\n${rawText}`);
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          await this.sendMessage(chatId, `❌ Lỗi khi trả về task ${taskId}: ${errMsg}`);
        }
        return;
      }
    }

    // 3. Command processing
    if (!rawText.startsWith('/')) {
      return;
    }

    const [cmdToken, ...args] = rawText.split(/\s+/);
    // Strip optional @botname suffix
    const cmd = cmdToken.split('@')[0].toLowerCase();
    const argStr = args.join(' ').trim();

    switch (cmd) {
      case '/start':
        await this.sendMessage(
          chatId,
          '👋 Chào bạn! Bạn đã kết nối với AgentHub.\nGõ /help để xem danh sách các lệnh.',
        );
        break;

      case '/help':
        await this.sendMessage(chatId, this.renderHelp());
        break;

      case '/status':
        await this.handleStatusCommand(chatId);
        break;

      case '/tasks':
        await this.handleTasksCommand(chatId, argStr);
        break;

      case '/task':
        await this.handleTaskDetailCommand(chatId, argStr);
        break;

      case '/log':
        await this.handleLogCommand(chatId, argStr);
        break;

      case '/retry':
        await this.handleRetryCommand(chatId, argStr);
        break;

      case '/cancel':
        await this.handleCancelCommand(chatId, argStr);
        break;

      case '/approve':
        await this.handleApproveCommand(chatId, argStr);
        break;

      case '/reject':
        await this.handleRejectCommand(chatId, args);
        break;

      case '/pause':
        this.service.pauseScheduler();
        await this.sendMessage(chatId, '⏸ Đã tạm dừng giao task mới. Các task đang chạy vẫn tiếp tục.');
        break;

      case '/resume':
        this.service.resumeScheduler();
        await this.sendMessage(chatId, '▶️ Đã tiếp tục giao task mới.');
        break;

      default:
        await this.sendMessage(chatId, `Lệnh không hợp lệ: ${cmd}. Gõ /help để xem hướng dẫn.`);
        break;
    }
  }

  // --- Callback Query Handling (Inline Buttons) ---

  private async handleCallbackQuery(query: NonNullable<TelegramUpdate['callback_query']>): Promise<void> {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const isAllowed = Boolean(
      chatId &&
      userId === chatId &&
      this.config.telegram?.allowedChatIds?.includes(chatId),
    );

    if (!isAllowed || !chatId) {
      await this.answerCallbackQuery(query.id);
      return;
    }

    const data = query.data || '';
    const parts = data.split(':');
    const domain = parts[0];
    const action = parts[1];
    const taskIdOrParam = parts.slice(2).join(':');

    switch (domain) {
      case 'cancel': {
        if (action === 'confirm') {
          const resolved = this.resolveTask(taskIdOrParam);
          if ('error' in resolved) {
            await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
            return;
          }
          try {
            this.service.cancelTask(resolved.id);
            await this.answerCallbackQuery(query.id, 'Đã hủy task.');
            await this.sendMessage(chatId, `🛑 Đã hủy task ${resolved.id}.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi hủy task.');
            await this.sendMessage(chatId, `❌ Lỗi khi hủy task: ${errMsg}`);
          }
        } else {
          await this.answerCallbackQuery(query.id, 'Đã hủy thao tác.');
          await this.sendMessage(chatId, 'Đã hủy thao tác.');
        }
        break;
      }

      case 'review': {
        const resolved = this.resolveTask(taskIdOrParam);
        if ('error' in resolved) {
          await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
          return;
        }

        if (action === 'approve') {
          const project = this.projectRepo.get(resolved.projectId);
          const hasMerge = isProjectMergeEnabled(project);
          try {
            await this.service.reviewTask(resolved.id, {
              verdict: 'approved',
              merge: hasMerge,
              by: 'telegram',
            });
            await this.answerCallbackQuery(query.id, 'Đã duyệt task!');
            await this.sendMessage(
              chatId,
              `✅ Đã duyệt task ${resolved.id}${hasMerge ? ' (và merge vào nhánh mặc định)' : ''}.`,
            );
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi duyệt task.');
            await this.sendMessage(chatId, `❌ Lỗi khi duyệt task: ${errMsg}`);
          }
        } else if (action === 'reject_prompt') {
          await this.answerCallbackQuery(query.id, 'Vui lòng nhập nhận xét...');
          this.chatStates.set(chatId, { action: 'reject_feedback', taskId: resolved.id });
          await this.sendMessage(
            chatId,
            `💬 Vui lòng gửi nhận xét/yêu cầu sửa cho task ${resolved.id}:\n(Hoặc gửi /cancel để hủy)`,
          );
        }
        break;
      }

      case 'task': {
        const resolved = this.resolveTask(taskIdOrParam);
        if ('error' in resolved) {
          await this.answerCallbackQuery(query.id, 'Không tìm thấy task.');
          return;
        }

        if (action === 'diff') {
          await this.answerCallbackQuery(query.id, 'Đang lấy diff...');
          const diffText = await this.getTaskDiffSummary(resolved);
          await this.sendMessage(
            chatId,
            `📊 Diff tóm tắt của task ${resolved.id}:\n\n<pre>${this.escapeHtml(diffText)}</pre>`,
          );
        } else if (action === 'retry') {
          try {
            this.service.retryTask(resolved.id, {});
            await this.answerCallbackQuery(query.id, 'Đã đưa vào hàng đợi.');
            await this.sendMessage(chatId, `🔄 Đã đưa task ${resolved.id} vào hàng đợi để chạy lại.`);
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            await this.answerCallbackQuery(query.id, 'Lỗi retry.');
            await this.sendMessage(chatId, `❌ Lỗi khi retry task: ${errMsg}`);
          }
        } else if (action === 'log') {
          await this.answerCallbackQuery(query.id, 'Đang lấy log...');
          const logText = this.getTaskLast30Lines(resolved.id);
          await this.sendMessage(
            chatId,
            `📄 30 dòng cuối log của ${resolved.id}:\n\n<pre>${this.escapeHtml(logText)}</pre>`,
          );
        }
        break;
      }

      default:
        await this.answerCallbackQuery(query.id);
        break;
    }
  }

  // --- Command Implementations ---

  private async handleStatusCommand(chatId: number): Promise<void> {
    const status = this.service.getStatus();
    const tasks = status.tasks;
    const running = status.running || [];
    const isPaused = this.service.isSchedulerPaused();

    let text = '📊 <b>Tổng quan trạng thái AgentHub</b>\n\n';
    text = text + `• Điều phối: <b>${isPaused ? '⏸ Tạm dừng giao việc' : '▶️ Đang hoạt động'}</b>\n`;
    text = text + `• Tasks: <b>${tasks.running}</b> đang chạy, <b>${tasks.review}</b> chờ review, <b>${tasks.queued}</b> hàng đợi, <b>${tasks.waiting_quota}</b> chờ quota, <b>${tasks.failed}</b> lỗi, <b>${tasks.blocked}</b> bị chặn, <b>${tasks.done}</b> hoàn thành\n`;

    if (running.length > 0) {
      text = text + '\n🏃 <b>Đang chạy:</b>\n';
      for (const r of running) {
        const taskObj = this.taskRepo.get(r.taskId);
        const titleStr = taskObj?.title || r.taskId;
        text = text + `• <code>${r.taskId}</code> (${r.profileName}/${r.model})\n  <i>${this.escapeHtml(titleStr)}</i>\n`;
      }
    }

    if (status.disk) {
      text = text + `\n💾 Ổ đĩa: <b>${status.disk.freeGB} GB</b> trống (tối thiểu ${status.disk.minFreeGB} GB)\n`;
    }

    const quotaMarks = status.profiles
      ? status.profiles.flatMap((p: { quotaMarks?: Array<{ until: number; profileName: string; family: string }> }) => p.quotaMarks || [])
      : [];
    if (quotaMarks.length > 0) {
      text = text + '\n⏳ <b>Quota đang bị hạn chế:</b>\n';
      for (const q of quotaMarks) {
        const untilStr = new Date(q.until * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        text = text + `• Hồ sơ ${q.profileName} (${q.family}): đến ${untilStr}\n`;
      }
    }

    await this.sendMessage(chatId, text);
  }

  private async handleTasksCommand(chatId: number, statusFilter?: string): Promise<void> {
    const filter = statusFilter && statusFilter.trim() !== 'all' ? statusFilter.trim().toLowerCase() : undefined;
    const tasks = this.service.listTasks(filter ? { status: filter } : undefined);

    if (tasks.length === 0) {
      await this.sendMessage(chatId, `Không có task nào${filter ? ` ở trạng thái '${filter}'` : ''}.`);
      return;
    }

    let text = `📋 <b>Danh sách task${filter ? ` (${filter})` : ''}</b> (${tasks.length}):\n\n`;
    const displayList = tasks.slice(0, 15);
    for (const t of displayList) {
      text = text + `• [${t.status}] <code>${t.id}</code>: ${this.escapeHtml(t.title)}\n`;
    }

    if (tasks.length > 15) {
      text = text + `\n<i>... và còn ${tasks.length - 15} task khác.</i>`;
    }

    await this.sendMessage(chatId, text);
  }

  private async handleTaskDetailCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /task <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    const detail = await this.service.getTask(resolved.id);
    const checks = detail.checks || [];
    let checksText = 'Chưa có kiểm tra';
    if (checks.length > 0) {
      const passed = checks.filter((c) => c.ok).length;
      checksText = `${passed === checks.length ? '✓' : '✗'} ${passed}/${checks.length} checks đạt`;
    }

    const dashboardUrl = `http://127.0.0.1:${this.config.port}/#/tasks/${toRouteId(resolved.id)}`;

    let text = `📌 <b>Task: ${resolved.id}</b>\n\n`;
    text = text + `• Tiêu đề: <b>${this.escapeHtml(detail.title)}</b>\n`;
    text = text + `• Trạng thái: <code>${detail.status}</code> (${detail.level})\n`;
    text = text + `• Nhánh: <code>${detail.branch || 'mặc định'}</code> (gốc: ${detail.baseRef || 'main'})\n`;
    text = text + `• Kiểm tra: ${checksText}\n`;
    text = text + `• Lượt chạy: ${detail.runs?.length || 0}\n`;
    text = text + `• Link: <a href="${dashboardUrl}">Mở trên Dashboard</a>\n`;

    // Dynamic action buttons depending on task status
    const buttons: InlineKeyboardButton[][] = [];
    if (detail.status === 'review') {
      buttons.push([
        { text: '✅ Duyệt & merge', callback_data: `review:approve:${resolved.id}` },
        { text: '↩️ Trả về', callback_data: `review:reject_prompt:${resolved.id}` },
      ]);
      buttons.push([{ text: '📊 Xem diff tóm tắt', callback_data: `task:diff:${resolved.id}` }]);
    } else if (detail.status === 'failed' || detail.status === 'blocked') {
      buttons.push([
        { text: '🔄 Chạy lại', callback_data: `task:retry:${resolved.id}` },
        { text: '📄 Xem log', callback_data: `task:log:${resolved.id}` },
      ]);
    } else if (detail.status === 'running' || detail.status === 'queued') {
      buttons.push([{ text: '🛑 Hủy task', callback_data: `cancel:confirm:${resolved.id}` }]);
    }

    await this.sendMessage(chatId, text, buttons.length > 0 ? { inline_keyboard: buttons } : undefined);
  }

  private async handleLogCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /log <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    const logLines = this.getTaskLast30Lines(resolved.id);
    await this.sendMessage(
      chatId,
      `📄 30 dòng cuối log của <code>${resolved.id}</code>:\n\n<pre>${this.escapeHtml(logLines)}</pre>`,
    );
  }

  private async handleRetryCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /retry <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'failed' && resolved.status !== 'blocked') {
      await this.sendMessage(
        chatId,
        `Chỉ có thể retry task ở trạng thái failed hoặc blocked (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    try {
      this.service.retryTask(resolved.id, {});
      await this.sendMessage(chatId, `🔄 Đã đưa task ${resolved.id} vào hàng đợi để chạy lại.`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi retry task: ${errMsg}`);
    }
  }

  private async handleCancelCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /cancel <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    const keyboard: InlineKeyboardButton[][] = [
      [
        { text: '✅ Xác nhận hủy', callback_data: `cancel:confirm:${resolved.id}` },
        { text: '❌ Không', callback_data: `cancel:abort:${resolved.id}` },
      ],
    ];

    await this.sendMessage(
      chatId,
      `❓ Bạn có chắc muốn hủy task <b>${resolved.id}</b> không?\n<i>Tiêu đề: ${this.escapeHtml(resolved.title)}</i>`,
      { inline_keyboard: keyboard },
    );
  }

  private async handleApproveCommand(chatId: number, idOrSlug: string): Promise<void> {
    if (!idOrSlug) {
      await this.sendMessage(chatId, 'Vui lòng cung cấp task ID hoặc slug: /approve <id>');
      return;
    }

    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'review') {
      await this.sendMessage(
        chatId,
        `Task ${resolved.id} không ở trạng thái review (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    const project = this.projectRepo.get(resolved.projectId);
    const hasMerge = isProjectMergeEnabled(project);

    try {
      await this.service.reviewTask(resolved.id, {
        verdict: 'approved',
        merge: hasMerge,
        by: 'telegram',
      });
      await this.sendMessage(
        chatId,
        `✅ Đã duyệt task ${resolved.id}${hasMerge ? ' (và merge vào nhánh mặc định)' : ''}.`,
      );
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi duyệt task: ${errMsg}`);
    }
  }

  private async handleRejectCommand(chatId: number, args: string[]): Promise<void> {
    if (args.length === 0) {
      await this.sendMessage(chatId, 'Cú pháp: /reject <id> <nhận xét>');
      return;
    }

    const idOrSlug = args[0];
    const resolved = this.resolveTask(idOrSlug);
    if ('error' in resolved) {
      await this.sendMessage(chatId, this.renderResolveError(idOrSlug, resolved));
      return;
    }

    if (resolved.status !== 'review') {
      await this.sendMessage(
        chatId,
        `Task ${resolved.id} không ở trạng thái review (hiện tại: ${resolved.status}).`,
      );
      return;
    }

    const feedback = args.slice(1).join(' ').trim();
    if (!feedback) {
      this.chatStates.set(chatId, { action: 'reject_feedback', taskId: resolved.id });
      await this.sendMessage(
        chatId,
        `💬 Vui lòng gửi nhận xét/yêu cầu sửa cho task ${resolved.id}:\n(Hoặc gửi /cancel để hủy)`,
      );
      return;
    }

    try {
      await this.service.reviewTask(resolved.id, {
        verdict: 'changes_requested',
        feedback,
        by: 'telegram',
      });
      await this.sendMessage(chatId, `↩️ Đã trả về task ${resolved.id} với nhận xét:\n${feedback}`);
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await this.sendMessage(chatId, `❌ Lỗi khi trả về task: ${errMsg}`);
    }
  }

  private renderResolveError(idOrSlug: string, err: { error: 'not_found' | 'ambiguous'; matches?: string[] }): string {
    if (err.error === 'ambiguous') {
      return `⚠️ Có nhiều task trùng slug '${idOrSlug}':\n${(err.matches || []).join('\n')}\nVui lòng dùng dạng 'project/slug'.`;
    }
    return `❌ Không tìm thấy task '${idOrSlug}'.`;
  }

  // --- Task ID Resolution ---

  /**
   * Resolves a task by either `projectId/slug`, `projectId~slug`, or unique `slug`.
   */
  resolveTask(idOrSlug: string): TaskRow | { error: 'not_found' | 'ambiguous'; matches?: string[] } {
    const raw = idOrSlug.trim();
    if (raw.includes('/') || raw.includes('~')) {
      const normId = toTaskId(raw);
      const task = this.taskRepo.get(normId);
      return task || { error: 'not_found' };
    }

    const allTasks = this.taskRepo.getAll();
    const matches = allTasks.filter(
      (t) => t.slug === raw || t.id === raw || t.id.endsWith(`/${raw}`),
    );

    if (matches.length === 1) {
      return matches[0];
    }
    if (matches.length > 1) {
      return { error: 'ambiguous', matches: matches.map((m) => m.id) };
    }
    return { error: 'not_found' };
  }

  // --- EventBus Listener & Notification Sender ---

  handleEvent(type: string, taskId?: string, payload?: unknown): void {
    if (!this.config.telegram?.enabled) return;
    const allowedChats = this.config.telegram?.allowedChatIds || [];
    if (allowedChats.length === 0) return;

    const notify = this.config.telegram?.notify || {
      reviewReady: true,
      failed: true,
      blocked: true,
      quota: true,
      fallback: true,
    };

    const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

    // Deduplication check: ignore duplicate events within 10 seconds
    const profileKey = (p.profile || p.worker || p.profileName || '') as string;
    const familyKey = (p.family || p.model || '') as string;
    const dedupKey = `${type}:${taskId || ''}:${profileKey}:${familyKey}`;
    const now = this.now();
    const lastTime = this.lastNotificationTime.get(dedupKey) || 0;
    if (now - lastTime < 10_000) {
      return;
    }
    this.lastNotificationTime.set(dedupKey, now);

    switch (type) {
      case 'review.escalated':
      case 'task.review_ready': {
        if (!notify.reviewReady) return;
        const task = taskId ? this.taskRepo.get(taskId) : null;
        const title = this.resolveTaskTitle(taskId, p, task);
        let checksText = '';
        if (typeof p.checksPassed === 'boolean') {
          checksText = `\nChecks: ${p.checksPassed ? '✓ Đạt' : '✗ Thất bại'}`;
        }

        const isEscalated = type === 'review.escalated';
        const header = isEscalated ? '🚨 <b>Cần người duyệt (Escalated)</b>' : '📋 <b>Task chờ review</b>';

        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '✅ Duyệt & merge', callback_data: `review:approve:${taskId}` },
            { text: '↩️ Trả về', callback_data: `review:reject_prompt:${taskId}` },
          ],
          [{ text: '📊 Xem diff tóm tắt', callback_data: `task:diff:${taskId}` }],
        ];

        this.broadcastMessage(
          `${header}\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>${checksText}`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'task.failed': {
        if (!notify.failed) return;
        const title = this.resolveTaskTitle(taskId, p);
        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '🔄 Chạy lại', callback_data: `task:retry:${taskId}` },
            { text: '📄 Xem log', callback_data: `task:log:${taskId}` },
          ],
        ];

        this.broadcastMessage(
          `❌ <b>Task thất bại</b>\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'task.blocked': {
        if (!notify.blocked) return;
        const title = this.resolveTaskTitle(taskId, p);
        const keyboard: InlineKeyboardButton[][] = [
          [
            { text: '🔄 Chạy lại', callback_data: `task:retry:${taskId}` },
            { text: '📄 Xem log', callback_data: `task:log:${taskId}` },
          ],
        ];

        this.broadcastMessage(
          `⚠️ <b>Task bị chặn</b>\nID: <code>${taskId}</code>\nTiêu đề: <b>${this.escapeHtml(title)}</b>`,
          { inline_keyboard: keyboard },
        );
        break;
      }

      case 'quota.exhausted': {
        if (!notify.quota) return;
        const name = (p.profile || p.worker || p.profileName || 'Hồ sơ') as string;
        const family = (p.family || p.model || '') as string;
        const resetStr = this.resolveResetTime(p, name, family);
        const text = resetStr
          ? `⏳ <b>Hết Quota</b>\nHồ sơ <b>${name}</b> hết quota <code>${family}</code> đến ${resetStr}`
          : `⏳ <b>Hết Quota</b>\nHồ sơ <b>${name}</b> hết quota <code>${family}</code>`;
        this.broadcastMessage(text);
        break;
      }

      case 'claude.quota_exhausted': {
        if (!notify.quota) return;
        this.broadcastMessage('⏳ <b>Claude hết quota</b>\nĐã kích hoạt failover hoặc cần chờ reset quota.');
        break;
      }

      case 'disk.low': {
        if (!notify.fallback) return;
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        const minFreeGB = typeof p.minFreeGB === 'number' ? p.minFreeGB : 3;
        this.broadcastMessage(`💾 <b>Ổ đĩa thấp</b>\nCòn ${freeGB} GB (&lt; ${minFreeGB} GB): tạm dừng khởi chạy task mới.`);
        break;
      }

      case 'disk.ok': {
        if (!notify.fallback) return;
        const freeGB = typeof p.freeGB === 'number' ? p.freeGB : 0;
        this.broadcastMessage(`💾 <b>Ổ đĩa đã đủ chỗ</b> (${freeGB} GB): tiếp tục chạy task.`);
        break;
      }

      case 'profile.auth_expired': {
        if (!notify.fallback) return;
        const name = typeof p.name === 'string' ? p.name : 'tài khoản';
        this.broadcastMessage(`🔑 <b>Tài khoản ${this.escapeHtml(name)}</b> cần đăng nhập lại.`);
        break;
      }
    }
  }

  private broadcastMessage(
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): void {
    const allowed = this.config.telegram?.allowedChatIds || [];
    for (const chatId of allowed) {
      void this.sendMessage(chatId, text, replyMarkup);
    }
  }

  // --- Message Sending & Anti-Flood Queue (1 msg/sec/chat) ---

  async sendMessage(
    chatId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<unknown> {
    return new Promise((resolve, reject) => {
      let queue = this.chatQueues.get(chatId);
      if (!queue) {
        queue = [];
        this.chatQueues.set(chatId, queue);
      }

      queue.push({ chatId, text, replyMarkup, resolve, reject });
      void this.processChatQueue(chatId);
    });
  }

  private async processChatQueue(chatId: number): Promise<void> {
    if (this.chatProcessing.get(chatId)) {
      return;
    }
    this.chatProcessing.set(chatId, true);

    try {
      while (true) {
        const queue = this.chatQueues.get(chatId);
        if (!queue || queue.length === 0) {
          break;
        }

        const item = queue.shift()!;
        const now = this.now();
        const lastSent = this.chatLastSent.get(chatId) || 0;
        const elapsed = now - lastSent;

        // Anti-flood: ensure at least 1000ms between messages to the same chat
        if (elapsed < 1000) {
          await this.sleepFn(1000 - elapsed);
        }

        this.chatLastSent.set(chatId, this.now());

        try {
          const res = await this.sendDirectMessage(item.chatId, item.text, item.replyMarkup);
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
    } finally {
      this.chatProcessing.set(chatId, false);
    }
  }

  /**
   * Flush any queued messages for a chat immediately (mainly for test cleanup).
   */
  async flushQueue(chatId?: number): Promise<void> {
    const chatIds = chatId ? [chatId] : Array.from(this.chatQueues.keys());
    for (const id of chatIds) {
      const queue = this.chatQueues.get(id);
      while (queue && queue.length > 0) {
        const item = queue.shift()!;
        try {
          const res = await this.sendDirectMessage(item.chatId, item.text, item.replyMarkup);
          item.resolve(res);
        } catch (err) {
          item.reject(err);
        }
      }
    }
  }

  private async sendDirectMessage(
    chatId: number,
    text: string,
    replyMarkup?: { inline_keyboard: InlineKeyboardButton[][] },
  ): Promise<unknown> {
    if (!this.token) {
      return null;
    }

    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;
    const body: Record<string, unknown> = {
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
    };
    if (replyMarkup) {
      body.reply_markup = replyMarkup;
    }

    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new Error(`Telegram sendMessage request failed: ${redactTelegramToken(err, this.token)}`);
    }

    if (!res.ok) {
      throw new Error(`Telegram sendMessage failed with status ${res.status}`);
    }

    return res.json();
  }

  private async answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void> {
    if (!this.token) return;

    try {
      const url = `https://api.telegram.org/bot${this.token}/answerCallbackQuery`;
      await this.fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          callback_query_id: callbackQueryId,
          text,
        }),
      });
    } catch {
      // ignore
    }
  }

  // --- Diff and Log Helpers ---

  private async getTaskDiffSummary(task: TaskRow): Promise<string> {
    const project = this.projectRepo.get(task.projectId);
    if (!project) return 'Không tìm thấy project của task.';

    const cwd = task.worktreePath && fs.existsSync(task.worktreePath)
      ? task.worktreePath
      : project.path;
    const baseRef = task.baseRef || project.defaultBranch || 'main';
    const branch = task.branch || 'HEAD';
    const target = cwd === task.worktreePath ? `${baseRef}...HEAD` : `${baseRef}...${branch}`;

    try {
      const { stdout } = await this.execFileFn('git', ['diff', '--stat', target], {
        cwd,
        timeout: 10_000,
      });
      const trimmed = stdout.trim();
      if (!trimmed) return 'Không có thay đổi file nào.';
      return trimmed.length > 3500 ? trimmed.slice(0, 3500) + '\n... (đã cắt bớt)' : trimmed;
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return `Không thể lấy diff: ${errMsg}`;
    }
  }

  private getTaskLast30Lines(taskId: string): string {
    const fullLog = this.service.getTaskLog(taskId, { tail: 64 }) || '';
    if (!fullLog.trim()) {
      return 'Chưa có log cho task này.';
    }

    const lines = fullLog.split('\n');
    const last30 = lines.slice(-30).join('\n');
    return last30.length > 3500 ? last30.slice(0, 3500) + '\n... (đã cắt bớt)' : last30;
  }

  private resolveTaskTitle(taskId?: string, payload?: Record<string, unknown>, taskObj?: TaskRow | null): string {
    if (payload?.title && typeof payload.title === 'string') return payload.title;
    if (taskObj?.title) return taskObj.title;
    if (taskId) {
      const task = this.taskRepo.get(taskId) || this.taskRepo.get(toTaskId(taskId));
      if (task?.title) return task.title;
      return taskId;
    }
    return 'Task';
  }

  private resolveResetTime(p: Record<string, unknown>, profile: string, family: string): string {
    if (typeof p.time === 'string') return p.time;
    if (typeof p.untilStr === 'string') return p.untilStr;

    let epochSec: number | undefined;
    if (typeof p.until === 'number') {
      epochSec = p.until > 1e11 ? Math.floor(p.until / 1000) : p.until;
    } else if (typeof p.resetAt === 'number') {
      epochSec = p.resetAt > 1e11 ? Math.floor(p.resetAt / 1000) : p.resetAt;
    } else if (typeof p.resetSeconds === 'number') {
      epochSec = Math.floor(this.now() / 1000) + p.resetSeconds;
    } else if (this.quotaMarkRepo && profile && family) {
      const marks = this.quotaMarkRepo.getActive();
      const mark = marks.find((m) => m.profileName === profile && m.family === family);
      if (mark) epochSec = mark.until;
    }

    if (epochSec !== undefined) {
      const d = new Date(epochSec * 1000);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return `${hh}:${mm}`;
    }

    return '';
  }

  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  private renderHelp(): string {
    return `🤖 <b>Danh sách lệnh AgentHub Telegram Bot:</b>

/status - Xem tổng quan hệ thống (task, hồ sơ, quota, ổ đĩa)
/tasks [trạng thái] - Xem danh sách task (vd: /tasks review, /tasks running)
/task &lt;id&gt; - Xem chi tiết task, kết quả checks và link dashboard
/log &lt;id&gt; - Xem 30 dòng cuối log của task
/retry &lt;id&gt; - Chạy lại task bị failed hoặc blocked
/cancel &lt;id&gt; - Hủy task (kèm nút xác nhận)
/approve &lt;id&gt; - Duyệt task (+ merge nếu project có cấu hình)
/reject &lt;id&gt; &lt;nhận xét&gt; - Trả về task yêu cầu sửa đổi
/pause - Tạm dừng giao task mới
/resume - Tiếp tục giao task mới
/help - Hướng dẫn sử dụng

<i>Lưu ý: Task ID có thể dùng dạng đầy đủ 'project/slug' hoặc chỉ 'slug' nếu không trùng.</i>`;
  }
}
