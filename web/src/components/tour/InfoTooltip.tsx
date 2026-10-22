import React, { useState } from 'react';
import { Info } from 'lucide-react';

export const InfoTooltip: React.FC<{ text: string; label?: string }> = ({ text, label = 'More information' }) => {
  const [open, setOpen] = useState(false);
  return <span className="relative inline-flex align-middle">
    <button type="button" aria-label={label} aria-expanded={open} onClick={() => setOpen((value) => !value)} onBlur={() => setOpen(false)} className="ml-1 rounded-full text-[var(--t-text-3)] hover:text-[var(--t-accent)] focus:outline-none focus:ring-2 focus:ring-[var(--t-accent)]"><Info size={14} /></button>
    {open && <span role="tooltip" className="absolute left-5 top-5 z-50 w-64 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface)] p-3 text-xs font-normal text-[var(--t-text-2)] shadow-xl">{text}</span>}
  </span>;
};
