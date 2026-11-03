import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DashboardTrendsSchema, type DashboardTrends, type TrendWeek } from '@neway/shared';
import { FULL_VISIBILITY, type Visibility } from '../visibility';
import { TrendWidget, TrendWidgetSkeleton } from './TrendWidget';

const WEEK_STARTS = [
  '2026-07-06',
  '2026-07-13',
  '2026-07-20',
  '2026-07-27',
  '2026-08-03',
  '2026-08-10',
  '2026-08-17',
  '2026-08-24',
] as const;

const WEEK_ENDS = [
  '2026-07-12',
  '2026-07-19',
  '2026-07-26',
  '2026-08-02',
  '2026-08-09',
  '2026-08-16',
  '2026-08-23',
  '2026-08-30',
] as const;

const SHORT_LABELS = [
  'Jul 6',
  'Jul 13',
  'Jul 20',
  'Jul 27',
  'Aug 3',
  'Aug 10',
  'Aug 17',
  'Aug 24',
] as const;

/**
 * One schema-valid week; the last week of the window is the selected one. `unknown` stays at zero
 * in every week so the widget's "drop a pay type nobody ran" rule is exercised by the fixture.
 */
function week(index: number, overrides: Partial<TrendWeek> = {}): TrendWeek {
  return {
    weekStart: WEEK_STARTS[index]!,
    weekEnd: WEEK_ENDS[index]!,
    label: `${SHORT_LABELS[index]!} – week ${index + 1}, 2026`,
    highlighted: index === 7,
    isComplete: true,
    gross: 250_000 + index * 1_000,
    cost: 180_000,
    profit: 70_000 + index * 1_000,
    rpm: 2.5,
    cpm: 1.8,
    ppm: 0.7,
    marginPct: 28,
    totalMiles: 100_000 + index * 1_000,
    activeTrucks: 54 + index,
    inactiveTrucks: 6,
    activeByPayType: {
      company: 30 + index,
      owner_operator: 12,
      lease_owner: 8,
      percentage: 4,
      unknown: 0,
    },
    avgGrossPerTruck: 4_600,
    avgCostPerTruck: 3_300,
    avgProfitPerTruck: 1_300,
    avgMilesPerTruck: 1_850,
    hasExpenseData: true,
    ...overrides,
  };
}

/**
 * Week 6 (`Aug 10`) has no expense coverage. Its expense-derived numbers are sent as zeros on
 * purpose so the test proves the widget honours `hasExpenseData` rather than printing "$0".
 */
const NO_EXPENSE_INDEX = 5;

/** Every metric the widget refuses to show without expense coverage. */
const EXPENSE_GATED = [
  'Cost',
  'Net profit',
  'CPM',
  'PPM',
  'Profit margin',
  'Avg cost / truck',
  'Avg profit / truck',
] as const;

/** One schema-valid summary metric; `delta` is derived here so the fixture stays self-consistent. */
function metric(value: number | null, previous: number | null, deltaPct: number | null) {
  return {
    value,
    previous,
    delta: value !== null && previous !== null ? value - previous : null,
    deltaPct,
    reasons: value === null ? ['unavailable'] : [],
    masked: false,
  };
}

/**
 * The window rolled up against the eight weeks before it. Seven of the eight weeks carry expense
 * data (`NO_EXPENSE_INDEX` does not), which is what the coverage caveat reads.
 */
function summary(overrides: Record<string, unknown> = {}) {
  return {
    window: { from: '2026-07-06', to: '2026-08-30', weeks: 8 },
    previousWindow: { from: '2026-05-11', to: '2026-07-05', weeks: 8 },
    gross: metric(2_450_000, 2_330_000, 5.2),
    cost: metric(1_500_000, 1_400_000, 7.1),
    profit: metric(950_000, 930_000, 2.2),
    rpm: metric(2.55, 2.48, 2.8),
    cpm: metric(1.75, 1.82, -3.8),
    ppm: metric(0.8, 0.66, 21.2),
    marginPct: metric(37.6, 35.2, 6.8),
    totalMiles: metric(828_000, 800_000, 3.5),
    activeTrucks: metric(58, 55, 5.5),
    expenseCoverage: { weeks: 8, weeksWithData: 7 },
    ...overrides,
  };
}

function trends(overrides: Partial<DashboardTrends> = {}): DashboardTrends {
  return DashboardTrendsSchema.parse({
    meta: {
      source: 'demo',
      generatedAt: '2026-09-06T12:00:00.000Z',
      period: {
        preset: 'last_week',
        from: '2026-08-24',
        to: '2026-08-30',
        label: 'Aug 24 – Aug 30, 2026',
        isComplete: true,
        timezone: 'America/Chicago',
        comparison: { from: '2026-08-17', to: '2026-08-23', label: 'Aug 17 – Aug 23, 2026' },
        weekStart: 1,
      },
    },
    weeks: WEEK_STARTS.map((_, i) =>
      i === NO_EXPENSE_INDEX
        ? week(i, {
            cost: 0,
            profit: 0,
            cpm: 0,
            ppm: 0,
            marginPct: 0,
            avgCostPerTruck: 0,
            avgProfitPerTruck: 0,
            hasExpenseData: false,
          })
        : week(i),
    ),
    summary: summary(),
    masked: false,
    ...overrides,
  });
}

function renderWidget(data = trends(), visibility: Visibility = FULL_VISIBILITY) {
  render(<TrendWidget trends={data} visibility={visibility} />);
}

/** The rendered cells of one metric row, in week order. */
function rowCells(metric: string): string[] {
  const header = screen.getByRole('rowheader', { name: metric });
  const row = header.closest('tr');
  expect(row).not.toBeNull();
  return within(row!)
    .getAllByRole('cell')
    .map((cell) => cell.textContent ?? '');
}

/** The trailing "Δ vs prev." cell of one metric row. */
function deltaCell(metric: string): HTMLElement {
  const cells = within(screen.getByRole('rowheader', { name: metric }).closest('tr')!).getAllByRole(
    'cell',
  );
  return cells[cells.length - 1]!;
}

/** One headline KpiCard, found by its label. */
function headlineCard(label: string): HTMLElement {
  const strip = screen.getByTestId('trend-headline');
  const card = within(strip).getByText(label).closest('[data-metric-state]');
  expect(card).not.toBeNull();
  return card as HTMLElement;
}

describe('TrendWidget', () => {
  it('renders the eight week columns and every metric row', () => {
    renderWidget();

    const headerRow = screen.getAllByRole('row')[0]!;
    const headers = within(headerRow).getAllByRole('columnheader');
    expect(headers).toHaveLength(10); // the sticky "Metric" column + 8 weeks + the delta column
    expect(headers[0]).toHaveTextContent('Metric');
    SHORT_LABELS.forEach((label, i) => {
      expect(headers[i + 1]).toHaveTextContent(label);
    });
    expect(headers[9]).toHaveTextContent('Δ vs prev.');

    for (const metric of [
      'Total gross',
      'Cost',
      'Net profit',
      'RPM',
      'CPM',
      'PPM',
      'Profit margin',
      'Active company drivers',
      'Active owner operators',
      'Active lease owners',
      'Active percentage',
      'Total active',
      'Total inactive',
      'Total miles',
      'Avg gross / truck',
      'Avg cost / truck',
      'Avg profit / truck',
      'Avg miles / truck',
    ]) {
      expect(screen.getByRole('rowheader', { name: metric })).toBeInTheDocument();
    }

    expect(rowCells('Total gross')).toHaveLength(9); // 8 weeks + the delta column
    expect(rowCells('Total gross')[0]).toBe('$250K');
    expect(rowCells('RPM')[0]).toBe('$2.50');
    expect(rowCells('Profit margin')[0]).toBe('28.0%');
    expect(rowCells('Total active')[7]).toBe('61');
    expect(screen.getByText('Weekly operating performance')).toBeInTheDocument();
    expect(screen.getByText('Last 8 weeks')).toBeInTheDocument();
    expect(screen.getByText('Weekly gross, cost & net profit')).toBeInTheDocument();
  });

  it('frames the table in a bordered cage with a sticky, centred header', () => {
    renderWidget();

    const table = screen.getByRole('table');
    const cage = table.parentElement!;
    expect(cage.className).toContain('rounded-lg');
    expect(cage.className).toContain('border-line');
    expect(cage.className).toContain('overflow-x-auto');

    // The header row stays visible while the 19-row table scrolls.
    const headers = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader');
    for (const header of headers) {
      expect(header.className).toContain('sticky');
      expect(header.className).toContain('top-0');
    }
    // The metric column stays left-aligned; the week columns are centred over their values.
    expect(headers[0]!.className).toContain('text-left');
    for (const header of headers.slice(1)) {
      expect(header.className).toContain('text-center');
    }
  });

  it('centres value cells and keeps them tabular', () => {
    renderWidget();

    const header = screen.getByRole('rowheader', { name: 'Total gross' });
    expect(header.className).toContain('text-left');
    for (const cell of within(header.closest('tr')!).getAllByRole('cell')) {
      expect(cell.className).toContain('text-center');
      expect(cell.className).toContain('tabular');
      expect(cell.className).not.toContain('text-right');
    }
  });

  it('formats the new metric rows by kind', () => {
    renderWidget();

    expect(rowCells('PPM')[0]).toBe('$0.70');
    expect(rowCells('Total inactive')[0]).toBe('6');
    expect(rowCells('Total miles')[0]).toBe('100,000 mi');
    expect(rowCells('Total miles')[7]).toBe('107,000 mi');
    expect(rowCells('Avg gross / truck')[0]).toBe('$4.6K');
    expect(rowCells('Avg cost / truck')[0]).toBe('$3.3K');
    expect(rowCells('Avg profit / truck')[0]).toBe('$1.3K');
    expect(rowCells('Avg miles / truck')[0]).toBe('1,850 mi');
    expect(rowCells('Active company drivers')[0]).toBe('30');
    expect(rowCells('Active company drivers')[7]).toBe('37');
    expect(rowCells('Active owner operators')[0]).toBe('12');
  });

  it('groups the fleet and per-truck blocks under uppercase captions', () => {
    renderWidget();

    // `th scope="rowgroup"` — a header for the block, not another column header.
    const fleet = screen.getByRole('rowheader', { name: 'Fleet' });
    const perTruck = screen.getByRole('rowheader', { name: 'Per truck averages' });
    expect(fleet).toHaveClass('eyebrow');
    expect(perTruck).toHaveClass('eyebrow');
    // Captions open their block: "Fleet" sits above the pay-type rows, not below them.
    const rowText = screen.getAllByRole('row').map((r) => r.textContent ?? '');
    const indexOf = (needle: string) => rowText.findIndex((text) => text.startsWith(needle));
    expect(indexOf('Fleet')).toBeGreaterThan(indexOf('Profit margin'));
    expect(indexOf('Fleet')).toBeLessThan(indexOf('Active company drivers'));
    expect(indexOf('Total miles')).toBeLessThan(indexOf('Per truck averages'));
    expect(indexOf('Per truck averages')).toBeLessThan(indexOf('Avg gross / truck'));
  });

  it('omits a pay type no week reports', () => {
    renderWidget();

    expect(screen.queryByRole('rowheader', { name: 'Active unknown' })).not.toBeInTheDocument();
  });

  it('omits the whole pay-type block when no week has driver attribution', () => {
    const data = trends();
    for (const w of data.weeks) w.activeByPayType = null;
    renderWidget(data);

    for (const metric of [
      'Active company drivers',
      'Active owner operators',
      'Active lease owners',
      'Active percentage',
      'Active unknown',
    ]) {
      expect(screen.queryByRole('rowheader', { name: metric })).not.toBeInTheDocument();
    }
    // The rest of the fleet block is unaffected.
    expect(screen.getByRole('rowheader', { name: 'Total active' })).toBeInTheDocument();
    expect(screen.getByText('Fleet')).toBeInTheDocument();
  });

  it('renders "—" (never "$0") for a week without expense data', () => {
    renderWidget();

    for (const metric of EXPENSE_GATED) {
      expect(rowCells(metric)[NO_EXPENSE_INDEX]).toBe('—');
    }
    // Gross, miles, counts and the gross-derived averages are unaffected.
    expect(rowCells('Total gross')[NO_EXPENSE_INDEX]).toBe('$255K');
    expect(rowCells('Total active')[NO_EXPENSE_INDEX]).toBe('59');
    expect(rowCells('Total inactive')[NO_EXPENSE_INDEX]).toBe('6');
    expect(rowCells('Total miles')[NO_EXPENSE_INDEX]).toBe('105,000 mi');
    expect(rowCells('Avg gross / truck')[NO_EXPENSE_INDEX]).toBe('$4.6K');
    expect(rowCells('Avg miles / truck')[NO_EXPENSE_INDEX]).toBe('1,850 mi');
    expect(screen.queryByText('$0')).not.toBeInTheDocument();
    expect(screen.queryByText('0.0%')).not.toBeInTheDocument();
    // The reason is named per cell, prefixed with the week it belongs to.
    expect(
      screen.getAllByTitle('Aug 10 – week 6, 2026: No expense data for this period'),
    ).toHaveLength(EXPENSE_GATED.length);
  });

  it('renders "—" for a null metric rather than inventing a zero', () => {
    const data = trends();
    data.weeks[0]!.totalMiles = null;
    data.weeks[0]!.inactiveTrucks = null;
    data.weeks[0]!.avgMilesPerTruck = null;
    renderWidget(data);

    expect(rowCells('Total miles')[0]).toBe('—');
    expect(rowCells('Total inactive')[0]).toBe('—');
    expect(rowCells('Avg miles / truck')[0]).toBe('—');
  });

  it('marks the highlighted week in text, not colour alone', () => {
    renderWidget();

    const selectedHeader = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader')[8];
    expect(selectedHeader).toHaveTextContent('Aug 24');
    expect(selectedHeader).toHaveTextContent('Selected');
    expect(screen.getByRole('table')).toHaveAccessibleName(/Selected week: Aug 24 – week 8, 2026/);
    expect(screen.getAllByRole('img')[0]).toHaveAccessibleName(
      /Selected week: Aug 24 – week 8, 2026/,
    );
  });

  it('marks an incomplete week as partial', () => {
    const data = trends();
    data.weeks[7]!.isComplete = false;
    renderWidget(data);

    const headers = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader');
    expect(headers[8]).toHaveTextContent('Selected · Partial');
  });

  it('renders "••••••" for financial values when masked', () => {
    renderWidget(trends({ masked: true }), { financial: false });

    for (const metric of [
      'Total gross',
      'Cost',
      'Net profit',
      'RPM',
      'CPM',
      'PPM',
      'Profit margin',
      'Avg gross / truck',
      'Avg cost / truck',
      'Avg profit / truck',
    ]) {
      expect(rowCells(metric).every((text) => text === '••••••')).toBe(true);
    }
    // Head counts and miles are not financial data and stay visible.
    expect(rowCells('Total active')[0]).toBe('54');
    expect(rowCells('Total inactive')[0]).toBe('6');
    expect(rowCells('Active company drivers')[0]).toBe('30');
    expect(rowCells('Total miles')[0]).toBe('100,000 mi');
    expect(rowCells('Avg miles / truck')[0]).toBe('1,850 mi');
    expect(
      screen.getByText(/Weekly performance is hidden by your financial visibility/),
    ).toBeInTheDocument();
  });

  it('shows the expense footnote only when a week lacks expense data', () => {
    const complete = trends();
    complete.weeks[NO_EXPENSE_INDEX] = week(NO_EXPENSE_INDEX);
    const { unmount } = render(<TrendWidget trends={complete} visibility={FULL_VISIBILITY} />);
    expect(screen.queryByText(/No expense data available for/)).not.toBeInTheDocument();
    unmount();

    renderWidget();
    expect(screen.getByText(/No expense data available for one week/)).toBeInTheDocument();
  });

  it('renders an empty chart state and no table when there are no weeks', () => {
    renderWidget(trends({ weeks: [], summary: null }));

    expect(screen.getByText('No weeks in this window.')).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });

  it('leads with five headline cards read straight off the summary', () => {
    renderWidget();

    const strip = screen.getByTestId('trend-headline');
    expect(strip.children).toHaveLength(5);

    expect(headlineCard('Total gross')).toHaveTextContent('$2,450,000');
    expect(headlineCard('Total gross')).toHaveTextContent('+5.2%');
    expect(headlineCard('Total cost')).toHaveTextContent('$1,500,000');
    expect(headlineCard('Net profit')).toHaveTextContent('$950,000');
    expect(headlineCard('Net profit')).toHaveTextContent('+2.2%');
    expect(headlineCard('RPM')).toHaveTextContent('$2.55');
    expect(headlineCard('Profit margin')).toHaveTextContent('37.6%');
    expect(headlineCard('Profit margin')).toHaveTextContent('+6.8%');
    // The comparison window is named from the payload, never hardcoded.
    expect(within(strip).getAllByText('vs. previous 8 weeks')).toHaveLength(5);
  });

  it('reads a rising cost as bad and a falling CPM as good', () => {
    renderWidget();

    const cost = headlineCard('Total cost');
    expect(cost).toHaveTextContent('+7.1%');
    expect(cost.querySelector('.text-nw-urgent-text')).not.toBeNull();
    expect(cost.querySelector('.text-nw-done-text')).toBeNull();

    const gross = headlineCard('Total gross');
    expect(gross.querySelector('.text-nw-done-text')).not.toBeNull();
    expect(gross.querySelector('.text-nw-urgent-text')).toBeNull();
  });

  it('renders a null summary metric as "—" with no delta', () => {
    renderWidget(trends({ summary: summary({ rpm: metric(null, null, null) }) }));

    const rpm = headlineCard('RPM');
    expect(rpm).toHaveTextContent('—');
    expect(rpm).toHaveAttribute('data-metric-state', 'null');
    expect(rpm.textContent).not.toMatch(/%/);
    expect(rpm).toHaveTextContent('Not available');
    // The other four cards are unaffected.
    expect(headlineCard('Total gross')).toHaveTextContent('$2,450,000');
  });

  it('omits the whole strip and the delta column when there is no summary', () => {
    renderWidget(trends({ summary: null }));

    expect(screen.queryByTestId('trend-headline')).not.toBeInTheDocument();
    const headers = within(screen.getAllByRole('row')[0]!).getAllByRole('columnheader');
    expect(headers).toHaveLength(9);
    expect(screen.queryByText('Δ vs prev.')).not.toBeInTheDocument();
    expect(rowCells('Total gross')).toHaveLength(8);
  });

  it('hides the headline money when masked', () => {
    renderWidget(trends({ masked: true }), { financial: false });

    for (const label of ['Total gross', 'Total cost', 'Net profit', 'RPM', 'Profit margin']) {
      const card = headlineCard(label);
      expect(card).toHaveTextContent('••••••');
      expect(card).toHaveAttribute('data-metric-state', 'masked');
      expect(card.textContent).not.toMatch(/\$|%/);
    }
  });

  it('caveats a window whose expense coverage is incomplete', () => {
    const { unmount } = render(<TrendWidget trends={trends()} visibility={FULL_VISIBILITY} />);
    expect(screen.getByText(/Cost and profit cover 7 of 8 weeks/)).toBeInTheDocument();
    expect(screen.getByText(/one week has no expense data/)).toBeInTheDocument();
    unmount();

    // A fully covered window states nothing: the rollup is a clean comparison.
    renderWidget(trends({ summary: summary({ expenseCoverage: { weeks: 8, weeksWithData: 8 } }) }));
    expect(screen.queryByText(/Cost and profit cover/)).not.toBeInTheDocument();
  });

  it('lists the three series in an inline legend beside the chart title', () => {
    renderWidget();

    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(
      within(legend)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Gross', 'Cost', 'Net profit']);
    // On the title's line, not under the plot.
    const header = screen.getByText('Weekly gross, cost & net profit').closest('header');
    expect(header).not.toBeNull();
    expect(header).toContainElement(legend);
  });

  it('closes each metric row with its window-over-window change', () => {
    renderWidget();

    expect(deltaCell('Total gross')).toHaveTextContent('Up +5.2%');
    expect(deltaCell('Total gross').querySelector('.text-success-text')).not.toBeNull();
    expect(deltaCell('PPM')).toHaveTextContent('+21.2%');
    expect(deltaCell('Total miles')).toHaveTextContent('+3.5%');
    expect(deltaCell('Total active')).toHaveTextContent('+5.5%');
    expect(deltaCell('Profit margin')).toHaveTextContent('+6.8%');
  });

  it('inverts the tone for cost, CPM and the per-truck cost row', () => {
    renderWidget();

    const cost = deltaCell('Cost');
    expect(cost).toHaveTextContent('Up +7.1%');
    expect(cost.querySelector('.text-danger-text')).not.toBeNull();
    expect(cost.querySelector('.text-success-text')).toBeNull();

    // A falling CPM is an improvement, so it reads green while pointing down.
    const cpm = deltaCell('CPM');
    expect(cpm).toHaveTextContent('Down -3.8%');
    expect(cpm.querySelector('.text-success-text')).not.toBeNull();
    expect(cpm.querySelector('.text-danger-text')).toBeNull();
  });

  it('renders "—" in the delta column for rows the summary does not carry', () => {
    renderWidget();

    for (const metricName of [
      'Total inactive',
      'Active company drivers',
      'Avg gross / truck',
      'Avg cost / truck',
      'Avg miles / truck',
    ]) {
      expect(deltaCell(metricName)).toHaveTextContent('—');
      expect(deltaCell(metricName).querySelector('.text-success-text')).toBeNull();
      expect(deltaCell(metricName).querySelector('.text-danger-text')).toBeNull();
    }
  });

  it('renders a skeleton with a chart block and one line per metric row', () => {
    const { container } = render(<TrendWidgetSkeleton />);
    // 2 header lines + 5 KPI cards x 3 lines + the chart block + one line per metric row.
    expect(container.querySelectorAll('.animate-pulse').length).toBe(32);
  });
});
