import { describe, expect, it } from 'vitest';
import { HiringDocumentUploadSchema } from '../hiring/journey.js';
import { UploadComplianceDocumentSchema } from './records.js';
import {
  WORK_AUTHORIZATION_KINDS,
  WORK_AUTHORIZATION_KIND_LABELS,
  workAuthorizationKindOf,
} from './work-authorization.js';

/** Which paper a Work authorization is (owner, 2026-10-26). */
describe('work authorization kind', () => {
  it('has exactly the four options the owner listed', () => {
    expect(WORK_AUTHORIZATION_KINDS.map((k) => WORK_AUTHORIZATION_KIND_LABELS[k])).toEqual([
      'U.S. Passport / Passport Card',
      'Permanent Resident Card (Green Card)',
      'Employment Authorization',
      'Non-Domiciled',
    ]);
  });

  const upload = {
    ownerType: 'driver',
    ownerId: 'drv_1',
    ownerLabel: 'Ali',
    requirementCode: 'work_authorization',
    title: 'Work authorization',
    fileName: 'gc.pdf',
    contentType: 'application/pdf',
    sizeBytes: 10,
    issuedOn: null,
    expiresOn: '2030-01-15',
  };

  it('travels on the upload in the document reading, and an unknown kind is refused', () => {
    const parsed = UploadComplianceDocumentSchema.parse({ ...upload, extracted: { workAuthorizationKind: 'green_card' } });
    expect(parsed.extracted?.workAuthorizationKind).toBe('green_card');
    expect(UploadComplianceDocumentSchema.safeParse({ ...upload, extracted: { workAuthorizationKind: 'visa' } }).success).toBe(false);
    // A licence reading without it still parses.
    expect(UploadComplianceDocumentSchema.parse({ ...upload, requirementCode: 'cdl', extracted: { cdlNumber: 'X1' } }).extracted?.workAuthorizationKind).toBeUndefined();
  });

  it('is accepted on the HR upload', () => {
    const parsed = HiringDocumentUploadSchema.parse({
      requirementCode: 'work_authorization',
      title: 'Work authorization',
      fileName: 'p.pdf',
      contentType: 'application/pdf',
      sizeBytes: 10,
      content: 'JVBERi0=',
      workAuthorizationKind: 'us_passport',
    });
    expect(parsed.workAuthorizationKind).toBe('us_passport');
  });

  it('reads the kind off a Work authorization document only', () => {
    expect(workAuthorizationKindOf({ requirementCode: 'work_authorization', extracted: { workAuthorizationKind: 'non_domiciled' } })).toBe('non_domiciled');
    expect(workAuthorizationKindOf({ requirementCode: 'cdl', extracted: { workAuthorizationKind: 'non_domiciled' } })).toBeNull();
    expect(workAuthorizationKindOf({ requirementCode: 'work_authorization', extracted: null })).toBeNull();
    expect(workAuthorizationKindOf(null)).toBeNull();
  });
});
