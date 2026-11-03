import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Pencil, Trash2 } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button';
import { DropdownMenu, MenuCheckboxItem, MenuItem, MenuLabel, MenuSeparator } from './DropdownMenu';

describe('DropdownMenu', () => {
  it('opens from the trigger and fires item selection', async () => {
    const user = userEvent.setup();
    const onEdit = vi.fn();
    const onDelete = vi.fn();
    render(
      <DropdownMenu trigger={<Button>Actions</Button>}>
        <MenuLabel>Truck</MenuLabel>
        <MenuItem icon={<Pencil />} shortcut="E" onSelect={onEdit}>
          Edit
        </MenuItem>
        <MenuCheckboxItem checked>Show archived</MenuCheckboxItem>
        <MenuSeparator />
        <MenuItem icon={<Trash2 />} destructive disabled onSelect={onDelete}>
          Delete
        </MenuItem>
      </DropdownMenu>,
    );
    await user.click(screen.getByRole('button', { name: 'Actions' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toBeInTheDocument();
    expect(screen.getByText('E')).toBeInTheDocument();
    expect(screen.getByRole('menuitemcheckbox', { name: 'Show archived' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(screen.getByRole('menuitem', { name: 'Delete' })).toHaveAttribute(
      'aria-disabled',
      'true',
    );

    await user.click(screen.getByRole('menuitem', { name: /Edit/ }));
    expect(onEdit).toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });
});
