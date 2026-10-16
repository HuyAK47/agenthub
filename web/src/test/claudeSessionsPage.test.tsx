import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { ClaudeSessionsPage } from '../pages/ClaudeSessionsPage';
import * as client from '../api/client';

const session = {
  sessionId: 'session-1', cwd: '/work/project', title: 'Implement feature', model: 'claude-sonnet',
  messages: 3, effectiveTokens: 120, lastAt: '2026-10-16T09:00:00Z', active: true,
  isHubChat: false, topTasks: [{ taskId: 'proj~alpha', effectiveTokens: 100 }],
};

function renderPage(initialEntry = '/claude-sessions') {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <Routes>
          <Route path="/claude-sessions" element={<ClaudeSessionsPage />} />
          <Route path="/claude-sessions/:sessionId" element={<ClaudeSessionsPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe('ClaudeSessionsPage', () => {
  beforeEach(() => {
    vi.spyOn(client, 'apiFetch').mockImplementation(async (path) => {
      if (path === '/api/claude/sessions') return [session];
      return {
        ...session,
        turns: [{ ts: '2026-10-16T09:00:00Z', turnId: 'turn-1', effectiveTokens: 120, input: 80, output: 40, tasks: [{ taskId: 'proj~alpha', effectiveTokens: 120 }] }],
      };
    });
    vi.spyOn(client, 'rescanClaudeSessions').mockResolvedValue({ ok: true });
  });

  it('renders session title, message count, and top task', async () => {
    renderPage();
    expect(await screen.findByText('Implement feature')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
    expect(screen.getByText(/proj~alpha/)).toBeInTheDocument();
  });

  it('calls the rescan endpoint when Quét lại is clicked', async () => {
    renderPage();
    await screen.findByText('Implement feature');
    fireEvent.click(screen.getByRole('button', { name: 'Quét lại' }));
    await waitFor(() => expect(client.rescanClaudeSessions).toHaveBeenCalledTimes(1));
  });

  it('shows a token chart and turn rows in the detail view', async () => {
    renderPage('/claude-sessions/session-1');
    expect(await screen.findByRole('img', { name: 'Token theo thời gian' })).toBeInTheDocument();
    expect(screen.getByText('120')).toBeInTheDocument();
    expect(screen.getByText('proj~alpha (120)')).toBeInTheDocument();
  });
});
