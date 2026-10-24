import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { vi as viLocale } from '../locales/vi';
import { en as enLocale } from '../locales/en';

import { ProfilesPage } from '../pages/ProfilesPage';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import { TasksPage } from '../pages/TasksPage';
import { ProjectsPage } from '../pages/ProjectsPage';
import { CreateTaskPage } from '../pages/CreateTaskPage';
import { SettingsPage } from '../pages/SettingsPage';
import { ChatPage } from '../pages/ChatPage';
import { PlansPage } from '../pages/PlansPage';
import { DashboardPage } from '../pages/DashboardPage';
import { SavingsPage } from '../pages/SavingsPage';
import { SetupPage } from '../pages/SetupPage';
import { TelegramCard } from '../components/TelegramCard';
import { translateApiErrorMessage } from '../utils/apiError';
import { formatTimeAgo } from '../lib/time';
import { browserNotificationBody } from '../notifications';

import * as client from '../api/client';
import * as chatApi from '../api/chat';
import * as sse from '../api/sse';

const VN_DIACRITICS_REGEX = /[àáạảãâầấậẩẫăằắặẳẵèéẹẻẽêềếệểễìíịỉĩòóọỏõôồốộổỗơờớợởỡùúụủũưừứựửữỳýỵỷỹđ]/i;

function getNestedKeys(obj: any, prefix = ''): string[] {
  const keys: string[] = [];
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
      keys.push(...getNestedKeys(obj[k], full));
    } else {
      keys.push(full);
    }
  }
  return keys.sort();
}

function assertNoVietnameseText(container: HTMLElement, pageName: string) {
  // 1. Text content of text nodes
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node = walker.nextNode();
  const textViolations: string[] = [];

  while (node) {
    const text = node.textContent?.trim();
    if (text && VN_DIACRITICS_REGEX.test(text)) {
      textViolations.push(text);
    }
    node = walker.nextNode();
  }

  // 2. Attributes: placeholder, title, aria-label
  const elements = container.querySelectorAll('*');
  elements.forEach((el) => {
    const placeholder = el.getAttribute('placeholder');
    if (placeholder && VN_DIACRITICS_REGEX.test(placeholder)) {
      textViolations.push(`placeholder: "${placeholder}"`);
    }
    const title = el.getAttribute('title');
    if (title && VN_DIACRITICS_REGEX.test(title)) {
      textViolations.push(`title: "${title}"`);
    }
    const ariaLabel = el.getAttribute('aria-label');
    if (ariaLabel && VN_DIACRITICS_REGEX.test(ariaLabel)) {
      textViolations.push(`aria-label: "${ariaLabel}"`);
    }
  });

  expect(
    textViolations,
    `Found Vietnamese accented text on ${pageName} in "en" locale: ${JSON.stringify(textViolations)}`,
  ).toEqual([]);
}

describe('i18n Audit & Parity', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
      },
    });

    vi.spyOn(sse, 'subscribeToEvents').mockImplementation(() => () => {});
    vi.spyOn(sse, 'subscribeToRunOutput').mockImplementation(() => () => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('Requirement 3: vi and en have identical key sets', () => {
    const viKeys = getNestedKeys(viLocale);
    const enKeys = getNestedKeys(enLocale);

    const missingInEn = viKeys.filter((k) => !enKeys.includes(k));
    const missingInVi = enKeys.filter((k) => !viKeys.includes(k));

    expect(missingInEn, 'Keys present in vi but missing in en').toEqual([]);
    expect(missingInVi, 'Keys present in en but missing in vi').toEqual([]);
    expect(enKeys).toEqual(viKeys);
  });

  it('Requirement 3b: Placeholder parameter parity between vi and en', () => {
    function getNestedEntries(obj: any, prefix = ''): [string, string][] {
      const entries: [string, string][] = [];
      for (const k of Object.keys(obj)) {
        const full = prefix ? `${prefix}.${k}` : k;
        if (typeof obj[k] === 'object' && obj[k] !== null && !Array.isArray(obj[k])) {
          entries.push(...getNestedEntries(obj[k], full));
        } else if (typeof obj[k] === 'string') {
          entries.push([full, obj[k]]);
        }
      }
      return entries;
    }

    const viEntries = new Map(getNestedEntries(viLocale));
    const enEntries = new Map(getNestedEntries(enLocale));

    const PLACEHOLDER_RE = /\{([a-zA-Z0-9_]+)\}/g;
    function extractPlaceholders(str: string): string[] {
      const matches: string[] = [];
      let m;
      while ((m = PLACEHOLDER_RE.exec(str)) !== null) {
        matches.push(m[1]);
      }
      return matches.sort();
    }

    const mismatches: Array<{ key: string; vi: string[]; en: string[] }> = [];

    for (const [key, viVal] of viEntries) {
      const enVal = enEntries.get(key);
      if (enVal !== undefined) {
        const viTokens = extractPlaceholders(viVal);
        const enTokens = extractPlaceholders(enVal);
        if (JSON.stringify(viTokens) !== JSON.stringify(enTokens)) {
          mismatches.push({ key, vi: viTokens, en: enTokens });
        }
      }
    }

    expect(mismatches, `Placeholder mismatches found: ${JSON.stringify(mismatches, null, 2)}`).toEqual([]);
  });

  it('Requirement 3c: web/src contains no hardcoded Vietnamese diacritics in user-facing JSX or string literals', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const violations: Array<{ file: string; line: number; text: string }> = [];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          scanDir(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          if (full.includes('locales/')) continue;
          if (full.includes('utils/apiError.ts')) continue;
          if (full.includes('notifications.ts')) continue;
          if (full.includes('lib/time.ts')) continue;
          if (full.includes('api/client.ts')) continue;
          if (full.includes('api/chat.ts')) continue;
          if (full.includes('mocks/')) continue;
          if (full.includes('.test.') || full.includes('__tests__') || full.includes('/test/')) continue;

          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('{/*')) return;
            if (trimmed.includes("locale === 'en'") || trimmed.includes("locale === 'vi'") || trimmed.includes("getActiveLocale()")) return;
            if (trimmed.includes(".includes('") || trimmed.includes('.includes("')) return;

            if (VN_DIACRITICS_REGEX.test(trimmed)) {
              violations.push({
                file: path.relative(process.cwd(), full),
                line: idx + 1,
                text: trimmed,
              });
            }
          });
        }
      }
    }

    const srcDir = fs.existsSync('web/src') ? 'web/src' : 'src';
    scanDir(srcDir);

    expect(violations, `Hardcoded Vietnamese strings found in source code: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  it('Requirement 3d: web/src contains no hardcoded English display patterns in JSX or attributes', async () => {
    const fs = await import('fs');
    const path = await import('path');

    const violations: Array<{ file: string; line: number; rule: string; text: string }> = [];
    const forbiddenPatterns: Array<{ regex: RegExp; rule: string }> = [
      { regex: /topic\s*#/, rule: 'Hardcoded topic # label' },
      { regex: /\}\s*process(es)?\b/, rule: 'Hardcoded process suffix in JSX' },
      { regex: /placeholder=["'](e\.g\.|123456:)/, rule: 'Hardcoded placeholder' },
      { regex: /title=["'](Move up|Move down|Remove)["']/, rule: 'Hardcoded button title' },
      { regex: /aria-label=["'](Model chain|Chat suggestions)["']/, rule: 'Hardcoded aria-label' },
    ];

    function scanDir(dir: string) {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.git') continue;
          scanDir(full);
        } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))) {
          if (full.includes('locales/')) continue;
          if (full.includes('mocks/')) continue;
          if (full.includes('.test.') || full.includes('__tests__') || full.includes('/test/')) continue;

          const content = fs.readFileSync(full, 'utf8');
          const lines = content.split('\n');
          lines.forEach((line, idx) => {
            const trimmed = line.trim();
            if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('{/*')) return;

            for (const { regex, rule } of forbiddenPatterns) {
              if (regex.test(trimmed)) {
                violations.push({
                  file: path.relative(process.cwd(), full),
                  line: idx + 1,
                  rule,
                  text: trimmed,
                });
              }
            }
          });
        }
      }
    }

    const srcDir = fs.existsSync('web/src') ? 'web/src' : 'src';
    scanDir(srcDir);

    expect(violations, `Hardcoded English UI patterns found in source code: ${JSON.stringify(violations, null, 2)}`).toEqual([]);
  });

  describe('Requirement 2: Render all in-scope pages in English without Vietnamese diacritics', () => {
    it('1. ProfilesPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProfiles').mockResolvedValue([
        {
          name: 'g1',
          engine: 'agy',
          kind: 'isolated',
          email: 'g1@example.com',
          loggedIn: true,
          enabled: 1,
          usage: [
            { grp: 'gemini', window: '5h', remainingPct: 80, resetAt: Math.floor(Date.now() / 1000) + 7200, fetchedAt: Date.now() },
          ],
        },
      ]);
      vi.spyOn(client, 'refreshProfileUsage').mockResolvedValue({} as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProfilesPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Account Management (Profiles)')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'ProfilesPage');
    });

    it('2. TaskDetailPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getTask').mockResolvedValue({
        id: 'proj1/task-1',
        projectId: 'proj1',
        slug: 'task-1',
        title: 'Sample Task Title',
        body: 'Sample description in English',
        level: 'easy',
        status: 'running',
        dependsOn: [],
        attempt: 1,
        resume: 0,
        createdAt: '2026-10-15T08:00:00Z',
        updatedAt: '2026-10-15T08:00:00Z',
        runs: [
          {
            id: 'run-1',
            taskId: 'proj1/task-1',
            engine: 'agy',
            model: 'gemini-3.8-flash',
            profileName: 'g1',
            startedAt: '2026-10-15T08:00:00Z',
            outcome: null,
          },
        ],
        checks: [{ name: 'lint', ok: true, exitCode: 0, durationMs: 1200, outputTail: 'all good' }],
        reviews: [],
      } as any);
      vi.spyOn(client, 'getTaskLog').mockResolvedValue('Worker executing task...\n');

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/tasks/proj1~task-1']}>
                <Routes>
                  <Route path="/tasks/:id" element={<TaskDetailPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Sample Task Title')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'TaskDetailPage');
    });

    it('3. TasksPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        { id: 'proj1', name: 'Project 1', path: '/home/user/proj1', defaultBranch: 'main', maxParallel: 2 },
      ]);
      vi.spyOn(client, 'getTasks').mockResolvedValue([
        {
          id: 'proj1/task-1',
          projectId: 'proj1',
          slug: 'task-1',
          title: 'Task Alpha',
          level: 'hard',
          status: 'running',
          dependsOn: [],
          attempt: 1,
          resume: 0,
        },
        {
          id: 'proj1/task-2',
          projectId: 'proj1',
          slug: 'task-2',
          title: 'Task Beta',
          level: 'easy',
          status: 'review',
          dependsOn: [],
          attempt: 0,
          resume: 0,
        },
      ] as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <TasksPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Task Management')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'TasksPage');
    });

    it('4. ProjectsPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        {
          id: 'proj1',
          name: 'Project 1',
          path: '/home/user/proj1',
          defaultBranch: 'main',
          maxParallel: 3,
          envTemplate: '{"PORT": 3000}',
        },
      ]);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <ProjectsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Project Management')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'ProjectsPage');
    });

    it('5. CreateTaskPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        { id: 'proj1', name: 'Project 1', path: '/home/user/proj1', defaultBranch: 'main', maxParallel: 2 },
      ]);
      vi.spyOn(client, 'getTasks').mockResolvedValue([]);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <CreateTaskPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Create New Task')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'CreateTaskPage');
    });

    it('6. SettingsPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        modelChainHard: ['gemini-3.8-flash-high'],
        modelChainEasy: ['gemini-3.8-flash-medium'],
        defaultTimeout: 10800,
        chat: {
          claudeBin: 'claude',
          allowFullMode: false,
          maxConcurrent: 2,
          model: 'sonnet',
        },
        savings: {
          bucketTokens: { gemini: 5000000, claude: 5000000 },
          claudeFactor: 0.9,
          claudeOverheadPerTask: 40000,
        },
      } as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
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
        expect(screen.getByText('System Settings')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'SettingsPage');
    });

    it('7. ChatPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(chatApi, 'getChatSessions').mockResolvedValue([
        {
          id: 'sess-1',
          title: 'Design Discussion',
          mode: 'safe',
          busy: false,
          updatedAt: new Date().toISOString(),
        },
      ]);
      vi.spyOn(chatApi, 'getChatMessages').mockResolvedValue([
        {
          id: 'msg-1',
          role: 'user',
          content: 'Hello Claude',
          createdAt: new Date().toISOString(),
        },
        {
          id: 'msg-2',
          role: 'assistant',
          content: 'Hello! How can I help you?',
          createdAt: new Date().toISOString(),
        },
      ]);
      vi.spyOn(chatApi, 'warmChatSession').mockResolvedValue({ ok: true, warmed: true });

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/chat/sess-1']}>
                <Routes>
                  <Route path="/chat/:sessionId" element={<ChatPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getAllByText('Design Discussion').length).toBeGreaterThan(0);
      });

      assertNoVietnameseText(container, 'ChatPage');
    });

    it('8. PlansPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        { id: 'proj1', name: 'Project 1', path: '/home/user/proj1', defaultBranch: 'main', maxParallel: 2 },
      ]);
      vi.spyOn(client, 'getBatches').mockResolvedValue([]);
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        planning: { requireApproval: false, approvalMinTasks: 0 },
      } as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/plans']}>
                <PlansPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Plans');
      });

      assertNoVietnameseText(container, 'PlansPage');
    });

    it('9. PlansPage with active batch renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        { id: 'proj1', name: 'Project 1', path: '/home/user/proj1', defaultBranch: 'main', maxParallel: 2 },
      ]);
      vi.spyOn(client, 'getBatches').mockResolvedValue([
        {
          id: 'b-1',
          projectId: 'proj1',
          title: 'Sprint 1 Plan',
          goal: 'Core architecture and dependencies',
          status: 'draft',
          createdBy: 'claude',
          createdAt: '2026-10-20T10:00:00Z',
          tasks: [],
        },
      ]);
      vi.spyOn(client, 'getBatch').mockResolvedValue({
        id: 'b-1',
        projectId: 'proj1',
        title: 'Sprint 1 Plan',
        goal: 'Core architecture and dependencies',
        status: 'draft',
        createdBy: 'claude',
        createdAt: '2026-10-20T10:00:00Z',
        tasks: [
          {
            id: 'proj1~task-1',
            projectId: 'proj1',
            slug: 'task-1',
            title: 'Setup routing',
            body: 'Implement routes',
            level: 'easy',
            status: 'draft',
            modelChain: ['gemini-3.8-flash-high'],
            dependsOn: [],
            attempt: 0,
            resume: 0,
            createdAt: '2026-10-20T10:00:00Z',
            updatedAt: '2026-10-20T10:00:00Z',
            batchId: 'b-1',
          },
        ],
      });
      vi.spyOn(client, 'getConfig').mockResolvedValue({
        planning: { requireApproval: true },
      } as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter initialEntries={['/plans/b-1']}>
                <Routes>
                  <Route path="/plans/:batchId" element={<PlansPage />} />
                </Routes>
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getAllByText('Sprint 1 Plan').length).toBeGreaterThan(0);
      });

      assertNoVietnameseText(container, 'PlansPage with active batch');
    });

    it('10. DashboardPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getStatus').mockResolvedValue({
        tasks: { running: 1, waiting_quota: 0, queued: 0 },
        running: [
          {
            taskId: 'p1/t1',
            projectId: 'p1',
            slug: 't1',
            title: 'Sample running task',
            status: 'running',
            engine: 'agy',
            model: 'gemini-3.8-flash',
            profile: 'g1',
            workerRssMb: 120,
            workerCpuPct: 15,
            startedAt: new Date(Date.now() - 60000).toISOString(),
          },
        ],
        disk: { freeGB: 20, totalGB: 100 },
        orphanProcesses: [],
        quota: { profiles: [], claudeProfiles: [], accounts: [] },
        claudeFailover: { active: false, status: 'off', currentStep: 0, dailyCostUSD: 0 },
      } as any);
      vi.spyOn(client, 'getProjects').mockResolvedValue([
        { id: 'p1', name: 'Project 1', path: '/path/to/p1', defaultBranch: 'main', maxParallel: 2 },
      ]);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getClaudeQuota').mockResolvedValue({ profiles: [] } as any);
      vi.spyOn(client, 'getClaudeFailover').mockResolvedValue({ active: false } as any);
      vi.spyOn(client, 'getEventHistoryPage').mockResolvedValue({ events: [], hasMore: false } as any);
      vi.spyOn(client, 'getBrain').mockResolvedValue({ mode: 'auto' } as any);
      vi.spyOn(client, 'getPerf').mockResolvedValue([] as any);
      vi.spyOn(client, 'getOrphans').mockResolvedValue([] as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <DashboardPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('System Overview')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'DashboardPage');
    });

    it('11. SavingsPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getSavings').mockResolvedValue({
        summary: {
          totalWorkerTokens: 100000,
          claudeSavedTokens: 90000,
          claudeCostTokens: 30000,
          savingsRatio: 0.7,
          totalLinesAdded: 50,
          totalLinesDeleted: 10,
          totalLinesChanged: 60,
          tasksApprovedCount: 2,
          avgReviewRounds: 1,
        },
        byEngine: {},
        byModel: {},
        byDay: [],
        tasks: [
          {
            taskId: 'p1/t1',
            slug: 't1',
            title: 'Task Alpha',
            projectId: 'p1',
            status: 'done',
            model: 'gemini-3.8-flash-high',
            engine: 'agy',
            linesAdded: 50,
            linesDeleted: 10,
            filesChanged: 2,
            tokens: 100000,
            estimated: false,
            reviewRounds: 1,
            durationMs: 30000,
            completedAt: '2026-10-20T10:00:00.000Z',
          },
        ],
      } as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SavingsPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Delegation Savings')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'SavingsPage');
    });

    it('12. SetupPage renders in en without Vietnamese characters', async () => {
      vi.spyOn(client, 'getSetupStatus').mockResolvedValue({
        node: { version: 'v22.21.1', ok: true },
        git: { version: '2.25.1', installed: true },
        tools: [
          { id: 'claude', installed: true, version: '1.0.0', path: '/bin/claude', manual: false, installing: false },
          { id: 'codex', installed: true, version: '1.0.0', path: '/bin/codex', manual: false, installing: false },
          { id: 'agy', installed: true, version: '1.0.0', path: '/bin/agy', manual: false, installing: false },
        ],
        profiles: [
          { name: 'default', engine: 'agy', kind: 'keyring', loggedIn: true, enabled: 1 },
        ],
        mcpRegistered: true,
        serviceRunning: true,
      } as any);

      const { container } = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <SetupPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('Get started with AgentHub')).toBeInTheDocument();
      });

      assertNoVietnameseText(container, 'SetupPage');
    });
  });

  describe('Backend API error message translation', () => {
    it('translates exact Vietnamese backend messages into English when in en locale', () => {
      expect(translateApiErrorMessage('Chỉ thị không tồn tại', undefined, 'en')).toBe('Directive does not exist');
      expect(translateApiErrorMessage('Mục kiến thức không tồn tại', undefined, 'en')).toBe('Knowledge entry does not exist');
      expect(translateApiErrorMessage('Database chưa sẵn sàng', undefined, 'en')).toBe('Database is not ready');
      expect(translateApiErrorMessage('Không thể xóa hồ sơ hệ thống', undefined, 'en')).toBe('Cannot delete system profile');
    });

    it('translates dynamic patterned messages into English with preserved parameters', () => {
      expect(translateApiErrorMessage('Không thể xóa hồ sơ "worker-1" đang chạy task', undefined, 'en'))
        .toBe('Cannot delete profile "worker-1" while running a task');
      expect(translateApiErrorMessage('Nhánh mặc định "dev" không tồn tại trong repository', undefined, 'en'))
        .toBe('Default branch "dev" does not exist in repository');
      expect(translateApiErrorMessage('Thư mục repo không tồn tại: /tmp/repo', undefined, 'en'))
        .toBe('Repository directory does not exist: /tmp/repo');
    });

    it('translates standard error codes when message is code-based', () => {
      expect(translateApiErrorMessage('conflict', 'conflict', 'en')).toBe('Resource conflict');
      expect(translateApiErrorMessage('cycle_detected', 'cycle_detected', 'en')).toBe('Dependency cycle detected');
      expect(translateApiErrorMessage('rate_limited', 'rate_limited', 'en')).toBe('Rate limit exceeded');
      expect(translateApiErrorMessage('conflict', 'conflict', 'vi')).toBe('Xung đột dữ liệu');
      expect(translateApiErrorMessage('not_found', 'not_found', 'vi')).toBe('Không tìm thấy tài nguyên');
    });

    it('falls back to localized error code translation when payload has code and unmapped Vietnamese message', () => {
      expect(translateApiErrorMessage('Một lỗi xung đột chưa có regex riêng', 'conflict', 'en'))
        .toBe('Resource conflict');
      expect(translateApiErrorMessage('Lỗi yêu cầu không xác định được mẫu', 'bad_request', 'en'))
        .toBe('Bad request');
      expect(translateApiErrorMessage('Tài nguyên không tìm thấy theo id mới', 'not_found', 'en'))
        .toBe('Resource not found');
    });

    it('translates merge and chat backend messages accurately', () => {
      expect(translateApiErrorMessage('Merge bị xung đột', 'conflict', 'en')).toBe('Merge conflict');
      expect(translateApiErrorMessage('Xung đột merge ở: src/index.ts, src/app.ts', 'conflict', 'en'))
        .toBe('Merge conflict in: src/index.ts, src/app.ts');
      expect(translateApiErrorMessage('worktree tích hợp có thay đổi chưa commit', 'conflict', 'en'))
        .toBe('Integration worktree has uncommitted changes');
      expect(translateApiErrorMessage('Không thể đổi quyền khi brain đang chạy', 'conflict', 'en'))
        .toBe('Cannot change permissions while brain is running');
      expect(translateApiErrorMessage('Phiên đang bận', 'conflict', 'en')).toBe('Session is busy');
    });

    it('preserves Vietnamese text when active locale is vi', () => {
      expect(translateApiErrorMessage('Chỉ thị không tồn tại', undefined, 'vi')).toBe('Chỉ thị không tồn tại');
      expect(translateApiErrorMessage('Không thể xóa hồ sơ "worker-1" đang chạy task', undefined, 'vi'))
        .toBe('Không thể xóa hồ sơ "worker-1" đang chạy task');
    });
  });

  describe('Date, time, and relative time formatting by locale', () => {
    it('formats relative time correctly in vi and en', () => {
      const now = 1700000000000;
      expect(formatTimeAgo(now - 15000, now, 'vi')).toBe('15 giây trước');
      expect(formatTimeAgo(now - 15000, now, 'en')).toBe('15s ago');

      expect(formatTimeAgo(now - 120000, now, 'vi')).toBe('2 phút trước');
      expect(formatTimeAgo(now - 120000, now, 'en')).toBe('2m ago');

      expect(formatTimeAgo(now - 7200000, now, 'vi')).toBe('2 giờ trước');
      expect(formatTimeAgo(now - 7200000, now, 'en')).toBe('2h ago');

      expect(formatTimeAgo(now - 86400000 * 3, now, 'vi')).toBe('3 ngày trước');
      expect(formatTimeAgo(now - 86400000 * 3, now, 'en')).toBe('3d ago');

      expect(formatTimeAgo(NaN, now, 'vi')).toBe('chưa rõ thời gian');
      expect(formatTimeAgo(NaN, now, 'en')).toBe('time unknown');
      expect(formatTimeAgo('invalid-date', now, 'vi')).toBe('chưa rõ thời gian');
      expect(formatTimeAgo('invalid-date', now, 'en')).toBe('time unknown');
    });
  });

  describe('Browser notifications localization', () => {
    it('formats notification body in Vietnamese and English', () => {
      const taskEvent = {
        type: 'task.review_ready',
        taskId: 'p1/t1',
        payload: { title: 'Implement Auth' },
      };
      expect(browserNotificationBody(taskEvent as any, 'vi')).toContain('Implement Auth chờ review');
      expect(browserNotificationBody(taskEvent as any, 'en')).toContain('Implement Auth waiting for review');

      const diskEvent = {
        type: 'disk.low',
        payload: { freeGB: 2.5, minFreeGB: 5 },
      };
      expect(browserNotificationBody(diskEvent as any, 'vi')).toContain('Ổ đĩa còn 2.5 GB');
      expect(browserNotificationBody(diskEvent as any, 'en')).toContain('Disk space low: 2.5 GB');
    });
  });

  describe('Specific UI Component Localization', () => {
    it('TelegramCard renders topic and placeholder localized in vi and en', async () => {
      vi.spyOn(client, 'getTelegramStatus').mockResolvedValue({
        enabled: true,
        hasToken: false,
        topicMode: 'department',
        allowedChatIds: [100],
        chats: [],
        departmentTopics: { 'd-1': { chatId: 100, threadId: 42 } },
        projectTopics: {},
        notify: {} as any,
      } as any);
      vi.spyOn(client, 'getTelegramPairingCode').mockResolvedValue({
        code: '123456',
        expiresInSec: 300,
        enabled: true,
        allowedChatIds: [100],
        chats: [],
      });
      vi.spyOn(client, 'getDepartments').mockResolvedValue([{ id: 'd-1', name: 'DevOps', telegramTopicId: 42 } as any]);
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);

      // EN render
      const enView = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <TelegramCard />
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('topic #42')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('e.g. 123456:ABC...')).toBeInTheDocument();
      });
      enView.unmount();

      // VI render
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <TelegramCard />
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText('chủ đề #42')).toBeInTheDocument();
        expect(screen.getByPlaceholderText('Ví dụ: 123456:ABC...')).toBeInTheDocument();
      });
    });

    it('DashboardPage perf card renders process count localized in vi and en', async () => {
      vi.spyOn(client, 'getStatus').mockResolvedValue({
        tasks: { running: 0, waiting_quota: 0, queued: 0 },
        running: [],
        disk: { freeGB: 20, totalGB: 100 },
        orphanProcesses: [],
        quota: { profiles: [], claudeProfiles: [], accounts: [] },
        claudeFailover: { active: false, status: 'off', currentStep: 0, dailyCostUSD: 0 },
      } as any);
      vi.spyOn(client, 'getProjects').mockResolvedValue([]);
      vi.spyOn(client, 'getProfiles').mockResolvedValue([]);
      vi.spyOn(client, 'getClaudeQuota').mockResolvedValue({ profiles: [] } as any);
      vi.spyOn(client, 'getClaudeFailover').mockResolvedValue({ active: false } as any);
      vi.spyOn(client, 'getEventHistoryPage').mockResolvedValue({ events: [], hasMore: false } as any);
      vi.spyOn(client, 'getBrain').mockResolvedValue({ mode: 'auto' } as any);
      vi.spyOn(client, 'getPerf').mockResolvedValue({
        latest: {
          at: Date.now(),
          cpuCount: 4,
          groups: {
            worker: { cpuPercent: 10, rssBytes: 1024 ** 3 * 2, processes: 2 },
            hub: { cpuPercent: 5, rssBytes: 1024 ** 3 * 1, processes: 1 },
          },
        },
        samples: [],
      } as any);
      vi.spyOn(client, 'getOrphans').mockResolvedValue([] as any);

      // EN render
      const enView = render(
        <LocaleProvider initialLocale="en">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <DashboardPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/2 processes/)).toBeInTheDocument();
        expect(screen.getByText(/1 process\b/)).toBeInTheDocument();
      });
      enView.unmount();

      // VI render
      render(
        <LocaleProvider initialLocale="vi">
          <ThemeProvider>
            <QueryClientProvider client={queryClient}>
              <MemoryRouter>
                <DashboardPage />
              </MemoryRouter>
            </QueryClientProvider>
          </ThemeProvider>
        </LocaleProvider>,
      );

      await waitFor(() => {
        expect(screen.getByText(/2 tiến trình/)).toBeInTheDocument();
        expect(screen.getByText(/1 tiến trình/)).toBeInTheDocument();
      });
    });
  });
});
