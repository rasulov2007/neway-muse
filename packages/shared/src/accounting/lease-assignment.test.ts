import { describe, expect, it } from 'vitest';
import { readingConflict, odometerConflictMessage } from '../fleet/pm.js';
import { defaultSwitches, type ProfileVersion } from './driver-account.js';
import { NO_TRUCK_LEASE_NOTE, defaultLeasePlan, leaseAssignmentsInWeek, leaseCharges } from './lease-plan.js';
import { computeStatement, settlementPeriodFor, type SettleableLoadV2 } from './settlement-rules.js';

/**
 * Lease charges only while a truck is assigned (owner, 2026-10-22), and the guard on a typed
 * odometer that jumps far past the last reading.
 */

const NY = { timezone: 'America/New_York', cutoffTime: '12:00', payDay: 'thursday' };
// Mon 2026-10-12 .. Sun 2026-10-18 (Monday noon to Monday noon).
const period = settlementPeriodFor('2026-10-14', NY);
const a = (assignedOn: string, endedOn: string | null) => ({ truckId: 't1', assignedOn, endedOn });

const profile: ProfileVersion = {
  effectiveFrom: '2026-01-01',
  contractType: 'LO',
  switches: { ...defaultSwitches('LO'), recurringDeductions: true },
  loadedPlan: { kind: 'percent_of_gross', rate: 100 },
  emptyPlan: { kind: 'none', rate: 0 },
  escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true },
  lease: defaultLeasePlan('lease_owner'),
  byId: 'u1',
  byName: 'Test',
  at: '2026-01-01T00:00:00Z',
} as ProfileVersion;

const load: SettleableLoadV2 = { id: 'ld1', loadNumber: 'L-1', completedAt: '2026-10-14T15:00:00Z', originLabel: 'A', destinationLabel: 'B', loadedMiles: 1000, emptyMiles: 0, grossCents: 500_000, linehaulCents: 500_000, driverIds: ['d1'], accessorials: [], funded: true, status: 'delivered' };

const run = (leaseTruckAssigned: boolean | undefined) =>
  computeStatement({ driverId: 'd1', period, profile, loads: [load], transactions: [], recurring: [{ id: 'rcd1', driverId: 'd1', category: 'other', label: 'phone', cadence: 'weekly', amountCents: 2_000, startsOn: '2026-01-01', endsOn: null, appliesWhenNoWork: true, totalCents: null, status: 'active', overrides: [], chargedCents: 0 }] as never, openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false }, odometer: { unitNumber: '0008', startMiles: 120_000, endMiles: 121_000, endReadAt: null }, leaseTruckAssigned });

describe('which assignments count for a pay week', () => {
  it('a week before the assignment: none', () => {
    expect(leaseAssignmentsInWeek([a('2026-10-19', null)], period)).toEqual([]);
  });
  it('an assignment starting mid-week: the whole week counts, its odometer window starts that day', () => {
    expect(leaseAssignmentsInWeek([a('2026-10-15', null)], period)).toEqual([{ ...a('2026-10-15', null), from: '2026-10-15', to: '2026-10-18' }]);
  });
  it('one that started on the Sunday still counts', () => {
    expect(leaseAssignmentsInWeek([a('2026-10-18', null)], period)).toHaveLength(1);
  });
  it('ended before the week: none; ended on the Monday the week starts (by noon): none; ended Tuesday: counts', () => {
    expect(leaseAssignmentsInWeek([a('2026-09-01', '2026-10-05')], period)).toEqual([]);
    expect(leaseAssignmentsInWeek([a('2026-09-01', '2026-10-12')], period)).toEqual([]);
    expect(leaseAssignmentsInWeek([a('2026-09-01', '2026-10-13')], period)).toEqual([{ ...a('2026-09-01', '2026-10-13'), from: '2026-10-12', to: '2026-10-13' }]);
  });
  it('a same-day assignment (opened and closed on one day) is not a week with a truck', () => {
    expect(leaseAssignmentsInWeek([a('2026-10-14', '2026-10-14')], period)).toEqual([]);
  });
});

describe('lease charges on the statement', () => {
  it('no truck assigned: no lease lines, the note, recurring deductions still taken', () => {
    const s = run(false);
    expect(s.deductions.filter((d) => d.kind === 'lease')).toEqual([]);
    expect(s.leaseCharges).toEqual([]);
    expect(s.notes).toEqual([NO_TRUCK_LEASE_NOTE]);
    expect(s.exceptions.some((e) => /odometer/i.test(e))).toBe(false);
    expect(s.deductions.find((d) => d.ref === 'rcd1')?.cents).toBe(2_000);
  });
  it('a truck assigned (any overlap): the full weekly charges', () => {
    const s = run(true);
    const by = Object.fromEntries(s.deductions.filter((d) => d.kind === 'lease').map((d) => [d.ref, d.cents]));
    expect(by.tractor_lease).toBe(115_000);
    expect(by.maintenance_fee).toBe(1_000 * 13);
    expect(by.trailer_rent).toBe(22_000);
    expect(s.notes).toEqual([]);
  });
  it('not checked (older callers): as before', () => {
    expect(run(undefined).deductions.some((d) => d.ref === 'tractor_lease')).toBe(true);
  });
  it('miles across two trucks in one week are added up', () => {
    const r = leaseCharges(defaultLeasePlan('lease_owner'), { grossCents: 0, periodStart: period.start, periodEnd: period.end, odometer: { unitNumber: '0009', startMiles: 50_000, endMiles: 50_400, endReadAt: null, miles: 1_400 } });
    expect(r.lines.find((l) => l.code === 'maintenance_fee')?.cents).toBe(1_400 * 13);
  });
});

describe('odometer jump guard (owner, 2026-10-22)', () => {
  const prev = { odometerMiles: 440_667, readingAt: '2026-10-10T12:00:00Z' };
  it('642,085 typed after 440,667 is an implausible jump, said with both numbers', () => {
    expect(readingConflict(prev, { odometerMiles: 642_085, readingAt: '2026-10-20T12:00:00Z' })).toBe('implausible_jump');
    expect(odometerConflictMessage('implausible_jump', 642_085, 440_667)).toBe('Odometer 642,085 is 201,418 mi above the last reading (440,667) — check the number');
  });
  it('more than 3,000 mi the same day is a jump; a normal week is not', () => {
    expect(readingConflict(prev, { odometerMiles: 443_700, readingAt: '2026-10-10T18:00:00Z' })).toBe('implausible_jump');
    expect(readingConflict(prev, { odometerMiles: 443_500, readingAt: '2026-10-17T12:00:00Z' })).toBeNull();
  });
  it('below the last reading stays below_previous', () => {
    expect(readingConflict(prev, { odometerMiles: 440_000, readingAt: '2026-10-11T12:00:00Z' })).toBe('below_previous');
    expect(odometerConflictMessage('below_previous', 440_000, 440_667)).toBe('Odometer 440,000 is 667 mi below the last reading (440,667) — check the number');
  });
});

describe('dispatch fee and a percentage load pay (owner, 2026-10-29)', () => {
  const at = (rate: number, percent: number) =>
    computeStatement({ driverId: 'd1', period, profile: { ...profile, loadedPlan: { kind: 'percent_of_gross', rate }, lease: { ...defaultLeasePlan('lease_owner'), dispatchFee: { enabled: true, percent } } } as ProfileVersion, loads: [{ ...load, grossCents: 200_000, linehaulCents: 200_000 }], transactions: [], recurring: [], openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false }, odometer: { unitNumber: '0008', startMiles: 120_000, endMiles: 121_000, endReadAt: null }, leaseTruckAssigned: true });
  it('85% pay keeps the 15% already: no dispatch fee line, a note says why', () => {
    const s = at(85, 15);
    expect(s.leaseCharges?.some((l) => l.code === 'dispatch_fee')).toBe(false);
    expect(s.notes?.some((n) => n.startsWith('Dispatch fee not taken'))).toBe(true);
  });
  it('100% pay: the 15% fee on the $2,000 gross', () => {
    expect(at(100, 15).leaseCharges?.find((l) => l.code === 'dispatch_fee')?.cents).toBe(30_000);
  });
});

describe('a charge added for the week is taken whole (owner, 2026-10-29)', () => {
  const fuel = (extra: object = {}) => ({ id: 'dtx_fuel', driverId: 'd1', kind: 'manual_charge', onDate: period.end, amountCents: 802_21, recoveredCents: 0, state: 'approved', source: 'manual', sourceKey: 'k', truckId: null, loadId: null, settlementId: null, description: 'Fuel', companyCost: false, ...extra });
  const at = (tx: object) =>
    computeStatement({ driverId: 'd1', period, profile: { ...profile, lease: undefined } as unknown as ProfileVersion, loads: [{ ...load, grossCents: 50_000, linehaulCents: 50_000 }], transactions: [tx] as never, recurring: [], openingDebtCents: 0, settings: { teamBaseMileageSplit: 'each_full', payOnFundingOnly: false } });
  it('net goes below zero and the rest is carried to next week', () => {
    const s = at(fuel());
    expect(s.deductions.find((d) => d.txId === 'dtx_fuel')).toMatchObject({ kind: 'manual_charge', cents: 802_21 });
    expect(s.netCents).toBe(50_000 - 802_21);
    expect(s.payableCents).toBe(0);
    expect(s.carryCents).toBe(802_21 - 50_000);
    expect(s.recoveries).toEqual([]);
  });
  it('a charge spread over weeks is still recovered from what is left', () => {
    const s = at(fuel({ installments: { total: 4, remaining: 4, perPeriodCents: 20_056 } }));
    expect(s.deductions.some((d) => d.kind === 'manual_charge')).toBe(false);
  });
});
