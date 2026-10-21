import { TaskRepo, ProjectRepo, ProfileRepo, QuotaMarkRepo, EventRepo } from '../db/index.js';
import type { QuietHoursConfig } from '../config.js';

export interface PendingDecision {
  id: string;
  text: string;
  level: 'decision';
  createdAt: number;
  chatIds: number[];
  answered: boolean;
  answer?: 'agree' | 'reject';
  answeredAt?: number;
  remindersCount: number;
  lastReminderAt: number;
}

export class DecisionTracker {
  private decisions = new Map<string, PendingDecision>();

  recordDecision(
    id: string,
    text: string,
    chatIds: number[] = [],
    createdAt = Date.now(),
  ): PendingDecision {
    const existing = this.decisions.get(id);
    if (existing) return existing;

    const decision: PendingDecision = {
      id,
      text,
      level: 'decision',
      createdAt,
      chatIds: [...chatIds],
      answered: false,
      remindersCount: 0,
      lastReminderAt: createdAt,
    };
    this.decisions.set(id, decision);
    return decision;
  }

  getDecision(id: string): PendingDecision | undefined {
    return this.decisions.get(id);
  }

  answerDecision(
    id: string,
    answer: 'agree' | 'reject',
    answeredAt = Date.now(),
  ): PendingDecision | null {
    const d = this.decisions.get(id);
    if (!d) return null;
    d.answered = true;
    d.answer = answer;
    d.answeredAt = answeredAt;
    return d;
  }

  getPending(): PendingDecision[] {
    return Array.from(this.decisions.values()).filter((d) => !d.answered);
  }

  getAll(): PendingDecision[] {
    return Array.from(this.decisions.values());
  }

  getRemindersDue(
    now = Date.now(),
    intervalMs = 2 * 60 * 60 * 1000,
    maxReminders = 2,
  ): Array<{ decision: PendingDecision; reminderIndex: number }> {
    const due: Array<{ decision: PendingDecision; reminderIndex: number }> = [];
    for (const d of this.decisions.values()) {
      if (d.answered) continue;
      if (d.remindersCount >= maxReminders) continue;
      if (now - d.lastReminderAt >= intervalMs) {
        due.push({
          decision: d,
          reminderIndex: d.remindersCount + 1,
        });
      }
    }
    return due;
  }

  markReminderSent(id: string, now = Date.now()): void {
    const d = this.decisions.get(id);
    if (!d) return;
    d.remindersCount += 1;
    d.lastReminderAt = now;
  }

  clear(): void {
    this.decisions.clear();
  }
}

/**
 * Checks whether the current time falls inside quiet hours.
 * Handles ranges spanning midnight (e.g. 22:00 -> 07:00).
 */
export function isQuietHours(config?: QuietHoursConfig | null, now = new Date()): boolean {
  if (!config || !config.enabled) return false;

  const startParts = (config.start || '22:00').split(':').map(Number);
  const endParts = (config.end || '07:00').split(':').map(Number);
  const startMins = (startParts[0] || 0) * 60 + (startParts[1] || 0);
  const endMins = (endParts[0] || 0) * 60 + (endParts[1] || 0);
  const curMins = now.getHours() * 60 + now.getMinutes();

  if (startMins === endMins) return false;
  if (startMins < endMins) {
    return curMins >= startMins && curMins < endMins;
  } else {
    // Spans midnight, e.g. 22:00 to 07:00
    return curMins >= startMins || curMins < endMins;
  }
}

/**
 * Determines if all configured active/enabled profiles are currently quota-exhausted.
 */
export function areAllProfilesQuotaExhausted(
  profileRepo?: ProfileRepo,
  quotaMarkRepo?: QuotaMarkRepo,
  now = Date.now(),
): boolean {
  if (!profileRepo || !quotaMarkRepo) return false;
  const profiles = profileRepo.getAll(true);
  if (profiles.length === 0) return false;

  const marks = quotaMarkRepo.getActive().filter((m) => m.until > Math.floor(now / 1000));
  const exhaustedProfiles = new Set(marks.map((m) => m.profileName));

  return profiles.every((p) => exhaustedProfiles.has(p.name));
}

/**
 * Checks whether an event qualifies as a system incident that should bypass quiet hours and auto-mode suppression.
 */
export function isSystemIncident(
  type: string,
  payload?: unknown,
  profileRepo?: ProfileRepo,
  quotaMarkRepo?: QuotaMarkRepo,
  now = Date.now(),
): boolean {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>;

  if (p.level === 'incident') return true;
  if (p.urgency === 'critical' || p.critical === true) return true;

  if (type === 'disk.low' || type === 'disk.docker_low') return true;
  if (type === 'claude.quota_exhausted') return true;
  if (type === 'hub.restart_failed' || type === 'system.error') return true;

  if (type === 'quota.exhausted') {
    if (p.allExhausted === true) return true;
    if (areAllProfilesQuotaExhausted(profileRepo, quotaMarkRepo, now)) return true;
  }

  return false;
}

export interface GenerateDigestOptions {
  taskRepo: TaskRepo;
  projectRepo?: ProjectRepo;
  profileRepo?: ProfileRepo;
  quotaMarkRepo?: QuotaMarkRepo;
  eventRepo?: EventRepo;
  decisionTracker?: DecisionTracker;
  now?: () => number;
  accumulatedQuietHoursMessages?: string[];
  port?: number;
}

export interface DigestData {
  generatedAt: string;
  tasks: {
    done: number;
    running: number;
    failed: number;
    blocked: number;
    review: number;
    queued: number;
    waiting_quota: number;
    total: number;
  };
  merged: Array<{
    taskId: string;
    title: string;
    mergeCommit?: string;
  }>;
  quota: {
    summary: string;
    totalProfiles: number;
    availableProfiles: string[];
    exhaustedProfiles: Array<{
      profileName: string;
      family: string;
      until: string;
    }>;
  };
  decisions: Array<{
    id: string;
    text: string;
    createdAt: string;
    remindersCount?: number;
  }>;
  accumulatedQuietHoursMessages?: string[];
  text: string;
  markdown: string;
}

export function generateDigest(opts: GenerateDigestOptions): DigestData {
  const nowMs = opts.now ? opts.now() : Date.now();
  const nowDate = new Date(nowMs);
  const nowIso = nowDate.toISOString();
  const timeStr = `${String(nowDate.getHours()).padStart(2, '0')}:${String(nowDate.getMinutes()).padStart(2, '0')}`;
  const dateStr = `${timeStr} ${String(nowDate.getDate()).padStart(2, '0')}/${String(nowDate.getMonth() + 1).padStart(2, '0')}/${nowDate.getFullYear()}`;

  // 1. Task counts
  const doneTasks = opts.taskRepo.getByStatus('done');
  const runningTasks = opts.taskRepo.getByStatus('running');
  const failedTasks = opts.taskRepo.getByStatus('failed');
  const blockedTasks = opts.taskRepo.getByStatus('blocked');
  const reviewTasks = opts.taskRepo.getByStatus('review');
  const queuedTasks = opts.taskRepo.getByStatus('queued');
  const waitingQuotaTasks = opts.taskRepo.getByStatus('waiting_quota');
  const totalTasks =
    doneTasks.length +
    runningTasks.length +
    failedTasks.length +
    blockedTasks.length +
    reviewTasks.length +
    queuedTasks.length +
    waitingQuotaTasks.length;

  const tasksSummary = {
    done: doneTasks.length,
    running: runningTasks.length,
    failed: failedTasks.length,
    blocked: blockedTasks.length,
    review: reviewTasks.length,
    queued: queuedTasks.length,
    waiting_quota: waitingQuotaTasks.length,
    total: totalTasks,
  };

  // 2. Merged tasks in the last 24h
  const merged: Array<{ taskId: string; title: string; mergeCommit?: string }> = [];
  if (opts.eventRepo) {
    const recentEvents = opts.eventRepo.getRecent(200);
    const dayAgoMs = nowMs - 24 * 60 * 60 * 1000;
    for (const ev of recentEvents) {
      if (ev.type === 'task.merged') {
        const evTime = ev.ts ? new Date(ev.ts).getTime() : nowMs;
        if (evTime >= dayAgoMs) {
          const taskId = ev.taskId || '';
          const task = taskId ? opts.taskRepo.get(taskId) : null;
          const p = (ev.payload && typeof ev.payload === 'object' ? ev.payload : {}) as Record<string, unknown>;
          const mergeCommit = typeof p.mergeCommit === 'string' ? p.mergeCommit.slice(0, 7) : undefined;
          merged.push({
            taskId,
            title: task?.title || taskId || 'Task',
            mergeCommit,
          });
        }
      }
    }
  }

  // 3. Quota summary
  const profiles = opts.profileRepo ? opts.profileRepo.getAll(true) : [];
  const activeMarks = opts.quotaMarkRepo
    ? opts.quotaMarkRepo.getActive().filter((m) => m.until > Math.floor(nowMs / 1000))
    : [];
  const exhaustedMap = new Map<string, { family: string; until: string }>();
  for (const m of activeMarks) {
    const d = new Date(m.until * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    exhaustedMap.set(m.profileName, {
      family: m.family,
      until: `${hh}:${mm}`,
    });
  }

  const exhaustedList: Array<{ profileName: string; family: string; until: string }> = [];
  const availableList: string[] = [];

  for (const p of profiles) {
    const ex = exhaustedMap.get(p.name);
    if (ex) {
      exhaustedList.push({ profileName: p.name, ...ex });
    } else {
      availableList.push(p.name);
    }
  }

  let quotaSummary = '';
  if (profiles.length === 0) {
    quotaSummary = 'Không có tài khoản nào được cấu hình';
  } else if (exhaustedList.length === 0) {
    quotaSummary = `Tất cả tài khoản đều sẵn sàng (${profiles.length}/${profiles.length})`;
  } else if (availableList.length === 0) {
    quotaSummary = `Mọi tài khoản đều hết quota (0/${profiles.length})`;
  } else {
    quotaSummary = `${availableList.length}/${profiles.length} tài khoản sẵn sàng`;
  }

  // 4. Pending decisions
  const decisions: Array<{ id: string; text: string; createdAt: string; remindersCount?: number }> = [];
  if (opts.decisionTracker) {
    for (const d of opts.decisionTracker.getPending()) {
      decisions.push({
        id: d.id,
        text: d.text,
        createdAt: new Date(d.createdAt).toISOString(),
        remindersCount: d.remindersCount,
      });
    }
  }

  // Also include escalated review tasks that require human decision
  for (const t of reviewTasks) {
    if (t.reviewerEscalated) {
      decisions.push({
        id: `review:${t.id}`,
        text: `Duyệt task escalated: ${t.title || t.id}`,
        createdAt: t.updatedAt || nowIso,
      });
    }
  }

  // Format Telegram HTML text
  const taskLines = [
    `• Hoàn thành: <b>${tasksSummary.done}</b>`,
    `• Đang chạy: <b>${tasksSummary.running}</b>`,
    `• Lỗi: <b>${tasksSummary.failed}</b>${tasksSummary.blocked ? ` (Bị chặn: <b>${tasksSummary.blocked}</b>)` : ''}${tasksSummary.review ? ` (Chờ review: <b>${tasksSummary.review}</b>)` : ''}`,
  ];

  let mergedSection = '';
  if (merged.length === 0) {
    mergedSection = '• <i>Không có task nào được merge trong 24h qua</i>';
  } else {
    mergedSection = merged
      .slice(0, 10)
      .map((m) => `• <code>${escapeHtml(m.taskId)}</code>: ${escapeHtml(m.title)}${m.mergeCommit ? ` <i>(${m.mergeCommit})</i>` : ''}`)
      .join('\n');
    if (merged.length > 10) {
      mergedSection += `\n• <i>... và ${merged.length - 10} task khác</i>`;
    }
  }

  let quotaSection = `• ${escapeHtml(quotaSummary)}`;
  if (exhaustedList.length > 0) {
    quotaSection += '\n' + exhaustedList.map((e) => `  - Hồ sơ <b>${escapeHtml(e.profileName)}</b> (${escapeHtml(e.family)}): đến ${e.until}`).join('\n');
  }

  let decisionsSection = '';
  if (decisions.length === 0) {
    decisionsSection = '• <i>Không có việc nào cần xử lý</i>';
  } else {
    decisionsSection = decisions
      .map((d) => `• [Cần quyết định] ${escapeHtml(d.text)}`)
      .join('\n');
  }

  let quietSection = '';
  if (opts.accumulatedQuietHoursMessages && opts.accumulatedQuietHoursMessages.length > 0) {
    quietSection = `\n\n🌅 <b>Tin dồn giờ yên tĩnh (${opts.accumulatedQuietHoursMessages.length}):</b>\n` +
      opts.accumulatedQuietHoursMessages.slice(0, 5).map((m) => `• ${escapeHtml(m)}`).join('\n');
    if (opts.accumulatedQuietHoursMessages.length > 5) {
      quietSection += `\n• <i>... và ${opts.accumulatedQuietHoursMessages.length - 5} tin khác</i>`;
    }
  }

  const text =
    `📋 <b>TÓM TẮT HỆ THỐNG AGENTHUB</b>\n` +
    `<i>${dateStr}</i>\n\n` +
    `📊 <b>Tiến độ công việc:</b>\n${taskLines.join('\n')}\n\n` +
    `🔀 <b>Đã merge (24h):</b>\n${mergedSection}\n\n` +
    `⏳ <b>Quota tài khoản:</b>\n${quotaSection}\n\n` +
    `📌 <b>Việc cần quyết định (${decisions.length}):</b>\n${decisionsSection}${quietSection}`;

  // Markdown format for web / dashboard
  const markdown =
    `# Tóm tắt hệ thống AgentHub (${dateStr})\n\n` +
    `### Tiến độ công việc\n` +
    `- Hoàn thành: **${tasksSummary.done}**\n` +
    `- Đang chạy: **${tasksSummary.running}**\n` +
    `- Lỗi: **${tasksSummary.failed}**\n` +
    `- Chờ review: **${tasksSummary.review}**\n` +
    `- Bị chặn: **${tasksSummary.blocked}**\n\n` +
    `### Đã merge (24h)\n` +
    (merged.length === 0
      ? `_Không có task nào được merge trong 24h qua_\n\n`
      : merged.map((m) => `- \`${m.taskId}\`: ${m.title}${m.mergeCommit ? ` (${m.mergeCommit})` : ''}`).join('\n') + '\n\n') +
    `### Quota tài khoản\n` +
    `- ${quotaSummary}\n` +
    (exhaustedList.length > 0
      ? exhaustedList.map((e) => `  - ${e.profileName} (${e.family}) đến ${e.until}`).join('\n') + '\n\n'
      : '\n') +
    `### Việc cần quyết định (${decisions.length})\n` +
    (decisions.length === 0
      ? `_Không có việc nào cần xử lý_\n`
      : decisions.map((d) => `- ${d.text}`).join('\n') + '\n');

  return {
    generatedAt: nowIso,
    tasks: tasksSummary,
    merged,
    quota: {
      summary: quotaSummary,
      totalProfiles: profiles.length,
      availableProfiles: availableList,
      exhaustedProfiles: exhaustedList,
    },
    decisions,
    accumulatedQuietHoursMessages: opts.accumulatedQuietHoursMessages ? [...opts.accumulatedQuietHoursMessages] : undefined,
    text,
    markdown,
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
