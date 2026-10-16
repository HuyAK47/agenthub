import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('TaskDetailPage - Invalid time handling', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
  });

  it('không làm sập trang khi run.startedAt chứa chuỗi thời gian không hợp lệ', async () => {
    vi.spyOn(client, 'getTask').mockResolvedValue({
      id: 'p1~t1',
      projectId: 'p1',
      slug: 't1',
      title: 'Task Test Invalid Date',
      body: 'Nội dung task',
      level: 'easy',
      status: 'review',
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-15T00:00:00Z',
      runs: [
        {
          id: 'run-invalid',
          taskId: 'p1~t1',
          engine: 'agy',
          model: 'gemini-3.8-flash-high',
          profileName: 'g1',
          outcome: 'done',
          startedAt: 'invalid-date-xyz',
          endedAt: null,
        },
      ],
      reviews: [],
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/tasks/p1~t1']}>
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>
    );

    // Chờ tiêu đề xuất hiện
    expect(await screen.findByText('Task Test Invalid Date')).toBeInTheDocument();

    // Chuyển sang tab Runs
    const runsTabButton = screen.getByRole('button', { name: /Danh sách runs/i });
    fireEvent.click(runsTabButton);

    // Kiểm tra dòng run hiển thị với chuỗi fallback mà không ném RangeError: Invalid time value
    expect(screen.getByText('invalid-date-xyz')).toBeInTheDocument();
  });
});
