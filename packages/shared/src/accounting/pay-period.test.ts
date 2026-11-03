import { describe, expect, it } from 'vitest';
import { defaultSwitches, type DriverTx, type ProfileVersion } from './driver-account.js';
import { fuelLineDescription, fuelSourceKey, planFuelCharges, type FuelPurchase } from './fuel-deductions.js';
import { inPayPeriod, loadPayTime, payPeriodLabel } from './pay-period.js';
import { DEFAULT_ACCOUNTING_SETTINGS } from './settings.js';
import { computeStatement, periodForCompletion, settlementPeriodFor, txInPeriod } from './settlement-rules.js';

/**
 * The pay week (owner, 2026-10-21): Monday 12:00 noon US Eastern to the next Monday 12:00 noon.
 * A load counts at its completion, unless Accounting set "Counts for pay on"; fuel bought in the
 * week is taken off the same week's statement.
 */

const ET = { timezone: 'America/New_York', cutoffTime: '12:00', payDay: 'thursday' };

describe('the pay week: Monday noon to Monday noon, US Eastern', () => {
  it('is the default for every company', () => {
    expect(DEFAULT_ACCOUNTING_SETTINGS.payPeriodCutoffTime).toBe('12:00');
    expect(DEFAULT_ACCOUNTING_SETTINGS.payPeriodTimezone).toBe('America/New_York');
    expect(DEFAULT_ACCOUNTING_SETTINGS.cutoffDay).toBe('monday');
  });

  it('11:59 on the Monday belongs to the week that is ending; 12:00 starts the new one', () => {
    // Monday 2026-10-19, EDT (UTC−4): noon = 16:00Z.
    expect(periodForCompletion('2026-10-19T15:59:00Z', ET).start).toBe('2026-10-12');
    expect(periodForCompletion('2026-10-19T15:59:59.999Z', ET).start).toBe('2026-10-12');
    expect(periodForCompletion('2026-10-19T16:00:00Z', ET).start).toBe('2026-10-19');
    expect(periodForCompletion('2026-10-19T16:01:00Z', ET).start).toBe('2026-10-19');
  });

  it('the window opens and closes at noon Eastern and reads as the real window', () => {
    const p = settlementPeriodFor('2026-10-14', ET);
    expect(p).toMatchObject({ start: '2026-10-12', end: '2026-10-18', startsAt: '2026-10-12T16:00:00.000Z', cutoffAt: '2026-10-19T16:00:00.000Z', payDate: '2026-10-22' });
    expect(payPeriodLabel(p)).toBe('Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET');
    expect(inPayPeriod('2026-10-12T16:00:00Z', p)).toBe(true);
    expect(inPayPeriod('2026-10-12T15:59:00Z', p)).toBe(false);
    expect(inPayPeriod('2026-10-19T15:59:00Z', p)).toBe(true);
    expect(inPayPeriod('2026-10-19T16:00:00Z', p)).toBe(false);
  });

  it('the owner’s example: picked up Sunday, completed Monday evening → the next period', () => {
    // Picked up Sunday 2026-10-18; the facility was closed; completed Monday 2026-10-19 at 19:30 ET.
    expect(periodForCompletion('2026-10-19T23:30:00Z', ET).start).toBe('2026-10-19');
    // Had it been completed Sunday evening it would have been this period.
    expect(periodForCompletion('2026-10-18T23:30:00Z', ET).start).toBe('2026-10-12');
  });

  it('holds across the autumn DST change: noon EST on Monday 2026-11-02 is 17:00Z', () => {
    const p = settlementPeriodFor('2026-10-28', ET);
    // Opens at noon EDT (16:00Z), closes at noon EST (17:00Z): a 169-hour week.
    expect(p.startsAt).toBe('2026-10-26T16:00:00.000Z');
    expect(p.cutoffAt).toBe('2026-11-02T17:00:00.000Z');
    expect(periodForCompletion('2026-11-02T16:59:00Z', ET).start).toBe('2026-10-26');
    expect(periodForCompletion('2026-11-02T17:00:00Z', ET).start).toBe('2026-11-02');
    expect(payPeriodLabel(p)).toBe('Mon Oct 26, 12:00 PM – Mon Nov 2, 12:00 PM ET');
  });

  it('holds across the spring DST change: noon EDT on Monday 2026-03-09 is 16:00Z', () => {
    const p = settlementPeriodFor('2026-03-04', ET);
    expect(p.startsAt).toBe('2026-03-02T17:00:00.000Z');
    expect(p.cutoffAt).toBe('2026-03-09T16:00:00.000Z');
    expect(periodForCompletion('2026-03-09T15:59:00Z', ET).start).toBe('2026-03-02');
    expect(periodForCompletion('2026-03-09T16:00:00Z', ET).start).toBe('2026-03-09');
  });

  it('consecutive weeks meet exactly: no instant belongs to two periods or to none', () => {
    const a = settlementPeriodFor('2026-10-14', ET);
    const b = settlementPeriodFor('2026-10-21', ET);
    expect(b.startsAt).toBe(a.cutoffAt);
  });
});

describe('Counts for pay on: the pay-date override', () => {
  const delivered = { deliveredAt: '2026-10-19T23:30:00Z', updatedAt: '2026-10-20T01:00:00Z' };

  it('without an override a load counts at its delivery (or its status change, when that is the basis)', () => {
    expect(loadPayTime(delivered, 'delivered_at')).toEqual({ at: '2026-10-19T23:30:00Z', source: 'completed' });
    expect(loadPayTime(delivered, 'status_updated_at').at).toBe('2026-10-20T01:00:00Z');
  });

  it('an override moves the load into exactly one week, and out of the week of its delivery', () => {
    const load = { ...delivered, payDateOverride: { at: '2026-10-19T14:00:00Z', reason: 'Facility closed; driver was there Sunday', by: 'u1', byName: 'Acct', changedAt: '2026-10-20T15:00:00Z', previousAt: '2026-10-19T23:30:00Z' } };
    const pay = loadPayTime(load, 'delivered_at');
    expect(pay).toEqual({ at: '2026-10-19T14:00:00Z', source: 'override' });
    const weekA = settlementPeriodFor('2026-10-12', ET);
    const weekB = settlementPeriodFor('2026-10-19', ET);
    // Membership is decided by one function from one time: in A, not in B.
    expect(periodForCompletion(pay.at, ET).start).toBe(weekA.start);
    expect(inPayPeriod(pay.at, weekA)).toBe(true);
    expect(inPayPeriod(pay.at, weekB)).toBe(false);
    // The delivery facts are untouched.
    expect(load.deliveredAt).toBe('2026-10-19T23:30:00Z');
  });

  it('an override that does not parse is ignored rather than guessed', () => {
    expect(loadPayTime({ ...delivered, payDateOverride: { at: 'not a date' } }, 'delivered_at').source).toBe('completed');
  });
});

function profile(over: Partial<ProfileVersion> = {}): ProfileVersion {
  return {
    effectiveFrom: '2026-01-01',
    contractType: 'LO',
    switches: { ...defaultSwitches('LO'), recurringDeductions: false },
    loadedPlan: { kind: 'per_mile', rate: 1 },
    emptyPlan: { kind: 'none', rate: 0 },
    escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true },
    byId: 'u1',
    byName: 'Test',
    at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

function tx(over: Partial<DriverTx>): DriverTx {
  return { id: 't', driverId: 'd1', kind: 'fuel', onDate: '2026-10-14', amountCents: 0, recoveredCents: 0, state: 'approved', source: 'fuel_ledger', sourceKey: 'k', truckId: null, loadId: null, settlementId: null, description: 'Fuel', companyCost: false, ...over };
}

describe('fuel on the driver statement', () => {
  const weekA = settlementPeriodFor('2026-10-12', ET);
  const weekB = settlementPeriodFor('2026-10-19', ET);
  const base = { driverId: 'd1', profile: profile(), loads: [], recurring: [], openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full' as const, payOnFundingOnly: false } };

  it('a purchase is placed by the Monday-noon window, not by its date alone', () => {
    // Monday 2026-10-19 at 11:00 ET: dated on week B's first day, but before noon → week A.
    const early = tx({ id: 'f1', onDate: '2026-10-19', occurredAt: '2026-10-19T15:00:00Z', amountCents: 40_000 });
    expect(txInPeriod(early, weekA)).toBe(true);
    expect(txInPeriod(early, weekB)).toBe(false);
    const a = computeStatement({ ...base, period: weekA, transactions: [early] });
    const b = computeStatement({ ...base, period: weekB, transactions: [early] });
    expect(a.deductions.filter((d) => d.kind === 'fuel')).toEqual([expect.objectContaining({ txId: 'f1', cents: 40_000 })]);
    expect(b.deductions.some((d) => d.txId === 'f1')).toBe(false);
  });

  it('a row with only a date is still placed by the week’s days', () => {
    const dated = tx({ id: 'f2', onDate: '2026-10-18', amountCents: 10_000 });
    expect(computeStatement({ ...base, period: weekA, transactions: [dated] }).deductions.map((d) => d.txId)).toContain('f2');
  });

  it('a company-paid purchase is shown on the account, never deducted', () => {
    const paid = tx({ id: 'f3', occurredAt: '2026-10-14T15:00:00Z', amountCents: 30_000, companyCost: true, state: 'applied' });
    expect(computeStatement({ ...base, period: weekA, transactions: [paid] }).deductions).toEqual([]);
  });

  const purchase = (over: Partial<FuelPurchase> = {}): FuelPurchase => ({ id: 'fue_1', truckId: 'tr1', driverId: 'd1', at: '2026-10-14T15:00:00Z', station: { brand: 'Pilot', name: 'Pilot #123', city: 'Dallas', state: 'TX' }, product: 'diesel', gallons: 112.44, amount: 401.25, status: 'verified', ...over });
  const plan = (purchases: FuelPurchase[], existing: DriverTx[] = [], deductFuel = true) => planFuelCharges({ driverId: 'd1', truckId: 'tr1', period: weekA, purchases, existing, deductFuel, timezone: 'America/New_York' });

  it('turns the week’s ledger purchases into one fuel transaction each, with the ledger’s amount', () => {
    const out = plan([purchase(), purchase({ id: 'fue_2', at: '2026-10-19T17:00:00Z' }), purchase({ id: 'fue_3', driverId: 'd2' })]);
    expect(out.add).toHaveLength(1); // fue_2 is week B; fue_3 is another driver's
    expect(out.add[0]).toMatchObject({ kind: 'fuel', amountCents: 40_125, state: 'approved', companyCost: false, onDate: '2026-10-14', occurredAt: '2026-10-14T15:00:00.000Z', sourceKey: fuelSourceKey('fue_1', 'd1'), description: 'Fuel · Pilot #123 · Dallas, TX · 112.4 gal' });
  });

  it('is idempotent: a recompute with the row on file writes nothing', () => {
    const first = plan([purchase()]);
    const onFile = { ...first.add[0]!, id: 'dtx1' } as DriverTx;
    expect(plan([purchase()], [onFile])).toEqual({ add: [], update: [], void: [], alreadyImported: [] });
  });

  it('a truck’s purchase with no driver named goes to the truck’s driver', () => {
    expect(plan([purchase({ driverId: '' })]).add).toHaveLength(1);
  });

  it('a purchase already imported from a Relay CSV is not charged again', () => {
    const imported = tx({ id: 'imp', sourceKey: 'import:relay:R77', source: 'import' });
    const out = plan([purchase({ id: 'fue_rly_R77' }), purchase({ id: 'fue_rly_R77_def', product: 'def', gallons: 5, amount: 20 })], [imported]);
    expect(out.add).toEqual([]);
    expect(out.alreadyImported).toEqual(['fue_rly_R77', 'fue_rly_R77_def']);
  });

  it('when the profile does not deduct fuel the purchase is the company’s cost', () => {
    expect(plan([purchase()], [], false).add[0]).toMatchObject({ companyCost: true, state: 'applied' });
  });

  it('a purchase the ledger marks as a problem waits for approval', () => {
    expect(plan([purchase({ status: 'problem' })]).add[0]).toMatchObject({ state: 'pending' });
  });

  it('a changed purchase is brought in line while unclaimed; one taken by a statement is left alone', () => {
    const onFile = { ...plan([purchase()]).add[0]!, id: 'dtx1' } as DriverTx;
    expect(plan([purchase({ amount: 410 })], [onFile]).update).toEqual([expect.objectContaining({ id: 'dtx1', amountCents: 41_000 })]);
    expect(plan([purchase({ amount: 410 })], [{ ...onFile, settlementId: 'stm1', state: 'applied', recoveredCents: 40_125 }]).update).toEqual([]);
  });

  it('a purchase no longer the driver’s is voided while unclaimed, never when a statement took it', () => {
    const onFile = { ...plan([purchase()]).add[0]!, id: 'dtx1' } as DriverTx;
    expect(plan([], [onFile]).void).toEqual(['dtx1']);
    expect(plan([], [{ ...onFile, settlementId: 'stm1' }]).void).toEqual([]);
  });

  it('DEF reads as DEF', () => {
    expect(fuelLineDescription({ station: { name: 'Love’s', city: 'Joplin', state: 'MO' }, product: 'def', gallons: 5, })).toBe('DEF · Love’s · Joplin, MO · 5 gal');
  });
});
