import { screen, within } from '@testing-library/react';
import { TEST_ACCOUNT } from '@/test/roster-server';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NAVIGATION } from '@/app/navigation';
import { SIDEBAR_STORAGE_KEY } from './shellState';
import { renderShell } from './test-utils';

vi.mock('@/demo', async () => (await import('./demo-mock')).createDemoMock());

async function findNav() {
  return screen.findByRole('navigation', { name: 'Main navigation' });
}

describe('Sidebar', () => {
  beforeEach(() => {
    window.localStorage.clear();
    // The menu shows only what the signed-in account may open; keep the administrator signed in.
    window.localStorage.setItem('neway.session.token', 'test-session-token');
    window.localStorage.setItem('neway.session.account', JSON.stringify(TEST_ACCOUNT));
  });

  it('renders every group and highlights the active item', async () => {
    renderShell('/dashboard');
    const nav = await findNav();
    for (const group of NAVIGATION) {
      expect(within(nav).getAllByText(group.label).length).toBeGreaterThan(0);
    }
    const dashboard = within(nav).getAllByRole('link', { name: 'Dashboard' })[0]!;
    expect(dashboard).toHaveAttribute('aria-current', 'page');
    expect(within(nav).getByRole('link', { name: 'Loads' })).not.toHaveAttribute('aria-current');
  });

  it('collapses from the toggle and persists the state', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    const nav = await findNav();
    expect(nav).toHaveAttribute('data-collapsed', 'false');
    await user.click(within(nav).getByRole('button', { name: 'Collapse sidebar' }));
    expect(nav).toHaveAttribute('data-collapsed', 'true');
    expect(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)).toBe('true');
    // Group labels give way to hairlines; items keep an accessible name.
    expect(within(nav).queryByText('Operations')).not.toBeInTheDocument();
    // Dispatch is gone from the navigation: it was the Loads page under another name.
    expect(within(nav).queryByRole('link', { name: 'Dispatch' })).not.toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Loads' })).toBeInTheDocument();
    await user.click(within(nav).getByRole('button', { name: 'Expand sidebar' }));
    expect(nav).toHaveAttribute('data-collapsed', 'false');
  });

  it('toggles with the [ shortcut but not while typing', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    const nav = await findNav();
    await user.keyboard('[[');
    expect(nav).toHaveAttribute('data-collapsed', 'true');
    await user.keyboard('[[');
    expect(nav).toHaveAttribute('data-collapsed', 'false');

    await user.keyboard('{Control>}k{/Control}');
    const input = await screen.findByPlaceholderText(/Search pages/);
    await user.type(input, '[[');
    expect(nav).toHaveAttribute('data-collapsed', 'false');
  });

  it('shows nested children only under the active PM & inspections item', async () => {
    // The Pre-trip board is a view under PM & inspections rather than a rival top-level page, so the
    // parent carries `aria-current` and the children are the ways into it.
    renderShell('/fleet/pti');
    const nav = await findNav();
    expect(within(nav).getAllByRole('link', { name: 'PM & inspections' })[0]).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Trucks' })).not.toHaveAttribute('aria-current');
  });

  it('hides nested children when another item is active', async () => {
    renderShell('/dispatch');
    const nav = await findNav();
    expect(within(nav).queryByRole('link', { name: 'Pre-trip board' })).not.toBeInTheDocument();
  });

  it('moves focus with the arrow keys', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    const nav = await findNav();
    within(nav).getAllByRole('link', { name: 'Dashboard' })[0]!.focus();
    await user.keyboard('{ArrowDown}');
    expect(within(nav).getByRole('link', { name: 'Analytics' })).toHaveFocus();
    await user.keyboard('{End}');
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveFocus();
    await user.keyboard('{Home}');
    expect(within(nav).getAllByRole('link', { name: 'Dashboard' })[0]!).toHaveFocus();
  });

  it('collapses and reopens a section when its own item is clicked', async () => {
    const user = userEvent.setup();
    renderShell('/fleet/oil-change');
    const nav = await findNav();
    const repairs = within(nav).getAllByRole('link', {
      name: /^PM & inspections/,
    })[0] as HTMLElement;

    expect(repairs).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeVisible();

    // Already on the page, so the click has no navigation to do and collapses instead.
    await user.click(repairs);
    expect(repairs).toHaveAttribute('aria-expanded', 'false');
    expect(within(nav).queryByRole('link', { name: 'Pre-trip board' })).not.toBeInTheDocument();

    await user.click(repairs);
    expect(repairs).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeVisible();
  });

  it('forgets a collapse once the operator leaves the section', async () => {
    const user = userEvent.setup();
    renderShell('/fleet/oil-change');
    const nav = await findNav();
    const repairs = within(nav).getAllByRole('link', {
      name: /^PM & inspections/,
    })[0] as HTMLElement;

    await user.click(repairs);
    expect(repairs).toHaveAttribute('aria-expanded', 'false');

    await user.click(within(nav).getByRole('link', { name: 'Trucks' }));
    await user.click(within(nav).getAllByRole('link', { name: /^PM & inspections/ })[0] as HTMLElement);

    // Back in the section, the default applies again rather than a collapse made elsewhere.
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeVisible();
  });

  it('still navigates from a child view rather than collapsing', async () => {
    const user = userEvent.setup();
    // The Pre-trip board shares the section's match list, so a child can look like the parent.
    // From one of them the row still has somewhere to go: the section's own page.
    renderShell('/fleet/pti');
    const nav = await findNav();
    const repairs = within(nav).getAllByRole('link', {
      name: /^PM & inspections/,
    })[0] as HTMLElement;

    await user.click(repairs);

    expect(repairs).toHaveAttribute('aria-expanded', 'true');
    expect(within(nav).getByRole('link', { name: 'Pre-trip board' })).toBeVisible();
  });
});
