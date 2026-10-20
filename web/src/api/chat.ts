import { apiFetch } from './client';
import {
  ChatMessage,
  ChatSession,
  CreateChatSessionInput,
  SendMessageResponse,
  UpdateChatSessionInput,
  ChatPermissionRequest,
} from '../types/api';

export async function getChatSessions(): Promise<ChatSession[]> {
  return apiFetch<ChatSession[]>('/api/chat/sessions');
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
): Promise<ChatMessage[]> {
  // The API returns { messages, hasMore } (cursor pagination); older servers return an array.
  const res = await apiFetch<ChatMessage[] | { messages: ChatMessage[]; hasMore?: boolean }>(
    `/api/chat/sessions/${encodeURIComponent(sessionId)}/messages?limit=200`,
  );
  return Array.isArray(res) ? res : res?.messages ?? [];
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
