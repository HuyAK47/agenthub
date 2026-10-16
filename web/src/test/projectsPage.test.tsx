import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
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
    path: '/home/ducanh/projects/xfarm',
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

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <BrowserRouter>
            <ProjectsPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Đăng ký project thành công và gọi createProject với các giá trị hợp lệ', async () => {
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue({
      id: 'proj-2',
      name: 'AgentHub',
      path: '/home/ducanh/projects/agenthub',
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
    fireEvent.change(screen.getByPlaceholderText('vd: /home/ducanh/projects/xfarm'), {
      target: { value: '/home/ducanh/projects/agenthub' },
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
        path: '/home/ducanh/projects/agenthub',
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
    fireEvent.change(screen.getByPlaceholderText('vd: /home/ducanh/projects/xfarm'), {
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

    const checksInputs = screen.getAllByRole('textbox');
    // In project card, the textarea for checks
    const cardChecksTextarea = checksInputs[checksInputs.length - 1];

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
});
