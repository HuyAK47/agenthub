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
});
