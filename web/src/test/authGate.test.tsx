import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AuthGate } from '../components/AuthGate';
import { clearToken, setToken } from '../api/client';

describe('AuthGate Component', () => {
  beforeEach(() => {
    clearToken();
    window.location.hash = '';
  });

  it('hiển thị màn hình hướng dẫn "agenthub open" khi thiếu token', () => {
    render(
      <AuthGate>
        <div data-testid="protected-content">Dashboard Protected Content</div>
      </AuthGate>,
    );

    expect(screen.getByTestId('auth-required-screen')).toBeInTheDocument();
    expect(screen.getByText('agenthub open')).toBeInTheDocument();
    expect(screen.queryByTestId('protected-content')).not.toBeInTheDocument();
  });

  it('hiển thị nội dung bên trong khi đã có token hợp lệ', () => {
    setToken('sample_token_xyz');

    render(
      <AuthGate>
        <div data-testid="protected-content">Dashboard Protected Content</div>
      </AuthGate>,
    );

    expect(screen.getByTestId('protected-content')).toBeInTheDocument();
    expect(screen.queryByTestId('auth-required-screen')).not.toBeInTheDocument();
  });
});
