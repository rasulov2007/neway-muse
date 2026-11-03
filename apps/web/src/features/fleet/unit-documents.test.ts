import { describe, expect, it } from 'vitest';
import type { ComplianceDocument } from '@neway/shared';
import {
  defaultDocumentRule,
  documentExpiryStatus,
  documentTypesFor,
  unitDocumentIssues,
  worstExpiryTone,
} from './unit-documents';

function doc(
  over: Partial<ComplianceDocument> & { id: string; requirementCode: string },
): ComplianceDocument {
  return {
    ownerType: 'truck',
    ownerId: 'trk_1',
    ownerLabel: 'Unit 1',
    extracted: null,
    title: over.requirementCode,
    fileName: 'f.pdf',
    contentType: 'application/pdf',
    sizeBytes: 1,
    issuedOn: null,
    expiresOn: null,
    status: 'pending_review',
    source: 'staff',
    uploadedAt: '2026-09-01T00:00:00.000Z',
    uploadedBy: 'Test',
    verifiedAt: null,
    verifiedBy: null,
    rejectionReason: null,
    version: 1,
    supersedesDocumentId: null,
    containsPii: false,
    hasFile: true,
    ...over,
  };
}

describe('document expiry status', () => {
  const today = '2026-09-15';
  it('reads valid, expiring (within three calendar months), expired and no expiry off the date alone', () => {
    expect(documentExpiryStatus({ expiresOn: null }, today)).toBe('no_expiry');
    expect(documentExpiryStatus({ expiresOn: '2027-01-01' }, today)).toBe('valid');
    expect(documentExpiryStatus({ expiresOn: '2026-12-16' }, today)).toBe('valid');
    expect(documentExpiryStatus({ expiresOn: '2026-12-15' }, today)).toBe('expiring');
    expect(documentExpiryStatus({ expiresOn: '2026-10-15' }, today)).toBe('expiring');
    expect(documentExpiryStatus({ expiresOn: '2026-09-15' }, today)).toBe('expiring');
    expect(documentExpiryStatus({ expiresOn: '2026-09-14' }, today)).toBe('expired');
  });

  it('carries the shared expiry band on every issue, and the worst band wins', () => {
    const issues = unitDocumentIssues(
      [
        doc({ id: 'reg', requirementCode: 'registration', expiresOn: '2026-12-01' }),
        doc({ id: 'ifta', requirementCode: 'ifta_license', expiresOn: '2026-10-01' }),
      ],
      'truck',
      {},
      today,
    );
    expect(issues.expiring.map((i) => [i.document.id, i.expiry.tone])).toEqual([
      ['reg', 'info'],
      ['ifta', 'danger'],
    ]);
    expect(worstExpiryTone(issues.expiring.map((i) => i.expiry.tone))).toBe('danger');
    expect(issues.expiring[1]?.expiry.label).toBe('Expires in 16 days');
  });

  it('judges only the newest version of each type, ignores rejected files, and holds dispatch per the rule', () => {
    const issues = unitDocumentIssues(
      [
        doc({ id: 'old', requirementCode: 'registration', expiresOn: '2025-01-01', version: 1 }),
        doc({ id: 'new', requirementCode: 'registration', expiresOn: '2027-01-01', version: 2 }),
        doc({ id: 'insp', requirementCode: 'annual_inspection', expiresOn: '2026-09-01' }),
        doc({ id: 'ifta', requirementCode: 'ifta_license', expiresOn: '2026-10-01' }),
        doc({
          id: 'bad',
          requirementCode: 'insurance_cab_card',
          expiresOn: '2020-01-01',
          status: 'rejected',
        }),
      ],
      'truck',
      {},
      today,
    );
    expect(issues.expired.map((i) => i.document.id)).toEqual(['insp']);
    expect(issues.expiring.map((i) => i.document.id)).toEqual(['ifta']);
    expect(issues.expired[0]?.blocks).toBe(true);
    expect(issues.hold).toMatch(/Annual DOT inspection expired — dispatch is held/);

    const warned = unitDocumentIssues(
      [doc({ id: 'insp', requirementCode: 'annual_inspection', expiresOn: '2026-09-01' })],
      'truck',
      { annual_inspection: 'warn' },
      today,
    );
    expect(warned.expired[0]?.blocks).toBe(false);
    expect(warned.hold).toBeNull();
  });

  it('ships the catalog with the paperwork a unit actually carries, and the regulatory ones block by default', () => {
    const truck = documentTypesFor('truck').map((r) => r.code);
    expect(truck).toEqual(
      expect.arrayContaining([
        'registration',
        'title',
        'annual_inspection',
        'ifta_license',
        'lease_agreement',
        'permit',
        'warranty',
        'bill_of_sale',
        // Owner, 2026-10-24: the NY HUT sticker and the insurance cab card, each with an expiry.
        'ny_hut_sticker',
        'insurance_cab_card',
      ]),
    );
    const nyAndCab = documentTypesFor('truck').filter((r) => ['ny_hut_sticker', 'insurance_cab_card'].includes(r.code));
    expect(nyAndCab.map((r) => [r.name, r.hasExpiry, defaultDocumentRule(r)])).toEqual([
      ['Insurance cab card', true, 'warn'],
      ['NY sticker', true, 'warn'],
    ]);
    const trailer = documentTypesFor('trailer').map((r) => r.code);
    expect(trailer).toEqual(
      expect.arrayContaining([
        'trailer_registration',
        'trailer_title',
        'trailer_annual_inspection',
        'trailer_insurance_card',
        'trailer_lease_agreement',
      ]),
    );
    expect(defaultDocumentRule({ holdEffect: 'unit_hold' })).toBe('block');
    expect(defaultDocumentRule({ holdEffect: 'advisory' })).toBe('warn');
    expect(defaultDocumentRule({ holdEffect: 'none' })).toBe('warn');
  });
});
