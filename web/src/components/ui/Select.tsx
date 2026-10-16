import React from 'react';

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {}

export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className = '', disabled, children, ...props }, ref) => {
    return (
      <select
        ref={ref}
        disabled={disabled}
        className={`w-full h-9 px-3 text-sm bg-[var(--t-surface-2)] text-[var(--t-text)] border border-[var(--t-border)] rounded-lg transition-colors focus:border-[var(--t-accent)] focus:ring-2 focus:ring-[var(--t-accent)] focus:outline-hidden disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer ${className}`}
        {...props}
      >
        {children}
      </select>
    );
  }
);

Select.displayName = 'Select';
