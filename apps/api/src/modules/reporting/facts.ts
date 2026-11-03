/**
 * Facts are the plain input records the reporting engines compute over. They are produced by a
 * `ReportingDataSource` for one company and one date range, and never contain another company's
 * rows. Engines are pure functions over facts (see docs/DASHBOARD.md §2).
 *
 * Money is in dollars with cent precision as JS numbers here (engines round to cents on output);
 * distances are miles; timestamps are ISO-8601 strings in UTC; `date` fields are company-local
 * calendar days as `YYYY-MM-DD`.
 */

import type { VendorFacts } from './vendor-trucks';

export type IsoDateTime = string;
export type IsoDate = string;

export type ExpenseCategory =
  | 'fuel'
  /** Diesel exhaust fluid: its own line, never blended into diesel (owner, 2026-10-25). */
  | 'def'
  | 'insurance'
  | 'maintenance'
  | 'tolls'
  | 'repairs'
  | 'dispatch_fee'
  | 'factoring'
  | 'driver_pay'
  /** Staff wages and payroll taxes: company overhead, never a truck's cost. */
  | 'staff_payroll'
  /** Repairs written to a trailer: the trailer's cost, never a truck's (owner, 2026-10-25). */
  | 'trailer_repairs'
  | 'other'
  /**
   * Money held back from drivers on their statements for costs the company paid (fuel, repairs,
   * tolls, charges). A NEGATIVE line: the cost stays recorded in full and this takes the recovery
   * off it, so net cost = cost - recovered (owner, 2026-10-25).
   */
  | 'recovered';

/** What a recovery charged back: fuel, repairs, tolls, damage/claims, or a company-paid Fleet expense. */
export type RecoveredFor = 'fuel' | 'repairs' | 'tolls' | 'damage' | 'fleet_expense';

/** `ledger` is a posted accounting entry - the authority for what a period cost. */
export type ExpenseSource =
  | 'fuel'
  | 'accounting'
  | 'settlement'
  | 'estimate'
  | 'maintenance'
  | 'ledger'
  /** A manual Fleet expense (`fleet_expenses`) the books have not taken on. */
  | 'fleet_expense'
  /** A driver-account recovery (`acct_driver_transactions`). */
  | 'recovery';

/** Normalized driver pay type. `null` means the driver's pay tag could not be classified. */
export type DriverPayType = 'company' | 'owner_operator' | 'lease_owner' | 'percentage';

export type TruckStatus =
  | 'available'
  | 'assigned'
  | 'driving'
  | 'idle'
  | 'in_shop'
  | 'out_of_service'
  | 'accident'
  | 'maintenance'
  | 'sold'
  | 'archived';

export interface RevenueLine {
  loadId: string;
  loadNumber: string;
  truckId: string | null;
  driverId: string | null;
  teamId: string | null;
  deliveredAt: IsoDateTime;
  /** Company-local delivery day, used for period membership. */
  deliveredOn: IsoDate;
  /** The linehaul the broker pays (the linehaul charge, else the rate). 0 on a TONU line. */
  linehaul: number;
  /**
   * Billed accessorials at the real (broker) amount: accepted, billable, non-linehaul charges.
   * Absent = 0. Gross = linehaul + accessorials + tonu (`revenueOf`).
   */
  accessorials?: number;
  /** The TONU fee on a load the broker cancelled. Absent = 0. */
  tonu?: number;
  /** `tonu` for a truck-ordered-not-used line; absent or `load` for a delivered load. */
  kind?: 'load' | 'tonu';
  loadedMiles: number;
  emptyMiles: number;
}

export interface ExpenseLine {
  id: string;
  date: IsoDate;
  category: ExpenseCategory;
  amount: number;
  truckId: string | null;
  driverId: string | null;
  source: ExpenseSource;
  /** True for driver-pay estimates for drivers without a finalized settlement. */
  isEstimate: boolean;
  description?: string;
  /** The load this cost was recorded against, when the source record names one. */
  loadNumber?: string | null;
  /** On a `recovered` line: which kind of company-paid cost the driver paid back. */
  recoveredFor?: RecoveredFor;
  /** The trailer a trailer repair belongs to (category `trailer_repairs`; truckId is then null). */
  trailerId?: string | null;
  /** The trailer's unit number, for the per-trailer breakdown. */
  trailerUnit?: string | null;
  /** `<type>:<id>` of the accounting record behind the line, for the drill-down. */
  reference?: string | null;
  /**
   * The obligation this line is about. An estimate and the posting that replaces it carry the
   * same key, so posting one driver's settlement retires that driver's estimate and nobody
   * else's. `null` when the line matches nothing, which keeps it.
   */
  obligationKey?: string | null;
}

export interface FuelTransactionFact {
  id: string;
  at: IsoDateTime;
  date: IsoDate;
  truckId: string | null;
  driverId: string | null;
  state: string;
  gallons: number;
  grossCost: number;
  discountedCost: number;
  stationName: string;
  /** `diesel` or `def` as the card feed reports it; absent reads as diesel. */
  product?: string;
}

export interface MileageRecord {
  truckId: string;
  driverId: string | null;
  date: IsoDate;
  miles: number;
  source: 'odometer' | 'loads';
}

export interface TruckFact {
  truckId: string;
  unitNumber: string;
  status: TruckStatus;
  driverId: string | null;
  driverName: string | null;
  /** Ran for a vendor at some point in the range (owner, 2026-10-28): its revenue is the company share. */
  vendor?: boolean;
}

export interface DriverFact {
  driverId: string;
  name: string;
  payType: DriverPayType | null;
  /** The configured pay tag as entered, kept for the data-quality investigation view. */
  rawPayTag: string | null;
}

/** One dispatcher team's aggregated week, as recorded by the dispatch module. */
export interface DispatchTeamWeek {
  teamId: string;
  teamName: string;
  /** First day of the reporting week (company-local). */
  weekStart: IsoDate;
  gross: number;
  loads: number;
  /** Trucks with at least one delivered load in the week. */
  activeTrucks: number;
  /** Truck-days the team was responsible for (trucks × days in the week so far). */
  truckDays: number;
  /** Truck-days on which the truck had a load in progress or delivered. */
  activeTruckDays: number;
  miles: number;
  /** Per-truck RPM for the week, for bucket distribution. */
  truckRpms: number[];
}

/** Whether accounting expense data exists for a reporting week. Absent data is not zero. */
export interface ExpenseCoverage {
  weekStart: IsoDate;
  hasExpenseData: boolean;
}

/** Everything an engine needs for one company and one date range. */
export interface ReportingFacts {
  companyId: string;
  range: { from: IsoDate; to: IsoDate };
  revenue: RevenueLine[];
  expenses: ExpenseLine[];
  fuel: FuelTransactionFact[];
  mileage: MileageRecord[];
  trucks: TruckFact[];
  drivers: DriverFact[];
  dispatchWeeks: DispatchTeamWeek[];
  expenseCoverage: ExpenseCoverage[];
  /** Independent revenue ledger total for the same range, used for reconciliation. */
  revenueLedgerTotal: number;
  /** What was actually read to build these facts (absent on older sources). */
  provenance?: FactsProvenance;
  /** Vendor trucks (owner, 2026-10-28): their gross, shares and costs, kept out of the company lines. */
  vendor?: VendorFacts;
}

/**
 * Where the facts came from - what was read, not what a setting says (2026-10-25). A screen's
 * "live records" label is derived from this.
 */
export interface FactsProvenance {
  /** True when the facts are the generated demo book. */
  generated: boolean;
  /** Real (non-demo) loads the company has in NeWay Loads, whatever their date. */
  loadsOnFile: number;
  /** Revenue lines in the range. */
  revenueLines: number;
  /** Expense lines in the range, by source. */
  expenseLines: Partial<Record<ExpenseSource, number>>;
  /** Fuel card rows in the range. */
  fuelRows: number;
  /** The newest fuel card row on file (any date); null when the company has no fuel feed. */
  fuelLatestAt: IsoDateTime | null;
  /** Ledger fuel (5100) in the range not linked to a card transaction: it may duplicate card fuel. */
  unlinkedLedgerFuel: number;
  /**
   * Recoveries larger than the matching cost recorded in the period (a company whose fuel is not
   * connected). Only `applied` is subtracted from cost; the rest is named, never netted silently.
   */
  unappliedRecoveries?: Array<{ kind: RecoveredFor; recovered: number; applied: number; cost: number }>;
}

export interface DateRange {
  from: IsoDate;
  to: IsoDate;
}

/** Contract implemented by the demo source now and the database source from Phase 3. */
export interface ReportingDataSource {
  readonly kind: 'demo' | 'database';
  /** Facts whose dates fall inside `range` (inclusive), for the given company only. */
  facts(companyId: string, range: DateRange): Promise<ReportingFacts>;
}

export const REPORTING_DATA_SOURCE = Symbol('REPORTING_DATA_SOURCE');
