import { z } from 'zod';
import { dateOfBirthIssue } from '@neway/shared';
import { today as easternToday } from '@/lib/clock';

/**
 * Adding a driver.
 *
 * The two credential dates are required because they open the qualification file. A driver without
 * a CDL or medical expiry on record cannot be judged by the compliance engine at all, and a driver
 * the engine cannot judge is one nobody notices going out of date.
 *
 * Everything else safety needs — the documents themselves, MVR, PSP, drug screen, background check
 * — is collected afterwards in Safety, which is why this form does not ask for it. The new hire
 * appears there immediately with those requirements missing.
 */

export const DRIVER_TYPES = [
  { value: 'company', label: 'Company driver' },
  { value: 'owner_operator', label: 'Owner-operator' },
  { value: 'lease_operator', label: 'Lease operator' },
] as const;

export const CDL_CLASSES = [
  { value: 'A', label: 'Class A' },
  { value: 'B', label: 'Class B' },
] as const;

export const ENDORSEMENTS = [
  { value: 'H', label: 'H — Hazmat' },
  { value: 'N', label: 'N — Tanker' },
  { value: 'T', label: 'T — Doubles/triples' },
  { value: 'X', label: 'X — Hazmat and tanker' },
] as const;

export const PAY_KINDS = [
  { value: 'per_mile', label: 'Per mile' },
  { value: 'percent_of_linehaul', label: 'Percent of linehaul' },
  { value: 'lease_owner', label: 'Lease owner' },
  { value: 'lease_to_own', label: 'Leasing to owner' },
  { value: 'owner_truck', label: 'Owner truck' },
] as const;

/** Paid the gross less the lease sheet's charges (owner, 2026-10-12): no rate on this form. */
export const LEASE_PAY_KINDS = new Set(['lease_owner', 'lease_to_own', 'owner_truck']);

export const SECONDARY_PHONE_LABELS = [
  { value: 'cell', label: 'Cell' },
  { value: 'home', label: 'Home' },
  { value: 'spouse', label: 'Spouse' },
  { value: 'dispatch_only', label: 'Dispatch only' },
] as const;

export const LANGUAGES = [
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Spanish' },
  { value: 'ru', label: 'Russian' },
  { value: 'uz', label: 'Uzbek' },
] as const;

const requiredText = (field: string) => z.string().trim().min(1, `${field} is required`);

const stateCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{2}$/, 'Use the two-letter state code');

/** `YYYY-MM-DD`, and the date must actually parse. */
const isoDate = (field: string) =>
  z
    .string()
    .trim()
    .min(1, `${field} is required`)
    .refine((value) => !Number.isNaN(Date.parse(value)), {
      message: `${field} is not a valid date`,
    });

export const driverFormSchema = z
  .object({
    firstName: requiredText('First name'),
    lastName: requiredText('Last name'),
    phone: requiredText('Phone').regex(
      /^[+\d(][\d\s()-]{6,}$/,
      'Enter a phone number the driver can be reached on',
    ),
    /** Optional second number; when given it must look like a phone number. */
    secondaryPhone: z
      .string()
      .trim()
      .refine((value) => value === '' || /^[+\d(][\d\s()-]{6,}$/.test(value), {
        message: 'Enter a phone number, or leave it empty',
      }),
    secondaryPhoneLabel: z.enum(['', 'cell', 'home', 'spouse', 'dispatch_only']),
    email: z.string().trim().email('Enter a valid email address'),
    driverType: z.enum(['company', 'owner_operator', 'lease_operator']),
    cdlState: stateCode,
    cdlClass: z.enum(['A', 'B']),
    cdlEndorsements: z.array(z.string()),
    cdlExpiresOn: isoDate('CDL expiry'),
    /** Recruiting collects the DOT medical card (owner, 2026-10-12); kept for edits that have it. */
    medicalCardExpiresOn: z.string().trim().optional(),
    /**
     * Optional (owner, 2026-10-25): `YYYY-MM-DD`, or empty when not known. Checked on the field
     * itself, so the message shows as soon as the date is picked, against the Eastern today.
     */
    dateOfBirth: z
      .string()
      .trim()
      .optional()
      .superRefine((value, ctx) => {
        const issue = value ? dateOfBirthIssue(value, easternToday()) : null;
        if (issue) ctx.addIssue({ code: 'custom', message: issue });
      }),
    hireDate: isoDate('Hire date'),
    homeCity: requiredText('Home city'),
    homeState: stateCode,
    /** Optional (owner, 2026-10-12): chosen later from the driver profile or the board. */
    dispatcherId: z.string().trim(),
    /** The unit they take, when one is free. Optional: most drivers are paired later. */
    truckId: z.string().optional(),
    payKind: z.enum(['per_mile', 'percent_of_linehaul', 'lease_owner', 'lease_to_own', 'owner_truck']),
    payRate: z.coerce.number().min(0),
    preferredLanguage: z.enum(['en', 'es', 'ru', 'uz', 'uk']),
  })
  .superRefine((values, ctx) => {
    // A credential that has already lapsed is almost always a typo; the engine would otherwise
    // book the new hire straight into an expired state.
    const today = new Date().toISOString().slice(0, 10);
    if (values.cdlExpiresOn < today) {
      ctx.addIssue({
        code: 'custom',
        path: ['cdlExpiresOn'],
        message: 'This CDL has already expired. Check the date.',
      });
    }
    if (!LEASE_PAY_KINDS.has(values.payKind) && !(values.payRate > 0)) {
      ctx.addIssue({ code: 'custom', path: ['payRate'], message: 'Enter the pay rate' });
    }
  });

export type DriverFormValues = z.infer<typeof driverFormSchema>;

/**
 * A `YYYY-MM-DD` day as a local-midnight Date, for a DatePicker's min/max. Built from the parts,
 * never `new Date(iso)`, which reads the string as UTC and can land on the previous day.
 */
export function calendarDay(iso: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  return match ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])) : undefined;
}

/** Whole days from today to an ISO date; negative once past. Null when unparseable. */
export function daysUntil(date: string, today = new Date()): number | null {
  const target = Date.parse(date);
  if (Number.isNaN(target)) return null;
  const start = Date.parse(today.toISOString().slice(0, 10));
  return Math.round((target - start) / 86_400_000);
}
