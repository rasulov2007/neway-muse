import type { DashboardOpsNet, OpsNetBucket, OpsNetCosts } from '@neway/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { FULL_VISIBILITY, visibilityOf } from '../visibility';
import { OpsNetWidget } from './OpsNetWidget';

/**
 * Local fixture: the shared `opsNetFixture` still predates the per-category `costs` breakdown that
 * this widget is built on, so the table's data is spelled out here instead.
 */
function costs(overrides: Partial<OpsNetCosts> = {}): OpsNetCosts {
  return {
    fuel: null,
    insurance: null,
    maintenance: null,
    tolls: null,
    repairs: null,
    dispatch_fee: null,
    factoring: null,
    driver_pay: null,
    staff_payroll: null,
    other: null,
    ...overrides,
  };
}

function bucket(overrides: Partial<OpsNetBucket> = {}): OpsNetBucket {
  return {
    payType: 'company',
    label: 'Company drivers',
    driverCount: 6,
    gross: 100_000,
    costs: costs(),
    fuel: null,
    insurance: null,
    factoring: null,
    driverPay: null,
    driverPayEstimated: 0,
    other: null,
    totalCost: null,
    operatingProfit: null,
    marginPct: null,
    rpm: null,
    totalMiles: null,
    activeTrucks: null,
    avgGrossPerTruck: null,
    avgMilesPerTruck: null,
    ...overrides,
  };
}

const meta: DashboardOpsNet['meta'] = {
  source: 'demo',
  generatedAt: '2026-08-31T06:00:00.000Z',
  period: {
    preset: 'last_week',
    from: '2026-08-24',
    to: '2026-08-30',
    label: 'Aug 24 - Aug 30, 2026',
    isComplete: true,
    timezone: 'America/Chicago',
    comparison: { from: '2026-08-17', to: '2026-08-23', label: 'Aug 17 - Aug 23, 2026' },
    weekStart: 1,
  },
};

function opsNet(overrides: Partial<DashboardOpsNet> = {}): DashboardOpsNet {
  const company = bucket({
    payType: 'company',
    label: 'Company drivers',
    driverCount: 6,
    gross: 100_000,
    costs: costs({
      driver_pay: 25_000,
      fuel: 30_000,
      insurance: 5_000,
      dispatch_fee: 4_000,
      factoring: 3_000,
      tolls: 1_000,
      maintenance: 2_000,
      repairs: 500,
      other: 1_500,
    }),
    driverPayEstimated: 2_400,
    totalCost: 72_000,
    operatingProfit: 28_000,
    marginPct: 28,
    rpm: 2.5,
    totalMiles: 40_000,
    activeTrucks: 6,
    avgGrossPerTruck: 16_666.67,
    avgMilesPerTruck: 6_666.67,
  });
  const owner = bucket({
    payType: 'owner_operator',
    label: 'Owner operators',
    driverCount: 4,
    gross: 50_000,
    // No maintenance and no repairs at all: "Repair & maintenance" must stay null here.
    costs: costs({ driver_pay: 20_000, fuel: 12_000, insurance: 2_000 }),
    totalCost: 34_000,
    operatingProfit: 16_000,
    marginPct: 32,
    rpm: 2.1,
    totalMiles: 24_000,
    activeTrucks: 4,
    avgGrossPerTruck: 12_500,
    avgMilesPerTruck: 6_000,
  });
  const unknownBucket = bucket({
    payType: 'unknown',
    label: 'Unknown pay type',
    driverCount: 2,
    gross: 10_000,
    costs: costs({ driver_pay: 3_000, fuel: 2_000 }),
    totalCost: 5_000,
    operatingProfit: 5_000,
    activeTrucks: 2,
    totalMiles: 5_000,
  });
  return {
    meta,
    buckets: [company, owner, unknownBucket],
    totals: bucket({
      payType: 'unknown',
      label: 'Total',
      driverCount: 12,
      gross: 160_000,
      costs: costs({
        driver_pay: 48_000,
        fuel: 44_000,
        insurance: 7_000,
        dispatch_fee: 4_000,
        factoring: 3_000,
        tolls: 1_000,
        maintenance: 2_000,
        repairs: 500,
        other: 1_500,
      }),
      driverPayEstimated: 2_400,
      totalCost: 111_000,
      operatingProfit: 49_000,
      marginPct: 30.6,
      rpm: 2.32,
      totalMiles: 69_000,
      activeTrucks: 12,
      avgGrossPerTruck: 13_333.33,
      avgMilesPerTruck: 5_750,
    }),
    inactiveTruckLoss: 4_000,
    netOperatingProfit: 45_000,
    unknown: {
      driverCount: 2,
      gross: 10_000,
      drivers: [
        { driverId: 'drv_1', name: 'Pavel Ivanov', rawPayTag: 'OO-lease?' },
        { driverId: 'drv_2', name: 'Dmitri Volkov', rawPayTag: null },
      ],
    },
    masked: false,
    ...overrides,
  };
}

/** The detail table; scoped so donut legend labels never collide with column headers. */
const table = () => within(screen.getByRole('table'));

/** The cells of one P&L line, in column order: buckets first, Total last. */
function lineCells(label: string): HTMLElement[] {
  const row = table().getByRole('rowheader', { name: label }).closest('tr')!;
  return within(row).getAllByRole('cell');
}

describe('OpsNetWidget', () => {
  it('renders P&L lines as rows and driver pay types plus a total as columns', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    const headers = table().getAllByRole('columnheader');
    expect(headers.map((h) => h.textContent?.trim().split(' ')[0])).toEqual([
      'Line',
      'Company',
      'Owner',
      'Unknown',
      'Total',
    ]);
    // Driver counts ride along as a muted suffix on each column header.
    expect(headers[1]).toHaveTextContent('Company drivers 6');
    expect(headers[4]).toHaveTextContent('Total 12');

    for (const label of [
      'Total gross',
      'Driver gross pay',
      'Fuel cost',
      'Truck insurance',
      'Dispatch fee',
      'Factoring',
      'Toll cost',
      'Repair & maintenance',
      'Other expenses',
      'Total cost',
      'Operating profit',
      'Loss on inactive trucks',
      'Net operating profit',
      'RPM',
      'Total miles',
      'Active trucks',
      'Avg gross / truck',
      'Avg miles / truck',
    ]) {
      expect(table().getByRole('rowheader', { name: label })).toBeInTheDocument();
    }

    const gross = lineCells('Total gross');
    expect(gross[0]).toHaveTextContent('$100,000.00');
    expect(gross[1]).toHaveTextContent('$50,000.00');
    expect(gross[2]).toHaveTextContent('$10,000.00');
    // Costs read as negative amounts.
    expect(lineCells('Fuel cost')[0]).toHaveTextContent('−$30,000.00');
    expect(lineCells('Driver gross pay')[0]).toHaveTextContent('incl. $2.4K est.');
  });

  it('shows "—" for accounting lines with no data source, in every column', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    for (const label of [
      'Driver other pay',
      'Vendor gross pay',
      'Truck payment',
      'Trailer payment',
      'ELD & SAM',
      'IFTA',
      'Safety',
      'Other admin cost',
    ]) {
      const cells = lineCells(label);
      expect(cells).toHaveLength(4);
      for (const cell of cells) expect(cell).toHaveTextContent('—');
    }
    // A bucket that simply has no value for a sourced line also shows "—", never 0.
    const dispatch = lineCells('Dispatch fee');
    expect(dispatch[1]).toHaveTextContent('—');
    expect(dispatch[1]).not.toHaveTextContent('$0');
  });

  it('sums maintenance and repairs into "Repair & maintenance", null only when both are', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);
    const cells = lineCells('Repair & maintenance');

    expect(cells[0]).toHaveTextContent('−$2,500.00');
    expect(cells[1]).toHaveTextContent('—');
    expect(cells[3]).toHaveTextContent('−$2,500.00');
  });

  it('keeps a repair-only bucket numeric rather than null', () => {
    const data = opsNet();
    const patched: DashboardOpsNet = {
      ...data,
      buckets: data.buckets.map((b, i) =>
        i === 1 ? { ...b, costs: { ...b.costs, repairs: 750 } } : b,
      ),
    };
    render(<OpsNetWidget opsNet={patched} visibility={FULL_VISIBILITY} />);

    expect(lineCells('Repair & maintenance')[1]).toHaveTextContent('−$750.00');
  });

  it('renders each line as a percentage of its own column gross', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    // 30,000 / 100,000 company · 12,000 / 50,000 owner · 44,000 / 160,000 total.
    const fuel = lineCells('Fuel cost');
    expect(fuel[0]).toHaveTextContent('30.0%');
    expect(fuel[1]).toHaveTextContent('24.0%');
    expect(fuel[3]).toHaveTextContent('27.5%');
    expect(lineCells('Operating profit')[0]).toHaveTextContent('28.0%');
    // Unit lines carry no share of gross.
    expect(lineCells('Active trucks')[0]).not.toHaveTextContent('%');
  });

  it('puts company-level lines in the Total column only', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    const loss = lineCells('Loss on inactive trucks');
    expect(loss[0]).toHaveTextContent('—');
    expect(loss[1]).toHaveTextContent('—');
    expect(loss[2]).toHaveTextContent('—');
    expect(loss[3]).toHaveTextContent('−$4,000.00');
    expect(loss[0]).toHaveAttribute('title', expect.stringContaining('Company-level'));

    const net = lineCells('Net operating profit');
    expect(net[0]).toHaveTextContent('—');
    expect(net[3]).toHaveTextContent('$45,000.00');
  });

  it('reconciles the Total column with the totals bucket, not a client-side sum', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    expect(lineCells('Total gross')[3]).toHaveTextContent('$160,000.00');
    expect(lineCells('Total cost')[3]).toHaveTextContent('−$111,000.00');
    expect(lineCells('Operating profit')[3]).toHaveTextContent('$49,000.00');
    expect(lineCells('Total miles')[3]).toHaveTextContent('69,000 mi');
    expect(lineCells('Active trucks')[3]).toHaveTextContent('12');
    expect(lineCells('RPM')[3]).toHaveTextContent('$2.32');
  });

  it('keeps the unknown pay-type strip with its Investigate drill-down', async () => {
    const onDrilldown = vi.fn();
    render(
      <OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} onDrilldown={onDrilldown} />,
    );

    const strip = screen.getByRole('status');
    expect(strip).toHaveTextContent('2 drivers have an unknown pay type');
    expect(strip).toHaveTextContent('$10,000.00 of gross is unclassified');

    await userEvent.click(within(strip).getByRole('button', { name: 'Investigate' }));
    expect(onDrilldown).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'unknown_pay_types' }),
    );
    expect(onDrilldown.mock.calls[0]?.[0].unknown.drivers).toHaveLength(2);
  });

  it('footnotes the untagged drivers under the table, truncating a long list', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);
    expect(
      screen.getByText(/of gross belongs to drivers without a parseable pay tag/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Pavel Ivanov, Dmitri Volkov/)).toBeInTheDocument();

    const data = opsNet();
    const many = {
      ...data,
      unknown: {
        ...data.unknown,
        driverCount: 9,
        drivers: Array.from({ length: 9 }, (_, i) => ({
          driverId: `drv_${i}`,
          name: `Driver ${i}`,
          rawPayTag: null,
        })),
      },
    };
    render(<OpsNetWidget opsNet={many} visibility={FULL_VISIBILITY} />);
    expect(screen.getByText(/Driver 5 and 3 more/)).toBeInTheDocument();
    expect(screen.queryByText(/Driver 6/)).toBeNull();
  });

  it('masks money but keeps counts and miles readable, and withholds the donut', () => {
    render(<OpsNetWidget opsNet={opsNet({ masked: true })} visibility={visibilityOf(true)} />);

    expect(lineCells('Total gross')[0]).toHaveTextContent('••••••');
    expect(lineCells('Fuel cost')[0]).toHaveTextContent('••••••');
    expect(lineCells('RPM')[0]).toHaveTextContent('••••••');
    expect(lineCells('Active trucks')[0]).toHaveTextContent('6');
    expect(lineCells('Total miles')[0]).toHaveTextContent('40,000 mi');
    expect(screen.queryByText('$100,000.00')).not.toBeInTheDocument();

    expect(screen.getByText('Revenue split hidden')).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
  });

  it('cages the table: sticky header, centred values, no border past the last column', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    // The header must survive scrolling 26 P&L lines.
    for (const header of table().getAllByRole('columnheader')) {
      expect(header.className.split(' ')).toContain('sticky');
      expect(header.className.split(' ')).toContain('top-0');
    }

    // Amounts and their share-of-gross line read centred in the cell, not flushed right.
    const cells = lineCells('Fuel cost');
    for (const cell of cells) {
      expect(cell.className).toContain('text-center');
      expect(cell.className).not.toContain('text-right');
      expect(cell.className).toContain('border-r');
    }
    // The outer cage draws the right edge, so the last column drops its own.
    expect(cells.at(-1)?.className).toContain('last:border-r-0');
    expect(within(cells[0]!).getByText('30.0%')).toBeInTheDocument();

    // The line name stays left-aligned against the value grid.
    expect(table().getByRole('rowheader', { name: 'Fuel cost' }).className).toContain('text-left');
  });

  it('shows the proportion-of-revenue donut with a legend row per driver type', () => {
    render(<OpsNetWidget opsNet={opsNet()} visibility={FULL_VISIBILITY} />);

    const chart = screen.getByRole('img', { name: /Proportion of gross revenue by driver type/ });
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('Total $160K'));
    const rows = within(screen.getByRole('list', { name: 'Legend' })).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
  });
});
