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

function renderWizard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><LocaleProvider initialLocale="vi"><ProjectWizard onClose={vi.fn()} /></LocaleProvider></QueryClientProvider>);
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
        worktree: { root: '/media', logsInRoot: true, install: 'skip', gitHooks: 'skip' },
        notifications: { telegramContent: 'minimal' },
        brain: expect.objectContaining({ permissions: 'standard' }),
        integration: expect.objectContaining({ enabled: true, baseRef: 'main' }),
      }),
    }));
    await waitFor(() => expect(knowledgeSpy).toHaveBeenCalledWith(project.id, expect.objectContaining({ pinned: true, content: inspection.memoryPreview })));
    expect(guidanceSpy).toHaveBeenCalledWith(project.id, '# Approved guidance');
  });
});
