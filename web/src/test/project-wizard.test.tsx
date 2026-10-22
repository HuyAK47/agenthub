import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ProjectWizard } from '../components/ProjectWizard';
import * as client from '../api/client';

const project = { id: 'new-project', name: 'New Project', path: '/tmp/new-project', defaultBranch: 'main', maxParallel: 3, envTemplate: null, checks: null };

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
});
