import type { DriverRecord } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { PERSONNEL_DOCUMENT_PERMISSIONS } from '../../common/auth/signed-download';

/**
 * Driver PII, narrowed on the server (owner brief, 2026-10-25, finding 5).
 *
 * The roster lists feed pickers on nearly every page, so who may OPEN them is wide
 * (roster-access.ts). What each reader then sees of a driver is decided here, per field group:
 *
 *   drivers.view_contact  phone, second phone, email, home city / state
 *   drivers.view_licence  CDL state / class / endorsements / expiry date, medical card date
 *   drivers.view_pay      the pay plan (kind and rate)
 *
 * Safety and HR hold all three; Operations and Dispatch hold contact; Accounting holds pay;
 * everybody else gets the masked copy: phone and email reduced to their last characters, licence
 * and medical dates removed (the verified / expiring / expired statuses stay, because dispatch
 * must not send a driver whose card has lapsed), pay hidden.
 *
 * Writes mirror it: a field group the caller cannot see is dropped from an update, so saving a form
 * that was filled from a masked copy never overwrites the real values.
 */
export const DRIVER_PII_CODES = {
  contact: 'drivers.view_contact',
  licence: 'drivers.view_licence',
  pay: 'drivers.view_pay',
} as const;

export interface DriverPiiReach {
  contact: boolean;
  licence: boolean;
  pay: boolean;
  /**
   * The date of birth (owner, 2026-10-25): stricter than the licence group - Safety
   * (compliance_sensitive.view, safety_testing.view), the HR / recruiting manager and the
   * administrator only.
   */
  birth: boolean;
}

export function driverPiiReach(principal: Principal): DriverPiiReach {
  return {
    contact: hasPermission(principal, DRIVER_PII_CODES.contact),
    licence: hasPermission(principal, DRIVER_PII_CODES.licence),
    pay: hasPermission(principal, DRIVER_PII_CODES.pay),
    birth: PERSONNEL_DOCUMENT_PERMISSIONS.some((code) => hasPermission(principal, code)),
  };
}

/** `(555) 123-4567` → `***-***-4567`. Empty stays empty. */
export function maskPhone(phone: string | null | undefined): string | null {
  if (phone === null || phone === undefined) return phone ?? null;
  const digits = phone.replace(/\D/g, '');
  if (digits.length === 0) return '';
  return `***-***-${digits.slice(-4)}`;
}

/** `jane.doe@example.com` → `j***@example.com`. */
export function maskEmail(email: string | null | undefined): string {
  if (!email) return '';
  const at = email.indexOf('@');
  if (at <= 0) return '***';
  return `${email[0]}***${email.slice(at)}`;
}

const CONTACT_FIELDS = ['phone', 'secondaryPhone', 'secondaryPhoneLabel', 'email', 'homeCity', 'homeState'] as const;
const LICENCE_FIELDS = ['cdlState', 'cdlClass', 'cdlEndorsements', 'cdlExpiresOn', 'medicalCardExpiresOn'] as const;
const PAY_FIELDS = ['payPlan'] as const;

export function maskDriver(principal: Principal, driver: DriverRecord): DriverRecord {
  const reach = driverPiiReach(principal);
  if (reach.contact && reach.licence && reach.pay && reach.birth) return driver;
  const out = { ...driver } as DriverRecord & Record<string, unknown>;
  if (!reach.contact) {
    out.phone = maskPhone(driver.phone) ?? '';
    if (driver.secondaryPhone !== undefined) out.secondaryPhone = maskPhone(driver.secondaryPhone);
    out.email = maskEmail(driver.email);
    out.homeCity = '';
    out.homeState = '';
  }
  if (!reach.licence) {
    // The schema keeps these strings; an empty value reads as "not shown" on every screen.
    out.cdlState = '';
    out.cdlEndorsements = [];
    out.cdlExpiresOn = '';
    out.medicalCardExpiresOn = null;
  }
  if (!reach.birth && 'dateOfBirth' in out) out.dateOfBirth = null;
  if (!reach.pay) {
    out.payPlan = { kind: driver.payPlan.kind, rate: 0 };
  }
  return out;
}

export function maskDriverPage<P extends { data: DriverRecord[] }>(principal: Principal, page: P): P {
  return { ...page, data: page.data.map((d) => maskDriver(principal, d)) };
}

/** An update without the field groups the caller cannot see (the stored values stay). */
export function withoutHiddenDriverFields<T extends Record<string, unknown>>(principal: Principal, patch: T): T {
  const reach = driverPiiReach(principal);
  const out: Record<string, unknown> = { ...patch };
  if (!reach.contact) for (const f of CONTACT_FIELDS) delete out[f];
  if (!reach.licence) for (const f of LICENCE_FIELDS) delete out[f];
  if (!reach.pay) for (const f of PAY_FIELDS) delete out[f];
  if (!reach.birth) delete out.dateOfBirth;
  return out as T;
}

/** Vacation rows carry the driver's phone for the return call. */
export function maskVacationPhone<V extends { phone: string | null }>(principal: Principal, row: V): V {
  return driverPiiReach(principal).contact ? row : { ...row, phone: maskPhone(row.phone) };
}
