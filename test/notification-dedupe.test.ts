import { describe, expect, it } from 'vitest';
import { NotificationDeduper } from '../src/notification-dedupe.js';

describe('NotificationDeduper', () => {
  it('scopes duplicate events by project', () => {
    const deduper = new NotificationDeduper({ now: () => 1_000 });

    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-a' })).toBe(true);
    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-b' })).toBe(true);
    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-a' })).toBe(false);
  });

  it('deduplicates task.waiting_quota for 30 minutes', () => {
    let now = 1_000;
    const deduper = new NotificationDeduper({ now: () => now });

    expect(deduper.shouldSend('task.waiting_quota', 'proj/t1', { reason: 'no_department_profile' })).toBe(true);
    // Within 30 minutes -> false
    now += 15 * 60 * 1000;
    expect(deduper.shouldSend('task.waiting_quota', 'proj/t1', { reason: 'no_department_profile' })).toBe(false);
    // After 30 minutes -> true
    now += 16 * 60 * 1000; // 31 minutes total
    expect(deduper.shouldSend('task.waiting_quota', 'proj/t1', { reason: 'no_department_profile' })).toBe(true);
  });
});
