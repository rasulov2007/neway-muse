import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { setClockForTests } from '@/lib/clock';
import { setFlagForTests } from '@/lib/feature-flags';
import { servePtiBoard } from '@/test/roster-server';
import { briefRows } from './pti/board-fixtures';
import { FleetTodayPage } from './FleetTodayPage';

const NOW = '2026-09-17T14:30:00-05:00';

beforeAll(() => setDemoLatency(false));
beforeEach(() => {
  setClockForTests(NOW);
  setFlagForTests('fleet_v2', true);
  // The PM board is not served by the test server; the oil numbers then come from the Today feed.
  setFlagForTests('pm_module', false);
  servePtiBoard(briefRows());
});
afterEach(() => {
  setClockForTests(null);
  setFlagForTests('fleet_v2', null);
  setFlagForTests('pm_module', null);
});

function render() {
  return renderPage(<FleetTodayPage />, { routePath: '/fleet/today', path: '/fleet/today' });
}

describe('FleetTodayPage', () => {
  it('shows each board’s own count and lists the shop with its provider and stage', async () => {
    render();
    await screen.findByText(/items · highest priority first/);
    const tiles = within(screen.getByRole('region', { name: "Today's numbers" }));
    // The Today feed's counts (fixture: 1 overdue, 1 due soon, 1 in the shop).
    expect(tiles.getByRole('button', { name: /Oil change overdue/ })).toHaveTextContent('1');
    expect(tiles.getByRole('button', { name: /Oil due/ })).toHaveTextContent('1');
    expect(tiles.getByRole('button', { name: /In the shop now/ })).toHaveTextContent('1');
    expect(tiles.getByRole('button', { name: /Waiting on parts/ })).toHaveTextContent('1');
    // The pre-trip board's: one missing video, one unactioned defect.
    expect(tiles.getByRole('button', { name: /Walk-arounds missing/ })).toHaveTextContent('1');
    expect(tiles.getByRole('button', { name: /PTI issues unresolved/ })).toHaveTextContent('1');

    const shop = within(
      screen.getByRole('heading', { name: 'In the shop' }).closest('div')!.parentElement!
        .parentElement as HTMLElement,
    );
    expect(shop.getByText('TA Truck Service – Effingham')).toBeInTheDocument();
    expect(shop.getByText('Waiting on parts')).toBeInTheDocument();
  });

  it('lists what needs a decision, worst first, with one action each, and the segments filter it', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByText(/items · highest priority first/);
    const rows = screen.getAllByRole('row').filter((r) => within(r).queryByRole('button'));
    expect(rows.length).toBeGreaterThan(0);
    // The out-of-service defect on 2718 outranks the waiting-on-parts order.
    const first = rows[0] as HTMLElement;
    expect(first).toHaveTextContent(/Dispatch held|Out of service/);

    await user.click(screen.getByRole('button', { name: 'PTI' }));
    await waitFor(() => expect(screen.getByText(/DEF-4417/)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Assign owner' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Shop' }));
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Open order' })).toBeInTheDocument(),
    );
    expect(screen.getAllByText('Waiting on parts').length).toBeGreaterThanOrEqual(2);
  });
});
