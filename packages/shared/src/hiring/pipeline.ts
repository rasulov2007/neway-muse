import { z } from 'zod';
import { DRIVER_TYPES, PAY_PLAN_KINDS, DRIVER_LANGUAGES } from '../roster/roster.js';

/**
 * The back of the funnel: offer, ticket, orientation, hire.
 *
 * From the safety decision on, a case moves because a recruiter recorded something. Each of these
 * is a record of that thing — the offer that went out and what it said, the travel that was booked
 * and what it cost, the days of orientation and how the road test went — kept on the case so the
 * cost ledger and the analytics can read them later. None of it is a copy of the qualification
 * file: the road test certificate is filed there, and the record here points at it.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime();
const money = z.number().nonnegative().max(1_000_000);

// -------------------------------------------------------------------------------------- offer

/**
 * What a driver offer says beyond the generic one: the pay plan (per mile or percent of
 * linehaul, the roster's own enum), a sign-on bonus, a referral bonus and who earned it, and
 * the orientation date the offer is for.
 */
export const CreateDriverOfferSchema = z.object({
  driverType: z.enum(DRIVER_TYPES),
  payPlan: z.object({ kind: z.enum(PAY_PLAN_KINDS), rate: z.number().positive() }),
  signOnBonus: money.nullable().default(null),
  referralBonus: money.nullable().default(null),
  /** The driver on the roster who referred this candidate; required when a referral bonus is set. */
  referringDriverId: z.string().nullable().default(null),
  orientationDate: isoDate,
  expiresOn: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type CreateDriverOfferInput = z.input<typeof CreateDriverOfferSchema>;
export type CreateDriverOfferRequest = z.infer<typeof CreateDriverOfferSchema>;

// ------------------------------------------------------------------------------------- ticket

export const TRAVEL_MODES = [
  'bus',
  'flight',
  'rental_car',
  'own_vehicle',
  'company_shuttle',
] as const;
export const TravelModeSchema = z.enum(TRAVEL_MODES);
export type TravelMode = z.infer<typeof TravelModeSchema>;

export const TRAVEL_MODE_LABELS: Readonly<Record<TravelMode, string>> = {
  bus: 'Bus',
  flight: 'Flight',
  rental_car: 'Rental car',
  own_vehicle: 'Own vehicle',
  company_shuttle: 'Company shuttle',
};

export const TravelTicketSchema = z.object({
  id: z.string(),
  hiringCaseId: z.string(),
  travelMode: TravelModeSchema,
  carrier: z.string().nullable(),
  bookingReference: z.string().nullable(),
  departAt: isoDateTime,
  arriveAt: isoDateTime.nullable(),
  travelCost: z.number().nullable(),
  lodgingNights: z.number().int().nonnegative(),
  lodgingCost: z.number().nullable(),
  bookedById: z.string().nullable(),
  bookedByName: z.string(),
  notes: z.string().nullable(),
  createdAt: isoDateTime,
});
export type TravelTicket = z.infer<typeof TravelTicketSchema>;

export const BookTicketSchema = z.object({
  travelMode: TravelModeSchema,
  carrier: z.string().trim().max(120).nullable().default(null),
  bookingReference: z.string().trim().max(60).nullable().default(null),
  departAt: isoDateTime,
  arriveAt: isoDateTime.nullable().default(null),
  travelCost: money.nullable().default(null),
  lodgingNights: z.number().int().nonnegative().max(60).default(0),
  lodgingCost: money.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type BookTicketInput = z.input<typeof BookTicketSchema>;
export type BookTicketRequest = z.infer<typeof BookTicketSchema>;

// -------------------------------------------------------------------------------- orientation

export const ORIENTATION_ATTENDANCE = ['scheduled', 'attended', 'no_show'] as const;
export const OrientationAttendanceSchema = z.enum(ORIENTATION_ATTENDANCE);
export type OrientationAttendance = z.infer<typeof OrientationAttendanceSchema>;

export const ROAD_TEST_RESULTS = ['pass', 'fail'] as const;
export const RoadTestResultSchema = z.enum(ROAD_TEST_RESULTS);
export type RoadTestResult = z.infer<typeof RoadTestResultSchema>;

/** The road test as 49 CFR 391.31 describes it; the certificate (391.31(e)) is rendered from this. */
export const RoadTestSchema = z.object({
  result: RoadTestResultSchema,
  testedOn: isoDate,
  examinerName: z.string().trim().min(1).max(120),
  /** The kind of vehicle used, e.g. "Tractor-semitrailer". */
  vehicleType: z.string().trim().min(1).max(120),
  notes: z.string().trim().max(1000).nullable().default(null),
});
export type RoadTest = z.infer<typeof RoadTestSchema>;

export const OrientationSchema = z.object({
  id: z.string(),
  hiringCaseId: z.string(),
  startDate: isoDate,
  days: z.number().int().positive(),
  /** What the candidate is paid per day of orientation. Null when unpaid. */
  perDayPay: z.number().nullable(),
  attendance: OrientationAttendanceSchema,
  roadTest: RoadTestSchema.nullable(),
  /** The certificate in the qualification file, once a pass was filed. */
  roadTestDocumentId: z.string().nullable(),
  completedOn: isoDate.nullable(),
  notes: z.string().nullable(),
  updatedAt: isoDateTime,
});
export type Orientation = z.infer<typeof OrientationSchema>;

export const RecordOrientationSchema = z.object({
  startDate: isoDate,
  days: z.number().int().positive().max(30),
  perDayPay: money.nullable().default(null),
  attendance: OrientationAttendanceSchema,
  roadTest: RoadTestSchema.nullable().default(null),
  completedOn: isoDate.nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});
export type RecordOrientationInput = z.input<typeof RecordOrientationSchema>;
export type RecordOrientationRequest = z.infer<typeof RecordOrientationSchema>;

// --------------------------------------------------------------------------------------- hire

/**
 * The hire event. Everything else about the driver is already known — name and licence from the
 * DOT application, pay plan and driver type from the offer, CDL and medical dates from the
 * qualification file — so this asks only for what nothing upstream held.
 */
export const HireDriverSchema = z.object({
  hireDate: isoDate,
  dispatcherId: z.string().min(1, 'A dispatcher is required'),
  managerEmployeeId: z.string().nullable().default(null),
  preferredLanguage: z.enum(DRIVER_LANGUAGES).default('en'),
  startOnboarding: z.boolean().default(true),
});
export type HireDriverInput = z.input<typeof HireDriverSchema>;
export type HireDriverRequest = z.infer<typeof HireDriverSchema>;

export const HireDriverResultSchema = z.object({
  hiringCaseId: z.string(),
  employeeId: z.string(),
  employeeNumber: z.string(),
  driverId: z.string(),
  driverNumber: z.string(),
  onboardingChecklistId: z.string().nullable(),
});
export type HireDriverResult = z.infer<typeof HireDriverResultSchema>;
