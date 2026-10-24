import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ProjectWizard } from '../components/ProjectWizard';
import * as client from '../api/client';

const project = { id: 'new-project', name: 'New Project', path: '/tmp/new-project', defaultBranch: 'main', maxParallel: 3, envTemplate: null, checks: null };
const inspection = {
  path: '/media/project', exists: true, isDirectory: true, isGitRepo: true,
  currentBranch: 'main', branches: ['main', 'feature'], remoteHost: 'github.com',
  estimatedSizeBytes: 10, sizeTruncated: false, lockfiles: ['package-lock.json'],
  monorepo: { detected: false, type: null }, gitHooks: { husky: true, commitlint: false },
  language: 'JavaScript/TypeScript', projectFiles: ['package.json'], guidanceFiles: [],
  mount: { mountpoint: '/media', temporary: false, encrypted: true },
  claudeSessions: [{ name: 'session-a.jsonl', modifiedAt: '2026-10-22T00:00:00.000Z', sizeBytes: 1024 }],
  claudeSessionPreviews: [{ name: 'session-a.jsonl', content: 'Use pnpm and keep API stable.' }],
  hasClaudeMemory: true, memoryPreview: 'Use the project conventions.',
  suggestedSettings: {
    skipInstall: true, skipGitHooks: true, sensitiveProject: true,
    checks: [{ name: 'lint', cmd: ['npm', 'run', 'lint'], reason: 'package.json có script lint' }],
  },
};

function renderWizard(props?: { onClose?: () => void; summaryTimeoutMs?: number }) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale="vi">
        <ProjectWizard onClose={props?.onClose || vi.fn()} summaryTimeoutMs={props?.summaryTimeoutMs} />
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('ProjectWizard', () => {
  beforeEach(() => { localStorage.clear(); vi.restoreAllMocks(); });

  it('new mode skips inspect and sends selected settings', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject');
    const createSpy = vi.spyOn(client, 'createNewProject').mockResolvedValue(project);
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: /Dự án mới/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'New Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/tmp/new-project' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    for (let step = 0; step < 4; step += 1) fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(inspectSpy).not.toHaveBeenCalled();
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({ name: 'New Project', path: '/tmp/new-project', defaultBranch: 'main', settings: expect.objectContaining({ worktree: { install: 'auto', gitHooks: 'run' } }) }));
  });

  it('restores the draft fields from localStorage', () => {
    localStorage.setItem('agenthub.projectWizard', JSON.stringify({ name: 'Restored', path: '/tmp/restored', mode: 'existing' }));
    renderWizard();
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    expect(screen.getByDisplayValue('Restored')).toBeInTheDocument();
    expect(screen.getByDisplayValue('/tmp/restored')).toBeInTheDocument();
  });

  it('renders sensitive suggestion and reason for removable media even when unencrypted', async () => {
    const plainMediaInspection = {
      ...inspection,
      path: '/media/usb-drive/repo',
      mount: { mountpoint: '/media/usb-drive', temporary: false, encrypted: false },
    };
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(plainMediaInspection);
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Media Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/media/usb-drive/repo' } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith('/media/usb-drive/repo'));

    // Advance to suggestions step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    expect(screen.getByText(/Đánh dấu dự án nhạy cảm/i)).toBeInTheDocument();
    expect(screen.getByText(/Repo nằm trên thiết bị lưu trữ ngoài/i)).toBeInTheDocument();
  });

  it('offers an AGENTS.md draft when the repository only has CLAUDE.md guidance', async () => {
    const guidanceInspection = { ...inspection, guidanceFiles: ['CLAUDE.md'] };
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(guidanceInspection);
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Guidance project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: guidanceInspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(guidanceInspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    expect(screen.getByRole('checkbox', { name: /Tạo bản nháp AGENTS/i })).toBeInTheDocument();
  });

  it('summarization flow: displays progress, presents summary for review, and only pins transcript knowledge after user approval', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    const knowledgeSpy = vi.spyOn(client, 'addProjectKnowledge').mockResolvedValue({
      id: 1,
      projectId: project.id,
      taskId: 'manual/new-project',
      content: 'pinned',
      createdAt: '',
      pinned: 1,
    });
    const summarizeSpy = vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-123',
      status: 'ready',
      summary: '# Durable Knowledge from Sessions\n- Important architectural rule',
    });

    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Context project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    // Suggestions step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Context step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Select session and approve
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    // Brain step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Summary step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Create
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Verifies progress is displayed
    await waitFor(() => expect(summarizeSpy).toHaveBeenCalledWith(project.id, { sessions: ['session-a.jsonl'] }));
    // Verifies review screen is displayed with summary content
    await waitFor(() => expect(screen.getByText(/Duyệt kiến thức tóm tắt từ ngữ cảnh cũ/i)).toBeInTheDocument());
    expect(screen.getByDisplayValue(/# Durable Knowledge from Sessions/)).toBeInTheDocument();

    // Transcript knowledge is NOT yet pinned before user approval
    expect(knowledgeSpy).not.toHaveBeenCalledWith(project.id, expect.objectContaining({ content: expect.stringContaining('# Durable Knowledge') }));

    // User approves and pins
    fireEvent.click(screen.getByRole('button', { name: 'Duyệt và ghim kiến thức' }));

    // Now addProjectKnowledge is called with the summarized transcript knowledge
    await waitFor(() => {
      expect(knowledgeSpy).toHaveBeenCalledWith(
        project.id,
        expect.objectContaining({
          content: expect.stringContaining('# Durable Knowledge from Sessions'),
          pinned: true,
        }),
      );
    });
  });

  it('summarization flow: skips pinning transcript knowledge when user chooses to skip', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    const knowledgeSpy = vi.spyOn(client, 'addProjectKnowledge').mockResolvedValue({
      id: 1,
      projectId: project.id,
      taskId: 'manual/new-project',
      content: 'pinned',
      createdAt: '',
      pinned: 1,
    });
    vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-123',
      status: 'ready',
      summary: '# Knowledge to skip',
    });

    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Skip project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    // Advance to context step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    // Advance to summary step and create
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    await waitFor(() => expect(screen.getByText(/Duyệt kiến thức tóm tắt từ ngữ cảnh cũ/i)).toBeInTheDocument());

    // User skips pinning
    fireEvent.click(screen.getByRole('button', { name: 'Bỏ qua, không ghim' }));

    // Knowledge was NOT pinned with summary
    expect(knowledgeSpy).not.toHaveBeenCalledWith(project.id, expect.objectContaining({ content: expect.stringContaining('# Knowledge to skip') }));
  });

  it('inspects existing repos, lets the user approve context, and sends the full settings payload', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue(project);
    const knowledgeSpy = vi.spyOn(client, 'addProjectKnowledge').mockResolvedValue({ id: 1, projectId: project.id, taskId: 'manual/new-project', content: inspection.memoryPreview, createdAt: '', pinned: 1 });
    const guidanceSpy = vi.spyOn(client, 'writeProjectGuidance').mockResolvedValue({ ok: true });
    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Sensitive project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getAllByRole('checkbox', { name: /lint/i }).at(-1)!);
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tạo bản nháp AGENTS/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã xem và duyệt ghi AGENTS/i }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Bản nháp AGENTS.md' }), { target: { value: '# Approved guidance' } });
    fireEvent.click(screen.getByRole('checkbox', { name: /Ghim nội dung MEMORY/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    await waitFor(() => expect(createSpy).toHaveBeenCalled());
    expect(createSpy).toHaveBeenCalledWith(expect.objectContaining({
      settings: expect.objectContaining({
        worktree: expect.objectContaining({ logsInRoot: true, root: '/media/.agenthub-worktrees', install: 'skip', gitHooks: 'skip' }),
        notifications: { telegramContent: 'minimal' },
        brain: expect.objectContaining({ permissions: 'standard' }),
        integration: expect.objectContaining({ enabled: true, baseRef: 'main' }),
      }),
    }));
    await waitFor(() => expect(knowledgeSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({ pinned: true, content: inspection.memoryPreview })));
    expect(guidanceSpy).toHaveBeenCalledWith(project.id, '# Approved guidance');
  });

  it('handles API error on summarization gracefully without blocking project creation, sanitizes stack traces, and allows retry', async () => {
    const onClose = vi.fn();
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    const createSpy = vi.spyOn(client, 'createProject').mockResolvedValue(project);
    const summarizeSpy = vi.spyOn(client, 'summarizeProjectContext')
      .mockRejectedValueOnce(new Error('Internal Server Error 500\n    at Object.apiFetch (/src/client.ts:182:10)\n    at processTicksAndRejections'))
      .mockResolvedValueOnce({ taskId: 'task-retry', status: 'ready', summary: '# Retried Summary' });

    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'API Error Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    // Suggestions step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Context step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    // Brain step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Summary step
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    // Create
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Project creation succeeded
    await waitFor(() => expect(createSpy).toHaveBeenCalled());

    // Summary failed with API error -> renders wizard-summary-error
    await waitFor(() => expect(screen.getByTestId('wizard-summary-error')).toBeInTheDocument());
    expect(screen.getByText('Lỗi')).toBeInTheDocument();
    expect(screen.getByText('Dự án đã được tạo thành công.')).toBeInTheDocument();

    // Verify error is sanitized without stack trace
    expect(screen.getByText('Internal Server Error 500')).toBeInTheDocument();
    expect(screen.queryByText(/at Object\.apiFetch/)).not.toBeInTheDocument();

    // Has Retry button and Background button
    const retryBtn = screen.getByRole('button', { name: 'Thử lại' });
    const bgBtn = screen.getByRole('button', { name: 'Chạy nền và đóng' });
    expect(retryBtn).toBeInTheDocument();
    expect(bgBtn).toBeInTheDocument();

    // Click retry
    fireEvent.click(retryBtn);

    // Second summarize call is made and transitions to review screen
    await waitFor(() => expect(summarizeSpy).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTestId('wizard-summary-review')).toBeInTheDocument());
    expect(screen.getByDisplayValue(/# Retried Summary/)).toBeInTheDocument();
  });

  it('handles missing engine or quota status without blocking and allows running in background', async () => {
    const onClose = vi.fn();
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-quota',
      status: 'waiting_quota',
      summary: null,
    });
    vi.spyOn(client, 'getProjectContextSummary').mockResolvedValue({
      taskId: 'task-quota',
      status: 'waiting_quota',
      summary: null,
    });

    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Quota Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Shows summarizing state with running badge and waiting quota notice
    await waitFor(() => expect(screen.getByTestId('wizard-summarizing')).toBeInTheDocument());
    expect(screen.getByText('Đang chạy')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Đang chờ engine AI khả dụng hoặc hạn ngạch...')).toBeInTheDocument());

    // User can click "Chạy nền và đóng" so project creation is not blocked
    const bgBtn = screen.getByRole('button', { name: 'Chạy nền và đóng' });
    expect(bgBtn).toBeInTheDocument();
    fireEvent.click(bgBtn);
    expect(onClose).toHaveBeenCalled();
  });

  it('handles client-side timeout during summarization and shows error state with retry', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-timeout',
      status: 'queued',
      summary: null,
    });
    vi.spyOn(client, 'getProjectContextSummary').mockResolvedValue({
      taskId: 'task-timeout',
      status: 'running',
      summary: null,
    });

    renderWizard({ summaryTimeoutMs: 50 });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Timeout Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Initially in summarizing
    await waitFor(() => expect(screen.getByTestId('wizard-summarizing')).toBeInTheDocument());

    // After 50ms timeout, transitions to wizard-summary-error
    await waitFor(() => expect(screen.getByTestId('wizard-summary-error')).toBeInTheDocument());
    expect(screen.getByText('Quá thời gian chờ tóm tắt ngữ cảnh (task vẫn đang chạy nền).')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Thử lại' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Chạy nền và đóng' })).toBeInTheDocument();
  });

  it('handles backend failed task status, sanitizes error, and allows retry', async () => {
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-failed',
      status: 'queued',
      summary: null,
    });
    vi.spyOn(client, 'getProjectContextSummary').mockResolvedValue({
      taskId: 'task-failed',
      status: 'failed',
      summary: null,
      error: 'Worker process terminated unexpectedly\n    at ChildProcess.onExit (worker.ts:99:1)',
    } as any);

    renderWizard();

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Failed Task Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Transitions to error state
    await waitFor(() => expect(screen.getByTestId('wizard-summary-error')).toBeInTheDocument());
    expect(screen.getByText('Worker process terminated unexpectedly')).toBeInTheDocument();
    expect(screen.queryByText(/at ChildProcess/)).not.toBeInTheDocument();
  });

  it('cleans up draft and closes when clicking top close button during summarization', async () => {
    const onClose = vi.fn();
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    vi.spyOn(client, 'summarizeProjectContext').mockResolvedValue({
      taskId: 'task-close-test',
      status: 'running',
      summary: null,
    });
    vi.spyOn(client, 'getProjectContextSummary').mockResolvedValue({
      taskId: 'task-close-test',
      status: 'running',
      summary: null,
    });

    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Close Test Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Wait until summarizing
    await waitFor(() => expect(screen.getByTestId('wizard-summarizing')).toBeInTheDocument());

    // Click top close button
    const closeBtn = screen.getByRole('button', { name: 'Đóng' });
    fireEvent.click(closeBtn);

    // Verify onClose is called and draft in localStorage is cleared
    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem('agenthub.projectWizard')).toBeNull();
  });

  it('cleans up draft and closes when clicking top close button during summary error state', async () => {
    const onClose = vi.fn();
    const inspectSpy = vi.spyOn(client, 'inspectProject').mockResolvedValue(inspection);
    vi.spyOn(client, 'createProject').mockResolvedValue(project);
    vi.spyOn(client, 'summarizeProjectContext').mockRejectedValue(new Error('Network failure'));

    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Close On Error Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: inspection.path } });
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(inspectSpy).toHaveBeenCalledWith(inspection.path));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    await waitFor(() => expect(screen.getByText(/session-a\.jsonl/i)).toBeInTheDocument());
    fireEvent.click(screen.getByRole('checkbox', { name: /session-a\.jsonl/i }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Tôi đã duyệt nội dung/i }));

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.click(screen.getByRole('button', { name: 'Tạo dự án' }));

    // Wait for error state
    await waitFor(() => expect(screen.getByTestId('wizard-summary-error')).toBeInTheDocument());

    // Click top close button
    const closeBtn = screen.getByRole('button', { name: 'Đóng' });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalled();
    expect(localStorage.getItem('agenthub.projectWizard')).toBeNull();
  });

  it('preserves draft in localStorage when closing wizard before project creation', () => {
    const onClose = vi.fn();
    renderWizard({ onClose });

    fireEvent.click(screen.getByRole('button', { name: 'Tiếp' }));
    fireEvent.change(screen.getByPlaceholderText(/vd: XFarm/), { target: { value: 'Unsaved Project' } });
    fireEvent.change(screen.getByPlaceholderText(/vd: \/home/), { target: { value: '/tmp/unsaved' } });

    // Click top close button before creating project
    const closeBtn = screen.getByRole('button', { name: 'Đóng' });
    fireEvent.click(closeBtn);

    expect(onClose).toHaveBeenCalled();
    const saved = JSON.parse(localStorage.getItem('agenthub.projectWizard') || '{}');
    expect(saved.name).toBe('Unsaved Project');
    expect(saved.path).toBe('/tmp/unsaved');
  });
});
