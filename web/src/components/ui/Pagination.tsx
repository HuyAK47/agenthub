import React from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';

export interface PaginationProps {
  page: number;
  pageSize: number;
  total: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizes?: readonly number[];
}

export const Pagination: React.FC<PaginationProps> = ({ page, pageSize, total, onPageChange, onPageSizeChange, pageSizes = [20, 50, 100] }) => {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-[var(--t-border)] px-3 py-2 text-xs text-[var(--t-text-3)]">
      <label className="flex items-center gap-2">
        Rows/page
        <select value={pageSize} onChange={(event) => onPageSizeChange?.(Number(event.target.value))} className="rounded border border-[var(--t-border)] bg-[var(--t-surface)] px-2 py-1 text-[var(--t-text)]">
          {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
        </select>
      </label>
      <div className="flex items-center gap-2">
        <button type="button" aria-label="Previous page" disabled={page <= 1} onClick={() => onPageChange(page - 1)} className="rounded p-1.5 hover:bg-[var(--t-hover)] disabled:opacity-40"><ChevronLeft className="h-4 w-4" /></button>
        <span>Page {page}/{pages}</span>
        <button type="button" aria-label="Next page" disabled={page >= pages} onClick={() => onPageChange(page + 1)} className="rounded p-1.5 hover:bg-[var(--t-hover)] disabled:opacity-40"><ChevronRight className="h-4 w-4" /></button>
      </div>
    </div>
  );
};

