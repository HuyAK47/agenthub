import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DepartmentsPage } from '../pages/DepartmentsPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';

describe('DepartmentsPage', () => {
  let queryClient: QueryClient;
  const department = {
    id: 'engineering', name: 'Engineering', priority: 1, maxParallel: 2,
    claudeDailyTokenBudget: 0, telegramTopicId: null, brainEngine: 'claude' as const,
    brainModel: 'sonnet', brainCodexProfile: 'old-profile', brainMode: 'auto' as const,
    brainPermissions: 'trusted' as const, brainDailyTokenBudget: 100, brainMaxTurnsPerHour: 2,
    profiles: [], projects: [],
  };

  beforeEach(() => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.spyOn(client, 'getDepartments').mockResolvedValue([department]);
    vi.spyOn(client, 'getProfiles').mockResolvedValue([{ name: 'worker-1' }] as any);
  });

  afterEach(() => vi.restoreAllMocks());

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi"><DepartmentsPage /></LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('gửi inherit thật khi bỏ kế thừa mode và permissions', async () => {
    const updateSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByText('Cấu hình Brain'));

    fireEvent.change(screen.getByLabelText('Chế độ Brain'), { target: { value: 'inherit' } });
    fireEvent.change(screen.getByLabelText('Quyền'), { target: { value: 'inherit' } });

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('engineering', { brainMode: 'inherit' }));
    expect(updateSpy).toHaveBeenCalledWith('engineering', { brainPermissions: 'inherit' });
  });

  it('hiện profile Codex ngay khi đổi engine và gửi null khi xoá profile', async () => {
    const updateSpy = vi.spyOn(client, 'updateDepartment').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByText('Cấu hình Brain'));
    fireEvent.change(screen.getByLabelText('Engine Brain'), { target: { value: 'codex' } });
    const profile = await screen.findByLabelText('Profile Codex');
    fireEvent.change(profile, { target: { value: '' } });
    fireEvent.blur(profile);

    await waitFor(() => expect(updateSpy).toHaveBeenCalledWith('engineering', { brainCodexProfile: null }));
  });

  it('gán và bỏ gán profile bằng checkbox', async () => {
    const updateProfilesSpy = vi.spyOn(client, 'updateDepartmentProfiles').mockResolvedValue(department);
    renderPage();
    await screen.findByText('Engineering');
    fireEvent.click(screen.getByLabelText('worker-1'));

    await waitFor(() => expect(updateProfilesSpy).toHaveBeenCalledWith('engineering', [{ profileName: 'worker-1', share: null }]));
  });
});
