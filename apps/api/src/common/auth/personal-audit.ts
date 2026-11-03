import { hasPermission, type Principal } from './principal';
import { PERSONNEL_DOCUMENT_PERMISSIONS } from './signed-download';

/**
 * Personal data in audit lines (owner, 2026-10-25).
 *
 * The audit log records the before and after of every field a person changed, so a driver's date
 * of birth, phone number, licence dates and pay plan, and an employee's pay, ride along in it. A
 * reader of the log sees those values only when they could read the field on the record itself;
 * otherwise the line says the field changed and shows neither value.
 */
const anyOf = (principal: Principal, codes: readonly string[]) => codes.some((code) => hasPermission(principal, code));

type Rule = (principal: Principal) => boolean;

const DRIVER_FIELDS: Record<string, Rule> = {
  dateOfBirth: (p) => anyOf(p, PERSONNEL_DOCUMENT_PERMISSIONS),
  phone: (p) => hasPermission(p, 'drivers.view_contact'),
  secondaryPhone: (p) => hasPermission(p, 'drivers.view_contact'),
  email: (p) => hasPermission(p, 'drivers.view_contact'),
  homeCity: (p) => hasPermission(p, 'drivers.view_contact'),
  homeState: (p) => hasPermission(p, 'drivers.view_contact'),
  cdlState: (p) => hasPermission(p, 'drivers.view_licence'),
  cdlExpiresOn: (p) => hasPermission(p, 'drivers.view_licence'),
  medicalCardExpiresOn: (p) => hasPermission(p, 'drivers.view_licence'),
  payPlan: (p) => hasPermission(p, 'drivers.view_pay'),
  payPlanKind: (p) => hasPermission(p, 'drivers.view_pay'),
  payPlanRate: (p) => hasPermission(p, 'drivers.view_pay'),
};

const EMPLOYEE_FIELDS: Record<string, Rule> = {
  payType: (p) => hasPermission(p, 'employees.view_financial'),
  payRate: (p) => hasPermission(p, 'employees.view_financial'),
  // 2026-10-26: an employee's date of birth and passport / ID number, like a driver's date of birth.
  dateOfBirth: (p) => anyOf(p, PERSONNEL_DOCUMENT_PERMISSIONS),
  idNumber: (p) => anyOf(p, PERSONNEL_DOCUMENT_PERMISSIONS),
};

const BY_ENTITY: Record<string, Record<string, Rule>> = { driver: DRIVER_FIELDS, employee: EMPLOYEE_FIELDS };

export interface AuditLineLike {
  entityType: string;
  summary: string;
  changes: { field: string; old: string | null; new: string | null }[];
}

export function redactPersonalAuditLine<T extends AuditLineLike>(principal: Principal, line: T): T {
  const rules = BY_ENTITY[line.entityType];
  if (!rules || !Array.isArray(line.changes)) return line;
  let hidden = false;
  const changes = line.changes.map((c) => {
    const rule = rules[c.field] ?? (c.field.startsWith('payPlan') ? rules.payPlan : undefined);
    if (!rule || rule(principal)) return c;
    hidden = true;
    return { ...c, old: null, new: null };
  });
  if (!hidden) return line;
  // A summary that quotes a hidden value is replaced by one that does not.
  const quotes = line.changes.some((c) => {
    const rule = rules[c.field];
    return rule && !rule(principal) && [c.old, c.new].some((v) => v && line.summary.includes(v));
  });
  return { ...line, changes, summary: quotes ? 'Personal details changed' : line.summary };
}
