import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
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

  it('chuyển sang chế độ theo project và ghi nhớ lựa chọn', async () => {
    vi.spyOn(client, 'getTasks').mockResolvedValue(createDoneTasks(1));

    renderPage();

    fireEvent.click(screen.getByTestId('view-toggle-project'));

    expect(await screen.findByTestId('project-view-wrapper')).toBeInTheDocument();
    expect(screen.getByTestId('project-task-group-p1')).toBeInTheDocument();
    expect(window.localStorage.getItem('agenthub:tasks:view-mode')).toBe('project');
  });

  it('thu gọn và mở lại nhóm project, đồng thời đếm đúng trạng thái', async () => {
    const tasks: Task[] = [
      { ...createDoneTasks(1)[0], id: 'p1~running', slug: 'running', title: 'Running task', status: 'running' },
      { ...createDoneTasks(1)[0], id: 'p1~checking', slug: 'checking', title: 'Checking task', status: 'checking' },
      { ...createDoneTasks(1)[0], id: 'p1~review', slug: 'review', title: 'Review task', status: 'review' },
      { ...createDoneTasks(1)[0], id: 'p1~blocked', slug: 'blocked', title: 'Blocked task', status: 'blocked' },
      { ...createDoneTasks(1)[0], id: 'p1~queued', slug: 'queued', title: 'Queued task', status: 'queued' },
      { ...createDoneTasks(1)[0], id: 'p1~quota', slug: 'quota', title: 'Quota task', status: 'waiting_quota' },
    ];
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    fireEvent.click(screen.getByTestId('view-toggle-project'));
    const group = await screen.findByTestId('project-task-group-p1');
    expect(within(group).getByLabelText('Số task theo trạng thái')).toHaveTextContent('Đang chạy: 1');
    expect(within(group).getByLabelText('Số task theo trạng thái')).toHaveTextContent('Đang kiểm tra: 1');
    expect(within(group).getByLabelText('Số task theo trạng thái')).toHaveTextContent('Chờ duyệt: 1');
    expect(within(group).getByLabelText('Số task theo trạng thái')).toHaveTextContent('Bị chặn: 1');
    expect(within(group).getByLabelText('Số task theo trạng thái')).toHaveTextContent('Chờ: 2');

    const toggle = group.querySelector('button[aria-expanded]') as HTMLButtonElement;
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(within(group).queryByText('Running task')).not.toBeInTheDocument();
    fireEvent.click(toggle);
    expect(within(group).getByText('Running task')).toBeInTheDocument();
  });

  it('lọc được đồng thời nhiều project bằng các chip project', async () => {
    const secondProject: Project = { ...mockProject, id: 'p2', name: 'Project 2' };
    vi.spyOn(client, 'getProjects').mockResolvedValue([mockProject, secondProject]);
    vi.spyOn(client, 'getTasks').mockResolvedValue([
      { ...createDoneTasks(1)[0], id: 'p1~one', slug: 'one', title: 'Task one' },
      { ...createDoneTasks(1)[0], id: 'p2~two', projectId: 'p2', slug: 'two', title: 'Task two' },
    ]);

    renderPage();

    fireEvent.click(screen.getByTestId('view-toggle-project'));
    await screen.findByTestId('project-task-group-p1');
    const projectFilter = (name: string) => screen.getAllByRole('button', { name }).find((button) => !button.hasAttribute('aria-expanded')) as HTMLButtonElement;
    fireEvent.click(projectFilter('Project 1'));
    fireEvent.click(projectFilter('Project 2'));

    expect(screen.getByTestId('project-task-group-p1')).toBeInTheDocument();
    expect(screen.getByTestId('project-task-group-p2')).toBeInTheDocument();
    expect(screen.getByText('Task one')).toBeInTheDocument();
    expect(screen.getByText('Task two')).toBeInTheDocument();
  });

  it('giới hạn task trong nhóm project dài và cho xem thêm theo từng bước', async () => {
    const tasks = createDoneTasks(45);
    vi.spyOn(client, 'getTasks').mockResolvedValue(tasks);

    renderPage();

    fireEvent.click(screen.getByTestId('view-toggle-project'));
    const group = await screen.findByTestId('project-task-group-p1');
    expect(group.querySelectorAll('a[href^="/tasks/"]').length).toBe(20);
    expect(within(group).getByRole('button', { name: /xem thêm 20 \(còn 25\)/i })).toBeInTheDocument();

    fireEvent.click(within(group).getByRole('button', { name: /xem thêm 20 \(còn 25\)/i }));
    expect(group.querySelectorAll('a[href^="/tasks/"]').length).toBe(40);
  });

  it('áp dụng bộ lọc nhanh slug/tiêu đề trong chế độ theo project', async () => {
    vi.spyOn(client, 'getTasks').mockResolvedValue([
      { ...createDoneTasks(1)[0], id: 'p1~matching', slug: 'matching-task', title: 'Matching task' },
      { ...createDoneTasks(1)[0], id: 'p1~other', slug: 'other-task', title: 'Other task' },
    ]);

    renderPage();

    fireEvent.click(screen.getByTestId('view-toggle-project'));
    const group = await screen.findByTestId('project-task-group-p1');
    fireEvent.change(screen.getByRole('textbox', { name: /lọc slug \/ tiêu đề/i }), { target: { value: 'matching' } });

    expect(within(group).getByText('Matching task')).toBeInTheDocument();
    expect(within(group).queryByText('Other task')).not.toBeInTheDocument();
  });
});
