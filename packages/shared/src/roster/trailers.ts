import { z } from 'zod';

/**
 * Trailers, served from the `trailers` table.
 *
 * They used to be generated per session and kept in the workspace snapshot, like fuel fills and
 * safety events. They are not that kind of record: a trailer is a real asset with a VIN and a
 * plate, somebody adds one and expects to find it tomorrow, and 160 of them arrived from Ditat
 * on 2026-09-25 and had nowhere to be seen. So they now sit beside trucks and drivers — one row
 * in one table, read through this contract and nowhere else, which is also why there is no second
 * copy of them anywhere.
 *
 * The field names are the ones the Trailers page already used, so the page did not have to be
 * rewritten around a new vocabulary.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const TRAILER_TYPES = ['dry_van', 'reefer', 'flatbed'] as const;
export type TrailerType = (typeof TRAILER_TYPES)[number];

export const ROSTER_TRAILER_STATUSES = [
  'available',
  'assigned',
  'in_shop',
  'out_of_service',
  'sold',
  // Off the fleet for good — totaled, returned, retired — with the reason recorded (2026-10-07).
  'inactive',
] as const;
export type RosterTrailerStatus = (typeof ROSTER_TRAILER_STATUSES)[number];

export const TRAILER_OWNERSHIPS = ['owned', 'leased'] as const;

export const TrailerSchema = z.object({
  id: z.string(),
  unitNumber: z.string(),
  vin: z.string(),
  /**
   * Year, make, length, plate and the next inspection are all genuinely unknown for most of the
   * fleet — the system they came from never held them — and the page prints "Not set" for each.
   * An invented year would be indistinguishable from a real one.
   */
  year: z.number().int().nullable(),
  make: z.string().nullable(),
  /** Added 2026-10-22; null for every trailer recorded before the form asked for it. */
  model: z.string().nullable(),
  type: z.enum(TRAILER_TYPES),
  lengthFt: z.number().int().nullable(),
  plate: z.string().nullable(),
  plateState: z.string().nullable(),
  status: z.enum(ROSTER_TRAILER_STATUSES),
  ownership: z.enum(TRAILER_OWNERSHIPS),
  currentTruckId: z.string().nullable(),
  /** Denormalised for display; the pairing itself lives in `currentTruckId`. */
  currentTruckUnit: z.string().nullable(),
  nextInspectionDate: isoDate.nullable(),
  homeTerminal: z.string().nullable(),
  /** The system this row was imported out of, and its key there. Null when somebody typed it. */
  source: z.string().nullable(),
  externalId: z.string().nullable(),
});
export type TrailerRecord = z.infer<typeof TrailerSchema>;

/** A unit number is all that is truly required; everything else is added as it becomes known. */
export const CreateTrailerSchema = z.object({
  unitNumber: z.string().trim().min(1, 'Unit number is required').max(20),
  vin: z
    .string()
    .trim()
    .regex(/^([A-HJ-NPR-Z0-9]{17})?$/i, 'That is not a valid VIN')
    .default(''),
  year: z.number().int().min(1950).max(2100).nullable().optional(),
  make: z.string().trim().max(40, 'Make is too long').nullable().optional(),
  model: z.string().trim().max(40, 'Model is too long').nullable().optional(),
  type: z.enum(TRAILER_TYPES).default('dry_van'),
  lengthFt: z.number().int().min(1).max(100).nullable().optional(),
  plate: z.string().trim().max(20).nullable().optional(),
  plateState: z.string().trim().max(2).nullable().optional(),
  ownership: z.enum(TRAILER_OWNERSHIPS).default('owned'),
  nextInspectionDate: isoDate.nullable().optional(),
  homeTerminal: z.string().trim().max(60).nullable().optional(),
});
export type CreateTrailerRequest = z.infer<typeof CreateTrailerSchema>;

/*
 * The create defaults (blank VIN, dry van, company owned) must not follow into an edit: a
 * `.partial()` of the create schema still fills them in, so a PATCH that only added a plate also
 * blanked the VIN and turned a reefer into a dry van. An edit carries only what it names.
 */
export const UpdateTrailerSchema = CreateTrailerSchema.partial().extend({
  vin: CreateTrailerSchema.shape.vin.unwrap().optional(),
  type: z.enum(TRAILER_TYPES).optional(),
  ownership: z.enum(TRAILER_OWNERSHIPS).optional(),
  status: z.enum(ROSTER_TRAILER_STATUSES).optional(),
  currentTruckId: z.string().nullable().optional(),
});
export type UpdateTrailerRequest = z.infer<typeof UpdateTrailerSchema>;

/** A trailer in one of these states is off the board; the list hides it unless asked. */
export const INACTIVE_TRAILER_STATUSES: readonly RosterTrailerStatus[] = ['sold', 'inactive'];
