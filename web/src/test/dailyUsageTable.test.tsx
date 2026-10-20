import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { DailyUsageTable } from '../components/DailyUsageTable';
import { LocaleProvider } from '../context/LocaleContext';
import * as client from '../api/client';
import { DailyUsageReport } from '../types/api';

const mockReport: DailyUsageReport = {
  days: 7,
  timezone: 'Asia/Ho_Chi_Minh',
  dates: [
    '2026-10-20',
    '2026-10-19',
    '2026-10-18',
    '2026-10-17',
    '2026-10-16',
    '2026-10-15',
    '2026-10-14',
    '2026-10-13',
  ],
  profiles: [
    {
      name: 'chinh',
      engine: 'agy',
      enabled: true,
      isIdle: false,
      quota: { gemini5h: 80, geminiWeek: 85, claude5h: 40, claudeWeek: 50 },
      quotaUsage: [],
      today: { runs: 3, durationMs: 180000, tokens: 65000 },
      totals: { runs: 12, durationMs: 720000, tokens: 280000 },
      daily: {
        '2026-10-20': { runs: 3, durationMs: 180000, tokens: 65000 },
        '2026-10-19': { runs: 2, durationMs: 120000, tokens: 45000 },
      },
    },
    {
      name: 'g1',
      engine: 'agy',
      enabled: true,
      isIdle: true,
      idleReason: 'Gemini 95%, Claude 80% · 0 run hôm nay',
      quota: { gemini5h: 95, geminiWeek: 95, claude5h: 80, claudeWeek: 85 },
      quotaUsage: [],
      today: { runs: 0, durationMs: 0, tokens: 0 },
      totals: { runs: 8, durationMs: 480000, tokens: 190000 },
      daily: {
        '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
        '2026-10-19': { runs: 4, durationMs: 240000, tokens: 90000 },
      },
    },
    {
      name: 'g2',
      engine: 'agy',
      enabled: true,
      isIdle: true,
      idleReason: 'Gemini 90%, Claude 90% · 0 run hôm nay',
      quota: { gemini5h: 90, geminiWeek: 90, claude5h: 90, claudeWeek: 90 },
      quotaUsage: [],
      today: { runs: 0, durationMs: 0, tokens: 0 },
      totals: { runs: 5, durationMs: 300000, tokens: 120000 },
      daily: {
        '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
      },
    },
    {
      name: 'g3',
      engine: 'agy',
      enabled: true,
      isIdle: false,
      idleReason: 'Đang bị khóa quota',
      quota: { gemini5h: 10, geminiWeek: 20, claude5h: 5, claudeWeek: 15 },
      quotaUsage: [],
      today: { runs: 1, durationMs: 60000, tokens: 25000 },
      totals: { runs: 6, durationMs: 360000, tokens: 150000 },
      daily: {
        '2026-10-20': { runs: 1, durationMs: 60000, tokens: 25000 },
      },
    },
    {
      name: 'codex',
      engine: 'codex',
      enabled: true,
      isIdle: true,
      idleReason: 'Codex sẵn sàng, ít việc hôm nay',
      quota: { gemini5h: null, geminiWeek: null, claude5h: null, claudeWeek: null },
      quotaUsage: [],
      today: { runs: 0, durationMs: 0, tokens: 0 },
      totals: { runs: 4, durationMs: 160000, tokens: 150000 },
      daily: {
        '2026-10-20': { runs: 0, durationMs: 0, tokens: 0 },
      },
    },
  ],
  byDay: [
    {
      date: '2026-10-20',
      isToday: true,
      totalRuns: 4,
      totalDurationMs: 240000,
      totalTokens: 90000,
      profiles: [],
    },
    {
      date: '2026-10-19',
      isToday: false,
      totalRuns: 6,
      totalDurationMs: 360000,
      totalTokens: 135000,
      profiles: [],
    },
  ],
};

function renderWithProviders(ui: React.ReactElement) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <LocaleProvider initialLocale="vi">
        {ui}
      </LocaleProvider>
    </QueryClientProvider>,
  );
}

describe('DailyUsageTable Component', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders loading state initially', () => {
    vi.spyOn(client, 'getDailyUsage').mockReturnValue(new Promise(() => {}));
    renderWithProviders(<DailyUsageTable />);
    expect(screen.getByTestId('daily-usage-loading')).toBeInTheDocument();
  });

  it('renders error state on query failure', async () => {
    vi.spyOn(client, 'getDailyUsage').mockRejectedValue(new Error('Network error'));
    renderWithProviders(<DailyUsageTable />);
    await waitFor(() => {
      expect(screen.getByTestId('daily-usage-error')).toBeInTheDocument();
    });
    expect(screen.getByText('Không thể tải dữ liệu mức dùng theo ngày.')).toBeInTheDocument();
  });

  it('renders the daily usage table with all accounts, quotas, and metrics', async () => {
    vi.spyOn(client, 'getDailyUsage').mockResolvedValue(mockReport);
    renderWithProviders(<DailyUsageTable />);

    await waitFor(() => {
      expect(screen.getByTestId('daily-usage-section')).toBeInTheDocument();
    });

    // Check header title and subtitle
    expect(screen.getByText('Mức dùng theo ngày')).toBeInTheDocument();
    expect(screen.getByText('Tận dụng tối đa token theo ngày của các tài khoản agy và Codex.')).toBeInTheDocument();

    // Check that all 5 profiles are listed
    expect(screen.getByText('chinh')).toBeInTheDocument();
    expect(screen.getByText('g1')).toBeInTheDocument();
    expect(screen.getByText('g2')).toBeInTheDocument();
    expect(screen.getByText('g3')).toBeInTheDocument();
    expect(screen.getAllByText('codex').length).toBeGreaterThanOrEqual(1);

    // Check engine badges
    const agyBadges = screen.getAllByText('agy');
    expect(agyBadges.length).toBeGreaterThanOrEqual(4);
    const codexBadges = screen.getAllByText('codex');
    expect(codexBadges.length).toBeGreaterThanOrEqual(1);

    // Check quota percentage displays
    expect(screen.getAllByText('95%').length).toBeGreaterThanOrEqual(1);

    // Check idle suggestions: g1, g2, codex are idle (isIdle: true)
    const idleBadges = screen.getAllByText('Đang rảnh');
    expect(idleBadges.length).toBeGreaterThanOrEqual(3);

    // Check row highlighting
    const g1Row = screen.getByTestId('daily-usage-row-g1');
    expect(g1Row.className).toContain('border-l-emerald-500');

    // Check metric values for today (2026-10-20)
    // chinh has 3 runs, 65,000 tokens
    expect(screen.getByText('65.000')).toBeInTheDocument();
  });

  it('allows switching dates via date selector pills', async () => {
    vi.spyOn(client, 'getDailyUsage').mockResolvedValue(mockReport);
    renderWithProviders(<DailyUsageTable />);

    await waitFor(() => {
      expect(screen.getByTestId('daily-usage-section')).toBeInTheDocument();
    });

    // Click on 10-19 pill
    const user = userEvent.setup();
    const pill19 = screen.getByText('10-19');
    await user.click(pill19);

    // In 10-19: g1 has 4 runs, 90,000 tokens
    await waitFor(() => {
      expect(screen.getByText('90.000')).toBeInTheDocument();
    });
  });

  it('allows switching to 7-day overview matrix', async () => {
    vi.spyOn(client, 'getDailyUsage').mockResolvedValue(mockReport);
    renderWithProviders(<DailyUsageTable />);

    await waitFor(() => {
      expect(screen.getByTestId('daily-usage-section')).toBeInTheDocument();
    });

    const user = userEvent.setup();
    const overviewButton = screen.getByText('Tổng quan 7 ngày');
    await user.click(overviewButton);

    // Totals should be rendered
    await waitFor(() => {
      expect(screen.getByText('Tổng cộng')).toBeInTheDocument();
    });
    expect(screen.getByText('12 lượt chạy')).toBeInTheDocument();
  });
});
