import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter } from 'react-router-dom';
import { SavingsPage } from '../pages/SavingsPage';
import * as client from '../api/client';
import { SavingsReport } from '../types/api';

const report: SavingsReport = {
  summary: {
    totalWorkerTokens: 123456,
    claudeSavedTokens: 111110,
    claudeCostTokens: 40000,
    savingsRatio: 0.735,
    totalLinesAdded: 42,
    totalLinesDeleted: 7,
    totalLinesChanged: 49,
    tasksApprovedCount: 1,
    avgReviewRounds: 1,
  },
  byEngine: {},
  byModel: {},
  byDay: [],
  tasks: [
    {
      taskId: 'demo/task-1',
      slug: 'task-1',
      title: 'Tạo báo cáo savings',
      projectId: 'demo',
      status: 'done',
      model: 'codex:gpt-5.6-luna',
      engine: 'codex',
      linesAdded: 42,
      linesDeleted: 7,
      filesChanged: 2,
      tokens: 123456,
      estimated: false,
      reviewRounds: 1,
      durationMs: 65000,
      completedAt: '2026-10-15T10:00:00.000Z',
    },
  ],
};

describe('SavingsPage', () => {
  beforeEach(() => {
    vi.spyOn(client, 'getProjects').mockResolvedValue([]);
    vi.spyOn(client, 'getSavings').mockResolvedValue(report);
  });

  it('renders savings metrics and task data from the API', async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

    render(
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <SavingsPage />
        </BrowserRouter>
      </QueryClientProvider>,
    );

    const formattedSavedTokens = new Intl.NumberFormat('vi-VN').format(report.summary.claudeSavedTokens);
    expect(await screen.findByText(formattedSavedTokens)).toBeInTheDocument();
    expect(screen.getByText('Hiệu quả ủy quyền')).toBeInTheDocument();
    expect(screen.getByText('Tạo báo cáo savings')).toBeInTheDocument();
    expect(screen.queryByText('≈')).not.toBeInTheDocument();
    expect(screen.getByText('1m 5s')).toBeInTheDocument();
  });
});
