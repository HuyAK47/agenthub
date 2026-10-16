import React from 'react';

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {}

export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', disabled, ...props }, ref) => {
    return (
      <input
        ref={ref}
        disabled={disabled}
        className={`w-full h-9 px-3 text-sm bg-[var(--t-surface-2)] text-[var(--t-text)] placeholder:text-[var(--t-text-3)] border border-[var(--t-border)] rounded-lg transition-colors focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden disabled:opacity-50 disabled:cursor-not-allowed ${className}`}
        {...props}
      />
    );
  }
);

Input.displayName = 'Input';
