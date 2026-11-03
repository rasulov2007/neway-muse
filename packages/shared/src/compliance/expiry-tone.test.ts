import { describe, expect, it } from 'vitest';
import { addMonthsClamped } from '../dates.js';
import { SYSTEM_REQUIREMENTS, validityMonthsFor } from './catalog.js';
import { expiryTone } from './expiry-tone.js';

describe('addMonthsClamped', () => {
  it('moves a plain date by calendar months', () => {
    expect(addMonthsClamped('2026-10-08', 12)).toBe('2027-10-08');
    expect(addMonthsClamped('2026-10-08', 3)).toBe('2027-01-08');
    expect(addMonthsClamped('2026-01-15', -1)).toBe('2025-12-15');
  });

  it('clamps a leap day to the end of February', () => {
    expect(addMonthsClamped('2024-02-29', 12)).toBe('2025-02-28');
    expect(addMonthsClamped('2024-02-29', 48)).toBe('2028-02-29');
  });

  it('clamps the 31st to the end of a shorter month', () => {
    expect(addMonthsClamped('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonthsClamped('2028-01-31', 1)).toBe('2028-02-29');
    expect(addMonthsClamped('2026-03-31', 1)).toBe('2026-04-30');
  });

  it('refuses a value that is not a date', () => {
    expect(() => addMonthsClamped('10/08/2026', 1)).toThrow();
  });
});

describe('expiryTone — calendar-month bands from Eastern today', () => {
  const today = '2026-10-08';

  it('reads no date as no expiry', () => {
    expect(expiryTone(null, today)).toEqual({ tone: 'none', daysLeft: null, label: 'No expiry' });
  });

  it('is expired from the day after the expiry date', () => {
    expect(expiryTone('2026-10-07', today)).toEqual({ tone: 'expired', daysLeft: -1, label: 'Expired' });
  });

  it('is still valid on its expiry date: "Expires today", in the danger band', () => {
    expect(expiryTone('2026-10-08', today)).toEqual({ tone: 'danger', daysLeft: 0, label: 'Expires today' });
    expect(expiryTone('2026-10-09', today).label).toBe('Expires in 1 day');
  });

  it('is danger up to and including one calendar month out', () => {
    expect(expiryTone('2026-11-08', today)).toEqual({ tone: 'danger', daysLeft: 31, label: 'Expires in 31 days' });
    expect(expiryTone('2026-11-09', today).tone).toBe('warning');
  });

  it('is warning up to and including two calendar months out', () => {
    expect(expiryTone('2026-12-08', today).tone).toBe('warning');
    expect(expiryTone('2026-12-09', today).tone).toBe('info');
  });

  it('is info up to and including three calendar months out', () => {
    expect(expiryTone('2027-01-08', today)).toMatchObject({ tone: 'info', label: 'Expires in 92 days' });
    expect(expiryTone('2027-01-09', today)).toEqual({ tone: 'normal', daysLeft: 93, label: 'Valid' });
  });

  it('measures months by the calendar at a month end', () => {
    // One month after Jan 31 is Feb 28, so Mar 1 is already the warning band.
    expect(expiryTone('2026-02-28', '2026-01-31').tone).toBe('danger');
    expect(expiryTone('2026-03-01', '2026-01-31').tone).toBe('warning');
  });
});

describe('validityMonthsFor', () => {
  it('gives a fixed term only to the fixed-term types', () => {
    const withValidity = SYSTEM_REQUIREMENTS.filter((r) => r.validityMonths).map((r) => r.code);
    expect(withValidity.sort()).toEqual(
      ['annual_inspection', 'clearinghouse_query', 'mvr_review', 'psp_review', 'trailer_annual_inspection'].sort(),
    );
    // MVR and PSP every 6 months (owner, 2026-10-24); inspections and the Clearinghouse yearly.
    expect(validityMonthsFor('mvr_review')).toBe(6);
    expect(validityMonthsFor('psp_review')).toBe(6);
    expect(validityMonthsFor('clearinghouse_query')).toBe(12);
    expect(validityMonthsFor('trailer_annual_inspection')).toBe(12);
    expect(validityMonthsFor('registration')).toBeNull();
    expect(validityMonthsFor('medical_card')).toBeNull();
    expect(validityMonthsFor('nonsense')).toBeNull();
  });
});
