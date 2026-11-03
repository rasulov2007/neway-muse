import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Checkbox } from './Checkbox';

describe('Checkbox', () => {
  it('toggles when the label is clicked', async () => {
    const user = userEvent.setup();
    const onCheckedChange = vi.fn();
    render(
      <Checkbox
        label="Hazmat"
        description="Requires endorsement"
        onCheckedChange={onCheckedChange}
      />,
    );
    const box = screen.getByRole('checkbox', { name: 'Hazmat' });
    expect(box).toHaveAccessibleDescription('Requires endorsement');
    await user.click(screen.getByText('Hazmat'));
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });

  it('works without a visible label and supports indeterminate', () => {
    render(<Checkbox aria-label="Select all" checked="indeterminate" />);
    const box = screen.getByRole('checkbox', { name: 'Select all' });
    expect(box).toHaveAttribute('aria-checked', 'mixed');
    expect(box).toHaveAttribute('data-state', 'indeterminate');
  });
});
