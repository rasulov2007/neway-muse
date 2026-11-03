import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Modal } from './Modal';

describe('Modal', () => {
  it('renders title, description, footer and closes from the X button', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Modal
        open
        onOpenChange={onOpenChange}
        title="New load"
        description="Quick create"
        footer={<button type="button">Save</button>}
      >
        Body
      </Modal>,
    );
    const dialog = screen.getByRole('dialog', { name: 'New load' });
    expect(dialog).toHaveAccessibleDescription('Quick create');
    expect(screen.getByText('Body')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('always has an accessible title and closes on Escape', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange}>
        Anonymous content
      </Modal>,
    );
    expect(screen.getByRole('dialog', { name: 'Dialog' })).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it('ignores Escape when not dismissible', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Modal open onOpenChange={onOpenChange} title="Saving" dismissible={false}>
        Please wait
      </Modal>,
    );
    expect(screen.queryByRole('button', { name: 'Close' })).not.toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
