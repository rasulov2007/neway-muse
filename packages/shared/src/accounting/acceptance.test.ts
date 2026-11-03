import { describe, expect, it } from 'vitest';
import { billingVerdict, checkRateConfirmation, normalizeReference, revisionNumber, type BillableLoad } from './billing.js';
import { safeCell } from './csv-safety.js';
import { debtSummary, defaultSwitches, escrowSummary, planRecoveries, settleNet, type DriverTx, type ProfileVersion } from './driver-account.js';
import { checkFunding } from './factoring.js';
import { percentOf, splitCents } from './money.js';
import { computePayrollLines, fourWeekPeriodFor } from './payroll-periods.js';
import { batchTotals, computeStatement, explainLoadPay, periodForCompletion, settlementPeriodFor, type SettleableLoadV2 } from './settlement-rules.js';
import { computeVendorStatement } from './vendor-statement.js';
import { defaultLeasePlan } from './lease-plan.js';
import { expenseAccountFor } from './ledger.js';
import { postBill } from './posting.js';

/**
 * The owner's acceptance list (§13), the parts that are pure rules. The database-backed parts
 * (retry idempotency through unique source keys, post-invoice lock on the API, tenant
 * separation) are covered by the server's constraints and the e2e checks in the report.
 */

const NY = { timezone: 'America/New_York', cutoffTime: '14:00', payDay: 'thursday' };

function profile(over: Partial<ProfileVersion> = {}): ProfileVersion {
  return {
    effectiveFrom: '2026-01-01',
    contractType: 'CD',
    switches: defaultSwitches('CD'),
    loadedPlan: { kind: 'per_mile', rate: 0.6 },
    emptyPlan: { kind: 'none', rate: 0 },
    escrow: { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: 0, openingReconciled: true },
    byId: 'u1',
    byName: 'Test',
    at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function load(over: Partial<SettleableLoadV2> = {}): SettleableLoadV2 {
  return {
    id: 'ld1',
    loadNumber: 'L-1',
    completedAt: '2026-09-23T15:00:00Z',
    originLabel: 'A',
    destinationLabel: 'B',
    loadedMiles: 1000,
    emptyMiles: 100,
    grossCents: 342_500,
    linehaulCents: 342_500,
    driverIds: ['d1'],
    accessorials: [],
    funded: true,
    status: 'delivered',
    ...over,
  };
}

function tx(over: Partial<DriverTx>): DriverTx {
  return { id: 't', driverId: 'd1', kind: 'manual_charge', onDate: '2026-09-22', amountCents: 0, recoveredCents: 0, state: 'approved', source: 'manual', sourceKey: 'k', truckId: null, loadId: null, settlementId: null, description: 'x', companyCost: false, ...over };
}

describe('money (§2)', () => {
  it('splits with exact remainder allocation', () => {
    expect(splitCents(20_000, 2)).toEqual([10_000, 10_000]);
    expect(splitCents(20_001, 2)).toEqual([10_001, 10_000]);
    expect(splitCents(100, 3)).toEqual([34, 33, 33]);
    expect(percentOf(342_500, 90)).toBe(308_250);
  });
});

describe('RC validation (§4, test 3)', () => {
  const base = (): BillableLoad => ({
    id: 'ld1',
    loadNumber: 'L-1',
    status: 'delivered',
    brokerReference: 'BR-8801',
    customerId: 'c1',
    brokerId: 'b1',
    customerName: 'Atlas',
    brokerName: 'Broker',
    rate: 2800,
    documents: [
      { id: 'rc', type: 'rate_confirmation', status: 'pending', review: 'verified', fileHash: 'h1', uploadedAt: '2026-09-20T00:00:00Z', extractedReference: 'br 8801', extractionConfidence: 'person' },
      { id: 'pod', type: 'pod', status: 'pending', review: 'reviewed', uploadedAt: '2026-09-24T00:00:00Z' },
    ],
    charges: [{ id: 'c', type: 'linehaul', description: 'Linehaul', amount: 2800, billable: true }],
    stops: [{ kind: 'pickup', status: 'completed' }, { kind: 'delivery', status: 'completed' }],
    updatedAt: 'x',
  });
  const ctx = (hashes: Record<string, string[]> = {}, resolved: string[] = []) => ({
    invoices: [],
    hashesElsewhere: (h: string) => hashes[h] ?? [],
    resolvedExceptions: () => resolved.map((kind) => ({ kind })),
  });

  it('normalises conservatively: separators and case, never leading zeros', () => {
    expect(normalizeReference('br-88 01')).toBe('BR8801');
    expect(normalizeReference('0034')).not.toBe(normalizeReference('34'));
  });
  it('a match is ready to bill', () => {
    expect(billingVerdict(base(), ctx()).queue).toBe('ready_to_bill');
  });
  it('a reference mismatch is reported on the RC check but does not block billing (owner, 2026-10-16)', () => {
    const l = base();
    l.documents[0]!.extractedReference = 'BR-8803';
    expect(checkRateConfirmation(l, () => []).state).toBe('mismatch');
    expect(billingVerdict(l, ctx()).queue).toBe('ready_to_bill');
  });
  it('unreadable and duplicate block', () => {
    const l = base();
    l.documents[0]!.extractionConfidence = 'uncertain';
    expect(checkRateConfirmation(l, () => []).state).toBe('unreadable');
    const d = base();
    expect(checkRateConfirmation(d, () => ['ld9']).state).toBe('duplicate');
    expect(billingVerdict(d, ctx({ h1: ['ld9'] })).queue).toBe('needs_review');
  });
  it('a missing POD is needs documents; a TONU wants evidence instead', () => {
    const l = base();
    l.documents = l.documents.filter((d) => d.type !== 'pod');
    expect(billingVerdict(l, ctx()).queue).toBe('needs_documents');
    const t = base();
    t.status = 'tonu';
    t.cancellation = { outcome: 'tonu', fee: 250 };
    t.documents = t.documents.filter((d) => d.type !== 'pod');
    expect(billingVerdict(t, ctx()).conditions.map((c) => c.code)).toContain('tonu_evidence_missing');
    t.documents.push({ id: 'ev', type: 'tonu', status: 'pending', review: 'reviewed', uploadedAt: 'x' });
    expect(billingVerdict(t, ctx()).queue).toBe('ready_to_bill');
  });
  it('a TONU takes the revised rate confirmation sent after the cancellation as its evidence (owner, 2026-10-15)', () => {
    const t = base();
    t.status = 'tonu';
    t.cancellation = { outcome: 'tonu', fee: 250, at: '2026-10-15T13:52:58Z' };
    t.documents = t.documents.filter((d) => d.type !== 'pod' && d.type !== 'bol');
    // The RC from before the cancellation is not evidence; no BOL or POD is asked for.
    const codes = billingVerdict(t, ctx()).conditions.map((c) => c.code);
    expect(codes).toContain('tonu_evidence_missing');
    expect(codes).not.toContain('pod_missing');
    t.documents.push({ id: 'rc2', type: 'rate_confirmation', status: 'pending', review: 'reviewed', uploadedAt: '2026-10-15T15:00:00Z' });
    expect(billingVerdict(t, ctx()).conditions.map((c) => c.code)).not.toContain('tonu_evidence_missing');
  });
  it('names revisions in one family', () => {
    expect(revisionNumber('INV-10452', 1)).toBe('INV-10452');
    // Owner, 2026-09-29: revisions read INV2-10452, INV3-10452 (replaces the earlier -R2 rule).
    expect(revisionNumber('INV-10452', 2)).toBe('INV2-10452');
  });
});

describe('funding (§5)', () => {
  it('checks the arithmetic and refuses an overpayment', () => {
    const inv = [{ id: 'i1', balanceCents: 280_000, status: 'issued' }, { id: 'i2', balanceCents: 240_000, status: 'issued' }];
    const ok = checkFunding({ provider: 'RTS', reference: 'F1', fundedOn: '2026-09-25', feeCents: 3_900, reserveCents: 0, extraFees: [{ label: 'Holiday', amountCents: 1_500 }], allocations: [{ invoiceId: 'i1', grossCents: 280_000 }, { invoiceId: 'i2', grossCents: 240_000 }], netReceivedCents: 514_600 }, inv);
    expect(ok.ok).toBe(true);
    const bad = checkFunding({ provider: 'RTS', reference: 'F1', fundedOn: '2026-09-25', feeCents: 0, reserveCents: 0, extraFees: [], allocations: [{ invoiceId: 'i1', grossCents: 300_000 }], netReceivedCents: 300_000 }, inv);
    expect(bad.ok).toBe(false);
  });
});

describe('driver account (§7, tests 6 and 7)', () => {
  it('$100 opening + $50 charge − $40 recovery = $110, with no second posting', () => {
    const charge = tx({ id: 'c1', amountCents: 5_000, recoveredCents: 4_000 });
    const d = debtSummary(10_000, [charge]);
    expect(d.newChargesCents).toBe(5_000);
    expect(d.recoveredCents).toBe(4_000);
    expect(d.closingCents).toBe(11_000);
    expect(planRecoveries(d.open, 100_000)).toEqual([{ txId: 'c1', cents: 1_000 }]);
  });
  it('unknown opening debt stays unknown', () => {
    expect(debtSummary(null, [tx({ amountCents: 100 })]).closingCents).toBeNull();
  });
  it('escrow from $2,450 collects $50 then stops; unknown opening needs review', () => {
    const plan = { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: 245_000, openingReconciled: true };
    expect(escrowSummary(plan, []).nextDeductionCents).toBe(5_000);
    expect(escrowSummary(plan, [tx({ kind: 'escrow_deposit', amountCents: 5_000 })]).nextDeductionCents).toBe(0);
    expect(escrowSummary({ ...plan, openingBalanceCents: null, openingReconciled: false }, []).balanceCents).toBeNull();
    // From zero: seven × $350 then $50.
    const fromZero = { ...plan, openingBalanceCents: 0 };
    const deposits = Array.from({ length: 7 }, (_, i) => tx({ id: `e${i}`, kind: 'escrow_deposit', amountCents: 35_000 }));
    expect(escrowSummary(fromZero, deposits).nextDeductionCents).toBe(5_000);
  });
  it('a refund lowers the balance and history stays; an offset is its own transaction', () => {
    const plan = { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: 250_000, openingReconciled: true };
    const s = escrowSummary(plan, [tx({ kind: 'escrow_refund', amountCents: 10_000 }), tx({ id: 'o', kind: 'escrow_offset', amountCents: 5_000 })]);
    expect(s.balanceCents).toBe(235_000);
    expect(s.refundsCents).toBe(10_000);
    expect(s.offsetsCents).toBe(5_000);
  });
  it('CD fuel is a company cost; an owner is charged by the switch (test 5)', () => {
    expect(defaultSwitches('CD').deductFuel).toBe(false);
    expect(defaultSwitches('OO').deductFuel).toBe(true);
    const fuel = tx({ kind: 'fuel', amountCents: 20_000, companyCost: true, onDate: '2026-09-22' });
    expect(debtSummary(0, [fuel]).newChargesCents).toBe(0);
  });
});

describe('team and accessorials (test 8)', () => {
  it('splits a $200 team extra $100/$100, conserves odd cents, and does not split base mileage unless configured', () => {
    const l = load({
      driverIds: ['d1', 'd2'],
      accessorials: [{ id: 'a1', type: 'detention', description: 'Detention', amountCents: 20_000, allocation: { chargeId: 'a1', treatment: 'paid_separately', mode: 'full', value: 100, nature: 'earning', recipients: ['d1', 'd2'] } }],
    });
    const p = profile();
    const a = explainLoadPay(l, 'd1', p, { teamBaseMileageSplit: 'each_full' });
    const b = explainLoadPay(l, 'd2', p, { teamBaseMileageSplit: 'each_full' });
    expect(a.lines.find((x) => x.kind === 'accessorial')?.cents).toBe(10_000);
    expect(b.lines.find((x) => x.kind === 'accessorial')?.cents).toBe(10_000);
    expect(a.lines.find((x) => x.kind === 'loaded_miles')?.cents).toBe(60_000);
    const odd = load({ driverIds: ['d1', 'd2'], accessorials: [{ id: 'a', type: 'lumper', description: 'Lumper', amountCents: 20_001, allocation: { chargeId: 'a', treatment: 'paid_separately', mode: 'full', value: 100, nature: 'earning', recipients: ['d1', 'd2'] } }] });
    const s1 = explainLoadPay(odd, 'd1', p, { teamBaseMileageSplit: 'each_full' }).lines.find((x) => x.kind === 'accessorial')!.cents;
    const s2 = explainLoadPay(odd, 'd2', p, { teamBaseMileageSplit: 'each_full' }).lines.find((x) => x.kind === 'accessorial')!.cents;
    expect(s1 + s2).toBe(20_001);
    const unset = explainLoadPay(l, 'd1', p, { teamBaseMileageSplit: null });
    expect(unset.exceptions.join(' ')).toContain('Team base-mileage split');
  });
  it('a reimbursement goes to the payer only', () => {
    const l = load({ driverIds: ['d1', 'd2'], accessorials: [{ id: 'a', type: 'lumper', description: 'Lumper paid by d2', amountCents: 15_000, allocation: { chargeId: 'a', treatment: 'paid_separately', mode: 'full', value: 100, nature: 'reimbursement', recipients: ['d2'] } }] });
    expect(explainLoadPay(l, 'd1', profile(), { teamBaseMileageSplit: 'each_full' }).lines.some((x) => x.kind === 'reimbursement')).toBe(false);
    expect(explainLoadPay(l, 'd2', profile(), { teamBaseMileageSplit: 'each_full' }).lines.find((x) => x.kind === 'reimbursement')?.cents).toBe(15_000);
  });
  it('a line is in the base OR paid separately, never both; undecided is an exception', () => {
    const l = load({ accessorials: [{ id: 'a', type: 'detention', description: 'Detention', amountCents: 10_000, allocation: { chargeId: 'a', treatment: 'in_percentage_base', mode: 'full', value: 100, nature: 'earning', recipients: ['d1'] } }] });
    const pct = profile({ loadedPlan: { kind: 'percent_of_gross', rate: 25 } });
    const r = explainLoadPay(l, 'd1', pct, { teamBaseMileageSplit: 'each_full' });
    expect(r.lines).toHaveLength(1);
    expect(r.lines[0]!.cents).toBe(percentOf(352_500, 25));
    const undecided = load({ accessorials: [{ id: 'a', type: 'detention', description: 'Detention', amountCents: 10_000, allocation: null }] });
    expect(explainLoadPay(undecided, 'd1', pct, { teamBaseMileageSplit: 'each_full' }).exceptions[0]).toContain('not decided');
  });
  it('a blank empty plan pays nothing for empty miles', () => {
    const r = explainLoadPay(load(), 'd1', profile(), { teamBaseMileageSplit: 'each_full' });
    expect(r.lines.some((x) => x.kind === 'empty_miles')).toBe(false);
  });
});

describe('cutoff (test 9)', () => {
  // The boundary instant itself starts the new week (owner, 2026-10-21: 11:59 → previous, 12:00 → new).
  it('Monday 13:59 Eastern belongs to the previous week; 14:00 starts the new one', () => {
    // Monday 2026-09-28. EDT = UTC−4 → 14:00 local = 18:00Z.
    expect(periodForCompletion('2026-09-28T17:59:00Z', NY).start).toBe('2026-09-21');
    expect(periodForCompletion('2026-09-28T18:00:00Z', NY).start).toBe('2026-09-28');
    expect(periodForCompletion('2026-09-28T18:01:00Z', NY).start).toBe('2026-09-28');
  });
  it('handles the DST change: Monday 2026-11-02 14:00 EST is 19:00Z', () => {
    expect(periodForCompletion('2026-11-02T18:59:00Z', NY).start).toBe('2026-10-26');
    expect(periodForCompletion('2026-11-02T19:00:00Z', NY).start).toBe('2026-11-02');
  });
  it('payday is the Thursday after the week', () => {
    expect(settlementPeriodFor('2026-09-23', NY).payDate).toBe('2026-10-01');
  });
});

describe('statements (test 10)', () => {
  it('a negative week pays $0 and carries one debt; batch totals are not netted across people', () => {
    const s = computeStatement({
      driverId: 'd1',
      period: settlementPeriodFor('2026-09-23', NY),
      profile: profile({ contractType: 'OO', switches: defaultSwitches('OO') }),
      loads: [load({ loadedMiles: 100, emptyMiles: 0, grossCents: 30_000, linehaulCents: 30_000 })],
      transactions: [tx({ id: 'f', kind: 'fuel', amountCents: 50_000, onDate: '2026-09-22' })],
      recurring: [],
      openingDebtCents: 0,
      settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false },
    });
    expect(s.grossCents).toBe(6_000);
    expect(s.netCents).toBe(-44_000);
    expect(s.payableCents).toBe(0);
    expect(s.carryCents).toBe(44_000);
    expect(s.closingDebtCents).toBe(44_000);
    const totals = batchTotals([s, { netCents: 100_000, payableCents: 100_000, carryCents: 0 }]);
    expect(totals.payableCents).toBe(100_000);
    expect(totals.carryCents).toBe(44_000);
    expect(totals.signedNetCents).toBe(56_000);
    expect(settleNet(-1)).toEqual({ payableCents: 0, carryCents: 1 });
  });
  it('recovers open debt oldest first, once, and escrow after it', () => {
    const s = computeStatement({
      driverId: 'd1',
      period: settlementPeriodFor('2026-09-23', NY),
      profile: profile({ switches: { ...defaultSwitches('CD'), escrowEnabled: true }, escrow: { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: 245_000, openingReconciled: true } }),
      loads: [load()],
      transactions: [tx({ id: 'old', amountCents: 10_000, onDate: '2026-09-01' })],
      recurring: [],
      openingDebtCents: 0,
      settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false },
    });
    expect(s.recoveries).toEqual([{ txId: 'old', cents: 10_000 }]);
    expect(s.escrowCents).toBe(5_000);
    expect(s.netCents).toBe(60_000 - 10_000 - 5_000);
  });
  it('a lease charge or recurring deduction skipped or changed for one week (owner, 2026-10-20)', () => {
    const period = settlementPeriodFor('2026-09-23', NY);
    const lease = defaultLeasePlan('lease_owner');
    const odometer = { unitNumber: '0008', startMiles: 120_000, endMiles: 121_000, endReadAt: null };
    const recurring = [{ id: 'rcd1', driverId: 'd1', category: 'other' as const, label: 'weekly', cadence: 'weekly' as const, amountCents: 50_000, startsOn: '2026-01-01', endsOn: null, appliesWhenNoWork: true, totalCents: null, status: 'active' as const, overrides: [], chargedCents: 0 }];
    const run = (leaseOverrides: Array<{ periodStart: string; code: string; cents: number; reason: string }>, rec = recurring) =>
      computeStatement({ driverId: 'd1', period, profile: profile({ contractType: 'LO', switches: { ...defaultSwitches('LO'), recurringDeductions: true }, lease }), loads: [load()], transactions: [], recurring: rec as never, openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false }, odometer, leaseOverrides });
    const plain = run([]);
    const tractor = plain.deductions.find((d) => d.ref === 'tractor_lease')!;
    expect(tractor.cents).toBeGreaterThan(0);
    expect(plain.deductions.find((d) => d.ref === 'rcd1')?.cents).toBe(50_000);

    // Skipped this week: gone from the deductions, listed as skipped, pay goes up by exactly that.
    const skipped = run([{ periodStart: period.start, code: 'tractor_lease', cents: 0, reason: 'truck in the shop' }]);
    expect(skipped.deductions.some((d) => d.ref === 'tractor_lease')).toBe(false);
    expect(skipped.skipped).toEqual([expect.objectContaining({ kind: 'lease', ref: 'tractor_lease', cents: tractor.cents })]);
    expect(skipped.netCents - plain.netCents).toBe(tractor.cents);

    // Changed this week: the new amount, and only for that week.
    const changed = run([{ periodStart: period.start, code: 'tractor_lease', cents: 10_000, reason: 'half week' }]);
    expect(changed.deductions.find((d) => d.ref === 'tractor_lease')?.cents).toBe(10_000);
    expect(run([{ periodStart: '2026-01-05', code: 'tractor_lease', cents: 0, reason: 'other week' }]).deductions.find((d) => d.ref === 'tractor_lease')?.cents).toBe(tractor.cents);

    // A recurring deduction skipped this week, and one stopped.
    const recSkip = run([], [{ ...recurring[0]!, overrides: [{ periodStart: period.start, amountCents: 0, reason: 'driver on vacation' }] as never }]);
    expect(recSkip.deductions.some((d) => d.ref === 'rcd1')).toBe(false);
    expect(recSkip.skipped).toEqual([expect.objectContaining({ kind: 'recurring', ref: 'rcd1', cents: 50_000 })]);
    const stopped = run([], [{ ...recurring[0]!, status: 'cancelled' }]);
    expect(stopped.deductions.some((d) => d.ref === 'rcd1')).toBe(false);
    expect(stopped.skipped).toEqual([]);
  });
});

describe('vendor statements (test 11)', () => {
  it('two trucks, one payout, vendor adjustment counted once', () => {
    const v = computeVendorStatement(
      [
        { truckId: 't1', unitNumber: '101', percentBps: 9000, loads: [{ loadId: 'a', loadNumber: 'A', completedAt: 'x', route: 'r', grossCents: 200_000 }, { loadId: 'b', loadNumber: 'B', completedAt: 'x', route: 'r', grossCents: 300_000 }], driverPay: [{ driverId: 'd', driverName: 'D', settlementId: 's', cents: 100_000 }], fuelCents: 50_000, tollsCents: 10_000, other: [], adjustments: [] },
        { truckId: 't2', unitNumber: '202', percentBps: 9000, loads: [{ loadId: 'c', loadNumber: 'C', completedAt: 'x', route: 'r', grossCents: 400_000 }], driverPay: [{ driverId: 'e', driverName: 'E', settlementId: 's2', cents: 80_000 }], fuelCents: 40_000, tollsCents: 10_000, other: [], adjustments: [] },
      ],
      [{ description: 'Vendor credit', cents: 5_000, reason: 'agreed' }],
      null,
    );
    expect(v.trucks[0]!.netCents).toBe(290_000);
    expect(v.trucks[1]!.netCents).toBe(230_000);
    expect(v.payoutCents).toBe(525_000);
    expect(v.exceptions).toHaveLength(0);
    const unconfigured = computeVendorStatement([{ truckId: 't', unitNumber: '9', percentBps: null, loads: [], driverPay: [], fuelCents: 0, tollsCents: 0, other: [], adjustments: [] }], [], null);
    expect(unconfigured.exceptions[0]).toContain('no vendor percentage');
  });
});

describe('payroll (test 14)', () => {
  it('four-week periods differ from calendar months; a missing formula blocks only its line', () => {
    const p = fourWeekPeriodFor('2026-09-27', '2026-09-07');
    expect(p).toEqual({ start: '2026-09-07', end: '2026-10-04', index: 0 });
    expect(fourWeekPeriodFor('2026-10-05', '2026-09-07').start).toBe('2026-10-05');
    const r = computePayrollLines([
      { employeeId: 'a', employeeName: 'A', role: 'dispatcher', plan: { kind: 'dispatcher_commission', effectiveFrom: '2026-01-01', effectiveTo: null, currency: 'USD', salaryCents: null, frequency: 'four_weekly', commissionPolicyVersion: null, sharedCreditRule: null }, commissionCents: null, bonusCents: 0, advanceCents: 0, adjustments: [] },
      { employeeId: 'b', employeeName: 'B', role: 'safety', plan: { kind: 'salary', effectiveFrom: '2026-01-01', effectiveTo: null, currency: 'USD', salaryCents: 400_000, frequency: 'four_weekly', commissionPolicyVersion: null, sharedCreditRule: null }, commissionCents: null, bonusCents: 10_000, advanceCents: 5_000, adjustments: [] },
    ]);
    expect(r.blocked).toBe(1);
    expect(r.lines[1]!.netCents).toBe(405_000);
  });
});

describe('exports (§10)', () => {
  it('neutralises formula cells and leaves numbers alone', () => {
    expect(safeCell('=HYPERLINK("x")')).toBe(`'=HYPERLINK("x")`);
    expect(safeCell(1234.5)).toBe(1234.5);
    expect(safeCell('Blue Express LLC')).toBe('Blue Express LLC');
  });
});

describe('a bill posts to the account its category names', () => {
  it('sends a repair to maintenance, not to other operating', () => {
    // The records carry an account code (`5300`); the map is keyed by the category name
    // (`maintenance`). Looking one up in the other used to miss silently and put every bill in
    // "other operating", throwing away the category the person chose.
    expect(expenseAccountFor('5300')).toBe('5300');
    expect(expenseAccountFor('maintenance')).toBe('5300');
    expect(expenseAccountFor('fuel')).toBe('5100');
    expect(expenseAccountFor('5100')).toBe('5100');
    expect(expenseAccountFor('nonsense')).toBe('6900');
    const posted = postBill({ billId: 'bil_1', billNumber: 'AP-1', issuedOn: '2026-09-28', vendorName: 'Shop', categoryCode: '5300', amount: 900 });
    expect(posted.ok).toBe(true);
    if (!posted.ok) return;
    expect(posted.entry.lines.find((l) => l.debit > 0)?.accountCode).toBe('5300');
  });
});
