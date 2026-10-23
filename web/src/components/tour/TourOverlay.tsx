import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { useLocale } from '../../context/LocaleContext';
import { useTour } from './TourContext';
import { UI_Z_INDEX } from '../ui/layers';

export type Rect = {
  top: number;
  left: number;
  width: number;
  height: number;
  right?: number;
  bottom?: number;
  x?: number;
  y?: number;
};

export type Size = {
  width: number;
  height: number;
};

export type Viewport = {
  width: number;
  height: number;
};

export type PopoverPlacement = 'right' | 'bottom' | 'top' | 'left' | 'bottom-sheet';

export type PopoverArrow = {
  placement: 'left' | 'top' | 'bottom' | 'right';
  top?: number;
  left?: number;
};

export type PopoverPosition = {
  top: number;
  left: number;
  placement: PopoverPlacement;
  arrow?: PopoverArrow;
};

export const VIEWPORT_MARGIN = 12;
export const POPOVER_GAP = 14;
export const ARROW_MARGIN = 16;

function clamp(val: number, min: number, max: number): number {
  if (min > max) return min;
  return Math.max(min, Math.min(max, val));
}

/**
 * Tính vị trí bong bóng tour theo phần tử đích với thứ tự ưu tiên (phải → dưới → trên → trái)
 * và luôn kẹp trong viewport với lề 12px. Nếu không đủ chỗ ở mọi phía, đặt giữa màn hình
 * phía dưới phần tử hoặc dạng tấm dưới đáy.
 */
export function computePopoverPosition(
  targetRect: Rect,
  popoverSize: Size,
  viewport: Viewport,
  preferredPlacement?: 'right' | 'bottom' | 'top' | 'left',
): PopoverPosition {
  const targetTop = targetRect.top ?? targetRect.y ?? 0;
  const targetLeft = targetRect.left ?? targetRect.x ?? 0;
  const targetWidth = targetRect.width ?? 0;
  const targetHeight = targetRect.height ?? 0;
  const targetRight = targetRect.right ?? (targetLeft + targetWidth);
  const targetBottom = targetRect.bottom ?? (targetTop + targetHeight);

  const targetCenterX = targetLeft + targetWidth / 2;
  const targetCenterY = targetTop + targetHeight / 2;

  const minLeft = VIEWPORT_MARGIN;
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - VIEWPORT_MARGIN - popoverSize.width);
  const minTop = VIEWPORT_MARGIN;
  const maxTop = Math.max(VIEWPORT_MARGIN, viewport.height - VIEWPORT_MARGIN - popoverSize.height);

  // Khoảng trống khả dụng theo 4 hướng (kèm lề 12px và khoảng cách 14px)
  const spaceRight = viewport.width - VIEWPORT_MARGIN - (targetRight + POPOVER_GAP);
  const spaceBottom = viewport.height - VIEWPORT_MARGIN - (targetBottom + POPOVER_GAP);
  const spaceTop = targetTop - POPOVER_GAP - VIEWPORT_MARGIN;
  const spaceLeft = targetLeft - POPOVER_GAP - VIEWPORT_MARGIN;

  // Kiểm tra từng hướng có đủ chỗ chứa bong bóng hay không
  const fitsRight = spaceRight >= popoverSize.width && viewport.height >= popoverSize.height + 2 * VIEWPORT_MARGIN;
  const fitsBottom = spaceBottom >= popoverSize.height && viewport.width >= popoverSize.width + 2 * VIEWPORT_MARGIN;
  const fitsTop = spaceTop >= popoverSize.height && viewport.width >= popoverSize.width + 2 * VIEWPORT_MARGIN;
  const fitsLeft = spaceLeft >= popoverSize.width && viewport.height >= popoverSize.height + 2 * VIEWPORT_MARGIN;

  // Thứ tự ưu tiên: phải → dưới → trên → trái (hoặc preferredPlacement nếu được truyền)
  const baseOrder: Array<'right' | 'bottom' | 'top' | 'left'> = ['right', 'bottom', 'top', 'left'];
  const order = preferredPlacement
    ? [preferredPlacement, ...baseOrder.filter((p) => p !== preferredPlacement)]
    : baseOrder;

  let chosen: 'right' | 'bottom' | 'top' | 'left' | null = null;
  for (const candidate of order) {
    if (candidate === 'right' && fitsRight) {
      chosen = 'right';
      break;
    }
    if (candidate === 'bottom' && fitsBottom) {
      chosen = 'bottom';
      break;
    }
    if (candidate === 'top' && fitsTop) {
      chosen = 'top';
      break;
    }
    if (candidate === 'left' && fitsLeft) {
      chosen = 'left';
      break;
    }
  }

  if (chosen === 'right') {
    const left = clamp(targetRight + POPOVER_GAP, minLeft, maxLeft);
    const top = clamp(targetCenterY - popoverSize.height / 2, minTop, maxTop);
    const arrowMargin = Math.min(ARROW_MARGIN, Math.max(8, popoverSize.height / 2));
    const arrowTop = clamp(targetCenterY - top, arrowMargin, popoverSize.height - arrowMargin);
    return {
      top,
      left,
      placement: 'right',
      arrow: { placement: 'left', top: arrowTop },
    };
  }

  if (chosen === 'bottom') {
    const top = clamp(targetBottom + POPOVER_GAP, minTop, maxTop);
    const left = clamp(targetCenterX - popoverSize.width / 2, minLeft, maxLeft);
    const arrowMargin = Math.min(ARROW_MARGIN, Math.max(8, popoverSize.width / 2));
    const arrowLeft = clamp(targetCenterX - left, arrowMargin, popoverSize.width - arrowMargin);
    return {
      top,
      left,
      placement: 'bottom',
      arrow: { placement: 'top', left: arrowLeft },
    };
  }

  if (chosen === 'top') {
    const top = clamp(targetTop - POPOVER_GAP - popoverSize.height, minTop, maxTop);
    const left = clamp(targetCenterX - popoverSize.width / 2, minLeft, maxLeft);
    const arrowMargin = Math.min(ARROW_MARGIN, Math.max(8, popoverSize.width / 2));
    const arrowLeft = clamp(targetCenterX - left, arrowMargin, popoverSize.width - arrowMargin);
    return {
      top,
      left,
      placement: 'top',
      arrow: { placement: 'bottom', left: arrowLeft },
    };
  }

  if (chosen === 'left') {
    const left = clamp(targetLeft - POPOVER_GAP - popoverSize.width, minLeft, maxLeft);
    const top = clamp(targetCenterY - popoverSize.height / 2, minTop, maxTop);
    const arrowMargin = Math.min(ARROW_MARGIN, Math.max(8, popoverSize.height / 2));
    const arrowTop = clamp(targetCenterY - top, arrowMargin, popoverSize.height - arrowMargin);
    return {
      top,
      left,
      placement: 'left',
      arrow: { placement: 'right', top: arrowTop },
    };
  }

  // Fallback: không đủ chỗ ở mọi phía
  const centeredLeft = clamp((viewport.width - popoverSize.width) / 2, minLeft, maxLeft);

  // 1. Nếu có đủ chỗ dưới phần tử (khi đặt giữa màn hình theo chiều ngang)
  if (spaceBottom >= popoverSize.height) {
    const top = clamp(targetBottom + POPOVER_GAP, minTop, maxTop);
    const arrowMargin = Math.min(ARROW_MARGIN, Math.max(8, popoverSize.width / 2));
    const arrowLeft = clamp(targetCenterX - centeredLeft, arrowMargin, popoverSize.width - arrowMargin);
    return {
      top,
      left: centeredLeft,
      placement: 'bottom',
      arrow: { placement: 'top', left: arrowLeft },
    };
  }

  // 2. Dạng tấm dưới đáy (điện thoại/màn hẹp)
  return {
    top: maxTop,
    left: centeredLeft,
    placement: 'bottom-sheet',
  };
}

export const TourOverlay: React.FC = () => {
  const { t } = useLocale();
  const { active, stepIndex, next, previous, closeTour } = useTour();
  const location = useLocation();
  const [rect, setRect] = useState<Rect | null>(null);
  const [popoverSize, setPopoverSize] = useState<Size>({ width: 340, height: 200 });
  const [viewport, setViewport] = useState<Viewport>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1024,
    height: typeof window !== 'undefined' ? window.innerHeight : 768,
  }));
  const popoverRef = useRef<HTMLElement | null>(null);

  const step = active?.steps[stepIndex];
  const title = step ? t(step.title) : '';
  const content = step ? t(step.content) : '';

  // Theo dõi kích thước viewport
  useEffect(() => {
    const onResize = () => {
      setViewport({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener('resize', onResize, { passive: true });
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Đo kích thước thực tế của popover khi DOM thay đổi
  useEffect(() => {
    if (!popoverRef.current) return;
    const updateSize = () => {
      if (!popoverRef.current) return;
      const box = popoverRef.current.getBoundingClientRect();
      if (box.width > 0 && box.height > 0) {
        setPopoverSize((prev) => {
          if (Math.round(prev.width) === Math.round(box.width) && Math.round(prev.height) === Math.round(box.height)) {
            return prev;
          }
          return { width: Math.round(box.width), height: Math.round(box.height) };
        });
      }
    };
    updateSize();
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(updateSize);
      ro.observe(popoverRef.current);
      return () => ro.disconnect();
    }
  }, [rect, title, content, stepIndex]);

  // Tìm phần tử đích và lắng nghe scroll, resize, ResizeObserver, font load
  useEffect(() => {
    if (!active || !step) return;
    let cancelled = false;
    let attempts = 0;
    let rafId: number | null = null;
    let resizeObserver: ResizeObserver | null = null;
    let timerId: number | null = null;
    let cleanupTargetListeners: (() => void) | null = null;

    const locate = () => {
      if (cancelled) return;
      const target = document.querySelector(step.selector) as HTMLElement | null;
      if (target && target.isConnected) {
        target.scrollIntoView?.({ block: 'center', behavior: 'smooth' });

        const update = () => {
          if (cancelled) return;
          if (!target.isConnected) {
            setRect(null);
            next();
            return;
          }
          const box = target.getBoundingClientRect();
          setRect((prev) => {
            if (
              prev &&
              prev.top === box.top &&
              prev.left === box.left &&
              prev.width === box.width &&
              prev.height === box.height
            ) {
              return prev;
            }
            return { top: box.top, left: box.left, width: box.width, height: box.height };
          });
        };

        const scheduleUpdate = () => {
          if (cancelled) return;
          if (rafId !== null) return;
          rafId = requestAnimationFrame(() => {
            rafId = null;
            update();
          });
        };

        scheduleUpdate();

        // 1. Scroll listener (capture để bắt mọi container cuộn bên trong)
        window.addEventListener('scroll', scheduleUpdate, { capture: true, passive: true });

        // 2. Resize & transition listeners (thu gọn/mở sidebar với CSS transition)
        window.addEventListener('resize', scheduleUpdate, { passive: true });
        window.addEventListener('transitionend', scheduleUpdate, { capture: true, passive: true });

        // 3. ResizeObserver trên target và document.body (bắt việc thu gọn/mở sidebar, layout shift)
        if (typeof ResizeObserver !== 'undefined') {
          resizeObserver = new ResizeObserver(() => {
            scheduleUpdate();
          });
          resizeObserver.observe(target);
          if (document.body) {
            resizeObserver.observe(document.body);
          }
        }

        // 4. Khi font tải xong
        if (typeof document !== 'undefined' && 'fonts' in document && document.fonts?.ready) {
          document.fonts.ready.then(() => scheduleUpdate()).catch(() => {});
        }

        cleanupTargetListeners = () => {
          if (rafId !== null) cancelAnimationFrame(rafId);
          window.removeEventListener('scroll', scheduleUpdate, true);
          window.removeEventListener('resize', scheduleUpdate);
          window.removeEventListener('transitionend', scheduleUpdate, true);
          if (resizeObserver) resizeObserver.disconnect();
        };
        return;
      }

      if (attempts++ < 20) {
        timerId = window.setTimeout(locate, 50);
      } else {
        next();
      }


    };

    setRect(null);
    locate();
    return () => {
      cancelled = true;
      if (timerId !== null) window.clearTimeout(timerId);
      if (cleanupTargetListeners) cleanupTargetListeners();
    };
  }, [active, location.pathname, next, step]);

  // Phím tắt điều hướng
  useEffect(() => {
    if (!active) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeTour(false);
      else if (event.key === 'ArrowRight') next();
      else if (event.key === 'ArrowLeft') previous();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, closeTour, next, previous]);

  if (!active || !step || !rect) return null;

  const bubbleWidth = Math.max(0, Math.min(360, viewport.width - 24));
  const effectiveSize: Size = {
    width: Math.min(bubbleWidth, popoverSize.width || bubbleWidth),
    height: popoverSize.height || 200,
  };
  const position = computePopoverPosition(rect, effectiveSize, viewport);
  const target = document.querySelector(step.selector);
  const targetIsInModal = target instanceof HTMLElement && Boolean(target.closest('[role="dialog"]'));
  const zIndex = targetIsInModal ? UI_Z_INDEX.modalTour : UI_Z_INDEX.tour;

  return (
    <div
      className="pointer-events-none fixed inset-0 overflow-hidden"
      style={{ zIndex }}
      role="dialog"
      aria-modal="true"
      aria-label={title}
      data-testid="tour-overlay"
    >
      {/* Vùng khoét sáng đúng vị trí phần tử: bóng 9999px phủ tối toàn bộ phần còn lại */}
      <div
        data-testid="tour-spotlight"
        className="absolute rounded-xl pointer-events-none border-2 border-[var(--t-accent)] shadow-[0_0_0_9999px_rgba(0,0,0,0.55)] transition-all duration-150"
        style={{
          top: rect.top - 4,
          left: rect.left - 4,
          width: rect.width + 8,
          height: rect.height + 8,
        }}
      />

      {/* Bong bóng hướng dẫn */}
      <section
        ref={popoverRef}
        data-testid="tour-popover"
        className="pointer-events-auto absolute flex flex-col rounded-xl border border-[var(--t-border)] bg-[var(--t-surface)] p-4 shadow-2xl text-[var(--t-text)] overflow-visible max-sm:!left-3 max-sm:!right-3 max-sm:!bottom-3 max-sm:!top-auto max-sm:!w-auto"
        style={{
          top: position.top,
          left: position.left,
          width: bubbleWidth,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
        }}
      >
        <button
          type="button"
          onClick={() => closeTour(false)}
          aria-label={t('tour.close')}
          className="absolute right-2 top-2 rounded p-1 text-[var(--t-text-3)] hover:bg-[var(--t-hover)]"
        >
          <X size={16} />
        </button>

        <h2 className="pr-6 text-base font-semibold shrink-0">{title}</h2>

        {/* Nội dung dài cuộn bên trong */}
        <div className="mt-2 text-sm text-[var(--t-text-2)] overflow-y-auto min-h-0 flex-1 pr-1">
          <p>{content}</p>
        </div>

        {/* Nút điều hướng luôn hiển thị ở đáy */}
        <div className="mt-4 flex items-center justify-between gap-3 shrink-0 pt-2 border-t border-[var(--t-border)]/40">
          <span className="text-xs text-[var(--t-text-3)] shrink-0">
            {t('tour.step', { current: stepIndex + 1, total: active.steps.length })}
          </span>
          <div className="flex gap-2 shrink-0">
            <button
              type="button"
              onClick={previous}
              disabled={stepIndex === 0}
              className="rounded-lg border border-[var(--t-border)] px-3 py-1.5 text-xs disabled:opacity-40"
            >
              {t('tour.previous')}
            </button>
            <button
              type="button"
              onClick={next}
              className="rounded-lg bg-[var(--t-accent)] px-3 py-1.5 text-xs font-semibold text-white"
            >
              {stepIndex === active.steps.length - 1 ? t('tour.finish') : t('tour.next')}
            </button>
            <button
              type="button"
              onClick={() => closeTour(false)}
              className="rounded-lg px-2 py-1.5 text-xs text-[var(--t-text-3)] hover:text-[var(--t-text)]"
            >
              {t('tour.skip')}
            </button>

          </div>
        </div>

        {/* Mũi tên chỉ vào phần tử theo hướng đã chọn */}
        {position.arrow && (
          <div
            data-testid="tour-arrow"
            aria-hidden="true"
            className={`absolute w-3 h-3 bg-[var(--t-surface)] pointer-events-none rotate-45 ${
              position.arrow.placement === 'left'
                ? '-left-[7px] border-l border-b border-[var(--t-border)]'
                : position.arrow.placement === 'top'
                  ? '-top-[7px] border-t border-l border-[var(--t-border)]'
                  : position.arrow.placement === 'bottom'
                    ? '-bottom-[7px] border-b border-r border-[var(--t-border)]'
                    : '-right-[7px] border-t border-r border-[var(--t-border)]'
            }`}
            style={
              position.arrow.placement === 'left' || position.arrow.placement === 'right'
                ? { top: (position.arrow.top ?? 20) - 6 }
                : { left: (position.arrow.left ?? 20) - 6 }
            }
          />
        )}
      </section>
    </div>
  );
};
