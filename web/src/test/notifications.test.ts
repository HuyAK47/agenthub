import { describe, expect, it, beforeEach, vi } from 'vitest';
import { notifyBrowserEvent, shouldNotifyBrowserEvent } from '../notifications';
import { EventItem } from '../types/api';

const event = (type: string, payload: Record<string, unknown> = {}): EventItem => ({
  id: 1, ts: new Date().toISOString(), type, taskId: null, payload,
});

describe('browser notification policy', () => {
  beforeEach(() => {
    localStorage.clear();
    Object.defineProperty(window, 'Notification', {
      configurable: true,
      value: class MockNotification {
        static permission = 'granted';
        constructor() {}
      },
    });
  });

  it('does not turn background SSE events into browser notifications', () => {
    expect(shouldNotifyBrowserEvent(event('run.output'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('deploy.restart_waiting'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('claude.quota_available'), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('brain.updated'), 'all')).toBe(false);
  });

  it('requires engine-wide quota exhaustion at important level', () => {
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { profile: 'g1' }), 'important')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true }), 'important')).toBe(true);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { profile: 'g1' }), 'all')).toBe(false);
    expect(shouldNotifyBrowserEvent(event('quota.exhausted', { allExhausted: true }), 'all')).toBe(true);
  });

  it('throttles changing disk messages by state for one hour', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
    notifyBrowserEvent(event('disk.low', { freeGB: 1 }), 'all');
    notifyBrowserEvent(event('disk.low', { freeGB: 0.5 }), 'all');
    expect(localStorage.length).toBe(1);
    now.mockRestore();
  });
});
