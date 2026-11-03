import { PII_REQUIREMENTS, SENSITIVE_REQUIREMENTS, type ComplianceDocument, type QualificationItem } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';

/**
 * Restricted qualification records (owner, 2026-10-02).
 *
 * MVR, PSP, Clearinghouse, medical, pre-employment drug-test and W-9 records keep their status and
 * dates for everybody who reads the file — dispatch needs to know a driver is cleared — but the
 * file, its name, what was read off it and the reviewer's notes go only to callers holding
 * `compliance_sensitive.view`. The server redacts; the screen merely draws what it is given.
 */
export function seesSensitive(principal: Principal): boolean {
  return hasPermission(principal, 'compliance_sensitive.view');
}

export function isSensitive(requirementCode: string): boolean {
  return SENSITIVE_REQUIREMENTS.has(requirementCode) || PII_REQUIREMENTS.has(requirementCode);
}

/**
 * Who may read a driver's or candidate's personnel document (owner, 2026-10-25): Safety
 * (compliance_sensitive.view, safety_testing.view), the HR / recruiting manager (recruiting.manage)
 * and the administrator. Accounting reads the W-9 alone (driver_tax_forms.view, for 1099s). Applies to
 * the CDL, medical card, work authorisation, background check, DOT application, MVR, PSP,
 * Clearinghouse, drug test and W-9 records - their file, its name and what was read off it.
 */
export const PERSONNEL_RECORD_PERMISSIONS = ['compliance_sensitive.view', 'safety_testing.view', 'recruiting.manage'] as const;
export const W9_PERMISSION = 'driver_tax_forms.view';

export function seesRecord(principal: Principal, requirementCode: string): boolean {
  if (!isSensitive(requirementCode)) return true;
  if (PERSONNEL_RECORD_PERMISSIONS.some((code) => hasPermission(principal, code))) return true;
  return requirementCode === 'w9' && hasPermission(principal, W9_PERMISSION);
}

export function redactItems(principal: Principal, items: QualificationItem[]): QualificationItem[] {
  return items.map((i) =>
    !seesRecord(principal, i.requirementCode)
      ? { ...i, notes: i.notes ? 'Restricted' : null, verificationNote: i.verificationNote ? 'Restricted' : null }
      : i,
  );
}

export function redactDocuments(principal: Principal, documents: ComplianceDocument[]): ComplianceDocument[] {
  return documents.map((d) =>
    !seesRecord(principal, d.requirementCode)
      ? { ...d, fileName: 'Restricted', extracted: null, rejectionReason: d.rejectionReason ? 'Restricted' : null }
      : d,
  );
}
