import { describe, expect, it } from 'vitest';
import { PII_REQUIREMENTS, SENSITIVE_REQUIREMENTS } from '../compliance/records.js';
import { SYSTEM_REQUIREMENTS, isMandatoryRequirement, requirementsFor } from '../compliance/catalog.js';
import { HIRING_DOCUMENTS } from '../hiring/journey.js';
import {
  CreateDriverSchema,
  DRIVER_MAX_AGE,
  DRIVER_MIN_AGE,
  UpdateDriverSchema,
  ageOn,
  dateOfBirthIssue,
} from './roster.js';

/** Owner request of 2026-10-25: date of birth on the driver, W-9 in the driver's documents. */

describe('driver date of birth', () => {
  const today = '2026-10-25';

  it('counts whole years on calendar days, with no time zone involved', () => {
    expect(ageOn('2000-10-25', today)).toBe(26);
    expect(ageOn('2000-10-26', today)).toBe(25);
    // A 29 February birthday turns a year older on 1 March in a common year.
    expect(ageOn('2008-02-29', '2027-02-28')).toBe(18);
    expect(ageOn('2008-02-29', '2027-03-01')).toBe(19);
    expect(ageOn('2026-02-30', today)).toBeNull();
  });

  it('accepts 18 to 100 and refuses the future, under 18, over 100 and non-dates', () => {
    expect(DRIVER_MIN_AGE).toBe(18);
    expect(DRIVER_MAX_AGE).toBe(100);
    expect(dateOfBirthIssue('2008-10-25', today)).toBeNull(); // 18 today
    expect(dateOfBirthIssue('1926-10-25', today)).toBeNull(); // 100 today
    expect(dateOfBirthIssue('1987-04-12', today)).toBeNull();
    expect(dateOfBirthIssue('2026-10-26', today)).toBe('Date of birth cannot be in the future');
    expect(dateOfBirthIssue('2008-10-26', today)).toBe('A driver must be at least 18 years old');
    expect(dateOfBirthIssue('1925-10-24', today)).toMatch(/over 100/);
    expect(dateOfBirthIssue('1990-13-01', today)).toBe('Date of birth is not a valid date');
  });

  it('is optional on create and edit, and the wire takes only a real YYYY-MM-DD day', () => {
    const base = {
      firstName: 'Ali',
      lastName: 'Karimov',
      phone: '+1 312 555 0142',
      email: 'ali@example.com',
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlEndorsements: [],
      cdlExpiresOn: '2028-01-01',
      hireDate: '2026-10-25',
      homeCity: 'Chicago',
      homeState: 'IL',
      payPlan: { kind: 'per_mile', rate: 0.6 },
      preferredLanguage: 'en',
    };
    expect(CreateDriverSchema.safeParse(base).success).toBe(true);
    expect(CreateDriverSchema.safeParse({ ...base, dateOfBirth: null }).success).toBe(true);
    expect(CreateDriverSchema.safeParse({ ...base, dateOfBirth: '1987-04-12' }).success).toBe(true);
    expect(CreateDriverSchema.safeParse({ ...base, dateOfBirth: '04/12/1987' }).success).toBe(false);
    expect(CreateDriverSchema.safeParse({ ...base, dateOfBirth: '1987-02-30' }).success).toBe(false);
    const edit = UpdateDriverSchema.safeParse({ dateOfBirth: '1987-04-12', expectedUpdatedAt: '2026-10-25T12:00:00.000Z' });
    expect(edit.success).toBe(true);
    if (edit.success) expect(edit.data.expectedUpdatedAt).toBe('2026-10-25T12:00:00.000Z');
  });
});

describe('W-9 driver document', () => {
  const w9 = SYSTEM_REQUIREMENTS.find((r) => r.code === 'w9');

  it('is a document-only driver paper with no expiry that never holds', () => {
    expect(w9).toBeDefined();
    expect(w9?.name).toBe('W-9');
    expect(w9?.scope).toBe('driver');
    expect(w9?.active).toBe(true);
    expect(w9?.hasExpiry).toBe(false);
    expect(w9?.documentOnly).toBe(true);
    expect(w9?.holdEffect).toBe('none');
    expect(w9?.requiresVerification).toBe(false);
    expect(w9 && isMandatoryRequirement(w9)).toBe(false);
    // Not graded: a driver without one is never missing it on the Safety board.
    expect(requirementsFor('driver').some((r) => r.code === 'w9')).toBe(false);
  });

  it('holds a taxpayer ID, so its file is restricted and marked personal', () => {
    expect(SENSITIVE_REQUIREMENTS.has('w9')).toBe(true);
    expect(PII_REQUIREMENTS.has('w9')).toBe(true);
  });

  it('is listed among the hiring papers as optional', () => {
    expect(HIRING_DOCUMENTS.find((d) => d.code === 'w9')).toMatchObject({ label: 'W-9', timing: 'optional' });
  });
});
