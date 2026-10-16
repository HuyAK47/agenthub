import React, { useEffect, Suspense, lazy } from 'react';
import { BrowserRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ThemeProvider } from './context/ThemeContext';
import { LocaleProvider } from './context/LocaleContext';
import { AuthGate } from './components/AuthGate';
import { Layout } from './components/Layout';
import { SavingsPage } from './pages/SavingsPage';
import { connectSSE } from './api/sse';
import { ClaudeSessionsPage } from './pages/ClaudeSessionsPage';

const DashboardPage = lazy(() => import('./pages/DashboardPage').then((m) => ({ default: m.DashboardPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then((m) => ({ default: m.TasksPage })));
const CreateTaskPage = lazy(() => import('./pages/CreateTaskPage').then((m) => ({ default: m.CreateTaskPage })));
const TaskDetailPage = lazy(() => import('./pages/TaskDetailPage').then((m) => ({ default: m.TaskDetailPage })));
const ProfilesPage = lazy(() => import('./pages/ProfilesPage').then((m) => ({ default: m.ProfilesPage })));
const ChatPage = lazy(() => import('./pages/ChatPage').then((m) => ({ default: m.ChatPage })));
const ProjectsPage = lazy(() => import('./pages/ProjectsPage').then((m) => ({ default: m.ProjectsPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then((m) => ({ default: m.SettingsPage })));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 3000,
    },
  },
});

export const App: React.FC = () => {
  useEffect(() => {
    // Start SSE stream connection and automatic cache invalidation
    const cleanupSSE = connectSSE(queryClient);
    return () => {
      cleanupSSE();
    };
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <LocaleProvider>
          <AuthGate>
          <BrowserRouter>
            <Suspense
              fallback={
                <div className="flex items-center justify-center p-12">
                  <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
                </div>
              }
            >
              <Routes>
                <Route path="/" element={<Layout />}>
                  <Route index element={<DashboardPage />} />
                  <Route path="chat" element={<ChatPage />} />
                  <Route path="chat/:sessionId" element={<ChatPage />} />
                  <Route path="claude-sessions" element={<ClaudeSessionsPage />} />
                  <Route path="claude-sessions/:sessionId" element={<ClaudeSessionsPage />} />
                  <Route path="tasks" element={<TasksPage />} />
                  <Route path="tasks/new" element={<CreateTaskPage />} />
                  <Route path="tasks/:id" element={<TaskDetailPage />} />
                  <Route path="savings" element={<SavingsPage />} />
                  <Route path="profiles" element={<ProfilesPage />} />
                  <Route path="projects" element={<ProjectsPage />} />
                  <Route path="settings" element={<SettingsPage />} />
                </Route>
              </Routes>
            </Suspense>
          </BrowserRouter>
          </AuthGate>
        </LocaleProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
};
