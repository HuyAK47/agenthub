import { describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { TourProvider, modalTourDefinitions, pageTours, tourDefinitions, useTour } from '../components/tour/TourContext';
import { translations, translate } from '../locales';
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

  it('closes the help panel and keeps every tour key translated in both locales', () => {
    const close = vi.fn();
    wrapper(<HelpPanel open onClose={close} />);
    fireEvent.click(screen.getAllByRole('button', { name: 'Close guide' })[1]);
    expect(close).toHaveBeenCalledTimes(1);

    const definitions = [...tourDefinitions, ...Object.values(pageTours), ...modalTourDefinitions];
    for (const step of definitions.flatMap((tour) => tour.steps)) {
      expect(translate('vi', step.title)).not.toBe(step.title);
      expect(translate('en', step.title)).not.toBe(step.title);
      expect(translate('vi', step.content)).not.toBe(step.content);
      expect(translate('en', step.content)).not.toBe(step.content);
    }
    expect(translations.vi.tour.steps).toBeDefined();
    expect(translations.en.tour.steps).toBeDefined();
  });

  it('suggests a modal tour only once', async () => {
    localStorage.clear();
    let suggest: ((id: string) => void) | undefined;
    let closeTour: (() => void) | undefined;
    const Probe = () => {
      const tour = useTour();
      suggest = tour.suggestModalTour;
      closeTour = tour.closeTour;
      return <span data-testid="active-tour">{tour.active?.id || ''}</span>;
    };
    wrapper(<Probe />);
    await waitFor(() => expect(suggest).toBeDefined());
    act(() => suggest?.('modal-create-task'));
    await waitFor(() => expect(screen.getByTestId('active-tour')).toHaveTextContent('modal-create-task'));
    act(() => closeTour?.());
    expect(localStorage.getItem('agenthub_tours_seen:modal-create-task')).toBe('1');
    act(() => suggest?.('modal-create-task'));
    expect(screen.getByTestId('active-tour')).not.toHaveTextContent('modal-create-task');
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
