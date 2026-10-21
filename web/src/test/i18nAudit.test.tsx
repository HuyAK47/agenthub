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
        expect(screen.getByText('Plan review')).toBeInTheDocument();
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
  });
});
