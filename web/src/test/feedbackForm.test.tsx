import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

// Isolated feedback form component representing the "Yêu cầu sửa" modal logic
function FeedbackModalForm({ onSubmit }: { onSubmit: (fb: string) => void }) {
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!feedback.trim()) {
      setError('Bắt buộc nhập feedback');
      return;
    }
    setError(null);
    onSubmit(feedback.trim());
  };

  return (
    <form onSubmit={handleSubmit} data-testid="changes-requested-form">
      <textarea
        data-testid="feedback-textarea"
        value={feedback}
        onChange={(e) => {
          setFeedback(e.target.value);
          if (e.target.value.trim()) setError(null);
        }}
      />
      {error && <span data-testid="feedback-error">{error}</span>}
      <button
        type="submit"
        data-testid="submit-feedback-btn"
        disabled={!feedback.trim()}
      >
        Gửi yêu cầu sửa
      </button>
    </form>
  );
}

describe('Form "Yêu cầu sửa" (Feedback Form)', () => {
  it('nút gửi bị disabled khi ô feedback rỗng hoặc chỉ có khoảng trắng', () => {
    const onSubmit = vi.fn();
    render(<FeedbackModalForm onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('feedback-textarea');
    const submitBtn = screen.getByTestId('submit-feedback-btn');

    expect(submitBtn).toBeDisabled();

    fireEvent.change(textarea, { target: { value: '   ' } });
    expect(submitBtn).toBeDisabled();

    fireEvent.click(submitBtn);
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('cho phép gửi khi feedback có nội dung và gọi callback với text đã trim', () => {
    const onSubmit = vi.fn();
    render(<FeedbackModalForm onSubmit={onSubmit} />);

    const textarea = screen.getByTestId('feedback-textarea');
    const submitBtn = screen.getByTestId('submit-feedback-btn');

    fireEvent.change(textarea, { target: { value: 'Cần sửa lại hàm tính toán' } });
    expect(submitBtn).not.toBeDisabled();

    fireEvent.click(submitBtn);
    expect(onSubmit).toHaveBeenCalledWith('Cần sửa lại hàm tính toán');
  });
});
