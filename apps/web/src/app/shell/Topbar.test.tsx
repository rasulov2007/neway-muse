import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderShell } from './test-utils';

vi.mock('@/demo', async () => (await import('./demo-mock')).createDemoMock());

describe('CompanySelector', () => {
  it('a signed-in account with one company sees its own company and no switch menu (owner, 2026-10-27)', async () => {
    renderShell('/dashboard');
    await screen.findByRole('button', { name: /Account menu/ });
    expect(screen.queryByText('Switch company')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Northwind Freight/ })).not.toBeInTheDocument();
    expect(screen.queryByText(/Lakeside|Summit/)).not.toBeInTheDocument();
  });
});

describe('UserMenu', () => {
  it('offers only actions that go somewhere', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    await user.click(await screen.findByRole('button', { name: /Account menu/ }));
    const menu = await screen.findByRole('menu');

    // Sign out is the one action every account has. Profile, Preferences and a second copy of the
    // keyboard shortcuts used to sit here and only toast "available in a later phase".
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Profile' })).not.toBeInTheDocument();
    expect(within(menu).queryByRole('menuitem', { name: 'Preferences' })).not.toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', { name: 'Keyboard shortcuts' }),
    ).not.toBeInTheDocument();
  });
});

describe('Topbar', () => {
  it('shows the unread count on the bell', async () => {
    renderShell('/dashboard');
    expect(
      await screen.findByRole('button', { name: 'Notifications (1 unread)' }),
    ).toBeInTheDocument();
  });
});
