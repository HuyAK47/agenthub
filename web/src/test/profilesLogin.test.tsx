import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ProfilesPage } from '../pages/ProfilesPage';
import * as client from '../api/client';
import * as sse from '../api/sse';
import { Profile } from '../types/api';

describe('ProfilesPage - Trạng thái đăng nhập và hiển thị email/codex', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('hồ sơ codex đã đăng nhập hiển thị "Codex (ChatGPT)" ở chỗ email', async () => {
    const mockProfiles: Profile[] = [
      {
        name: 'codex-main',
        engine: 'codex',
        kind: 'codex',
        email: null,
        loggedIn: true,
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Codex (ChatGPT)')).toBeInTheDocument();
    expect(screen.queryByText('Chưa đăng nhập')).not.toBeInTheDocument();
  });

  it('dùng loggedIn: false để hiển thị "Chưa đăng nhập" kể cả khi profile có chuỗi email', async () => {
    const mockProfiles: Profile[] = [
      {
        name: 'g1',
        engine: 'agy',
        kind: 'isolated',
        email: 'old.expired@gmail.com',
        loggedIn: false,
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Chưa đăng nhập')).toBeInTheDocument();
    expect(screen.getByText('Đăng nhập ngay')).toBeInTheDocument();
    expect(screen.queryByText('old.expired@gmail.com')).not.toBeInTheDocument();
  });

  it('nút Đăng nhập chỉ hiện với hồ sơ có thể đăng nhập (agy isolated, codex, claude)', async () => {
    const mockProfiles: Profile[] = [
      {
        name: 'g-iso',
        engine: 'agy',
        kind: 'isolated',
        email: null,
        loggedIn: false,
        enabled: 1,
      },
      {
        name: 'g-keyring',
        engine: 'agy',
        kind: 'keyring',
        email: null,
        loggedIn: false,
        enabled: 1,
      },
      {
        name: 'codex-iso',
        engine: 'codex',
        kind: 'codex',
        email: null,
        loggedIn: false,
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    await screen.findByText('g-iso');

    // Button "Đăng nhập ngay" (inline) for g-iso and codex-iso (not for keyring)
    const loginNowBtns = screen.getAllByText('Đăng nhập ngay');
    expect(loginNowBtns).toHaveLength(2);

    // Button "Đăng nhập" (in Action column) for g-iso and codex-iso
    const actionLoginBtns = screen.getAllByRole('button', { name: /^Đăng nhập$/ });
    expect(actionLoginBtns).toHaveLength(2);
  });

  it('giữ hành vi cũ nếu loggedIn không có trong response (server cũ)', async () => {
    const mockProfiles: Profile[] = [
      {
        name: 'legacy-logged-in',
        engine: 'agy',
        kind: 'keyring',
        email: 'legacy@gmail.com',
        // loggedIn undefined
        enabled: 1,
      },
      {
        name: 'legacy-not-logged-in',
        engine: 'agy',
        kind: 'isolated',
        email: null,
        // loggedIn undefined
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('legacy@gmail.com')).toBeInTheDocument();
    expect(screen.getByText('Chưa đăng nhập')).toBeInTheDocument();
  });

  it('hồ sơ có authState = "needs_verification" hiện badge vàng, nút Mở trang xác minh và hướng dẫn thay vì "Đã đăng nhập"', async () => {
    const verifyUrl = 'https://accounts.google.com/signin/continue?sarp=1&scc=1&continue=https%3A%2F%2Ftest';
    const mockProfiles: Profile[] = [
      {
        name: 'g-ineligible',
        engine: 'agy',
        kind: 'isolated',
        email: null,
        loggedIn: true,
        authState: 'needs_verification',
        authMessage: 'Cần xác minh tài khoản',
        verifyUrl,
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    // Badge "Cần xác minh tài khoản" thay cho "Đã đăng nhập"
    expect(await screen.findByText('Cần xác minh tài khoản')).toBeInTheDocument();
    expect(screen.queryByText('Đã đăng nhập')).not.toBeInTheDocument();

    // Nút "Mở trang xác minh" có target=_blank và rel=noopener
    const verifyLink = screen.getByRole('link', { name: 'Mở trang xác minh' });
    expect(verifyLink).toBeInTheDocument();
    expect(verifyLink).toHaveAttribute('href', verifyUrl);
    expect(verifyLink).toHaveAttribute('target', '_blank');
    expect(verifyLink).toHaveAttribute('rel', 'noopener');

    // Dòng hướng dẫn
    expect(
      screen.getByText('Mở link bằng đúng tài khoản Google đó, hoàn tất xác minh, rồi bấm Check'),
    ).toBeInTheDocument();
  });

  it('hồ sơ có authState = "not_logged_in" hiện "Chưa đăng nhập" và nút Đăng nhập', async () => {
    const mockProfiles: Profile[] = [
      {
        name: 'g-not-logged-in',
        engine: 'agy',
        kind: 'isolated',
        email: null,
        loggedIn: false,
        authState: 'not_logged_in',
        authMessage: 'Chưa đăng nhập',
        verifyUrl: null,
        enabled: 1,
      },
    ];

    vi.spyOn(client, 'getProfiles').mockResolvedValue(mockProfiles);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <ProfilesPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText('Chưa đăng nhập')).toBeInTheDocument();
    expect(screen.getByText('Đăng nhập ngay')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Đăng nhập$/ })).toBeInTheDocument();
  });
});
