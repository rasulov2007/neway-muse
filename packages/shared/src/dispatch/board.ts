import { z } from 'zod';
import { CommissionPolicySchema } from './policy.js';

/**
 * The dispatch boards (owner's brief, 2026-09-22): the Daily Dispatch Board and the Weekly
 * Production Board, run the way the Google Sheet was run - a status palette, typed cells that
 * override what the loads say, formulas, fills - and the contracts every screen reads through.
 * Everything here is pure; the API and the screens call it. Money rules live in `policy.ts`.
 */

// ------------------------------------------------------------------------------ statuses

export const DISPATCH_STATUSES = [
  'RE-UPDATE',
  'DISPATCHED',
  // On the shipper's dock (owner, 2026-10-13).
  'AT PU',
  'COVERED',
  'RESERVED',
  'HOLD FOR LOAD',
  'READY',
  'ENROUTE',
  'UNLOADING',
  'NO ANSWER',
  'STOP',
  'REST',
  // A driver's first days, before the first load (owner, 2026-10-19): off the plan, like HOME.
  'NEW DRIVER',
  'HOME',
  'VACATION',
  'SHOP',
  // Off the plan like HOME: the day comes off the days worked (owner, 2026-10-28).
  'INACTIVE',
] as const;
export type DispatchStatus = (typeof DISPATCH_STATUSES)[number];

/** Porcelain family each status wears (symbol + word + colour, never colour alone). */
export type StatusFamily = 'moving' | 'warning' | 'done' | 'urgent' | 'neutral' | 'info';

export interface DispatchStatusDef {
  code: DispatchStatus;
  family: StatusFamily;
  /** True when the day does not count as worked (HOME, VACATION, SHOP …). REST counts. */
  off: boolean;
}

export const DISPATCH_STATUS_DEFS: DispatchStatusDef[] = [
  { code: 'RE-UPDATE', family: 'info', off: false },
  { code: 'DISPATCHED', family: 'warning', off: false },
  { code: 'AT PU', family: 'moving', off: false },
  { code: 'COVERED', family: 'info', off: false },
  { code: 'RESERVED', family: 'info', off: false },
  { code: 'HOLD FOR LOAD', family: 'warning', off: false },
  { code: 'READY', family: 'done', off: false },
  { code: 'ENROUTE', family: 'moving', off: false },
  { code: 'UNLOADING', family: 'moving', off: false },
  { code: 'NO ANSWER', family: 'urgent', off: true },
  { code: 'STOP', family: 'urgent', off: true },
  { code: 'REST', family: 'neutral', off: false },
  { code: 'NEW DRIVER', family: 'info', off: true },
  { code: 'HOME', family: 'neutral', off: true },
  { code: 'VACATION', family: 'neutral', off: true },
  { code: 'SHOP', family: 'neutral', off: true },
  { code: 'INACTIVE', family: 'neutral', off: true },
];

export function statusDef(code: string | null | undefined): DispatchStatusDef | null {
  if (!code) return null;
  const upper = code.trim().toUpperCase();
  return DISPATCH_STATUS_DEFS.find((s) => s.code === upper) ?? null;
}

/** Rows inside a team sit in this order; a status change moves the row to its block. */
export const DAILY_STATUS_ORDER: DispatchStatus[] = [...DISPATCH_STATUSES];

export function statusRank(code: string | null | undefined): number {
  const def = statusDef(code);
  if (!def) return DAILY_STATUS_ORDER.length;
  return DAILY_STATUS_ORDER.indexOf(def.code);
}

// ------------------------------------------------------------------------------ columns

/** The typed cells a driver's day can hold. `status` and `truck` carry into the next day. */
export const DAILY_COLUMNS = [
  'status',
  'load_number',
  'truck',
  'trailer',
  'phone',
  'eta',
  'route',
  'miles',
  'notes',
] as const;
export type DailyColumn = (typeof DAILY_COLUMNS)[number];

/**
 * The weekly board's typed cells: amount, miles and load # one per day; `wk_comment` one per
 * driver per week, stored on the week's Monday (WEEK_COMMENT_COLUMN). It is free text and never
 * enters a total.
 */
export const WEEKLY_COLUMNS = ['amount', 'wk_miles', 'wk_load', 'wk_comment'] as const;
export type WeeklyColumn = (typeof WEEKLY_COLUMNS)[number];

/** The weekly board's Comment column: one free-text cell per driver per week, kept on the Monday. */
export const WEEK_COMMENT_COLUMN = 'wk_comment' as const satisfies WeeklyColumn;

export const BOARD_COLUMNS = [...DAILY_COLUMNS, ...WEEKLY_COLUMNS] as const;
export type BoardColumn = (typeof BOARD_COLUMNS)[number];

/** Cells that start the next day with yesterday's value. Location and miles are GPS columns. */
export const CARRY_COLUMNS: readonly BoardColumn[] = [
  'status',
  'load_number',
  'truck',
  'trailer',
  'phone',
  'eta',
  'route',
  'notes',
];

/** Ten Sheets tints a cell or range can be painted with; the status cell cannot. */
export const FILL_TINTS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as const;
export type FillTint = (typeof FILL_TINTS)[number];

// ------------------------------------------------------------------------------ formulas

/**
 * `=2150+1350` the way the sheet took it: digits, a decimal point, + - * /, parentheses.
 * Anything else is not a formula and is left as typed. Null when it does not evaluate.
 * No JavaScript is ever evaluated: this is a hand-written expression parser.
 */
export function evaluateFormula(text: string): number | null {
  const body = text.trim().startsWith('=') ? text.trim().slice(1) : text.trim();
  if (!/^[\d\s.+\-*/(),$]+$/.test(body)) return null;
  const clean = body.replace(/[,$\s]/g, '');
  if (!clean) return null;
  const tokens = clean.match(/\d+(\.\d+)?|[+\-*/()]/g);
  if (!tokens || tokens.join('') !== clean) return null;
  let i = 0;
  const peek = () => tokens[i];
  const next = () => tokens[i++];
  const factor = (): number => {
    const t = next();
    if (t === undefined) throw new Error('end');
    if (t === '(') {
      const v = expr();
      if (next() !== ')') throw new Error('paren');
      return v;
    }
    if (t === '-') return -factor();
    if (t === '+') return factor();
    if (/^\d/.test(t)) return Number(t);
    throw new Error('token');
  };
  const term = (): number => {
    let v = factor();
    while (peek() === '*' || peek() === '/') {
      const op = next();
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number => {
    let v = term();
    while (peek() === '+' || peek() === '-') {
      const op = next();
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  try {
    const value = expr();
    if (i !== tokens.length || !Number.isFinite(value)) return null;
    return Math.round(value * 100) / 100;
  } catch {
    return null;
  }
}

export function isFormula(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.trim().startsWith('=');
}

/**
 * What an Amount cell means: a status word (zero revenue, painted), a number, or a formula.
 * `$` and commas are tolerated. Null when the text is none of those.
 */
export function parseAmount(
  text: string,
): { kind: 'status'; code: DispatchStatus } | { kind: 'number'; value: number; formula: string | null } | null {
  const t = text.trim();
  if (t === '') return null;
  const def = statusDef(t);
  if (def) return { kind: 'status', code: def.code };
  const n = evaluateFormula(t);
  if (n === null) return null;
  return { kind: 'number', value: n, formula: isFormula(t) ? t : null };
}

/**
 * Miles: a number or formula, commas and a `mi` suffix tolerated; negative rejected.
 *
 * The decimals are kept. Rounding here used to turn 3,428.57 miles into 3,429, which moves the
 * weighted RPM from exactly $3.50 to $3.4996 and silently costs a driver the RPM bonus - a
 * quarter of a percentage point decided by a rounding step nobody asked for. The screens round
 * miles for display; the commission compares the real number.
 */
export function parseMiles(text: string): { value: number; formula: string | null } | null {
  const t = text.trim().replace(/\s*(mi|miles)\.?$/i, '');
  if (t === '') return null;
  const n = evaluateFormula(t);
  if (n === null || n < 0) return null;
  // Two decimals is below the precision any mileage source reports, and keeps the stored value
  // free of binary-floating-point tails like 3428.5700000000003.
  return { value: Math.round(n * 100) / 100, formula: isFormula(t) ? t : null };
}

/** Plan Reach: `total − goal`. Cents in, cents out. */
export function planReachCents(totalCents: number, goalCents: number): number {
  return totalCents - goalCents;
}

/**
 * Plan Adj: what the week made against what the week was expected to make.
 *
 * The divisor is the question. `seven_day` spreads the weekly goal across the seven days of the
 * week, which is what the boards have always shown. `active_days` spreads it across the policy's
 * own working days - five, for a document that describes a five-active-day target - so a week with
 * four active days is measured against four fifths of the goal rather than four sevenths.
 *
 * Both are correct arithmetic for different questions, and they disagree by a lot: $8,000 against
 * a $10,000 goal over four days is +$2,285.71 on the seven-day basis and $0.00 on the five-day
 * one. The basis therefore comes from the policy rather than being hard-coded here.
 */
export function planAdjustedCents(
  totalCents: number,
  goalCents: number,
  daysWorked: number,
  options?: { basis?: 'seven_day' | 'active_days'; workDays?: number },
): number {
  const basis = options?.basis ?? 'seven_day';
  const divisor = basis === 'active_days' ? (options?.workDays && options.workDays > 0 ? options.workDays : 5) : 7;
  return Math.round(totalCents - (goalCents * daysWorked) / divisor);
}

/**
 * The days a week was expected to run, and whether that is more than the policy plans for.
 *
 * A day is on or off; the boards have no half-day, so there is no partial day to handle and none
 * is invented here. A week can still show more active days than the policy's `workDays` - seven
 * statuses, none of them off, against a five-day target - and the document does not say whether
 * that should raise the target or be capped. It is reported, not decided.
 */
export function activeDaysFor(
  dayStatuses: (string | null | undefined)[],
  workDays: number,
): { activeDays: number; overWorkDays: boolean } {
  const activeDays = daysWorked(dayStatuses);
  return { activeDays, overWorkDays: activeDays > workDays };
}

/**
 * Days worked counts down from seven: an off status (HOME, VACATION, SHOP …) takes a day off
 * the plan. REST does not - the driver chose it, the company still expected the week.
 */
export function daysWorked(dayStatuses: (string | null | undefined)[]): number {
  let days = 7;
  for (const s of dayStatuses) if (statusDef(s)?.off) days -= 1;
  return Math.max(0, days);
}

export function efficiencyPct(totalCents: number, goalCents: number): number {
  if (goalCents <= 0) return 0;
  return Math.round((totalCents / goalCents) * 1000) / 10;
}

export function dollarsToCents(dollars: number): number {
  return Math.round(dollars * 100);
}

// ------------------------------------------------------------------------------ contracts

export const BoardCellSchema = z.object({
  driverId: z.string(),
  day: z.string(),
  column: z.enum(BOARD_COLUMNS),
  /** Null is an explicit empty: the automatic value stays hidden. */
  value: z.string().nullable(),
  /** The typed formula when the value came from one. */
  formula: z.string().nullable(),
  setBy: z.string(),
  setByName: z.string(),
  setAt: z.string(),
  version: z.number().int(),
  /** Typed for the load before the current one: the row shows the automatic value instead. */
  earlierLoad: z.boolean().optional(),
});
export type BoardCell = z.infer<typeof BoardCellSchema>;

export const WriteBoardCellSchema = z.object({
  driverId: z.string().min(1),
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  column: z.enum(BOARD_COLUMNS),
  /** What was typed. Null = explicit empty (the automatic value stays hidden). */
  value: z.string().max(2000).nullable(),
  /** True restores the automatic value: the typed cell is removed. */
  restore: z.boolean().optional(),
  /**
   * The version the writer last saw: a number for an existing typed cell, null for "no typed
   * cell yet". When given and stale the write is refused with 409 and nothing in the batch is
   * saved. Omitted = no check (a status menu, a fill-down that means "overwrite").
   */
  expectedVersion: z.number().int().nullable().optional(),
});
export type WriteBoardCellInput = z.infer<typeof WriteBoardCellSchema>;

export const WriteBoardCellsSchema = z.object({
  cells: z.array(WriteBoardCellSchema).min(1).max(500),
});
export type WriteBoardCellsInput = z.infer<typeof WriteBoardCellsSchema>;

/** The Weekly board's driver-name cell paints too (owner, 2026-11-02); its fill is kept on the week's Monday. */
export const WEEK_NAME_FILL_COLUMN = 'wk_name' as const;

export const WriteBoardFillSchema = z.object({
  fills: z
    .array(
      z.object({
        driverId: z.string().min(1),
        day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        column: z.enum([...BOARD_COLUMNS, WEEK_NAME_FILL_COLUMN]),
        tint: z.number().int().min(0).max(10),
      }),
    )
    .min(1)
    .max(500),
});
export type WriteBoardFillInput = z.infer<typeof WriteBoardFillSchema>;

export const BoardEditSchema = z.object({
  id: z.string(),
  driverId: z.string(),
  day: z.string(),
  column: z.enum(BOARD_COLUMNS),
  oldValue: z.string().nullable(),
  newValue: z.string().nullable(),
  byName: z.string(),
  at: z.string(),
  source: z.enum(['user', 'carry', 'system']),
});
export type BoardEdit = z.infer<typeof BoardEditSchema>;

/** A load as the daily board reads it. */
export const BoardLoadSchema = z.object({
  id: z.string(),
  loadNumber: z.string(),
  status: z.string(),
  /** The shipper the truck is heading to, or loaded at: the first pickup not yet done. */
  origin: z.string(),
  /** The receiver the truck is heading to: the first delivery not yet done (owner, 2026-10-28). */
  destination: z.string(),
  /** The load's last receiver, for the whole trip "origin → final". Absent on older rows. */
  finalDestination: z.string().optional(),
  /** Deliveries still open, this one included. Absent on older rows. */
  deliveriesLeft: z.number().int().nonnegative().optional(),
  pickupAt: z.string(),
  pickupZone: z.string().nullable(),
  deliveryAt: z.string(),
  deliveryZone: z.string().nullable(),
  rate: z.number(),
  loadedMiles: z.number(),
  /** Deadhead to the pickup; the MILES column shows loaded + deadhead (owner, 2026-10-29). Absent on older rows. */
  emptyMiles: z.number().optional(),
  trailer: z.string().nullable(),
  /** The load has not been heard from inside its cadence (rule 1.4). Absent on older rows. */
  updateDue: z.boolean().optional(),
  /** Flags open on the load (rule 1.10). Absent on older rows. */
  openFlags: z.number().int().nonnegative().optional(),
  /** The broker's own reference for the load, shown before the load number (owner, 2026-10-21). */
  brokerReference: z.string().nullable().optional(),
});
export type BoardLoad = z.infer<typeof BoardLoadSchema>;

/**
 * How a load is named on the boards (owner, 2026-10-21): `<broker reference>/<load number>`
 * when the broker gave one - `4471823/L-100009` - and the load number alone when it did not.
 */
export function boardLoadLabel(load: { loadNumber: string; brokerReference?: string | null }): string {
  const ref = load.brokerReference?.trim();
  return ref ? `${ref}/${load.loadNumber}` : load.loadNumber;
}

/** A board row: a driver record, or a roster line the sheet ran that has no driver file yet. */
export const RosterRowSchema = z.object({
  id: z.string(),
  driverId: z.string().nullable(),
  name: z.string(),
  coDriver: z.string().nullable(),
  sourceName: z.string().nullable(),
  payTag: z.string().nullable(),
  truckUnit: z.string().nullable(),
  phone: z.string(),
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
  dispatcherNickname: z.string().nullable().optional(),
  /** Full name(s) behind the nickname, for the tooltip. */
  dispatcherFullName: z.string().nullable().optional(),
  /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
  teamNumber: z.number().int().nullable().optional(),
  comment: z.string(),
  unassignedAt: z.string().nullable(),
  unassignedReason: z.string().nullable(),
  /** Another active row runs the same truck number. */
  truckConflict: z.boolean(),
  version: z.number().int(),
  /** The driver file's number (D-2112), '' for a row without one; searched by Add driver. */
  driverNumber: z.string().optional(),
});
export type RosterRow = z.infer<typeof RosterRowSchema>;

export const DailyBoardRowSchema = z.object({
  driverId: z.string(),
  driverName: z.string(),
  coDriver: z.string().nullable(),
  payTag: z.string().nullable(),
  driverNumber: z.string(),
  driverType: z.string(),
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
  dispatcherNickname: z.string().nullable().optional(),
  /** Full name(s) behind the nickname, for the tooltip. */
  dispatcherFullName: z.string().nullable().optional(),
  /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
  teamNumber: z.number().int().nullable().optional(),
  /** Roster facts the cells fall back to. */
  phone: z.string(),
  truckUnit: z.string().nullable(),
  truckConflict: z.boolean(),
  cdlHold: z.array(z.string()),
  primaryLoad: BoardLoadSchema.nullable(),
  /** Further loads on the driver beyond the primary, in pickup order. */
  queuedLoads: z.array(BoardLoadSchema),
  /** The automatic value of each column before any typed cell. */
  auto: z.record(z.string(), z.string().nullable()),
  /** Typed cells in force on the day (carried ones included). */
  cells: z.record(z.string(), BoardCellSchema),
  fills: z.record(z.string(), z.number()),
  status: z.string().nullable(),
  statusSince: z.string().nullable(),
  rosterVersion: z.number().int(),
});
export type DailyBoardRow = z.infer<typeof DailyBoardRowSchema>;

export const DailyBoardSchema = z.object({
  day: z.string(),
  today: z.string(),
  nowIso: z.string(),
  rows: z.array(DailyBoardRowSchema),
  teams: z.array(
    z.object({
      dispatcherId: z.string(),
      dispatcherName: z.string(),
      /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
      dispatcherNickname: z.string().nullable().optional(),
      /** Full name(s) behind the nickname, for the tooltip. */
      dispatcherFullName: z.string().nullable().optional(),
      /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
      teamNumber: z.number().int().nullable().optional(),
      driverCount: z.number().int(),
    }),
  ),
  /** Board cells and fills. */
  canWrite: z.boolean(),
  /** Roster, rules, overrides, salary. */
  canManage: z.boolean(),
  /** Whether live tracking feeds the board. False today: every ETA and mile is typed or from the load. */
  liveTracking: z.boolean(),
});
export type DailyBoard = z.infer<typeof DailyBoardSchema>;

/**
 * Drivers at home (owner, 2026-10-30): every row whose status on today's Daily board is HOME,
 * with the first day of the unbroken HOME run - the page beside On vacation.
 */
export interface AtHomeDriver {
  /** The board row (the driver file's own id when the row has one). */
  rowId: string;
  /** The driver file, when the row has one. */
  driverId: string | null;
  driverName: string;
  coDriver: string | null;
  unitNumber: string | null;
  dispatcherName: string;
  teamNumber: number | null;
  phone: string | null;
  /** First day of the unbroken HOME run on the board. */
  homeSince: string;
  daysHome: number;
}
export interface AtHomeList {
  day: string;
  rows: AtHomeDriver[];
}

export const WeeklyDaySchema = z.object({
  day: z.string(),
  /** Money and miles the loads say, before any typed cell. */
  autoAmount: z.number(),
  autoMiles: z.number(),
  loadNumbers: z.array(z.string()),
  /** What the Load # row shows: `<broker ref> - <load number>`, or the load number alone (owner, 2026-10-27). */
  loadLabels: z.array(z.string()).default([]),
  /** Each load on the day with its own money and miles, so a two-load day shows its breakdown (owner, 2026-10-19). */
  loads: z.array(z.object({ loadNumber: z.string(), amount: z.number(), miles: z.number() })).default([]),
  /** What the day shows after typed cells: a number, or a status word that zeroes the day. */
  amount: z.number(),
  miles: z.number(),
  statusWord: z.string().nullable(),
  amountCell: BoardCellSchema.nullable(),
  milesCell: BoardCellSchema.nullable(),
  loadCell: BoardCellSchema.nullable(),
  fills: z.record(z.string(), z.number()),
});
export type WeeklyDay = z.infer<typeof WeeklyDaySchema>;

export const CommissionViewSchema = z.object({
  status: z.enum(['ok', 'no_gross', 'below_floor', 'junior', 'needs_miles', 'no_payment', 'reduced']),
  /** The calculated amount, before any manual layer. */
  calculatedCents: z.number().int(),
  /** What is paid: the override, the adjusted figure, or the calculated one. */
  payableCents: z.number().int(),
  pct: z.number(),
  basePct: z.number(),
  bonusPct: z.number(),
  tier: z.string(),
  formula: z.string(),
  bonusWithheld: z.boolean(),
  override: z
    .object({
      mode: z.enum(['amount', 'adjustment']),
      amountCents: z.number().int(),
      reason: z.string(),
      byName: z.string(),
      at: z.string(),
      version: z.number().int(),
    })
    .nullable(),
  flags: z.object({ complaint: z.boolean(), junior: z.boolean(), reason: z.string() }),
  policyVersion: z.string(),
  /**
   * An adjustment is on the week but the week has no gross yet, so it is not paid (owner,
   * 2026-10-26). It applies by itself once the week has gross.
   */
  adjustmentHeld: z.boolean().optional(),
});
export type CommissionView = z.infer<typeof CommissionViewSchema>;

export const WeeklyBoardRowSchema = z.object({
  driverId: z.string(),
  driverName: z.string(),
  coDriver: z.string().nullable(),
  payTag: z.string().nullable(),
  /** company · lease_operator · owner_operator: the CD / LO column of the Weekly Report (2026-10-19). */
  driverType: z.string().default('company'),
  comment: z.string(),
  driverNumber: z.string(),
  truckUnit: z.string().nullable(),
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
  dispatcherNickname: z.string().nullable().optional(),
  /** Full name(s) behind the nickname, for the tooltip. */
  dispatcherFullName: z.string().nullable().optional(),
  /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
  teamNumber: z.number().int().nullable().optional(),
  unit: z.enum(['solo', 'team']),
  /** True when the team/truck/co-driver shown are pinned from the week, not today's roster. */
  pinned: z.boolean(),
  days: z.array(WeeklyDaySchema),
  /** The week's Comment cell (column `wk_comment` on the Monday); null when nothing is typed. */
  weekComment: BoardCellSchema.nullable(),
  total: z.number(),
  miles: z.number(),
  rpm: z.number().nullable(),
  goal: z.number(),
  planReach: z.number(),
  planAdj: z.number(),
  daysWorked: z.number().int(),
  efficiencyPct: z.number(),
  /** Absent when the viewer may not see it. */
  commission: CommissionViewSchema.nullable(),
  unassignedAt: z.string().nullable(),
  rosterVersion: z.number().int(),
});
export type WeeklyBoardRow = z.infer<typeof WeeklyBoardRowSchema>;

export const WeeklyBoardSchema = z.object({
  weekStart: z.string(),
  days: z.array(z.string()),
  payBlock: z.object({ block: z.number().int(), week: z.number().int(), start: z.string(), end: z.string() }),
  isoWeek: z.object({ year: z.number().int(), week: z.number().int() }),
  policyVersion: z.string(),
  rows: z.array(WeeklyBoardRowSchema),
  /** Rows taken off the board this week; still shown at the foot with Restore. */
  unassigned: z.array(WeeklyBoardRowSchema),
  teams: z.array(
    z.object({
      dispatcherId: z.string(),
      dispatcherName: z.string(),
      /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
      dispatcherNickname: z.string().nullable().optional(),
      /** Full name(s) behind the nickname, for the tooltip. */
      dispatcherFullName: z.string().nullable().optional(),
      /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
      teamNumber: z.number().int().nullable().optional(),
      total: z.number(),
      miles: z.number(),
      rpm: z.number().nullable(),
      goal: z.number(),
      dayTotals: z.array(z.number()),
      trucks: z.number().int(),
      /** Null when not the viewer's to see. */
      commissionCents: z.number().int().nullable(),
    }),
  ),
  grand: z.object({
    total: z.number(),
    miles: z.number(),
    rpm: z.number().nullable(),
    dayTotals: z.array(z.number()),
    trucks: z.number().int(),
    commissionCents: z.number().int().nullable(),
  }),
  canWrite: z.boolean(),
  canManage: z.boolean(),
  seesCommission: z.boolean(),
});
export type WeeklyBoard = z.infer<typeof WeeklyBoardSchema>;

// ------------------------------------------------------------------------------ roster writes

export const AddRosterRowSchema = z.object({
  name: z.string().trim().min(1).max(120),
  coDriver: z.string().trim().max(120).nullable().optional(),
  payTag: z.string().trim().max(40).nullable().optional(),
  truckUnit: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(120).optional(),
  dispatcherId: z.string().trim().min(1),
  dispatcherName: z.string().trim().min(1).max(120),
  /** Link to an existing driver file, when there is one. */
  driverId: z.string().trim().min(1).nullable().optional(),
});
export type AddRosterRowInput = z.infer<typeof AddRosterRowSchema>;

export const UpdateRosterRowSchema = z.object({
  coDriver: z.string().trim().max(120).nullable().optional(),
  payTag: z.string().trim().max(40).nullable().optional(),
  truckUnit: z.string().trim().max(40).nullable().optional(),
  phone: z.string().trim().max(120).optional(),
  dispatcherId: z.string().trim().min(1).optional(),
  dispatcherName: z.string().trim().min(1).max(120).optional(),
  /** Why the driver leaves their dispatcher; required when dispatcherId changes (owner, 2026-10-16). */
  reason: z.string().trim().min(2).max(500).optional(),
  /**
   * A team change counts from the Monday (US Eastern) of this date's week - this week or an
   * earlier one (owner, 2026-10-26). Left out, it counts from today, as before.
   */
  fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  comment: z.string().trim().max(2000).optional(),
  name: z.string().trim().min(1).max(120).optional(),
  expectedVersion: z.number().int(),
});
export type UpdateRosterRowInput = z.infer<typeof UpdateRosterRowSchema>;

/**
 * A driver who is not on the boards today (owner, 2026-10-26): a driver file with no board row,
 * or a board row removed from the boards. Add driver and the driver profile offer both.
 */
export const OffBoardDriverSchema = z.object({
  /** 'file' = a driver file with no board row; 'removed' = a board row taken off the boards. */
  kind: z.enum(['file', 'removed']),
  driverId: z.string().nullable(),
  rosterId: z.string().nullable(),
  /** The board row's version, for the version check; null when there is no row yet. */
  version: z.number().int().nullable(),
  name: z.string(),
  driverNumber: z.string(),
  truckUnit: z.string().nullable(),
  phone: z.string(),
  coDriver: z.string().nullable(),
  /** The team the row had before it was removed; '' for none. */
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  removedFrom: z.string().nullable(),
  removedReason: z.string().nullable(),
});
export type OffBoardDriver = z.infer<typeof OffBoardDriverSchema>;

/**
 * Assign a driver to a dispatcher (owner, 2026-10-26), from the board's Add driver or the driver
 * profile: creates the driver's board row when he has none, puts a removed row back on the board,
 * and moves him to the team from the Monday of `fromWeek` (this week when left out).
 */
export const AssignDriverToTeamSchema = z
  .object({
    driverId: z.string().trim().min(1).optional(),
    rosterId: z.string().trim().min(1).optional(),
    dispatcherId: z.string().trim().min(1),
    dispatcherName: z.string().trim().min(1).max(120),
    fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    /** Why the driver leaves his current dispatcher; required when he has one. */
    reason: z.string().trim().min(2).max(500).optional(),
    /** The board row's version when the driver has one; left out only when he has none. */
    expectedVersion: z.number().int().optional(),
  })
  .refine((v) => Boolean(v.driverId || v.rosterId), { message: 'Name the driver or the board row' });
export type AssignDriverToTeamInput = z.infer<typeof AssignDriverToTeamSchema>;

/**
 * Unassign (owner, 2026-10-26): the driver leaves his dispatcher from the Monday of this week on
 * and sits in Unassigned drivers; earlier weeks keep the old team. The same body takes a row
 * completely off the boards ("Remove from board").
 */
export const UnassignRosterRowSchema = z.object({
  reason: z.string().trim().min(2).max(500),
  /** From this date's week on (a day or the week's Monday; the Monday is what counts). */
  fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  expectedVersion: z.number().int(),
});
export type UnassignRosterRowInput = z.infer<typeof UnassignRosterRowSchema>;

/**
 * Separate team (owner, 2026-10-28): a team truck splits. The board asks who stays on the row, from
 * which week the one who stays drives solo, why, and whether the other comes back - from that day
 * the row is a team again. Driver pay follows the loads: the one who left is on none, so the one
 * who stayed is paid 100 %.
 */
export const SeparateTeamSchema = z.object({
  /** 'driver' = the row's own driver stays; 'co_driver' = the co-driver takes the truck and the row. */
  stays: z.enum(['driver', 'co_driver']),
  fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(2, 'Say why the team splits').max(500),
  /** The day the other driver comes back and the row is a team again; null = not coming back. */
  returnsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  expectedVersion: z.number().int(),
});
export type SeparateTeamInput = z.infer<typeof SeparateTeamSchema>;

/**
 * Separate dispatchers (owner, 2026-10-28): a team run by two dispatchers splits. Team commission is
 * 50/50; from the chosen week the one who stays is paid 100 % and the one who left nothing, and
 * from the return day it is 50/50 again.
 */
export const SeparateDispatchersSchema = z.object({
  /** The member who stays: TeamMember.key. */
  staysKey: z.string().trim().min(1),
  fromWeek: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  reason: z.string().trim().min(2, 'Say why the team splits').max(500),
  returnsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});
export type SeparateDispatchersInput = z.infer<typeof SeparateDispatchersSchema>;

/** The dispatchers behind a team, as Separate dispatchers offers them. */
export interface DispatchTeamMembers {
  dispatcherId: string;
  members: Array<{ key: string; name: string; employeeId: string | null; sharePct: number }>;
  /** Who is paid this week: the split in force today. */
  inForce: Array<{ name: string; sharePct: number }>;
}

export const RosterImportApplySchema = z.object({
  csv: z.string().min(1).max(2_000_000),
});
export type RosterImportApplyInput = z.infer<typeof RosterImportApplySchema>;

export const RosterImportReportSchema = z.object({
  parsed: z.number().int(),
  teams: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  conflicts: z.array(
    z.object({ truckUnit: z.string(), rows: z.array(z.object({ importKey: z.string(), name: z.string(), team: z.string() })) }),
  ),
  skipped: z.array(z.object({ line: z.number().int(), reason: z.string() })),
  dryRun: z.boolean(),
});
export type RosterImportReport = z.infer<typeof RosterImportReportSchema>;

// ------------------------------------------------------------------------------ salary

export const AllocationShareSchema = z.object({
  employeeId: z.string().nullable(),
  name: z.string().trim().min(1).max(120),
  /** Percent, two decimals; the shares of a team must total 100. */
  sharePct: z.number().min(0).max(100),
});
export const WriteAllocationSchema = z.object({
  dispatcherId: z.string().min(1),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  shares: z.array(AllocationShareSchema).min(1).max(10),
});
export type WriteAllocationInput = z.infer<typeof WriteAllocationSchema>;

export const SalaryAdjustmentKinds = [
  'lane_bonus',
  'dnu',
  'driver_departure',
  'freight_guard',
  'junior_forfeit',
  'other_bonus',
  'other_penalty',
] as const;
export type SalaryAdjustmentKind = (typeof SalaryAdjustmentKinds)[number];

export const WriteSalaryAdjustmentSchema = z.object({
  dispatcherId: z.string().min(1),
  employeeName: z.string().trim().max(120).default(''),
  month: z.string().regex(/^\d{4}-\d{2}$/),
  kind: z.enum(SalaryAdjustmentKinds),
  /** Positive for a bonus, negative for a penalty; the kind decides the sign the UI offers. */
  amountCents: z.number().int().min(-100_000_000).max(100_000_000),
  reason: z.string().trim().min(3).max(1000),
  approvedByName: z.string().trim().min(1).max(120),
});
export type WriteSalaryAdjustmentInput = z.infer<typeof WriteSalaryAdjustmentSchema>;

export const SalaryAdjustmentSchema = WriteSalaryAdjustmentSchema.extend({
  id: z.string(),
  byName: z.string(),
  at: z.string(),
  voidedAt: z.string().nullable(),
  voidReason: z.string().nullable(),
});
export type SalaryAdjustment = z.infer<typeof SalaryAdjustmentSchema>;

export const SalaryTruckWeekSchema = z.object({
  weekStart: z.string(),
  rosterId: z.string(),
  driverName: z.string(),
  truckUnit: z.string().nullable(),
  unit: z.enum(['solo', 'team']),
  grossCents: z.number().int(),
  miles: z.number(),
  rpm: z.number().nullable(),
  basePct: z.number(),
  bonusPct: z.number(),
  status: CommissionViewSchema.shape.status,
  tier: z.string(),
  calculatedCents: z.number().int(),
  overrideCents: z.number().int().nullable(),
  overrideMode: z.enum(['amount', 'adjustment']).nullable(),
  overrideReason: z.string().nullable(),
  payableCents: z.number().int(),
  formula: z.string(),
  policyVersion: z.string(),
});
export type SalaryTruckWeek = z.infer<typeof SalaryTruckWeekSchema>;

export const SalaryTeamSchema = z.object({
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  /** The team's nickname(s) when it is linked to employees (owner, 2026-10-26); null = show dispatcherName. */
  dispatcherNickname: z.string().nullable().optional(),
  /** Full name(s) behind the nickname, for the tooltip. */
  dispatcherFullName: z.string().nullable().optional(),
  /** TEAM n on the boards; null for a solo dispatcher (owner, 2026-10-26). */
  teamNumber: z.number().int().nullable().optional(),
  weeks: z.array(z.object({ weekStart: z.string(), grossCents: z.number().int(), commissionCents: z.number().int(), trucks: z.number().int() })),
  grossCents: z.number().int(),
  miles: z.number(),
  rpm: z.number().nullable(),
  commissionCents: z.number().int(),
  bonusesCents: z.number().int(),
  penaltiesCents: z.number().int(),
  payableCents: z.number().int(),
  /** Null until shares are configured; then one line per employee. */
  allocation: z
    .array(z.object({ name: z.string(), employeeId: z.string().nullable(), sharePct: z.number(), payableCents: z.number().int() }))
    .nullable(),
  allocationEffectiveFrom: z.string().nullable(),
  needsMiles: z.number().int(),
  trucks: z.array(SalaryTruckWeekSchema),
  adjustments: z.array(SalaryAdjustmentSchema),
});
export type SalaryTeam = z.infer<typeof SalaryTeamSchema>;

export const SalaryReportSchema = z.object({
  kind: z.enum(['week', 'pay_period', 'month']),
  start: z.string(),
  end: z.string(),
  label: z.string(),
  weeks: z.array(z.string()),
  /** Months whose approved bonuses and penalties fall in the period. */
  months: z.array(z.string()),
  policyVersions: z.array(z.string()),
  teams: z.array(SalaryTeamSchema),
  totals: z.object({
    grossCents: z.number().int(),
    commissionCents: z.number().int(),
    bonusesCents: z.number().int(),
    penaltiesCents: z.number().int(),
    payableCents: z.number().int(),
  }),
  run: z
    .object({
      id: z.string(),
      status: z.enum(['draft', 'review', 'final']),
      version: z.number().int(),
      createdByName: z.string(),
      createdAt: z.string(),
      finalizedByName: z.string().nullable(),
      finalizedAt: z.string().nullable(),
      reopenedByName: z.string().nullable(),
      reopenedAt: z.string().nullable(),
      reopenReason: z.string().nullable(),
    })
    .nullable(),
  /** True when the numbers come from a finalized snapshot rather than the live boards. */
  frozen: z.boolean(),
  canManage: z.boolean(),
});
export type SalaryReport = z.infer<typeof SalaryReportSchema>;

export const SalaryRunActionSchema = z.object({
  action: z.enum(['create', 'review', 'finalize', 'reopen', 'back_to_draft']),
  reason: z.string().trim().max(500).default(''),
  expectedVersion: z.number().int().nullable().optional(),
});
export type SalaryRunActionInput = z.infer<typeof SalaryRunActionSchema>;

// ------------------------------------------------------------------------------ detention & layover

export const DISPATCH_CLAIM_TYPES = ['detention', 'layover', 'tonu', 'other'] as const;
export const DISPATCH_CLAIM_STATUSES = ['open', 'submitted', 'recovered', 'partial', 'denied', 'paid'] as const;

export const ClaimSchema = z.object({
  id: z.string(),
  loadNumber: z.string(),
  claimType: z.enum(DISPATCH_CLAIM_TYPES),
  rosterId: z.string().nullable(),
  driverName: z.string(),
  claimDate: z.string(),
  requestedCents: z.number().int(),
  recoveredCents: z.number().int(),
  updater: z.string(),
  updaterPayoutCents: z.number().int(),
  status: z.enum(DISPATCH_CLAIM_STATUSES),
  notes: z.string(),
  byName: z.string(),
  at: z.string(),
  version: z.number().int(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const WriteClaimSchema = z.object({
  loadNumber: z.string().trim().min(1).max(60),
  claimType: z.enum(DISPATCH_CLAIM_TYPES),
  rosterId: z.string().nullable().optional(),
  driverName: z.string().trim().max(120).default(''),
  claimDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  requestedCents: z.number().int().min(0).max(100_000_000),
  recoveredCents: z.number().int().min(0).max(100_000_000),
  updater: z.string().trim().max(120).default(''),
  updaterPayoutCents: z.number().int().min(0).max(100_000_000),
  status: z.enum(DISPATCH_CLAIM_STATUSES),
  notes: z.string().trim().max(2000).default(''),
  expectedVersion: z.number().int().nullable().optional(),
});
export type WriteClaimInput = z.infer<typeof WriteClaimSchema>;

// ------------------------------------------------------------------------------ audit

export const DispatchAuditSchema = z.object({
  id: z.string(),
  entity: z.string(),
  entityId: z.string(),
  action: z.string(),
  before: z.unknown().nullable(),
  after: z.unknown().nullable(),
  byName: z.string(),
  at: z.string(),
});
export type DispatchAudit = z.infer<typeof DispatchAuditSchema>;

export { CommissionPolicySchema };

/**
 * Which load a daily-board row is carrying, which wait behind it, and the word the row reads.
 *
 * The owner's rule (2026-09-30):
 * - A driver with no load reads READY (or whatever was typed); DISPATCHED, ENROUTE and UNLOADING
 *   need a load - see `BOARD_WORDS_NEEDING_A_LOAD`.
 * - Assigning a load to a driver whose LOAD # is empty puts it in LOAD # and the row reads
 *   DISPATCHED, automatically - over READY or any other "waiting" word.
 * - A load assigned while LOAD # is already filled is a prebook: it waits in Notes.
 *
 * A load still moving while the dispatcher says READY is a disagreement with the load record,
 * settled on the Loads page; the row carries nothing and does not re-file it as a prebook.
 *
 * Pure, so the rule is argued with here rather than against a live board.
 */
export const BOARD_MOVING_LOAD_STATUSES: ReadonlySet<string> = new Set([
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);

/** Load statuses that are the driver's next job but not yet rolling. */
const BOARD_WAITING_LOAD_STATUSES: ReadonlySet<string> = new Set(['booked', 'assigned', 'dispatched']);

/** Words a newly assigned load replaces with DISPATCHED: the driver was waiting for work. */
export const BOARD_WORDS_A_LOAD_REPLACES: ReadonlySet<string> = new Set([
  'READY',
  'COVERED',
  'RESERVED',
  'HOLD FOR LOAD',
  'RE-UPDATE',
]);

/** Words that describe a load in hand; a driver with no load cannot carry them. */
export const BOARD_WORDS_NEEDING_A_LOAD: ReadonlySet<string> = new Set(['DISPATCHED', 'AT PU', 'ENROUTE', 'UNLOADING']);

export function boardLoadsFor<T extends { status: string }>(
  status: string | null,
  loads: T[],
): { primary: T | null; queued: T[]; status: string | null } {
  const code = statusDef(status)?.code ?? null;
  const moving = loads.find((l) => BOARD_MOVING_LOAD_STATUSES.has(l.status)) ?? null;
  if (moving) {
    if (code === 'READY') {
      return { primary: null, queued: loads.filter((l) => !BOARD_MOVING_LOAD_STATUSES.has(l.status)), status };
    }
    return { primary: moving, queued: loads.filter((l) => l !== moving), status };
  }
  // Callers pass the loads in pickup order; a dispatched one is the job in hand before any other.
  const current =
    loads.find((l) => l.status === 'dispatched') ??
    loads.find((l) => BOARD_WAITING_LOAD_STATUSES.has(l.status)) ??
    null;
  if (!current) return { primary: null, queued: [], status };
  const replaced = code === null || BOARD_WORDS_A_LOAD_REPLACES.has(code);
  return {
    primary: current,
    queued: loads.filter((l) => l !== current),
    status: replaced ? 'DISPATCHED' : status,
  };
}

/**
 * Columns that describe the load in hand. What somebody typed there belongs to that load: once
 * the next load is the row's, the typed text gives way to the new load's own values (owner,
 * 2026-10-27: a dispatched prebook kept the old load's ETA and "SPRINGFIELD, MA").
 */
export const LOAD_BOUND_COLUMNS: ReadonlySet<string> = new Set(['load_number', 'eta', 'route', 'miles']);

/**
 * The moment the row's current load became its load: when it was dispatched, or when the
 * driver's previous load was delivered, whichever is later. Null when neither is known.
 */
export function loadInHandSince(
  primary: { id: string; dispatchedAt?: string | null },
  driverLoads: { id: string; deliveredAt?: string | null }[],
  nowIso: string,
): string | null {
  const now = Date.parse(nowIso);
  let since = primary.dispatchedAt ? Date.parse(primary.dispatchedAt) : Number.NaN;
  for (const l of driverLoads) {
    if (l.id === primary.id || !l.deliveredAt) continue;
    const at = Date.parse(l.deliveredAt);
    if (at <= now && !(at <= since)) since = at;
  }
  return Number.isNaN(since) ? null : new Date(since).toISOString();
}

/** A typed load-bound cell set before the current load was the row's: it was about the last one. */
export function typedForEarlierLoad(column: string, setAt: string, since: string | null): boolean {
  return since !== null && LOAD_BOUND_COLUMNS.has(column) && Date.parse(setAt) < Date.parse(since);
}

/**
 * The board order of the teams (owner, 2026-10-26): teams first, TEAM 1 at the top, then the solo
 * dispatchers, who carry no number. Stored per company; every board, report and rotation reads it.
 */
export const TeamOrderEntrySchema = z.object({
  dispatcherId: z.string(),
  dispatcherName: z.string(),
  dispatcherNickname: z.string().nullable().optional(),
  teamNumber: z.number().int().nullable(),
});
export type TeamOrderEntry = z.infer<typeof TeamOrderEntrySchema>;

export const TeamOrderViewSchema = z.object({
  /** 0 until somebody saves an order; the order shown is then the derived one. */
  version: z.number().int(),
  stored: z.boolean(),
  teams: z.array(TeamOrderEntrySchema),
  solos: z.array(TeamOrderEntrySchema),
});
export type TeamOrderView = z.infer<typeof TeamOrderViewSchema>;

export const WriteTeamOrderSchema = z.object({
  expectedVersion: z.number().int().min(0),
  /** Dispatcher ids, TEAM 1 first. */
  teams: z.array(z.string().min(1)).max(200),
  /** Dispatcher ids of the solo dispatchers, in board order. */
  solos: z.array(z.string().min(1)).max(200),
});
export type WriteTeamOrderInput = z.infer<typeof WriteTeamOrderSchema>;

/**
 * Who may separate a team - driver team or dispatcher team (owner, 2026-10-29): the administrators
 * and the dispatch managers (Dispatch Lead), nobody else. Role codes, as the session carries them.
 */
export const SEPARATE_TEAM_ROLES = ['administrator', 'dispatch_lead'] as const;
export function canSeparateTeams(roles: readonly string[]): boolean {
  return roles.some((r) => (SEPARATE_TEAM_ROLES as readonly string[]).includes(r));
}
