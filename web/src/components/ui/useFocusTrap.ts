import { useEffect, useRef } from 'react';

export const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'textarea:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

export interface UseFocusTrapOptions {
  isOpen: boolean;
  onClose?: () => void;
  autoFocus?: boolean;
  /**
   * CSS selector for elements where key events should NOT trigger focus trap behavior
   * (e.g. '.xterm' or any embedded terminal).
   */
  ignoreSelector?: string;
  /**
   * Custom predicate to ignore key events for specific targets or states.
   */
  shouldIgnoreEvent?: (e: KeyboardEvent) => boolean;
}

interface TrapEntry {
  id: number;
  getContainer: () => HTMLElement | null;
}

let nextTrapId = 1;
// Module-level stack of active traps for nested modals
const activeTrapStack: TrapEntry[] = [];

export const _getActiveTrapStackCount = () => activeTrapStack.length;

export function useFocusTrap<T extends HTMLElement = HTMLDivElement>({
  isOpen,
  onClose,
  autoFocus = true,
  ignoreSelector,
  shouldIgnoreEvent,
}: UseFocusTrapOptions) {
  const containerRef = useRef<T>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  const ignoreSelectorRef = useRef(ignoreSelector);
  const shouldIgnoreEventRef = useRef(shouldIgnoreEvent);

  useEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  useEffect(() => {
    ignoreSelectorRef.current = ignoreSelector;
  }, [ignoreSelector]);

  useEffect(() => {
    shouldIgnoreEventRef.current = shouldIgnoreEvent;
  }, [shouldIgnoreEvent]);

  useEffect(() => {
    if (!isOpen) return;

    const trapId = nextTrapId++;
    const trapEntry: TrapEntry = {
      id: trapId,
      getContainer: () => containerRef.current,
    };
    activeTrapStack.push(trapEntry);

    // Save previous active element to restore focus on close
    triggerRef.current = document.activeElement as HTMLElement | null;

    // Initially focus the first focusable element inside the modal
    if (autoFocus && containerRef.current) {
      const focusable = Array.from(
        containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
      ).filter((el) => {
        if (el.getAttribute('type') === 'hidden') return false;
        if (ignoreSelectorRef.current && el.closest(ignoreSelectorRef.current)) return false;
        return true;
      });

      if (focusable.length > 0) {
        focusable[0].focus();
      } else {
        containerRef.current.focus();
      }
    }

    const isTopTrap = () => {
      if (activeTrapStack.length === 0) return false;

      const myContainer = containerRef.current;
      if (myContainer) {
        // If another active trap is inside this container, that child modal must be closed first
        const hasChildTrap = activeTrapStack.some((e) => {
          if (e.id === trapId) return false;
          const childCont = e.getContainer();
          return childCont && myContainer.contains(childCont);
        });
        if (hasChildTrap) return false;
      }

      // Filter traps that are not parents of any other active trap
      const candidateTraps = activeTrapStack.filter((e) => {
        const cont = e.getContainer();
        if (!cont) return true;
        return !activeTrapStack.some((other) => {
          if (other.id === e.id) return false;
          const otherCont = other.getContainer();
          return otherCont && cont.contains(otherCont);
        });
      });

      if (candidateTraps.length === 0) return false;
      return candidateTraps[candidateTraps.length - 1].id === trapId;
    };

    const isIgnored = (e: KeyboardEvent): boolean => {
      if (shouldIgnoreEventRef.current && shouldIgnoreEventRef.current(e)) {
        return true;
      }
      const selector = ignoreSelectorRef.current;
      if (selector) {
        const target = e.target as HTMLElement | null;
        if (target?.closest?.(selector)) return true;
        const active = document.activeElement as HTMLElement | null;
        if (active?.closest?.(selector)) return true;
      }
      return false;
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      // Only the top-most modal in the stack handles Escape and Tab
      if (!isTopTrap()) return;

      // Allow bypassed elements (e.g. xterm in LoginTerminal) to handle keys natively
      if (isIgnored(e)) return;

      if (e.key === 'Escape') {
        if (onCloseRef.current) {
          e.preventDefault();
          e.stopPropagation();
          onCloseRef.current();
        }
        return;
      }

      if (e.key === 'Tab') {
        if (!containerRef.current) return;
        const focusable = Array.from(
          containerRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => {
          if (el.getAttribute('type') === 'hidden') return false;
          if (ignoreSelectorRef.current && el.closest(ignoreSelectorRef.current)) return false;
          return true;
        });

        if (focusable.length === 0) {
          e.preventDefault();
          return;
        }

        const first = focusable[0];
        const last = focusable[focusable.length - 1];

        if (e.shiftKey) {
          if (document.activeElement === first || !containerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            last.focus();
          }
        } else {
          if (document.activeElement === last || !containerRef.current.contains(document.activeElement)) {
            e.preventDefault();
            first.focus();
          }
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);

    return () => {
      const idx = activeTrapStack.findIndex((e) => e.id === trapId);
      if (idx !== -1) {
        activeTrapStack.splice(idx, 1);
      }
      window.removeEventListener('keydown', handleKeyDown);
      if (triggerRef.current && typeof triggerRef.current.focus === 'function') {
        triggerRef.current.focus();
      }
    };
  }, [isOpen, autoFocus]);

  return containerRef;
}
