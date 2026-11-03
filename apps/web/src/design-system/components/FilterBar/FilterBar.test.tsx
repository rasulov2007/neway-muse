import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FilterBar, type FilterDefinition } from './FilterBar';
import { isFilterActive } from './filterUtils';

const filters: FilterDefinition[] = [
  {
    key: 'status',
    label: 'Status',
    type: 'select',
    options: [
      { value: 'in_transit', label: 'In transit' },
      { value: 'delivered', label: 'Delivered' },
    ],
  },
  {
    key: 'equipment',
    label: 'Equipment',
    type: 'multiselect',
    options: [
      { value: 'dry_van', label: 'Dry van' },
      { value: 'reefer', label: 'Reefer' },
    ],
  },
  { key: 'dates', label: 'Dates', type: 'daterange' },
  { key: 'ref', label: 'Reference', type: 'text' },
];

describe('FilterBar', () => {
  it('shows the value in an active chip and clears all filters', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    render(
      <FilterBar
        filters={filters}
        values={{ status: 'in_transit', equipment: ['dry_van', 'reefer'] }}
        onChange={() => {}}
        onClear={onClear}
      />,
    );
    expect(screen.getByRole('button', { name: 'Status: In transit' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Equipment: Dry van, Reefer' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reference' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(onClear).toHaveBeenCalledTimes(1);
  });

  it('opens a select chip and reports the chosen option', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<FilterBar filters={filters} values={{}} onChange={onChange} onClear={() => {}} />);
    expect(screen.queryByRole('button', { name: 'Clear filters' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Status' }));
    await user.click(await screen.findByRole('button', { name: 'Delivered' }));
    expect(onChange).toHaveBeenCalledWith('status', 'delivered');
  });

  it('toggles multiselect options', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(
      <FilterBar
        filters={filters}
        values={{ equipment: ['dry_van'] }}
        onChange={onChange}
        onClear={() => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Equipment: Dry van' }));
    await user.click(await screen.findByRole('checkbox', { name: 'Reefer' }));
    expect(onChange).toHaveBeenCalledWith('equipment', ['dry_van', 'reefer']);
  });

  it('debounces search input', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <FilterBar
        search={{ value: '', onChange: onSearch, placeholder: 'Search loads' }}
        values={{}}
        onChange={() => {}}
        onClear={() => {}}
      />,
    );
    const input = screen.getByRole('searchbox', { name: 'Search loads' });
    await user.type(input, 'abc');
    expect(input).toHaveValue('abc');
    expect(onSearch).not.toHaveBeenCalled();
    await waitFor(() => expect(onSearch).toHaveBeenCalledWith('abc'));
    expect(onSearch).toHaveBeenCalledTimes(1);
  });

  it('knows which values count as active', () => {
    expect(isFilterActive(undefined)).toBe(false);
    expect(isFilterActive('')).toBe(false);
    expect(isFilterActive([])).toBe(false);
    expect(isFilterActive({ from: undefined })).toBe(false);
    expect(isFilterActive('x')).toBe(true);
    expect(isFilterActive(['x'])).toBe(true);
    expect(isFilterActive({ from: new Date() })).toBe(true);
  });
});
