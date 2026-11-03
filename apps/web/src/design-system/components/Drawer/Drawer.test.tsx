import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { Drawer } from './Drawer';

describe('Drawer', () => {
  it('renders header pieces, tabs, footer and the full page action', async () => {
    const user = userEvent.setup();
    const onOpenFullPage = vi.fn();
    const onOpenChange = vi.fn();
    render(
      <Drawer
        open
        onOpenChange={onOpenChange}
        title="Unit 2785"
        description="Freightliner Cascadia"
        headerExtra={<span>Active</span>}
        tabs={<nav>Tabs</nav>}
        footer={<button type="button">Edit</button>}
        onOpenFullPage={onOpenFullPage}
      >
        Details
      </Drawer>,
    );
    const dialog = screen.getByRole('dialog', { name: 'Unit 2785' });
    expect(dialog).toHaveAccessibleDescription('Freightliner Cascadia');
    expect(screen.getByText('Active')).toBeInTheDocument();
    expect(screen.getByText('Tabs')).toBeInTheDocument();
    expect(screen.getByText('Details')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Open full page' }));
    expect(onOpenFullPage).toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
