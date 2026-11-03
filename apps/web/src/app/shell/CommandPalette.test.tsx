import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { globalSearch } from '@/demo';
import { renderShell } from './test-utils';

vi.mock('@/demo', async () => (await import('./demo-mock')).createDemoMock());

describe('CommandPalette', () => {
  it('opens with Ctrl+K, lists pages and closes with Escape', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Pages')).toBeInTheDocument();
    expect(within(dialog).getByText('Loads')).toBeInTheDocument();
    expect(within(dialog).getByText('Invoices')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('filters pages and shows entity results for the query', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/dashboard');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.click(await screen.findByRole('button', { name: /Search anything/ }));
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), '2785');
    expect(await within(dialog).findByText('Unit 2785')).toBeInTheDocument();
    expect(
      within(dialog).getByText(/Freightliner Cascadia · Marcus Reid · Active/),
    ).toBeInTheDocument();
    expect(vi.mocked(globalSearch)).toHaveBeenCalledWith('2785');

    await user.click(within(dialog).getByText('Unit 2785'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/fleet/trucks');
    expect(router.state.location.searchStr).toContain('unit=2785');
  });

  it('navigates to a page on select', async () => {
    const user = userEvent.setup();
    const { router } = renderShell('/dashboard');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'trail');
    await user.click(await within(dialog).findByText('Trailers'));
    expect(router.state.location.pathname).toBe('/fleet/trailers');
  });

  it('shows an empty message for an unknown query', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    await screen.findByRole('navigation', { name: 'Main navigation' });
    await user.keyboard('{Control>}k{/Control}');
    const dialog = await screen.findByRole('dialog');
    await user.type(within(dialog).getByRole('combobox'), 'zzzzqq');
    expect(await within(dialog).findByText(/No results for/)).toBeInTheDocument();
  });
});
