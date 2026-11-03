import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { setClockForTests } from '@/lib/clock';
import { fleetTodayFixture } from '@/test/fixtures/fleet-today';
import { ShopTodayPage } from './ShopTodayPage';

/** Nine days and six and a half hours after the fixture's work order went into the shop. */
const NOW = '2026-09-17T14:30:00-05:00';

beforeEach(() => setClockForTests(NOW));
afterEach(() => setClockForTests(null));

function render() {
  return renderPage(<ShopTodayPage />, { routePath: '/fleet/today', path: '/fleet/today' });
}

/** The section a heading owns, so an assertion cannot be satisfied by a row in a different one. */
async function section(name: string): Promise<HTMLElement> {
  const heading = await screen.findByText(name);
  const panel = heading.closest('section');
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

describe('ShopTodayPage', () => {
  it('shows the three sections with a count in each header', async () => {
    render();

    const oil = await section('Oil change');
    expect(within(oil).getByText('1 overdue')).toBeInTheDocument();
    expect(within(oil).getByText('1 due soon')).toBeInTheDocument();
    expect(within(oil).getByText('1 no record')).toBeInTheDocument();

    const inspections = await section('Inspections');
    expect(within(inspections).getByText('1 overdue')).toBeInTheDocument();

    const inShop = await section('In the shop');
    expect(within(inShop).getByText('1 in the shop')).toBeInTheDocument();
  });

  it('says how far past due each unit is, in the unit the service is measured in', async () => {
    render();

    const oil = await section('Oil change');
    // Miles for an oil change, and the direction said in words rather than by a minus sign.
    expect(within(oil).getByText('7,000 mi over')).toBeInTheDocument();
    expect(within(oil).getByText('600 mi left')).toBeInTheDocument();
    // No baseline is "No record", not "Overdue": the two ask for different work.
    expect(within(oil).getByText('No record')).toBeInTheDocument();

    // Days for a trailer inspection, which has no odometer to measure against.
    const inspections = await section('Inspections');
    expect(within(inspections).getByText('65 days overdue')).toBeInTheDocument();
  });

  it('groups the units with no service history instead of listing them above what is due', async () => {
    render();
    const user = userEvent.setup();
    const oil = await section('Oil change');

    // The unit with no baseline is counted, not listed: it would otherwise sit above the overdue
    // one, and a fleet new to the product has one of these for every truck.
    expect(within(oil).getByText('1 with no oil change on record')).toBeInTheDocument();
    expect(within(oil).queryByText('3099')).not.toBeInTheDocument();
    // What is due is still on top.
    expect(within(oil).getByText('3008')).toBeInTheDocument();

    await user.click(within(oil).getByRole('button', { name: /Show them/ }));
    expect(await within(oil).findByText('3099')).toBeInTheDocument();
    expect(within(oil).getByText(/No oil change on record/)).toBeInTheDocument();

    await user.click(within(oil).getByRole('button', { name: /Hide them/ }));
    await waitFor(() => expect(within(oil).queryByText('3099')).not.toBeInTheDocument());
  });

  it('counts downtime from the company clock, not from the payload', async () => {
    render();

    const inShop = await section('In the shop');
    // 2026-09-08 13:00Z to 2026-09-17 19:30Z.
    expect(within(inShop).getByText('9d 6h')).toBeInTheDocument();
    expect(within(inShop).getByText('Waiting for parts')).toBeInTheDocument();
  });

  it('carries no money anywhere on the page', async () => {
    render();
    await section('In the shop');

    // The endpoint sends no cost field; this asserts the page has not grown one from elsewhere.
    expect(document.body.textContent).not.toMatch(/\$/);
    expect(screen.queryByText(/invoice/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/vendor/i)).not.toBeInTheDocument();
  });

  it('filters the inspections section without touching the others', async () => {
    render();
    const user = userEvent.setup();
    const inspections = await section('Inspections');

    expect(within(inspections).getByText('5502')).toBeInTheDocument();
    expect(within(inspections).getByText('3021')).toBeInTheDocument();

    await user.click(within(inspections).getByRole('button', { name: 'Trailers' }));
    await waitFor(() => expect(within(inspections).queryByText('3021')).not.toBeInTheDocument());
    expect(within(inspections).getByText('5502')).toBeInTheDocument();

    await user.click(within(inspections).getByRole('button', { name: 'Overdue' }));
    await waitFor(() => expect(within(inspections).queryByText('3021')).not.toBeInTheDocument());
    expect(within(inspections).getByText('5502')).toBeInTheDocument();

    // The oil section is untouched by the inspection filter.
    const oil = await section('Oil change');
    expect(within(oil).getByText('3021')).toBeInTheDocument();
  });

  it('opens the create modal from a row with the unit and the work already filled in', async () => {
    render();
    const user = userEvent.setup();
    const oil = await section('Oil change');

    const row = within(oil).getByText('3008').closest('li') as HTMLElement;
    await user.click(within(row).getByRole('button', { name: 'Create work order' }));

    const dialog = await screen.findByRole('dialog');
    // The one Create work order form (the owner's 2026-09-20 mockup), with the row's answers in.
    expect(within(dialog).getByRole('combobox', { name: 'Type' })).toHaveTextContent('Oil change');
    expect(within(dialog).getByRole('textbox', { name: 'Unit (truck or trailer)' })).toBeInTheDocument();
    expect(within(dialog).getByRole('combobox', { name: 'Status' })).toHaveTextContent('Completed');
  });

  it('says nothing is due rather than drawing an empty list', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if (raw.includes('/fleet/today')) {
        const empty = fleetTodayFixture();
        return new Response(
          JSON.stringify({
            ...empty,
            oilChanges: [],
            inspections: [],
            workOrdersInShop: [],
            counts: {
              oilOverdue: 0,
              oilDueSoon: 0,
              oilUnknown: 0,
              inspectionsOverdue: 0,
              inspectionsDueSoon: 0,
              inShop: 0,
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      return original(input, init);
    }) as typeof fetch;

    try {
      render();
      await waitFor(() =>
        expect(screen.getAllByText('Nothing due — all good')).toHaveLength(3),
      );
    } finally {
      globalThis.fetch = original;
    }
  });
});
