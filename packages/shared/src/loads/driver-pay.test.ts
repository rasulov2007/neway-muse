import { describe, expect, it } from 'vitest';
import { invoiceLinesFor, type BillableLoad } from '../accounting/billing.js';
import { defaultSwitches, type ProfileVersion } from '../accounting/driver-account.js';
import { computeStatement, explainLoadPay, type SettleableLoadV2 } from '../accounting/settlement-rules.js';
import { driverMessageFromRc } from './driver-message.js';
import { applyEdit } from './edit.js';
import { applyPayFacts, chargeDriverAmount, driverRateOf, isCompanyDriverType, loadRefLabel, settleableAmounts } from './driver-pay.js';
import type { RateConfirmationExtract } from './rate-confirmation.js';
import type { StoredLoad } from './write-rules.js';

/**
 * Real rate vs For driver rate (owner, 2026-10-23): the broker pays $3,000, the driver is paid as
 * if the load were $2,500. The figures are fixtures, not any load's real revenue.
 */
const record = (over: Record<string, unknown> = {}): StoredLoad =>
  ({
    id: 'ld_1',
    loadNumber: 'L-100015',
    status: 'delivered',
    brokerReference: '123456',
    rate: 3000,
    stops: [],
    documents: [],
    timeline: [],
    notes: [],
    updatedAt: '2026-10-20T12:00:00.000Z',
    charges: [
      { id: 'c1', type: 'linehaul', description: 'Linehaul', amount: 3000, billable: true },
      { id: 'c2', type: 'detention', description: 'Detention', amount: 200, billable: true, status: 'accepted' },
      { id: 'c3', type: 'layover', description: 'Layover', amount: 250, billable: true, status: 'draft' },
    ],
    ...over,
  }) as unknown as StoredLoad;

const profile = (kind: ProfileVersion['loadedPlan']['kind'], rate: number): ProfileVersion => ({ effectiveFrom: '2026-01-01', contractType: 'OO', switches: defaultSwitches('OO'), loadedPlan: { kind, rate }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, byId: 'u', byName: 'u', at: '2026-01-01T00:00:00Z' });

function settleable(r: StoredLoad): SettleableLoadV2 {
  const m = settleableAmounts(r);
  return {
    id: r.id,
    loadNumber: r.loadNumber,
    completedAt: '2026-10-20T15:00:00Z',
    originLabel: 'A',
    destinationLabel: 'B',
    loadedMiles: 1000,
    emptyMiles: 0,
    grossCents: m.grossCents,
    linehaulCents: m.linehaulCents,
    realLinehaulCents: m.realLinehaulCents,
    brokerReference: String(r['brokerReference']),
    driverIds: ['d1'],
    accessorials: m.accessorials.map((a) => ({ ...a, allocation: { chargeId: a.id, treatment: 'paid_separately', mode: 'full', value: 100, nature: 'earning', recipients: ['d1'] } })),
    funded: true,
    status: 'delivered',
  };
}

describe('For driver amounts', () => {
  it('default to the real amounts', () => {
    const r = record();
    expect(driverRateOf(r)).toBe(3000);
    expect(chargeDriverAmount({ amount: 200 })).toBe(200);
    expect(settleableAmounts(r)).toMatchObject({ realLinehaulCents: 300_000, linehaulCents: 300_000 });
  });

  it('the statement pays a percentage plan on the For driver rate, not the real one', () => {
    const load = settleable(record({ driverRate: 2500 }));
    const pay = explainLoadPay(load, 'd1', profile('percent_of_linehaul', 30), { teamBaseMileageSplit: 'each_full' });
    expect(pay.lines[0]!.payBasisCents).toBe(250_000);
    expect(pay.lines[0]!.cents).toBe(75_000);
    expect(pay.lines[0]!.brokerReference).toBe('123456');
    const comp = computeStatement({ driverId: 'd1', period: { start: '2026-10-19', end: '2026-10-25', cutoffAt: '2026-10-26T16:00:00Z', payDate: '2026-10-30', timezone: 'America/New_York' }, profile: profile('percent_of_linehaul', 30), loads: [load], transactions: [], recurring: [], openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false } });
    expect(comp.loadFacts?.[0]).toMatchObject({ loadNumber: 'L-100015', brokerReference: '123456', realLinehaulCents: 300_000, linehaulCents: 250_000 });
  });

  it('pays detention on its For driver amount; a draft layover is not paid at all', () => {
    const r = record({ charges: [{ id: 'c1', type: 'linehaul', description: 'Linehaul', amount: 3000, billable: true }, { id: 'c2', type: 'detention', description: 'Detention', amount: 200, billable: true, status: 'accepted', driverAmount: 150 }, { id: 'c3', type: 'layover', description: 'Layover', amount: 250, billable: true, status: 'draft' }] });
    const load = settleable(r);
    expect(load.accessorials).toEqual([expect.objectContaining({ id: 'c2', amountCents: 15_000, realAmountCents: 20_000 })]);
    const pay = explainLoadPay(load, 'd1', profile('percent_of_linehaul', 30), { teamBaseMileageSplit: 'each_full' });
    expect(pay.lines.find((l) => l.chargeId === 'c2')!.cents).toBe(15_000);
    // The real gross is the load's revenue: it is not lowered by what the driver is paid on.
    expect(load.grossCents).toBe(320_000);
  });

  it('the invoice to the broker still bills the real amounts', () => {
    const billable = { id: 'ld_1', loadNumber: 'L-100015', status: 'delivered', rate: 3000, charges: [{ id: 'c1', type: 'linehaul', description: 'Linehaul', amount: 3000, billable: true, driverAmount: 2500 }, { id: 'c2', type: 'detention', description: 'Detention', amount: 200, billable: true, status: 'accepted', driverAmount: 150 }] } as unknown as BillableLoad;
    expect(invoiceLinesFor(billable).map((l) => l.amount)).toEqual([3000, 200]);
  });
});

describe('the pay-facts write', () => {
  it('sets the For driver rate, a For driver accessorial and the REF, version-checked', () => {
    const r = record();
    const out = applyPayFacts(r, { expectedUpdatedAt: r.updatedAt, driverRate: 2500, charges: [{ chargeId: 'c2', driverAmount: 150 }], brokerReference: ' 654321 ' }, '2026-10-21T00:00:00.000Z');
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.record['driverRate']).toBe(2500);
    expect((out.record['charges'] as Array<{ id: string; driverAmount?: number | null }>).find((c) => c.id === 'c2')!.driverAmount).toBe(150);
    expect(out.record['brokerReference']).toBe('654321');
    expect(out.record.updatedAt).toBe('2026-10-21T00:00:00.000Z');
  });

  it('a stale copy is a conflict, never an overwrite', () => {
    const out = applyPayFacts(record(), { expectedUpdatedAt: '2026-10-01T00:00:00.000Z', driverRate: 2500 }, '2026-10-21T00:00:00.000Z');
    expect(out).toMatchObject({ ok: false, refusal: { code: 'conflict' } });
  });

  it('a For driver figure equal to the real one is stored as "same as real"', () => {
    const r = record({ driverRate: 2500 });
    const out = applyPayFacts(r, { expectedUpdatedAt: r.updatedAt, driverRate: 3000 }, '2026-10-21T00:00:00.000Z');
    expect(out.ok && out.record['driverRate']).toBeNull();
  });

  it('refuses an accessorial the load does not have, and a blank REF', () => {
    const r = record();
    expect(applyPayFacts(r, { expectedUpdatedAt: r.updatedAt, charges: [{ chargeId: 'nope', driverAmount: 1 }] }, 'now')).toMatchObject({ ok: false, refusal: { code: 'not_found' } });
    expect(applyPayFacts(r, { expectedUpdatedAt: r.updatedAt, brokerReference: '  ' }, 'now')).toMatchObject({ ok: false, refusal: { code: 'invalid' } });
  });

  it('dispatch may set the For driver rate through Edit', () => {
    const r = record();
    expect(applyEdit(r, { expectedUpdatedAt: r.updatedAt, patch: { driverRate: 2500 } }, 'now').ok).toBe(true);
  });
});

describe('REF beside the L-number', () => {
  it('prints "REF 123456 / L-100015", or the L-number alone without a REF', () => {
    expect(loadRefLabel('123456', 'L-100015')).toBe('REF 123456 / L-100015');
    expect(loadRefLabel('', 'L-100015')).toBe('L-100015');
    expect(loadRefLabel(null, 'L-100015')).toBe('L-100015');
  });
});

describe('the Telegram message and the rate', () => {
  const rc: RateConfirmationExtract = {
    brokerName: 'Broker', brokerMc: null, brokerLoadNumber: '123456', totalRate: 3000, linehaulRate: null, commodity: null, weightLbs: null, equipment: 'dry_van', hazmat: false, temperature: null, miles: 900,
    stops: [
      { kind: 'pickup', facilityName: 'Shipper', street: null, city: 'Atlanta', state: 'GA', zip: null, date: '2026-10-24', time: '08:00', endTime: null, reference: null },
      { kind: 'delivery', facilityName: 'Receiver', street: null, city: 'Dallas', state: 'TX', zip: null, date: '2026-10-25', time: '14:00', endTime: null, reference: null },
    ],
    notes: null, warnings: [],
  };

  it('keeps the rate for an owner operator, at the For driver figure', () => {
    expect(driverMessageFromRc(rc)).toContain('Rate: $3000');
    expect(driverMessageFromRc(rc, { rate: 2500 })).toContain('Rate: $2500');
    expect(driverMessageFromRc(rc, { rate: 2500 })).not.toContain('$3000');
  });

  it('leaves the Rate line out for a company driver', () => {
    const text = driverMessageFromRc(rc, { hideRate: true, rate: 2500 });
    expect(text).not.toMatch(/Rate:/);
    expect(text).toContain('Total: 900 miles');
  });

  it('knows a company driver by the driver type', () => {
    expect(isCompanyDriverType('company')).toBe(true);
    expect(isCompanyDriverType('owner_operator')).toBe(false);
    expect(isCompanyDriverType('lease_operator')).toBe(false);
    expect(isCompanyDriverType(null)).toBe(false);
  });
});
