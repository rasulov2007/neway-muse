import { describe, expect, it } from 'vitest';
import { SYSTEM_REQUIREMENTS, requirementsFor, validityMonthsFor } from './catalog.js';
import { combineParts, partCodes, partsOf, reportAge } from './combined.js';
import { effectiveExpiresOn, evaluateEntity, evaluateItem } from './engine.js';
import type { ComplianceStatus, QualificationItem } from './item.js';

/** Owner requests of 2026-10-24: MVR/PSP every 6 months, CDL front + back, retired types. */

const driver = { id: 'drv_1', label: 'Ali Karimov' };
const req = (code: string) => {
  const r = SYSTEM_REQUIREMENTS.find((x) => x.code === code);
  if (!r) throw new Error(code);
  return r;
};
const item = (overrides: Partial<QualificationItem>): QualificationItem => ({
  id: 'qi_1',
  requirementCode: 'mvr_review',
  scope: 'driver',
  entityId: driver.id,
  entityLabel: driver.label,
  documentId: 'doc_1',
  issuedOn: null,
  expiresOn: null,
  verifiedAt: '2026-04-02T12:00:00.000Z',
  verifiedBy: 'Safety',
  verificationFailed: false,
  verificationNote: null,
  waivedUntil: null,
  waivedReason: null,
  notApplicable: false,
  notes: null,
  ...overrides,
});

describe('MVR and PSP fall due 6 months after their date', () => {
  it('both carry a 6-month term and expire', () => {
    for (const code of ['mvr_review', 'psp_review']) {
      expect(validityMonthsFor(code)).toBe(6);
      expect(req(code).hasExpiry).toBe(true);
    }
  });

  it('dates the due date from the report date, capping an older 12-month expiry', () => {
    // Filed when the term was 12 months: expiry stored as issue + 12.
    const legacy = item({ issuedOn: '2026-04-01', expiresOn: '2027-04-01' });
    expect(effectiveExpiresOn(req('mvr_review'), legacy)).toBe('2026-10-01');
    // A typed expiry earlier than the term is kept.
    expect(effectiveExpiresOn(req('mvr_review'), item({ issuedOn: '2026-04-01', expiresOn: '2026-07-01' }))).toBe('2026-07-01');
    // Month-end clamp: Aug 31 + 6 = Feb 28.
    expect(effectiveExpiresOn(req('psp_review'), item({ issuedOn: '2026-08-31' }))).toBe('2027-02-28');
  });

  it('falls back to the day the report was received when it carries no date', () => {
    const psp = item({ requirementCode: 'psp_review', receivedOn: '2026-03-15' });
    expect(effectiveExpiresOn(req('psp_review'), psp)).toBe('2026-09-15');
    // Without either date the stored expiry (if any) stands.
    expect(effectiveExpiresOn(req('psp_review'), item({ requirementCode: 'psp_review' }))).toBeNull();
  });

  it('reads expiring inside the run-up, expired once 6 months pass, like any expiring document', () => {
    const mvr = req('mvr_review');
    const fresh = item({ issuedOn: '2026-04-01', expiresOn: '2027-04-01' });
    expect(evaluateItem(mvr, fresh, driver, { today: '2026-07-01' }).status).toBe('verified');
    const soon = evaluateItem(mvr, fresh, driver, { today: '2026-09-10' });
    expect(soon.status).toBe('expiring');
    expect(soon.expiresOn).toBe('2026-10-01');
    expect(soon.requiredAction).toMatch(/Renew the MVR review before 2026-10-01/);
    const lapsed = evaluateItem(mvr, fresh, driver, { today: '2026-10-02' });
    expect(lapsed.status).toBe('expired');
    expect(lapsed.daysRemaining).toBe(-1);
    // A PSP that used to be one-off now ages too.
    const psp = evaluateItem(req('psp_review'), item({ requirementCode: 'psp_review', receivedOn: '2026-01-10' }), driver, {
      today: '2026-10-24',
    });
    expect(psp.status).toBe('expired');
    expect(psp.expiresOn).toBe('2026-07-10');
  });

  it('states the age of a report', () => {
    expect(reportAge('2026-04-24', '2026-10-24')?.label).toBe('6 months old');
    expect(reportAge('2026-04-25', '2026-10-24')?.months).toBe(5);
    expect(reportAge('2026-10-14', '2026-10-24')?.label).toBe('10 days old');
    expect(reportAge('2026-10-24', '2026-10-24')?.label).toBe('Dated today');
    expect(reportAge('nope', '2026-10-24')).toBeNull();
  });
});

describe('CDL is one item with a Front and a Back', () => {
  const ev = (code: string, status: ComplianceStatus) => ({ requirementCode: code, status });

  it('pairs the back with the CDL in the catalog', () => {
    expect(partsOf('cdl').map((r) => [r.code, r.partLabel])).toEqual([
      ['cdl', 'Front'],
      ['cdl_back', 'Back'],
    ]);
    expect([...partCodes()]).toEqual(['cdl_back']);
  });

  it('is complete only with both sides on file', () => {
    expect(combineParts('cdl', [ev('cdl', 'verified'), ev('cdl_back', 'pending_verification')]).complete).toBe(true);
    const frontOnly = combineParts('cdl', [ev('cdl', 'verified'), ev('cdl_back', 'missing')]);
    expect(frontOnly.complete).toBe(false);
    expect(frontOnly.missing).toEqual(['Back']);
    const backOnly = combineParts('cdl', [ev('cdl_back', 'verified')]);
    expect(backOnly.complete).toBe(false);
    expect(backOnly.missing).toEqual(['Front']);
    // A rejected side is not a side on file.
    expect(combineParts('cdl', [ev('cdl', 'verified'), ev('cdl_back', 'verification_failed')]).missing).toEqual(['Back']);
  });

  it('keeps the back graded on its own code, so existing backs read and holds do not change', () => {
    const rules = requirementsFor('driver');
    expect(rules.some((r) => r.code === 'cdl_back')).toBe(true);
    expect(req('cdl_back').holdEffect).toBe('none');
    const result = evaluateEntity({ scope: 'driver', ...driver }, rules.filter((r) => r.code === 'cdl' || r.code === 'cdl_back'), [
      item({ id: 'a', requirementCode: 'cdl', issuedOn: '2024-01-01', expiresOn: '2028-01-01' }),
    ], { today: '2026-10-24' });
    expect(result.items.find((i) => i.requirementCode === 'cdl_back')?.status).toBe('missing');
    // A missing back makes the file incomplete but never holds dispatch.
    expect(result.dispatchable).toBe(true);
  });
});

describe('retired and new types', () => {
  it('retires the driver photograph and the background check, keeping their rows', () => {
    for (const code of ['driver_photo', 'background_check']) {
      expect(req(code).active).toBe(false);
      expect(requirementsFor('driver').some((r) => r.code === code)).toBe(false);
    }
  });

  it('adds the random drug test as a driver document', () => {
    const r = req('random_drug_test');
    expect(r.scope).toBe('driver');
    expect(r.active).toBe(true);
    expect(r.documentOnly).toBe(true);
    // Not every driver is selected: it is never a missing item on the Safety board.
    expect(requirementsFor('driver').some((x) => x.code === 'random_drug_test')).toBe(false);
  });

  it('requires the NY sticker and the insurance cab card on every truck, with expiry, as a reminder that never holds it', () => {
    for (const code of ['ny_hut_sticker', 'insurance_cab_card']) {
      const r = req(code);
      expect(r.scope).toBe('truck');
      expect(r.active).toBe(true);
      expect(r.hasExpiry).toBe(true);
      // Graded, so a truck without one shows as missing (owner, 2026-10-24).
      expect(r.documentOnly ?? false).toBe(false);
      expect(r.holdEffect).toBe('advisory');
    }
  });
});
