import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DashboardPage } from '../pages/DashboardPage';
import * as client from '../api/client';
import * as sse from '../api/sse';

describe('DashboardPage - Disk status display', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });
    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
  });

  it('hiển thị dung lượng trống và đổi màu khi còn dưới 5GB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 3.2,
        totalGB: 73.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 3.2 / 73 GB trống');
    expect(diskBadge.className).toContain('text-[var(--t-warn)]');
  });

  it('dùng màu bình thường khi dung lượng trống >= 5GB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 15.0,
        totalGB: 73.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 15 / 73 GB trống');
    expect(diskBadge.className).not.toContain('text-[var(--t-warn)]');
  });

  it('hiển thị ngưỡng minFreeGB khi có trường minFreeGB', async () => {
    vi.spyOn(client, 'getStatus').mockResolvedValue({
      tasks: { running: 0 },
      running: [],
      disk: {
        freeGB: 2.1,
        totalGB: 73.0,
        minFreeGB: 5.0,
      },
    } as any);

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <DashboardPage />
        </BrowserRouter>
      </QueryClientProvider>
    );

    const diskBadge = await screen.findByTestId('disk-status');
    expect(diskBadge).toBeInTheDocument();
    expect(diskBadge).toHaveTextContent('Ổ đĩa: 2.1 / 73 GB trống (ngưỡng 5 GB)');
    expect(diskBadge.className).toContain('text-[var(--t-warn)]');
  });
});
