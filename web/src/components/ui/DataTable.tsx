import React from 'react';
import { EmptyState } from './EmptyState';
import { Pagination, PaginationProps } from './Pagination';
import { useLocale } from '../../context/LocaleContext';

export interface DataTableProps<T> extends Omit<PaginationProps, 'onPageChange' | 'onPageSizeChange'> {
  rows: T[];
  columns: Array<{ key: string; title: React.ReactNode; render: (row: T) => React.ReactNode; className?: string; sortable?: boolean; sortValue?: (row: T) => string | number | null | undefined }>;
  loading?: boolean;
  error?: string | null;
  emptyTitle?: string;
  onPageChange?: PaginationProps['onPageChange'];
  onPageSizeChange?: PaginationProps['onPageSizeChange'];
  sortKey?: string;
  sortDirection?: 'asc' | 'desc';
  onSortChange?: (key: string, direction: 'asc' | 'desc') => void;
}

export function DataTable<T>({ rows, columns, loading, error, emptyTitle, onPageChange, onPageSizeChange, sortKey, sortDirection, onSortChange, ...pagination }: DataTableProps<T>) {
  const { t } = useLocale();
  const [localSort, setLocalSort] = React.useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const sort = sortKey ? { key: sortKey, direction: sortDirection || 'asc' } : localSort;
  const sortedRows = React.useMemo(() => {
    if (!sort) return rows;
    const column = columns.find((item) => item.key === sort.key);
    if (!column?.sortable || !column.sortValue) return rows;
    return [...rows].sort((left, right) => {
      const a = column.sortValue!(left);
      const b = column.sortValue!(right);
      const result = a == null && b == null ? 0 : a == null ? -1 : b == null ? 1 : String(a).localeCompare(String(b), undefined, { numeric: true, sensitivity: 'base' });
      return sort.direction === 'asc' ? result : -result;
    });
  }, [columns, rows, sort]);
  const toggleSort = (key: string) => {
    const direction = sort?.key === key && sort.direction === 'asc' ? 'desc' : 'asc';
    if (onSortChange) onSortChange(key, direction);
    else setLocalSort({ key, direction });
  };
  return <div className="overflow-hidden rounded-xl border border-[var(--t-border)]">
    <div className="max-h-[min(70vh,720px)] overflow-auto">
      <table className="w-full border-collapse text-left text-sm text-[var(--t-text)]">
        <thead className="sticky top-0 z-10 border-b border-[var(--t-border)] bg-[var(--t-surface-2)]"><tr>{columns.map((column) => <th key={column.key} aria-sort={sort?.key === column.key ? (sort.direction === 'asc' ? 'ascending' : 'descending') : undefined} className={`whitespace-nowrap px-4 py-3 text-xs font-semibold uppercase tracking-wider text-[var(--t-text-3)] ${column.className || ''}`}><button type="button" disabled={!column.sortable} onClick={() => toggleSort(column.key)} className={column.sortable ? 'cursor-pointer hover:text-[var(--t-text)]' : ''}>{column.title}{sort?.key === column.key ? (sort.direction === 'asc' ? ' ↑' : ' ↓') : ''}</button></th>)}</tr></thead>
        <tbody className="divide-y divide-[var(--t-border)]">
          {loading ? <tr><td colSpan={columns.length} className="p-8 text-center text-[var(--t-text-3)]">{t('pagination.loading')}</td></tr> : error ? <tr><td colSpan={columns.length} className="p-8 text-center text-[var(--t-crit)]">{error}</td></tr> : sortedRows.map((row, index) => <tr key={index} className="hover:bg-[var(--t-hover)]">{columns.map((column) => <td key={column.key} className={`max-w-[28rem] px-4 py-3 ${column.className || ''}`}>{column.render(row)}</td>)}</tr>)}
        </tbody>
      </table>
      {!loading && !error && rows.length === 0 && <EmptyState title={emptyTitle} />}
    </div>
    <Pagination {...pagination} onPageChange={onPageChange || (() => undefined)} onPageSizeChange={onPageSizeChange} />
  </div>;
}

