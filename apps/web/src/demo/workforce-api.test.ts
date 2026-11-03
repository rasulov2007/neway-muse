import { beforeEach, describe, expect, it, vi } from 'vitest';
import { demoData } from './data';
import {
  DEFAULT_ESCROW_TARGET,
  escrowAccount,
  recordEscrowEntry,
  terminateDriver,
} from './workforce-api';
import { defaultEquipment } from './workforce-api';

// The roster write is the one call that leaves the store; a termination must not depend on it.
vi.mock('./roster-api', () => ({ setDriverStatusRecord: vi.fn(async () => undefined) }));

describe('driver escrow and termination', () => {
  const driverId = 'drv_escrow_test';

  beforeEach(() => {
    demoData.escrowEntries.length = 0;
    demoData.terminations.length = 0;
    demoData.deductionPlans.length = 0;
    const driver = demoData.drivers[0];
    if (driver) {
      // A fresh copy of a real driver, so the termination has something to write to.
      const clone = { ...driver, id: driverId, name: 'Escrow Test', status: 'available' as const };
      const existing = demoData.drivers.findIndex((d) => d.id === driverId);
      if (existing >= 0) demoData.drivers.splice(existing, 1, clone);
      else demoData.drivers.push(clone);
    }
  });

  it('refuses to take out more escrow than was ever put in', async () => {
    await recordEscrowEntry({ driverId, kind: 'payment', amount: 500, reason: 'Deposit' });
    await expect(
      recordEscrowEntry({ driverId, kind: 'refund', amount: 900, reason: 'Too much' }),
    ).rejects.toThrow(/is held for this driver/);
    expect(escrowAccount(driverId).balance).toBe(500);
  });

  it('takes charges from escrow and owes the rest back to the driver', async () => {
    await recordEscrowEntry({
      driverId,
      kind: 'payment',
      amount: DEFAULT_ESCROW_TARGET,
      reason: 'Escrow deposit',
    });

    const equipment = defaultEquipment().map((item) =>
      item.code === 'tablet' ? { ...item, returned: false } : item,
    );
    const record = await terminateDriver({
      driverId,
      reason: 'resigned',
      rehireEligible: true,
      equipment,
      accident: false,
    });

    expect(record.equipmentCharge).toBe(450);
    expect(record.escrowApplied).toBe(450);
    expect(record.escrowRefund).toBe(DEFAULT_ESCROW_TARGET - 450);
    expect(record.shortfall).toBe(0);
    expect(escrowAccount(driverId).balance).toBe(DEFAULT_ESCROW_TARGET - 450);
  });

  it('sends what escrow cannot cover to the final settlement rather than writing it off', async () => {
    await recordEscrowEntry({ driverId, kind: 'payment', amount: 200, reason: 'Part deposit' });

    const equipment = defaultEquipment().map((item) => ({ ...item, returned: false }));
    const record = await terminateDriver({
      driverId,
      reason: 'abandoned_truck',
      rehireEligible: false,
      equipment,
      accident: true,
      accidentCharge: 1000,
    });

    const charges = equipment.reduce((sum, item) => sum + item.replacementCost, 0) + 1000;
    expect(record.escrowApplied).toBe(200);
    expect(record.shortfall).toBe(charges - 200);
    expect(record.escrowRefund).toBe(0);

    const plan = demoData.deductionPlans.find((p) => p.driverId === driverId);
    expect(plan, 'the shortfall follows the driver into Accounting').toBeTruthy();
    expect(plan?.balance).toBe(charges - 200);
  });

  it('will not terminate the same driver twice', async () => {
    await terminateDriver({
      driverId,
      reason: 'resigned',
      rehireEligible: true,
      equipment: defaultEquipment(),
      accident: false,
    });
    await expect(
      terminateDriver({
        driverId,
        reason: 'resigned',
        rehireEligible: true,
        equipment: defaultEquipment(),
        accident: false,
      }),
    ).rejects.toThrow(/already terminated/);
  });
});
