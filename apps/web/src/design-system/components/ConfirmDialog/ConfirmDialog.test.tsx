import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

describe('ConfirmDialog', () => {
  it('awaits an async onConfirm, shows loading, then closes', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    let resolve: () => void = () => {};
    const onConfirm = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    render(
      <ConfirmDialog
        open
        onOpenChange={onOpenChange}
        title="Delete truck?"
        description="This cannot be undone."
        tone="danger"
        confirmLabel="Delete"
        onConfirm={onConfirm}
      />,
    );
    const confirm = screen.getByRole('button', { name: 'Delete' });
    await user.click(confirm);
    expect(onConfirm).toHaveBeenCalled();
    expect(confirm).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeDisabled();
    expect(onOpenChange).not.toHaveBeenCalled();

    resolve();
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });

  it('cancel closes without confirming', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    const onConfirm = vi.fn();
    render(
      <ConfirmDialog open onOpenChange={onOpenChange} title="Archive?" onConfirm={onConfirm} />,
    );
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
    expect(onConfirm).not.toHaveBeenCalled();
  });
});
