import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { demoData, setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { TruckDetailPage } from './TruckDetailPage';

beforeAll(() => setDemoLatency(false));

/** A unit that actually has an accident against it, so History has something to show. */
const accident = demoData.accidents[0];
if (!accident) throw new Error('the demo book has no accidents');
const truckId = accident.truckId;

function render(search = '') {
  return renderPage(<TruckDetailPage truckId={truckId} />, {
    routePath: '/fleet/trucks/$truckId',
    path: `/fleet/trucks/${truckId}${search}`,
  });
}

/**
 * The section a unit page is showing lives in the URL. Opening an accident from History and
 * pressing Back has to come back to History — a tab kept in component state cannot survive that,
 * and landing on Overview after every record is what makes a history unusable.
 */
describe('the unit page keeps its section in the URL', () => {
  it('opens the section the link names', async () => {
    render('?tab=history');

    const tab = await screen.findByRole('tab', { name: 'History' });
    await waitFor(() => expect(tab).toHaveAttribute('aria-selected', 'true'));
    expect(await screen.findByText(accident.accidentNumber)).toBeVisible();
  });

  it('writes the section to the URL when one is chosen', async () => {
    const user = userEvent.setup();
    const { router } = render();

    expect(await screen.findByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await user.click(await screen.findByRole('tab', { name: 'History' }));
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'history' }));
  });

  it('shows a finished work order on the unit, not only the open ones', async () => {
    const truck = demoData.trucks.find((row) => row.id === truckId);
    if (!truck) throw new Error('the accident names a truck the book does not have');
    const order = {
      id: 'ro_test_done',
      roNumber: 'RO-9099',
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      type: 'pm_service' as const,
      description: 'Completed PM service',
      status: 'completed' as const,
      priority: 'normal' as const,
      vendorId: null,
      vendorName: null,
      openedAt: '2026-09-14T10:00:00.000Z',
      startedAt: '2026-09-14T10:00:00.000Z',
      completedAt: '2026-09-14T15:00:00.000Z',
      totalCost: 5503,
      invoiceNumber: null,
      invoiceFileName: null,
      notes: null,
    };
    demoData.repairOrders.push(order as unknown as (typeof demoData.repairOrders)[number]);

    try {
      render('?tab=maintenance');
      // Finished work is still this unit's maintenance record.
      expect(await screen.findByText('RO-9099')).toBeVisible();
      const row = (await screen.findByText('RO-9099')).closest('tr');
      expect(row).toHaveTextContent('Completed');
    } finally {
      const index = demoData.repairOrders.findIndex((row) => row.id === 'ro_test_done');
      if (index >= 0) demoData.repairOrders.splice(index, 1);
    }
  });

  it('keeps every other section it had', async () => {
    render();
    for (const label of [
      'Overview',
      'Driver',
      'Load',
      'Tracking',
      'Maintenance',
      'Expenses',
      'History',
      'Documents',
      'Performance',
      'Notes',
      'Activity',
    ]) {
      expect(await screen.findByRole('tab', { name: label })).toBeInTheDocument();
    }
  });
});
