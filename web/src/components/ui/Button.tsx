import React from 'react';

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
  size?: 'sm' | 'md';
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'primary', size = 'md', className = '', children, disabled, loading, ...props }, ref) => {
    const variantStyles = {
      primary: 'bg-[var(--t-accent)] hover:bg-[var(--t-accent-hover)] text-[var(--t-on-accent)] shadow-xs',
      secondary:
        'bg-[var(--t-surface-2)] hover:bg-[var(--t-hover)] text-[var(--t-text)] border border-[var(--t-border)]',
      ghost: 'bg-transparent hover:bg-[var(--t-hover)] text-[var(--t-text)]',
      danger: 'bg-[var(--t-crit)] hover:opacity-90 text-[var(--t-on-accent)] shadow-xs',
    }[variant];

    const sizeStyles = {
      sm: 'h-8 px-3 text-xs gap-1.5',
      md: 'h-9 px-4 text-sm gap-2',
    }[size];

    const isBusy = Boolean(loading || props['aria-busy'] === true || props['aria-busy'] === 'true');

    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        aria-busy={isBusy ? true : undefined}
        className={`inline-flex items-center justify-center font-medium rounded-lg transition-colors cursor-pointer select-none focus:outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--t-surface)] disabled:opacity-50 disabled:cursor-not-allowed ${variantStyles}  ${sizeStyles}  ${className}`}
        {...props}
      >
        {children}
      </button>
    );
  }
);

Button.displayName = 'Button';
