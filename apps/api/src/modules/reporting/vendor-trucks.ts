import { vendorMoneyTotals, type VendorMoneySummary, type VendorTruckMoney } from '@neway/shared';
import { revenueOf } from './engines/financial-calculator';
import type { DateRange, ExpenseLine, IsoDate, ReportingFacts, RevenueLine } from './facts';

/**
 * Vendor trucks in the company's numbers (owner, 2026-10-28).
 *
 * A vendor truck's load gross is not the company's: the company keeps its agreed percentage, the
 * driver is paid out of the vendor's part, and the truck's running costs are the vendor's. So,
 * once, at the source - every engine then agrees without knowing vendors exist:
 *
 *   - a revenue line on a vendor truck counts at the company's share (linehaul, accessorials and
 *     TONU each scaled), so company revenue and profit carry exactly what the company keeps;
 *   - every cost line on that truck in the arrangement's days (driver pay, fuel, repairs, other)
 *     leaves company expenses;
 *   - both are kept whole in `facts.vendor`, which the Vendor section reads.
 */

export interface VendorArrangementFact {
  truckId: string;
  vendorId: string;
  vendorName: string;
  /** What the company keeps, basis points of gross. */
  companyBps: number;
  from: IsoDate;
  to: IsoDate | null;
}

export interface VendorRevenueFact {
  loadId: string;
  loadNumber: string;
  truckId: string;
  vendorId: string;
  deliveredOn: IsoDate;
  gross: number;
  companyShare: number;
}

export interface VendorFacts {
  arrangements: VendorArrangementFact[];
  revenue: VendorRevenueFact[];
  /** The truck's costs in the vendor's days, as they were before leaving company expenses. */
  costs: Array<ExpenseLine & { vendorId: string }>;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

function inForce(rows: readonly VendorArrangementFact[], truckId: string | null, day: IsoDate): VendorArrangementFact | null {
  if (!truckId) return null;
  return (
    rows
      .filter((a) => a.truckId === truckId && a.from <= day && (!a.to || a.to >= day))
      .sort((a, b) => b.from.localeCompare(a.from))[0] ?? null
  );
}

/** Company staff and the like never belong to a truck's vendor. */
const NEVER_VENDOR: ReadonlySet<ExpenseLine['category']> = new Set(['staff_payroll', 'trailer_repairs']);

export function applyVendorTrucks(facts: ReportingFacts, arrangements: readonly VendorArrangementFact[]): ReportingFacts {
  const vendor: VendorFacts = { arrangements: [...arrangements], revenue: [], costs: [] };
  if (arrangements.length === 0) return { ...facts, vendor };

  const loadTruck = new Map<string, string | null>();
  const revenue: RevenueLine[] = facts.revenue.map((line) => {
    loadTruck.set(line.loadNumber, line.truckId);
    const a = inForce(arrangements, line.truckId, line.deliveredOn);
    if (!a) return line;
    const f = a.companyBps / 10_000;
    const scaled: RevenueLine = {
      ...line,
      linehaul: round2(line.linehaul * f),
      ...(line.accessorials !== undefined ? { accessorials: round2(line.accessorials * f) } : {}),
      ...(line.tonu !== undefined ? { tonu: round2(line.tonu * f) } : {}),
    };
    vendor.revenue.push({
      loadId: line.loadId,
      loadNumber: line.loadNumber,
      truckId: a.truckId,
      vendorId: a.vendorId,
      deliveredOn: line.deliveredOn,
      gross: round2(revenueOf(line)),
      companyShare: round2(revenueOf(scaled)),
    });
    return scaled;
  });

  const expenses: ExpenseLine[] = [];
  for (const line of facts.expenses) {
    const truckId = line.truckId ?? (line.loadNumber ? (loadTruck.get(line.loadNumber) ?? null) : null);
    const a = NEVER_VENDOR.has(line.category) ? null : inForce(arrangements, truckId, line.date);
    if (a) vendor.costs.push({ ...line, truckId: a.truckId, vendorId: a.vendorId });
    else expenses.push(line);
  }

  const vendorTrucks = new Set(arrangements.filter((a) => a.from <= facts.range.to && (!a.to || a.to >= facts.range.from)).map((a) => a.truckId));
  return {
    ...facts,
    revenue,
    expenses,
    trucks: facts.trucks.map((t) => (vendorTrucks.has(t.truckId) ? { ...t, vendor: true } : t)),
    revenueLedgerTotal: round2(revenue.reduce((s, row) => s + revenueOf(row), 0)),
    vendor,
  };
}

/** The Vendor section: per vendor truck, the gross, what the company kept, the driver, the costs and the vendor's net. */
export function computeVendorMoney(facts: ReportingFacts, range: DateRange = facts.range): VendorMoneySummary {
  const v = facts.vendor;
  const rows = new Map<string, VendorTruckMoney>();
  const unit = new Map(facts.trucks.map((t) => [t.truckId, t.unitNumber]));
  const inRange = (d: IsoDate) => d >= range.from && d <= range.to;
  const row = (truckId: string, vendorId: string): VendorTruckMoney => {
    const key = `${truckId}|${vendorId}`;
    let r = rows.get(key);
    if (!r) {
      const a = v?.arrangements.filter((x) => x.truckId === truckId && x.vendorId === vendorId).sort((x, y) => y.from.localeCompare(x.from))[0];
      r = {
        truckId,
        unitNumber: unit.get(truckId) ?? truckId,
        vendorId,
        vendorName: a?.vendorName ?? 'Vendor',
        companyPercent: a ? a.companyBps / 100 : 0,
        loads: 0,
        gross: 0,
        companyShare: 0,
        driverPay: 0,
        truckCosts: 0,
        vendorNet: 0,
      };
      rows.set(key, r);
    }
    return r;
  };
  // Every vendor truck in the period has a row, even one with no loads yet.
  for (const a of v?.arrangements ?? []) {
    if (a.from <= range.to && (!a.to || a.to >= range.from)) row(a.truckId, a.vendorId);
  }
  for (const line of v?.revenue ?? []) {
    if (!inRange(line.deliveredOn)) continue;
    const r = row(line.truckId, line.vendorId);
    r.loads += 1;
    r.gross += line.gross;
    r.companyShare += line.companyShare;
  }
  for (const line of v?.costs ?? []) {
    if (!inRange(line.date) || !line.truckId) continue;
    const r = row(line.truckId, line.vendorId);
    if (line.category === 'driver_pay') r.driverPay += line.amount;
    else r.truckCosts += line.amount;
  }
  const trucks = [...rows.values()]
    .map((r) => ({
      ...r,
      gross: round2(r.gross),
      companyShare: round2(r.companyShare),
      driverPay: round2(r.driverPay),
      truckCosts: round2(r.truckCosts),
      vendorNet: round2(r.gross - r.companyShare - r.driverPay - r.truckCosts),
    }))
    .sort((a, b) => a.vendorName.localeCompare(b.vendorName) || a.unitNumber.localeCompare(b.unitNumber));
  return { from: range.from, to: range.to, trucks, totals: vendorMoneyTotals(trucks) };
}
