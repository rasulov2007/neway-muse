import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import { driverChargePlanId, syncDriverChargeDeduction } from './driver-charge';

/**
 * The deduction a driver charge becomes.
 *
 * One plan per work order, named after it, so correcting a charge corrects the plan instead of
 * stacking a second one on the driver. And the rule the whole feature exists for: a charge the
 * driver has not been told about is never active.
 */
const charge = {
  orderId: 'wo_1',
  orderNumber: 'RO-2026-1042',
  driverId: 'drv_1',
  amount: 1200,
  informed: false,
  summary: 'Air leak at the trailer supply line',
  startsOn: '2026-09-24T12:00:00.000Z',
};

describe('a repair charged to a driver', () => {
  beforeEach(() => {
    demoData.deductionPlans = demoData.deductionPlans.filter(
      (p) => p.id !== driverChargePlanId(charge.orderId),
    );
  });

  it('is held, not deducted, while the driver has not been told', () => {
    const plan = syncDriverChargeDeduction(charge);
    expect(plan?.status).toBe('on_hold');
    expect(plan?.balance).toBe(1200);
    expect(plan?.description).toContain('RO-2026-1042');
  });

  it('starts running the moment the driver is recorded as told', () => {
    syncDriverChargeDeduction(charge);
    const plan = syncDriverChargeDeduction({ ...charge, informed: true });
    expect(plan?.status).toBe('active');
    expect(
      demoData.deductionPlans.filter((p) => p.id === driverChargePlanId(charge.orderId)),
    ).toHaveLength(1);
  });

  it('corrects the same plan when the amount changes instead of adding another', () => {
    syncDriverChargeDeduction({ ...charge, informed: true });
    const plan = syncDriverChargeDeduction({ ...charge, informed: true, amount: 900 });
    expect(plan?.amountPerPeriod).toBe(900);
    expect(
      demoData.deductionPlans.filter((p) => p.id === driverChargePlanId(charge.orderId)),
    ).toHaveLength(1);
  });

  it('is cancelled, and carries nothing, when the charge goes back to the company', () => {
    syncDriverChargeDeduction({ ...charge, informed: true });
    const plan = syncDriverChargeDeduction({ ...charge, informed: true, amount: 0 });
    expect(plan?.status).toBe('cancelled');
    expect(plan?.balance).toBe(0);
  });
});
