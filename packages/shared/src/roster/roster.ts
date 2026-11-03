import { z } from 'zod';
import { TruckVendorSchema } from '../fleet/vendor-trucks.js';
import { isIsoCalendarDate } from '../dates.js';

/**
 * The roster contract: trucks and drivers as the database stores them and the API returns them.
 *
 * This is the only definition of these two records. The API validates against it on the way in,
 * the web app types its cache with it on the way out, and the Drizzle table mirrors it field for
 * field. Before this existed the roster lived only as a TypeScript interface inside the browser
 * bundle, which is how a "created" truck could vanish on refresh: nothing on either side of the
 * wire had ever agreed on what a truck was, because nothing had ever crossed the wire.
 *
 * Every union here mirrors the domain types the rest of the application already uses. Where a name
 * is already taken in this package by a different union (the reporting `TRUCK_STATUSES`, the
 * compliance `COMPLIANCE_STATUSES`), the roster one carries a `ROSTER_` prefix rather than
 * redefining the existing meaning.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

/*
 * Date of birth (owner, 2026-10-25).
 *
 * A calendar day, never an instant: `YYYY-MM-DD` read against today's US Eastern date, so no
 * browser or server zone can move it a day. 18 is the floor because nothing in this product
 * enforces a higher one: there is no interstate under-21 rule here, and the insurance minimum
 * (hiring.prequal.require_age_23) is a prequalification answer, not a roster rule. 100 is the
 * ceiling past which the date is almost certainly a typo.
 */
export const DRIVER_MIN_AGE = 18;
export const DRIVER_MAX_AGE = 100;

/** Whole years from `dateOfBirth` to `today`, both `YYYY-MM-DD`; null when either is not a date. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  if (!isIsoCalendarDate(dateOfBirth) || !isIsoCalendarDate(today)) return null;
  const [by, bm, bd] = dateOfBirth.split('-').map(Number) as [number, number, number];
  const [ty, tm, td] = today.split('-').map(Number) as [number, number, number];
  // A 29 February birthday turns a year older on 1 March in a common year.
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/**
 * Why a date of birth cannot be saved, or null when it can. `today` is the US Eastern calendar
 * date from the server clock; the form and the API ask the same question with the same words.
 */
export function dateOfBirthIssue(dateOfBirth: string, today: string): string | null {
  if (!isIsoCalendarDate(dateOfBirth)) return 'Date of birth is not a valid date';
  if (dateOfBirth > today) return 'Date of birth cannot be in the future';
  const age = ageOn(dateOfBirth, today);
  if (age === null) return 'Date of birth is not a valid date';
  if (age < DRIVER_MIN_AGE) return `A driver must be at least ${DRIVER_MIN_AGE} years old`;
  if (age > DRIVER_MAX_AGE) return `That date makes the driver over ${DRIVER_MAX_AGE}. Check the year.`;
  return null;
}

/** The wire shape: a real calendar day. The age rule needs today, so the API applies it. */
const dateOfBirth = isoDate.refine((value) => isIsoCalendarDate(value), 'Date of birth is not a valid date');

export const ROSTER_TRUCK_STATUSES = [
  'active',
  'driving',
  'available',
  'idle',
  'in_shop',
  'out_of_service',
  'maintenance',
  'accident',
  // A unit parked indefinitely. The lifecycle has always offered "Make inactive"; without the
  // status here the API refused the change with a validation error the person could not act on.
  'inactive',
  'sold',
  // Archived (owner, 2026-10-05): hidden from every list, picker and count of the current fleet,
  // kept with its history, reversible, audited. Reached only through POST /trucks/:id/archive.
  'archived',
] as const;
export type RosterTruckStatus = (typeof ROSTER_TRUCK_STATUSES)[number];

/** The states a unit may be created in: a new unit has not been dispatched, so never `driving`. */
/** No in_shop: maintenance starts from a work order (Create repair), never from the unit form (owner, 2026-10-16). */
export const TRUCK_CREATE_STATUSES = ['available', 'idle', 'out_of_service'] as const;

/** `vendor`: a vendor's own truck running under our authority (owner, 2026-10-12). */
export const TRUCK_OWNERSHIPS = ['owned', 'leased', 'owner_operator', 'vendor'] as const;
export const FLEET_HEALTHS = ['healthy', 'needs_attention', 'critical'] as const;
export const TELEMATICS_STATUSES = ['connected', 'disconnected', 'error'] as const;

export const ROSTER_MAINTENANCE_TYPES = [
  'oil_change',
  'pm_service',
  'brake_inspection',
  'brake_repair',
  'tire_rotation',
  'tire_replacement',
  'dot_inspection',
  'coolant',
  'transmission',
  'engine',
  'dpf',
  'battery',
  'electrical',
  'lights',
  'doors_seals',
  'floor_walls',
  'landing_gear',
  'suspension',
  'reefer_unit',
  'other',
] as const;

export const TruckLocationSchema = z.object({
  lat: z.number(),
  lng: z.number(),
  city: z.string(),
  state: z.string(),
  updatedAt: z.string(),
  speedMph: z.number(),
  engineState: z.enum(['on', 'off', 'idle']),
  /**
   * Which way the truck is pointing, in degrees clockwise from north.
   *
   * Null is the ordinary case for a parked truck and for any position recorded before the sync
   * began reading it. The map draws an arrow only when this is a number: a marker that points
   * somewhere it was never told is a lie the eye believes.
   */
  headingDegrees: z.number().nullable().optional(),
});

export const TruckSchema = z.object({
  id: z.string(),
  unitNumber: z.string(),
  vin: z.string(),
  year: z.number().int(),
  make: z.string(),
  model: z.string(),
  /**
   * Registration, colour, terminal and the in-service date are known some time after the unit is.
   * Until the migration that relaxes their NOT NULL columns lands, an absent plate, colour or
   * terminal travels as an empty string and the in-service date as the day the unit was added;
   * the web treats an empty value and `null` alike ("Not set"), so the contract can go nullable
   * with that migration and nothing on the page changes.
   */
  /** Known later, from the unit's page; null until then (round 3, P1 #5). */
  plate: z.string().nullable(),
  plateState: z.string().nullable(),
  color: z.string().nullable(),
  status: z.enum(ROSTER_TRUCK_STATUSES),
  health: z.enum(FLEET_HEALTHS),
  ownership: z.enum(TRUCK_OWNERSHIPS),
  odometer: z.number().int(),
  odometerAt: z.string(),
  engineHours: z.number(),
  inServiceDate: isoDate.nullable(),
  currentDriverId: z.string().nullable(),
  /** Denormalised for display; the assignment itself lives in `currentDriverId`. */
  currentDriverName: z.string().nullable(),
  currentTrailerId: z.string().nullable(),
  currentLoadId: z.string().nullable(),
  location: TruckLocationSchema.nullable(),
  nextServiceOdometer: z.number().int(),
  nextServiceDate: isoDate,
  nextServiceType: z.enum(ROSTER_MAINTENANCE_TYPES),
  telematicsProvider: z.string(),
  telematicsStatus: z.enum(TELEMATICS_STATUSES),
  mpg30d: z.number(),
  mpg90d: z.number(),
  idlePercent30d: z.number(),
  idlePercent90d: z.number(),
  homeTerminal: z.string().nullable(),
  /** The vendor the truck runs for (owner, 2026-10-28); null or absent on a company truck. */
  vendor: TruckVendorSchema.nullable().optional(),
  /** The row's last write; the version token an archive or restore must quote back. */
  updatedAt: z.string().optional(),
});
export type TruckRecord = z.infer<typeof TruckSchema>;

/** Miles and days at which a new unit's first PM falls due when the caller names no schedule. */
export const FIRST_SERVICE_INTERVAL_MILES = 25_000;
export const FIRST_SERVICE_DAYS = 180;

/**
 * Only what identifies the unit is required: unit number, VIN, year, make, model, plus the
 * odometer it arrives with. Everything else — plate, colour, ownership, engine hours, in-service
 * date, home terminal, the first PM booking — can be added from the unit's page once it is known.
 * A unit exists before every detail about it does, and the form must not pretend otherwise.
 */
export const CreateTruckSchema = z.object({
  unitNumber: z.string().trim().min(1, 'Unit number is required').max(20),
  vin: z
    .string()
    .trim()
    .length(17, 'A VIN is 17 characters')
    // I, O and Q are excluded from the VIN alphabet precisely because they are misread as 1 and 0.
    .regex(/^[A-HJ-NPR-Z0-9]{17}$/i, 'That is not a valid VIN'),
  year: z.number().int().min(1980).max(2100),
  make: z.string().trim().min(1).max(40),
  model: z.string().trim().min(1).max(40),
  plate: z.string().trim().min(1).max(12).optional(),
  plateState: z.string().trim().length(2).optional(),
  color: z.string().trim().min(1).max(30).optional(),
  /** Company owned unless told otherwise: settlements and lease accounting key on this. */
  ownership: z.enum(TRUCK_OWNERSHIPS).default('owned'),
  odometer: z.number().int().min(0).max(3_000_000),
  engineHours: z.number().min(0).max(200_000).default(0),
  inServiceDate: isoDate.optional(),
  homeTerminal: z.string().trim().min(1).max(60).optional(),
  status: z.enum(TRUCK_CREATE_STATUSES),
  driverId: z.string().nullable().default(null),
  serviceIntervalMiles: z.number().int().min(1).max(100_000).default(FIRST_SERVICE_INTERVAL_MILES),
  nextServiceType: z.enum(ROSTER_MAINTENANCE_TYPES).default('pm_service'),
  /** Absent: booked FIRST_SERVICE_DAYS after the in-service date, or after the day it was added. */
  nextServiceDate: isoDate.optional(),
  /** A vendor truck (owner, 2026-10-28): whose truck it is and what the company keeps of its gross. */
  vendor: z
    .object({
      vendorId: z.string().min(1).nullable().optional(),
      vendorName: z.string().trim().min(2).max(120).nullable().optional(),
      companyPercent: z.number().min(0).max(100),
    })
    .optional(),
});
export type CreateTruckRequest = z.infer<typeof CreateTruckSchema>;

/** What an edit may change. Odometer and status move through their own operations. */
export const UpdateTruckSchema = z
  .object({
    unitNumber: z.string().trim().min(1).max(20),
    make: z.string().trim().min(1).max(40),
    model: z.string().trim().min(1).max(40),
    plate: z.string().trim().min(1).max(12),
    plateState: z.string().trim().length(2),
    color: z.string().trim().min(1).max(30),
    ownership: z.enum(TRUCK_OWNERSHIPS),
    homeTerminal: z.string().trim().min(1).max(60),
    inServiceDate: isoDate,
    nextServiceDate: isoDate,
    nextServiceType: z.enum(ROSTER_MAINTENANCE_TYPES),
    nextServiceOdometer: z.number().int().min(0),
  })
  .partial();
export type UpdateTruckRequest = z.infer<typeof UpdateTruckSchema>;

export const ROSTER_DRIVER_STATUSES = [
  /**
   * Hired, not yet cleared to work.
   *
   * Distinct from off duty, which is a driver who *can* be dispatched and happens not to be. An
   * onboarding driver has an open qualification file and cannot take a load at all, and saying so
   * in the status is the difference between a dispatcher wondering why nobody answers and one who
   * can see the reason.
   */
  'onboarding',
  'driving',
  'dispatched',
  'available',
  'off_duty',
  'sleeper',
  /** On vacation (owner, 2026-10-16): away, not inactive; the days count from driver_vacations. */
  'vacation',
  'suspended',
  'terminated',
  'inactive',
] as const;
export type RosterDriverStatus = (typeof ROSTER_DRIVER_STATUSES)[number];

export const DRIVER_TYPES = ['company', 'owner_operator', 'lease_operator'] as const;
export const CDL_CLASSES = ['A', 'B'] as const;
/** Lease owner, leasing to owner and owner truck are paid gross less the lease sheet's charges (owner, 2026-10-12). */
export const PAY_PLAN_KINDS = ['per_mile', 'percent_of_linehaul', 'lease_owner', 'lease_to_own', 'owner_truck'] as const;
/** `uk` stays accepted for rows written before 2026-09-21; the form offers Uzbek in its place. */
export const DRIVER_LANGUAGES = ['en', 'es', 'ru', 'uz', 'uk'] as const;
export const ROSTER_COMPLIANCE_STATUSES = ['verified', 'expiring', 'expired', 'missing'] as const;

export const PayPlanSchema = z.object({
  kind: z.enum(PAY_PLAN_KINDS),
  /**
   * Zero means no rate has been agreed yet, which is what an imported driver file arrives with:
   * the other system knew the pay *plan* and not the number. It is not a driver who is paid
   * nothing — a settlement cannot be run against it, and the screens read it as unset.
   */
  rate: z.number().nonnegative(),
});

/** What a second number is for; shown beside it so dispatch knows whom they are ringing. */
export const SECONDARY_PHONE_LABELS = ['cell', 'home', 'spouse', 'dispatch_only'] as const;
export type SecondaryPhoneLabel = (typeof SECONDARY_PHONE_LABELS)[number];

export const DriverSchema = z.object({
  id: z.string(),
  driverNumber: z.string(),
  firstName: z.string(),
  lastName: z.string(),
  name: z.string(),
  phone: z.string(),
  secondaryPhone: z.string().nullable().optional(),
  secondaryPhoneLabel: z.enum(SECONDARY_PHONE_LABELS).nullable().optional(),
  email: z.string(),
  driverType: z.enum(DRIVER_TYPES),
  cdlState: z.string(),
  cdlClass: z.enum(CDL_CLASSES),
  cdlEndorsements: z.array(z.string()),
  cdlExpiresOn: isoDate,
  cdlStatus: z.enum(ROSTER_COMPLIANCE_STATUSES),
  /** Null when no certificate is on file; the status beside it says `missing`. */
  medicalCardExpiresOn: isoDate.nullable(),
  medicalCardStatus: z.enum(ROSTER_COMPLIANCE_STATUSES),
  /**
   * Date of birth (owner, 2026-10-25); null when not recorded. Personal data, in the licence
   * group with the CDL and medical fields for masking (drivers.view_licence).
   */
  dateOfBirth: isoDate.nullable().optional(),
  hireDate: isoDate,
  /**
   * The person this driver is.
   *
   * A driver is an employee who drives: the same human being holds the onboarding plan, the
   * attendance record and the pay. Null only for roster rows opened before the two were linked.
   */
  employeeId: z.string().nullable().optional(),
  status: z.enum(ROSTER_DRIVER_STATUSES),
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  currentTruckId: z.string().nullable(),
  currentTruckUnit: z.string().nullable(),
  currentTrailerId: z.string().nullable(),
  homeCity: z.string(),
  homeState: z.string(),
  safetyScore: z.number(),
  safetyEvents30d: z.number().int(),
  payPlan: PayPlanSchema,
  preferredLanguage: z.enum(DRIVER_LANGUAGES),
  /**
   * When the driver was archived (owner, 2026-10-02): hidden from the Drivers page and every
   * picker, kept and restorable. Null (or absent) for every driver in use. The status is untouched.
   */
  archivedAt: z.string().nullable().optional(),
  archivedReason: z.string().nullable().optional(),
  /** The row's last write; the version token an edit quotes back as `expectedUpdatedAt`. */
  updatedAt: z.string().optional(),
});
export type DriverRecord = z.infer<typeof DriverSchema>;

export const CreateDriverSchema = z.object({
  /**
   * The unit this driver takes, when it is already known.
   *
   * Optional, because most drivers are hired before a truck is free — but a carrier that hires
   * a driver for a truck should not have to pair them on a second screen afterwards.
   */
  truckId: z.string().min(1).nullable().optional(),
  firstName: z.string().trim().min(1, 'First name is required').max(40),
  lastName: z.string().trim().min(1, 'Last name is required').max(40),
  phone: z.string().trim().min(7, 'A contact number is required').max(20),
  /** A second way to reach them; optional, and the label says whose phone it is. */
  secondaryPhone: z.string().trim().max(20).nullable().optional(),
  secondaryPhoneLabel: z.enum(SECONDARY_PHONE_LABELS).nullable().optional(),
  email: z.email('That is not a valid email address'),
  driverType: z.enum(DRIVER_TYPES),
  cdlState: z.string().trim().length(2),
  cdlClass: z.enum(CDL_CLASSES),
  cdlEndorsements: z.array(z.string().trim().min(1).max(4)).max(10),
  cdlExpiresOn: isoDate,
  /** Optional since 2026-10-12: Recruiting collects the DOT medical card, not the roster form. */
  medicalCardExpiresOn: isoDate.nullable().optional(),
  /** Optional (owner, 2026-10-25). The API refuses a future date and an age outside 18–100. */
  dateOfBirth: dateOfBirth.nullable().optional(),
  hireDate: isoDate,
  /** Optional since 2026-10-12 (owner): a driver can be added before a dispatcher is chosen. */
  dispatcherId: z.string().default(''),
  homeCity: z.string().trim().min(1).max(60),
  homeState: z.string().trim().length(2),
  payPlan: PayPlanSchema,
  preferredLanguage: z.enum(DRIVER_LANGUAGES),
  /**
   * The Daily board row this driver file is made for (owner, 2026-10-26): a row the board's quick
   * "Create new driver" added without a driver file. The new file is linked to that row, so loads
   * can be assigned to the driver the board already shows. Optional; without it the API links the
   * one active unlinked row with the same name, if exactly one exists.
   */
  boardRowId: z.string().trim().min(1).max(64).nullable().optional(),
});
export type CreateDriverRequest = z.infer<typeof CreateDriverSchema>;

/**
 * Putting a driver in a truck, or taking them out of one.
 *
 * Null is how a driver is taken out: no truck is a real answer, and an endpoint that can only
 * assign leaves a driver stuck to a unit that has gone to the shop.
 */
export const AssignDriverTruckSchema = z.object({
  truckId: z.string().min(1).nullable(),
});
export type AssignDriverTruckRequest = z.infer<typeof AssignDriverTruckSchema>;

export const UpdateDriverSchema = CreateDriverSchema.partial().extend({
  /**
   * The driver's `updatedAt` as the editor read it. When given, a save over a newer write is a
   * 409, never a silent overwrite. Optional so older callers keep working; the profile sends it.
   */
  expectedUpdatedAt: z.string().min(1).optional(),
});
export type UpdateDriverRequest = z.infer<typeof UpdateDriverSchema>;

/** Both list endpoints answer in this shape, so a client pages them the same way. */
export const RosterQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  // Pickers ask for the whole roster in one page; a size above the cap is answered with the cap
  // rather than refused (a 422 here emptied the Assign driver and work-order pickers, 2026-10-16).
  pageSize: z.coerce.number().int().min(1).default(50).transform((v) => Math.min(v, 1000)),
  search: z.string().trim().max(120).optional(),
  /** Sold units and terminated drivers are excluded unless this is `true`. */
  includeInactive: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
  /** Archived drivers (migration 0039) are excluded unless this is `true`. */
  includeArchived: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export type RosterQuery = z.infer<typeof RosterQuerySchema>;

export interface RosterPage<T> {
  data: T[];
  total: number;
  page: number;
  pageSize: number;
}

/** A unit in one of these states is off the board; the list hides it unless asked. */
export const INACTIVE_TRUCK_STATUSES: readonly RosterTruckStatus[] = ['sold', 'inactive'];

/**
 * An archived truck (owner, 2026-10-05) is not part of the current fleet anywhere: no list, picker,
 * board or count shows it unless it asks for archived units by name. Its history stays: old loads,
 * repairs, fuel and settlements keep its unit number.
 */
export const ARCHIVED_TRUCK_STATUS = 'archived' as const;

/** True for a truck that has been archived. Accepts any status string, so every caller can ask. */
export function isArchivedTruck(unit: { status?: string | null } | null | undefined): boolean {
  return (unit?.status ?? '').trim().toLowerCase() === ARCHIVED_TRUCK_STATUS;
}

/** The statuses the plain status route may set: archiving has its own route, reason and audit. */
export const SETTABLE_TRUCK_STATUSES = [
  'active',
  'driving',
  'available',
  'idle',
  'in_shop',
  'out_of_service',
  'maintenance',
  'accident',
  'inactive',
  'sold',
] as const satisfies readonly RosterTruckStatus[];

/** Archives a truck. The truck's `updatedAt` the page read is the version check. */
export const ArchiveTruckSchema = z.object({
  reason: z.string().trim().min(3, 'Say why the truck is archived').max(500),
  expectedUpdatedAt: z.string().min(1),
});
export type ArchiveTruckRequest = z.infer<typeof ArchiveTruckSchema>;

/** Restores an archived truck to `available`. Same version check; the reason is optional. */
export const RestoreTruckSchema = z.object({
  reason: z.string().trim().max(500).optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type RestoreTruckRequest = z.infer<typeof RestoreTruckSchema>;

export const INACTIVE_DRIVER_STATUSES: readonly RosterDriverStatus[] = ['terminated', 'inactive'];

/**
 * The working roster (owner, 2026-10-25): drivers who can take a load, or are away on vacation and
 * coming back. Onboarding (hired, not yet cleared), suspended, terminated and inactive drivers are
 * not on it. Analytics' "Drivers" counts these, from the drivers table.
 */
export const ACTIVE_ROSTER_DRIVER_STATUSES: readonly RosterDriverStatus[] = [
  'driving',
  'dispatched',
  'available',
  'off_duty',
  'sleeper',
  'vacation',
];

/** Restores an archived driver; the archive time read is the version token, so a stale restore is refused. */
export const RestoreDriverSchema = z.object({ expectedArchivedAt: z.string().min(1) });
export type RestoreDriverRequest = z.infer<typeof RestoreDriverSchema>;
