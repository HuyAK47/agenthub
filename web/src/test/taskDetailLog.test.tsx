import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { TaskDetail } from '../types/api';

describe('TaskDetailPage - Live log of running task', () => {
  let queryClient: QueryClient;
  let runOutputListener: sse.RunOutputCallback | null = null;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation((cb) => {
      runOutputListener = cb;
      return () => {
        runOutputListener = null;
      };
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fetches initial log and appends real-time chunks from running slow engine', async () => {
    const mockTask: TaskDetail = {
      id: 'demo/task-slow',
      projectId: 'demo',
      slug: 'task-slow',
      title: 'Tác vụ chạy lâu',
      level: 'easy',
      status: 'running',
      dependsOn: '[]',
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T08:00:00Z',
      updatedAt: '2026-10-15T08:00:00Z',
      runs: [],
      reviews: [],
    };

    vi.spyOn(client, 'getTask').mockResolvedValue(mockTask);
    vi.spyOn(client, 'getTaskLog').mockResolvedValue('Fake agent: starting...\n');

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/demo~task-slow']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Initial log displayed
    expect(await screen.findByText(/Fake agent: starting\.\.\./)).toBeInTheDocument();

    // Verify subscriber was registered
    expect(runOutputListener).not.toBeNull();

    // Simulate SSE run.output event from slow mode fake engine
    act(() => {
      runOutputListener!('demo/task-slow', 'Fake agent: working slowly...\n', 'run-1');
    });

    // Check that terminal has updated and contains the new live log
    expect(screen.getByText(/Fake agent: working slowly\.\.\./)).toBeInTheDocument();
  });
});
