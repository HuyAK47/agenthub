import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { WaitingQueue } from '../components/WaitingQueue';
import { Task } from '../types/api';

describe('WaitingQueue Component', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
  });

  it('hiển thị trạng thái rỗng khi không có task chờ', () => {
    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <WaitingQueue tasks={[]} />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByTestId('waiting-queue')).toBeInTheDocument();
    expect(screen.getByTestId('waiting-queue-empty')).toHaveTextContent('Không có task nào đang chờ.');
    expect(screen.getByTestId('waiting-queue-count')).toHaveTextContent('0 task đang chờ');
  });

  it('hiển thị danh sách task chờ kèm nhãn waitReason tương ứng', () => {
    const now = new Date().toISOString();
    const mockTasks: Task[] = [
      {
        id: 'Proj/t-disk',
        projectId: 'Proj',
        slug: 't-disk',
        title: 'Task thiếu ổ đĩa',
        status: 'waiting_quota',
        waitReason: 'disk',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        level: 'easy',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'Proj/t-quota',
        projectId: 'Proj',
        slug: 't-quota',
        title: 'Task chờ quota',
        status: 'waiting_quota',
        waitReason: 'quota',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        level: 'easy',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'Proj/t-parallel',
        projectId: 'Proj',
        slug: 't-parallel',
        title: 'Task chờ slot song song',
        status: 'waiting_quota',
        waitReason: 'parallel',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        level: 'easy',
        createdAt: now,
        updatedAt: now,
      },
      {
        id: 'Proj/t-profile',
        projectId: 'Proj',
        slug: 't-profile',
        title: 'Task chờ tài khoản rảnh',
        status: 'waiting_quota',
        waitReason: 'profile_busy',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        level: 'easy',
        createdAt: now,
        updatedAt: now,
      },
    ];

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <WaitingQueue tasks={mockTasks} diskFreeGB={1.8} diskMinFreeGB={5} />
        </BrowserRouter>
      </QueryClientProvider>
    );

    expect(screen.getByTestId('waiting-queue-count')).toHaveTextContent('4 task đang chờ');

    // Kiểm tra từng task và nhãn lý do chờ
    expect(screen.getByText('Task thiếu ổ đĩa')).toBeInTheDocument();
    expect(screen.getByText('Chờ ổ đĩa (còn 1.8 GB / cần 5 GB)')).toBeInTheDocument();

    expect(screen.getByText('Task chờ quota')).toBeInTheDocument();
    expect(screen.getByText('Chờ quota model')).toBeInTheDocument();

    expect(screen.getByText('Task chờ slot song song')).toBeInTheDocument();
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();

    expect(screen.getByText('Task chờ tài khoản rảnh')).toBeInTheDocument();
    expect(screen.getByText('Chờ tài khoản rảnh')).toBeInTheDocument();
  });
});
