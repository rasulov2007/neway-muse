import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { TrucksPage } from './TrucksPage';

beforeAll(() => setDemoLatency(false));

function render(path = '/fleet/trucks') {
  return renderPage(<TrucksPage />, { routePath: '/fleet/trucks', path });
}

/**
 * The table renders its caption before the fleet bundle resolves, so waiting on the table alone
 * finds an empty shell. Wait for real rows.
 */
async function loadedRows(): Promise<HTMLElement[]> {
  const table = await screen.findByRole('table', { name: 'Trucks' });
  await waitFor(() => expect(within(table).getAllByRole('row').length).toBeGreaterThan(3));
  return within(table).getAllByRole('row') as HTMLElement[];
}

describe('TrucksPage', () => {
  it('shows the fleet with the brief’s subtitle and a single create action', async () => {
    render();
    expect(await screen.findByRole('heading', { level: 1, name: 'Trucks' })).toBeInTheDocument();
    expect(
      screen.getByText('Manage fleet availability, assignments and maintenance.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add truck' })).toBeInTheDocument();
    // The brief is explicit that the Trucks page offers no Add Trailer.
    expect(screen.queryByRole('button', { name: /Add trailer/i })).toBeNull();
  });

  it('counts the summary strip with the same predicate the table filters on', async () => {
    const user = userEvent.setup();
    render();

    await loadedRows();
    const available = screen.getByRole('button', { name: /^Available/ });
    // The tile reads "Available 26 of 30 total"; the count is the first number.
    const count = Number((available.textContent ?? '').match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
    expect(count).toBeGreaterThan(0);

    await user.click(available);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: /^Available/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );

    // The table footer reports the same total the tile promised.
    await waitFor(() => expect(screen.getByText(new RegExp(`of ${count}$`))).toBeInTheDocument());
  });

  it('opens the unit on a single click, and offers no checkbox to select it with', async () => {
    const user = userEvent.setup();
    const { router } = render();
    const firstRow = (await loadedRows())[1] as HTMLElement;

    // Nothing acts on a selection here, so the column of checkboxes went with it.
    expect(within(firstRow).queryByRole('checkbox')).toBeNull();

    await user.click(within(firstRow).getAllByRole('cell')[1] as HTMLElement);

    await waitFor(() => expect(router.state.location.pathname).toMatch(/^\/fleet\/trucks\/trk_/));
  });

  it('narrows to exactly the units behind a finding when an exception is clicked', async () => {
    const user = userEvent.setup();
    render();

    await loadedRows();
    // The findings are behind the Needs attention segment of the summary strip: five coloured
    // cards above the fleet was the first thing the page said, every time.
    await user.click(screen.getByRole('button', { name: /Needs attention/i }));
    const finding = await screen.findByRole('button', {
      name: /trucks are overdue for maintenance/,
    });
    const count = Number((finding.textContent ?? '').match(/^(\d+)/)?.[1] ?? '0');
    expect(count).toBeGreaterThan(0);

    await user.click(finding);

    expect(
      await screen.findByText(`Showing the ${count} units behind one finding.`),
    ).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText(new RegExp(`of ${count}$`))).toBeInTheDocument());
  });
});
