import React from 'react';
import { EmptyState } from './EmptyState';
import { Pagination, PaginationProps } from './Pagination';
import { useLocale } from '../../context/LocaleContext';

export interface DataTableProps<T> extends Omit<PaginationProps, 'onPageChange' | 'onPageSizeChange'> {
  rows: T[];
  columns: Array<{ key: string; title: React.ReactNode; render: (row: T) => React.ReactNode; className?: string }>;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  onPageChange?: PaginationProps['onPageChange'];
  onPageSizeChange?: PaginationProps['onPageSizeChange'];
}

export function DataTable<T>({ rows, columns, loading, error, emptyTitle, onPageChange, onPageSizeChange, ...pagination }: DataTableProps<T>) {
  const { t } = useLocale();
  return <div className="overflow-hidden rounded-xl border border-[var(--t-border)]">
    <div className="max-h-[min(70vh,720px)] overflow-auto">
      <table className="w-full border-collapse text-left text-sm text-[var(--t-text)]">
        <thead className="sticky top-0 z-10 border-b border-[var(--t-border)] bg-[var(--t-surface-2)]"><tr>{columns.map((column) => <th key={column.key} className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--t-text-3)] ${column.className || ''}`}>{column.title}</th>)}</tr></thead>
        <tbody className="divide-y divide-[var(--t-border)]">
          {loading ? <tr><td colSpan={columns.length} className="p-8 text-center text-[var(--t-text-3)]">{t('pagination.loading')}</td></tr> : error ? <tr><td colSpan={columns.length} className="p-8 text-center text-[var(--t-crit)]">{error}</td></tr> : rows.map((row, index) => <tr key={index} className="hover:bg-[var(--t-hover)]">{columns.map((column) => <td key={column.key} className={`max-w-[28rem] px-4 py-3 ${column.className || ''}`}>{column.render(row)}</td>)}</tr>)}
        </tbody>
      </table>
      {!loading && !error && rows.length === 0 && <EmptyState title={emptyTitle} />}
    </div>
    <Pagination {...pagination} onPageChange={onPageChange || (() => undefined)} onPageSizeChange={onPageSizeChange} />
  </div>;
}

