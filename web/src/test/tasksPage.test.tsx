import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { TasksPage } from '../pages/TasksPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Task, Project } from '../types/api';

describe('TasksPage & Kanban Long Lists', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'p1',
    name: 'Project 1',
    path: '/path/1',
    defaultBranch: 'main',
    maxParallel: 2,
  };

  const createDoneTasks = (count: number): Task[] => {
    return Array.from({ length: count }, (_, i) => ({
      id: `p1~task-${i + 1}`,
      projectId: 'p1',
      slug: `slug-${i + 1}`,
      title: `Task Title ${i + 1}`,
      status: 'done' as const,
      level: 'easy' as const,
      dependsOn: [],
      attempt: 1,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: new Date(Date.now() - (count - i) * 1000).toISOString(),
    }));
  };

  beforeEach(() => {
    window.localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject]);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={['/tasks']}>
            <TasksPage />
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('cột 131 task chỉ render 10 thẻ done + nút Xem thêm, bấm thì thêm đúng step', async () => {
    const tasks = createDoneTasks(131);
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    const doneCol = await screen.findByTestId('kanban-column-done');
    expect(doneCol).toHaveTextContent('131');

    // Mặc định cột done chỉ render 10 thẻ
    const linksBefore = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(linksBefore.length).toBe(10);

    // Có nút Xem thêm 20 (còn 121)
    const showMoreBtn = screen.getByRole('button', {
      name: /xem thêm 20 \(còn 121\)/i,
    });
    expect(showMoreBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /thu gọn/i })).not.toBeInTheDocument();

    // Bấm xem thêm
    fireEvent.click(showMoreBtn);

    // Giờ có 30 thẻ
    const linksAfter = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(linksAfter.length).toBe(30);

    // Nút cập nhật thành "Xem thêm 20 (còn 101)" và xuất hiện nút "Thu gọn"
    expect(screen.getByRole('button', { name: /xem thêm 20 \(còn 101\)/i })).toBeInTheDocument();
    const collapseBtn = screen.getByRole('button', { name: /thu gọn/i });
    expect(collapseBtn).toBeInTheDocument();

    // Bấm thu gọn
    fireEvent.click(collapseBtn);
    const linksCollapsed = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(linksCollapsed.length).toBe(10);
    expect(screen.queryByRole('button', { name: /thu gọn/i })).not.toBeInTheDocument();
  });

  it('cột khác mặc định hiển thị 20 thẻ', async () => {
    const queuedTasks: Task[] = Array.from({ length: 25 }, (_, i) => ({
      id: `p1~queued-${i + 1}`,
      projectId: 'p1',
      slug: `queued-${i + 1}`,
      title: `Queued Task ${i + 1}`,
      status: 'queued' as const,
      level: 'easy' as const,
      dependsOn: [],
      attempt: 0,
      resume: 0,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: new Date(Date.now() - (25 - i) * 1000).toISOString(),
    }));
    vi.spyOn(client, 'getTasks').mockResolvedValue(queuedTasks);

    renderPage();

    const queuedCol = await screen.findByTestId('kanban-column-queued');
    expect(queuedCol).toHaveTextContent('25');

    // Mặc định cột queued hiện 20 thẻ
    const links = queuedCol.querySelectorAll('a[href^="/tasks/"]');
    expect(links.length).toBe(20);

    expect(screen.getByRole('button', { name: /xem thêm 5 \(còn 5\)/i })).toBeInTheDocument();
  });

  it('lọc nhanh theo slug và tiêu đề không dấu tiếng Việt', async () => {
    const tasks: Task[] = [
      {
        id: 'p1~viet-slug',
        projectId: 'p1',
        slug: 'viet-slug',
        title: 'Xử lý đăng nhập tài khoản',
        status: 'done' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-16T00:00:00Z',
      },
      {
        id: 'p1~other-slug',
        projectId: 'p1',
        slug: 'other-slug',
        title: 'Cập nhật giao diện người dùng',
        status: 'done' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T00:00:00Z',
        updatedAt: '2026-10-15T00:00:00Z',
      },
    ];
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    await screen.findByTestId('kanban-column-done');
    expect(screen.getByText('Xử lý đăng nhập tài khoản')).toBeInTheDocument();
    expect(screen.getByText('Cập nhật giao diện người dùng')).toBeInTheDocument();

    const filterInput = screen.getByPlaceholderText(/lọc slug \/ tiêu đề/i);

    // Lọc không dấu: "dang nhap" khớp với "đăng nhập"
    fireEvent.change(filterInput, { target: { value: 'dang nhap' } });
    expect(screen.getByText('Xử lý đăng nhập tài khoản')).toBeInTheDocument();
    expect(screen.queryByText('Cập nhật giao diện người dùng')).not.toBeInTheDocument();

    // Lọc theo slug
    fireEvent.change(filterInput, { target: { value: 'other-slug' } });
    expect(screen.queryByText('Xử lý đăng nhập tài khoản')).not.toBeInTheDocument();
    expect(screen.getByText('Cập nhật giao diện người dùng')).toBeInTheDocument();
  });

  it('giữ nguyên badge reviewerEscalated khi có task cần duyệt', async () => {
    const escalatedTask: Task = {
      id: 'p1~t-review',
      projectId: 'p1',
      slug: 't-review',
      title: 'Task Alpha Escalated',
      status: 'review' as const,
      level: 'hard' as const,
      dependsOn: [],
      attempt: 1,
      resume: 0,
      reviewerEscalated: 1,
      createdAt: '2026-10-15T00:00:00Z',
      updatedAt: '2026-10-16T00:00:00Z',
    };
    vi.spyOn(client, 'getTasks').mockResolvedValue([escalatedTask]);

    renderPage();

    await screen.findByTestId('kanban-column-review');
    expect(screen.getByText(/chờ duyệt/i)).toBeInTheDocument();
  });

  it('sắp xếp theo updatedAt giảm dần (mới nhất lên đầu)', async () => {
    const tasks: Task[] = [
      {
        id: 'p1~t-old',
        projectId: 'p1',
        slug: 't-old',
        title: 'Task Cũ',
        status: 'draft' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-10T00:00:00Z',
        updatedAt: '2026-10-10T00:00:00Z',
      },
      {
        id: 'p1~t-new',
        projectId: 'p1',
        slug: 't-new',
        title: 'Task Mới',
        status: 'draft' as const,
        level: 'easy' as const,
        dependsOn: [],
        attempt: 0,
        resume: 0,
        createdAt: '2026-10-10T00:00:00Z',
        updatedAt: '2026-10-18T00:00:00Z',
      },
    ];
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    const draftCol = await screen.findByTestId('kanban-column-draft');
    const titles = Array.from(draftCol.querySelectorAll('h3')).map((el) => el.textContent);
    expect(titles).toEqual(['Task Mới', 'Task Cũ']);
  });

  it('ghi nhớ trạng thái mở rộng trong localStorage', async () => {
    window.localStorage.setItem('agenthub:tasks:done', 'expanded');
    const tasks = createDoneTasks(35);
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    const doneCol = await screen.findByTestId('kanban-column-done');
    const links = doneCol.querySelectorAll('a[href^="/tasks/"]');
    expect(links.length).toBe(35);
    expect(screen.getByRole('button', { name: /thu gọn/i })).toBeInTheDocument();
  });
});
