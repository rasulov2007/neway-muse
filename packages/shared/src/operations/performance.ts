/**
 * Counterparty and resource performance.
 *
 * Driver, customer and broker performance are the same computation over a set of loads, so there is
 * one engine rather than three. That is what stops the driver page, the customer page and the
 * broker page from quoting three different profits for the same work.
 *
 * Everything is derived from loads and their stops. Nothing is stored on the customer or broker
 * record, because a stored aggregate goes stale the moment a load is edited.
 *
 * Honesty rules, same as the rest of the operations domain:
 *  - An unknown figure is `null`, never `0`, and `coverage` says how much of the set could actually
 *    be priced. "Profit $0" and "profit unknown for 6 of 20 loads" are different answers.
 *  - Metrics that need data this system does not hold are listed in `unavailable`, not invented.
 */
import type { LoadEconomics } from './economics.js';

export interface PerformanceStop {
  kind: 'pickup' | 'delivery';
  appointmentStartAt: string | null;
  appointmentEndAt: string | null;
  arrivedAt: string | null;
  departedAt: string | null;
  detentionMinutes: number;
}

export interface PerformanceLoad {
  id: string;
  status: string;
  /** Already restated on total miles by `computeLoadEconomics`. */
  economics: LoadEconomics;
  stops: readonly PerformanceStop[];
}

export interface PerformanceCoverage {
  /** Loads in the set. */
  loads: number;
  /** Loads whose economics could be computed. */
  priced: number;
  /** Delivery stops with both an appointment and an arrival, so lateness is knowable. */
  timedDeliveries: number;
  /** Pickup stops with both an appointment and an arrival. */
  timedPickups: number;
}

export interface PerformanceSummary {
  counts: {
    total: number;
    active: number;
    delivered: number;
    cancelled: number;
  };
  revenue: number | null;
  totalCost: number | null;
  profit: number | null;
  marginPct: number | null;
  loadedMiles: number | null;
  emptyMiles: number | null;
  totalMiles: number | null;
  deadheadPct: number | null;
  revenuePerLoadedMile: number | null;
  revenuePerTotalMile: number | null;
  profitPerTotalMile: number | null;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  /** Mean minutes between arrival and departure across stops that recorded both. */
  avgDwellMinutes: number | null;
  detentionMinutes: number | null;
  cancellationRatePct: number | null;
  coverage: PerformanceCoverage;
  reasons: string[];
  /** Metrics this system cannot produce yet, each naming what it needs. */
  unavailable: Array<{ metric: string; requires: string }>;
}

const ACTIVE = new Set([
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);
const CANCELLED = new Set(['cancelled', 'tonu']);

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

function sumOrNull(values: Array<number | null>): number | null {
  const known = values.filter((v): v is number => v !== null);
  return known.length === 0
    ? null
    : round(
        known.reduce((a, b) => a + b, 0),
        2,
      );
}

function divide(a: number | null, b: number | null): number | null {
  if (a === null || b === null || b === 0) return null;
  return a / b;
}

/** True when arrival fell inside (or before) the appointment window. */
function onTime(stop: PerformanceStop): boolean | null {
  if (!stop.arrivedAt || !stop.appointmentEndAt) return null;
  const arrived = Date.parse(stop.arrivedAt);
  const end = Date.parse(stop.appointmentEndAt);
  if (Number.isNaN(arrived) || Number.isNaN(end)) return null;
  return arrived <= end;
}

function dwellMinutes(stop: PerformanceStop): number | null {
  if (!stop.arrivedAt || !stop.departedAt) return null;
  const arrived = Date.parse(stop.arrivedAt);
  const departed = Date.parse(stop.departedAt);
  if (Number.isNaN(arrived) || Number.isNaN(departed) || departed < arrived) return null;
  return Math.round((departed - arrived) / 60_000);
}

function pct(part: number, whole: number): number | null {
  return whole === 0 ? null : round((part / whole) * 100, 1);
}

/**
 * Rolls a set of loads into one performance picture. Cancelled loads are counted for the
 * cancellation rate but excluded from money and miles, since they earned neither.
 */
export function summarizePerformance(loads: readonly PerformanceLoad[]): PerformanceSummary {
  const reasons: string[] = [];
  const active = loads.filter((l) => ACTIVE.has(l.status));
  const cancelled = loads.filter((l) => CANCELLED.has(l.status));
  const delivered = loads.filter((l) => l.status === 'delivered' || l.status === 'closed');
  const earning = loads.filter((l) => !CANCELLED.has(l.status));

  const revenue = sumOrNull(earning.map((l) => l.economics.revenue));
  const totalCost = sumOrNull(earning.map((l) => l.economics.totalCost));
  const loadedMiles = sumOrNull(earning.map((l) => l.economics.loadedMiles));
  const emptyMiles = sumOrNull(earning.map((l) => l.economics.emptyMiles));
  const totalMiles = sumOrNull(earning.map((l) => l.economics.totalMiles));

  const profit = revenue === null || totalCost === null ? null : round(revenue - totalCost, 2);
  const marginPct =
    profit === null || revenue === null || revenue === 0
      ? null
      : round((profit / revenue) * 100, 1);

  const priced = earning.filter((l) => l.economics.marginPct !== null).length;
  if (priced < earning.length) {
    reasons.push(
      `${earning.length - priced} of ${earning.length} loads could not be priced, so money figures cover only part of this work`,
    );
  }

  const pickups = loads.flatMap((l) => l.stops.filter((s) => s.kind === 'pickup'));
  const deliveries = loads.flatMap((l) => l.stops.filter((s) => s.kind === 'delivery'));
  const timedPickups = pickups.map(onTime).filter((v): v is boolean => v !== null);
  const timedDeliveries = deliveries.map(onTime).filter((v): v is boolean => v !== null);

  const dwells = loads
    .flatMap((l) => l.stops.map(dwellMinutes))
    .filter((v): v is number => v !== null);
  const detention = loads.flatMap((l) => l.stops.map((s) => s.detentionMinutes));

  if (timedDeliveries.length === 0 && deliveries.length > 0) {
    reasons.push(
      'No delivery has both an appointment and a recorded arrival, so on-time cannot be measured',
    );
  }

  return {
    counts: {
      total: loads.length,
      active: active.length,
      delivered: delivered.length,
      cancelled: cancelled.length,
    },
    revenue,
    totalCost,
    profit,
    marginPct,
    loadedMiles,
    emptyMiles,
    totalMiles,
    deadheadPct:
      totalMiles === null || emptyMiles === null || totalMiles === 0
        ? null
        : round((emptyMiles / totalMiles) * 100, 1),
    revenuePerLoadedMile: (() => {
      const v = divide(revenue, loadedMiles);
      return v === null ? null : round(v, 2);
    })(),
    revenuePerTotalMile: (() => {
      const v = divide(revenue, totalMiles);
      return v === null ? null : round(v, 2);
    })(),
    profitPerTotalMile: (() => {
      const v = divide(profit, totalMiles);
      return v === null ? null : round(v, 2);
    })(),
    onTimePickupPct:
      timedPickups.length === 0
        ? null
        : pct(timedPickups.filter(Boolean).length, timedPickups.length),
    onTimeDeliveryPct:
      timedDeliveries.length === 0
        ? null
        : pct(timedDeliveries.filter(Boolean).length, timedDeliveries.length),
    avgDwellMinutes:
      dwells.length === 0 ? null : Math.round(dwells.reduce((a, b) => a + b, 0) / dwells.length),
    detentionMinutes: detention.length === 0 ? null : detention.reduce((a, b) => a + b, 0),
    cancellationRatePct: loads.length === 0 ? null : pct(cancelled.length, loads.length),
    coverage: {
      loads: loads.length,
      priced,
      timedDeliveries: timedDeliveries.length,
      timedPickups: timedPickups.length,
    },
    reasons,
    unavailable: [
      {
        metric: 'Claims and claim exposure',
        requires: 'a claims module; no claim record exists in the system yet',
      },
    ],
  };
}

// ---------------------------------------------------------------------------------------------
// Payment behaviour
// ---------------------------------------------------------------------------------------------

export interface PerformanceInvoice {
  status: string;
  issuedOn: string | null;
  dueOn: string | null;
  paidOn: string | null;
  total: number;
  balance: number;
}

export interface PaymentSummary {
  invoices: number;
  /** Mean days from issue to payment across invoices that were actually paid. */
  avgDaysToPay: number | null;
  /** Share of paid invoices settled on or before the due date. */
  paidOnTimePct: number | null;
  outstanding: number | null;
  overdueCount: number;
  overdueAmount: number | null;
  disputedCount: number;
  coverage: { paid: number; datedPaid: number };
  reasons: string[];
}

function daysBetween(from: string, to: string): number | null {
  const a = Date.parse(from);
  const b = Date.parse(to);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 86_400_000);
}

/** How a counterparty actually pays, derived from their invoices. */
export function summarizePayment(invoices: readonly PerformanceInvoice[]): PaymentSummary {
  const reasons: string[] = [];
  const paid = invoices.filter((i) => i.paidOn !== null);
  const daysToPay = paid
    .map((i) => (i.issuedOn && i.paidOn ? daysBetween(i.issuedOn, i.paidOn) : null))
    .filter((v): v is number => v !== null);

  const settledOnTime = paid
    .map((i) => (i.dueOn && i.paidOn ? Date.parse(i.paidOn) <= Date.parse(i.dueOn) : null))
    .filter((v): v is boolean => v !== null);

  const overdue = invoices.filter((i) => i.status === 'overdue');
  const outstanding = invoices.filter((i) => i.balance > 0);

  if (paid.length > 0 && daysToPay.length < paid.length) {
    reasons.push(
      `${paid.length - daysToPay.length} paid invoices are missing an issue or payment date, so they are excluded from the average`,
    );
  }
  if (invoices.length === 0) reasons.push('No invoices on file for this counterparty');

  return {
    invoices: invoices.length,
    avgDaysToPay:
      daysToPay.length === 0
        ? null
        : Math.round(daysToPay.reduce((a, b) => a + b, 0) / daysToPay.length),
    paidOnTimePct:
      settledOnTime.length === 0
        ? null
        : pct(settledOnTime.filter(Boolean).length, settledOnTime.length),
    outstanding:
      outstanding.length === 0
        ? null
        : round(
            outstanding.reduce((a, i) => a + i.balance, 0),
            2,
          ),
    overdueCount: overdue.length,
    overdueAmount:
      overdue.length === 0
        ? null
        : round(
            overdue.reduce((a, i) => a + i.balance, 0),
            2,
          ),
    disputedCount: invoices.filter((i) => i.status === 'disputed').length,
    coverage: { paid: paid.length, datedPaid: daysToPay.length },
    reasons,
  };
}
