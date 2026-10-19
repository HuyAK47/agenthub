import React, { useCallback, useEffect, useMemo, useState } from 'react';

export function useShowMore<T>(items: T[], initial: number, step: number, storageKey?: string) {
  const [visibleCount, setVisibleCount] = useState<number>(() => {
    if (!storageKey) return initial;
    try {
      if (typeof window !== 'undefined' && window.localStorage.getItem(storageKey) === 'expanded') {
        return items.length;
      }
    } catch {
      /* unavailable */
    }
    return initial;
  });

  useEffect(() => {
    if (!storageKey) return;
    try {
      if (window.localStorage.getItem(storageKey) === 'expanded') {
        setVisibleCount(items.length);
      }
    } catch {
      /* unavailable */
    }
  }, [storageKey, items.length]);

  const showMore = useCallback(() => {
    setVisibleCount((count) => Math.min(items.length, count + step));
    if (storageKey) {
      try {
        window.localStorage.setItem(storageKey, 'expanded');
      } catch {
        /* unavailable */
      }
    }
  }, [items.length, step, storageKey]);

  const collapse = useCallback(() => {
    setVisibleCount(initial);
    if (storageKey) {
      try {
        window.localStorage.removeItem(storageKey);
      } catch {
        /* unavailable */
      }
    }
  }, [initial, storageKey]);

  return {
    visibleItems: useMemo(() => items.slice(0, visibleCount), [items, visibleCount]),
    hasMore: visibleCount < items.length,
    isExpanded: visibleCount > initial && items.length > initial,
    showMore,
    collapse,
  };
}

export function CollapsibleList<T>({
  items,
  initial = 20,
  step = 20,
  storageKey,
  children,
  className = 'space-y-2',
  tableColSpan,
}: {
  items: T[];
  initial?: number;
  step?: number;
  storageKey?: string;
  children: (item: T, index: number) => React.ReactNode;
  className?: string;
  tableColSpan?: number;
}) {
  const list = useShowMore(items, initial, step, storageKey);
  const remaining = items.length - list.visibleItems.length;
  const controls = (list.hasMore || list.isExpanded) && (
    <div className="flex items-center justify-center gap-3 pt-3">
      {list.hasMore && (
        <button
          type="button"
          onClick={list.showMore}
          className="text-xs font-medium text-[var(--t-accent)] hover:underline"
        >
          Xem thêm {Math.min(step, remaining)} (còn {remaining})
        </button>
      )}
      {list.isExpanded && (
        <button
          type="button"
          onClick={list.collapse}
          className="text-xs text-[var(--text-secondary)] hover:underline"
        >
          Thu gọn
        </button>
      )}
    </div>
  );

  if (tableColSpan) {
    return (
      <>
        {list.visibleItems.map((item, index) => children(item, index))}
        {controls && (
          <tr>
            <td colSpan={tableColSpan}>{controls}</td>
          </tr>
        )}
      </>
    );
  }

  return (
    <>
      <div className={className}>
        {list.visibleItems.map((item, index) => children(item, index))}
      </div>
      {controls}
    </>
  );
}
