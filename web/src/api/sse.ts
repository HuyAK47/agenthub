import { QueryClient } from '@tanstack/react-query';
import { getToken } from './client';
import { EventItem } from '../types/api';
import { notifyBrowserEvent, shouldNotifyBrowserEvent } from '../notifications';
import type { BrowserNotificationOptions, BrowserQuotaProfile } from '../notifications';

export type EventCallback = (event: EventItem) => void;
export type RunOutputCallback = (taskId: string, chunk: string, runId?: string) => void;

const eventListeners = new Set<EventCallback>();
const runOutputListeners = new Set<RunOutputCallback>();
const connectionListeners = new Set<(connected: boolean) => void>();
const runLogs = new Map<string, string>(); // runId -> accumulated log
let isConnected = false;

export function isSSEConnected(): boolean {
  return isConnected;
}

export function subscribeConnectionState(callback: (connected: boolean) => void): () => void {
  connectionListeners.add(callback);
  callback(isConnected);
  return () => {
    connectionListeners.delete(callback);
  };
}

export function getRunLog(runId: string): string {
  return runLogs.get(runId) || '';
}

export function clearRunLogs(): void {
  runLogs.clear();
}

export function subscribeToEvents(callback: EventCallback): () => void {
  eventListeners.add(callback);
  return () => {
    eventListeners.delete(callback);
  };
}

export function subscribeToRunOutput(callback: RunOutputCallback): () => void {
  runOutputListeners.add(callback);
  return () => {
    runOutputListeners.delete(callback);
  };
}

export const INITIAL_RECONNECT_DELAY_MS = 1000;
export const MAX_RECONNECT_DELAY_MS = 30000;

export function getBackoffDelay(attempt: number): number {
  const delay = INITIAL_RECONNECT_DELAY_MS * Math.pow(2, attempt);
  return Math.min(delay, MAX_RECONNECT_DELAY_MS);
}

export function handleRunOutput(
  taskId: string,
  runId: string,
  chunk: string,
  queryClient?: QueryClient,
): void {
  if (runId && chunk) {
    const existing = runLogs.get(runId) || '';
    runLogs.set(runId, existing + chunk);
    if (queryClient) {
      queryClient.setQueryData<string>(['runLog', runId], (prev = '') => prev + chunk);
    }
  }

  if (taskId && chunk && queryClient) {
    queryClient.setQueryData<string>(['taskLog', taskId], (prev = '') => (prev ? prev + chunk : chunk));
    const altTaskId = taskId.includes('/') ? taskId.replace('/', '~') : taskId.replace('~', '/');
    queryClient.setQueryData<string>(['taskLog', altTaskId], (prev = '') => (prev ? prev + chunk : chunk));
  }

  if (taskId && chunk) {
    for (const listener of runOutputListeners) {
      try {
        listener(taskId, chunk, runId);
      } catch {
        // ignore
      }
    }
  }
}

export function connectSSE(queryClient: QueryClient): () => void {
  let eventSource: EventSource | null = null;
  let isClosed = false;
  let reconnectTimeout: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempts = 0;
  let lastEventId: string | null = null;

  function initSSE() {
    if (isClosed) return;

    const token = getToken();
    if (!token) return;

    let sseUrl = `/api/events?token=${encodeURIComponent(token)}`;
    if (lastEventId) {
      sseUrl += `&lastEventId=${encodeURIComponent(lastEventId)}`;
    }
    eventSource = new EventSource(sseUrl);

    eventSource.onopen = () => {
      reconnectAttempts = 0;
      isConnected = true;
      for (const listener of connectionListeners) {
        try {
          listener(true);
        } catch {}
      }
    };

    const handleEventData = (eventName: string, rawData: string, rawLastEventId?: string) => {
      try {
        const parsed = JSON.parse(rawData);
        const type = parsed.type || eventName;
        const taskId = parsed.taskId;

        if (rawLastEventId) {
          lastEventId = rawLastEventId;
        } else if (parsed.id) {
          lastEventId = String(parsed.id);
        }

        // Handle run.output separately for real-time live logs
        if (type === 'run.output' || eventName === 'run.output') {
          const payload = parsed.payload;
          const runId = payload?.runId || parsed.runId || '';
          const chunk = payload?.chunk ?? parsed.data ?? payload?.output ?? '';
          handleRunOutput(taskId || parsed.taskId || '', runId, chunk, queryClient);
          return;
        }

        const rawId = rawLastEventId ? Number(rawLastEventId) : parsed.id;
        const eventId = typeof rawId === 'number' && !isNaN(rawId) ? rawId : Date.now();

        const eventItem: EventItem = {
          id: eventId,
          ts: parsed.ts || new Date().toISOString(),
          type,
          taskId: parsed.taskId || null,
          payload: parsed.payload !== undefined ? parsed.payload : parsed,
        };

        const appConfig = queryClient.getQueryData<{ brain?: { mode?: BrowserNotificationOptions['brainMode'] }; notifications?: { desktop?: boolean; desktopLevel?: 'all' | 'important' | 'critical' | 'off'; quietHours?: BrowserNotificationOptions['quietHours'] } }>(['config']);
        const notificationConfig = appConfig?.notifications;
        const notificationLevel = notificationConfig?.desktopLevel || 'important';
        const profilesData = queryClient.getQueryData<unknown>(['profiles']);
        const profiles = Array.isArray(profilesData)
          ? profilesData
          : profilesData && typeof profilesData === 'object' && Array.isArray((profilesData as { profiles?: unknown }).profiles)
          ? (profilesData as { profiles: unknown[] }).profiles
          : [];
        const notificationOptions: BrowserNotificationOptions = {
          quietHours: notificationConfig?.quietHours,
          brainMode: appConfig?.brain?.mode,
        };
        if (notificationConfig?.desktop !== false && shouldNotifyBrowserEvent(eventItem, notificationLevel, profiles as BrowserQuotaProfile[], notificationOptions)) {
          notifyBrowserEvent(eventItem, notificationLevel, profiles as BrowserQuotaProfile[], notificationOptions);
        }

        // Notify raw event listeners
        for (const listener of eventListeners) {
          try {
            listener(eventItem);
          } catch {
            // ignore listener error
          }
        }

        // Cache invalidation based on event type
        if (type.startsWith('task.')) {
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          queryClient.invalidateQueries({ queryKey: ['status'] });
          if (taskId) {
            queryClient.invalidateQueries({ queryKey: ['task', taskId] });
            queryClient.invalidateQueries({ queryKey: ['task', taskId.replace('/', '~')] });
            if (type === 'task.running') {
              queryClient.invalidateQueries({ queryKey: ['taskLog', taskId] });
              queryClient.invalidateQueries({ queryKey: ['taskLog', taskId.replace('/', '~')] });
            }
          }
        } else if (type.startsWith('run.')) {
          queryClient.invalidateQueries({ queryKey: ['tasks'] });
          queryClient.invalidateQueries({ queryKey: ['status'] });
          if (taskId) {
            queryClient.invalidateQueries({ queryKey: ['task', taskId] });
            queryClient.invalidateQueries({ queryKey: ['task', taskId.replace('/', '~')] });
            if (type !== 'run.output') {
              queryClient.invalidateQueries({ queryKey: ['taskLog', taskId] });
              queryClient.invalidateQueries({ queryKey: ['taskLog', taskId.replace('/', '~')] });
            }
          }
        } else if (type.startsWith('profile.')) {
          queryClient.invalidateQueries({ queryKey: ['profiles'] });
          queryClient.invalidateQueries({ queryKey: ['status'] });
        } else if (type.startsWith('quota.')) {
          queryClient.invalidateQueries({ queryKey: ['profiles'] });
          queryClient.invalidateQueries({ queryKey: ['status'] });
        } else if (type.startsWith('config.')) {
          queryClient.invalidateQueries({ queryKey: ['config'] });
        } else if (type === 'brain.status' || type === 'brain.updated') {
          queryClient.invalidateQueries({ queryKey: ['status'] });
          queryClient.invalidateQueries({ queryKey: ['brain'] });
        } else if (type.startsWith('chat.')) {
          queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
        } else if (type.startsWith('batch.')) {
          queryClient.invalidateQueries({ queryKey: ['batches'] });
        }
      } catch (err) {
        console.error('Lỗi phân tích SSE event:', err);
      }
    };

    eventSource.onmessage = (messageEvent) => {
      handleEventData('message', messageEvent.data, messageEvent.lastEventId);
    };

    const SSE_EVENTS = [
      'run.output',
      'task.queued',
      'task.running',
      'task.checking',
      'task.review_ready',
      'task.blocked',
      'task.waiting_quota',
      'task.done',
      'task.failed',
      'task.cancelled',
      'task.timeout',
      'run.crashed',
      'profile.created',
      'profile.updated',
      'profile.check',
      'quota.exhausted',
      'disk.low',
      'disk.ok',
      'disk.docker_low',
      'brain.notify',
      'ci.failed',
      'review.escalated',
      'quota.cleared',
      'config.updated',
      'brain.status',
      'brain.updated',
      'chat.delta',
      'chat.tool',
      'chat.done',
      'chat.error',
      'chat.permission_request',
      'chat.permission_resolved',
    ];

    for (const evtName of SSE_EVENTS) {
      eventSource.addEventListener(evtName, ((e: MessageEvent) => {
        handleEventData(evtName, e.data, e.lastEventId);
      }) as EventListener);
    }

    eventSource.onerror = () => {
      isConnected = false;
      for (const listener of connectionListeners) {
        try {
          listener(false);
        } catch {}
      }
      if (eventSource) {
        eventSource.close();
        eventSource = null;
      }
      if (!isClosed) {
        const delay = getBackoffDelay(reconnectAttempts);
        reconnectAttempts++;
        reconnectTimeout = setTimeout(initSSE, delay);
      }
    };
  }

  initSSE();

  return () => {
    isClosed = true;
    isConnected = false;
    for (const listener of connectionListeners) {
      try {
        listener(false);
      } catch {}
    }
    if (reconnectTimeout) clearTimeout(reconnectTimeout);
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
