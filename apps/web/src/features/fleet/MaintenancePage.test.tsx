import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { MaintenancePage } from './MaintenancePage';

beforeAll(() => setDemoLatency(false));

function render(path = '/fleet/maintenance') {
  return renderPage(<MaintenancePage />, { routePath: '/fleet/maintenance', path });
}

async function loadedRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: 'Work orders' });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(3));
  return within(table).getAllByRole('row') as HTMLElement[];
}

describe('MaintenancePage', () => {
  it('offers Create work order, and never a global Schedule maintenance', async () => {
    render();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Maintenance' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Create work order' })).toBeInTheDocument();
    // Scheduling a service needs a unit, so it only exists inside a unit's own page.
    expect(screen.queryByRole('button', { name: /Schedule maintenance/i })).toBeNull();
  });

  it('filters to the view a summary segment names, and the footer agrees with its count', async () => {
    const user = userEvent.setup();
    render();
    await loadedRows();

    const overdue = screen.getByRole('button', { name: /^Overdue/ });
    const count = Number((overdue.textContent ?? '').replace(/[^\d]/g, ''));
    expect(count).toBeGreaterThan(0);

    await user.click(overdue);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Overdue/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    await waitFor(() => expect(screen.getByText(new RegExp(`of ${count}\\b`))).toBeInTheDocument());
  });

  it('reads the view straight out of the URL, so the nav quick links land filtered', async () => {
    render('/fleet/maintenance?view=completed');
    await loadedRows();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Completed/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
  });

  it('offers only the transitions the write path allows', async () => {
    const user = userEvent.setup();
    render('/fleet/maintenance?view=completed');
    const rows = await loadedRows();
    const firstRow = rows[1] as HTMLElement;

    await user.click(within(firstRow).getByRole('button', { name: 'Row actions' }));

    // A completed order can be reopened into a shop; it cannot jump straight back to scheduled
    // or be completed twice.
    expect(await screen.findByRole('menuitem', { name: 'Reopen work' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Complete' })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: 'Schedule' })).toBeNull();
  });
});
