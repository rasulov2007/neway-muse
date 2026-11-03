import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Button } from '../Button';
import { BulkActionBar } from './BulkActionBar';

describe('BulkActionBar', () => {
  it('shows the count, clears, and renders actions', async () => {
    const user = userEvent.setup();
    const onClear = vi.fn();
    const onAssign = vi.fn();
    render(
      <BulkActionBar count={3} noun="loads" onClear={onClear}>
        <Button variant="primary" size="sm" onClick={onAssign}>
          Assign driver
        </Button>
      </BulkActionBar>,
    );
    const bar = screen.getByRole('region', { name: 'Bulk actions' });
    expect(bar).toHaveTextContent('3 loads selected');
    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(onClear).toHaveBeenCalledTimes(1);
    await user.click(screen.getByRole('button', { name: 'Assign driver' }));
    expect(onAssign).toHaveBeenCalledTimes(1);
  });
});
