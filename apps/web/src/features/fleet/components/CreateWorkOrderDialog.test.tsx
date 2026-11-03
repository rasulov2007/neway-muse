import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { CreateWorkOrderDialog } from './CreateWorkOrderDialog';
import { useFleet, type FleetTruck } from '../useFleet';

/**
 * The Create work order form as the owner drew it (2026-09-20), which is also Create repair.
 *
 * The entry rules are the Fleet specification's §2.3 (acceptance test A14): Completed is the
 * default because the paperwork comes after the job; the Type has no default so the repair is
 * coded on purpose; and only the five things a completed record must say block saving.
 */

beforeEach(() => {
  setDemoLatency(false);
  // Off: the form writes to the workspace, which the test harness has; the layout is the same.
  setFlagForTests('fleet_v2', false);
});
afterEach(() => setFlagForTests('fleet_v2', null));

/** Renders the dialog against a real truck from the workspace. */
function Harness() {
  const fleet = useFleet();
  const trucks = fleet.data?.trucks ?? [];
  if (trucks.length === 0) return <p>Loading…</p>;
  return (
    <CreateWorkOrderDialog
      open
      onOpenChange={() => {}}
      defaultTruckId={(trucks[0] as FleetTruck).truck.id}
      onDone={vi.fn()}
    />
  );
}

async function openDialog() {
  renderPage(<Harness />, { routePath: '/fleet/maintenance', path: '/fleet/maintenance' });
  return screen.findByRole('dialog', { name: /Create work order/i }, { timeout: 10_000 });
}

function field(dialog: HTMLElement, label: string): HTMLElement {
  return within(dialog).getByRole('combobox', { name: new RegExp(label, 'i') });
}

describe('Create work order', () => {
  it('offers no default type, so the repair is coded on purpose', async () => {
    const dialog = await openDialog();
    expect(field(dialog, '^Type$')).toHaveTextContent(/Pick a type/i);
  });

  it('opens on Completed, with the sections the invoice fills', async () => {
    const dialog = await openDialog();
    expect(field(dialog, '^Status$')).toHaveTextContent('Completed');
    expect(within(dialog).getByText(/^Back in service$/i)).toBeInTheDocument();
    expect(within(dialog).getByRole('region', { name: /What was done/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('textbox', { name: /Invoice total/i })).toBeInTheDocument();
    expect(within(dialog).getByRole('checkbox', { name: /Warranty claim/i })).toBeInTheDocument();
  });

  it('will not write up completed work without the shop, the date back, the total and a line', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();

    await user.type(within(dialog).getByRole('textbox', { name: /Title/i }), 'Radiator replaced');

    await waitFor(() =>
      expect(
        within(dialog).getByText(
          /Completed work needs a shop, a back-in-service date, an invoice total and at least one line with a system/i,
        ),
      ).toBeInTheDocument(),
    );
    expect(within(dialog).getByRole('button', { name: /Create work order/i })).toBeDisabled();
  });

  it('asks for the back-in-service date only when the work is finished', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();
    expect(within(dialog).getByText(/^Back in service$/i)).toBeInTheDocument();

    await user.click(field(dialog, '^Status$'));
    await user.click(await screen.findByRole('option', { name: 'In the shop' }));

    await waitFor(() => expect(within(dialog).queryByText(/^Back in service$/i)).toBeNull());
    // And the footer no longer lists the completed-only fields.
    expect(within(dialog).queryByText(/Completed work needs/i)).toBeNull();
  });

  it('adds and removes lines under What was done', async () => {
    const user = userEvent.setup();
    const dialog = await openDialog();
    const table = within(dialog).getByRole('region', { name: /What was done/i });
    expect(within(table).getAllByRole('textbox', { name: /Work performed/i })).toHaveLength(1);

    await user.click(within(table).getByRole('button', { name: /Add line/i }));
    expect(within(table).getAllByRole('textbox', { name: /Work performed/i })).toHaveLength(2);

    await user.click(within(table).getAllByRole('button', { name: /Remove line/i })[1]!);
    expect(within(table).getAllByRole('textbox', { name: /Work performed/i })).toHaveLength(1);
  });
});
