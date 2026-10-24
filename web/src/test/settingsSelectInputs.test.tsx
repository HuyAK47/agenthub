import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { useState } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { SelectOrCustomInput, SortableModelList } from '../components/ui';
import { SettingsPage } from '../pages/SettingsPage';
import { ProjectSettingsDrawer } from '../components/ProjectSettingsDrawer';
import {
  validateModelSyntax,
  validateChatModelSyntax,
  validateReviewChainReviewerSyntax,
  validateReviewerModelSyntax,
  validateBranchSyntax,
} from '../utils/models';
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

    it('validates worker model syntax consistently with backend modelValidator', () => {
      expect(validateModelSyntax('gemini-3.8-flash-high', (k) => k)).toBeNull();
      expect(validateModelSyntax('claude-sonnet-4-6', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:gpt-5.6-luna', (k) => k)).toBeNull();
      expect(validateModelSyntax('codex:custom-model-id', (k) => k)).toBeNull();
      expect(validateModelSyntax('   ', (k) => k)).toBe('settings.emptyChainWarning');
      // Arbitrary non-agy and non-codex models should be rejected
      expect(validateModelSyntax('gemini-custom', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateModelSyntax('gpt-custom', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateModelSyntax('claude:custom', (k) => k)).toBe('settings.invalidModelSyntax');
    });

    it('validates chat model syntax consistently with chat.model enum', () => {
      expect(validateChatModelSyntax('', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('sonnet', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('opus', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('haiku', (k) => k)).toBeNull();
      expect(validateChatModelSyntax('gemini-3.8-flash-high', (k) => k)).toBe('settings.invalidChatModelSyntax');
      expect(validateChatModelSyntax('codex:gpt-5.6-luna', (k) => k)).toBe('settings.invalidChatModelSyntax');
    });

    it('validates review chain reviewer syntax and reviewer model syntax', () => {
      expect(validateReviewChainReviewerSyntax('claude', (k) => k)).toBeNull();
      expect(validateReviewChainReviewerSyntax('codex:gpt-5.6-luna', (k) => k)).toBeNull();
      expect(validateReviewChainReviewerSyntax('unknown-reviewer', (k) => k)).toBe('settings.invalidReviewChainReviewer');
      expect(validateReviewChainReviewerSyntax('codex:', (k) => k)).toBe('settings.invalidReviewChainReviewer');

      expect(validateReviewerModelSyntax('sonnet', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('claude-sonnet-4-6', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('claude:sonnet', 'claude', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('gpt-5.6-luna', 'codex', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('codex:gpt-5.6-luna', 'codex', (k) => k)).toBeNull();
      expect(validateReviewerModelSyntax('invalid model with space', 'codex', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateReviewerModelSyntax('codex:', 'codex', (k) => k)).toBe('settings.invalidModelSyntax');
      expect(validateReviewerModelSyntax('gpt-5.6-luna', 'claude', (k) => k)).toBe('settings.invalidChatModelSyntax');
      expect(validateReviewerModelSyntax('sonnet', 'codex', (k) => k)).toBe('settings.invalidModelSyntax');
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

    it('preserves old/inactive profiles in reviewer order without dropping them', async () => {
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'claude-active', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'gemini-3.8-flash-high',
          order: [
            { engine: 'claude', model: 'sonnet', profiles: ['claude-deleted-old', 'claude-active'] },
          ],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

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
        expect(screen.getByTestId('reviewer-order')).toBeInTheDocument();
      });

      // The old profile should still appear as an option with the inactive label
      const profileSelect = screen.getByLabelText(/Hồ sơ Claude review \(theo thứ tự ưu tiên\) 1/i);
      expect(profileSelect).toBeInTheDocument();
      expect(screen.getByText(/claude-deleted-old \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();
    });

    it('preserves inactive/deleted codexProfile with inactive label and retains it on save', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-active', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        brain: {
          engine: 'codex',
          codexProfile: 'codex-archived-legacy',
          mode: 'suggest',
          digest: { enabled: true, time: '18:00' },
          fallback: [],
        },
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'gemini-3.8-flash-high',
          order: [{ engine: 'claude', model: 'sonnet', profiles: [] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

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
        expect(screen.getByText(/Hồ sơ Codex cho Brain/i)).toBeInTheDocument();
      });

      // The inactive profile option should be present with the inactive label
      expect(screen.getByText(/codex-archived-legacy \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();

      // Click save and verify codex-archived-legacy was preserved
      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.brain?.codexProfile).toBe('codex-archived-legacy');
    });

    it('preserves fallback step pointing to an old profile absent from claudeProfiles and profiles list', async () => {
      const updateSpy = vi.spyOn(client, 'updateConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'claude-current', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        brain: {
          mode: 'suggest',
          digest: { enabled: true, time: '18:00' },
          fallback: [
            { type: 'profile', profile: 'legacy-fallback-claude' },
          ],
        },
        chat: { model: 'sonnet', models: ['sonnet', 'opus'] },
        reviewer: {
          model: 'gemini-3.8-flash-high',
          claudeProfiles: ['claude-current'],
          order: [{ engine: 'claude', model: 'sonnet', profiles: ['claude-current'] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          arbiter: { engine: 'claude', model: 'sonnet' },
        },
      } as any);

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
        expect(screen.getByText(/Claude fallback chain/i)).toBeInTheDocument();
      });

      // The fallback profile input should recognize legacy-fallback-claude as a preset option with inactive label
      expect(screen.getByText(/legacy-fallback-claude \(cũ \/ không khả dụng\)/i)).toBeInTheDocument();

      // Click save and verify fallback profile is retained
      const saveBtn = screen.getByRole('button', { name: /Lưu cấu hình/i });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateSpy).toHaveBeenCalled();
      });
      const payload = updateSpy.mock.calls[0][0];
      expect(payload.brain?.fallback?.[0]).toEqual({ type: 'profile', profile: 'legacy-fallback-claude' });
    });
  });

  describe('4. ProjectSettingsDrawer Reviewer Order, Fallback & Review Chain Integration', () => {
    let queryClient: QueryClient;

    const mockProject = {
      id: 'p1',
      name: 'XFarm',
      path: '/home/repo',
      defaultBranch: 'main',
      maxParallel: 2,
      settings: {
        integration: { enabled: true, branch: 'integration', baseRef: 'main' },
        commitConvention: { branchTemplate: 'agenthub/{slug}' },
        brain: { engine: 'claude', model: 'sonnet', mode: 'suggest', permissions: 'standard' },
        worktree: {},
        ci: {},
        references: [],
        reviewChecklist: [],
        notifications: { telegramContent: 'full' },
        review: {
          order: [{ engine: 'codex', model: 'codex:gpt-5.6-luna', profiles: ['codex-main'] }],
          fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
        },
      },
      review: {
        chain: [
          { reviewer: 'codex:gpt-5.6-luna', mode: 'gate' },
          { reviewer: 'claude', mode: 'final' },
        ],
        maxRounds: 2,
      },
    } as any;

    beforeEach(() => {
      queryClient = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        { name: 'codex-main', engine: 'codex', kind: 'isolated', home: '/home/codex', email: null, enabled: 1 } as any,
        { name: 'claude-main', engine: 'claude', kind: 'isolated', home: '/home/claude', email: null, enabled: 1 } as any,
      ]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({} as any);
      vi.spyOn(client, 'getFocus').mockResolvedValue({ projectId: null, since: null, pauseRunning: false } as any);
    });

    it('renders structured reviewer order and review chain controls without JSON textareas', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      // Open advanced settings section
      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Assert that old JSON textareas are NOT present
      expect(screen.queryByTestId('review-chain-textarea')).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Ghi đè thứ tự reviewer/i)).not.toBeInTheDocument();
      expect(screen.queryByLabelText(/Ghi đè fallback reviewer/i)).not.toBeInTheDocument();

      // Assert that interactive controls are present
      expect(screen.getAllByText('codex:gpt-5.6-luna').length).toBeGreaterThan(0);
      expect(screen.getAllByText('claude').length).toBeGreaterThan(0);
    });

    it('saves updated reviewer order and review chain correctly', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Add a review step
      const addStepBtn = screen.getByRole('button', { name: /Thêm bước review/i });
      fireEvent.click(addStepBtn);

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      expect(callArgs.review?.chain.length).toBe(3);
    });

    it('handleDiscard resets reviewerOrder, reviewerFallback, reviewChain and override flags to original state', async () => {
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={mockProject}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
      });

      // Initially review chain has 2 steps and reviewer order has 1 item
      expect(within(screen.getByTestId('project-review-chain')).getByText('1.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).getByText('2.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).queryByText('3.')).not.toBeInTheDocument();

      // Add a review step (chain now has 3 steps)
      const addStepBtn = screen.getByRole('button', { name: /Thêm bước review/i });
      fireEvent.click(addStepBtn);
      expect(within(screen.getByTestId('project-review-chain')).getByText('3.')).toBeInTheDocument();

      // Add a reviewer (reviewerOrder now has 2 items)
      const addReviewerBtn = screen.getByRole('button', { name: /Thêm reviewer/i });
      fireEvent.click(addReviewerBtn);
      expect(within(screen.getByTestId('project-reviewer-order')).getByText('2.')).toBeInTheDocument();

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Click "Huỷ" / Discard
      const discardBtn = screen.getByRole('button', { name: 'Huỷ' });
      fireEvent.click(discardBtn);

      // Unsaved changes bar should disappear
      expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();

      // Review steps and reviewer order should be restored to original counts
      expect(within(screen.getByTestId('project-review-chain')).queryByText('3.')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('project-review-chain')).getByText('2.')).toBeInTheDocument();
      expect(within(screen.getByTestId('project-reviewer-order')).queryByText('2.')).not.toBeInTheDocument();
      expect(within(screen.getByTestId('project-reviewer-order')).getByText('1.')).toBeInTheDocument();
    });

    it('preserves existing project.review when chain is empty and does not send review: null on unrelated changes', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
      const projectWithEmptyChain = {
        ...mockProject,
        review: {
          chain: [],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithEmptyChain}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Upon opening, unsaved changes bar MUST NOT be present
      expect(screen.queryByTestId('unsaved-changes-bar')).not.toBeInTheDocument();

      // The review chain override is preserved even with empty chain (displays empty notice, not system default)
      expect(within(screen.getByTestId('project-review-chain')).getByText(/Chưa có bước review nào/i)).toBeInTheDocument();

      // Modify an unrelated field: hooks
      const hooksTextarea = screen.getByTestId('hooks-textarea');
      fireEvent.change(hooksTextarea, { target: { value: 'echo "hello"' } });

      // Unsaved changes bar appears
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Save
      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      // review should NOT be in callArgs (or definitely not null!)
      expect(callArgs.review).toBeUndefined();
    });

    it('sends review: null only when user explicitly clicks useSystemDefault to remove review chain override', async () => {
      const updateProjectSpy = vi.spyOn(client, 'updateProject').mockResolvedValue(mockProject);
      const projectWithChain = {
        ...mockProject,
        review: {
          chain: [{ reviewer: 'claude', mode: 'final' }],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithChain}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
      });

      // Click "Dùng mặc định hệ thống" in the review chain block
      const chainBlock = screen.getByTestId('project-review-chain');
      const useSystemDefaultBtn = within(chainBlock).getByRole('button', { name: /Dùng mặc định hệ thống/i });
      fireEvent.click(useSystemDefaultBtn);

      // Unsaved changes bar should appear
      expect(screen.getByTestId('unsaved-changes-bar')).toBeInTheDocument();

      // Save
      const saveBtn = screen.getByRole('button', { name: 'Lưu' });
      fireEvent.click(saveBtn);

      await waitFor(() => {
        expect(updateProjectSpy).toHaveBeenCalled();
      });

      const callArgs = updateProjectSpy.mock.calls[0][1];
      // review must explicitly be null to clear override on backend
      expect(callArgs.review).toBeNull();
    });

    it('populates review chain and reviewer order options dynamically from getModelOptions without defaulting to custom', async () => {
      vi.spyOn(client, 'getModelOptions').mockResolvedValue({
        suggestions: ['codex:custom-model-dynamic', 'gemini-3.8-flash-high'],
        configured: ['codex:custom-model-dynamic', 'sonnet'],
      });

      const projectWithDynamicModel = {
        ...mockProject,
        settings: {
          ...mockProject.settings,
          review: {
            order: [{ engine: 'codex', model: 'codex:custom-model-dynamic', profiles: [] }],
            fallback: { onUnavailable: true, onError: true, onBusyAfterMin: 10 },
          },
        },
        review: {
          chain: [{ reviewer: 'codex:custom-model-dynamic', mode: 'gate' }],
          maxRounds: 2,
        },
      };

      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectSettingsDrawer
                  project={projectWithDynamicModel}
                  isOpen={true}
                  onClose={() => {}}
                />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      const advancedSummary = screen.getByTestId('advanced-settings-section').querySelector('summary');
      if (advancedSummary) fireEvent.click(advancedSummary);

      await waitFor(() => {
        expect(screen.getByTestId('project-review-chain')).toBeInTheDocument();
        expect(screen.getByTestId('project-reviewer-order')).toBeInTheDocument();
      });

      // Review step select should display codex:custom-model-dynamic as a known select option, NOT custom input
      const chainBlock = screen.getByTestId('project-review-chain');
      const stepSelect = within(chainBlock).getByRole('combobox', { name: /^Bước review 1$/i }) as HTMLSelectElement;
      expect(stepSelect.tagName.toLowerCase()).toBe('select');
      expect(stepSelect.value).toBe('codex:custom-model-dynamic');
      expect(within(stepSelect).getByRole('option', { name: 'codex:custom-model-dynamic' })).toBeInTheDocument();

      // Reviewer order select should also have codex:custom-model-dynamic as option
      const orderBlock = screen.getByTestId('project-reviewer-order');
      const reviewerSelect = within(orderBlock).getByRole('combobox', { name: /^Model reviewer 1$/i }) as HTMLSelectElement;
      expect(reviewerSelect.tagName.toLowerCase()).toBe('select');
      expect(reviewerSelect.value).toBe('codex:custom-model-dynamic');
    });
  });
});
