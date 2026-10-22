import { EventItem } from './types/api';

const IMPORTANT = new Set(['brain.notify', 'task.review_ready', 'task.failed', 'task.blocked', 'review.escalated', 'disk.low', 'disk.docker_low', 'quota.exhausted', 'ci.failed']);
const WINDOW_MS = 30 * 60 * 1000;

export function notifyBrowserEvent(event: EventItem, level: 'all' | 'important' | 'critical' | 'off' = 'important'): void {
  if (level === 'off' || typeof window === 'undefined' || !('Notification' in window) || Notification.permission !== 'granted') return;
  if (level === 'important' && !IMPORTANT.has(event.type)) return;
  const payload = event.payload && typeof event.payload === 'object' ? event.payload as Record<string, unknown> : {};
  const critical = event.type === 'task.failed' || event.type === 'disk.docker_low' || (event.type === 'quota.exhausted' && payload.allExhausted === true);
  if (level === 'critical' && !critical) return;
  const key = `agenthub:notification:${event.type}:${event.taskId || ''}:${JSON.stringify(payload)}`;
  const now = Date.now();
  try {
    const previous = Number(localStorage.getItem(key) || 0);
    if (previous && now - previous < WINDOW_MS) return;
    localStorage.setItem(key, String(now));
    new Notification(event.type, { body: typeof payload.message === 'string' ? payload.message : 'AgentHub có cập nhật cần chú ý' });
  } catch {
    // Browser notification APIs may be unavailable or blocked by policy.
  }
}
