import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { LocaleProvider } from '../context/LocaleContext';
import { DataTable, Pagination } from '../components/ui';

describe('pagination UI', () => {
  it('changes page and page size', () => {
    let page = 1;
    let pageSize = 20;
    const view = render(<LocaleProvider initialLocale="en"><Pagination page={page} pageSize={pageSize} total={120} onPageChange={(next) => { page = next; }} onPageSizeChange={(next) => { pageSize = next; }} /></LocaleProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Next page' }));
    expect(page).toBe(2);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: '50' } });
    expect(pageSize).toBe(50);
    view.unmount();
  });

  it('renders loading, error, empty and rows through DataTable', () => {
    const columns = [{ key: 'name', title: 'Name', render: (row: { name: string }) => row.name }];
    const { rerender } = render(<LocaleProvider initialLocale="en"><DataTable rows={[]} columns={columns} page={1} pageSize={20} total={0} loading /></LocaleProvider>);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    rerender(<LocaleProvider initialLocale="en"><DataTable rows={[]} columns={columns} page={1} pageSize={20} total={0} error="Failed" /></LocaleProvider>);
    expect(screen.getByText('Failed')).toBeInTheDocument();
    rerender(<LocaleProvider initialLocale="en"><DataTable rows={[]} columns={columns} page={1} pageSize={20} total={0} /></LocaleProvider>);
    expect(screen.getByText('No data')).toBeInTheDocument();
    rerender(<LocaleProvider initialLocale="en"><DataTable rows={[{ name: 'row 1' }]} columns={columns} page={1} pageSize={20} total={1} /></LocaleProvider>);
    expect(screen.getByText('row 1')).toBeInTheDocument();
  });
});
