import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ChatMessage, ChatSession } from '../../types/api';
import { MessageItem } from './MessageItem';
import { ToolStep } from './ToolStep';
import { ScrollToBottomButton } from './ScrollToBottomButton';
import { useLocale } from '../../context/LocaleContext';
import { Plus, Loader2 } from 'lucide-react';

export type MessageListItem =
  | { type: 'single'; id: string; message: ChatMessage }
  | { type: 'toolGroup'; id: string; messages: ChatMessage[] };

export interface MessageListProps {
  messages: ChatMessage[];
  activeSession: ChatSession | null;
  streamingMessageId?: string | null;
  isBusy?: boolean;
  hasMore?: boolean;
  isLoadingMore?: boolean;
  onLoadMore?: () => void;
  onRetryMessage?: (message: ChatMessage) => void;
  onEditMessage?: (message: ChatMessage) => void;
  onNewSession?: () => void;
  className?: string;
}

const ESTIMATED_ITEM_HEIGHT = 90;
const OVERSCAN = 8;

export const MessageList: React.FC<MessageListProps> = ({
  messages,
  activeSession,
  streamingMessageId,
  isBusy = false,
  hasMore = false,
  isLoadingMore = false,
  onLoadMore,
  onRetryMessage,
  onEditMessage,
  onNewSession,
  className = '',
}) => {
  const { t } = useLocale();
  const containerRef = useRef<HTMLDivElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const isAtBottomRef = useRef(true);
  const [showScrollBottom, setShowScrollBottom] = useState(false);

  // Group consecutive tool messages
  const groupedItems = useMemo<MessageListItem[]>(() => {
    const result: MessageListItem[] = [];
    let currentToolGroup: ChatMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'tool') {
        currentToolGroup.push(msg);
      } else {
        if (currentToolGroup.length > 0) {
          result.push({
            type: 'toolGroup',
            id: `tg-${currentToolGroup[0].id}`,
            messages: currentToolGroup,
          });
          currentToolGroup = [];
        }
        result.push({ type: 'single', id: msg.id, message: msg });
      }
    }

    if (currentToolGroup.length > 0) {
      result.push({
        type: 'toolGroup',
        id: `tg-${currentToolGroup[0].id}`,
        messages: currentToolGroup,
      });
    }

    return result;
  }, [messages]);

  const lastToolGroupIndex = useMemo(() => {
    return groupedItems.map((item) => item.type).lastIndexOf('toolGroup');
  }, [groupedItems]);

  // Virtualization state
  const [scrollTop, setScrollTop] = useState(0);
  const [containerHeight, setContainerHeight] = useState(0);
  const itemHeightsRef = useRef<Map<string, number>>(new Map());

  // Detect jsdom or small list: disable virtualization if in jsdom or container height is 0 or list < 30
  const isJsdom =
    typeof navigator !== 'undefined' &&
    (navigator.userAgent.includes('jsdom') || navigator.userAgent.includes('Node.js'));

  // Scroll retention for prepended messages
  const prevScrollHeightRef = useRef<number>(0);
  const prevFirstIdRef = useRef<string | null>(null);
  const isPrependingRef = useRef(false);

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const currentFirstId = messages.length > 0 ? messages[0].id : null;
    if (
      isPrependingRef.current &&
      prevFirstIdRef.current &&
      currentFirstId !== prevFirstIdRef.current
    ) {
      const heightDiff = container.scrollHeight - prevScrollHeightRef.current;
      if (heightDiff > 0) {
        container.scrollTop += heightDiff;
      }
      isPrependingRef.current = false;
    }

    prevFirstIdRef.current = currentFirstId;
    prevScrollHeightRef.current = container.scrollHeight;
  }, [messages]);

  const scrollToBottom = (smooth = true) => {
    const container = containerRef.current;
    if (!container) return;
    if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === 'function') {
      try {
        messagesEndRef.current.scrollIntoView({
          behavior: smooth ? 'smooth' : 'auto',
        });
      } catch {
        container.scrollTop = container.scrollHeight;
      }
    } else {
      container.scrollTop = container.scrollHeight;
    }
    setShowScrollBottom(false);
    isAtBottomRef.current = true;
  };

  // Scroll handler
  const handleScroll = () => {
    const container = containerRef.current;
    if (!container) return;

    const currentScrollTop = container.scrollTop;
    const scrollHeight = container.scrollHeight;
    const clientHeight = container.clientHeight;

    setScrollTop(currentScrollTop);
    setContainerHeight(clientHeight);

    // Check at bottom
    const distanceToBottom = scrollHeight - currentScrollTop - clientHeight;
    const isAtBottom = distanceToBottom < 60;
    isAtBottomRef.current = isAtBottom;
    if (isAtBottom) {
      setShowScrollBottom(false);
    } else if (distanceToBottom > 100) {
      setShowScrollBottom(true);
    }

    // Check near top for infinite loading
    if (currentScrollTop < 50 && hasMore && !isLoadingMore && onLoadMore) {
      prevScrollHeightRef.current = scrollHeight;
      isPrependingRef.current = true;
      onLoadMore();
    }
  };

  // Auto-scroll when new messages arrive if user was at bottom
  useEffect(() => {
    if (isPrependingRef.current) return;
    if (isAtBottomRef.current) {
      scrollToBottom();
    } else {
      setShowScrollBottom(true);
    }
  }, [messages, streamingMessageId]);

  // Measure element height
  const measureRef = (id: string) => (el: HTMLElement | null) => {
    if (el) {
      const h = el.offsetHeight;
      if (h > 0 && itemHeightsRef.current.get(id) !== h) {
        itemHeightsRef.current.set(id, h);
      }
    }
  };

  // Calculate virtual window
  const shouldVirtualize = !isJsdom && containerHeight > 0 && groupedItems.length >= 25;

  let visibleItems: { item: MessageListItem; index: number }[] = [];
  let topSpacerHeight = 0;
  let bottomSpacerHeight = 0;

  if (!shouldVirtualize) {
    visibleItems = groupedItems.map((item, index) => ({ item, index }));
  } else {
    // Calculate cumulative positions
    let cumulative = 0;
    const positions: number[] = [];
    for (const it of groupedItems) {
      positions.push(cumulative);
      const h = itemHeightsRef.current.get(it.id) || ESTIMATED_ITEM_HEIGHT;
      cumulative += h;
    }

    const viewportTop = Math.max(0, scrollTop);
    const viewportBottom = scrollTop + containerHeight;

    let start = 0;
    while (start < positions.length && positions[start] + (itemHeightsRef.current.get(groupedItems[start].id) || ESTIMATED_ITEM_HEIGHT) < viewportTop) {
      start++;
    }
    start = Math.max(0, start - OVERSCAN);

    let end = start;
    while (end < positions.length && positions[end] < viewportBottom) {
      end++;
    }
    end = Math.min(groupedItems.length, end + OVERSCAN);

    topSpacerHeight = positions[start] || 0;
    const endPosition = positions[end] !== undefined ? positions[end] : cumulative;
    bottomSpacerHeight = Math.max(0, cumulative - endPosition);

    visibleItems = groupedItems.slice(start, end).map((item, idx) => ({
      item,
      index: start + idx,
    }));
  }

  return (
    <div className={`relative flex-1 flex flex-col min-h-0 ${className}`}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        data-testid="message-list-container"
        className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-2 relative"
      >
        {/* Top Loading indicator when fetching older messages */}
        {isLoadingMore && (
          <div
            data-testid="loading-older-messages"
            className="flex items-center justify-center gap-2 py-3 text-xs text-[var(--t-text-3)] animate-pulse"
          >
            <Loader2 className="w-3.5 h-3.5 animate-spin text-[var(--t-accent)]" />
            <span>{t('extra.loadingOlderMessages')}</span>
          </div>
        )}

        {/* Welcome State when no session selected */}
        {!activeSession ? (
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-4">
            <div
              className="w-14 h-14 rounded-full flex items-center justify-center text-[var(--t-on-accent)] font-bold text-2xl shadow-lg"
              style={{ backgroundColor: 'var(--t-claude)' }}
            >
              C
            </div>
            <div className="max-w-md space-y-1">
              <h3 className="text-base font-bold text-[var(--t-text)]">
                {t('extra.chatWelcome')}
              </h3>
              <p className="text-xs text-[var(--t-text-2)] leading-relaxed">
                {t('extra.chatWelcomeDesc')}
              </p>
            </div>
            {onNewSession && (
              <button
                type="button"
                onClick={onNewSession}
                className="px-4 py-2 rounded-xl bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] font-semibold text-xs shadow-xs transition-colors cursor-pointer inline-flex items-center gap-2"
              >
                <Plus className="w-4 h-4" />
                <span>{t('extra.startChat')}</span>
              </button>
            )}
          </div>
        ) : messages.length === 0 ? (
          /* Empty Chat State */
          <div className="h-full flex flex-col items-center justify-center text-center p-6 space-y-3 text-[var(--t-text-2)]">
            <div
              className="w-12 h-12 rounded-full flex items-center justify-center text-[var(--t-on-accent)] font-bold text-xl shadow-md"
              style={{ backgroundColor: 'var(--t-claude)' }}
            >
              C
            </div>
            <p className="text-sm font-medium text-[var(--t-text)]">
              {t('extra.emptyChat')}
            </p>
            <p className="text-xs text-[var(--t-text-3)] max-w-sm">
              {t('extra.emptyChatDesc')}
            </p>
          </div>
        ) : (
          /* Message List Items */
          <>
            {topSpacerHeight > 0 && <div style={{ height: topSpacerHeight }} aria-hidden="true" />}
            {visibleItems.map(({ item, index }) => {
              if (item.type === 'toolGroup') {
                return (
                  <div
                    key={item.id}
                    ref={measureRef(item.id)}
                    data-index={index}
                  >
                    <ToolStep
                      messages={item.messages}
                      isRunning={isBusy && index === lastToolGroupIndex}
                    />
                  </div>
                );
              }

              const msg = item.message;
              const isStreaming = msg.id === streamingMessageId;

              return (
                <div
                  key={msg.id}
                  ref={measureRef(msg.id)}
                  data-index={index}
                >
                  <MessageItem
                    message={msg}
                    isStreaming={isStreaming}
                    onRetry={
                      msg.role === 'error' && onRetryMessage
                        ? () => onRetryMessage(msg)
                        : undefined
                    }
                    onEdit={msg.role === 'user' && onEditMessage ? () => onEditMessage(msg) : undefined}
                  />
                </div>
              );
            })}
            {bottomSpacerHeight > 0 && (
              <div style={{ height: bottomSpacerHeight }} aria-hidden="true" />
            )}
            <div ref={messagesEndRef} className="h-2" />
          </>
        )}
      </div>

      {/* Floating scroll to bottom button */}
      <ScrollToBottomButton
        show={showScrollBottom}
        onClick={() => scrollToBottom(true)}
      />
    </div>
  );
};
