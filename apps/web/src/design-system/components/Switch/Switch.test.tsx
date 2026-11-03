import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Switch } from './Switch';

describe('Switch', () => {
  it('toggles from the label and exposes description', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Switch
        label="Auto-dispatch"
        description="Assign loads automatically"
        onCheckedChange={onCheckedChange}
      />,
    );
    const control = screen.getByRole('switch', { name: 'Auto-dispatch' });
    expect(control).toHaveAccessibleDescription('Assign loads automatically');
    await user.click(screen.getByText('Auto-dispatch'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('respects disabled', () => {
    render(<Switch aria-label="Notifications" disabled />);
    expect(screen.getByRole('switch', { name: 'Notifications' })).toBeDisabled();
  });
});
