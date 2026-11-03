import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { addDays, demoData, openPtiWeek, stateOf, updatePti, weekStartOf } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { PtiPage } from './PtiPage';
import { weekRangeLabel } from './pti-week-label';

/*
 * The board and modal here are the pre-fleet_v2 screen, which is what production runs until the
 * flag is turned on. With the flag on, "Update PTI" opens the review drawer instead - covered by
 * e2e/pti-drawer.spec.ts and src/features/fleet/pti/*.test.ts.
 */
beforeAll(() => setFlagForTests('fleet_v2', false));
afterAll(() => setFlagForTests('fleet_v2', null));
/** A test that pinned the clock must not leave it pinned for the next one. */
afterEach(() => vi.useRealTimers());

/**
 * Opening a week writes rows into the workspace, which asks the persistence scheduler to save.
 * The board is what is under test here, not the snapshot, so the scheduler is mocked away.
 */
vi.mock('@/demo/state-persist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo/state-persist')>()),
  saveSoon: vi.fn(),
}));

const ROUTE = { routePath: '/fleet/pti', path: '/fleet/pti' };

/**
 * Pins the clock past this period's video deadline.
 *
 * The deadline is the end of Wednesday, so on a Monday nothing is late yet and a test about
 * post-deadline behaviour would be asserting the wrong side of it. Friday of the same period is
 * unambiguously after it.
 */
function afterTheDeadline(): void {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(new Date('2026-10-02T12:00:00Z'));
}


/** The unit column, in the order the board prints it. Plain text now, not links. */
function dataRows(): HTMLElement[] {
  return screen
    .getAllByRole('row')
    .filter((row) => within(row).queryAllByRole('cell').length > 1) as HTMLElement[];
}

/**
 * The unit number out of the first cell, which carries the driver under it. It is marked rather
 * than parsed: the cell is two lines of text and reading the first one by hand is a guess.
 */
function unitIn(row: HTMLElement): string {
  return row.querySelector('[data-unit]')?.textContent?.trim() ?? '';
}

function unitNumbers(): string[] {
  return dataRows().map(unitIn);
}

/** The row a unit is printed on. */
function rowFor(unit: string): HTMLElement {
  const row = dataRows().find((candidate) => unitIn(candidate) === unit);
  if (!row) throw new Error(`no row for unit ${unit}`);
  return row;
}

/**
 * Picks a period from the list.
 *
 * The option is clicked rather than typed: typing a date drives a keystroke-per-character
 * re-render of the whole board, which is a second of nothing under a loaded suite and turns a
 * passing test into a timing question.
 */
async function choosePeriod(user: ReturnType<typeof userEvent.setup>, label: string) {
  await user.click(screen.getByRole('button', { name: 'Date range' }));
  await user.click(await screen.findByText(label));
  await waitFor(
    () => expect(screen.getByRole('button', { name: 'Date range' })).toHaveTextContent(label),
    { timeout: 15_000 },
  );
}

/**
 * The period is named by its dates. A week number is a private code — two months each have a
 * "Week 1", and nobody matching a row against a calendar or a driver's message can tell them
 * apart.
 */
describe('naming an inspection period', () => {
  it('names one month once when the period stays inside it', () => {
    expect(weekRangeLabel('2026-09-07')).toBe('Sep 7 – 13, 2026');
  });

  it('names both months when the period crosses one', () => {
    expect(weekRangeLabel('2026-08-31')).toBe('Aug 31 – Sep 6, 2026');
    expect(weekRangeLabel('2026-02-23')).toBe('Feb 23 – Mar 1, 2026');
  });

  it('names both years when the period crosses the new year', () => {
    expect(weekRangeLabel('2025-12-29')).toBe('Dec 29, 2025 – Jan 4, 2026');
  });

  it('reads the date as a calendar date, not through the local time zone', () => {
    // A Monday-start ISO date parsed as a timestamp moves a day west of Greenwich; the label must
    // still say the Monday.
    expect(weekRangeLabel('2026-03-02')).toBe('Mar 2 – 8, 2026');
  });
});

describe('the inspection board', () => {
  it('labels the selector by date range rather than by week number', async () => {
    renderPage(<PtiPage />, ROUTE);

    expect(await screen.findByText('Date range')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Date range' })).toHaveTextContent(
      weekRangeLabel(weekStartOf()),
    );
    expect(screen.queryByText(/Week \d/)).toBeNull();
  });

  it('returns the same rows when the same period is selected again', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));
    const before = unitNumbers();

    await choosePeriod(user, weekRangeLabel(addDays(weekStartOf(), -7)));
    await choosePeriod(user, weekRangeLabel(weekStartOf()));

    await waitFor(() => expect(unitNumbers()).toEqual(before));
  });

  it('keeps red for a walk-around that missed its deadline, not for one that is simply not in yet', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    // The next period is still open, so nothing in it is late or missing yet.
    await choosePeriod(user, weekRangeLabel(addDays(weekStartOf(), 7)));
    await waitFor(() => expect(screen.getAllByText('NOT IN').length).toBeGreaterThan(0));
    expect(screen.queryByText('MISSING')).toBeNull();
  });

  it('counts them as not in until the deadline, and as missing after it', async () => {
    afterTheDeadline();
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderPage(<PtiPage />, ROUTE);
    // This period's deadline has passed.
    await waitFor(() => expect(screen.getByText('Missing')).toBeVisible());
    expect(screen.queryByText('Not in')).toBeNull();

    await choosePeriod(user, weekRangeLabel(addDays(weekStartOf(), 7)));
    await waitFor(() => expect(screen.getByText('Not in')).toBeVisible());
    expect(screen.queryByText('Missing')).toBeNull();
  });

  it('leaves a truck in the shop neutral after the deadline, and only reddens one on the road', async () => {
    afterTheDeadline();
    const week = weekStartOf();
    const rows = openPtiWeek(week);
    const shop = rows.find((row) => stateOf(row) === 'shop');
    const road = rows.find((row) => stateOf(row) === 'road');
    if (!shop || !road) throw new Error('the demo book has no shop and road pair for this week');

    const before = [shop.status, road.status] as const;
    shop.status = 'no';
    road.status = 'no';

    try {
      renderPage(<PtiPage />, ROUTE);
      await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

      const shopRow = screen.getAllByText(shop.unitNumber)[0]?.closest('tr');
      const roadRow = screen.getAllByText(road.unitNumber)[0]?.closest('tr');
      // The shop owes its walk-around on release; it is exempt while it is in there.
      expect(shopRow).toHaveTextContent('NOT IN');
      expect(shopRow).not.toHaveTextContent('MISSING');
      expect(roadRow).toHaveTextContent('MISSING');
    } finally {
      shop.status = before[0];
      road.status = before[1];
    }
  });

  it('opens the review panel under its four numbered steps', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));
    const unit = unitNumbers()[0] as string;

    await user.click(within(rowFor(unit)).getByRole('button', { name: 'Update PTI' }));

    const dialog = await screen.findByRole('dialog');
    expect(
      within(dialog).getByText(`Unit ${unit} — ${weekRangeLabel(weekStartOf())}`),
    ).toBeVisible();
    expect(within(dialog).getByText('Receipt')).toBeVisible();
    expect(within(dialog).getByText('Review')).toBeVisible();
    expect(within(dialog).getByText('Issue & action')).toBeVisible();
    expect(within(dialog).getByText('Condition')).toBeVisible();
    // The action note stays reachable whether or not an issue was recorded.
    expect(within(dialog).getByLabelText('Action taken')).toBeInTheDocument();
  });

  it('prints the unit and the driver rather than sending anybody somewhere', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    const unit = unitNumbers()[0] as string;
    const row = rowFor(unit);
    const cells = within(row).getAllByRole('cell');

    // Nothing on the row navigates.
    expect(within(row).queryAllByRole('link')).toHaveLength(0);

    // And nothing on it opens the dialog either.
    await user.click(cells[0] as HTMLElement);
    await user.click(cells[1] as HTMLElement);
    await user.click(cells[3] as HTMLElement);
    await user.click(cells[5] as HTMLElement);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('opens the dialog from the button, by mouse or by keyboard', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    const unit = unitNumbers()[0] as string;
    const button = within(rowFor(unit)).getByRole('button', { name: 'Update PTI' });

    button.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByRole('dialog')).toHaveTextContent(`Unit ${unit}`);
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    await user.click(within(rowFor(unit)).getByRole('button', { name: 'Update PTI' }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(`Unit ${unit}`);
  });

  it('reads driver names and results in the case the sheet uses', async () => {
    const week = weekStartOf();
    const rows = openPtiWeek(week);
    const row = rows.find((r) => r.driverName && stateOf(r) === 'road');
    if (!row?.driverName) throw new Error('the demo book has no crewed road unit this week');
    const before = row.result;
    row.result = 'no_issues';

    try {
      renderPage(<PtiPage />, ROUTE);
      await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

      const printed = rowFor(row.unitNumber);
      expect(printed).toHaveTextContent(row.driverName.toUpperCase());
      expect(printed).toHaveTextContent('NO ISSUES');
      // The record itself is untouched; only the screen shouts.
      expect(row.driverName).not.toBe(row.driverName.toUpperCase());
    } finally {
      row.result = before;
    }
  });

  it('keeps the work order reference on a row that has one', async () => {
    const week = weekStartOf();
    const rows = openPtiWeek(week);
    const shown = rows.find((r) => stateOf(r) === 'road');
    // The stored record, not the copy a row that owes a fresh inspection is read through.
    const row = demoData.ptiRecords.find((r) => r.id === shown?.id);
    if (!row) throw new Error('the demo book has no road unit this week');
    const before = { action: row.actionTaken, order: row.workOrderNumber };
    row.actionTaken = 'Booked into the yard';
    row.workOrderNumber = 'RO-9001';

    try {
      renderPage(<PtiPage />, ROUTE);
      await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));
      expect(rowFor(row.unitNumber)).toHaveTextContent('RO-9001');
    } finally {
      row.actionTaken = before.action;
      row.workOrderNumber = before.order;
    }
  });

  it('records the account that saved it, and offers nobody else', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    const unit = unitNumbers()[0] as string;
    await user.click(within(rowFor(unit)).getByRole('button', { name: 'Update PTI' }));
    const dialog = await screen.findByRole('dialog');

    // The picker is gone: nobody chooses who did this.
    expect(within(dialog).queryByPlaceholderText('Type a name…')).toBeNull();
    expect(within(dialog).queryByText('Checked by')).toBeNull();
    expect(within(dialog).getByText('Updated by')).toBeVisible();
    // The signed-in account, by name — never its id.
    expect(within(dialog).getByText('System Administrator')).toBeVisible();
    expect(dialog).not.toHaveTextContent('usr_');

    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const saved = demoData.ptiRecords.find(
      (row) => row.unitNumber === unit && row.weekStart === weekStartOf(),
    );
    expect(saved?.checkedByName).toBe('System Administrator');
    expect(saved?.checkedById).toBe('usr_test_admin');
  });

  it('keeps the data columns and the filters on the board', async () => {
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    // Two of the headings carry a second line naming what rides under the pill in the cell.
    for (const column of [
      /^Unit \/ Driver$/,
      /^Dispatcher$/,
      /^Receipt status/,
      /^Review result/,
      /^Condition$/,
      /^Issue & action$/,
      /^Update$/,
    ]) {
      expect(screen.getByRole('columnheader', { name: column })).toBeInTheDocument();
    }

    expect(screen.getByPlaceholderText('Search unit, driver or issue')).toBeInTheDocument();
    expect(screen.getByLabelText('Show inactive')).toBeInTheDocument();
  });
});

describe('the general Update PTI action and the condition ratings', () => {
  /** A row whose result is already NO ISSUES, so the Condition section is on screen when it opens. */
  async function noIssuesRow() {
    const week = weekStartOf();
    openPtiWeek(week);
    const row = demoData.ptiRecords.find((r) => r.weekStart === week && stateOf(r) === 'road');
    if (!row) throw new Error('fixture');
    await updatePti(row.id, {
      status: 'sent',
      sentDate: week,
      result: 'no_issues',
      checkedDate: week,
    });
    return row;
  }

  it('opens from the header on the unit field, and picking a unit loads its record', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));
    const unit = unitNumbers()[0] as string;

    // The header button comes before every row button in the document.
    await user.click(screen.getAllByRole('button', { name: 'Update PTI' })[0] as HTMLElement);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(`Update PTI — ${weekRangeLabel(weekStartOf())}`)).toBeVisible();
    const unitField = within(dialog).getByRole('button', { name: 'Unit' });
    await waitFor(() => expect(unitField).toHaveFocus());

    await user.click(unitField);
    await user.click(
      (await screen.findAllByText(unit, { selector: '[cmdk-item] *' }))[0] as HTMLElement,
    );
    expect(
      await within(dialog).findByText(`Unit ${unit} — ${weekRangeLabel(weekStartOf())}`),
    ).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Change unit' })).toBeVisible();
    expect(within(dialog).getByRole('button', { name: 'Save and next' })).toBeVisible();
  });

  it('records component ratings, shows the worst one on the board with its window, and Due soon finds it', async () => {
    const user = userEvent.setup();
    const row = await noIssuesRow();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));

    await user.click(within(rowFor(row.unitNumber)).getByRole('button', { name: 'Update PTI' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Condition')).toBeVisible();

    await user.click(
      within(within(dialog).getByRole('group', { name: 'Steer tyres rating' })).getByRole(
        'button',
        { name: 'Good' },
      ),
    );
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Brakes rating' })).getByRole('button', {
        name: 'Monitor',
      }),
    );
    await user.click(
      within(within(dialog).getByRole('group', { name: 'Drive tyres rating' })).getByRole(
        'button',
        { name: 'Replace soon' },
      ),
    );
    await user.type(within(dialog).getByLabelText('Drive tyres expected window'), '1');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());

    const written = demoData.ptiRatings.filter((r) => r.recordId === row.id);
    expect(written.map((r) => r.rating).sort()).toEqual(['good', 'monitor', 'replace_soon']);
    expect(written.find((r) => r.rating === 'replace_soon')).toMatchObject({
      windowValue: 1,
      windowUnit: 'weeks',
    });

    await waitFor(() =>
      expect(within(rowFor(row.unitNumber)).getByText('Replace soon')).toBeVisible(),
    );
    expect(within(rowFor(row.unitNumber)).getByText(/Drive tyres · 7d left/)).toBeVisible();

    await user.click(screen.getByRole('button', { name: /Due soon/ }));
    await waitFor(() => expect(unitNumbers()).toEqual([row.unitNumber]));
  });

  it('keeps the dialog open on a fresh unit field after Save and next', async () => {
    const user = userEvent.setup();
    renderPage(<PtiPage />, ROUTE);
    await waitFor(() => expect(unitNumbers().length).toBeGreaterThan(0));
    const unit = unitNumbers()[0] as string;

    await user.click(within(rowFor(unit)).getByRole('button', { name: 'Update PTI' }));
    const dialog = await screen.findByRole('dialog');
    await user.click(within(dialog).getByRole('button', { name: 'Save and next' }));

    await waitFor(() =>
      expect(
        within(screen.getByRole('dialog')).getByText(
          `Update PTI — ${weekRangeLabel(weekStartOf())}`,
        ),
      ).toBeVisible(),
    );
    expect(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Unit' }),
    ).toBeInTheDocument();
  });
});
