import { beforeEach, describe, expect, it } from 'vitest';
import { demoData } from './data';
import { createRepairOrder, updateRepairOrder } from './fleet-writes';
import {
  ownerBilledOrdersFor,
  ownerShareOf,
  setWorkOrderBilling,
  suggestWorkOrderBilling,
} from './work-order-billing';

/**
 * P2 #13: a repair on an owner-operator's unit is the owner's cost. The work order records who
 * pays, the owner's share becomes a deduction on their settlement, and fleet spend counts only
 * the company's part.
 */
describe('work order billing', () => {
  const truck = demoData.trucks[0]!;
  const driver = demoData.drivers[0]!;

  beforeEach(() => {
    demoData.repairOrders.length = 0;
    demoData.deductionPlans.length = 0;
    truck.ownership = 'owned';
    truck.currentDriverId = driver.id;
    driver.driverType = 'company';
  });

  async function order(total = 1000) {
    const created = await createRepairOrder({
      truckId: truck.id,
      type: 'brake_repair',
      summary: 'Rear brake job',
      priority: 'normal',
      vendorName: '',
      technician: '',
      promisedAt: null,
      status: 'open',
      warranty: false,
      notes: null,
      price: total,
    });
    const row = demoData.repairOrders.find((ro) => ro.id === created.id)!;
    row.total = total;
    return row;
  }

  it('suggests the company for a company truck and the driver for an owner-operator unit', async () => {
    const row = await order();
    expect(suggestWorkOrderBilling(row)).toMatchObject({ party: 'company' });

    truck.ownership = 'owner_operator';
    const owned = suggestWorkOrderBilling(row);
    expect(owned).toMatchObject({ party: 'owner', ownerDriverId: driver.id });
    expect(owned.suggestedFrom).toContain(truck.unitNumber);

    truck.ownership = 'owned';
    driver.driverType = 'lease_operator';
    expect(suggestWorkOrderBilling(row)).toMatchObject({ party: 'owner', ownerDriverId: driver.id });
  });

  it('bills the whole repair to the driver as one deduction', async () => {
    const row = await order(1000);
    const saved = await setWorkOrderBilling({
      orderId: row.id,
      party: 'owner',
      ownerDriverId: driver.id,
    });
    expect(saved.billing).toMatchObject({ party: 'owner', ownerDriverId: driver.id });
    expect(ownerShareOf(saved)).toBe(1000);

    const plan = demoData.deductionPlans.find((p) => p.id === saved.billing?.deductionPlanId);
    expect(plan).toMatchObject({ driverId: driver.id, amountPerPeriod: 1000, status: 'active' });
    expect(plan?.description).toContain(row.roNumber);
    expect(ownerBilledOrdersFor(driver.id).map((o) => o.id)).toEqual([row.id]);
  });

  it('splits the bill, needs a note for it, and charges only the owner half', async () => {
    const row = await order(1000);
    await expect(
      setWorkOrderBilling({
        orderId: row.id,
        party: 'owner',
        ownerDriverId: driver.id,
        companyAmount: 400,
      }),
    ).rejects.toThrow(/note/i);

    const saved = await setWorkOrderBilling({
      orderId: row.id,
      party: 'owner',
      ownerDriverId: driver.id,
      companyAmount: 400,
      note: 'Company covers the tyres, driver covers the damage',
    });
    expect(ownerShareOf(saved)).toBe(600);
    const plan = demoData.deductionPlans.find((p) => p.id === saved.billing?.deductionPlanId);
    expect(plan?.amountPerPeriod).toBe(600);
    expect(demoData.deductionPlans).toHaveLength(1);
  });

  it('moves the charge back to the company without leaving a live deduction behind', async () => {
    const row = await order(1000);
    const billed = await setWorkOrderBilling({
      orderId: row.id,
      party: 'owner',
      ownerDriverId: driver.id,
    });
    const planId = billed.billing!.deductionPlanId!;

    const back = await setWorkOrderBilling({ orderId: row.id, party: 'company' });
    expect(back.billing).toMatchObject({ party: 'company', deductionPlanId: null });
    expect(ownerShareOf(back)).toBe(0);
    const plan = demoData.deductionPlans.find((p) => p.id === planId);
    expect(plan).toMatchObject({ status: 'cancelled', balance: 0 });
  });

  it('refuses an owner bill with no driver, and never raises a second plan for one order', async () => {
    const row = await order(1000);
    await expect(setWorkOrderBilling({ orderId: row.id, party: 'owner' })).rejects.toThrow(
      /driver/i,
    );
    await setWorkOrderBilling({ orderId: row.id, party: 'owner', ownerDriverId: driver.id });
    await setWorkOrderBilling({ orderId: row.id, party: 'owner', ownerDriverId: driver.id });
    expect(demoData.deductionPlans.filter((p) => p.status === 'active')).toHaveLength(1);
  });

  it('leaves the order itself alone: billing is not a status change', async () => {
    const row = await order(1000);
    await setWorkOrderBilling({ orderId: row.id, party: 'owner', ownerDriverId: driver.id });
    expect(row.status).toBe('open');
    const refused = await updateRepairOrder({ id: row.id, status: 'completed' });
    expect(refused.ok).toBe(false);
  });
});
