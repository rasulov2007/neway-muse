import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { FleetExpensePage } from './FleetExpensePage';
import { expenseSearchSchema } from './expense-search';

beforeAll(() => setDemoLatency(false));

function render(path = '/fleet') {
  return renderPage(<FleetExpensePage />, { routePath: '/fleet', path });
}

/** The stubbed transport answers `/fleet/expense-summary` with the fixture in `src/test/fixtures`. */
describe('FleetExpensePage', () => {
  it('shows the server figures with their basis, and a dash with the reason where there is none', async () => {
    render();
    expect(await screen.findByText('$1,630.50')).toBeInTheDocument();
    // The range names the date-range control and both section headings.
    expect(screen.getAllByText('Sep 1 – Sep 15, 2026').length).toBeGreaterThan(0);
    expect(screen.getByText(/2 completed work orders/)).toBeInTheDocument();

    // Cost per mile could not be computed: a dash and the coverage reason, never a zero.
    const cpm = screen.getByText('Maintenance cost / mile').closest('div') as HTMLElement;
    expect(cpm.parentElement?.textContent).toMatch(/—/);
    expect(screen.getByText(/No unit has odometer readings spanning/)).toBeInTheDocument();
    expect(screen.getByText('Lease mileage terms not configured')).toBeInTheDocument();
    // Present-tense figures say so.
    expect(screen.getByText('In shop now')).toBeInTheDocument();
    expect(screen.getByText('Inactive now')).toBeInTheDocument();
  });

  it('puts the period and units in the URL and sends them to the API', async () => {
    const { router } = render('/fleet?period=quarter&units=trk_2701');
    await screen.findByText('$1,630.50');
    expect(router.state.location.search).toMatchObject({ period: 'quarter', units: 'trk_2701' });

    await userEvent.click(screen.getByRole('tab', { name: 'Month' }));
    await waitFor(() =>
      expect(router.state.location.search).toMatchObject({ period: 'month', units: 'trk_2701' }),
    );
  });

  it('opens exactly the records a count counted', async () => {
    render();
    await screen.findByText('$1,630.50');

    const list = screen.getByRole('list', { name: 'Most frequent service types' });
    // Three types with one event each; the first row is brake repair.
    await userEvent.click(within(list).getAllByRole('button', { name: '1 event' })[0] as HTMLElement);

    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Brake repair' })).toBeInTheDocument();
    expect(within(drawer).getByText(/1 record · \$1,250\.00/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'RO-2001' })).toHaveAttribute(
      'href',
      '/fleet/maintenance/ro_1',
    );
    expect(within(drawer).queryByText('RO-2002')).not.toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: /Open the 1 work order/ })).toHaveAttribute(
      'href',
      '/fleet/maintenance?ids=ro_1',
    );
  });

  it('lists findings with their numbers and the checks that could not run', async () => {
    render();
    await screen.findByText('$1,630.50');
    expect(screen.getByText('Unit 2701 spent 3.1× its trailing average')).toBeInTheDocument();
    expect(screen.getByText(/Did not run: cost per mile above the fleet median; unit in the shop too long/)).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Review all' }));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText(/Work orders record when they were opened/)).toBeInTheDocument();
    expect(within(drawer).getByRole('link', { name: 'Unit 2701' })).toHaveAttribute(
      'href',
      '/fleet/trucks/trk_2701',
    );
  });

  it('links each vehicle to its unit and the in-shop count to the filtered trucks list', async () => {
    render();
    await screen.findByText('$1,630.50');
    expect(screen.getByRole('link', { name: '2702' })).toHaveAttribute(
      'href',
      '/fleet/trucks/trk_2702',
    );
    expect(screen.getByText('+212.5%')).toBeInTheDocument();
  });

  it('degrades a malformed URL to the defaults rather than an error screen', () => {
    expect(expenseSearchSchema.parse({ period: 'decade' }).period).toBeUndefined();
    expect(expenseSearchSchema.parse({ units: 2701 }).units).toBe('2701');
  });
});
