import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Layout } from '../components/Layout';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';

function renderLayout(initialEntry = '/') {
  return render(
    <LocaleProvider initialLocale="vi">
      <ThemeProvider>
        <MemoryRouter initialEntries={[initialEntry]}>
          <Layout />
        </MemoryRouter>
      </ThemeProvider>
    </LocaleProvider>,
  );
}

describe('Layout Navigation', () => {
  it('does not include "Phiên Claude" in the navigation sidebar', () => {
    renderLayout('/');

    // Check that Claude Sessions nav link is not in the sidebar navigation
    const nav = screen.getByRole('navigation');
    expect(nav).toBeInTheDocument();

    const claudeLink = screen.queryByRole('link', { name: /Phiên Claude/i });
    expect(claudeLink).toBeNull();

    // Verify other main links exist
    expect(screen.getByRole('link', { name: /Tổng quan/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Chat/i })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Tài khoản/i })).toBeInTheDocument();
  });

  it('keeps page title when visiting /claude-sessions directly', () => {
    renderLayout('/claude-sessions');

    // Header title displays page title for /claude-sessions
    const headerTitle = screen.getByRole('heading', { level: 1 });
    expect(headerTitle).toHaveTextContent('Phiên Claude');
  });
});
