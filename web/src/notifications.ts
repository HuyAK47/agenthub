import { EventItem } from './types/api';

const IMPORTANT = new Set(['brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed']);
const DESKTOP_EVENTS = new Set([
  ...IMPORTANT,
  'batch.created', 'task.paused', 'load.task_paused', 'load.high', 'task.resumed',
  'load.task_resumed', 'disk.ok', 'claude.fallback_changed', 'claude.auto_resumed',
  'profile.auth_expired', 'ci.passed',
]);
const WINDOW_MS = 30 * 60 * 1000;
const DISK_WINDOW_MS = 60 * 60 * 1000;
const LOAD_WINDOW_MS = 15 * 60 * 1000;

export interface BrowserQuotaProfile {
  name?: string;
  engine?: string;
  enabled?: boolean | number;
  quotaMarks?: Array<{ family?: string; until?: number }>;
}
function normalizeQuotaFamily(family: unknown): string | undefined {
  if (typeof family !== 'string' || !family) return undefined;
  if (family.startsWith('codex')) return 'codex';
  if (family.startsWith('gemini')) return 'gemini';
  if (family.startsWith('claude')) return 'claude';
  return family;
}
export function isEngineWideQuotaExhausted(
  event: EventItem,
  profiles: BrowserQuotaProfile[] = [],
): boolean {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  let engine = typeof payload.engine === 'string' ? payload.engine : undefined;
  const family = normalizeQuotaFamily(payload.family ?? payload.model);
  if (!engine) {
    const profileName = typeof payload.profile === 'string' ? payload.profile
      : typeof payload.profileName === 'string' ? payload.profileName
      : typeof payload.worker === 'string' ? payload.worker : undefined;
    if (profileName) {
      const match = profiles.find((p) => p.name === profileName);
      engine = match?.engine;
    }
  }
  if (!engine && family) {
    if (family === 'gemini' || family === 'claude') engine = 'agy';
    else if (family === 'codex') engine = 'codex';
  }
  const active = profiles.filter((profile) => profile.enabled !== false && profile.enabled !== 0 && (!engine || profile.engine === engine));
  if (active.length === 0) {
    return Boolean(payload.allExhausted === true && engine && family);
  }
  const now = Date.now() / 1000;
  if (family) {
    return active.every((profile) => profile.quotaMarks?.some((mark) => normalizeQuotaFamily(mark.family) === family && typeof mark.until === 'number' && mark.until > now));
  }
  return active.every((profile) => profile.quotaMarks?.some((mark) => typeof mark.until === 'number' && mark.until > now));
}

export function browserNotificationBody(event: EventItem): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const appName = 'AgentHub';
  if (event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high') {
    return `${appName}: Đã tạm dừng task hoặc gặp tải cao; xem dashboard để biết chi tiết`;
  }
  if (event.type === 'disk.low') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : 3;
    const cacheDir = typeof payload.cacheDir === 'string' ? ` Cache node_modules: ${payload.cacheDir}.` : '';
    const largest = typeof payload.largestCacheEntry === 'string'
      ? ` Bản lớn nhất: ${payload.largestCacheEntry}${typeof payload.largestCacheEntryBytes === 'number' ? ` (${(payload.largestCacheEntryBytes / 1024 ** 3).toFixed(2)} GB)` : ''}.`
      : '';
    return `Ổ đĩa còn ${freeGB} GB (< ${minFreeGB} GB): tạm dừng khởi chạy task${cacheDir}${largest}`;
  }
  if (event.type === 'disk.ok') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    return `Ổ đĩa đã đủ chỗ (${freeGB} GB): tiếp tục chạy task`;
  }
  if (event.type === 'disk.docker_low') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : (payload.freeGB ?? '?');
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : 5;
    return `Ổ đĩa Docker còn ${freeGB} GB (< ${minFreeGB} GB): không chạy docker build/pull/compose up`;
  }
  if (event.type === 'quota.exhausted') {
    return `${appName}: Mọi tài khoản đều đã hết quota`;
  }
  if (event.type === 'task.failed') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return `${appName}: ${title} thất bại`;
  }
  if (event.type === 'task.blocked') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return `${appName}: ${title} bị chặn`;
  }
  if (event.type === 'task.review_ready') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    let msg = `${appName}: ${title} chờ review`;
    if ('checksPassed' in payload) {
      msg += ` (${payload.checksPassed ? '✓' : '✗'} checks)`;
    }
    return msg;
  }
  if (event.type === 'review.escalated') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return `Cần người duyệt: ${title}`;
  }
  if (event.type === 'brain.notify') {
    const text = typeof payload.text === 'string' ? payload.text : '';
    if (payload.level === 'incident') return `🚨 Sự cố ${appName}: ${text}`;
    if (payload.level === 'decision') return `📌 Cần quyết định: ${text}`;
    return `ℹ️ ${appName}: ${text}`;
  }
  if (event.type === 'batch.created') {
    const count = typeof payload.taskCount === 'number' ? payload.taskCount : 0;
    const who = typeof payload.createdBy === 'string' && payload.createdBy ? payload.createdBy : 'Claude';
    const label = who.toLowerCase() === 'claude' ? 'Claude' : who;
    return `${label} đề xuất ${count} task, chờ bạn duyệt`;
  }
  if (event.type === 'task.resumed' || event.type === 'load.task_resumed') {
    const title = typeof payload.title === 'string' ? payload.title : (event.taskId || 'Task');
    return `Tiếp tục task ${title}`;
  }
  if (event.type === 'claude.fallback_changed') {
    const step = payload.step && typeof payload.step === 'object' ? payload.step as Record<string, unknown> : null;
    const label = step?.type === 'model' ? `model ${String(step.model)}`
      : step?.type === 'profile' ? `tài khoản ${String(step.profile || 'khác')}`
      : step?.type === 'apiKey' ? 'API key'
      : step?.type === 'engine' ? `engine ${String(step.engine)}`
      : step?.type === 'wait' ? 'chờ reset' : 'cấu hình chính';
    return `Claude fallback: đang dùng ${label}`;
  }
  if (event.type === 'claude.auto_resumed') {
    if (payload.started === true) return 'Claude đã tự tiếp tục phiên sau khi hết giới hạn';
    return 'Claude tự tiếp tục nhưng phiên đã lỗi';
  }
  if (event.type === 'profile.auth_expired') {
    const name = typeof payload.name === 'string' ? payload.name : 'tài khoản';
    return `Hồ sơ ${name} cần đăng nhập lại`;
  }
  if (event.type === 'ci.failed') {
    const projId = (typeof payload.projectId === 'string' ? payload.projectId : event.taskId) || 'dự án';
    const workflow = (typeof payload.workflow === 'string' ? payload.workflow : '') || 'CI';
    const sha = typeof payload.sha === 'string' ? payload.sha.slice(0, 7) : '';
    const jobs = Array.isArray(payload.jobs) ? (payload.jobs as Array<{ name?: string }>) : [];
    const failedJobNames = jobs.map((j) => j.name).filter(Boolean);
    const jobDetails = failedJobNames.length > 0 ? ` (${failedJobNames.join(', ')})` : '';
    return `CI thất bại [${projId}]: ${workflow}${sha ? ` @ ${sha}` : ''}${jobDetails}`;
  }
  if (event.type === 'ci.passed') {
    const projId = (typeof payload.projectId === 'string' ? payload.projectId : event.taskId) || 'dự án';
    const workflow = (typeof payload.workflow === 'string' ? payload.workflow : '') || 'CI';
    const sha = typeof payload.sha === 'string' ? payload.sha.slice(0, 7) : '';
    return `CI đã xanh: [${projId}] ${workflow}${sha ? ` @ ${sha}` : ''}`;
  }
  return `${appName} có cập nhật cần chú ý`;
}

export function shouldNotifyBrowserEvent(
  event: EventItem,
  level: 'all' | 'important' | 'critical' | 'off' = 'important',
  profiles: BrowserQuotaProfile[] = [],
): boolean {
  if (level === 'off' || !DESKTOP_EVENTS.has(event.type)) return false;
  if (level === 'important' && !IMPORTANT.has(event.type)) return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'quota.exhausted') {
    return isEngineWideQuotaExhausted(event, profiles);
  }
  // The scheduler emits disk.ok only after the hysteresis margin is crossed.
  // Keep this guard here too because SSE can be replayed or produced by an
  // older scheduler, and such an event must not wake the browser.
  if (event.type === 'disk.low' || event.type === 'disk.ok') {
    const freeGB = typeof payload.freeGB === 'number' ? payload.freeGB : NaN;
    const minFreeGB = typeof payload.minFreeGB === 'number' ? payload.minFreeGB : NaN;
    const valid = event.type === 'disk.low' ? freeGB < minFreeGB : freeGB >= minFreeGB + 1;
    if (!Number.isFinite(freeGB) || !Number.isFinite(minFreeGB) || !valid) return false;
  }
  if (level !== 'critical') return true;
  return event.type === 'task.failed' || event.type === 'disk.docker_low' || (event.type === 'quota.exhausted' && isEngineWideQuotaExhausted(event, profiles));
}

export function notifyBrowserEvent(
  event: EventItem,
  level: 'all' | 'important' | 'critical' | 'off' = 'important',
  profiles: BrowserQuotaProfile[] = [],
): void {
  if (typeof window === 'undefined' || !shouldNotifyBrowserEvent(event, level, profiles) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'quota.exhausted' && !shouldNotifyBrowserEvent(event, level, profiles)) return;

  // State transition guard for disk.ok: only allowed if disk was previously in 'low' state.
  if (event.type === 'disk.ok') {
    const previousLow = Number(localStorage.getItem('agenthub:notification:disk.low') || 0);
    const previousOk = Number(localStorage.getItem('agenthub:notification:disk.ok') || 0);
    if (!previousLow || previousLow < previousOk) return;
  }

  const throttleWindow = event.type === 'disk.low' || event.type === 'disk.ok'
    ? DISK_WINDOW_MS
    : event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high'
    ? LOAD_WINDOW_MS
    : WINDOW_MS;

  let engine = typeof payload.engine === 'string' ? payload.engine : undefined;
  const family = normalizeQuotaFamily(payload.family ?? payload.model);
  if (!engine && typeof (payload.profile || payload.worker || payload.profileName) === 'string') {
    const pName = (payload.profile || payload.worker || payload.profileName) as string;
    engine = profiles.find((p) => p.name === pName)?.engine;
  }

  const identity = event.type === 'disk.low' || event.type === 'disk.ok'
    ? event.type
    : event.type === 'quota.exhausted'
    ? `quota:${engine || 'unknown'}:${family || 'unknown'}`
    : event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high'
    ? 'load:summary'
    : `${event.type}:${event.taskId || ''}:${JSON.stringify(payload)}`;

  const key = `agenthub:notification:${identity}`;
  const now = Date.now();
  try {
    const previous = Number(localStorage.getItem(key) || 0);
    if (previous && now - previous < throttleWindow) return;
    localStorage.setItem(key, String(now));
    new Notification(event.type, { body: browserNotificationBody(event) });
  } catch {
    // Browser notification APIs may be unavailable or blocked by policy.
  }
}
