import { useMemo } from 'react';
import { summarizePerformance } from '@neway/shared';
import { KpiCard } from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import { isActiveLoad, type OperationalLoad } from '@/features/operations/useOperations';

const LOADING = 'Loading…';

/**
 * The five number cards over the loads register.
 *
 * Scope: every load in the operations bundle — the same set the "All" tab counts — not the rows
 * the current view, search or filters leave in the table. The cards are the register's headline;
 * the tab counts beside them are what narrows it. Counts come from those tab counts, so "7
 * delivered" here and "Delivered 7" on the tab can never disagree.
 *
 * Money and miles are not recomputed: they are `summarizePerformance`, the one roll-up the driver,
 * customer and broker pages use over the same per-load economics. Like there, cancelled loads are
 * counted but earn no revenue and run no miles.
 */
export function LoadsSummary({
  rows,
  counts,
  loading,
}: {
  rows: readonly OperationalLoad[];
  counts: { all: number; delivered: number; booked: number };
  loading: boolean;
}) {
  const summary = useMemo(
    () =>
      summarizePerformance(
        rows.map((row) => ({
          id: row.load.id,
          status: row.load.status,
          economics: row.economics,
          // On-time needs stops; the cards show money and miles only, so none are passed.
          stops: [],
        })),
      ),
    [rows],
  );

  const active = useMemo(() => {
    const drivers = new Set<string>();
    const units = new Set<string>();
    for (const row of rows) {
      if (!isActiveLoad(row.load) || !row.load.driverId) continue;
      drivers.add(row.load.driverId);
      if (row.load.truckUnit) units.add(row.load.truckUnit);
    }
    return { drivers: drivers.size, units: [...units].sort((a, b) => a.localeCompare(b)) };
  }, [rows]);

  const earning = summary.counts.total - summary.counts.cancelled;
  const unitsLine =
    active.units.length === 0
      ? active.drivers === 0
        ? 'No loads on the road'
        : 'No unit recorded'
      : `${active.units.length === 1 ? 'Unit' : 'Units'} ${active.units.slice(0, 3).join(', ')}${
          active.units.length > 3 ? ` +${active.units.length - 3}` : ''
        }`;

  return (
    <section
      aria-label="Loads summary"
      className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-5"
    >
      <KpiCard
        label="Loads"
        value={loading ? LOADING : formatNumber(counts.all)}
        hint={loading ? undefined : `${formatNumber(counts.delivered)} delivered · ${formatNumber(counts.booked)} booked`}
      />
      <KpiCard
        label="Revenue"
        value={loading ? LOADING : summary.revenue === null ? 'Not priced yet' : formatMoney(summary.revenue)}
        hint={
          loading
            ? undefined
            : summary.counts.cancelled > 0
              ? `${formatNumber(earning)} loads, cancelled left out`
              : `All ${formatNumber(summary.counts.total)} loads`
        }
      />
      <KpiCard
        label="Loaded miles"
        value={loading ? LOADING : summary.loadedMiles === null ? 'No miles yet' : formatNumber(summary.loadedMiles)}
        hint={
          loading
            ? undefined
            : summary.emptyMiles === null
              ? 'Deadhead not recorded'
              : `${formatNumber(summary.emptyMiles)} deadhead`
        }
      />
      <KpiCard
        label="Avg RPM"
        value={
          loading
            ? LOADING
            : !summary.loadedMiles
              ? 'No miles yet'
              : summary.revenuePerLoadedMile === null
                ? 'Not priced yet'
                : formatMoney(summary.revenuePerLoadedMile)
        }
        hint={loading ? undefined : 'Revenue ÷ loaded miles'}
      />
      <KpiCard
        label="Active drivers"
        value={loading ? LOADING : formatNumber(active.drivers)}
        hint={loading ? undefined : unitsLine}
      />
    </section>
  );
}
