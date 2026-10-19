import {
  BrainStatus,
  ClaudeQuota,
  CheckProfileResponse,
  CreateProfileInput,
  CreateProjectInput,
  CreateTaskInput,
  HubStatus,
  LoginSessionResponse,
  Profile,
  Project,
  RetryTaskInput,
  ReviewTaskInput,
  SystemConfig,
  Task,
  TaskDetail,
  UpdateProjectInput,
  UpdateTaskInput,
  VersionResponse,
  SavingsReport,
  OrphanProcess,
} from '../types/api';

const TOKEN_STORAGE_KEY = 'agenthub_token';

let unauthorizedListeners: Array<() => void> = [];

export class AuthError extends Error {
  constructor(message = 'Chưa xác thực hoặc token không hợp lệ') {
    super(message);
    this.name = 'AuthError';
  }
}

export function subscribeUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.push(listener);
  return () => {
    unauthorizedListeners = unauthorizedListeners.filter((l) => l !== listener);
  };
}

function notifyUnauthorized() {
  for (const listener of unauthorizedListeners) {
    try {
      listener();
    } catch {
      // ignore listener error
    }
  }
}

export function getToken(): string | null {
  return sessionStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  sessionStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  sessionStorage.removeItem(TOKEN_STORAGE_KEY);
  notifyUnauthorized();
}

/**
 * Reads token from window.location.hash (#token=...)
 * Stores it into sessionStorage and cleans the hash from the URL.
 */
export function initTokenFromHash(): string | null {
  if (typeof window === 'undefined') return null;

  const hash = window.location.hash;
  if (hash) {
    const match = hash.match(/(?:^#|&|\?)token=([^&]+)/);
    if (match && match[1]) {
      const token = decodeURIComponent(match[1]);
      setToken(token);
      // Remove hash from URL without reloading
      const cleanUrl = window.location.pathname + window.location.search;
      window.history.replaceState(null, '', cleanUrl);
      return token;
    }
  }
  return getToken();
}

export async function apiFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getToken();
  if (!token) {
    notifyUnauthorized();
    throw new AuthError('Thiếu token xác thực');
  }

  const headers = new Headers(options.headers || {});
  headers.set('Authorization', `Bearer ${token}`);

  if (options.body && typeof options.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(path, {
    ...options,
    headers,
  });

  if (response.status === 401) {
    clearToken();
    throw new AuthError('Token không hợp lệ hoặc đã hết hạn');
  }

  if (!response.ok) {
    let errorMsg = `Lỗi ${response.status}: ${response.statusText}`;
    try {
      const errJson = await response.json();
      if (errJson) {
        if (errJson.message) {
          errorMsg = errJson.message;
        } else if (errJson.error) {
          errorMsg = errJson.error;
        }
      }
    } catch {
      try {
        const errText = await response.text();
        if (errText) errorMsg = errText;
      } catch {
        // fallback
      }
    }
    const err: any = new Error(errorMsg);
    err.status = response.status;
    throw err;
  }

  // Handle empty or text responses
  const contentType = response.headers.get('content-type');
  if (contentType && contentType.includes('application/json')) {
    return (await response.json()) as T;
  }
  return (await response.text()) as unknown as T;
}

// API methods
export async function getVersion(): Promise<VersionResponse | null> {
  try {
    return await apiFetch<VersionResponse>('/api/version');
  } catch (err: any) {
    if (err?.status === 404 || err?.message?.includes('404')) {
      return null;
    }
    throw err;
  }
}
export async function getStatus(): Promise<HubStatus> {
  return apiFetch<HubStatus>('/api/status');
}

export async function getOrphans(): Promise<OrphanProcess[]> {
  return apiFetch<OrphanProcess[]>('/api/system/orphans');
}

export async function reapOrphans(): Promise<{ ok: boolean; reaped: number[] }> {
  return apiFetch<{ ok: boolean; reaped: number[] }>('/api/system/orphans/reap', { method: 'POST' });
}

export async function getBrain(): Promise<BrainStatus> {
  return apiFetch<BrainStatus>('/api/brain');
}

export async function getClaudeQuota(): Promise<ClaudeQuota> {
  return apiFetch<ClaudeQuota>('/api/claude/quota');
}

export type ClaudeFailover = {
  active: boolean;
  until: number | null;
  reason: string | null;
  activatedAt: number | null;
  evidence?: { file: string; line: number; observedAt: string } | null;
  lastActivityAt?: string | null;
};

export async function getClaudeFailover(): Promise<ClaudeFailover> {
  return apiFetch<ClaudeFailover>('/api/claude/failover');
}

export async function clearClaudeFailover(): Promise<ClaudeFailover> {
  return apiFetch<ClaudeFailover>('/api/claude/failover/clear', { method: 'POST' });
}

export async function rescanClaudeSessions(): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>('/api/claude/sessions/rescan', { method: 'POST' });
}

export async function getProjects(): Promise<Project[]> {
  return apiFetch<Project[]>('/api/projects');
}

export async function createProject(data: CreateProjectInput): Promise<Project> {
  return apiFetch<Project>('/api/projects', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateProject(id: string, data: UpdateProjectInput): Promise<Project> {
  return apiFetch<Project>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteProject(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/projects/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getProfiles(): Promise<Profile[]> {
  return apiFetch<Profile[]>('/api/profiles');
}

export async function refreshProfileUsage(name: string): Promise<Profile> {
  return apiFetch<Profile>(`/api/profiles/${encodeURIComponent(name)}/usage/refresh`, { method: 'POST' });
}

export async function createProfile(data: CreateProfileInput): Promise<Profile> {
  return apiFetch<Profile>('/api/profiles', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function loginProfile(name: string): Promise<LoginSessionResponse> {
  return apiFetch<LoginSessionResponse>(`/api/profiles/${encodeURIComponent(name)}/login`, {
    method: 'POST',
  });
}

export async function checkProfile(name: string): Promise<CheckProfileResponse> {
  return apiFetch<CheckProfileResponse>(`/api/profiles/${encodeURIComponent(name)}/check`, {
    method: 'POST',
  });
}

export async function updateProfile(
  name: string,
  data: { enabled: boolean | number },
): Promise<Profile> {
  return apiFetch<Profile>(`/api/profiles/${encodeURIComponent(name)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function markQuota(
  name: string,
  data: { family: string; seconds?: number; reason?: string },
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/profiles/${encodeURIComponent(name)}/quota`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function deleteQuota(name: string, family: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/profiles/${encodeURIComponent(name)}/quota?family=${encodeURIComponent(family)}`,
    {
      method: 'DELETE',
    },
  );
}

export async function getTasks(params?: {
  project?: string;
  status?: string;
}): Promise<Task[]> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.status) query.set('status', params.status);
  const qStr = query.toString();
  return apiFetch<Task[]>(`/api/tasks${qStr ? `?${qStr}` : ''}`);
}

export async function createTask(data: CreateTaskInput): Promise<Task> {
  return apiFetch<Task>('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function getTask(id: string): Promise<TaskDetail> {
  return apiFetch<TaskDetail>(`/api/tasks/${encodeURIComponent(id)}`);
}

export async function updateTask(id: string, data: UpdateTaskInput): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function rerunChecks(id: string): Promise<{ passed: boolean; failed: string[] }> {
  return apiFetch<{ passed: boolean; failed: string[] }>(`/api/tasks/${encodeURIComponent(id)}/checks/rerun`, { method: 'POST' });
}

export async function startTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/start`, {
    method: 'POST',
  });
}

export async function cancelTask(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/cancel`, {
    method: 'POST',
  });
}

export async function reviewTask(
  id: string,
  data: ReviewTaskInput,
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/review`, {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function retryTask(
  id: string,
  data?: RetryTaskInput,
): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/retry`, {
    method: 'POST',
    body: JSON.stringify(data || {}),
  });
}

export async function retryReviewer(id: string): Promise<Task> {
  return apiFetch<Task>(`/api/tasks/${encodeURIComponent(id)}/review/retry-reviewer`, {
    method: 'POST',
  });
}

export async function deleteWorktree(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/tasks/${encodeURIComponent(id)}/worktree`, {
    method: 'DELETE',
  });
}

export async function getTaskLog(
  id: string,
  params?: { run?: string; tail?: number },
): Promise<string> {
  const query = new URLSearchParams();
  if (params?.run) query.set('run', params.run);
  if (params?.tail) query.set('tail', String(params.tail));
  const qStr = query.toString();
  return apiFetch<string>(`/api/tasks/${encodeURIComponent(id)}/log${qStr ? `?${qStr}` : ''}`);
}

export async function getConfig(): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/config');
}

export async function updateConfig(data: SystemConfig): Promise<SystemConfig> {
  return apiFetch<SystemConfig>('/api/config', {
    method: 'PUT',
    body: JSON.stringify(data),
  });
}

export async function getSavings(params?: { project?: string; since?: string }): Promise<SavingsReport> {
  const query = new URLSearchParams();
  if (params?.project) query.set('project', params.project);
  if (params?.since) query.set('since', params.since);
  const qStr = query.toString();
  return apiFetch<SavingsReport>(`/api/savings${qStr ? `?${qStr}` : ''}`);
}
