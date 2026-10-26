import { apiFetch, getToken } from './client';
import { getActiveLocale } from '../utils/apiError';
import {
  ChatMessage,
  ChatSession,
  CreateChatSessionInput,
  SendMessageResponse,
  UpdateChatSessionInput,
  ChatPermissionRequest,
} from '../types/api';

export interface GetChatMessagesResponse {
  messages: ChatMessage[];
  hasMore: boolean;
}

export type ChatMessagesResult = ChatMessage[] & { hasMore?: boolean };

export function normalizeMessagesResponse(
  raw: GetChatMessagesResponse | ChatMessage[] | ChatMessagesResult | null | undefined,
): { messages: ChatMessage[]; hasMore: boolean } {
  if (!raw) return { messages: [], hasMore: false };
  if (Array.isArray(raw)) {
    return { messages: raw, hasMore: Boolean((raw as any).hasMore) };
  }
  return {
    messages: Array.isArray(raw.messages) ? raw.messages : [],
    hasMore: Boolean(raw.hasMore),
  };
}

export interface ChatSessionPage {
  items: ChatSession[];
  total: number;
  nextCursor: string | null;
}

export function getChatSessions(): Promise<ChatSession[]>;
export function getChatSessions(options: { search?: string; archived?: '0' | '1' | 'all'; limit: number; cursor?: string }): Promise<ChatSessionPage>;
export function getChatSessions(options: { search?: string; archived?: '0' | '1' | 'all'; limit?: undefined; cursor?: string }): Promise<ChatSession[]>;
export async function getChatSessions(options?: { search?: string; archived?: '0' | '1' | 'all'; limit?: number; cursor?: string }): Promise<ChatSession[] | ChatSessionPage> {
  const query = new URLSearchParams();
  if (options?.search) query.set('search', options.search);
  if (options?.archived) query.set('archived', options.archived);
  if (options?.limit) query.set('limit', String(options.limit));
  if (options?.cursor) query.set('cursor', options.cursor);
  const suffix = query.toString() ? `?${query.toString()}` : '';
  return options?.limit
    ? apiFetch<ChatSessionPage>(`/api/chat/sessions${suffix}`)
    : apiFetch<ChatSession[]>(`/api/chat/sessions${suffix}`);
}

export async function decideChatPermission(
  id: string,
  decision: 'allow' | 'deny' | 'allow_always',
  message?: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/chat/permissions/${encodeURIComponent(id)}`, {
    method: 'POST',
    body: JSON.stringify({ decision, message }),
  });
}

export async function getChatPermissions(sessionId: string): Promise<ChatPermissionRequest[]> {
  return apiFetch<ChatPermissionRequest[]>(`/api/chat/permissions?sessionId=${encodeURIComponent(sessionId)}`);
}

export interface PermissionRule { id: string; scope: string; sessionId: string | null; projectId: string | null; toolName: string; pattern: string; createdAt: string; createdBy: string }
export interface PermissionRulePage { items: PermissionRule[]; total: number; nextCursor: string | null }
export function getPermissionRules(): Promise<PermissionRule[]>;
export function getPermissionRules(options: { limit: number; cursor?: string }): Promise<PermissionRulePage>;
export async function getPermissionRules(options?: { limit: number; cursor?: string }): Promise<PermissionRule[] | PermissionRulePage> {
  const query = options ? `?limit=${options.limit}${options.cursor ? `&cursor=${encodeURIComponent(options.cursor)}` : ''}` : '';
  return options ? apiFetch<PermissionRulePage>(`/api/chat/permission-rules${query}`) : apiFetch<PermissionRule[]>('/api/chat/permission-rules');
}
export function deletePermissionRule(id: string): Promise<{ ok: boolean }> { return apiFetch(`/api/chat/permission-rules/${encodeURIComponent(id)}`, { method: 'DELETE' }); }

export async function createChatSession(
  data: CreateChatSessionInput,
): Promise<ChatSession> {
  return apiFetch<ChatSession>('/api/chat/sessions', {
    method: 'POST',
    body: JSON.stringify(data),
  });
}

export async function updateChatSession(
  id: string,
  data: UpdateChatSessionInput,
): Promise<ChatSession> {
  return apiFetch<ChatSession>(`/api/chat/sessions/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: JSON.stringify(data),
  });
}

export async function deleteChatSession(id: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(id)}`, {
    method: 'DELETE',
  });
}

export async function getChatMessages(
  sessionId: string,
  options?: { limit?: number; before?: string },
): Promise<ChatMessagesResult> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.before) params.set('before', options.before);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const res = await apiFetch<ChatMessage[] | { messages: ChatMessage[]; hasMore?: boolean }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages${qs}`,
  );
  const messages: ChatMessage[] = Array.isArray(res) ? res : res?.messages ?? [];
  return Object.assign(messages, {
    hasMore: Array.isArray(res) ? false : Boolean(res?.hasMore),
  });
}

export async function exportChatSession(sessionId: string): Promise<string> {
  const token = getToken();
  const res = await fetch(`/api/chat/sessions/${encodeURIComponent(sessionId)}/export`, {
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  if (!res.ok) {
    throw new Error(getActiveLocale() === 'en' ? 'Failed to export chat session' : 'Không thể xuất phiên trò chuyện');
  }
  return res.text();
}

export async function sendChatMessage(
  sessionId: string,
  text: string,
): Promise<SendMessageResponse> {
  return apiFetch<SendMessageResponse>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages`,
    {
      method: 'POST',
      body: JSON.stringify({ text }),
    },
  );
}

export async function warmChatSession(sessionId: string): Promise<{ ok: boolean; warmed: boolean }> {
  return apiFetch<{ ok: boolean; warmed: boolean }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/warm`, { method: 'POST' },
  );
}

export async function cancelChatSession(
  sessionId: string,
): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/cancel`,
    {
      method: 'POST',
    },
  );
}

export async function stopChatSession(sessionId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/stop`, { method: 'POST' },
  );
}

export async function retryChatLimitNow(sessionId: string): Promise<{ ok: boolean }> {
  return apiFetch<{ ok: boolean }>(`/api/chat/sessions/${encodeURIComponent(sessionId)}/limit-retry/now`, { method: 'POST' });
}

export async function compactChatSession(sessionId: string): Promise<{ ok: boolean; contextTokens?: number }> {
  return apiFetch<{ ok: boolean; contextTokens?: number }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/compact`,
    {
      method: 'POST',
    },
  );
}

export async function forkSummaryChatSession(sessionId: string): Promise<{ id: string; sessionId?: string }> {
  return apiFetch<{ id: string; sessionId?: string }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/fork-summary`,
    {
      method: 'POST',
    },
  );
}
