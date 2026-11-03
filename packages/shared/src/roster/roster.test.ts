import { describe, expect, it } from 'vitest';
import {
  CreateTruckSchema,
  FIRST_SERVICE_INTERVAL_MILES,
  UpdateTruckSchema,
} from './roster.js';

describe('CreateTruckSchema', () => {
  const identity = {
    unitNumber: '2790',
    vin: '1FUJGLDR5LLAB1234',
    year: 2024,
    make: 'Freightliner',
    model: 'Cascadia',
    odometer: 0,
    status: 'available' as const,
  };

  it('accepts a unit with only its identity, an odometer and a status', () => {
    // A unit exists before its plate, colour, terminal or in-service date are known. Nothing the
    // Add form now allows may be rejected here.
    const result = CreateTruckSchema.safeParse(identity);
    expect(result.success).toBe(true);
    if (!result.success) return;
    expect(result.data.plate).toBeUndefined();
    expect(result.data.plateState).toBeUndefined();
    expect(result.data.color).toBeUndefined();
    expect(result.data.homeTerminal).toBeUndefined();
    expect(result.data.inServiceDate).toBeUndefined();
    expect(result.data.nextServiceDate).toBeUndefined();
    // The defaults the rest of the product assumes.
    expect(result.data.ownership).toBe('owned');
    expect(result.data.engineHours).toBe(0);
    expect(result.data.driverId).toBeNull();
    expect(result.data.serviceIntervalMiles).toBe(FIRST_SERVICE_INTERVAL_MILES);
    expect(result.data.nextServiceType).toBe('pm_service');
  });

  it('still rejects a unit with no identity', () => {
    expect(CreateTruckSchema.safeParse({ ...identity, vin: 'SHORT' }).success).toBe(false);
    expect(CreateTruckSchema.safeParse({ ...identity, model: '' }).success).toBe(false);
    expect(CreateTruckSchema.safeParse({ ...identity, unitNumber: ' ' }).success).toBe(false);
  });

  it('validates the optional details when they are given', () => {
    expect(CreateTruckSchema.safeParse({ ...identity, plateState: 'ILL' }).success).toBe(false);
    expect(CreateTruckSchema.safeParse({ ...identity, inServiceDate: '2024-1-1' }).success).toBe(
      false,
    );
    expect(
      CreateTruckSchema.safeParse({
        ...identity,
        plate: 'P123456',
        plateState: 'IL',
        inServiceDate: '2024-01-01',
        homeTerminal: 'Dallas, TX',
      }).success,
    ).toBe(true);
  });
});

describe('UpdateTruckSchema', () => {
  it('lets the in-service date be filled in from the unit page', () => {
    const result = UpdateTruckSchema.safeParse({ inServiceDate: '2026-09-01' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.inServiceDate).toBe('2026-09-01');
  });
});
