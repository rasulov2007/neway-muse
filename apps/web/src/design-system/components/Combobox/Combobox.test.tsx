import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Combobox } from './Combobox';

const options = [
  { value: 'd1', label: 'Alice Johnson', description: 'CDL-A · Active' },
  { value: 'd2', label: 'Bob Martinez' },
  { value: 'd3', label: 'Carla Nguyen' },
];

describe('Combobox', () => {
  it('opens, filters by typing and selects with the keyboard', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(<Combobox aria-label="Driver" options={options} onValueChange={onValueChange} />);

    await user.click(screen.getByRole('button', { name: 'Driver' }));
    const search = await screen.findByPlaceholderText('Search…');
    expect(search).toHaveFocus();

    await user.type(search, 'bob');
    expect(screen.queryByText('Alice Johnson')).not.toBeInTheDocument();
    expect(screen.getByText('Bob Martinez')).toBeInTheDocument();

    await user.keyboard('{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('d2');
  });

  it('shows the empty message and calls onSearch in async mode', async () => {
    const user = userEvent.setup();
    const onSearch = vi.fn();
    render(
      <Combobox aria-label="Truck" options={[]} onSearch={onSearch} emptyMessage="No trucks" />,
    );
    await user.click(screen.getByRole('button', { name: 'Truck' }));
    await user.type(await screen.findByPlaceholderText('Search…'), '27');
    expect(onSearch).toHaveBeenLastCalledWith('27');
    expect(screen.getByText('No trucks')).toBeInTheDocument();
  });

  it('renders chips for multiple values and removes one', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Combobox
        multiple
        aria-label="Drivers"
        options={options}
        value={['d1', 'd3']}
        onValueChange={onValueChange}
      />,
    );
    expect(screen.getByText('Alice Johnson')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Remove Carla Nguyen' }));
    expect(onValueChange).toHaveBeenCalledWith(['d1']);

    await user.click(screen.getByRole('button', { name: 'Drivers' }));
    const list = await screen.findByRole('listbox');
    await user.click(within(list).getByText('Bob Martinez'));
    expect(onValueChange).toHaveBeenLastCalledWith(['d1', 'd3', 'd2']);
  });
});
