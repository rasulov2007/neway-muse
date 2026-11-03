import { z } from 'zod';

/** 17 characters, letters and digits, never I, O or Q (ISO 3779). */
export const VIN_PATTERN = /^[A-HJ-NPR-Z0-9]{17}$/;

export const TRUCK_MAKES = [
  'Freightliner',
  'Volvo',
  'Kenworth',
  'Peterbilt',
  'Mack',
  'International',
  'Other',
] as const;

/**
 * What a unit can be set to on creation.
 *
 * `active` and `driving` are absent deliberately: those describe a unit that is on a load, and a
 * unit cannot be on a load it has not been dispatched.
 */
// No In shop: a unit goes into maintenance only through Create repair, so the shop, the repair and
// its cost are on record and closing the order returns it (owner, 2026-10-16: 0018 and 0031 were
// added as In shop with no work order and counted nowhere in Repairs).
export const TRUCK_STATUSES = ['available', 'idle', 'out_of_service'] as const;

export const OWNERSHIP_VALUES = ['owned', 'leased', 'owner_operator', 'vendor'] as const;

export const OWNERSHIP_OPTIONS = [
  { value: 'owned', label: 'Company owned', description: 'Titled to Northwind Freight.' },
  { value: 'leased', label: 'Leased', description: 'Lease payments tracked under Accounting.' },
  {
    value: 'owner_operator',
    label: 'Owner-operator',
    description: 'Driver owns the unit; settlements deduct fixed costs.',
  },
  {
    value: 'vendor',
    label: 'Vendor truck',
    description: 'A vendor’s own truck running with us; the company keeps a percentage of its gross.',
  },
] as const;

export const HOME_LOCATIONS = [
  'Naperville, IL',
  'Dallas, TX',
  'Atlanta, GA',
  'Denver, CO',
  'Columbus, OH',
] as const;

export const US_STATES = [
  'AL',
  'AK',
  'AZ',
  'AR',
  'CA',
  'CO',
  'CT',
  'DE',
  'FL',
  'GA',
  'HI',
  'ID',
  'IL',
  'IN',
  'IA',
  'KS',
  'KY',
  'LA',
  'ME',
  'MD',
  'MA',
  'MI',
  'MN',
  'MS',
  'MO',
  'MT',
  'NE',
  'NV',
  'NH',
  'NJ',
  'NM',
  'NY',
  'NC',
  'ND',
  'OH',
  'OK',
  'OR',
  'PA',
  'RI',
  'SC',
  'SD',
  'TN',
  'TX',
  'UT',
  'VT',
  'VA',
  'WA',
  'WV',
  'WI',
  'WY',
] as const;

/** An optional text field: blank means "not known yet", never an empty string on the record. */
const optionalText = (max: number, tooLong: string) =>
  z
    .string()
    .trim()
    .max(max, tooLong)
    .transform((value) => (value === '' ? undefined : value));

/** An optional choice: the Select/RadioGroup hands back `undefined` when nothing is picked. */
const optionalChoice = <T extends readonly [string, ...string[]]>(values: T, message: string) =>
  z.enum(values, { error: message }).optional();

export const truckFormSchema = z.object({
  unitNumber: z
    .string()
    .trim()
    .min(2, 'Unit number needs at least 2 characters')
    .max(8, 'Unit number can be at most 8 characters'),
  vin: z
    .string()
    .trim()
    .toUpperCase()
    .regex(VIN_PATTERN, 'VIN must be 17 characters with no I, O or Q'),
  make: z.enum(TRUCK_MAKES, { error: 'Select a make' }),
  model: z.string().trim().min(1, 'Model is required').max(40, 'Model is too long'),
  year: z
    .string()
    .trim()
    .min(1, 'Year is required')
    .transform(Number)
    .pipe(
      z
        .number({ error: 'Year must be a number' })
        .int('Year must be a whole number')
        .min(1995, 'Year must be 1995 or later')
        .max(2027, 'Year must be 2027 or earlier'),
    ),
  // Only the identity above is required. A unit is on the books before its plate, terminal or
  // in-service date are known; each of these is added from the unit's page later, and the
  // feature that needs it (PM scheduling, registration) asks for it there.
  plate: optionalText(10, 'Plate is too long'),
  plateState: optionalChoice(US_STATES, 'Select the plate state'),
  ownership: optionalChoice(OWNERSHIP_VALUES, 'Select ownership'),
  status: z.enum(TRUCK_STATUSES, { error: 'Select a status' }),
  driverId: z.string().nullable(),
  homeLocation: optionalChoice(HOME_LOCATIONS, 'Select a home location'),
  inServiceDate: z.date().optional(),
  odometer: z
    .string()
    .trim()
    .min(1, 'Odometer is required')
    .transform(Number)
    .pipe(
      z
        .number({ error: 'Odometer must be a number' })
        .int('Odometer must be a whole number')
        .min(0, 'Odometer cannot be negative'),
    ),
});

export type TruckFormInput = z.input<typeof truckFormSchema>;
export type TruckFormValues = z.output<typeof truckFormSchema>;

export const truckFormDefaults: TruckFormInput = {
  unitNumber: '',
  vin: '',
  make: undefined as unknown as TruckFormInput['make'],
  model: '',
  year: '',
  plate: '',
  plateState: undefined,
  // Company owned is the default the rest of the product assumes (settlements, lease accounting),
  // so it is preselected rather than left for the page to demand later.
  ownership: 'owned',
  status: 'available',
  driverId: null,
  homeLocation: undefined,
  inServiceDate: undefined,
  odometer: '0',
};

/** Miles and days a new unit's first PM is booked at when nobody has specified one. */
export const FIRST_SERVICE_INTERVAL_MILES = 25_000;
export const FIRST_SERVICE_DAYS = 180;

/** A picked date as the `YYYY-MM-DD` the records store, in local time rather than UTC. */
export function toIsoDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * When the first PM falls due.
 *
 * Measured from the in-service date when there is one. A unit added before that date is known
 * is measured from the day it was added instead, so it is never in the fleet with no service
 * schedule at all; the date is corrected from the unit's page once somebody has it.
 */
export function firstServiceDate(inServiceDate: Date | undefined, today = new Date()): string {
  const from = inServiceDate ?? today;
  return toIsoDate(new Date(from.getTime() + FIRST_SERVICE_DAYS * 86_400_000));
}
