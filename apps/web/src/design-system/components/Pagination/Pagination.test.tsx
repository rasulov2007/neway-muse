import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Pagination } from './Pagination';
import { formatPaginationRange, getPageCount } from './paginationUtils';

describe('Pagination', () => {
  it('shows the range and disables previous on the first page', async () => {
    const user = userEvent.setup();
    const onPageChange = vi.fn();
    render(<Pagination page={1} pageSize={25} total={377} onPageChange={onPageChange} />);
    expect(screen.getByRole('navigation', { name: 'Pagination' })).toBeInTheDocument();
    expect(screen.getByText('1–25 of 377')).toBeInTheDocument();
    expect(screen.getByText('Page 1 of 16')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Previous page' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(onPageChange).toHaveBeenCalledWith(2);
  });

  it('disables next on the last page and changes the page size', async () => {
    const user = userEvent.setup();
    const onPageSizeChange = vi.fn();
    render(
      <Pagination
        page={16}
        pageSize={25}
        total={377}
        onPageChange={() => {}}
        onPageSizeChange={onPageSizeChange}
      />,
    );
    expect(screen.getByText('376–377 of 377')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Next page' })).toBeDisabled();

    const select = screen.getByRole('combobox', { name: 'Rows per page' });
    expect(select).toHaveTextContent('25');
    select.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: '50' }));
    expect(onPageSizeChange).toHaveBeenCalledWith(50);
  });

  it('formats empty and single-page ranges', () => {
    expect(formatPaginationRange(1, 25, 0)).toBe('0 of 0');
    expect(formatPaginationRange(1, 25, 12)).toBe('1–12 of 12');
    expect(formatPaginationRange(3, 50, 1234)).toBe('101–150 of 1,234');
    expect(getPageCount(25, 0)).toBe(1);
    expect(getPageCount(25, 26)).toBe(2);
  });
});
