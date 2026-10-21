import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProjectsPage } from '../pages/ProjectsPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { Project } from '../types/api';

describe('ProjectsPage', () => {
  let queryClient: QueryClient;

  const mockProject: Project = {
    id: 'proj-1',
    name: 'XFarm',
    path: '/home/user/projects/xfarm',
    defaultBranch: 'main',
    maxParallel: 3,
    envTemplate: null,
    checks: null,
  };

  beforeEach(() => {
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

  function renderPage(initialEntries = ['/projects']) {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <MemoryRouter initialEntries={initialEntries}>
            <ProjectsPage />
          </MemoryRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Đăng ký project thành công và gọi createProject với các giá trị hợp lệ', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({
      id: 'proj-2',
      name: 'AgentHub',
      path: '/home/user/projects/agenthub',
      defaultBranch: 'main',
      maxParallel: 3,
      envTemplate: null,
      checks: null,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    // Chờ danh sách load
    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    // Mở form đăng ký
    const registerBtn = screen.getByRole('button', { name: /Đăng ký project/i });
    fireEvent.click(registerBtn);

    expect(screen.getByRole('heading', { name: /Đăng ký Project mới/i })).toBeInTheDocument();

    // Điền thông tin
    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'AgentHub' },
    });
    fireEvent.change(screen.getByPlaceholderText('vd: /home/user/projects/xfarm'), {
      target: { value: '/home/user/projects/agenthub' },
    });

    // Submit form
    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith(
      {
        name: 'AgentHub',
        path: '/home/user/projects/agenthub',
        defaultBranch: 'main',
        maxParallel: 3,
        envTemplate: null,
        checks: null,
      },
      expect.anything(),
    );

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['projects'] });
    // Form đóng lại
    expect(screen.queryByRole('heading', { name: /Đăng ký Project mới/i })).not.toBeInTheDocument();
  });

  it('2. envTemplate JSON sai cú pháp thì hiện lỗi validation và vô hiệu hóa nút submit', async () => {
    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Đăng ký project/i }));

    const envTextarea = screen.getByTestId('env-template-textarea');
    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });

    // Nhập JSON không hợp lệ
    fireEvent.change(envTextarea, {
      target: { value: '{"PORT": 3000, }' },
    });

    const errorMsg = screen.getByTestId('json-error-msg');
    expect(errorMsg).toBeInTheDocument();
    expect(errorMsg).toHaveTextContent(/JSON không hợp lệ/i);
    expect(saveBtn).toBeDisabled();

    // Nhập lại JSON hợp lệ
    fireEvent.change(envTextarea, {
      target: { value: '{"PORT": 3000}' },
    });

    expect(screen.queryByTestId('json-error-msg')).not.toBeInTheDocument();
    expect(screen.getByText(/JSON hợp lệ/i)).toBeInTheDocument();
    expect(saveBtn).toBeEnabled();
  });

  it('3. Sửa maxParallel trong form đăng ký project và submit giá trị mới', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({
      id: 'proj-3',
      name: 'HighConcurrency',
      path: '/path/parallel',
      defaultBranch: 'main',
      maxParallel: 6,
      envTemplate: null,
      checks: null,
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Đăng ký project/i }));

    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'HighConcurrency' },
    });
    fireEvent.change(screen.getByPlaceholderText('vd: /home/user/projects/xfarm'), {
      target: { value: '/path/parallel' },
    });

    // Thay đổi maxParallel sang 6
    const maxParallelInput = screen.getByRole('spinbutton');
    fireEvent.change(maxParallelInput, { target: { value: '6' } });

    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    expect(createSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'HighConcurrency',
        maxParallel: 6,
      }),
      expect.anything(),
    );
  });

  it('4. Bấm nút xóa project có xác nhận window.confirm và gọi deleteProject', async () => {
    const deleteSpy = vi.spyOn(client, 'deleteProject').mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    const deleteBtn = screen.getByTitle(/Xóa project/i);
    await act(async () => {
      fireEvent.click(deleteBtn);
      await Promise.resolve();
    });

    expect(window.confirm).toHaveBeenCalled();
    expect(deleteSpy).toHaveBeenCalledWith('proj-1', expect.anything());
  });

  it('5. Sửa checks tùy chỉnh trên project đã có và lưu thành công', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue({
      ...mockProject,
      checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    // The checks textarea sits next to its "Lưu checks" button (other textareas follow it, e.g. review chain)
    const cardChecksTextarea = screen.getByRole('button', { name: /Lưu checks/i }).parentElement!.querySelector('textarea')!;

    fireEvent.change(cardChecksTextarea, {
      target: { value: '[{"name":"lint","cmd":["npm","run","lint"]}]' },
    });

    const saveChecksBtn = screen.getByRole('button', { name: /Lưu checks/i });
    await act(async () => {
      fireEvent.click(saveChecksBtn);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1', {
      checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'] }],
    });
  });

  it('6. Sửa hooks trên project đã có và lưu thành công', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue({
      ...mockProject,
      hooks: { onWorktreeRemoved: ['docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"'] },
    });

    renderPage();

    expect(await screen.findByText('XFarm')).toBeInTheDocument();

    const textboxes = screen.getAllByRole('textbox');
    // In project card, first textbox is hooks
    const cardHooksTextarea = textboxes[0];

    fireEvent.change(cardHooksTextarea, {
      target: {
        value: 'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"\ndocker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_mt_{slug_underscored}"',
      },
    });

    const saveHooksBtn = screen.getByRole('button', { name: /Lưu hooks/i });
    await act(async () => {
      fireEvent.click(saveHooksBtn);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('proj-1', {
      hooks: {
        onWorktreeRemoved: [
          'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_t_{slug_underscored}"',
          'docker exec xfarm_postgres psql -U xfarm -d postgres -c "DROP DATABASE IF EXISTS xfarm_mt_{slug_underscored}"',
        ],
      },
    });
  });

  it('7. Trang Project trống: hiển thị khối hướng dẫn với 3 bước và nút mở form', async () => {
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);

    renderPage();

    expect(await screen.findByTestId('projects-empty-guide')).toBeInTheDocument();
    expect(screen.getByText('Bắt đầu với Project đầu tiên')).toBeInTheDocument();
    expect(screen.getByText(/Project là một repo git trên máy này/)).toBeInTheDocument();
    expect(screen.getByText(/Clone repo về máy/)).toBeInTheDocument();
    expect(screen.getByText(/Bấm "Đăng ký Project"/)).toBeInTheDocument();
    expect(screen.getByText(/Giao việc bằng \/newtask/)).toBeInTheDocument();

    // Nút "Đăng ký project đầu tiên" mở form
    const firstRegBtn = screen.getByRole('button', { name: /Đăng ký project đầu tiên/i });
    expect(firstRegBtn).toBeInTheDocument();

    fireEvent.click(firstRegBtn);
    expect(screen.getByRole('heading', { name: /Đăng ký Project mới/i })).toBeInTheDocument();
  });

  it('8. URL param ?new=1 tự động mở form đăng ký', async () => {
    renderPage(['/projects?new=1']);

    expect(await screen.findByRole('heading', { name: /Đăng ký Project mới/i })).toBeInTheDocument();
  });

  it('9. Form đăng ký có các gợi ý trường và mục Nâng cao thu gọn mặc định', async () => {
    renderPage(['/projects?new=1']);

    expect(await screen.findByRole('heading', { name: /Đăng ký Project mới/i })).toBeInTheDocument();

    // Gợi ý các trường
    expect(screen.getByText('Tên hiển thị, hệ thống sẽ tự động tạo ID dự án')).toBeInTheDocument();
    expect(screen.getByText('Thư mục gốc repo git, đường dẫn tuyệt đối')).toBeInTheDocument();
    expect(screen.getByText('Nhánh worker tách ra và merge về')).toBeInTheDocument();
    expect(screen.getByText('Số lượng task tối đa chạy song song trên project này')).toBeInTheDocument();

    // Mục Nâng cao thu gọn mặc định
    const advancedDetails = screen.getByTestId('advanced-section');
    expect(advancedDetails).toBeInTheDocument();
    expect(advancedDetails).not.toHaveAttribute('open');

    // Mở mục nâng cao
    const summary = advancedDetails.querySelector('summary')!;
    expect(summary).toHaveTextContent('Nâng cao');
    fireEvent.click(summary);

    expect(screen.getByText(/Tuỳ chọn, ví dụ cổng\/DB riêng cho mỗi worktree/)).toBeInTheDocument();
  });

  it('10. Form đăng ký hiển thị lỗi trả về từ server khi thất bại', async () => {
    vi.spyOn(client, 'createProject').mockRejectedValue(new Error('Đường dẫn repo phải là đường dẫn tuyệt đối: relative/path'));

    renderPage(['/projects?new=1']);

    await screen.findByRole('heading', { name: /Đăng ký Project mới/i });

    fireEvent.change(screen.getByPlaceholderText('vd: XFarm, AgentHub'), {
      target: { value: 'MyProject' },
    });
    fireEvent.change(screen.getByPlaceholderText('vd: /home/user/projects/xfarm'), {
      target: { value: 'relative/path' },
    });

    const saveBtn = screen.getByRole('button', { name: /Lưu Project/i });
    await act(async () => {
      fireEvent.click(saveBtn);
      await Promise.resolve();
    });

    const formError = await screen.findByTestId('form-error-msg');
    expect(formError).toBeInTheDocument();
    expect(formError).toHaveTextContent('Đường dẫn repo phải là đường dẫn tuyệt đối: relative/path');
  });

  it('11. Lưu settings project gửi đúng section thay đổi', async () => {
    const updateSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
    renderPage();
    await screen.findByText('XFarm');
    fireEvent.click(screen.getByRole('button', { name: 'Cài đặt' }));
    const mode = screen.getAllByRole('combobox')[0];
    fireEvent.change(mode, { target: { value: 'external' } });
    fireEvent.click(screen.getByRole('button', { name: 'Lưu cài đặt' }));
    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('proj-1', { settings: { brain: { mode: 'external' } } }));
  });
});
