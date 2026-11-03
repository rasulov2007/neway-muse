import { describe, expect, it } from 'vitest';
import { defaultLeasePlan, leaseCharges, leaseTierFor } from './lease-plan.js';

const week = { periodStart: '2026-10-05', periodEnd: '2026-10-11' };

describe('lease sheet charges (owner, 2026-10-12)', () => {
  it('tractor lease follows the odometer tiers', () => {
    const tiers = defaultLeasePlan('lease_owner').tractorLease.tiers;
    expect(leaseTierFor(tiers, 150_000).weeklyCents).toBe(115_000);
    expect(leaseTierFor(tiers, 200_000).weeklyCents).toBe(115_000);
    expect(leaseTierFor(tiers, 200_001).weeklyCents).toBe(105_000);
    expect(leaseTierFor(tiers, 650_000).weeklyCents).toBe(95_000);
    expect(leaseTierFor(tiers, 700_000).weeklyCents).toBe(85_000);
  });

  it('a lease owner week: tractor, maintenance per mile, dispatch fee, weekly charges; monthly only in the week of the 1st', () => {
    const plan = defaultLeasePlan('lease_owner');
    const r = leaseCharges(plan, { ...week, grossCents: 500_000, odometer: { unitNumber: '0008', startMiles: 120_000, endMiles: 122_500, endReadAt: null } });
    const by = Object.fromEntries(r.lines.map((l) => [l.code, l.cents]));
    expect(r.problems).toEqual([]);
    expect(by.tractor_lease).toBe(115_000);
    expect(by.maintenance_fee).toBe(2_500 * 13);
    expect(by.dispatch_fee).toBe(100_000);
    expect(by.trailer_rent).toBe(22_000);
    expect(by.insurance).toBe(50_000);
    expect(by.occupational_accident).toBeUndefined();
    const monthWeek = leaseCharges(plan, { periodStart: '2026-09-28', periodEnd: '2026-10-04', grossCents: 0, odometer: { unitNumber: '0008', startMiles: 1, endMiles: 1, endReadAt: null } });
    expect(monthWeek.lines.map((l) => l.code)).toEqual(expect.arrayContaining(['occupational_accident', 'tablet', 'toll_device']));
  });

  it('the dispatch fee never takes again what a percentage load pay already kept (owner, 2026-10-29)', () => {
    const plan = { ...defaultLeasePlan('lease_owner'), dispatchFee: { enabled: true, percent: 15 } };
    // 85% load pay on a $2,000 load: $300 already kept, the 15% fee is $300 - nothing more to take.
    const at85 = leaseCharges(plan, { ...week, grossCents: 170_000, loadGrossCents: 200_000, keptCents: 30_000, odometer: null });
    expect(at85.lines.some((l) => l.code === 'dispatch_fee')).toBe(false);
    expect(at85.notes[0]).toMatch(/Dispatch fee not taken/);
    // 90% load pay: $200 kept, $100 still due.
    const at90 = leaseCharges(plan, { ...week, grossCents: 180_000, loadGrossCents: 200_000, keptCents: 20_000, odometer: null });
    expect(at90.lines.find((l) => l.code === 'dispatch_fee')?.cents).toBe(10_000);
    // 100% load pay: the whole fee, on the load gross.
    const at100 = leaseCharges(plan, { ...week, grossCents: 200_000, loadGrossCents: 200_000, keptCents: 0, odometer: null });
    expect(at100.lines.find((l) => l.code === 'dispatch_fee')?.cents).toBe(30_000);
  });

  it('past 130,000 miles the maintenance fee is $0.20 a mile', () => {
    const r = leaseCharges(defaultLeasePlan('lease_owner'), { ...week, grossCents: 0, odometer: { unitNumber: '0008', startMiles: 129_000, endMiles: 131_000, endReadAt: null } });
    expect(r.lines.find((l) => l.code === 'maintenance_fee')?.cents).toBe(2_000 * 20);
  });

  it('owner truck pays only dispatch fee, insurance, IFTA and trailer rent; dispatch fee can be switched off', () => {
    const plan = defaultLeasePlan('owner_truck');
    const r = leaseCharges(plan, { ...week, grossCents: 100_000, odometer: null });
    expect(r.problems).toEqual([]);
    expect(r.lines.map((l) => l.code).sort()).toEqual(['dispatch_fee', 'ifta', 'insurance', 'trailer_rent']);
    const off = leaseCharges({ ...plan, dispatchFee: { enabled: false, percent: 20 } }, { ...week, grossCents: 100_000, odometer: null });
    expect(off.lines.some((l) => l.code === 'dispatch_fee')).toBe(false);
  });

  it('never guesses a mileage charge without an odometer', () => {
    const r = leaseCharges(defaultLeasePlan('lease_owner'), { ...week, grossCents: 0, odometer: { unitNumber: '0008', startMiles: null, endMiles: null, endReadAt: null } });
    expect(r.problems).toHaveLength(2);
    expect(r.lines.some((l) => l.code === 'tractor_lease' || l.code === 'maintenance_fee')).toBe(false);
  });
});
