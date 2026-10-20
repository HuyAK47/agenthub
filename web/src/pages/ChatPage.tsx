import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  stopChatSession,
  createChatSession,
  deleteChatSession,
  getChatMessages,
  getChatSessions,
  sendChatMessage,
  warmChatSession,
} from '../api/chat';
import { subscribeToEvents } from '../api/sse';
import { ChatMessage, ChatMode, ChatSession } from '../types/api';
import { ChatSessionList } from '../components/chat/ChatSessionList';
import { ChatMessageItem } from '../components/chat/ChatMessageItem';
import { ToolChipsGroup } from '../components/chat/ToolChipsGroup';
import { ChatInput } from '../components/chat/ChatInput';
import { NewSessionModal } from '../components/chat/NewSessionModal';
import { ScrollToBottomButton } from '../components/chat/ScrollToBottomButton';
import { useLocale } from '../context/LocaleContext';
import {
  Menu,
  X,
  AlertCircle,
  Plus,
  Bot,
} from 'lucide-react';

const EMPTY_SESSIONS: ChatSession[] = [];

export const ChatPage: React.FC = () => {
  const { t } = useLocale();
  const { sessionId } = useParams<{ sessionId?: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [mobileDrawerOpen, setMobileDrawerOpen] = useState(false);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  const [streamingMessageId, setStreamingMessageId] = useState<string | null>(null);
  const [isLocalBusy, setIsLocalBusy] = useState(false);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  const messagesEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);
  const isAtBottomRef = useRef(true);

  // Auto-dismiss toast
  useEffect(() => {
    if (!toastMessage) return;
    const timer = setTimeout(() => setToastMessage(null), 3000);
    return () => clearTimeout(timer);
  }, [toastMessage]);

  // Fetch chat sessions
  const {
    data: sessions = EMPTY_SESSIONS,
    isLoading: isSessionsLoading,
  } = useQuery({
    queryKey: ['chatSessions'],
    queryFn: getChatSessions,
  });

  // Resolve active session
  const activeSession = useMemo(() => {
    if (sessionId) {
      return sessions.find((s) => s.id === sessionId) || null;
    }
    return null;
  }, [sessionId, sessions]);

  // Navigate to first session if no sessionId specified
  useEffect(() => {
    if (!sessionId && sessions.length > 0 && !isSessionsLoading) {
      navigate(`/chat/${sessions[0].id}`, { replace: true });
    }
  }, [sessionId, sessions, isSessionsLoading, navigate]);

  // Fetch messages for active session
  const {
    data: remoteMessages,
    isLoading: isMessagesLoading,
  } = useQuery({
    queryKey: ['chatMessages', activeSession?.id],
    queryFn: () => getChatMessages(activeSession!.id),
    enabled: !!activeSession?.id,
  });

  // Local messages state for responsive streaming
  const [messages, setMessages] = useState<ChatMessage[]>([]);

  useEffect(() => {
    if (remoteMessages) {
      setMessages(remoteMessages);
    }
  }, [remoteMessages]);

  useEffect(() => {
    if (activeSession?.id) warmChatSession(activeSession.id).catch(() => {});
  }, [activeSession?.id]);

  const [thinkingSince, setThinkingSince] = useState<number | null>(null);
  const [thinkingSeconds, setThinkingSeconds] = useState(0);
  const [currentTool, setCurrentTool] = useState<string | null>(null);
  const [toolStepCount, setToolStepCount] = useState(0);
  const isBusy = Boolean(activeSession?.busy || isLocalBusy || streamingMessageId);

  useEffect(() => {
    if (!isBusy) { setThinkingSince(null); setThinkingSeconds(0); setToolStepCount(0); return; }
    const started = thinkingSince || Date.now();
    if (!thinkingSince) setThinkingSince(started);
    const timer = setInterval(() => setThinkingSeconds(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => clearInterval(timer);
  }, [isBusy, thinkingSince]);

  // Scroll position management
  const handleScroll = () => {
    const container = messagesContainerRef.current;
    if (!container) return;
    const { scrollTop, scrollHeight, clientHeight } = container;
    const distanceToBottom = scrollHeight - scrollTop - clientHeight;
    const isAtBottom = distanceToBottom < 60;
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) {
      setShowScrollBottom(false);
    }
  };

  const scrollToBottom = (smooth = true) => {
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      try {
        messagesEndRef.current.scrollIntoView({
          behavior: smooth ? 'smooth' : 'auto',
        });
      } catch {
        // ignore in jsdom environments
      }
    }
    setShowScrollBottom(false);
    isAtBottomRef.current = true;
  };

  // Auto-scroll when messages update if user was at bottom
  useEffect(() => {
    if (isAtBottomRef.current) {
      scrollToBottom();
    } else {
      setShowScrollBottom(true);
    }
  }, [messages, streamingMessageId]);

  // Listen to SSE Events
  useEffect(() => {
    const unsub = subscribeToEvents((event) => {
      const type = event.type;
      const payload = event.payload || {};
      const targetSessionId = payload.sessionId;

      if (!targetSessionId || targetSessionId !== activeSession?.id) {
        return;
      }

      if (type === 'chat.delta') {
        const { messageId, text } = payload;
        setStreamingMessageId(messageId);
        setIsLocalBusy(true);

        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === messageId);
          if (index !== -1) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              content: updated[index].content + text,
            };
            return updated;
          }
          // If message does not exist yet, add new assistant message
          const newMsg: ChatMessage = {
            id: messageId,
            role: 'assistant',
            content: text,
            createdAt: new Date().toISOString(),
          };
          return [...prev, newMsg];
        });
      } else if (type === 'chat.tool') {
        const { messageId, name, summary } = payload;
        setToolStepCount((count) => count + 1);
        setCurrentTool(summary || name || null);
        setMessages((prev) => {
          if (prev.some((m) => m.id === messageId)) return prev;
          const toolMsg: ChatMessage = {
            id: messageId,
            role: 'tool',
            content: summary || name,
            meta: { name, summary },
            createdAt: new Date().toISOString(),
          };
          return [...prev, toolMsg];
        });
      } else if (type === 'chat.done') {
        const { messageId, durationMs, costUsd, numTurns } = payload;
        setStreamingMessageId(null);
        setIsLocalBusy(false);
        setCurrentTool(null);

        setMessages((prev) => {
          const index = prev.findIndex((m) => m.id === messageId);
          if (index !== -1) {
            const updated = [...prev];
            updated[index] = {
              ...updated[index],
              meta: {
                ...updated[index].meta,
                durationMs,
                costUsd,
                numTurns,
              },
            };
            return updated;
          }
          return prev;
        });

        queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      } else if (type === 'chat.error') {
        const { messageId, message } = payload;
        setStreamingMessageId(null);
        setIsLocalBusy(false);
        setCurrentTool(null);

        setMessages((prev) => [
          ...prev,
          {
            id: messageId || `err-${Date.now()}`,
            role: 'error',
            content: message || t('extra.processingError'),
            createdAt: new Date().toISOString(),
          },
        ]);

        queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
      } else if (type === 'chat.status') {
        queryClient.setQueryData<ChatSession[]>(['chatSessions'], (prev = []) => prev.map((session) =>
          session.id === targetSessionId ? { ...session, state: payload.status, busy: payload.status !== 'idle' && payload.status !== 'error' } : session));
      }
    });

    return () => unsub();
  }, [activeSession?.id, queryClient]);

  // Mutations
  const createSessionMutation = useMutation({
    mutationFn: createChatSession,
    onSuccess: (newSession) => {
      queryClient.setQueryData<ChatSession[]>(['chatSessions'], (prev = []) => [
        newSession,
        ...prev,
      ]);
      setIsModalOpen(false);
      setMobileDrawerOpen(false);
      navigate(`/chat/${newSession.id}`);
    },
    onError: (err: any) => {
      alert(err.message || t('extra.createChatError'));
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: deleteChatSession,
    onSuccess: (_, deletedId) => {
      queryClient.setQueryData<ChatSession[]>(['chatSessions'], (prev = []) =>
        prev.filter((s) => s.id !== deletedId),
      );
      if (activeSession?.id === deletedId) {
        const remaining = sessions.filter((s) => s.id !== deletedId);
        if (remaining.length > 0) {
          navigate(`/chat/${remaining[0].id}`);
        } else {
          navigate('/chat');
        }
      }
    },
    onError: (err: any) => {
      alert(err.message || t('extra.deleteChatError'));
    },
  });

  const sendMessageMutation = useMutation({
    mutationFn: ({ sessId, text }: { sessId: string; text: string }) =>
      sendChatMessage(sessId, text),
    onMutate: async ({ text }) => {
      setIsLocalBusy(true);
      // Optimistic user message
      const tempUserMsgId = `temp-${Date.now()}`;
      const tempUserMsg: ChatMessage = {
        id: tempUserMsgId,
        role: 'user',
        content: text,
        createdAt: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, tempUserMsg]);
    },
    onSuccess: (res) => {
      // Set assistant streaming id
      setStreamingMessageId(res.assistantMessageId);
    },
    onError: (err: any) => {
      setIsLocalBusy(false);
      setStreamingMessageId(null);

      // Handle 409 Conflict while Claude is answering.
      if (err.status === 409 || err.message?.includes('409') || err.message?.includes('busy') || err.message?.includes('answering')) {
        setToastMessage(t('extra.claudeAnswering'));
      } else {
        setToastMessage(err.message || t('extra.sendError'));
      }
    },
  });

  const cancelMutation = useMutation({
    mutationFn: stopChatSession,
    onSuccess: () => {
      setIsLocalBusy(false);
      setStreamingMessageId(null);
      queryClient.invalidateQueries({ queryKey: ['chatSessions'] });
    },
    onError: (err: any) => {
      alert(err.message || t('extra.stopError'));
    },
  });

  const handleSendMessage = (text: string) => {
    if (!activeSession) return;
    sendMessageMutation.mutate({ sessId: activeSession.id, text });
  };

  const handleCancelMessage = () => {
    if (!activeSession) return;
    cancelMutation.mutate(activeSession.id);
  };

  const handleCreateSessionSubmit = (data: {
    projectId?: string | null;
    title?: string;
    mode: ChatMode;
    model?: string;
  }) => {
    createSessionMutation.mutate(data);
  };

  // Group consecutive tool messages
  const groupedItems = useMemo(() => {
    const result: Array<{ type: 'single'; message: ChatMessage } | { type: 'toolGroup'; messages: ChatMessage[] }> = [];
    let currentToolGroup: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        currentToolGroup.push(msg);
      } else {
        if (currentToolGroup.length > 0) {
          result.push({ type: 'toolGroup', messages: currentToolGroup });
          currentToolGroup = [];
        }
        result.push({ type: 'single', message: msg });
      }
    }

    if (currentToolGroup.length > 0) {
      result.push({ type: 'toolGroup', messages: currentToolGroup });
    }

    return result;
  }, [messages]);

  const lastToolGroupIndex = useMemo(() => {
    return groupedItems.map((item) => item.type).lastIndexOf('toolGroup');
  }, [groupedItems]);

  return (
    <div className="relative h-[calc(100vh-8.5rem)] flex rounded-2xl border border-[var(--border-default)] bg-[var(--bg-app)] overflow-hidden shadow-xs">
      {/* Toast Notification (409 etc.) */}
      {toastMessage && (
        <div
          role="alert"
          className="absolute top-4 left-1/2 -translate-x-1/2 z-50 px-4 py-2.5 rounded-xl bg-[var(--t-warn)] text-white font-medium text-xs shadow-xl flex items-center gap-2 animate-fade-in"
        >
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Desktop Left Column (Session List) >= 900px */}
      <aside className="hidden min-[900px]:block w-72 lg:w-80 shrink-0 h-full">
        <ChatSessionList
          sessions={sessions}
          activeSessionId={activeSession?.id}
          onSelectSession={(s) => navigate(`/chat/${s.id}`)}
          onNewSession={() => setIsModalOpen(true)}
          onDeleteSession={(id) => deleteSessionMutation.mutate(id)}
          isDeletingId={deleteSessionMutation.variables}
        />
      </aside>

      {/* Mobile Drawer Backdrop & Drawer < 900px */}
      {mobileDrawerOpen && (
        <div className="min-[900px]:hidden fixed inset-0 z-50 flex">
          {/* Backdrop */}
          <div
            className="fixed inset-0 bg-black/60 backdrop-blur-xs"
            onClick={() => setMobileDrawerOpen(false)}
          />
          {/* Drawer content */}
          <div className="relative w-72 max-w-[80vw] h-full bg-[var(--bg-surface)] shadow-2xl z-10 flex flex-col">
            <div className="flex items-center justify-between p-3 border-b border-[var(--border-default)]">
              <span className="font-semibold text-xs text-[var(--text-primary)]">
                {t('extra.chatList')}
              </span>
              <button
                type="button"
                onClick={() => setMobileDrawerOpen(false)}
                className="p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)]"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="flex-1 overflow-hidden">
              <ChatSessionList
                sessions={sessions}
                activeSessionId={activeSession?.id}
                onSelectSession={(s) => {
                  navigate(`/chat/${s.id}`);
                  setMobileDrawerOpen(false);
                }}
                onNewSession={() => {
                  setIsModalOpen(true);
                  setMobileDrawerOpen(false);
                }}
                onDeleteSession={(id) => deleteSessionMutation.mutate(id)}
                isDeletingId={deleteSessionMutation.variables}
              />
            </div>
          </div>
        </div>
      )}

      {/* Right Column (Chat Area) */}
      <section className="flex-1 flex flex-col h-full min-w-0 bg-[var(--bg-surface)]">
        {/* Top Chat Header */}
        <div className="h-14 px-4 border-b border-[var(--border-default)] flex items-center justify-between gap-3 bg-[var(--bg-surface)]">
          <div className="flex items-center gap-3 min-w-0">
            {/* Mobile drawer button */}
            <button
              type="button"
              onClick={() => setMobileDrawerOpen(true)}
              className="min-[900px]:hidden p-1.5 rounded-lg text-[var(--text-secondary)] hover:bg-[var(--bg-surface-hover)] hover:text-[var(--text-primary)]"
              title={t('extra.openSessions')}
            >
              <Menu className="w-5 h-5" />
            </button>

            {activeSession ? (
              <div className="min-w-0 flex items-center gap-2">
                <div className="w-7 h-7 rounded-full bg-[var(--t-claude)] text-white font-bold text-xs flex items-center justify-center shrink-0">
                  C
                </div>
                <div className="min-w-0">
                  <h2 className="text-xs sm:text-sm font-semibold text-[var(--text-primary)] truncate">
                    {activeSession.title}
                  </h2>
                  <div className="flex items-center gap-2 text-[10px] text-[var(--text-secondary)]">
                    <span>
                      {t('extra.mode')}: {activeSession.mode === 'full' ? t('extra.fullMode') : t('extra.safeMode')}
                    </span>
                    {activeSession.projectId && (
                      <span>• {t('extra.project')}: {activeSession.projectId}</span>
                    )}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-2 text-sm text-[var(--text-secondary)] font-medium">
                <Bot className="w-5 h-5 text-[var(--t-accent)]" />
                <span>{t('extra.chatWithClaude')}</span>
              </div>
            )}
          </div>

          {/* New chat button for convenience on mobile/header */}
          <button
            type="button"
            onClick={() => setIsModalOpen(true)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold bg-[var(--bg-surface-subtle)] hover:bg-[var(--bg-surface-hover)] border border-[var(--border-default)] text-[var(--text-primary)] transition-colors cursor-pointer shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{t('common.create')}</span>
          </button>
        </div>

        {/* Messages Body */}
        <div
          ref={messagesContainerRef}
          onScroll={handleScroll}
          className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-2 relative"
        >
          {!activeSession ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4">
              <div
                className="w-14 h-14 rounded-full flex items-center justify-center text-white font-bold text-2xl shadow-lg"
                style={{ backgroundColor: 'var(--t-claude)' }}
              >
                C
              </div>
              <div className="max-w-md space-y-1">
                <h3 className="text-base font-bold text-[var(--text-primary)]">
                  {t('extra.chatWelcome')}
                </h3>
                <p className="text-xs text-[var(--text-secondary)] leading-relaxed">
                {t('extra.chatWelcomeDesc')}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsModalOpen(true)}
                className="px-4 py-2 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-white font-semibold text-xs shadow-xs transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>{t('extra.startChat')}</span>
              </button>
            </div>
          ) : isMessagesLoading ? (
            <div className="flex items-center justify-center h-full">
              <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-[var(--t-accent)]" />
            </div>
          ) : messages.length === 0 ? (
            <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3 text-[var(--text-secondary)]">
              <div
                className="w-12 h-12 rounded-full flex items-center justify-center text-white font-bold text-xl shadow-md"
                style={{ backgroundColor: 'var(--t-claude)' }}
              >
                C
              </div>
              <p className="text-sm font-medium text-[var(--text-primary)]">
                {t('extra.emptyChat')}
              </p>
              <p className="text-xs text-[var(--text-muted)] max-w-sm">
                {t('extra.emptyChatDesc')}
              </p>
            </div>
          ) : (
            <>
              {groupedItems.map((item, idx) => {
                if (item.type === 'toolGroup') {
                  return (
                    <ToolChipsGroup
                      key={`tools-${idx}-${item.messages[0].id}`}
                      messages={item.messages}
                      isRunning={isBusy && idx === lastToolGroupIndex}
                    />
                  );
                }
                const isStreaming = item.message.id === streamingMessageId;
                return (
                  <ChatMessageItem
                    key={item.message.id}
                    message={item.message}
                    isStreaming={isStreaming}
                    onRetry={item.message.role === 'error' ? () => {
                      const index = messages.findIndex((message) => message.id === item.message.id);
                      const previous = index > 0 ? [...messages].slice(0, index).reverse().find((message) => message.role === 'user') : undefined;
                      if (previous && activeSession) sendMessageMutation.mutate({ sessId: activeSession.id, text: previous.content });
                    } : undefined}
                  />
                );
              })}
              <div ref={messagesEndRef} className="h-2" />
            </>
          )}
        </div>

        {/* Scroll To Bottom Button */}
        <ScrollToBottomButton
          show={showScrollBottom}
          onClick={() => scrollToBottom(true)}
        />

        {/* Input Bar */}
        {activeSession && (
          <>
            {(isBusy || (activeSession.state && activeSession.state !== 'idle')) && (
              <div className="px-5 pb-2 text-xs text-[var(--text-muted)]" role="status">
                {activeSession.state === 'waiting_permission'
                  ? 'Claude đang chờ bạn cấp quyền công cụ…'
                  : activeSession.state === 'error'
                  ? 'Lượt chat gặp lỗi — bạn có thể thử lại.'
                  : currentTool
                  ? t('extra.progress', { tool: currentTool, step: toolStepCount, time: `${Math.floor(thinkingSeconds / 60)}:${String(thinkingSeconds % 60).padStart(2, '0')}` })
                  : t('extra.thinking', { seconds: thinkingSeconds })}
              </div>
            )}
            <ChatInput
              onSend={handleSendMessage}
              onCancel={handleCancelMessage}
              busy={isBusy}
              isEmpty={messages.length === 0}
              disabled={!activeSession}
            />
          </>
        )}
      </section>

      {/* New Session Dialog */}
      <NewSessionModal
        isOpen={isModalOpen}
        onClose={() => setIsModalOpen(false)}
        onSubmit={handleCreateSessionSubmit}
        isSubmitting={createSessionMutation.isPending}
      />
    </div>
  );
};
