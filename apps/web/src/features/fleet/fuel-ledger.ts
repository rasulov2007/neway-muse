import { safeCell } from '@neway/shared';
import type { FuelTransaction } from '@/demo';
import { companyDateOf, type IsoDate } from '@/lib/clock';
import { formatDateTime } from '@/lib/format';

/**
 * The fuel ledger, read as fills rather than rows.
 *
 * One Relay transaction becomes up to two ledger rows - its diesel and its DEF - because DEF is
 * money but not fuel burned (see relay-sync.plan.ts). Their ids are derived from Relay's
 * transaction id: `fue_rly_<txn>` for the diesel, `fue_rly_<txn>_def` for the DEF. Putting the two
 * back together gives the one purchase the driver actually made at the pump, which is what an
 * invoice is. A fill keyed in by hand is one row and its own fill.
 *
 * Relay has no receipt image. The "invoice" here is the itemised record of the transaction, never
 * a picture of one.
 */

export const RELAY_INVOICE_CAPTION = 'From the Relay transaction — no receipt image is available';

const RELAY_ID = /^fue_rly_(.+?)(_def)?$/;

export const PRODUCT_LABEL: Record<string, string> = { diesel: 'Diesel', def: 'DEF' };

export function productLabel(product: string): string {
  return PRODUCT_LABEL[product] ?? product.charAt(0).toUpperCase() + product.slice(1);
}

/** Relay's transaction id for a Relay row; null for a fill keyed in by hand. */
export function relayTransactionId(row: Pick<FuelTransaction, 'id'>): string | null {
  return RELAY_ID.exec(row.id)?.[1] ?? null;
}

/** The fill a row belongs to: its Relay transaction, or the row itself. */
export function fillKey(row: Pick<FuelTransaction, 'id'>): string {
  const txn = relayTransactionId(row);
  return txn ? `relay:${txn}` : `row:${row.id}`;
}

const PRODUCT_ORDER: Record<string, number> = { diesel: 0, def: 1 };

export interface FuelFillGroup {
  key: string;
  /** Relay's transaction id, or null for a hand-keyed fill. */
  relayTransactionId: string | null;
  /** Every line of the fill, diesel first. */
  lines: FuelTransaction[];
  /** The row that leads the fill: its diesel line when it has one. */
  lead: FuelTransaction;
  gallons: number;
  total: number;
}

/**
 * The price a line was actually charged per gallon: its total over its gallons, to four places.
 * Relay's own `pricePerGallon` is rounded to three, so gallons times it misses the total by a few
 * cents (82.705 × 6.036 = 499.21 against a charge of 499.19). Shown this way, the line multiplies
 * out to its total to the cent (owner, 2026-10-05).
 */
export function chargedPricePerGallon(line: Pick<FuelTransaction, 'amount' | 'gallons' | 'pricePerGallon'>): number {
  return line.gallons > 0 ? round(line.amount / line.gallons, 4) : line.pricePerGallon;
}

/** Gallons as the pump measures them: three places. */
export function formatGallons(gallons: number): string {
  return gallons.toLocaleString('en-US', { minimumFractionDigits: 3, maximumFractionDigits: 3 });
}

/** A charged price per gallon: four places, as `chargedPricePerGallon` gives it. */
export function formatPricePerGallon(price: number): string {
  return `$${price.toFixed(4)}`;
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

/** Gather rows into fills, keeping the order of the first row of each fill as given. */
export function groupFills(rows: readonly FuelTransaction[]): FuelFillGroup[] {
  const byKey = new Map<string, FuelTransaction[]>();
  for (const row of rows) {
    const key = fillKey(row);
    const bucket = byKey.get(key);
    if (bucket) bucket.push(row);
    else byKey.set(key, [row]);
  }
  return [...byKey.entries()].map(([key, members]) => {
    const lines = [...members].sort(
      (a, b) => (PRODUCT_ORDER[a.product] ?? 9) - (PRODUCT_ORDER[b.product] ?? 9),
    );
    const lead = lines[0] as FuelTransaction;
    return {
      key,
      relayTransactionId: relayTransactionId(lead),
      lines,
      lead,
      gallons: round(
        lines.reduce((sum, line) => sum + line.gallons, 0),
        3,
      ),
      total: round(
        lines.reduce((sum, line) => sum + line.amount, 0),
        2,
      ),
    };
  });
}

// ---------------------------------------------------------------------------------------------
// Date range (Eastern calendar dates)
// ---------------------------------------------------------------------------------------------

export interface FuelRange {
  from: IsoDate;
  to: IsoDate;
}

export function addDays(date: IsoDate, days: number): IsoDate {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

function monthStart(date: IsoDate): IsoDate {
  return `${date.slice(0, 7)}-01`;
}

export interface FuelRangePreset {
  label: string;
  range: (today: IsoDate) => FuelRange;
}

export const FUEL_RANGE_PRESETS: FuelRangePreset[] = [
  { label: 'Last 7 days', range: (today) => ({ from: addDays(today, -6), to: today }) },
  { label: 'Last 30 days', range: (today) => ({ from: addDays(today, -29), to: today }) },
  { label: 'Last 90 days', range: (today) => ({ from: addDays(today, -89), to: today }) },
  { label: 'This month', range: (today) => ({ from: monthStart(today), to: today }) },
  {
    label: 'Last month',
    range: (today) => {
      const end = addDays(monthStart(today), -1);
      return { from: monthStart(end), to: end };
    },
  },
];

export const DEFAULT_RANGE_LABEL = 'Last 30 days';

/** The range the URL names, or the last 30 days ending today (Eastern). */
export function resolveRange(today: IsoDate, from?: string, to?: string): FuelRange {
  if (from && to) return from <= to ? { from, to } : { from: to, to: from };
  return { from: addDays(today, -29), to: today };
}

/** The preset a range matches, or "Custom". */
export function rangeLabel(range: FuelRange, today: IsoDate): string {
  const preset = FUEL_RANGE_PRESETS.find((p) => {
    const r = p.range(today);
    return r.from === range.from && r.to === range.to;
  });
  return preset?.label ?? 'Custom';
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function shortDate(date: IsoDate, withYear: boolean): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}${withYear ? `, ${y}` : ''}`;
}

/** `Sep 6 – Oct 5, 2026`; the year is said once when both ends share it. */
export function formatRange(range: FuelRange): string {
  if (range.from === range.to) return shortDate(range.from, true);
  const sameYear = range.from.slice(0, 4) === range.to.slice(0, 4);
  return `${shortDate(range.from, !sameYear)} – ${shortDate(range.to, true)}`;
}

export function inRange(row: Pick<FuelTransaction, 'at'>, range: FuelRange): boolean {
  const day = companyDateOf(row.at);
  return day >= range.from && day <= range.to;
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

const CSV_COLUMNS: { label: string; value: (row: FuelTransaction) => string | number }[] = [
  { label: 'Date & time (Eastern)', value: (r) => formatDateTime(r.at) },
  { label: 'Truck', value: (r) => r.unitNumber },
  { label: 'Driver', value: (r) => r.driverName },
  { label: 'Station', value: (r) => r.station.name },
  { label: 'City', value: (r) => r.station.city },
  { label: 'State', value: (r) => r.station.state },
  { label: 'Vendor', value: (r) => r.station.brand },
  { label: 'Product', value: (r) => productLabel(r.product) },
  { label: 'Gallons', value: (r) => r.gallons },
  { label: 'Price per gallon', value: (r) => chargedPricePerGallon(r) },
  { label: 'Total', value: (r) => r.amount },
  { label: 'Odometer', value: (r) => (r.odometer > 0 ? r.odometer : '') },
  { label: 'Card last 4', value: (r) => r.cardLast4 },
  { label: 'Relay transaction', value: (r) => relayTransactionId(r) ?? '' },
  { label: 'Flags', value: (r) => r.anomalyFlags.join('; ') },
];

function csvCell(value: string | number): string {
  const safe = safeCell(value);
  const text = String(safe);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** The transactions on screen, as CSV. Text cells are neutralised against spreadsheet formulas. */
export function fuelCsv(rows: readonly FuelTransaction[]): string {
  return [
    CSV_COLUMNS.map((c) => csvCell(c.label)).join(','),
    ...rows.map((row) => CSV_COLUMNS.map((c) => csvCell(c.value(row))).join(',')),
  ].join('\r\n');
}

export function downloadFuelCsv(rows: readonly FuelTransaction[], range: FuelRange): void {
  const blob = new Blob([fuelCsv(rows)], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `fuel_${range.from}_${range.to}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
