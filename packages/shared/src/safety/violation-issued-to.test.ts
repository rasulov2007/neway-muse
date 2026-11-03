import { describe, expect, it } from 'vitest';
import {
  CreateViolationCaseSchema,
  issuedToFromParties,
  issuedToIncludes,
  issuedToLabel,
  issuedToParties,
  parseViolationIssuedTo,
  VIOLATION_ISSUED_TO,
} from './cases.js';

describe('Issued to: Driver, Carrier or both (owner, 2026-10-24)', () => {
  it('round-trips every stored value through the ticked parties', () => {
    for (const value of VIOLATION_ISSUED_TO) {
      expect(issuedToFromParties(issuedToParties(value))).toBe(value);
      expect(parseViolationIssuedTo(value)).toBe(value);
    }
    expect(issuedToFromParties([])).toBeNull();
    expect(issuedToParties(null)).toEqual([]);
  });

  it('reads the old single values exactly as before', () => {
    expect(parseViolationIssuedTo('driver')).toBe('driver');
    expect(parseViolationIssuedTo('carrier')).toBe('carrier');
    expect(parseViolationIssuedTo(null)).toBeNull();
    expect(parseViolationIssuedTo('')).toBeNull();
    expect(issuedToLabel('driver')).toBe('Driver');
    expect(issuedToLabel('carrier')).toBe('Carrier');
    expect(issuedToLabel(null)).toBe('—');
  });

  it('stores both as one word and names both parties', () => {
    expect(issuedToFromParties(['carrier', 'driver'])).toBe('both');
    expect(issuedToParties('both')).toEqual(['driver', 'carrier']);
    expect(issuedToIncludes('both', 'driver')).toBe(true);
    expect(issuedToIncludes('both', 'carrier')).toBe(true);
    expect(issuedToIncludes('driver', 'carrier')).toBe(false);
    expect(issuedToLabel('both')).toBe('Driver and Carrier');
  });

  it('reads a list written by hand or by an import', () => {
    expect(parseViolationIssuedTo('driver,carrier')).toBe('both');
    expect(parseViolationIssuedTo('Driver and Carrier')).toBe('both');
    expect(parseViolationIssuedTo('Carrier')).toBe('carrier');
    expect(parseViolationIssuedTo('somebody')).toBeNull();
  });

  it('the case form accepts both', () => {
    const parsed = CreateViolationCaseSchema.safeParse({
      occurredAt: '2026-10-24T16:00:00.000Z',
      violationType: 'inspection',
      issuedTo: 'both',
      lines: [{ description: 'Brake out of adjustment' }],
    });
    expect(parsed.success ? parsed.data.issuedTo : parsed.error.message).toBe('both');
  });
});
