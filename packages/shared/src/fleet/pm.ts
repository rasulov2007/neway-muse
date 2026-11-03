import { z } from 'zod';
import { daysBetweenDates } from './work-orders.js';

/**
 * Oil change / PM (docs/pm-module/02-pm-spec.md).
 *
 * One service for now, `OIL_CHANGE`, but the shapes carry a service code so PM B and the annual
 * inspection can join without a second board. The rules here are the whole of §4 and §5: how a
 * plan resolves, how a reading is trusted, and how a due status is derived. Every screen reads
 * the cached `pm_status` the server computes with these functions; none computes its own.
 *
 * Three facts the customer insisted on: due status and appointment status never touch each
 * other; only a recorded, completed oil change resets the interval, from the odometer read at
 * the service; and a stale reading gives "≥ n over" or "can't tell", never a comforting number.
 */

// ------------------------------------------------------------------------------ vocabulary

export const PM_SERVICE_CODES = ['OIL_CHANGE'] as const;
export type PmServiceCode = (typeof PM_SERVICE_CODES)[number];

export const PM_SERVICE_LABEL: Record<PmServiceCode, string> = {
  OIL_CHANGE: 'Oil change (PM A)',
};

export const PM_PLAN_SCOPES = ['group', 'unit'] as const;
export type PmPlanScope = (typeof PM_PLAN_SCOPES)[number];

/** Where the resolved plan came from, shown on the row ("35,000 mi · truck override"). */
export const PM_PLAN_ORIGINS = ['unit', 'group', 'fleet'] as const;
export type PmPlanOrigin = (typeof PM_PLAN_ORIGINS)[number];

export const ODOMETER_SOURCES = ['eld', 'invoice', 'manual', 'import'] as const;
export type OdometerSource = (typeof ODOMETER_SOURCES)[number];

/** Trust order when two readings share a moment (§3.4). Lower is more trusted. */
export const ODOMETER_SOURCE_RANK: Record<OdometerSource, number> = {
  eld: 0,
  invoice: 1,
  manual: 2,
  import: 3,
};

export const ODOMETER_READING_STATUSES = ['ok', 'conflict', 'void'] as const;
export type OdometerReadingStatus = (typeof ODOMETER_READING_STATUSES)[number];

export const ODOMETER_CONFLICT_REASONS = ['below_previous', 'too_high_per_day', 'implausible_jump'] as const;
export type OdometerConflictReason = (typeof ODOMETER_CONFLICT_REASONS)[number];

/**
 * The owner's guard on typed odometers (2026-10-22): a figure more than 3,000 mi above the last
 * good reading of the unit - counted per day since that reading, a reading the same day being one
 * day - is not accepted silently. It is kept as a conflict (`implausible_jump`), which nothing
 * uses (not the PM board, not a lease settlement), and the screen that entered it says so.
 */
export const ODOMETER_MAX_JUMP_MILES = 3_000;

/** What the person who typed the odometer is told when it was not accepted. */
export function odometerConflictMessage(
  reason: OdometerConflictReason | null | undefined,
  odometerMiles: number,
  previousMiles: number | null | undefined,
): string | null {
  if (!reason) return null;
  const n = (v: number) => v.toLocaleString('en-US');
  if (previousMiles === null || previousMiles === undefined) return `Odometer ${n(odometerMiles)} conflicts with an earlier reading — check the number`;
  if (reason === 'below_previous')
    return `Odometer ${n(odometerMiles)} is ${n(previousMiles - odometerMiles)} mi below the last reading (${n(previousMiles)}) — check the number`;
  return `Odometer ${n(odometerMiles)} is ${n(odometerMiles - previousMiles)} mi above the last reading (${n(previousMiles)}) — check the number`;
}

/**
 * §4.1, plus two honest states the spec's table implies: `no_interval` (no plan resolves) and
 * `no_baseline` (a plan and a reading, but no service on record to count from). Neither ever
 * reads OK.
 */
export const PM_DUE_STATUSES = [
  'overdue',
  'overdue_at_least',
  'due_soon',
  'ok',
  'no_reading',
  'no_baseline',
  'no_interval',
] as const;
export type PmDueStatus = (typeof PM_DUE_STATUSES)[number];

export const PM_DUE_STATUS_LABEL: Record<PmDueStatus, string> = {
  overdue: 'Overdue',
  overdue_at_least: 'Overdue',
  due_soon: 'Due soon',
  ok: 'OK',
  no_reading: 'No reading',
  no_baseline: 'No service on record',
  no_interval: 'No interval set',
};

export const PM_DUE_BASES = ['miles', 'days', 'hours'] as const;
export type PmDueBasis = (typeof PM_DUE_BASES)[number];

export const PM_AVG_BASES = ['30d', '60d', 'group_median'] as const;
export type PmAvgBasis = (typeof PM_AVG_BASES)[number];

export const PM_RESPONSIBILITIES = ['us', 'lessor'] as const;
export type PmResponsibility = (typeof PM_RESPONSIBILITIES)[number];

// ------------------------------------------------------------------------------ settings (§10)

export interface PmSettings {
  /** Used when no unit or group plan resolves. */
  fleetIntervalMiles: number;
  /** Group defaults the company starts with; a group plan row overrides these. */
  groupIntervalMiles: Record<string, number>;
  /** Due soon = max(dueSoonMinMiles, dueSoonFraction × interval), or dueSoonDays. */
  dueSoonMinMiles: number;
  dueSoonFraction: number;
  dueSoonDays: number;
  /** A reading older than this cannot produce a due status by miles. */
  staleReadingDays: number;
  /** A reading more than this above the previous one, per day, is a conflict. */
  maxMilesPerDay: number;
  manualReadingPhotoRequired: boolean;
  /** Below this average no estimated date is shown. */
  minAvgMilesPerDayForEstimate: number;
  /** A reading within this many hours counts as fresh for the coverage card. */
  coverageHours: number;
}

export const PM_SETTINGS: PmSettings = {
  fleetIntervalMiles: 30_000,
  groupIntervalMiles: { NWF: 30_000, Ryder: 50_000, 'M&K': 20_000 },
  // Yellow at 2,500 mi or less, whatever the interval (owner, 2026-10-23).
  dueSoonMinMiles: 2_500,
  dueSoonFraction: 0,
  dueSoonDays: 14,
  staleReadingDays: 7,
  maxMilesPerDay: 1_500,
  manualReadingPhotoRequired: true,
  minAvgMilesPerDayForEstimate: 20,
  coverageHours: 24,
};

/** §4.1: due soon is the larger of the floor and a tenth of the interval, unless the plan says. */
export function dueSoonMilesFor(
  intervalMiles: number,
  override: number | null | undefined,
  settings: PmSettings = PM_SETTINGS,
): number {
  if (override !== null && override !== undefined) return override;
  return Math.max(settings.dueSoonMinMiles, Math.round(intervalMiles * settings.dueSoonFraction));
}

// ------------------------------------------------------------------------------ records

export const PmServiceSchema = z.object({
  code: z.enum(PM_SERVICE_CODES),
  name: z.string(),
  resetsInterval: z.boolean(),
  defaultIntervalMiles: z.number().int().nullable(),
  defaultIntervalDays: z.number().int().nullable(),
  defaultIntervalHours: z.number().int().nullable(),
});
export type PmService = z.infer<typeof PmServiceSchema>;

export const PmPlanSchema = z.object({
  id: z.string(),
  serviceCode: z.enum(PM_SERVICE_CODES),
  scope: z.enum(PM_PLAN_SCOPES),
  groupName: z.string().nullable(),
  unitId: z.string().nullable(),
  unitNumber: z.string().nullable(),
  intervalMiles: z.number().int(),
  intervalDays: z.number().int().nullable(),
  intervalHours: z.number().int().nullable(),
  dueSoonMiles: z.number().int().nullable(),
  dueSoonDays: z.number().int().nullable(),
  reason: z.string().nullable(),
  setBy: z.string(),
  setByName: z.string(),
  setAt: z.string(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
  version: z.number().int(),
});
export type PmPlan = z.infer<typeof PmPlanSchema>;

/** Setting a plan. A unit plan needs a reason; the interval has to be a plausible one (§04 import rules). */
export const SetPmPlanSchema = z
  .object({
    serviceCode: z.enum(PM_SERVICE_CODES).default('OIL_CHANGE'),
    scope: z.enum(PM_PLAN_SCOPES),
    groupName: z.string().trim().min(1).max(60).nullable().default(null),
    unitId: z.string().nullable().default(null),
    intervalMiles: z
      .number()
      .int()
      .min(5_000, 'An interval under 5,000 miles is not one')
      .max(100_000, 'An interval over 100,000 miles is not one'),
    intervalDays: z.number().int().min(7).max(730).nullable().default(null),
    intervalHours: z.number().int().min(50).max(5_000).nullable().default(null),
    dueSoonMiles: z.number().int().min(0).nullable().default(null),
    dueSoonDays: z.number().int().min(0).nullable().default(null),
    reason: z.string().trim().max(500).nullable().default(null),
  })
  .superRefine((value, ctx) => {
    if (value.scope === 'unit' && !value.unitId)
      ctx.addIssue({ code: 'custom', path: ['unitId'], message: 'A unit plan needs the unit' });
    if (value.scope === 'group' && !value.groupName)
      ctx.addIssue({
        code: 'custom',
        path: ['groupName'],
        message: 'A group plan needs the group',
      });
    if (value.scope === 'unit' && !value.reason?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'Say why this truck runs a different interval',
      });
    }
  });
export type SetPmPlanInput = z.infer<typeof SetPmPlanSchema>;
export type SetPmPlanRequest = z.input<typeof SetPmPlanSchema>;

export const VoidPmPlanSchema = z.object({
  version: z.number().int(),
  reason: z.string().trim().min(1, 'Say why the interval is being removed').max(500),
});
export type VoidPmPlanInput = z.infer<typeof VoidPmPlanSchema>;

/** Putting a unit in a group - the owner's "truck type" (Freightliner, Volvo…). Null: none. */
export const SetUnitGroupSchema = z.object({
  groupName: z.string().trim().min(1).max(60).nullable(),
});
export type SetUnitGroupInput = z.infer<typeof SetUnitGroupSchema>;

export const OdometerReadingSchema = z.object({
  id: z.string(),
  unitId: z.string(),
  unitNumber: z.string(),
  readingAt: z.string(),
  /** The calendar date of the reading in the company's timezone; one usable reading per day. */
  readingDate: z.string(),
  odometerMiles: z.number().int(),
  engineHours: z.number().nullable(),
  source: z.enum(ODOMETER_SOURCES),
  status: z.enum(ODOMETER_READING_STATUSES),
  conflictReason: z.enum(ODOMETER_CONFLICT_REASONS).nullable(),
  /** What the reading was checked against, when it conflicted. */
  conflictWith: z.number().int().nullable(),
  photoId: z.string().nullable(),
  note: z.string().nullable(),
  /**
   * The importer could not date this reading (the sheet's export time was unknown), so it is the
   * last known value and nothing more: it never produces a due status (04-sheet-import §6).
   */
  ageUnknown: z.boolean(),
  createdBy: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
});
export type OdometerReading = z.infer<typeof OdometerReadingSchema>;

/** A reading entered by a person (§6.4), or written by the importer / a service invoice. */
export const CreateReadingSchema = z.object({
  unitId: z.string().min(1),
  readingAt: z.string().min(1, 'Say when the reading was taken'),
  odometerMiles: z.number().int().min(0).max(2_000_000),
  engineHours: z.number().min(0).nullable().default(null),
  source: z.enum(['manual', 'invoice', 'import']).default('manual'),
  photoId: z.string().nullable().default(null),
  note: z.string().trim().max(500).nullable().default(null),
});
export type CreateReadingInput = z.infer<typeof CreateReadingSchema>;
export type CreateReadingRequest = z.input<typeof CreateReadingSchema>;

/** The cached verdict per unit and service (§3.3). Never written by hand. */
export const PmStatusSchema = z.object({
  unitId: z.string(),
  unitNumber: z.string(),
  unitStatus: z.string(),
  groupName: z.string().nullable(),
  pmResponsibility: z.enum(PM_RESPONSIBILITIES),
  lessorName: z.string().nullable(),
  serviceCode: z.enum(PM_SERVICE_CODES),
  lastServiceId: z.string().nullable(),
  lastServiceAt: z.string().nullable(),
  lastServiceOdometer: z.number().int().nullable(),
  /** Where the baseline came from: a recorded completion, the import, or the older settings row. */
  lastServiceSource: z.enum(['completion', 'import', 'baseline']).nullable(),
  intervalMiles: z.number().int().nullable(),
  intervalDays: z.number().int().nullable(),
  intervalHours: z.number().int().nullable(),
  planOrigin: z.enum(PM_PLAN_ORIGINS).nullable(),
  planId: z.string().nullable(),
  dueSoonMiles: z.number().int().nullable(),
  dueSoonDays: z.number().int().nullable(),
  nextServiceOdometer: z.number().int().nullable(),
  nextServiceDate: z.string().nullable(),
  milesSinceService: z.number().int().nullable(),
  milesRemaining: z.number().int().nullable(),
  daysSinceService: z.number().int().nullable(),
  daysRemaining: z.number().int().nullable(),
  avgMilesPerDay: z.number().nullable(),
  avgBasis: z.enum(PM_AVG_BASES).nullable(),
  estimatedDueDate: z.string().nullable(),
  dueStatus: z.enum(PM_DUE_STATUSES),
  dueBasis: z.enum(PM_DUE_BASES).nullable(),
  /** For `overdue_at_least`: the miles the stale reading was already past due. */
  milesOverAtReading: z.number().int().nullable(),
  readingId: z.string().nullable(),
  readingAt: z.string().nullable(),
  readingOdometer: z.number().int().nullable(),
  readingSource: z.enum(ODOMETER_SOURCES).nullable(),
  readingAgeHours: z.number().nullable(),
  readingStale: z.boolean(),
  /** True when the reading shown is a last known value with no date behind it. */
  readingAgeUnknown: z.boolean(),
  computedAt: z.string(),
});
export type PmStatus = z.infer<typeof PmStatusSchema>;

// ------------------------------------------------------------------------------ rules

const DAY_MS = 86_400_000;

/** A calendar date (`yyyy-mm-dd`) in a timezone. */
export function dateInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(at);
}

export function addDaysToDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export interface PlanCandidate {
  id: string;
  intervalMiles: number;
  intervalDays: number | null;
  intervalHours: number | null;
  dueSoonMiles: number | null;
  dueSoonDays: number | null;
}

export interface ResolvedPlan extends PlanCandidate {
  origin: PmPlanOrigin;
}

/** §3.2: unit plan → group plan → the group's starting default → the fleet fallback. */
export function resolvePlan(
  input: {
    unitPlan: PlanCandidate | null;
    groupPlan: PlanCandidate | null;
    groupName: string | null;
  },
  settings: PmSettings = PM_SETTINGS,
): ResolvedPlan | null {
  if (input.unitPlan) return { ...input.unitPlan, origin: 'unit' };
  if (input.groupPlan) return { ...input.groupPlan, origin: 'group' };
  const starting = input.groupName ? settings.groupIntervalMiles[input.groupName] : undefined;
  if (starting !== undefined) {
    return {
      id: `default:${input.groupName}`,
      intervalMiles: starting,
      intervalDays: null,
      intervalHours: null,
      dueSoonMiles: null,
      dueSoonDays: null,
      origin: 'group',
    };
  }
  if (settings.fleetIntervalMiles > 0) {
    return {
      id: 'default:fleet',
      intervalMiles: settings.fleetIntervalMiles,
      intervalDays: null,
      intervalHours: null,
      dueSoonMiles: null,
      dueSoonDays: null,
      origin: 'fleet',
    };
  }
  return null;
}

/**
 * §3.4: a reading below the last good one, or more than `maxMilesPerDay` above it, is a conflict.
 * Null means the reading stands. A same-moment reading from a less trusted source is not a
 * conflict, just not the one that drives the board.
 */
export function readingConflict(
  previous: { odometerMiles: number; readingAt: string } | null,
  candidate: { odometerMiles: number; readingAt: string },
  settings: PmSettings = PM_SETTINGS,
): OdometerConflictReason | null {
  if (!previous) return null;
  if (candidate.odometerMiles < previous.odometerMiles) return 'below_previous';
  const days = Math.max(
    1,
    (Date.parse(candidate.readingAt) - Date.parse(previous.readingAt)) / DAY_MS,
  );
  // Far past anything a truck can drive: a mistyped figure, said as such (owner, 2026-10-22).
  if ((candidate.odometerMiles - previous.odometerMiles) / days > ODOMETER_MAX_JUMP_MILES)
    return 'implausible_jump';
  if ((candidate.odometerMiles - previous.odometerMiles) / days > settings.maxMilesPerDay)
    return 'too_high_per_day';
  return null;
}

/**
 * The reading that drives the board: newest `ok`; at the same moment, the more trusted source
 * (§3.4). A reading whose age is unknown is not usable: it is shown as the last known value only.
 */
export function newestUsableReading<
  T extends {
    readingAt: string;
    source: OdometerSource;
    status: OdometerReadingStatus;
    ageUnknown?: boolean;
  },
>(readings: readonly T[]): T | null {
  let best: T | null = null;
  for (const reading of readings) {
    if (reading.status !== 'ok' || reading.ageUnknown) continue;
    if (!best) {
      best = reading;
      continue;
    }
    const later = Date.parse(reading.readingAt) - Date.parse(best.readingAt);
    if (
      later > 0 ||
      (later === 0 && ODOMETER_SOURCE_RANK[reading.source] < ODOMETER_SOURCE_RANK[best.source])
    )
      best = reading;
  }
  return best;
}

/** The newest `ok` reading of any age, dated or not: what a row shows when nothing is usable. */
export function newestKnownReading<
  T extends {
    readingAt: string;
    odometerMiles: number;
    source: OdometerSource;
    status: OdometerReadingStatus;
    ageUnknown?: boolean;
  },
>(readings: readonly T[]): T | null {
  let best: T | null = null;
  for (const reading of readings) {
    if (reading.status !== 'ok') continue;
    if (!best || Date.parse(reading.readingAt) > Date.parse(best.readingAt)) best = reading;
  }
  return best;
}

/**
 * §5: miles over a window ÷ the days it spans, from usable readings. Null when the window holds
 * fewer than two readings on different days, or spans under one day.
 */
export function averageMilesPerDay(
  readings: readonly { readingAt: string; odometerMiles: number; status: OdometerReadingStatus }[],
  now: Date,
  windowDays: number,
): number | null {
  const since = now.getTime() - windowDays * DAY_MS;
  const usable = readings
    .filter(
      (r) =>
        r.status === 'ok' &&
        !(r as { ageUnknown?: boolean }).ageUnknown &&
        Date.parse(r.readingAt) >= since &&
        Date.parse(r.readingAt) <= now.getTime(),
    )
    .sort((a, b) => Date.parse(a.readingAt) - Date.parse(b.readingAt));
  const first = usable[0];
  const last = usable[usable.length - 1];
  if (!first || !last || first === last) return null;
  const spanDays = (Date.parse(last.readingAt) - Date.parse(first.readingAt)) / DAY_MS;
  if (spanDays < 1) return null;
  return (last.odometerMiles - first.odometerMiles) / spanDays;
}

export function median(values: readonly number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** §5: today + miles remaining ÷ average, rounded to the day; nothing below the minimum average. */
export function estimatedDueDate(
  milesRemaining: number,
  avgMilesPerDay: number | null,
  today: string,
  settings: PmSettings = PM_SETTINGS,
): string | null {
  if (avgMilesPerDay === null || avgMilesPerDay < settings.minAvgMilesPerDayForEstimate)
    return null;
  const days = Math.round(milesRemaining / avgMilesPerDay);
  return addDaysToDate(today, Math.max(0, days));
}

export interface ComputeInput {
  unit: {
    id: string;
    unitNumber: string;
    status: string;
    groupName: string | null;
    pmResponsibility: PmResponsibility;
    lessorName: string | null;
  };
  serviceCode: PmServiceCode;
  plan: ResolvedPlan | null;
  lastService: {
    id: string | null;
    at: string;
    odometerMiles: number;
    source: 'completion' | 'import' | 'baseline';
  } | null;
  /** Every reading on the unit that could matter, any status; the rules pick. */
  readings: readonly {
    id: string;
    readingAt: string;
    odometerMiles: number;
    source: OdometerSource;
    status: OdometerReadingStatus;
    ageUnknown?: boolean;
  }[];
  /** The median 30-day average across the unit's group, for the last fallback. */
  groupMedianAvg: number | null;
  now: Date;
  timeZone: string;
  settings?: PmSettings;
}

const SEVERITY: Record<'overdue' | 'due_soon' | 'ok', number> = { overdue: 2, due_soon: 1, ok: 0 };

/** §4 and §5 in one place. Pure: the same input gives the same verdict on every screen. */
export function computePmStatus(input: ComputeInput): PmStatus {
  const settings = input.settings ?? PM_SETTINGS;
  const today = dateInZone(input.now, input.timeZone);
  const reading = newestUsableReading(input.readings);
  // With nothing usable, the last known value is still shown - undated, and never counted.
  const lastKnown = reading ?? newestKnownReading(input.readings);
  const readingAgeUnknown = reading === null && lastKnown !== null;
  const readingAgeHours = reading
    ? (input.now.getTime() - Date.parse(reading.readingAt)) / 3_600_000
    : null;
  const readingStale =
    reading === null || (readingAgeHours as number) > settings.staleReadingDays * 24;

  const base: PmStatus = {
    unitId: input.unit.id,
    unitNumber: input.unit.unitNumber,
    unitStatus: input.unit.status,
    groupName: input.unit.groupName,
    pmResponsibility: input.unit.pmResponsibility,
    lessorName: input.unit.lessorName,
    serviceCode: input.serviceCode,
    lastServiceId: input.lastService?.id ?? null,
    lastServiceAt: input.lastService?.at ?? null,
    lastServiceOdometer: input.lastService?.odometerMiles ?? null,
    lastServiceSource: input.lastService?.source ?? null,
    intervalMiles: input.plan?.intervalMiles ?? null,
    intervalDays: input.plan?.intervalDays ?? null,
    intervalHours: input.plan?.intervalHours ?? null,
    planOrigin: input.plan?.origin ?? null,
    planId: input.plan?.id ?? null,
    dueSoonMiles: input.plan
      ? dueSoonMilesFor(input.plan.intervalMiles, input.plan.dueSoonMiles, settings)
      : null,
    dueSoonDays: input.plan ? (input.plan.dueSoonDays ?? settings.dueSoonDays) : null,
    nextServiceOdometer: null,
    nextServiceDate: null,
    milesSinceService: null,
    milesRemaining: null,
    daysSinceService: null,
    daysRemaining: null,
    avgMilesPerDay: null,
    avgBasis: null,
    estimatedDueDate: null,
    dueStatus: 'no_interval',
    dueBasis: null,
    milesOverAtReading: null,
    readingId: lastKnown?.id ?? null,
    readingAt: reading?.readingAt ?? null,
    readingOdometer: lastKnown?.odometerMiles ?? null,
    readingSource: lastKnown?.source ?? null,
    readingAgeHours: readingAgeHours === null ? null : Math.round(readingAgeHours * 10) / 10,
    readingStale,
    readingAgeUnknown,
    computedAt: input.now.toISOString(),
  };

  if (!input.plan) return base;
  if (!input.lastService) return { ...base, dueStatus: 'no_baseline' };

  // -- the average, with its fallbacks (§5)
  let avg = averageMilesPerDay(input.readings, input.now, 30);
  let avgBasis: PmAvgBasis | null = avg === null ? null : '30d';
  if (avg === null) {
    avg = averageMilesPerDay(input.readings, input.now, 60);
    avgBasis = avg === null ? null : '60d';
  }
  if (avg === null && input.groupMedianAvg !== null) {
    avg = input.groupMedianAvg;
    avgBasis = 'group_median';
  }

  // -- the day limit, which needs no reading
  const lastServiceDate = dateInZone(new Date(input.lastService.at), input.timeZone);
  const daysSinceService = daysBetweenDates(lastServiceDate, today);
  const nextServiceDate = input.plan.intervalDays
    ? addDaysToDate(lastServiceDate, input.plan.intervalDays)
    : null;
  const daysRemaining = nextServiceDate ? daysBetweenDates(today, nextServiceDate) : null;
  const dayStatus: 'overdue' | 'due_soon' | 'ok' | null =
    daysRemaining === null
      ? null
      : daysRemaining < 0
        ? 'overdue'
        : daysRemaining <= (base.dueSoonDays as number)
          ? 'due_soon'
          : 'ok';

  // -- the mile limit, from the reading
  const nextServiceOdometer = input.lastService.odometerMiles + input.plan.intervalMiles;
  const withDays: PmStatus = {
    ...base,
    nextServiceOdometer,
    nextServiceDate,
    daysSinceService,
    daysRemaining,
    avgMilesPerDay: avg === null ? null : Math.round(avg * 10) / 10,
    avgBasis,
  };

  if (!reading || readingStale) {
    // A day limit already past is overdue whatever the odometer says.
    if (dayStatus === 'overdue') return { ...withDays, dueStatus: 'overdue', dueBasis: 'days' };
    if (reading && reading.odometerMiles >= nextServiceOdometer) {
      return {
        ...withDays,
        milesSinceService: reading.odometerMiles - input.lastService.odometerMiles,
        milesRemaining: nextServiceOdometer - reading.odometerMiles,
        milesOverAtReading: reading.odometerMiles - nextServiceOdometer,
        dueStatus: 'overdue_at_least',
        dueBasis: 'miles',
      };
    }
    if (dayStatus === 'due_soon') return { ...withDays, dueStatus: 'due_soon', dueBasis: 'days' };
    return { ...withDays, dueStatus: 'no_reading', dueBasis: null };
  }

  const milesSinceService = reading.odometerMiles - input.lastService.odometerMiles;
  const milesRemaining = nextServiceOdometer - reading.odometerMiles;
  const mileStatus: 'overdue' | 'due_soon' | 'ok' =
    milesRemaining < 0
      ? 'overdue'
      : milesRemaining <= (withDays.dueSoonMiles as number)
        ? 'due_soon'
        : 'ok';
  const estimated = estimatedDueDate(milesRemaining, avg, today, settings);

  // -- whichever comes first (§5)
  let dueStatus: PmDueStatus = mileStatus;
  let dueBasis: PmDueBasis = 'miles';
  if (dayStatus !== null) {
    if (SEVERITY[dayStatus] > SEVERITY[mileStatus]) {
      dueStatus = dayStatus;
      dueBasis = 'days';
    } else if (SEVERITY[dayStatus] === SEVERITY[mileStatus] && daysRemaining !== null) {
      // Same state on both: the one arriving sooner is the basis. Miles arrive at the estimate.
      const milesInDays =
        avg !== null && avg >= settings.minAvgMilesPerDayForEstimate ? milesRemaining / avg : null;
      if (milesInDays === null || daysRemaining < milesInDays) dueBasis = 'days';
    }
  }

  return {
    ...withDays,
    milesSinceService,
    milesRemaining,
    estimatedDueDate: estimated,
    dueStatus,
    dueBasis,
  };
}

/** "5,221 mi over" / "1,468 mi left": never a negative number on a screen (§5). */
export function milesRemainingLabel(milesRemaining: number): string {
  const n = Math.abs(milesRemaining).toLocaleString('en-US');
  return milesRemaining < 0 ? `${n} mi over` : `${n} mi left`;
}

/** The row's first line for a status (§4.1, Appendix B). */
export function pmStatusLine(status: PmStatus): string {
  switch (status.dueStatus) {
    case 'overdue':
      return status.dueBasis === 'days' && status.daysRemaining !== null
        ? `Overdue · ${Math.abs(status.daysRemaining)} d over the time limit`
        : `Overdue · ${milesRemainingLabel(status.milesRemaining ?? 0)}`;
    case 'overdue_at_least':
      return `Overdue · ≥ ${(status.milesOverAtReading ?? 0).toLocaleString('en-US')} mi over`;
    case 'due_soon':
      return status.dueBasis === 'days' && status.daysRemaining !== null
        ? `Due soon · ${status.daysRemaining} d left`
        : `Due soon · ${milesRemainingLabel(status.milesRemaining ?? 0)}`;
    case 'ok':
      return `OK · ${milesRemainingLabel(status.milesRemaining ?? 0)}`;
    case 'no_reading':
      return "No reading — can't tell";
    case 'no_baseline':
      return 'No service on record';
    case 'no_interval':
      return 'No interval set';
  }
}
