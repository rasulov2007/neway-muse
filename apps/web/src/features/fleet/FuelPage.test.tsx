import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { demoData, setDemoLatency, type FuelTransaction } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { companyDateOf } from '@/lib/clock';
import { FuelPage } from './FuelPage';
import { fuelSearchSchema } from './fuel-search';

beforeAll(() => setDemoLatency(false));

function render(path = '/fleet/fuel') {
  return renderPage(<FuelPage />, { routePath: '/fleet/fuel', path });
}

/** A range wide enough to hold every demo fill, whatever today is. */
function allTime(): string {
  const days = demoData.fuelTransactions.map((f) => companyDateOf(f.at)).sort();
  return `from=${days[0]}&to=${days[days.length - 1]}`;
}

async function loadedRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: 'Fuel transactions' });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(3));
  return within(table).getAllByRole('row') as HTMLElement[];
}

describe('FuelPage', () => {
  it('shows the four measured figures, with MPG measured or said to be missing', async () => {
    render(`/fleet/fuel?${allTime()}`);
    await loadedRows();

    const totals = screen.getByRole('region', { name: 'Fuel totals' });
    for (const label of ['Fuel spend', 'Gallons', 'Cost per gallon', 'Trucks fueled']) {
      expect(within(totals).getByText(label)).toBeInTheDocument();
    }
    // Every MPG on the page is measured over stated miles, never asserted bare.
    const gallons = within(totals).getByText('Gallons').parentElement as HTMLElement;
    expect(gallons.textContent).toMatch(/(MPG over [\d,]+ mi|no measurable MPG)/);
    expect(screen.getByRole('tab', { name: 'Transactions' })).toHaveAttribute(
      'data-state',
      'active',
    );
    expect(screen.getByRole('heading', { name: 'Selected transaction' })).toBeInTheDocument();
  });

  it('filters by the URL, so a link to one unit lands filtered', async () => {
    // A unit that actually has several fills, so the assertion has something to be wrong about.
    const counts = new Map<string, number>();
    for (const fill of demoData.fuelTransactions) {
      counts.set(fill.unitNumber, (counts.get(fill.unitNumber) ?? 0) + 1);
    }
    const unit = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] as string;
    expect(unit).toBeTruthy();

    render(`/fleet/fuel?unit=${encodeURIComponent(unit)}&${allTime()}`);
    const rows = await loadedRows();

    for (const row of rows.slice(1)) {
      const cell = within(row).getAllByRole('cell')[1] as HTMLElement;
      expect(within(cell).getByRole('link').textContent?.trim()).toBe(unit);
    }
  });

  it('accepts a numeric-looking unit in the URL', async () => {
    // The router parses `?unit=2747` into the number 2747; a plain z.string() rejected it and
    // blanked the page. Every fleet search field coerces instead.
    const unit = demoData.fuelTransactions[0]?.unitNumber as string;
    expect(fuelSearchSchema.parse({ unit: Number(unit) }).unit).toBe(unit);
    expect(fuelSearchSchema.parse({ unit }).unit).toBe(unit);
    // A malformed param degrades to "no filter" rather than an error screen.
    expect(fuelSearchSchema.parse({ page: 'nonsense' }).page).toBeUndefined();
    expect(fuelSearchSchema.parse({ from: 'yesterday' }).from).toBeUndefined();
    expect(fuelSearchSchema.parse({ tab: 'receipts' }).tab).toBeUndefined();
  });

  describe('a Relay fill', () => {
    const template = demoData.fuelTransactions[0] as FuelTransaction;
    const relay: FuelTransaction[] = [
      {
        ...template,
        id: 'fue_rly_TXN123',
        at: '2026-03-03T10:58:00Z',
        product: 'diesel',
        gallons: 119.8,
        pricePerGallon: 5.282,
        amount: 632.66,
        cardLast4: '4421',
        station: { brand: 'Pilot', name: 'Pilot #412', city: 'Haughton', state: 'LA' },
        anomalyFlags: [],
      },
      {
        ...template,
        id: 'fue_rly_TXN123_def',
        at: '2026-03-03T10:58:00Z',
        product: 'def',
        gallons: 9.8,
        pricePerGallon: 4.877,
        amount: 47.79,
        cardLast4: '4421',
        station: { brand: 'Pilot', name: 'Pilot #412', city: 'Haughton', state: 'LA' },
        anomalyFlags: [],
      },
    ];
    beforeAll(() => demoData.fuelTransactions.push(...relay));
    afterAll(() => {
      demoData.fuelTransactions.splice(demoData.fuelTransactions.length - relay.length);
    });

    it('offers its itemised transaction as the invoice, never a receipt image', async () => {
      render('/fleet/fuel?from=2026-03-03&to=2026-03-03&vendor=Pilot&state=LA');
      await waitFor(() => expect(screen.getAllByText('Haughton, LA').length).toBeGreaterThan(1));

      // "View" leads the fill, once; the DEF line is the same invoice.
      const table = screen.getByRole('table', { name: 'Fuel transactions' });
      expect(within(table).getAllByRole('button', { name: 'View' })).toHaveLength(1);

      // The selected panel sums the fill from its real lines.
      expect(screen.getAllByText('$680.45').length).toBeGreaterThan(0);
      expect(
        screen.getByText('From the Relay transaction — no receipt image is available'),
      ).toBeInTheDocument();

      await userEvent.click(screen.getByRole('button', { name: 'View invoice' }));
      const dialog = await screen.findByRole('dialog');
      expect(within(dialog).getByText('TXN123')).toBeInTheDocument();
      expect(within(dialog).getByText('•••• 4421')).toBeInTheDocument();
      expect(within(dialog).getByText('$680.45')).toBeInTheDocument();
      expect(within(dialog).queryByRole('img')).toBeNull();
    });

    it('lists one invoice per fill on the Invoices tab', async () => {
      render('/fleet/fuel?tab=invoices&from=2026-03-03&to=2026-03-03&vendor=Pilot&state=LA');
      const table = await screen.findByRole('table', { name: 'Fuel invoices' });
      await waitFor(() => expect(within(table).getByText('Diesel, DEF')).toBeInTheDocument());
      expect(within(table).getAllByRole('button', { name: 'View' })).toHaveLength(1);
      expect(within(table).getByText('$680.45')).toBeInTheDocument();
    });
  });
});
