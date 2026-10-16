import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import {
  getConfig,
  updateConfig,
  startTask,
  reviewTask,
  retryTask,
  setToken,
  clearToken,
  apiFetch,
} from '../api/client';
import { isMockEnabled } from '../mocks/browser';
import { connectSSE, subscribeToRunOutput } from '../api/sse';
import { Task } from '../types/api';

describe('Contract Alignment Tests', () => {
  const originalFetch = window.fetch;

  beforeEach(() => {
    sessionStorage.clear();
    setToken('test_token_contract_123');
  });

  afterEach(() => {
    window.fetch = originalFetch;
    clearToken();
    vi.restoreAllMocks();
  });

  it('1. startTask / reviewTask / retryTask trả về đối tượng Task hoàn chỉnh thay vì { ok: true }', async () => {
    const mockTask: Task = {
      id: 'agenthub/task-1',
      projectId: 'agenthub',
      slug: 'task-1',
      title: 'Task số 1',
      level: 'easy',
      status: 'queued',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
    };

    window.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/start')) {
        return new Response(JSON.stringify(mockTask), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/review')) {
        return new Response(JSON.stringify({ ...mockTask, status: 'done' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (url.includes('/retry')) {
        return new Response(JSON.stringify({ ...mockTask, attempt: 1 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(null, { status: 404 });
    });

    const startRes = await startTask('agenthub~task-1');
    expect(startRes.id).toBe('agenthub/task-1');
    expect(startRes.status).toBe('queued');

    const reviewRes = await reviewTask('agenthub~task-1', { verdict: 'approved' });
    expect(reviewRes.status).toBe('done');

    const retryRes = await retryTask('agenthub~task-1', { note: 'retry prompt' });
    expect(retryRes.attempt).toBe(1);
  });

  it('2. getConfig và updateConfig gửi và nhận schema phẳng (modelChainHard, modelChainEasy, defaultTimeout)', async () => {
    const serverConfig = {
      modelChainHard: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna'],
      modelChainEasy: ['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna'],
      defaultTimeout: 10800,
    };

    let sentBody: any = null;
    window.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        sentBody = JSON.parse(init.body as string);
        return new Response(JSON.stringify(sentBody), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      return new Response(JSON.stringify(serverConfig), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const config = await getConfig();
    expect(config.modelChainHard).toEqual(['gemini-3.8-flash-high', 'codex:gpt-5.6-luna']);
    expect(config.modelChainEasy).toEqual(['gemini-3.8-flash-medium', 'codex:gpt-5.6-luna']);
    expect(config.defaultTimeout).toBe(10800);

    const updated = await updateConfig({
      modelChainHard: ['claude-opus-4-6-thinking'],
      modelChainEasy: ['gemini-3.8-flash-low'],
      defaultTimeout: 7200,
    });

    expect(sentBody).toMatchObject({
      modelChainHard: ['claude-opus-4-6-thinking'],
      modelChainEasy: ['gemini-3.8-flash-low'],
      defaultTimeout: 7200,
    });
    expect(updated.defaultTimeout).toBe(7200);
  });

  it('3. apiFetch ưu tiên trích xuất errJson.message từ phản hồi lỗi của server Fastify', async () => {
    window.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          error: 'conflict',
          message: 'Không thể xóa project khi còn task đang chạy',
        }),
        {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    await expect(apiFetch('/api/projects/xfarm', { method: 'DELETE' })).rejects.toThrow(
      'Không thể xóa project khi còn task đang chạy',
    );
  });

  it('4. isMockEnabled không cho phép bật mock bằng ?mock=1 trên bản build chính thức (!DEV và !VITE_MOCK)', () => {
    // In test environment, import.meta.env.DEV might be true or false.
    // We verify the function behavior when DEV is false and VITE_MOCK is not '1'.
    const origDev = import.meta.env.DEV;
    const origViteMock = import.meta.env.VITE_MOCK;

    try {
      // Simulate production build without VITE_MOCK
      (import.meta.env as any).DEV = false;
      (import.meta.env as any).VITE_MOCK = '0';

      // Even if location has ?mock=1
      window.history.replaceState(null, '', '/?mock=1');
      expect(isMockEnabled()).toBe(false);

      // Only if VITE_MOCK === '1'
      (import.meta.env as any).VITE_MOCK = '1';
      expect(isMockEnabled()).toBe(true);
    } finally {
      (import.meta.env as any).DEV = origDev;
      (import.meta.env as any).VITE_MOCK = origViteMock;
      window.history.replaceState(null, '', '/');
    }
  });

  it('5. connectSSE xử lý sự kiện run.output với trường data từ backend thật', () => {
    let outputReceived: { taskId: string; chunk: string } | null = null;
    const unsubOutput = subscribeToRunOutput((taskId, chunk) => {
      outputReceived = { taskId, chunk };
    });

    const eventListenersMap: Record<string, ((e: any) => void)[]> = {};
    class MockEventSource {
      constructor(public url: string) {}
      addEventListener(type: string, listener: any) {
        if (!eventListenersMap[type]) eventListenersMap[type] = [];
        eventListenersMap[type].push(listener);
      }
      close() {}
    }
    const origEventSource = window.EventSource;
    (window as any).EventSource = MockEventSource;

    try {
      const queryClient = new QueryClient();
      const cleanup = connectSSE(queryClient);

      const listener = eventListenersMap['run.output']?.[0];
      expect(listener).toBeDefined();

      // Backend sends { runId, taskId, data: chunk }
      listener({
        data: JSON.stringify({
          runId: 'run-123',
          taskId: 'agenthub/task-1',
          data: 'Chunk log từ worker agy\n',
        }),
      });

      expect(outputReceived).toEqual({
        taskId: 'agenthub/task-1',
        chunk: 'Chunk log từ worker agy\n',
      });

      cleanup();
    } finally {
      unsubOutput();
      (window as any).EventSource = origEventSource;
    }
  });
});
