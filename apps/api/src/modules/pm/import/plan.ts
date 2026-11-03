import { normalizeAddress, vendorNameFor, type NormalizedAddress } from './address-norm';
import type { SheetRow } from './sheet';

/**
 * What the import would do (docs/pm-module/04-sheet-import.md §1, §3, §4, §6), decided before
 * anything is written.
 *
 * Pure: the sheet's rows and what the database already holds go in; a plan with every row's
 * fate and reason, the records to create, the vendors to draft and merge, and the report's
 * numbers come out. The dry run prints this; the real run applies it. Nothing here invents a
 * unit, a date or a responsible person.
 */

export type RowOutcome = 'import' | 'unchanged' | 'skip';

export type RowFlag =
  | 'sheet_arithmetic_stale'
  | 'cost_missing'
  | 'cost_out_of_range'
  | 'shop_missing'
  | 'shop_unmatched'
  | 'lease'
  | 'mileage_conflict'
  | 'duplicate_unit_row'
  | 'reading_age_unknown';

export interface RowResult {
  line: number;
  rowLabel: string | null;
  unit: string | null;
  unitId: string | null;
  group: string | null;
  outcome: RowOutcome;
  /** Why a row was skipped, in a sentence. */
  skipReason: string | null;
  flags: RowFlag[];
  notes: string[];
  /** The derived columns as recomputed from the inputs. */
  recomputed: { totalRunning: number; nextService: number; milesLeft: number } | null;
  intervalMiles: number | null;
  amount: number | null;
  shopKey: string | null;
}

export interface PlannedService {
  unitId: string;
  unitNumber: string;
  serviceDate: string;
  serviceOdometer: number;
  amount: number | null;
  vendorKey: string | null;
  flags: RowFlag[];
  line: number;
}

export interface PlannedPlan {
  unitId: string;
  unitNumber: string;
  intervalMiles: number;
  line: number;
}

export interface PlannedReading {
  unitId: string;
  unitNumber: string;
  /** ISO datetime the reading is dated at. */
  readingAt: string;
  odometerMiles: number;
  /** True when the sheet's export time was unknown and the import time stands in. */
  ageUnknown: boolean;
  /** `service` for LAST PM MILEAGE, `current` for CURRENT MILEAGE. */
  kind: 'service' | 'current';
  /** The mileage check failed (§3): stored as a conflict, never used. */
  conflict: boolean;
  line: number;
}

export interface PlannedVendor {
  key: string;
  name: string;
  address: NormalizedAddress;
  /** Every spelling the sheet used for it. */
  spellings: string[];
  isOwnYard: boolean;
  /** An existing vendor id when the key matched one; null for a draft to create. */
  existingId: string | null;
  rows: number[];
}

export interface PlannedUnitChange {
  unitId: string;
  unitNumber: string;
  groupName: string;
  pmResponsibility: 'us' | 'lessor';
  lessorName: string | null;
  unchanged: boolean;
}

export interface ImportSummary {
  rows: number;
  imported: number;
  unchanged: number;
  skipped: number;
  skippedBy: Record<string, number>;
  intervalDistribution: { intervalMiles: number; count: number }[];
  overdue: { count: number; of: number; totalMilesOver: number; worst: { unit: string; milesOver: number } | null };
  costMissing: number;
  shopMissing: number;
  staleArithmetic: number;
  leaseRows: number;
  vendorsMatched: number;
  vendorsDrafted: number;
  merges: { key: string; spellings: string[] }[];
  readingsAgeUnknown: boolean;
  dateFormats: Record<string, number>;
  unitsCreated: 0;
}

export interface ImportPlan {
  rows: RowResult[];
  services: PlannedService[];
  plans: PlannedPlan[];
  readings: PlannedReading[];
  vendors: PlannedVendor[];
  unitChanges: PlannedUnitChange[];
  summary: ImportSummary;
  /** Rows whose cells could not be read: the file is refused whole (§3: nothing is written until it parses). */
  parseErrors: { line: number; errors: string[] }[];
}

export interface ImportContext {
  /** Units by number, exactly as the roster spells them. Never extended by the import. */
  units: Map<string, { id: string; unitNumber: string; groupName: string | null; pmResponsibility: string; lessorName: string | null }>;
  /** Vendors already on record, by normalized address key. */
  vendors: Map<string, { id: string; name: string; isOwnYard: boolean }>;
  /** Completed OIL_CHANGE services already on record: `unitId|serviceDate|odometer`. */
  services: Set<string>;
  /** Active unit plans: unitId → interval. */
  unitPlans: Map<string, number>;
  /** Readings on record: `unitId|readingDate|odometer|source`. */
  readings: Set<string>;
  /** Today's date in the company's timezone. */
  today: string;
  /** When the import runs. */
  importedAt: Date;
  /** The sheet's export time, when the customer could say; null means the CURRENT readings are undated. */
  exportedAt: Date | null;
  /** Normalized keys of the customer's own yard(s). */
  ownYardKeys: Set<string>;
  timeZone: string;
  ownGroup: string;
}

export const IMPORT_LIMITS = {
  intervalMin: 5_000,
  intervalMax: 100_000,
  mileageMax: 2_000_000,
  dateWithinYears: 3,
  costMin: 0,
  costMax: 5_000,
};

function dateInZone(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at);
}

/**
 * Noon in the company's zone on a date: a date the sheet gives without a time.
 *
 * Worked out for whatever zone the company keeps rather than a Chicago-only table: noon on a
 * US clock lands on the same calendar day everywhere in the country, which is the only thing a
 * dated sheet promises.
 */
export function noonOf(date: string, timeZone: string): string {
  const guess = Date.parse(`${date}T12:00:00Z`);
  const offset = offsetMinutesIn(new Date(guess), timeZone);
  return new Date(guess - offset * 60_000).toISOString();
}

function offsetMinutesIn(at: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(at);
  const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((local - at.getTime()) / 60_000);
}


export function planPmImport(sheet: SheetRow[], ctx: ImportContext): ImportPlan {
  const parseErrors = sheet.filter((r) => r.parseErrors.length > 0).map((r) => ({ line: r.line, errors: r.parseErrors }));
  const rows: RowResult[] = [];
  const services: PlannedService[] = [];
  const plans: PlannedPlan[] = [];
  const readings: PlannedReading[] = [];
  const unitChanges: PlannedUnitChange[] = [];
  const vendorsByKey = new Map<string, PlannedVendor>();
  const dateFormats: Record<string, number> = {};
  const skippedBy: Record<string, number> = {};

  const skip = (row: SheetRow, unitId: string | null, reason: string, flags: RowFlag[] = []): RowResult => {
    skippedBy[reason] = (skippedBy[reason] ?? 0) + 1;
    return {
      line: row.line,
      rowLabel: row.rowLabel,
      unit: row.unit,
      unitId,
      group: row.group,
      outcome: 'skip',
      skipReason: reason,
      flags,
      notes: [],
      recomputed: null,
      intervalMiles: row.pmEvery,
      amount: row.amount,
      shopKey: null,
    };
  };

  // Duplicate unit rows: the later row wins, both are listed (§3).
  const lastLineByUnit = new Map<string, number>();
  for (const row of sheet) if (row.unit) lastLineByUnit.set(row.unit, row.line);

  const importedAtIso = ctx.importedAt.toISOString();
  const currentAt = ctx.exportedAt ? ctx.exportedAt.toISOString() : importedAtIso;
  const currentDate = dateInZone(ctx.exportedAt ?? ctx.importedAt, ctx.timeZone);

  for (const row of sheet) {
    if (row.lastPmDateFormat) dateFormats[row.lastPmDateFormat] = (dateFormats[row.lastPmDateFormat] ?? 0) + 1;
    if (row.parseErrors.length > 0) {
      rows.push(skip(row, null, 'could not be read'));
      continue;
    }
    if (!row.unit) {
      rows.push(skip(row, null, 'no unit number'));
      continue;
    }
    const unit = ctx.units.get(row.unit) ?? ctx.units.get(row.unit.replace(/^0+/, '')) ?? null;
    if (!unit) {
      rows.push(skip(row, null, 'unit not in NeWay'));
      continue;
    }
    const flags: RowFlag[] = [];
    const notes: string[] = [];
    if (lastLineByUnit.get(row.unit) !== row.line) {
      flags.push('duplicate_unit_row');
      rows.push(skip(row, unit.id, 'duplicate row for the unit; a later row wins', flags));
      continue;
    }
    if (row.pmEvery === null || row.pmEvery < IMPORT_LIMITS.intervalMin || row.pmEvery > IMPORT_LIMITS.intervalMax) {
      rows.push(skip(row, unit.id, row.pmEvery === null ? 'no interval' : `interval ${row.pmEvery.toLocaleString('en-US')} is outside 5,000–100,000`));
      continue;
    }
    if (!row.lastPmDate || row.lastPmMileage === null || row.currentMileage === null) {
      rows.push(skip(row, unit.id, 'last PM date, last PM mileage and current mileage are all required'));
      continue;
    }
    if (row.lastPmDate > ctx.today) {
      rows.push(skip(row, unit.id, `last PM date ${row.lastPmDate} is in the future`));
      continue;
    }
    const threeYearsAgo = `${Number(ctx.today.slice(0, 4)) - IMPORT_LIMITS.dateWithinYears}${ctx.today.slice(4)}`;
    if (row.lastPmDate < threeYearsAgo) {
      rows.push(skip(row, unit.id, `last PM date ${row.lastPmDate} is more than ${IMPORT_LIMITS.dateWithinYears} years ago`));
      continue;
    }

    // Derived columns: import the inputs, recompute the rest, and say when the sheet had drifted.
    const recomputed = {
      totalRunning: row.currentMileage - row.lastPmMileage,
      nextService: row.lastPmMileage + row.pmEvery,
      milesLeft: row.lastPmMileage + row.pmEvery - row.currentMileage,
    };
    const drifted =
      (row.totalRunning !== null && row.totalRunning !== recomputed.totalRunning) ||
      (row.nextService !== null && row.nextService !== recomputed.nextService) ||
      (row.milesLeft !== null && row.milesLeft !== recomputed.milesLeft);
    if (drifted) {
      flags.push('sheet_arithmetic_stale');
      notes.push(
        `sheet says ${row.totalRunning?.toLocaleString('en-US') ?? '—'} run / ${row.milesLeft?.toLocaleString('en-US') ?? '—'} left; recomputed ${recomputed.totalRunning.toLocaleString('en-US')} run / ${recomputed.milesLeft.toLocaleString('en-US')} left`,
      );
    }

    // Mileage: a current reading below the service one, or absurd, is stored as a conflict.
    const mileageConflict = row.currentMileage < row.lastPmMileage || row.currentMileage >= IMPORT_LIMITS.mileageMax;
    if (mileageConflict) flags.push('mileage_conflict');

    // Cost.
    let amount: number | null = row.amount;
    if (amount === null) flags.push('cost_missing');
    else if (amount <= IMPORT_LIMITS.costMin || amount >= IMPORT_LIMITS.costMax) {
      flags.push('cost_out_of_range');
      notes.push(`amount ${amount} is outside 0–5,000 and was not imported`);
      amount = null;
    }

    // Lease.
    const group = row.group?.trim() || null;
    const lease = group !== null && group.toLowerCase() !== ctx.ownGroup.toLowerCase();
    if (lease) flags.push('lease');

    // Shop.
    let shopKey: string | null = null;
    if (!row.shop) flags.push('shop_missing');
    else {
      const address = normalizeAddress(row.shop);
      if (!address.key) {
        flags.push('shop_unmatched');
        notes.push(`shop "${row.shop}" has no street number or ZIP to match on`);
      } else {
        shopKey = address.key;
        const existing = ctx.vendors.get(address.key) ?? null;
        const vendor = vendorsByKey.get(address.key) ?? {
          key: address.key,
          name: existing?.name ?? vendorNameFor(address),
          address,
          spellings: [],
          isOwnYard: existing?.isOwnYard || ctx.ownYardKeys.has(address.key),
          existingId: existing?.id ?? null,
          rows: [],
        };
        if (!vendor.spellings.includes(row.shop)) vendor.spellings.push(row.shop);
        vendor.rows.push(row.line);
        vendorsByKey.set(address.key, vendor);
      }
    }

    // What already exists: the same service, the same plan, the same readings.
    const serviceKey = `${unit.id}|${row.lastPmDate}|${row.lastPmMileage}`;
    const serviceExists = ctx.services.has(serviceKey);
    const planUnchanged = ctx.unitPlans.get(unit.id) === row.pmEvery;
    const serviceReadingKey = `${unit.id}|${row.lastPmDate}|${row.lastPmMileage}|import`;
    const currentReadingKey = `${unit.id}|${currentDate}|${row.currentMileage}|import`;
    const outcome: RowOutcome = serviceExists && planUnchanged ? 'unchanged' : 'import';

    if (!serviceExists) {
      services.push({
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        serviceDate: row.lastPmDate,
        serviceOdometer: row.lastPmMileage,
        amount,
        vendorKey: shopKey,
        flags,
        line: row.line,
      });
    }
    if (!planUnchanged) plans.push({ unitId: unit.id, unitNumber: unit.unitNumber, intervalMiles: row.pmEvery, line: row.line });
    if (!ctx.readings.has(serviceReadingKey)) {
      readings.push({
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        readingAt: noonOf(row.lastPmDate, ctx.timeZone),
        odometerMiles: row.lastPmMileage,
        ageUnknown: false,
        kind: 'service',
        conflict: false,
        line: row.line,
      });
    }
    if (!ctx.readings.has(currentReadingKey)) {
      readings.push({
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        readingAt: currentAt,
        odometerMiles: row.currentMileage,
        ageUnknown: ctx.exportedAt === null,
        kind: 'current',
        conflict: mileageConflict,
        line: row.line,
      });
    }
    if (ctx.exportedAt === null) flags.push('reading_age_unknown');

    if (group) {
      const responsibility: 'us' | 'lessor' = lease ? 'lessor' : 'us';
      const lessorName = lease ? group : null;
      unitChanges.push({
        unitId: unit.id,
        unitNumber: unit.unitNumber,
        groupName: group,
        pmResponsibility: responsibility,
        lessorName,
        unchanged: unit.groupName === group && unit.pmResponsibility === responsibility && (unit.lessorName ?? null) === lessorName,
      });
    }

    rows.push({
      line: row.line,
      rowLabel: row.rowLabel,
      unit: row.unit,
      unitId: unit.id,
      group,
      outcome,
      skipReason: null,
      flags,
      notes,
      recomputed,
      intervalMiles: row.pmEvery,
      amount,
      shopKey,
    });
  }

  // -- the report's numbers (§5)
  const considered = rows.filter((r) => r.outcome !== 'skip');
  const distribution = new Map<number, number>();
  for (const r of considered) if (r.intervalMiles !== null) distribution.set(r.intervalMiles, (distribution.get(r.intervalMiles) ?? 0) + 1);
  const overdueRows = considered.filter((r) => r.recomputed && r.recomputed.milesLeft < 0);
  const worst = overdueRows.reduce<{ unit: string; milesOver: number } | null>((acc, r) => {
    const over = -(r.recomputed as NonNullable<RowResult['recomputed']>).milesLeft;
    return acc === null || over > acc.milesOver ? { unit: r.unit ?? '', milesOver: over } : acc;
  }, null);
  const vendors = [...vendorsByKey.values()];

  const summary: ImportSummary = {
    rows: sheet.length,
    imported: rows.filter((r) => r.outcome === 'import').length,
    unchanged: rows.filter((r) => r.outcome === 'unchanged').length,
    skipped: rows.filter((r) => r.outcome === 'skip').length,
    skippedBy,
    intervalDistribution: [...distribution].map(([intervalMiles, count]) => ({ intervalMiles, count })).sort((a, b) => b.count - a.count || b.intervalMiles - a.intervalMiles),
    overdue: {
      count: overdueRows.length,
      of: considered.length,
      totalMilesOver: overdueRows.reduce((sum, r) => sum - (r.recomputed as NonNullable<RowResult['recomputed']>).milesLeft, 0),
      worst,
    },
    costMissing: considered.filter((r) => r.flags.includes('cost_missing')).length,
    shopMissing: considered.filter((r) => r.flags.includes('shop_missing')).length,
    staleArithmetic: considered.filter((r) => r.flags.includes('sheet_arithmetic_stale')).length,
    leaseRows: considered.filter((r) => r.flags.includes('lease')).length,
    vendorsMatched: vendors.filter((v) => v.existingId !== null).length,
    vendorsDrafted: vendors.filter((v) => v.existingId === null).length,
    merges: vendors.filter((v) => v.spellings.length > 1).map((v) => ({ key: v.key, spellings: v.spellings })),
    readingsAgeUnknown: ctx.exportedAt === null,
    dateFormats,
    unitsCreated: 0,
  };

  return { rows, services, plans, readings, vendors, unitChanges, summary, parseErrors };
}
