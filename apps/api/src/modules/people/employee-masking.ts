import type { EmployeePage, EmployeeRecord } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { PERSONNEL_DOCUMENT_PERMISSIONS } from '../../common/auth/signed-download';

/**
 * Compensation on an employee record reaches `employees.view_financial` only (owner brief,
 * 2026-10-25, finding 2). The pay type and rate ride on every EmployeeRecord - the list, the
 * profile, the answer to an edit - so they are removed here, on the way out, rather than trusted
 * to a screen that hides a column.
 *
 * The date of birth and passport / ID number (2026-10-26) follow the same rule as a driver's date
 * of birth: Safety (compliance_sensitive.view, safety_testing.view), the HR / recruiting manager
 * (recruiting.manage) and the administrator. Everybody else gets null and `personalMasked: true`.
 */
const PAY_FIELDS = new Set(['payType', 'payRate']);
const PERSONAL_FIELDS = new Set(['dateOfBirth', 'idNumber']);

export function seesPay(principal: Principal): boolean {
  return hasPermission(principal, 'employees.view_financial');
}

export function seesPersonal(principal: Principal): boolean {
  return PERSONNEL_DOCUMENT_PERMISSIONS.some((code) => hasPermission(principal, code));
}

export function maskEmployee(principal: Principal, record: EmployeeRecord): EmployeeRecord {
  const pay = seesPay(principal);
  const personal = seesPersonal(principal);
  if (pay && personal) return record;
  let out = record;
  if (!pay) out = { ...out, payType: null, payRate: null };
  if (!personal) out = { ...out, dateOfBirth: null, idNumber: null, personalMasked: true };
  return out;
}

export function maskEmployeePage(principal: Principal, page: EmployeePage): EmployeePage {
  if (seesPay(principal) && seesPersonal(principal)) return page;
  return { ...page, data: page.data.map((r) => maskEmployee(principal, r)) };
}

export interface ActivityEntry {
  summary: string;
  changes: { field: string; old: string | null; new: string | null }[];
}

/** An audit line about pay keeps the fact that pay changed, not the figures; same for personal data. */
export function maskActivity<T extends ActivityEntry>(principal: Principal, entry: T): T {
  const hide = new Set<string>();
  if (!seesPay(principal)) for (const f of PAY_FIELDS) hide.add(f);
  if (!seesPersonal(principal)) for (const f of PERSONAL_FIELDS) hide.add(f);
  const touched = (entry.changes ?? []).filter((c) => hide.has(c.field));
  if (touched.length === 0) return entry;
  const quotes = touched.some((c) => [c.old, c.new].some((v) => v && entry.summary.includes(v)));
  const touchesPay = touched.some((c) => PAY_FIELDS.has(c.field));
  return {
    ...entry,
    summary: touchesPay ? 'Compensation changed' : quotes ? 'Personal details changed' : entry.summary,
    changes: entry.changes.map((c) => (hide.has(c.field) ? { ...c, old: null, new: null } : c)),
  };
}
