import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { TourProvider } from '../components/tour/TourContext';
import { HelpPanel } from '../components/tour/HelpPanel';
import { InfoTooltip } from '../components/tour/InfoTooltip';
import * as client from '../api/client';

function wrapper(children: React.ReactNode) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.spyOn(client, 'getConfig').mockResolvedValue({ ui: { tours: {} } } as any);
  vi.spyOn(client, 'getSetupStatus').mockResolvedValue({ setupCompletedAt: 'now' } as any);
  return render(
    <LocaleProvider initialLocale="en">
      <QueryClientProvider client={queryClient}>
        <MemoryRouter initialEntries={['/']}>
          <TourProvider>{children}</TourProvider>
        </MemoryRouter>
      </QueryClientProvider>
    </LocaleProvider>,
  );
}

describe('tour help and tooltips', () => {
  it('filters help tours and starts the selected tour', async () => {
    const close = vi.fn();
    wrapper(<HelpPanel open onClose={close} />);
    const search = screen.getByRole('textbox', { name: 'Search guides…' });
    fireEvent.change(search, { target: { value: 'performance' } });
    expect(screen.getByText('Overview')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Overview/i }));
    expect(close).toHaveBeenCalled();
  });

  it('shows an info tooltip from keyboard activation with an accessible label', () => {
    render(<InfoTooltip text="Helpful context" label="Explain setting" />);
    const button = screen.getByRole('button', { name: 'Explain setting' });
    button.focus();
    fireEvent.keyDown(button, { key: 'Enter' });
    fireEvent.click(button);
    expect(screen.getByRole('tooltip')).toHaveTextContent('Helpful context');
  });
});
