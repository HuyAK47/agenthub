import { useState } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { Modal } from '../components/ui/Modal';
import { Button } from '../components/ui/Button';
import { Layout } from '../components/Layout';
import { ChatInput } from '../components/chat/ChatInput';
import { ChatMessageItem } from '../components/chat/ChatMessageItem';
import { ChatSessionList } from '../components/chat/ChatSessionList';
import { ScrollToBottomButton } from '../components/chat/ScrollToBottomButton';
import { LocaleProvider } from '../context/LocaleContext';
import { ThemeProvider } from '../context/ThemeContext';
import { ChatMessage, ChatSession } from '../types/api';

describe('Accessibility (a11y) & Keyboard Navigation', () => {
  let queryClient: QueryClient;

  beforeEach(() => {
    localStorage.clear();
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  });

  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  describe('Modal / Dialog Accessibility', () => {
    it('1. có role="dialog", aria-modal="true" và aria-labelledby gắn với tiêu đề', () => {
      render(
        <LocaleProvider>
          <Modal isOpen={true} onClose={vi.fn()} title="Cấu hình hệ thống">
            <div>Nội dung hộp thoại</div>
          </Modal>
        </LocaleProvider>
      );

      const dialog = screen.getByRole('dialog');
      expect(dialog).toBeInTheDocument();
      expect(dialog.getAttribute('aria-modal')).toBe('true');

      const labelledBy = dialog.getAttribute('aria-labelledby');
      expect(labelledBy).toBeTruthy();

      const titleEl = document.getElementById(labelledBy!);
      expect(titleEl).toBeInTheDocument();
      expect(titleEl).toHaveTextContent('Cấu hình hệ thống');
    });

    it('2. đóng hộp thoại khi nhấn phím Escape', () => {
      const onClose = vi.fn();
      render(
        <LocaleProvider>
          <Modal isOpen={true} onClose={onClose} title="Hộp thoại Escape">
            <p>Nội dung</p>
          </Modal>
        </LocaleProvider>
      );

      fireEvent.keyDown(window, { key: 'Escape' });
      expect(onClose).toHaveBeenCalledTimes(1);
    });

    it('3. focus trap: giữ focus xoay vòng bên trong dialog bằng phím Tab và Shift+Tab', () => {
      const onClose = vi.fn();
      render(
        <LocaleProvider>
          <Modal isOpen={true} onClose={onClose} title="Hộp thoại Focus Trap">
            <input data-testid="input-1" placeholder="Ô nhập 1" />
            <input data-testid="input-2" placeholder="Ô nhập 2" />
            <button data-testid="btn-action">Hành động</button>
          </Modal>
        </LocaleProvider>
      );

      const closeBtn = screen.getByRole('button', { name: /đóng/i });
      const actionBtn = screen.getByTestId('btn-action');

      // Nhấn Tab ở phần tử cuối cùng -> vòng lại phần tử đầu tiên (closeBtn)
      actionBtn.focus();
      expect(document.activeElement).toBe(actionBtn);

      fireEvent.keyDown(actionBtn, { key: 'Tab' });
      expect(document.activeElement).toBe(closeBtn);

      // Nhấn Shift+Tab ở phần tử đầu tiên -> vòng về phần tử cuối cùng (actionBtn)
      fireEvent.keyDown(closeBtn, { key: 'Tab', shiftKey: true });
      expect(document.activeElement).toBe(actionBtn);
    });

    it('4. trả focus về nút đã mở dialog sau khi đóng', () => {
      function DialogOpener() {
        const [isOpen, setIsOpen] = useState(false);
        return (
          <LocaleProvider>
            <div>
              <button data-testid="opener-btn" onClick={() => setIsOpen(true)}>
                Mở Modal
              </button>
              <Modal isOpen={isOpen} onClose={() => setIsOpen(false)} title="Hộp thoại phản hồi">
                <button data-testid="inner-close" onClick={() => setIsOpen(false)}>
                  Đóng trong
                </button>
              </Modal>
            </div>
          </LocaleProvider>
        );
      }

      render(<DialogOpener />);

      const openerBtn = screen.getByTestId('opener-btn');
      openerBtn.focus();
      expect(document.activeElement).toBe(openerBtn);

      // Mở modal
      fireEvent.click(openerBtn);
      const innerCloseBtn = screen.getByTestId('inner-close');
      expect(innerCloseBtn).toBeInTheDocument();

      // Đóng modal
      fireEvent.click(innerCloseBtn);
      expect(screen.queryByTestId('inner-close')).not.toBeInTheDocument();

      // Focus đã được trả về nút opener
      expect(document.activeElement).toBe(openerBtn);
    });

    it('5. modal lồng nhau: Escape chỉ đóng modal trên cùng, không đóng mọi modal', () => {
      function NestedModals() {
        const [open1, setOpen1] = useState(true);
        const [open2, setOpen2] = useState(true);
        return (
          <LocaleProvider>
            <div>
              <Modal isOpen={open1} onClose={() => setOpen1(false)} title="Modal Cha">
                <p>Nội dung modal cha</p>
                <Modal isOpen={open2} onClose={() => setOpen2(false)} title="Modal Con">
                  <p>Nội dung modal con</p>
                </Modal>
              </Modal>
            </div>
          </LocaleProvider>
        );
      }

      render(<NestedModals />);

      expect(screen.getByText('Modal Cha')).toBeInTheDocument();
      expect(screen.getByText('Modal Con')).toBeInTheDocument();

      // Nhấn Escape lần 1 -> chỉ đóng Modal Con
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText('Modal Con')).not.toBeInTheDocument();
      expect(screen.getByText('Modal Cha')).toBeInTheDocument();

      // Nhấn Escape lần 2 -> đóng Modal Cha
      fireEvent.keyDown(window, { key: 'Escape' });
      expect(screen.queryByText('Modal Cha')).not.toBeInTheDocument();
    });

    it('6. modal không có title: dùng ariaLabel prop hoặc chuỗi dịch theo locale, không hardcode tiếng Anh', () => {
      // Có ariaLabel prop
      const { unmount: unmount1 } = render(
        <LocaleProvider>
          <Modal isOpen={true} onClose={vi.fn()} ariaLabel="Hộp thoại cấu hình riêng">
            <p>Nội dung</p>
          </Modal>
        </LocaleProvider>
      );
      expect(screen.getByRole('dialog', { name: 'Hộp thoại cấu hình riêng' })).toBeInTheDocument();
      unmount1();

      // Không có title và không có ariaLabel, locale tiếng Việt
      const { unmount: unmount2 } = render(
        <LocaleProvider initialLocale="vi">
          <Modal isOpen={true} onClose={vi.fn()}>
            <p>Nội dung</p>
          </Modal>
        </LocaleProvider>
      );
      expect(screen.getByRole('dialog', { name: 'Hộp thoại' })).toBeInTheDocument();
      unmount2();

      // Không có title và không có ariaLabel, locale tiếng Anh
      const { unmount: unmount3 } = render(
        <LocaleProvider initialLocale="en">
          <Modal isOpen={true} onClose={vi.fn()}>
            <p>Nội dung</p>
          </Modal>
        </LocaleProvider>
      );
      expect(screen.getByRole('dialog', { name: 'Dialog' })).toBeInTheDocument();
      unmount3();
    });
  });

  describe('Button Accessibility', () => {
    it('1. Button có aria-busy khi loading={true}', () => {
      const { rerender } = render(<Button loading={true}>Đang lưu...</Button>);
      const btn = screen.getByRole('button');
      expect(btn.getAttribute('aria-busy')).toBe('true');
      expect(btn).toBeDisabled();

      rerender(<Button loading={false}>Lưu</Button>);
      expect(btn.getAttribute('aria-busy')).toBeNull();
      expect(btn).toBeEnabled();
    });

    it('2. Nút chỉ có icon phải có aria-label từ i18n', () => {
      const mockSessions: ChatSession[] = [
        {
          id: 's1',
          title: 'Phiên test',
          mode: 'safe',
          busy: false,
          updatedAt: new Date().toISOString(),
        },
      ];

      render(
        <LocaleProvider>
          <ChatSessionList
            sessions={mockSessions}
            activeSessionId="s1"
            onSelectSession={vi.fn()}
            onNewSession={vi.fn()}
            onDeleteSession={vi.fn()}
          />
          <ScrollToBottomButton show={true} onClick={vi.fn()} />
        </LocaleProvider>
      );

      // Nút xóa phiên có aria-label
      const deleteBtn = screen.getByRole('button', { name: /Xóa phiên/i });
      expect(deleteBtn).toBeInTheDocument();
      expect(deleteBtn.getAttribute('aria-label')).toBeTruthy();

      // Nút cuộn xuống cuối có aria-label
      const scrollBtn = screen.getByRole('button', { name: /Tin mới/i });
      expect(scrollBtn).toBeInTheDocument();
      expect(scrollBtn.getAttribute('aria-label')).toBeTruthy();
    });
  });

  describe('Layout Accessibility', () => {
    it('1. có skip link "Bỏ qua tới nội dung" dẫn tới #main-content', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <ThemeProvider>
              <MemoryRouter initialEntries={['/']}>
                <Layout />
              </MemoryRouter>
            </ThemeProvider>
          </LocaleProvider>
        </QueryClientProvider>
      );

      const skipLink = screen.getByRole('link', { name: /bỏ qua tới nội dung/i });
      expect(skipLink).toBeInTheDocument();
      expect(skipLink.getAttribute('href')).toBe('#main-content');

      const mainContent = document.getElementById('main-content');
      expect(mainContent).toBeInTheDocument();
      expect(mainContent?.tagName.toLowerCase()).toBe('main');
    });

    it('2. sidebar có <nav aria-label="..."> landmark', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <ThemeProvider>
              <MemoryRouter initialEntries={['/']}>
                <Layout />
              </MemoryRouter>
            </ThemeProvider>
          </LocaleProvider>
        </QueryClientProvider>
      );

      const navLandmark = screen.getByRole('navigation', { name: /sidebar điều hướng/i });
      expect(navLandmark).toBeInTheDocument();
      expect(navLandmark.getAttribute('aria-label')).toBeTruthy();
    });

    it('3. mục đang chọn có aria-current="page", các mục khác không có', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <ThemeProvider>
              <MemoryRouter initialEntries={['/tasks']}>
                <Layout />
              </MemoryRouter>
            </ThemeProvider>
          </LocaleProvider>
        </QueryClientProvider>
      );

      // Đường dẫn /tasks đang active
      const taskNavLinks = screen.getAllByRole('link', { name: /^task$/i });
      const activeTaskLink = taskNavLinks.find(
        (link) => link.getAttribute('aria-current') === 'page'
      );
      expect(activeTaskLink).toBeDefined();

      // Đường dẫn / không active
      const dashboardLinks = screen.getAllByRole('link', { name: /tổng quan/i });
      const inactiveDashLink = dashboardLinks.find(
        (link) => link.getAttribute('aria-current') === 'page'
      );
      expect(inactiveDashLink).toBeUndefined();
    });

    it('4. <aside> không trùng aria-label với <nav>', () => {
      render(
        <QueryClientProvider client={queryClient}>
          <LocaleProvider>
            <ThemeProvider>
              <MemoryRouter initialEntries={['/']}>
                <Layout />
              </MemoryRouter>
            </ThemeProvider>
          </LocaleProvider>
        </QueryClientProvider>
      );

      const navLandmarks = screen.getAllByLabelText(/sidebar điều hướng/i);
      expect(navLandmarks).toHaveLength(1);
      expect(navLandmarks[0].tagName.toLowerCase()).toBe('nav');
    });
  });

  describe('Chat Accessibility', () => {
    it('1. ô nhập tin nhắn ChatInput có label', () => {
      render(
        <LocaleProvider>
          <ChatInput onSend={vi.fn()} onCancel={vi.fn()} busy={false} isEmpty={false} />
        </LocaleProvider>
      );

      const textarea = screen.getByLabelText(/nhập tin nhắn/i);
      expect(textarea).toBeInTheDocument();
      expect(textarea.tagName.toLowerCase()).toBe('textarea');
      expect(textarea.getAttribute('id')).toBe('chat-message-input');
    });

    it('2. vùng tin nhắn có aria-live="polite" khi đang stream', () => {
      const message: ChatMessage = {
        id: 'msg-stream-1',
        role: 'assistant',
        content: 'Nội dung phản hồi đang truyền...',
        createdAt: new Date().toISOString(),
      };

      const { rerender } = render(
        <LocaleProvider>
          <ChatMessageItem message={message} isStreaming={true} />
        </LocaleProvider>
      );

      const streamingEl = screen.getByText('Nội dung phản hồi đang truyền...').closest('[aria-live]');
      expect(streamingEl).toBeInTheDocument();
      expect(streamingEl?.getAttribute('aria-live')).toBe('polite');

      // Khi không stream, aria-live không xuất hiện
      rerender(
        <LocaleProvider>
          <ChatMessageItem message={message} isStreaming={false} />
        </LocaleProvider>
      );

      const staticEl = screen.getByText('Nội dung phản hồi đang truyền...').closest('[aria-live]');
      expect(staticEl).toBeNull();
    });
  });
});
