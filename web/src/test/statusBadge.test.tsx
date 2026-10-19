import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StatusBadge } from '../components/StatusBadge';

describe('StatusBadge Component', () => {
  it('hiển thị đúng nhãn tiếng Việt cho từng trạng thái', () => {
    const { rerender } = render(<StatusBadge status="running" />);
    expect(screen.getByText('Đang chạy')).toBeInTheDocument();

    rerender(<StatusBadge status="checking" />);
    expect(screen.getByText('Đang kiểm tra')).toBeInTheDocument();

    rerender(<StatusBadge status="review" />);
    expect(screen.getByText('Chờ duyệt')).toBeInTheDocument();

    rerender(<StatusBadge status="done" />);
    expect(screen.getByText('Hoàn thành')).toBeInTheDocument();

    rerender(<StatusBadge status="waiting_quota" />);
    expect(screen.getByText('Chờ quota')).toBeInTheDocument();

    rerender(<StatusBadge status="blocked" />);
    expect(screen.getByText('Bị chặn')).toBeInTheDocument();

    rerender(<StatusBadge status="failed" />);
    expect(screen.getByText('Lỗi')).toBeInTheDocument();
  });

  it('hiển thị đúng nhãn tiếng Việt và style cho từng waitReason', () => {
    const { rerender } = render(
      <StatusBadge status="waiting_quota" waitReason="disk" diskFreeGB={2.4} diskMinFreeGB={5} />
    );
    expect(screen.getByText('Chờ ổ đĩa (còn 2.4 GB / cần 5 GB)')).toBeInTheDocument();
    const diskBadge = screen.getByTestId('status-badge-waiting_quota');
    expect(diskBadge.getAttribute('data-wait-reason')).toBe('disk');
    expect(diskBadge.style.backgroundColor).toContain('var(--wait-disk-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="disk" />);
    expect(screen.getByText('Chờ ổ đĩa')).toBeInTheDocument();

    rerender(<StatusBadge status="waiting_quota" waitReason="quota" />);
    expect(screen.getByText('Chờ quota model')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('quota');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-quota-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="parallel" />);
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('parallel');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-parallel-bg)');

    rerender(<StatusBadge status="waiting_quota" waitReason="profile_busy" />);
    expect(screen.getByText('Chờ tài khoản rảnh')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-waiting_quota').getAttribute('data-wait-reason')).toBe('profile_busy');
    expect(screen.getByTestId('status-badge-waiting_quota').style.backgroundColor).toContain('var(--wait-profile_busy-bg)');

    rerender(<StatusBadge status="queued" waitReason="parallel" />);
    expect(screen.getByText('Chờ slot song song')).toBeInTheDocument();
    expect(screen.getByTestId('status-badge-queued').style.backgroundColor).toContain('var(--wait-parallel-bg)');
  });
});
