import { describe, expect, it } from 'vitest';
import { CreateWorkOrderSchema, SetWorkOrderChargeSchema } from './work-orders.js';

/**
 * Who pays, and the one question a driver charge may not dodge.
 *
 * The rule these tests hold: money never moves off a driver's pay without somebody having
 * answered "has the driver been told". Not knowing is allowed - it is recorded as "not informed"
 * and held - but leaving the question blank is not.
 */
const base = {
  assetType: 'truck' as const,
  unitId: 'trk_1',
  status: 'in_shop' as const,
  workType: 'oil_change' as const,
};

describe('who pays for a repair', () => {
  it('is the company when nobody says otherwise', () => {
    const out = CreateWorkOrderSchema.safeParse(base);
    expect(out.success).toBe(true);
    if (out.success) expect(out.data.chargeParty).toBe('company');
  });

  it('refuses a driver charge that does not say whether the driver was told', () => {
    const out = CreateWorkOrderSchema.safeParse({ ...base, chargeParty: 'driver' });
    expect(out.success).toBe(false);
    if (!out.success) {
      expect(out.error.issues.some((i) => i.path[0] === 'driverInformed')).toBe(true);
    }
  });

  it('accepts a driver charge that has been answered either way', () => {
    for (const informed of [true, false]) {
      const out = CreateWorkOrderSchema.safeParse({
        ...base,
        chargeParty: 'driver',
        driverInformed: informed,
      });
      expect(out.success).toBe(true);
      if (out.success) expect(out.data.driverInformed).toBe(informed);
    }
  });

  it('does not ask the question of a company expense', () => {
    const out = CreateWorkOrderSchema.safeParse({ ...base, chargeParty: 'company' });
    expect(out.success).toBe(true);
  });
});

describe('changing who pays afterwards', () => {
  it('needs the answer for a driver charge', () => {
    expect(SetWorkOrderChargeSchema.safeParse({ party: 'driver' }).success).toBe(false);
    expect(
      SetWorkOrderChargeSchema.safeParse({ party: 'driver', driverInformed: true }).success,
    ).toBe(true);
  });

  it('takes a move back to the company with no answer at all', () => {
    expect(SetWorkOrderChargeSchema.safeParse({ party: 'company' }).success).toBe(true);
  });
});
