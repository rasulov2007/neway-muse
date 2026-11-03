import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Select } from './Select';

const options = [
  { value: 'active', label: 'Active' },
  { value: 'in_shop', label: 'In shop' },
  { value: 'sold', label: 'Sold', disabled: true },
];

describe('Select', () => {
  it('shows the placeholder, opens with the keyboard and selects an option', async () => {
    const user = userEvent.setup();
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Status"
        options={options}
        onValueChange={onValueChange}
        placeholder="Status"
      />,
    );
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(trigger).toHaveTextContent('Status');

    trigger.focus();
    await user.keyboard('{Enter}');
    const listbox = await screen.findByRole('listbox');
    expect(listbox).toBeInTheDocument();

    await user.keyboard('{ArrowDown}{Enter}');
    expect(onValueChange).toHaveBeenCalledWith('in_shop');
  });

  it('renders the selected label and invalid state', () => {
    render(<Select aria-label="Status" options={options} value="active" invalid />);
    const trigger = screen.getByRole('combobox', { name: 'Status' });
    expect(trigger).toHaveTextContent('Active');
    expect(trigger).toHaveAttribute('aria-invalid', 'true');
  });
});
