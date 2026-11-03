import { z } from 'zod';
import { ROSTER_MAINTENANCE_TYPES } from '../roster/roster.js';

/**
 * The Fleet expense summary: what maintenance actually cost, by unit, vendor and service type.
 *
 * This is the contract between the API's aggregation and the Fleet landing page. Every number in
 * it is traceable: a figure carries the ids of the records it was summed from, a metric that could
 * not be computed says why, and the coverage block names what was counted and what was left out.
 * Nothing here is modelled or filled in — a metric with no supporting records is `null`, never 0.
 *
 * Spending basis: completed work orders, dated by their completion, at the order's canonical total
 * (the write path makes the latest amount-bearing invoice authoritative for that total), plus
 * standalone service records — those not linked to an order — dated by the service date. Anything
 * else is excluded and counted as such.
 */

export const FLEET_SPEND_PERIODS = ['week', 'month', 'quarter', 'year'] as const;
export type FleetSpendPeriod = (typeof FLEET_SPEND_PERIODS)[number];

export const FLEET_UNIT_TYPES = ['all', 'truck', 'trailer'] as const;
export type FleetUnitTypeFilter = (typeof FLEET_UNIT_TYPES)[number];

export const FleetExpenseQuerySchema = z.object({
  period: z.enum(FLEET_SPEND_PERIODS).default('year'),
  /** Comma-separated unit ids (trucks or trailers); absent means the whole fleet. */
  units: z.string().optional(),
  /** Trucks, trailers, or both. */
  unitType: z.enum(FLEET_UNIT_TYPES).default('all'),
  /**
   * With period=week: any day of the week to show (its Monday, as the dispatch week picker sends).
   * Absent means the current week to date (owner, 2026-10-09).
   */
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /** Any day of the week, month, quarter or year to show; absent = the current one (to date). */
  at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  /**
   * Maintenance only (work orders and service records), or all fleet costs: the Fleet Expenses
   * entered by hand (parking, truck wash, tolls ...) added beside them (owner, 2026-10-12).
   */
  scope: z.enum(['maintenance', 'all']).default('maintenance'),
  /**
   * A rolling window to today instead of the period (owner, 2026-10-13: the tire map's 30 days /
   * 90 days / 12 months). When given it wins over `period`, `at` and `week`.
   */
  window: z.enum(['7d', '30d', '90d', '12m']).optional(),
});

export const UnitKindSchema = z.enum(['truck', 'trailer']);
export type UnitKind = z.infer<typeof UnitKindSchema>;
export type FleetExpenseQuery = z.infer<typeof FleetExpenseQuerySchema>;
export type FleetExpenseQueryInput = z.input<typeof FleetExpenseQuerySchema>;

/** Fleet Expense categories that are not maintenance; they appear only in the All fleet costs scope. */
export const FLEET_EXTRA_SPEND_TYPES = ['cash_advance', 'parking', 'truck_wash', 'tolls', 'fuel', 'permits', 'scale', 'lumper', 'supplies'] as const;
export const MaintenanceTypeSchema = z.enum([...ROSTER_MAINTENANCE_TYPES, ...FLEET_EXTRA_SPEND_TYPES]);
export type MaintenanceTypeCode = z.infer<typeof MaintenanceTypeSchema>;

/** The labels the Maintenance pages already use; the summary speaks the same vocabulary. */
export const MAINTENANCE_TYPE_LABEL: Record<MaintenanceTypeCode, string> = {
  oil_change: 'Oil change',
  pm_service: 'PM service',
  brake_inspection: 'Brake inspection',
  brake_repair: 'Brake repair',
  tire_rotation: 'Tire rotation',
  tire_replacement: 'Tire replacement',
  dot_inspection: 'Annual DOT inspection',
  coolant: 'Coolant service',
  transmission: 'Transmission service',
  engine: 'Engine service',
  dpf: 'DPF cleaning',
  battery: 'Battery replacement',
  electrical: 'Electrical repair',
  lights: 'Lights & electrical',
  doors_seals: 'Doors & seals',
  floor_walls: 'Floor & walls',
  landing_gear: 'Landing gear',
  suspension: 'Suspension / airbags',
  reefer_unit: 'Reefer unit',
  other: 'Other',
  cash_advance: 'Cash advance',
  parking: 'Parking',
  truck_wash: 'Truck Wash',
  tolls: 'Tolls',
  fuel: 'Fuel',
  permits: 'Permits',
  scale: 'Scale',
  lumper: 'Lumper',
  supplies: 'Supplies',
};

/**
 * Scheduled upkeep, as opposed to a repair.
 *
 * A second oil change on the same unit within ninety days is the interval, not a failed fix; a
 * second brake repair is worth a look. The repeat-service rule uses this list to tell them apart.
 */
export const SCHEDULED_MAINTENANCE_TYPES: readonly MaintenanceTypeCode[] = [
  'oil_change',
  'pm_service',
  'tire_rotation',
  'dot_inspection',
  'brake_inspection',
  'coolant',
];

const IsoDate = z.iso.date();

/** One thing that was paid for: a completed order or a standalone service record. */
export const FleetSpendEventSchema = z.object({
  id: z.string(),
  /** `fleet_expense`: a Fleet Expense entered by hand, only in the All fleet costs scope. */
  kind: z.enum(['work_order', 'service_record', 'fleet_expense']),
  /** WO number for an order; the service description for a record. */
  reference: z.string(),
  /** The unit's id — a truck or a trailer; `unitKind` says which. */
  truckId: z.string(),
  unitKind: UnitKindSchema,
  unitNumber: z.string(),
  type: MaintenanceTypeSchema,
  /** Company-local date the spend is counted on: completion or service date. */
  date: IsoDate,
  vendorName: z.string().nullable(),
  /** The vendor record the order names, when it names one. */
  vendorId: z.string().nullable(),
  /** Cents-rounded dollars. Zero is a real zero; an unknown amount never becomes an event. */
  amount: z.number(),
  /** Where the amount came from, so an anomaly can be labelled honestly. */
  amountSource: z.enum(['invoice', 'work_order', 'service_record', 'fleet_expense']),
  /** Odometer recorded on the event, when the record carries one. */
  odometer: z.number().nullable(),
  /**
   * What was actually done, for a person reading a list of one category's records. The order's
   * own description, or the service record's; null when the source carries none, and never the
   * category's name dressed up as a description.
   */
  description: z.string().nullable(),
  /** The invoice on file, so a row can open it. Null means no invoice, not a broken link. */
  invoiceFileId: z.string().nullable(),
  /**
   * Who bears it (owner, 2026-10-13): the company, a driver, nobody decided yet
   * (investigation), the maker or shop under warranty, or the unit's owner. `driverShare` is
   * the part charged to a driver when only part of it is.
   */
  payer: z.enum(['company', 'driver', 'investigation', 'warranty', 'owner']).default('company'),
  driverShare: z.number().default(0),
});
export type FleetSpendEvent = z.infer<typeof FleetSpendEventSchema>;

/**
 * How much of the thing a figure claims to measure it actually measured.
 *
 * A cost per mile computed over a third of the fleet is not a fleet number, and printed without
 * that fact it is worse than no number at all: it gets acted on. So a figure carries its coverage,
 * and below the floor it is not shown at all - the coverage is shown instead.
 */
export const MetricConfidenceSchema = z.object({
  level: z.enum(['high', 'medium', 'low']),
  /** Share of the units in scope the figure could actually be measured over, 0-100. */
  coveragePct: z.number(),
  covered: z.number().int(),
  total: z.number().int(),
});
export type MetricConfidence = z.infer<typeof MetricConfidenceSchema>;

/** Fleet specification: 90% and up is High, 70-89% Medium, below 70% is not shown. */
export const METRIC_CONFIDENCE = { highPct: 90, mediumPct: 70 } as const;

/** What share of the scope was covered, and what that makes the figure worth. */
export function metricConfidence(covered: number, total: number): MetricConfidence {
  const coveragePct = total === 0 ? 0 : Math.round((covered / total) * 100);
  const level =
    coveragePct >= METRIC_CONFIDENCE.highPct
      ? 'high'
      : coveragePct >= METRIC_CONFIDENCE.mediumPct
        ? 'medium'
        : 'low';
  return { level, coveragePct, covered, total };
}

/**
 * Thresholds under which a percentage change says nothing.
 *
 * A period that spent $80 last time and $240 this time is "up 200%", which is a sentence about
 * three oil filters. The reader acts on percentages, so a percentage is only offered when the
 * base it is measured against is big enough to mean something.
 */
export const TREND_MIN_PRIOR_VALUE = 500;
export const TREND_MIN_PRIOR_EVENTS = 5;

/** Is a percentage change worth showing, given what it is measured against? */
export function trendIsMeaningful(previous: number | null, priorEvents: number): boolean {
  if (previous === null) return false;
  return Math.abs(previous) >= TREND_MIN_PRIOR_VALUE && priorEvents >= TREND_MIN_PRIOR_EVENTS;
}

/** A figure and the reason it is missing, when it is. Never a zero standing in for "unknown". */
export const FleetMetricSchema = z.object({
  value: z.number().nullable(),
  /** The same figure over the comparison range, with identical rules. */
  previous: z.number().nullable(),
  deltaPct: z.number().nullable(),
  /** Why `value` is null, or a qualification the reader must see. Empty when the figure is clean. */
  reasons: z.array(z.string()),
  /** What the figure measures, in one sentence, including its denominator or basis. */
  basis: z.string(),
  /** True for a figure about the present ("in shop now"), which is not a period figure. */
  current: z.boolean(),
  /** Ids of the exact records behind the figure. */
  recordIds: z.array(z.string()),
  /** Where the records can be opened; absent when nothing lists exactly them. */
  link: z
    .object({
      to: z.string(),
      search: z.record(z.string(), z.string()).optional(),
    })
    .nullable(),
  /** How much of the scope the figure covers. Null for a figure whose scope is everything. */
  confidence: MetricConfidenceSchema.nullable().default(null),
});
export type FleetMetric = z.infer<typeof FleetMetricSchema>;

export const FleetVendorRowSchema = z.object({
  /** The vendor id when the records name one; otherwise the normalised name, or `unknown`. */
  key: z.string(),
  vendorId: z.string().nullable(),
  /** The vendor record's name, or the name as written on the most recent record in the group. */
  name: z.string(),
  spend: z.number(),
  events: z.number().int(),
  truckCount: z.number().int(),
  recordIds: z.array(z.string()),
});
export type FleetVendorRow = z.infer<typeof FleetVendorRowSchema>;

export const FleetCategorySliceSchema = z.object({
  /**
   * What a link points at.
   *
   * `type` is not enough on its own: the ring's last slice folds the smaller categories together
   * and carries the type `other`, which is also a category in its own right. They are different
   * sets of records, so they get different keys - `all-other-types` for the roll-up.
   */
  key: z.string(),
  type: MaintenanceTypeSchema,
  label: z.string(),
  spend: z.number(),
  events: z.number().int(),
  /** Share of total spend, one decimal, as a percentage. */
  sharePct: z.number(),
  recordIds: z.array(z.string()),
});
export type FleetCategorySlice = z.infer<typeof FleetCategorySliceSchema>;

export const FleetServiceTypeRowSchema = z.object({
  type: MaintenanceTypeSchema,
  label: z.string(),
  events: z.number().int(),
  spend: z.number(),
  truckCount: z.number().int(),
  /** True when the type touched at least `widespreadThreshold` distinct units — a review signal. */
  widespread: z.boolean(),
  recordIds: z.array(z.string()),
});
export type FleetServiceTypeRow = z.infer<typeof FleetServiceTypeRowSchema>;

export const FleetVehicleRowSchema = z.object({
  truckId: z.string(),
  kind: UnitKindSchema,
  unitNumber: z.string(),
  /** Year, make and model. */
  description: z.string(),
  ownership: z.string(),
  /** Roster status as stored — the present state, not a period judgement. */
  status: z.string(),
  topType: MaintenanceTypeSchema.nullable(),
  topTypeLabel: z.string().nullable(),
  topTypeEvents: z.number().int(),
  events: z.number().int(),
  spend: z.number(),
  previousSpend: z.number().nullable(),
  /** `spend` against `previousSpend`; null when the prior range holds nothing. */
  trendPct: z.number().nullable(),
  /** Findings on this unit in the anomalies block. */
  flags: z.number().int(),
  recordIds: z.array(z.string()),
  /**
   * The work orders behind this unit's spend, newest first — `RO-2026-1010`.
   *
   * The breakdown is one line per unit and a unit can carry several orders in a period, so this
   * is a list rather than a number: the row shows the order when there is one and says how many
   * there are when there are more. A standalone service record has no order and contributes
   * nothing here, which is why this can be shorter than `events`.
   */
  workOrderNumbers: z.array(z.string()),
  /** The same orders with their ids, newest first, so each RO can be listed and linked. */
  workOrders: z.array(
    z.object({
      id: z.string(),
      number: z.string(),
      date: z.string(),
      typeLabel: z.string(),
      services: z.number(),
      spend: z.number(),
    }),
  ),
  /** Spend from standalone service records (no RO) in the period. */
  otherSpend: z.number(),
  /** The driver on the unit as of the roster; null when it has none or is a trailer. */
  driverName: z.string().nullable(),
  /** Miles driven in the period from the unit's odometer readings; null when they cannot be trusted. */
  miles: z.number().nullable(),
  /** Why `miles` is null, in words; null when it is not. */
  milesReason: z.string().nullable(),
  /** spend / miles for this unit; null without valid miles. */
  costPerMile: z.number().nullable(),
});
export type FleetVehicleRow = z.infer<typeof FleetVehicleRowSchema>;

/** One bar of the monthly chart: a calendar month's counted spend. */
export const FleetMonthSchema = z.object({
  /** `YYYY-MM` in the company calendar. */
  month: z.string(),
  /** `Apr`, or `Apr 2025` when the year changes inside the series. */
  label: z.string(),
  spend: z.number(),
  events: z.number().int(),
  /** True for the month the period ends in - the one still being written. */
  current: z.boolean(),
});
export type FleetMonth = z.infer<typeof FleetMonthSchema>;

export const FLEET_ANOMALY_RULES = [
  'spend_spike',
  'repeat_service',
  'cpm_above_median',
  'long_shop_stay',
  'pm_overdue',
  'expensive_service',
] as const;
export type FleetAnomalyRule = (typeof FLEET_ANOMALY_RULES)[number];

export const FleetAnomalySchema = z.object({
  key: z.string(),
  rule: z.enum(FLEET_ANOMALY_RULES),
  severity: z.enum(['critical', 'warning', 'info']),
  truckId: z.string(),
  unitNumber: z.string(),
  title: z.string(),
  /** The numbers behind the finding, so it can be checked rather than believed. */
  detail: z.string(),
  /** True for a finding about the present rather than the selected period. */
  current: z.boolean(),
  recordIds: z.array(z.string()),
});
export type FleetAnomaly = z.infer<typeof FleetAnomalySchema>;

export const FleetAnomalyCheckSchema = z.object({
  rule: z.enum(FLEET_ANOMALY_RULES),
  label: z.string(),
  /** The threshold and sample size the rule applies, in words. */
  threshold: z.string(),
  /** `ran` when the check executed; otherwise why it could not. */
  status: z.enum(['ran', 'unavailable']),
  reason: z.string().nullable(),
});
export type FleetAnomalyCheck = z.infer<typeof FleetAnomalyCheckSchema>;

export const FleetExpenseSummarySchema = z.object({
  meta: z.object({
    asOf: z.string(),
    period: z.object({
      preset: z.enum(FLEET_SPEND_PERIODS),
      from: IsoDate,
      to: IsoDate,
      label: z.string(),
      timezone: z.string(),
      /** The equal-length range immediately before, used for every trend. */
      comparison: z.object({ from: IsoDate, to: IsoDate, label: z.string() }),
    }),
    source: z.object({
      kind: z.literal('workspace_snapshot'),
      /** `demo` while the API seeds the generated workspace; `workspace` for a live company. */
      provenance: z.enum(['demo', 'workspace']),
      snapshotUpdatedAt: z.string().nullable(),
      /** How records were tied to this company. */
      scope: z.string(),
      basis: z.string(),
    }),
    filters: z.object({
      /** Unit ids the figures are restricted to; empty means the whole roster. */
      units: z.array(z.string()),
      /** Ids in the filter that are not on this company's roster and were ignored. */
      unknownUnits: z.array(z.string()),
      unitType: z.enum(FLEET_UNIT_TYPES),
    }),
    /** The units in scope after the filters, by kind — the denominators the footnotes name. */
    fleet: z.object({ trucks: z.number().int(), trailers: z.number().int() }),
  }),
  coverage: z.object({
    workOrdersCounted: z.number().int(),
    serviceRecordsCounted: z.number().int(),
    /** Events with an amount of exactly zero, kept in the total and named here. */
    zeroAmountEvents: z.number().int(),
    excluded: z.object({
      draftOrCancelled: z.number().int(),
      notCompleted: z.number().int(),
      missingCompletionDate: z.number().int(),
      unknownAmount: z.number().int(),
      /** Orders whose truck is not on this company's roster. */
      unattributedTruck: z.number().int(),
      /** Service records that point at an order and are therefore counted through it. */
      linkedServiceRecords: z.number().int(),
      /** Orders whose latest invoice amount disagrees with the order total; the total was used. */
      invoiceMismatch: z.number().int(),
      /**
       * The same record reaching the report twice - once from the workspace, once from the
       * server's own table - and counted once. Money is never counted twice; when this is not
       * zero, somebody should find out why the two copies exist.
       */
      duplicateRecords: z.number().int(),
    }),
    /** Ids of the invoice-mismatch orders, so somebody can go and look. */
    invoiceMismatchIds: z.array(z.string()),
    /**
     * Repairs charged to an owner-operator or lease driver.
     *
     * Reported, never counted in fleet spend: the money is the owner's, and folding it into the
     * company's cost per mile is how a fleet's numbers stop meaning anything. The shop volume is
     * still visible here.
     */
    ownerBilled: z.object({ amount: z.number(), orders: z.number().int() }),
  }),
  kpis: z.object({
    totalSpend: FleetMetricSchema,
    costPerMile: FleetMetricSchema,
    inShopNow: FleetMetricSchema,
    averagePerVehicle: FleetMetricSchema,
    inactiveNow: FleetMetricSchema,
    leaseOverage: FleetMetricSchema,
  }),
  vendors: z.object({
    rows: z.array(FleetVendorRowSchema),
    /** By vendor id where the records carry one; by normalised name for the rest. */
    groupedBy: z.enum(['vendor_id', 'normalised_name']),
    /** Events grouped by name only, because their order names no vendor record. */
    byNameOnly: z.number().int(),
  }),
  categories: z.object({
    total: z.number(),
    slices: z.array(FleetCategorySliceSchema),
    /** What the `Other` slice folds together, when there is one. */
    otherMembers: z.array(FleetCategorySliceSchema),
  }),
  serviceTypes: z.object({
    rows: z.array(FleetServiceTypeRowSchema),
    widespreadThreshold: z.number().int(),
  }),
  vehicles: z.object({
    rows: z.array(FleetVehicleRowSchema),
    flagged: z.number().int(),
  }),
  anomalies: z.object({
    counts: z.object({
      critical: z.number().int(),
      warning: z.number().int(),
      info: z.number().int(),
    }),
    findings: z.array(FleetAnomalySchema),
    checks: z.array(FleetAnomalyCheckSchema),
  }),
  /** Every counted event, so a count can open exactly the records behind it. */
  events: z.array(FleetSpendEventSchema),
  /** The six calendar months ending in the period's last month, whatever the preset. */
  series: z.object({ months: z.array(FleetMonthSchema) }),
  /**
   * The period's total, split two ways (owner, 2026-10-13): maintenance (repairs and service)
   * against other fleet expenses, and who bears it. Each split adds up to the total.
   */
  split: z.object({
    maintenance: z.number(),
    expenses: z.number(),
    company: z.number(),
    driver: z.number(),
    investigation: z.number(),
    warranty: z.number(),
    owner: z.number(),
    /** Repairs still open (not completed): their estimate so far, not spend. */
    openRepairs: z.object({ amount: z.number(), orders: z.number().int() }),
  }),
});
export type FleetExpenseSummary = z.infer<typeof FleetExpenseSummarySchema>;
