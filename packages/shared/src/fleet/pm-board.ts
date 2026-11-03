import { z } from 'zod';
import { PM_SERVICE_CODES, PmStatusSchema, type PmStatus } from './pm.js';

/**
 * The Oil change / PM board (docs/pm-module/02-pm-spec.md §7, reference/pm-proposal.html
 * mockup A), the Schedule service sheet (§6.1, mockup B) and Record completion (§6.2, mockup C).
 *
 * Everything a row shows is computed on the server from `pm_status`, the work orders and the
 * roster: the screen never adds up fleet numbers itself. The rules here are pure so both sides
 * read the same answer.
 */

/** Where the odometer at the service may differ from the ELD before a reason is asked (§6.2). */
export const PM_ODOMETER_TOLERANCE_MILES = 100;
/** Bundle other work due within this many days into the same visit (§6.1). */
export const PM_BUNDLE_WINDOW_DAYS = 30;
/** The Dispatch hold an appointment places, in minutes (§3.7). */
export const PM_DEFAULT_HOLD_MINUTES = 120;
/** What the board counts an oil change against, for the on-time rate (§7 summary). */
export const PM_ON_TIME_WINDOW_DAYS = 90;

export const PM_NEXT_STEPS = [
  'set_interval',
  'get_reading',
  'send_to_lessor',
  'record_completion',
  'open',
  'schedule',
] as const;
export type PmNextStep = (typeof PM_NEXT_STEPS)[number];

export const PM_ZERO_REASONS = ['lease', 'warranty', 'goodwill', 'in_house'] as const;
export type PmZeroReason = (typeof PM_ZERO_REASONS)[number];

export const PM_ZERO_REASON_LABEL: Record<PmZeroReason, string> = {
  lease: 'Covered by the lease',
  warranty: 'Under warranty',
  goodwill: 'Goodwill / no charge',
  in_house: 'Done in-house, no invoice',
};

/** The checklist a completion records (§6.2). Oil & filter is the one that resets the clock. */
export const PM_WORK_ITEMS = [
  'oil_filter',
  'fuel_filters',
  'fuel_separator',
  'air_filter',
  'cabin_filter',
  'grease',
] as const;
export type PmWorkItem = (typeof PM_WORK_ITEMS)[number];

export const PM_WORK_ITEM_LABEL: Record<PmWorkItem, { label: string; note: string }> = {
  oil_filter: { label: 'Oil & filter change', note: 'the only item that resets the clock' },
  fuel_filters: { label: 'Fuel filters', note: 'included in the PM package' },
  fuel_separator: { label: 'Fuel separator filter', note: '' },
  air_filter: { label: 'Air filter', note: '' },
  cabin_filter: { label: 'Cabin filter', note: '' },
  grease: { label: 'Fifth wheel grease', note: '' },
};

export const PmAppointmentSchema = z.object({
  workOrderId: z.string(),
  workOrderNumber: z.string(),
  scheduledFor: z.string(),
  vendorId: z.string().nullable(),
  vendorName: z.string(),
  responsibleUserId: z.string().nullable(),
  responsibleName: z.string().nullable(),
  /** Present only for a reader with the cost permission. */
  estimatedCost: z.number().nullable().optional(),
  noteForShop: z.string().nullable(),
  holdMinutes: z.number().int(),
  /** The truck has arrived: the work order moved to `in_shop`. */
  inShop: z.boolean(),
});
export type PmAppointment = z.infer<typeof PmAppointmentSchema>;

export const PmLastServiceSchema = z.object({
  workOrderId: z.string().nullable(),
  at: z.string(),
  odometer: z.number().int(),
  vendorName: z.string().nullable(),
  cost: z.number().nullable().optional(),
  invoiceNumber: z.string().nullable(),
  source: z.enum(['completion', 'import', 'baseline']),
});
export type PmLastService = z.infer<typeof PmLastServiceSchema>;

export const PmNextStopSchema = z.object({
  kind: z.enum(['pickup', 'delivery']),
  city: z.string(),
  state: z.string(),
  at: z.string(),
  timezone: z.string(),
  loadNumber: z.string(),
});
export type PmNextStop = z.infer<typeof PmNextStopSchema>;

export const PmBoardRowSchema = PmStatusSchema.extend({
  driverName: z.string().nullable(),
  location: z.object({ city: z.string(), state: z.string(), updatedAt: z.string() }).nullable(),
  nextStop: PmNextStopSchema.nullable(),
  /** The next few stops from Dispatch, for the schedule sheet's route strip (§6.1). */
  route: z.array(PmNextStopSchema),
  appointment: PmAppointmentSchema.nullable(),
  lastService: PmLastServiceSchema.nullable(),
  /** Other work due on the unit that a visit could cover (annual inspection, open defects). */
  alsoDue: z.array(z.object({ key: z.string(), label: z.string(), detail: z.string() })),
  nextStep: z.enum(PM_NEXT_STEPS),
  /** For `overdue`, how far past the interval as a share of it - the sort key (§7). */
  pctOver: z.number().nullable(),
});
export type PmBoardRow = z.infer<typeof PmBoardRowSchema>;

export const PmBoardSummarySchema = z.object({
  total: z.number().int(),
  overdue: z.number().int(),
  overdueWorstMiles: z.number().int().nullable(),
  overdueTotalMiles: z.number().int(),
  dueSoon: z.number().int(),
  dueSoonThisWeek: z.number().int(),
  booked: z.number().int(),
  bookedToday: z.number().int(),
  bookedAtOwnYard: z.number().int(),
  bookedOverdue: z.number().int(),
  noReading: z.number().int(),
  noReadingStale: z.number().int(),
  noReadingNever: z.number().int(),
  leaseDue: z.number().int(),
  leaseNames: z.array(z.string()),
  /** Completions in the window, and how many landed inside their interval. */
  onTime: z.object({ done: z.number().int(), onTime: z.number().int() }),
  /** Average invoice total per oil change in the window; null until there is one with a cost. */
  avgCost: z.number().nullable().optional(),
  ownYardAvgCost: z.number().nullable().optional(),
  computedAt: z.string(),
});
export type PmBoardSummary = z.infer<typeof PmBoardSummarySchema>;

export const PmBoardSchema = z.object({
  rows: z.array(PmBoardRowSchema),
  summary: PmBoardSummarySchema,
});
export type PmBoard = z.infer<typeof PmBoardSchema>;

// ------------------------------------------------------------------------------ expanded row

export const PmServiceHistoryRowSchema = z.object({
  workOrderId: z.string(),
  number: z.string(),
  at: z.string(),
  odometer: z.number().int().nullable(),
  /** Miles since the previous completion, when both odometers are known. */
  milesRun: z.number().int().nullable(),
  vendorName: z.string(),
  cost: z.number().nullable().optional(),
  invoiceNumber: z.string().nullable(),
  invoiceFileIds: z.array(z.string()),
  source: z.enum(['completion', 'import']),
  historic: z.boolean(),
});
export type PmServiceHistoryRow = z.infer<typeof PmServiceHistoryRowSchema>;

export const PmUnitDetailSchema = z.object({
  unitId: z.string(),
  services: z.array(PmServiceHistoryRowSchema),
  averageMilesBetween: z.number().int().nullable(),
  plan: z
    .object({
      intervalMiles: z.number().int(),
      intervalDays: z.number().int().nullable(),
      intervalHours: z.number().int().nullable(),
      origin: z.enum(['unit', 'group', 'fleet']),
      setByName: z.string().nullable(),
      setAt: z.string().nullable(),
      reason: z.string().nullable(),
      groupName: z.string().nullable(),
      groupIntervalMiles: z.number().int().nullable(),
      groupUnitCount: z.number().int(),
    })
    .nullable(),
  readings: z.array(
    z.object({
      id: z.string(),
      readingAt: z.string(),
      odometerMiles: z.number().int(),
      source: z.string(),
      status: z.string(),
      ageUnknown: z.boolean(),
      usedForRow: z.boolean(),
      deltaMiles: z.number().int().nullable(),
    }),
  ),
  corrections: z.array(
    z.object({
      id: z.string(),
      at: z.string(),
      byName: z.string(),
      summary: z.string(),
      reason: z.string().nullable(),
    }),
  ),
});
export type PmUnitDetail = z.infer<typeof PmUnitDetailSchema>;

export const CreatePmShopSchema = z.object({
  name: z.string().trim().min(2, 'Name the shop').max(120),
  city: z.string().trim().max(80).nullable().default(null),
  state: z.string().trim().max(2).nullable().default(null),
  isOwnYard: z.boolean().default(false),
});
export type CreatePmShopInput = z.infer<typeof CreatePmShopSchema>;
export type CreatePmShopRequest = z.input<typeof CreatePmShopSchema>;

export const PmShopSchema = z.object({
  id: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  isOwnYard: z.boolean(),
  visits: z.number().int(),
  lastVisitAt: z.string().nullable(),
  lastPrice: z.number().nullable().optional(),
  avgPrice: z.number().nullable().optional(),
  /** Street line, version and whether the name is really an address (owner, 2026-10-19). */
  addressLine: z.string().nullable().optional(),
  version: z.number().int().optional(),
  needsName: z.boolean().optional(),
});
export type PmShop = z.infer<typeof PmShopSchema>;

/**
 * A shop whose name is its address: the oil-change import only had the address (owner, 2026-10-19:
 * every page should say the shop's name). A name starting with a house number reads as an address.
 */
export function shopNameIsAddress(name: string): boolean {
  return /^\s*\d+\s+\S/.test(name);
}

export const RenamePmShopSchema = z.object({
  name: z.string().trim().min(2, 'Name the shop').max(120),
  version: z.number().int().min(1),
});
export type RenamePmShopInput = z.infer<typeof RenamePmShopSchema>;

// ------------------------------------------------------------------------------ writes

export const SchedulePmSchema = z.object({
  unitId: z.string().min(1),
  serviceCode: z.enum(PM_SERVICE_CODES).default('OIL_CHANGE'),
  vendorId: z.string().min(1, 'Pick the shop'),
  /** ISO instant. Shown in the shop's zone on the screen. */
  scheduledFor: z.string().min(1, 'Pick the date and time'),
  responsibleUserId: z.string().min(1, 'Say who is responsible'),
  estimatedCost: z.number().nonnegative().nullable().optional(),
  noteForShop: z.string().trim().max(2000).nullable().optional(),
  notifyDriver: z.boolean().default(true),
  notifyDispatcher: z.boolean().default(true),
  holdMinutes: z.number().int().positive().default(PM_DEFAULT_HOLD_MINUTES),
  /** Other work to do on the same visit: `annual_inspection`, or a defect id. */
  bundle: z.array(z.string()).default([]),
  /** When the unit already has an open appointment, the caller says it may be moved. */
  moveExisting: z.boolean().default(false),
});
export type SchedulePmInput = z.infer<typeof SchedulePmSchema>;
export type SchedulePmRequest = z.input<typeof SchedulePmSchema>;

export const OtherWorkLineSchema = z.object({
  systemCode: z.string().min(1),
  description: z.string().trim().min(1).max(200),
  amount: z.number().nonnegative(),
});
export type OtherWorkLine = z.infer<typeof OtherWorkLineSchema>;

export const CompletePmSchema = z
  .object({
    unitId: z.string().min(1),
    serviceCode: z.enum(PM_SERVICE_CODES).default('OIL_CHANGE'),
    /** The appointment being completed, when there is one. */
    workOrderId: z.string().nullable().optional(),
    serviceAt: z.string().min(1, 'When was it done?'),
    serviceOdometer: z.number().int().nonnegative(),
    /** Required when the reading is more than the tolerance away from the ELD's. */
    odometerReason: z.string().trim().max(500).nullable().optional(),
    work: z.array(z.enum(PM_WORK_ITEMS)).min(1),
    otherLines: z.array(OtherWorkLineSchema).default([]),
    vendorId: z.string().min(1, 'Pick the shop'),
    invoiceTotal: z.number().nonnegative(),
    zeroReason: z.enum(PM_ZERO_REASONS).nullable().optional(),
    invoiceNumber: z.string().trim().max(60).nullable().optional(),
    invoiceFileIds: z.array(z.string()).default([]),
  })
  .superRefine((value, ctx) => {
    if (!value.work.includes('oil_filter')) {
      ctx.addIssue({
        code: 'custom',
        path: ['work'],
        message: 'Oil & filter is required to record an oil change',
      });
    }
    if (value.invoiceTotal === 0 && !value.zeroReason) {
      ctx.addIssue({
        code: 'custom',
        path: ['zeroReason'],
        message: 'A $0 invoice needs a reason',
      });
    }
  });
export type CompletePmInput = z.infer<typeof CompletePmSchema>;
export type CompletePmRequest = z.input<typeof CompletePmSchema>;

export const CorrectPmSchema = z.object({
  serviceAt: z.string().optional(),
  serviceOdometer: z.number().int().nonnegative().optional(),
  reason: z.string().trim().min(3, 'Say why').max(500),
});
export type CorrectPmInput = z.infer<typeof CorrectPmSchema>;

export const VoidPmCompletionSchema = z.object({
  reason: z.string().trim().min(3, 'Say why').max(500),
});
export type VoidPmCompletionInput = z.infer<typeof VoidPmCompletionSchema>;

// ------------------------------------------------------------------------------ rules

/**
 * The one button a row gets (§7): first match wins. The board never asks the person to work
 * out which of six things a truck needs.
 */
export function nextStepFor(input: {
  dueStatus: PmStatus['dueStatus'];
  pmResponsibility: PmStatus['pmResponsibility'];
  appointment: { scheduledFor: string; inShop: boolean } | null;
  now: string;
}): PmNextStep {
  if (input.dueStatus === 'no_interval') return 'set_interval';
  if (input.dueStatus === 'no_reading') return 'get_reading';
  if (input.dueStatus === 'no_baseline') return 'record_completion';
  if (input.pmResponsibility === 'lessor') return 'send_to_lessor';
  if (input.appointment) {
    const due = Date.parse(input.appointment.scheduledFor) <= Date.parse(input.now);
    if (input.appointment.inShop || due) return 'record_completion';
    return 'open';
  }
  return 'schedule';
}

export function nextStepLabel(step: PmNextStep, lessorName: string | null): string {
  switch (step) {
    case 'set_interval':
      return 'Set interval';
    case 'get_reading':
      return 'Get reading';
    case 'send_to_lessor':
      return `Send to ${lessorName ?? 'lessor'}`;
    case 'record_completion':
      return 'Record completion';
    case 'open':
      return 'Open';
    default:
      return 'Schedule';
  }
}

/** Board order (§7): overdue by share over the interval, due soon by date, booked, the rest. */
export function boardRank(
  row: Pick<
    PmBoardRow,
    'dueStatus' | 'milesRemaining' | 'estimatedDueDate' | 'appointment' | 'milesOverAtReading'
  >,
): [number, number] {
  switch (row.dueStatus) {
    case 'overdue':
      // Most miles over first - the mockup's order and the strip's 'worst N mi' (spec open question 6).
      return [0, row.milesRemaining ?? 0];
    case 'overdue_at_least':
      return [1, -(row.milesOverAtReading ?? 0)];
    case 'due_soon':
      return [2, row.estimatedDueDate ? Date.parse(row.estimatedDueDate) : Number.MAX_SAFE_INTEGER];
    case 'no_reading':
    case 'no_baseline':
    case 'no_interval':
      return [3, 0];
    default:
      return [
        row.appointment ? 4 : 5,
        row.estimatedDueDate ? Date.parse(row.estimatedDueDate) : Number.MAX_SAFE_INTEGER,
      ];
  }
}

export function sortBoardRows<
  T extends Pick<
    PmBoardRow,
    | 'dueStatus'
    | 'milesRemaining'
    | 'estimatedDueDate'
    | 'appointment'
    | 'milesOverAtReading'
    | 'unitNumber'
  >,
>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => {
    const [ga, ka] = boardRank(a);
    const [gb, kb] = boardRank(b);
    if (ga !== gb) return ga - gb;
    if (ka !== kb) return ka - kb;
    return a.unitNumber.localeCompare(b.unitNumber, undefined, { numeric: true });
  });
}

/** An oil change was on time when it ran no further than the interval it was set to (§7). */
export function completionOnTime(input: {
  previousOdometer: number | null;
  serviceOdometer: number;
  intervalMiles: number | null;
}): boolean | null {
  if (input.previousOdometer === null || input.intervalMiles === null) return null;
  return input.serviceOdometer - input.previousOdometer <= input.intervalMiles;
}

/**
 * The odometer at the service against the nearest ELD reading (§6.2): within the tolerance it is
 * trusted; beyond it a reason is required before saving.
 */
export function odometerCheck(input: {
  serviceOdometer: number;
  eldOdometer: number | null;
  eldAt: string | null;
  tolerance?: number;
}): { verdict: 'trusted' | 'needs_reason' | 'no_eld'; gapMiles: number | null } {
  if (input.eldOdometer === null) return { verdict: 'no_eld', gapMiles: null };
  const gap = Math.abs(input.serviceOdometer - input.eldOdometer);
  return {
    verdict: gap > (input.tolerance ?? PM_ODOMETER_TOLERANCE_MILES) ? 'needs_reason' : 'trusted',
    gapMiles: gap,
  };
}

/** What a completion will do, said before the save (mockup C's "When you save"). */
export function completionPreview(input: {
  serviceOdometer: number;
  intervalMiles: number | null;
  previousServiceOdometer: number | null;
  avgMilesPerDay: number | null;
  serviceAt: string;
}): {
  nextServiceOdometer: number | null;
  estimatedNextDate: string | null;
  milesRun: number | null;
  ranOverBy: number | null;
} {
  const next = input.intervalMiles === null ? null : input.serviceOdometer + input.intervalMiles;
  const milesRun =
    input.previousServiceOdometer === null
      ? null
      : input.serviceOdometer - input.previousServiceOdometer;
  const ranOverBy =
    milesRun !== null && input.intervalMiles !== null && milesRun > input.intervalMiles
      ? milesRun - input.intervalMiles
      : null;
  let estimatedNextDate: string | null = null;
  if (input.intervalMiles !== null && input.avgMilesPerDay && input.avgMilesPerDay > 0) {
    const days = Math.round(input.intervalMiles / input.avgMilesPerDay);
    const at = new Date(input.serviceAt);
    if (!Number.isNaN(at.getTime())) {
      at.setUTCDate(at.getUTCDate() + days);
      estimatedNextDate = at.toISOString().slice(0, 10);
    }
  }
  return { nextServiceOdometer: next, estimatedNextDate, milesRun, ranOverBy };
}
