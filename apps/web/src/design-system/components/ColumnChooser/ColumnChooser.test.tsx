import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ColumnChooser } from './ColumnChooser';

const columns = [
  { id: 'unit', label: 'Unit', visible: true, canHide: false },
  { id: 'miles', label: 'Miles', visible: true },
  { id: 'status', label: 'Status', visible: false },
];

describe('ColumnChooser', () => {
  it('lists columns with their visibility and toggles one', async () => {
    const user = userEvent.setup();
    const onToggle = vi.fn();
    const onReset = vi.fn();
    render(<ColumnChooser columns={columns} onToggle={onToggle} onReset={onReset} />);
    const trigger = screen.getByRole('button', { name: /Columns/ });
    expect(trigger).toHaveTextContent('1 hidden');
    await user.click(trigger);
    expect(await screen.findByRole('menuitemcheckbox', { name: 'Unit' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
    expect(screen.getByRole('menuitemcheckbox', { name: 'Status' })).toHaveAttribute(
      'aria-checked',
      'false',
    );
    await user.click(screen.getByRole('menuitemcheckbox', { name: 'Miles' }));
    expect(onToggle).toHaveBeenCalledWith('miles', false);
    // The menu stays open so several columns can be toggled in a row.
    await user.click(screen.getByRole('menuitem', { name: 'Show all columns' }));
    expect(onReset).toHaveBeenCalledTimes(1);
  });
});
