import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { TEST_ACCOUNT, servePtiBoard } from '@/test/roster-server';
import { PtiPage } from '../PtiPage';
import { briefRows } from './board-fixtures';

beforeAll(() => setDemoLatency(false));

function render(search = '') {
  return renderPage(<PtiPage />, { routePath: '/fleet/pti', path: `/fleet/pti${search}` });
}

const counters = () => within(screen.getByRole('group', { name: 'Filter' }));
const table = () => within(screen.getByRole('table', { name: 'Trucks' }));
const rowOf = (unit: string) => {
  const cell = table().getByText(unit, { selector: 'span' });
  const tr = cell.closest('tr');
  if (!tr) throw new Error(`no row for ${unit}`);
  return within(tr);
};

/*
 * The board as the owner drew it (2026-09-22): four counters that are also the filters, one
 * group per counter, one button per row; a row opens the review form in place of the board.
 * The fixture week: 2785 sent nothing, 2760 sent and unreviewed, 2718 holds an oos defect,
 * 0069 waits for a repair to be confirmed, 2701 is clean, 2740 is in the shop.
 */
describe('the pre-trip board (owner layout, 2026-09-22)', () => {
  beforeEach(() => {
    setFlagForTests('fleet_v2', true);
    servePtiBoard(briefRows());
    window.localStorage.setItem(
      'neway.session.account',
      JSON.stringify({ ...TEST_ACCOUNT, permissions: ['maintenance.view', 'maintenance.edit'] }),
    );
  });
  afterEach(() => setFlagForTests('fleet_v2', null));

  it('counts the week into the four counters and opens on the issues', async () => {
    render();
    await screen.findByRole('table', { name: 'Trucks' });
    expect(counters().getByRole('button', { name: /Nothing sent/ })).toHaveTextContent('1');
    expect(counters().getByRole('button', { name: /To review/ })).toHaveTextContent('1');
    expect(counters().getByRole('button', { name: /Open issues/ })).toHaveTextContent('2');
    expect(counters().getByRole('button', { name: /^2\s*Clean/ })).toHaveTextContent('2');
    expect(counters().getByRole('button', { name: /Open issues/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(counters().getByRole('button', { name: /Open issues/ })).toHaveTextContent(
      '1 holding a truck',
    );

    // The issues group first: the held truck, then the one waiting to be confirmed.
    expect(rowOf('2718').getByText('On hold')).toBeVisible();
    expect(rowOf('2718').getByText(/Brakes — Slack adjuster/)).toBeVisible();
    expect(rowOf('0069').getByText('Repaired')).toBeVisible();
    expect(rowOf('0069').getByRole('button', { name: 'Confirm & clear' })).toBeVisible();
    expect(table().queryByText('2785')).not.toBeInTheDocument();
  });

  it('a counter is a filter: Nothing sent shows the truck to chase, with its button', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole('table', { name: 'Trucks' });
    await user.click(counters().getByRole('button', { name: /Nothing sent/ }));
    expect(rowOf('2785').getByText('Missing')).toBeVisible();
    expect(rowOf('2785').getByRole('button', { name: 'Chase driver' })).toBeVisible();
    expect(table().queryByText('2718')).not.toBeInTheDocument();
  });

  it('a search finds a unit in any group, whichever counter is chosen (owner, 2026-10-26)', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole('table', { name: 'Trucks' });
    await user.click(counters().getByRole('button', { name: /Nothing sent/ }));
    // 0069 sits in Open issues, 2701 in the folded Clean group.
    await user.type(screen.getByRole('searchbox', { name: /Search unit/ }), '0069');
    expect(rowOf('0069').getByText('Repaired')).toBeVisible();
    await user.clear(screen.getByRole('searchbox', { name: /Search unit/ }));
    await user.type(screen.getByRole('searchbox', { name: /Search unit/ }), '2701');
    expect(rowOf('2701').getByText('No issues')).toBeVisible();
  });

  it('clean trucks collapse until asked for', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole('table', { name: 'Trucks' });
    await user.click(counters().getByRole('button', { name: /^2\s*Clean/ }));
    // Chosen from its counter the group opens straight away; collapse hides it again.
    expect(rowOf('2701').getByText('No issues')).toBeVisible();
    await user.click(table().getByRole('button', { name: 'collapse' }));
    expect(table().queryByText('2701')).not.toBeInTheDocument();
    expect(table().getByText(/reviewed and clear/)).toBeVisible();
  });

  it('Review opens the form beside the board: No issues, every component Good, one Save', async () => {
    const user = userEvent.setup();
    render();
    await screen.findByRole('table', { name: 'Trucks' });
    await user.click(counters().getByRole('button', { name: /To review/ }));
    await user.click(rowOf('2760').getByRole('button', { name: 'Review' }));

    const form = await screen.findByRole('region', { name: 'Review unit 2760' });
    // The board stays where it was; the review is a drawer over it.
    expect(screen.getByRole('table', { name: 'Trucks', hidden: true })).toBeInTheDocument();
    expect(within(form).getByRole('button', { name: /^No issues/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    // Everything starts at Good; the tally says so once the catalog is in.
    const good = await within(form).findAllByRole(
      'button',
      { name: / Good$/ },
      { timeout: 10_000 },
    );
    for (const b of good) expect(b).toHaveAttribute('aria-pressed', 'true');
    expect(within(form).getByText(new RegExp(`${good.length} good`))).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(within(form).queryByRole('button', { name: 'Save & next' })).not.toBeInTheDocument();
    expect(within(form).getByText('Inspection history')).toBeVisible();

    // Soon flags the row and promises a tracked issue; the truck keeps running.
    await user.click(within(form).getAllByRole('button', { name: / Soon$/ })[0]!);
    expect(within(form).getByText('1 soon')).toBeVisible();
    expect(within(form).getByText(/will open a tracked issue/)).toBeVisible();
    expect(within(form).getByText(/the truck keeps running/)).toBeVisible();

    // Cancel asks first, like the oil-change sheet; Leave closes the drawer.
    await user.click(within(form).getByRole('button', { name: 'Cancel' }));
    await user.click(
      within(await screen.findByRole('dialog', { name: 'Leave without saving?' })).getByRole(
        'button',
        { name: 'Leave' },
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Review unit 2760' })).not.toBeInTheDocument(),
    );
  });

  it('a missing video cannot be saved, and the form says why', async () => {
    render('?review=trk_2785');
    const form = await screen.findByRole('region', { name: 'Review unit 2785' });
    expect(within(form).getByRole('button', { name: 'Missing' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(within(form).getByText('Nothing to review until the video comes.')).toBeVisible();
    expect(within(form).getByRole('button', { name: 'Save' })).toBeDisabled();
  });
});
