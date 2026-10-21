import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfilesPage } from '../pages/ProfilesPage';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { Profile, EventItem } from '../types/api';

describe('ProfilesPage - Bật/Tắt, Nút Check và Quota Mark', () => {
  let queryClient: QueryClient;
  let sseCallback: sse.EventCallback | null = null;

  const mockProfiles: Profile[] = [
    {
      name: 'g1',
      engine: 'agy',
      kind: 'isolated',
      email: 'g1@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [
        {
          profileName: 'g1',
          family: 'gemini-2.5-pro',
          until: Math.floor(Date.now() / 1000) + 3600,
          reason: 'Daily token quota exceeded',
        },
      ],
      usage: [
        {
          grp: 'gemini-flash',
          window: '5h',
          remainingPct: 85,
          resetAt: Math.floor(Date.now() / 1000) + 7200,
          fetchedAt: Math.floor(Date.now() / 1000),
        },
      ],
    },
    {
      name: 'g2',
      engine: 'agy',
      kind: 'isolated',
      email: 'g2@example.com',
      loggedIn: true,
      enabled: 0,
      quotaMarks: [],
    },
  ];

  beforeEach(() => {
    window.history.replaceState({}, '', '/profiles');
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    sseCallback = null;
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation((cb) => {
      sseCallback = cb;
      return () => {
        sseCallback = null;
      };
    });

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);
    vi.spyOn(client, 'refreshProfileUsage').mockResolvedValue({} as any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    const prototype = HTMLElement.prototype as { scrollIntoView?: unknown };
    delete prototype.scrollIntoView;
  });

  it('scrolls to the profile named by the URL hash after profiles load', async () => {
    window.history.replaceState({}, '', '/profiles#profile-g1');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    renderPage();
    await screen.findByText('g1');

    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'start' });
  });

  it('does not scroll again when profile data is refreshed', async () => {
    window.history.replaceState({}, '', '/profiles#profile-g1');
    const scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: scrollIntoView });

    renderPage();
    await screen.findByText('g1');
    expect(scrollIntoView).toHaveBeenCalledTimes(1);

    queryClient.setQueryData(['profiles'], mockProfiles.map((profile) => ({ ...profile })));
    await act(async () => {
      await Promise.resolve();
    });

    expect(scrollIntoView).toHaveBeenCalledTimes(1);
  });

  function renderPage() {
    return render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="vi">
          <BrowserRouter>
            <ProfilesPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );
  }

  it('1. Bật/Tắt hồ sơ: click nút toggle khi profile đang bật (enabled: 1) gọi updateProfile với enabled = false', async () => {
    const updateSpy = vi.spyOn(client, 'updateProfile').mockResolvedValue({
      ...mockProfiles[0],
      enabled: 0,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const toggleG1 = screen.getByRole('button', { name: 'Bật tắt hồ sơ g1' });
    expect(toggleG1).toBeInTheDocument();
    // Đang bật -> class có bg-[var(--t-accent)]
    expect(toggleG1).toHaveClass('bg-[var(--t-accent)]');

    await act(async () => {
      fireEvent.click(toggleG1);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('g1', { enabled: false });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
  });

  it('2. Bật/Tắt hồ sơ: click nút toggle khi profile đang tắt (enabled: 0) gọi updateProfile với enabled = true', async () => {
    const updateSpy = vi.spyOn(client, 'updateProfile').mockResolvedValue({
      ...mockProfiles[1],
      enabled: 1,
    });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g2')).toBeInTheDocument();

    const toggleG2 = screen.getByRole('button', { name: 'Bật tắt hồ sơ g2' });
    expect(toggleG2).toBeInTheDocument();
    // Đang tắt -> class có bg-[var(--t-surface-2)]
    expect(toggleG2).toHaveClass('bg-[var(--t-surface-2)]');

    await act(async () => {
      fireEvent.click(toggleG2);
      await Promise.resolve();
    });

    expect(updateSpy).toHaveBeenCalledWith('g2', { enabled: true });
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
  });

  it('3. Nút Check: gửi request checkProfile (202), nút chuyển sang đang kiểm tra và bị disabled', async () => {
    const checkSpy = vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    const checkG1 = checkButtons[0];

    await act(async () => {
      fireEvent.click(checkG1);
      await Promise.resolve();
    });

    expect(checkSpy).toHaveBeenCalledWith('g1');

    // Nút chuyển sang "Đang kiểm tra…" và bị disabled
    expect(screen.getByRole('button', { name: /Đang kiểm tra…/i })).toBeDisabled();
  });

  it('4. Nút Check: nhận SSE profile.check (ok: true) hiển thị toast thành công kèm durationMs và refreshProfileUsage', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    await act(async () => {
      fireEvent.click(checkButtons[0]);
      await Promise.resolve();
    });

    // Server phát sự kiện SSE profile.check thành công
    expect(sseCallback).toBeDefined();
    await act(async () => {
      const sseEvent: EventItem = {
        id: 201,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: true,
          message: 'Tài khoản hoạt động tốt',
          durationMs: 420,
        },
      };
      sseCallback!(sseEvent);
      await Promise.resolve();
    });

    // Toast hiển thị icon ✓ và thời gian thực thi
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('✓');
    expect(toast).toHaveTextContent('Tài khoản hoạt động tốt (420ms)');

    // Invalidate queries và refresh usage
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });
    expect(client.refreshProfileUsage).toHaveBeenCalledWith('g1');
  });

  it('5. Nút Check: nhận SSE profile.check (ok: false) hiển thị toast lỗi ✗', async () => {
    vi.spyOn(client, 'checkProfile').mockResolvedValue({ started: true });

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const checkButtons = screen.getAllByRole('button', { name: /^Check$/ });
    await act(async () => {
      fireEvent.click(checkButtons[0]);
      await Promise.resolve();
    });

    // Server phát sự kiện SSE profile.check thất bại
    await act(async () => {
      const sseEvent: EventItem = {
        id: 202,
        ts: new Date().toISOString(),
        type: 'profile.check',
        payload: {
          name: 'g1',
          ok: false,
          message: 'Token hết hạn',
          durationMs: 150,
        },
      };
      sseCallback!(sseEvent);
      await Promise.resolve();
    });

    // Toast hiển thị icon ✗ và message lỗi
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent('✗');
    expect(toast).toHaveTextContent('Token hết hạn (150ms)');
  });

  it('6. Quota mark API: deleteQuota gọi đúng API DELETE /api/profiles/:name/quota?family=:family', async () => {
    const apiFetchSpy = vi.spyOn(client, 'deleteQuota').mockResolvedValue({ ok: true });

    const result = await client.deleteQuota('g1', 'gemini-2.5-pro');

    expect(result).toEqual({ ok: true });
    expect(apiFetchSpy).toHaveBeenCalledWith('g1', 'gemini-2.5-pro');
  });

  it('7. Quota mark UI: hiển thị badge khóa quota còn hiệu lực với text "Đã khóa <family> tới HH:MM", countdown timer, tooltip lý do và nút Gỡ', async () => {
    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();
    expect(screen.getByText('g2')).toBeInTheDocument();

    // Hồ sơ g1 có quotaMarks còn hiệu lực
    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute('title', 'Daily token quota exceeded');
    expect(badge).toHaveTextContent(/Đã khóa gemini-2.5-pro tới \d{2}:\d{2}/);

    // Có CountdownTimer đếm ngược
    const countdown = screen.getByTestId('countdown-timer');
    expect(countdown).toBeInTheDocument();

    // Có nút Gỡ
    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    expect(removeBtn).toBeInTheDocument();
  });

  it('8. Quota mark UI: bấm nút Gỡ nhưng hủy xác nhận (confirm = false) thì không gọi deleteQuota', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const deleteSpy = vi.spyOn(client, 'deleteQuota');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    await act(async () => {
      fireEvent.click(removeBtn);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('gemini-2.5-pro'));
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  it('9. Quota mark UI: bấm nút Gỡ, xác nhận (confirm = true) thì gọi deleteQuota với đúng tham số family và tải lại danh sách hồ sơ', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    const deleteSpy = vi.spyOn(client, 'deleteQuota').mockResolvedValue({ ok: true });
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries');

    renderPage();

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const removeBtn = screen.getByRole('button', { name: /^Gỡ$/ });
    await act(async () => {
      fireEvent.click(removeBtn);
      await Promise.resolve();
    });

    expect(confirmSpy).toHaveBeenCalledWith(expect.stringContaining('gemini-2.5-pro'));
    expect(deleteSpy).toHaveBeenCalledWith('g1', 'gemini-2.5-pro');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['profiles'] });

    // Hiển thị toast thông báo thành công
    const toast = screen.getByRole('alert');
    expect(toast).toHaveTextContent(/Đã gỡ khóa quota/i);
  });

  it('10. Quota mark UI: không hiển thị quota mark đã hết hạn (until trong quá khứ)', async () => {
    const profilesWithExpired: Profile[] = [
      {
        name: 'g_expired',
        engine: 'agy',
        kind: 'isolated',
        email: 'expired@example.com',
        loggedIn: true,
        enabled: 1,
        quotaMarks: [
          {
            profileName: 'g_expired',
            family: 'claude-3-7-sonnet',
            until: Math.floor(Date.now() / 1000) - 3600, // Đã hết hạn 1 tiếng trước
            reason: 'Old quota mark',
          },
        ],
      },
    ];
    vi.spyOn(client, 'getProfiles').mockResolvedValue(profilesWithExpired);

    renderPage();

    expect(await screen.findByText('g_expired')).toBeInTheDocument();
    expect(screen.queryByTestId('quota-mark-claude-3-7-sonnet')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Gỡ$/ })).not.toBeInTheDocument();
  });

  it('11. Quota mark UI: hiển thị badge và nút xóa đúng trong ngôn ngữ tiếng Anh (en)', async () => {
    render(
      <QueryClientProvider client={queryClient}>
        <LocaleProvider initialLocale="en">
          <BrowserRouter>
            <ProfilesPage />
          </BrowserRouter>
        </LocaleProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('g1')).toBeInTheDocument();

    const badge = screen.getByTestId('quota-mark-gemini-2.5-pro');
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveTextContent(/Locked gemini-2.5-pro until \d{2}:\d{2}/);

    const removeBtn = screen.getByRole('button', { name: /^Remove$/ });
    expect(removeBtn).toBeInTheDocument();
  });

  it('12. Claude card: displays limited sessions with auto-resume toggle and detail link', async () => {
    const claudeProfile: Profile = {
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      email: 'user@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [],
      limitedSessions: [
        {
          sessionId: 'sess-abc-12345',
          title: 'Implement feature X',
          cwd: '/projects/repo-a',
          limitResetAt: Math.floor(Date.now() / 1000) + 1800,
          autoResumeEnabled: true,
        },
      ],
    };
    vi.spyOn(client, 'getProfiles').mockResolvedValue([claudeProfile]);
    const apiFetchSpy = vi.spyOn(client, 'apiFetch').mockResolvedValue({} as any);

    renderPage();

    expect(await screen.findByText('claude-may')).toBeInTheDocument();
    expect(screen.getByText('Phiên bị giới hạn')).toBeInTheDocument();
    expect(screen.getByText('Implement feature X')).toBeInTheDocument();
    expect(screen.getByText('/projects/repo-a')).toBeInTheDocument();

    const detailLink = screen.getByText('Xem chi tiết →');
    expect(detailLink).toBeInTheDocument();
    expect(detailLink.closest('a')).toHaveAttribute('href', '/claude-sessions/sess-abc-12345');

    const toggle = screen.getByRole('checkbox', { name: /Tự tiếp tục khi hết giới hạn/ });
    expect(toggle).toBeChecked();

    fireEvent.click(toggle);
    expect(apiFetchSpy).toHaveBeenCalledWith(
      '/api/claude/sessions/sess-abc-12345/auto-resume',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ enabled: false }),
      }),
    );
  });

  it('13. Claude card: displays empty state when there are no limited sessions', async () => {
    const claudeProfile: Profile = {
      name: 'claude-may',
      engine: 'claude',
      kind: 'system',
      email: 'user@example.com',
      loggedIn: true,
      enabled: 1,
      quotaMarks: [],
      limitedSessions: [],
    };
    vi.spyOn(client, 'getProfiles').mockResolvedValue([claudeProfile]);

    renderPage();

    expect(await screen.findByText('claude-may')).toBeInTheDocument();
    expect(screen.getByText('Phiên bị giới hạn')).toBeInTheDocument();
    expect(screen.getByText('Không có phiên nào bị giới hạn')).toBeInTheDocument();
  });
});
