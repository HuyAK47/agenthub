import { describe, expect, it } from 'vitest';
import { NotificationDeduper } from '../src/notification-dedupe.js';

describe('NotificationDeduper', () => {
  it('scopes duplicate events by project', () => {
    const deduper = new NotificationDeduper({ now: () => 1_000 });

    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-a' })).toBe(true);
    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-b' })).toBe(true);
    expect(deduper.shouldSend('deploy.failed', 'task-1', { projectId: 'project-a' })).toBe(false);
  });
});
