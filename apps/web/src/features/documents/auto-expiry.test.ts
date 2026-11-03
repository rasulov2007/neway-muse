import { describe, expect, it } from 'vitest';
import { autoExpiryHint, autoExpiryReducer, type AutoExpiryState } from './auto-expiry';

const start = (code: string): AutoExpiryState => ({
  code,
  issuedOn: '',
  expiresOn: '',
  expiryTouched: false,
  filledMonths: null,
});

describe('issue date fills the expiry for fixed-term types', () => {
  it('fills +12 months for an annual inspection and says so', () => {
    const s = autoExpiryReducer(start('trailer_annual_inspection'), { type: 'issued', issuedOn: '2025-12-03' });
    expect(s.expiresOn).toBe('2026-12-03');
    expect(autoExpiryHint(s)).toBe(
      'Filled from the issue date (+12 months). Change it if the document says otherwise.',
    );
  });

  it('clamps a leap day', () => {
    const s = autoExpiryReducer(start('clearinghouse_query'), { type: 'issued', issuedOn: '2024-02-29' });
    expect(s.expiresOn).toBe('2025-02-28');
  });

  it('fills +6 months for an MVR and a PSP (owner, 2026-10-24)', () => {
    const mvr = autoExpiryReducer(start('mvr_review'), { type: 'issued', issuedOn: '2026-04-30' });
    expect(mvr.expiresOn).toBe('2026-10-30');
    expect(autoExpiryHint(mvr)).toMatch(/\+6 months/);
    const psp = autoExpiryReducer(start('psp_review'), { type: 'issued', issuedOn: '2026-08-31' });
    expect(psp.expiresOn).toBe('2027-02-28');
  });

  it('re-fills while untouched, and never after the expiry was typed', () => {
    let s = autoExpiryReducer(start('annual_inspection'), { type: 'issued', issuedOn: '2026-01-10' });
    s = autoExpiryReducer(s, { type: 'issued', issuedOn: '2026-02-10' });
    expect(s.expiresOn).toBe('2027-02-10');
    s = autoExpiryReducer(s, { type: 'expires', expiresOn: '2026-12-31' });
    expect(autoExpiryHint(s)).toBeNull();
    s = autoExpiryReducer(s, { type: 'issued', issuedOn: '2026-03-10' });
    expect(s.expiresOn).toBe('2026-12-31');
  });

  it('never fills a type without a fixed term', () => {
    const s = autoExpiryReducer(start('trailer_registration'), { type: 'issued', issuedOn: '2026-01-10' });
    expect(s.expiresOn).toBe('');
    expect(autoExpiryHint(s)).toBeNull();
  });

  it('fills when the type changes to a fixed-term one, and withdraws a filled value when it changes away', () => {
    let s = autoExpiryReducer(start('trailer_registration'), { type: 'issued', issuedOn: '2026-01-10' });
    s = autoExpiryReducer(s, { type: 'code', code: 'trailer_annual_inspection' });
    expect(s.expiresOn).toBe('2027-01-10');
    s = autoExpiryReducer(s, { type: 'code', code: 'trailer_insurance_card' });
    expect(s.expiresOn).toBe('');
  });

  it('leaves a typed expiry alone when the type changes', () => {
    let s = autoExpiryReducer(start('trailer_registration'), { type: 'expires', expiresOn: '2026-08-01' });
    s = autoExpiryReducer(s, { type: 'issued', issuedOn: '2026-01-10' });
    s = autoExpiryReducer(s, { type: 'code', code: 'trailer_annual_inspection' });
    expect(s.expiresOn).toBe('2026-08-01');
  });
});
