import { bpsOf, sumCents } from './money.js';

/**
 * VT consolidated vendor statements (§9). One vendor, many trucks, one payout. Each truck's
 * section carries its loads, the vendor's share of gross, the driver pay charged to the vendor
 * that week, the truck's fuel, tolls and other costs, and its net. Vendor-level adjustments
 * appear once, at the end, never per truck.
 */

export interface VendorTruckLoad {
  loadId: string;
  loadNumber: string;
  completedAt: string;
  route: string;
  grossCents: number;
}

export interface VendorTruckInput {
  truckId: string;
  unitNumber: string;
  /** The arrangement's share, basis points; null = not configured → exception. */
  percentBps: number | null;
  loads: VendorTruckLoad[];
  /** Driver pay this week on this truck, each linked to the driver's statement line. */
  driverPay: Array<{ driverId: string; driverName: string; settlementId: string | null; cents: number }>;
  fuelCents: number;
  tollsCents: number;
  other: Array<{ description: string; cents: number; sourceKey: string }>;
  adjustments: Array<{ description: string; cents: number; reason: string }>;
}

export interface VendorTruckSection {
  truckId: string;
  unitNumber: string;
  loads: Array<VendorTruckLoad & { vendorEarningsCents: number }>;
  grossCents: number;
  percentBps: number | null;
  vendorEarningsCents: number;
  driverPayDeductedCents: number;
  fuelCents: number;
  tollsCents: number;
  otherCents: number;
  adjustmentsCents: number;
  netCents: number;
  exceptions: string[];
}

export interface VendorStatementComputation {
  trucks: VendorTruckSection[];
  vendorAdjustmentsCents: number;
  totalEarningsCents: number;
  totalDeductionsCents: number;
  payoutCents: number;
  exceptions: string[];
}

export function computeVendorStatement(
  trucks: VendorTruckInput[],
  vendorAdjustments: Array<{ description: string; cents: number; reason: string }>,
  defaultPercentBps: number | null,
): VendorStatementComputation {
  const exceptions: string[] = [];
  const sections: VendorTruckSection[] = trucks.map((t) => {
    const bps = t.percentBps ?? defaultPercentBps;
    const own: string[] = [];
    if (bps === null) own.push(`Unit ${t.unitNumber}: no vendor percentage on the arrangement and no company default.`);
    const loads = t.loads.map((l) => ({ ...l, vendorEarningsCents: bps === null ? 0 : bpsOf(l.grossCents, bps) }));
    const gross = sumCents(loads.map((l) => l.grossCents));
    const earnings = sumCents(loads.map((l) => l.vendorEarningsCents));
    const driverPay = sumCents(t.driverPay.map((d) => d.cents));
    const other = sumCents(t.other.map((o) => o.cents));
    const adj = sumCents(t.adjustments.map((a) => a.cents));
    const net = earnings - driverPay - t.fuelCents - t.tollsCents - other + adj;
    exceptions.push(...own);
    return { truckId: t.truckId, unitNumber: t.unitNumber, loads, grossCents: gross, percentBps: bps, vendorEarningsCents: earnings, driverPayDeductedCents: driverPay, fuelCents: t.fuelCents, tollsCents: t.tollsCents, otherCents: other, adjustmentsCents: adj, netCents: net, exceptions: own };
  });
  const vendorAdj = sumCents(vendorAdjustments.map((a) => a.cents));
  const totalEarnings = sumCents(sections.map((s) => s.vendorEarningsCents));
  const totalDeductions = sumCents(sections.map((s) => s.driverPayDeductedCents + s.fuelCents + s.tollsCents + s.otherCents - s.adjustmentsCents));
  return { trucks: sections, vendorAdjustmentsCents: vendorAdj, totalEarningsCents: totalEarnings, totalDeductionsCents: totalDeductions, payoutCents: sumCents(sections.map((s) => s.netCents)) + vendorAdj, exceptions };
}

/** January–December: earnings, deductions, adjustments, net actually paid, payment count (§9). */
export function annualVendorSummary(statements: Array<{ periodStart: string; status: string; totalEarningsCents: number; totalDeductionsCents: number; vendorAdjustmentsCents: number; payoutCents: number; paidCents: number | null }>, year: number) {
  const months = Array.from({ length: 12 }, (_, i) => ({ month: i + 1, earningsCents: 0, deductionsCents: 0, adjustmentsCents: 0, paidCents: 0, payments: 0 }));
  for (const s of statements) {
    if (!s.periodStart.startsWith(String(year))) continue;
    const m = months[Number(s.periodStart.slice(5, 7)) - 1]!;
    m.earningsCents += s.totalEarningsCents;
    m.deductionsCents += s.totalDeductionsCents;
    m.adjustmentsCents += s.vendorAdjustmentsCents;
    if (s.paidCents !== null) {
      m.paidCents += s.paidCents;
      m.payments += 1;
    }
  }
  const total = months.reduce((a, m) => ({ earningsCents: a.earningsCents + m.earningsCents, deductionsCents: a.deductionsCents + m.deductionsCents, adjustmentsCents: a.adjustmentsCents + m.adjustmentsCents, paidCents: a.paidCents + m.paidCents, payments: a.payments + m.payments }), { earningsCents: 0, deductionsCents: 0, adjustmentsCents: 0, paidCents: 0, payments: 0 });
  return { year, months, total, note: 'A summary of statements and payments recorded here; not a tax filing or a determination of taxable income.' };
}
