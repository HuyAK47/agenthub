import { act } from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CountdownTimer, formatRemaining } from '../components/CountdownTimer';

describe('CountdownTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('formatRemaining format đúng cho giờ:phút:giây và phút:giây', () => {
    expect(formatRemaining(3665)).toBe('01:01:05');
    expect(formatRemaining(59)).toBe('00:59');
    expect(formatRemaining(120)).toBe('02:00');
  });

  it('formatRemaining trả về "Hết hạn" khi số giây <= 0', () => {
    expect(formatRemaining(0)).toBe('Hết hạn');
    expect(formatRemaining(-10)).toBe('Hết hạn');
  });

  it('render đồng hồ đếm ngược và cập nhật theo thời gian', () => {
    const fixedNow = 1700000000;
    vi.setSystemTime(fixedNow * 1000);

    const until = fixedNow + 120; // 2 minutes remaining
    render(<CountdownTimer until={until} />);

    expect(screen.getByTestId('countdown-timer')).toHaveTextContent('02:00');

    // Advance 30 seconds
    act(() => {
      vi.advanceTimersByTime(30000);
    });

    expect(screen.getByTestId('countdown-timer')).toHaveTextContent('01:30');
  });

  it('gọi onExpire khi hết thời gian đếm ngược', () => {
    const fixedNow = 1700000000;
    vi.setSystemTime(fixedNow * 1000);

    const onExpire = vi.fn();
    const until = fixedNow + 2; // 2 seconds

    render(<CountdownTimer until={until} onExpire={onExpire} />);

    act(() => {
      vi.advanceTimersByTime(3000);
    });

    expect(onExpire).toHaveBeenCalled();
    expect(screen.getByTestId('countdown-timer')).toHaveTextContent('Hết hạn');
  });
});
