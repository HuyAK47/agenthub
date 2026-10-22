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

export function browserNotificationBody(event: EventItem): string {
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high') {
    return 'AgentHub đã tạm dừng task hoặc phát hiện tải cao; xem dashboard để biết chi tiết';
  }
  if (event.type === 'disk.low') {
    return `Ổ đĩa còn ${String(payload.freeGB ?? '?')} GB; AgentHub tạm dừng khởi chạy task`;
  }
  if (event.type === 'disk.ok') {
    return `Ổ đĩa đã đủ chỗ (${String(payload.freeGB ?? '?')} GB); AgentHub tiếp tục chạy task`;
  }
  if (event.type === 'quota.exhausted') {
    return 'Mọi tài khoản của engine đã hết quota; AgentHub tạm dừng thực thi task';
  }
  if (event.type === 'task.failed') return 'AgentHub có task thất bại';
  if (event.type === 'task.blocked') return 'AgentHub có task bị chặn';
  if (event.type === 'task.review_ready' || event.type === 'review.escalated') return 'AgentHub cần bạn review';
  if (event.type === 'brain.notify') return typeof payload.text === 'string' ? payload.text : 'Bộ não cần bạn chú ý';
  return 'AgentHub có cập nhật cần chú ý';
}

export function shouldNotifyBrowserEvent(event: EventItem, level: 'all' | 'important' | 'critical' | 'off' = 'important'): boolean {
  if (level === 'off' || !DESKTOP_EVENTS.has(event.type)) return false;
  if (level === 'important' && !IMPORTANT.has(event.type)) return false;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'quota.exhausted') {
    return payload.allExhausted === true
      && typeof payload.engine === 'string'
      && typeof (payload.family || payload.model) === 'string';
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
  return event.type === 'task.failed' || event.type === 'disk.docker_low' || (event.type === 'quota.exhausted' && payload.allExhausted === true);
}

export function notifyBrowserEvent(event: EventItem, level: 'all' | 'important' | 'critical' | 'off' = 'important'): void {
  if (typeof window === 'undefined' || !shouldNotifyBrowserEvent(event, level) || !('Notification' in window) || Notification.permission !== 'granted') return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  if (event.type === 'quota.exhausted' && !shouldNotifyBrowserEvent(event, level)) return;
  const throttleWindow = event.type === 'disk.low' || event.type === 'disk.ok'
    ? DISK_WINDOW_MS
    : event.type === 'task.paused' || event.type === 'load.task_paused' || event.type === 'load.high'
    ? LOAD_WINDOW_MS
    : WINDOW_MS;
  const identity = event.type === 'disk.low' || event.type === 'disk.ok'
    ? event.type
    : event.type === 'quota.exhausted' && payload.allExhausted === true
    ? `quota:${String(payload.engine || 'unknown')}:${String(payload.family || payload.model || 'unknown')}`
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
