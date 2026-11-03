import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { ToastProvider } from './ToastProvider';
import { useToast } from './useToast';

function Trigger({ onAction }: { onAction?: () => void }) {
  const { toast } = useToast();
  return (
    <button
      type="button"
      onClick={() =>
        toast({
          tone: 'success',
          title: 'Truck saved',
          description: 'Unit 2785 was updated.',
          action: onAction ? { label: 'View', onClick: onAction } : undefined,
        })
      }
    >
      Save
    </button>
  );
}

describe('Toast', () => {
  it('shows a toast with title, description and action, and dismisses it', async () => {
    const user = userEvent.setup();
    const onAction = vi.fn();
    render(
      <ToastProvider>
        <Trigger onAction={onAction} />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Truck saved')).toBeInTheDocument();
    expect(screen.getByText('Unit 2785 was updated.')).toBeInTheDocument();
    expect(screen.getByText('Success:')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'View' }));
    expect(onAction).toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Truck saved')).not.toBeInTheDocument());
  });

  it('closes from the dismiss button', async () => {
    const user = userEvent.setup();
    render(
      <ToastProvider>
        <Trigger />
      </ToastProvider>,
    );
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Truck saved');
    await user.click(screen.getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText('Truck saved')).not.toBeInTheDocument());
  });

  it('throws outside a provider', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => render(<Trigger />)).toThrow(/ToastProvider/);
    vi.restoreAllMocks();
  });
});
