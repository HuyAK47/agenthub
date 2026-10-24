import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SelectOrCustomInput, SortableModelList } from '../components/ui';
import { SettingsPage } from '../pages/SettingsPage';
import { validateModelSyntax, validateBranchSyntax } from '../utils/models';
import * as client from '../api/client';
import * as sse from '../api/sse';

function TestSelectWrapper({ initialValue = 'sonnet', options = ['sonnet', 'opus', 'haiku'] }: { initialValue?: string; options?: string[] }) {
  const [val, setVal] = useState(initialValue);
  return (
    <div>
      <span data-testid="current-value">{val}</span>
      <SelectOrCustomInput
        testId="test-select"
        value={val}
        onChange={setVal}
        options={options}
        validate={(v) => validateModelSyntax(v, (k) => k)}
        ariaLabel="Test Model"
      />
    </div>
  );
}

function TestSortableWrapper({ initialModels = ['sonnet', 'haiku'] }: { initialModels?: string[] }) {
  const [models, setModels] = useState<string[]>(initialModels);
  return (
    <div>
      <div data-testid="models-json">{JSON.stringify(models)}</div>
      <SortableModelList
        title="Model Chain"
        models={models}
        onChange={setModels}
        availableOptions={['sonnet', 'opus', 'haiku', 'codex:gpt-5.6-luna']}
        dataTestId="sortable-list"
      />
    </div>
  );
}

describe('Settings Select Inputs and Sortable Lists (f-settings-select-inputs)', () => {
  describe('1. SelectOrCustomInput Component', () => {
    it('renders preset options and allows selecting a standard model', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="sonnet" />
        </LocaleProvider>,
      );

      const select = screen.getByTestId('test-select') as HTMLSelectElement;
      expect(select.value).toBe('sonnet');
      expect(screen.getByTestId('current-value').textContent).toBe('sonnet');

      fireEvent.change(select, { target: { value: 'opus' } });
      expect(screen.getByTestId('current-value').textContent).toBe('opus');
    });

    it('switches to custom mode when selecting "Tùy chỉnh" and validates syntax live', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="sonnet" />
        </LocaleProvider>,
      );

      const select = screen.getByTestId('test-select') as HTMLSelectElement;
      fireEvent.change(select, { target: { value: '__custom__' } });

      const customInput = screen.getByTestId('test-select-custom-input') as HTMLInputElement;
      expect(customInput).toBeInTheDocument();

      // Enter invalid model with spaces
      fireEvent.change(customInput, { target: { value: 'invalid model name' } });
      expect(screen.getByRole('alert')).toBeInTheDocument();
      expect(screen.getByText('settings.invalidModelSyntax')).toBeInTheDocument();

      // Fix syntax to valid model
      fireEvent.change(customInput, { target: { value: 'codex:my-custom-model-1' } });
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(screen.getByTestId('current-value').textContent).toBe('codex:my-custom-model-1');
    });

    it('preserves an existing out-of-list value when loaded without data loss', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSelectWrapper initialValue="enterprise-private-llm:v2" />
        </LocaleProvider>,
      );

      // Custom mode is opened automatically so the value is displayed and editable
      const customInput = screen.getByTestId('test-select-custom-input') as HTMLInputElement;
      expect(customInput.value).toBe('enterprise-private-llm:v2');
      expect(screen.getByTestId('current-value').textContent).toBe('enterprise-private-llm:v2');

      // Presets can be restored via the back button
      const backBtn = screen.getByLabelText(/Quay lại danh sách/i);
      fireEvent.click(backBtn);
      expect(screen.getByTestId('current-value').textContent).toBe('sonnet');
    });

    it('validates branch names correctly', () => {
      expect(validateBranchSyntax('main', (k) => k)).toBeNull();
      expect(validateBranchSyntax('feat/feature-1', (k) => k)).toBeNull();
      expect(validateBranchSyntax('invalid branch', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('/leading-slash', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('double..dot', (k) => k)).toBe('settings.invalidBranchSyntax');
      expect(validateBranchSyntax('has:colon', (k) => k)).toBe('settings.invalidBranchSyntax');
    });
  });

  describe('2. SortableModelList Component', () => {
    it('moves items up and down with buttons and updates order', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet', 'haiku']} />
        </LocaleProvider>,
      );

      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","haiku"]');

      // Move down button for first item
      const moveDownFirst = screen.getByLabelText(/Di chuyển xuống \(sonnet\)/i);
      fireEvent.click(moveDownFirst);
      expect(screen.getByTestId('models-json').textContent).toBe('["haiku","sonnet"]');

      // Move up button for second item
      const moveUpSecond = screen.getByLabelText(/Di chuyển lên \(sonnet\)/i);
      fireEvent.click(moveUpSecond);
      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","haiku"]');
    });

    it('removes an item and shows empty chain warning when empty', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet']} />
        </LocaleProvider>,
      );

      const removeBtn = screen.getByLabelText(/X[oó][aá] model \(sonnet\)/i);
      fireEvent.click(removeBtn);

      expect(screen.getByTestId('models-json').textContent).toBe('[]');
      expect(screen.getByText(/Chuỗi model không được để trống/i)).toBeInTheDocument();
    });

    it('adds a new model from available options', () => {
      render(
        <LocaleProvider initialLocale="vi">
          <TestSortableWrapper initialModels={['sonnet']} />
        </LocaleProvider>,
      );

      const addBtn = screen.getByRole('button', { name: /Thêm model/i });
      fireEvent.click(addBtn);

      expect(screen.getByTestId('models-json').textContent).toBe('["sonnet","sonnet"]');
    });
  });

  describe('3. SettingsPage Integration with Sortable Lists & Select Inputs', () => {
    let queryClient: QueryClient;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });

      vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
      vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
        enabled: false,
        hasToken: false,
        chats: [],
        notify: { reviewReady: true, failed: true, blocked: true, quota: true, fallback: true },
      } as any);
      vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({ code: '123456', expiresInSec: 600 } as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-main', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
        { name: 'claude-main', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna', 'sonnet'],
        configured: ['sonnet', 'opus'],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high', 'codex:gpt-5.6-luna'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        defaultTimeout: 10800,
        chat: { claudeBin: 'claude', allowFullMode: false, maxConcurrent: 2, model: 'sonnet', models: ['opus', 'sonnet', 'haiku'] },
        reviewer: {
          model: 'codex:gpt-5.6-luna',
          claudeFallback: true,
          claudeProfiles: ['claude-main'],
          claudeModel: 'sonnet',
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: [] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
        brain: { mode: 'suggest', digest: { enabled: true, time: '18:00' }, fallback: [] },
        notifications: { desktop: true },
        savings: { bucketTokens: { gemini: 5000000, claude: 5000000 }, claudeFactor: 0.9, claudeOverheadPerTask: 40000 },
      } as any);
    });

    it('renders hard and easy model chains as sortable lists and loads reviewer order', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('easy-chain-list')).toBeInTheDocument();
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      expect(screen.getAllByText('gemini-3.8-flash-high').length).toBeGreaterThan(0);
      expect(screen.getAllByText('codex:gpt-5.6-luna').length).toBeGreaterThan(0);
    });

    it('saves configuration with valid values', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SettingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByTestId('hard-chain-list')).toBeInTheDocument();
      });

      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.modelChainHard).toEqual(['gemini-3.8-flash-high', 'codex:gpt-5.6-luna']);
      expect(payload.reviewer?.order?.[0]?.model).toBe('codex:gpt-5.6-luna');
    });
  });
});
