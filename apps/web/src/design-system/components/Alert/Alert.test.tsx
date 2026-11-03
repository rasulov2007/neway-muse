import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Alert } from './Alert';

describe('Alert', () => {
  it('uses role=status for info and role=alert for danger/warning', () => {
    const { rerender } = render(<Alert tone="info" title="Heads up" />);
    expect(screen.getByRole('status')).toHaveTextContent('Heads up');
    rerender(<Alert tone="danger" title="Failed" />);
    expect(screen.getByRole('alert')).toHaveTextContent('Failed');
    rerender(<Alert tone="warning" title="Careful" />);
    expect(screen.getByRole('alert')).toHaveClass('bg-nw-warning-bg');
  });

  it('dismisses and calls onDismiss', async () => {
    const onDismiss = vi.fn();
    render(
      <Alert
        tone="success"
        title="Saved"
        description="All good"
        dismissible
        onDismiss={onDismiss}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('status')).toBeNull();
  });

  it('renders actions', () => {
    render(<Alert title="T" actions={<button type="button">Retry</button>} />);
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});
