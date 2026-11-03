import { and, eq, inArray, isNull } from 'drizzle-orm';
import { chargeDriverAmount, type AccessorialAllocation } from '@neway/shared';
import type { DatabaseService } from '../../database/database.service';
import { acctSettings, acctSettlements } from '../../database/schema/accounting';
import { dispatchClaims } from '../../database/schema/dispatch-ops';
import { loads as loadsTable } from '../../database/schema/loads';
import { drivers } from '../../database/schema/roster';
import type { DateRange, IsoDate } from '../reporting/facts';
import {
  REPORTING_TIMEZONE,
  isBilledAccessorial,
  revenueDayOf,
  tonuFeeOf,
  type LoadRecord,
} from '../reporting/workspace/workspace-reporting-data-source';

/**
 * Accessorials - who gets what (owner, 2026-10-25: "how much of detention, TONU and the like goes
 * to the driver, how much to the worker, and how much to the company").
 *
 * For every accessorial the period's gross counts, at the same amounts and on the same days:
 *
 *  - **Billed** is what the broker is billed: accepted, billable charges at the billed amount
 *    (`isBilledAccessorial`), and for a TONU the cancellation fee (`tonuFeeOf`). Dated like gross:
 *    a delivered load on its Eastern delivery day, a TONU on the Eastern day of the cancellation
 *    (`revenueDayOf`).
 *  - **To driver**, in order of authority:
 *      1. what approved or paid driver statements paid for that charge (earning lines that name the
 *         charge; for a TONU every earning line on the load; for a charge Accounting put "in the
 *         percentage base", its share of the percentage line);
 *      2. with no approved statement holding the load, Accounting's allocation applied to the For
 *         driver amount (the statement's own arithmetic, `accessorialShareCents`'s rule);
 *      3. with no allocation either, the For driver amount (`chargeDriverAmount`: the amount the
 *         driver is paid on, the billed amount when nobody set another).
 *    It is unknown (null, with the reason) when the charge sits in a percentage base no statement
 *    has paid yet, when a delivered load has no driver, and for a TONU no statement pays (a TONU
 *    is created "not payable to driver" and frees the driver, so its For driver amount is not a
 *    driver figure) unless a For driver amount was set on it.
 *  - **To dispatcher** is the updater payout on the load's Detention & Layover claim
 *    (`dispatch_claims.updater_payout_cents`), matched to the load by L-number or REF.
 *  - **Company keeps** = Billed - To driver - To dispatcher, and is null whenever To driver is.
 *
 * Pure from `buildAccessorialSplit` down, so the tests recompute every split from raw rows.
 */

export const ACCESSORIAL_TYPES = ['detention', 'layover', 'tonu', 'lumper', 'other'] as const;
export type AccessorialType = (typeof ACCESSORIAL_TYPES)[number];

export const ACCESSORIAL_LABELS: Record<AccessorialType, string> = {
  detention: 'Detention',
  layover: 'Layover',
  tonu: 'TONU',
  lumper: 'Lumper',
  other: 'Other accessorials',
};

/** Load charge types and claim types to the five rows. Stop charges, fuel surcharge etc. are Other. */
export function accessorialTypeOf(chargeType: string): AccessorialType {
  const t = chargeType.trim().toLowerCase();
  return t === 'detention' || t === 'layover' || t === 'tonu' || t === 'lumper' ? t : 'other';
}

/** Where a To driver figure came from. */
export type DriverBasis = 'statement' | 'allocation' | 'for_driver' | 'excluded' | 'no_charge' | 'unknown';

// ------------------------------------------------------------------------------ raw rows

/** A load as the loads table stores it, with the fields the split reads. */
export interface AccessorialLoad extends LoadRecord {
  brokerReference?: string | null;
  driverName?: string | null;
  coDriverId?: string | null;
  charges?: Array<{
    id?: string;
    type: string;
    amount: number;
    billable?: boolean;
    status?: string;
    driverAmount?: number | null;
    description?: string;
    payableToDriver?: boolean;
  }>;
}

/** An approved or paid driver statement, only what the split reads. */
export interface PaidStatement {
  id: string;
  settlementNumber: string;
  status: string;
  partyId: string;
  partyName: string | null;
  loadIds: string[];
  earnings: Array<{
    kind: string;
    loadId: string | null;
    chargeId?: string | null;
    cents: number;
    payBasisCents?: number | null;
    description?: string;
  }>;
}

export interface ClaimRow {
  id: string;
  loadNumber: string;
  claimType: string;
  status: string;
  updater: string;
  updaterPayoutCents: number;
  claimDate: IsoDate;
}

export interface AccessorialRaw {
  loads: AccessorialLoad[];
  statements: PaidStatement[];
  /** `${loadId}:${chargeId}` → Accounting's "Include in driver statement?" answer. */
  allocations: Record<string, AccessorialAllocation>;
  claims: ClaimRow[];
  drivers: Array<{ id: string; name: string }>;
}

// ------------------------------------------------------------------------------ the result

export interface AccessorialEntry {
  loadId: string;
  loadNumber: string;
  brokerReference: string | null;
  type: AccessorialType;
  label: string;
  /** The Eastern business day it counts on (delivery, or the cancellation for a TONU). */
  day: IsoDate;
  charges: number;
  billed: number;
  toDriver: number | null;
  driverBasis: DriverBasis;
  /** Why To driver is unknown; null when it is known. */
  driverReason: string | null;
  toDispatcher: number;
  companyKeeps: number | null;
  driverName: string | null;
  dispatcherName: string | null;
  claimStatus: string | null;
  href: string;
}

export interface AccessorialRow {
  type: AccessorialType;
  label: string;
  loads: number;
  charges: number;
  claims: number;
  billed: number;
  toDriver: number | null;
  /** Why To driver (and so Company keeps) is not shown; null when it is. */
  toDriverReason: string | null;
  /** Entries in this row whose driver share is unknown. */
  unknownDriver: number;
  toDispatcher: number;
  companyKeeps: number | null;
}

export interface AccessorialSplit {
  range: DateRange;
  rows: AccessorialRow[];
  totals: Omit<AccessorialRow, 'type' | 'label'>;
  loads: { items: AccessorialEntry[]; total: number; page: number; pageSize: number };
  /** How each To driver figure was found, counted over entries. */
  driverBases: Partial<Record<DriverBasis, number>>;
  notes: string[];
}

const PAID_STATUSES = new Set(['approved', 'paid']);

// ------------------------------------------------------------------------------ the builder

export function buildAccessorialSplit(
  range: DateRange,
  raw: AccessorialRaw,
  paging: { page?: number; pageSize?: number } = {},
  timeZone: string = REPORTING_TIMEZONE,
): AccessorialSplit {
  const driverName = new Map(raw.drivers.map((d) => [d.id, d.name]));
  const inRange = (day: IsoDate) => day >= range.from && day <= range.to;

  // Statements by load: which approved/paid statements hold it, and their lines for it.
  const holders = new Map<string, PaidStatement[]>();
  for (const s of raw.statements) {
    if (!PAID_STATUSES.has(s.status)) continue;
    const ids = new Set([...s.loadIds, ...s.earnings.map((e) => e.loadId).filter((id): id is string => Boolean(id))]);
    for (const id of ids) holders.set(id, [...(holders.get(id) ?? []), s]);
  }

  // Claims by load number or REF, case and space insensitive.
  const key = (v: string | null | undefined) => (v ?? '').trim().toUpperCase();
  const loadByKey = new Map<string, AccessorialLoad>();
  for (const l of raw.loads) {
    if (key(l.loadNumber)) loadByKey.set(key(l.loadNumber), l);
  }
  for (const l of raw.loads) {
    const ref = key(l.brokerReference);
    if (ref && !loadByKey.has(ref)) loadByKey.set(ref, l);
  }
  const claimsByLoad = new Map<string, ClaimRow[]>();
  let unmatchedClaims = 0;
  for (const c of raw.claims) {
    const l = loadByKey.get(key(c.loadNumber));
    if (!l) {
      if (inRange(c.claimDate)) unmatchedClaims += 1;
      continue;
    }
    claimsByLoad.set(l.id, [...(claimsByLoad.get(l.id) ?? []), c]);
  }

  const entries: AccessorialEntry[] = [];
  for (const load of raw.loads) {
    const counted = revenueDayOf(load, timeZone);
    if (!counted || !inRange(counted.on)) continue;
    const held = holders.get(load.id) ?? [];
    const byType = new Map<AccessorialType, AccessorialEntry>();
    const entryFor = (type: AccessorialType): AccessorialEntry => {
      const found = byType.get(type);
      if (found) return found;
      const fresh: AccessorialEntry = {
        loadId: load.id,
        loadNumber: load.loadNumber,
        brokerReference: load.brokerReference ?? null,
        type,
        label: ACCESSORIAL_LABELS[type],
        day: counted.on,
        charges: 0,
        billed: 0,
        toDriver: 0,
        driverBasis: 'no_charge',
        driverReason: null,
        toDispatcher: 0,
        companyKeeps: null,
        driverName: load.driverName ?? (load.driverId ? driverName.get(load.driverId) ?? null : null),
        dispatcherName: null,
        claimStatus: null,
        // The load page is keyed by its L-number.
        href: `/loads/${encodeURIComponent(load.loadNumber)}`,
      };
      byType.set(type, fresh);
      return fresh;
    };
    const addDriver = (entry: AccessorialEntry, share: DriverShare) => {
      entry.charges += 1;
      if (entry.toDriver === null) return;
      if (share.amount === null) {
        entry.toDriver = null;
        entry.driverBasis = 'unknown';
        entry.driverReason = share.reason;
        return;
      }
      entry.toDriver = round(entry.toDriver + share.amount);
      // The weakest source wins the label: an entry part-paid by statement and part-expected is expected.
      entry.driverBasis = weaker(entry.driverBasis, share.basis);
    };

    if (counted.kind === 'tonu') {
      const entry = entryFor('tonu');
      entry.billed = round(tonuFeeOf(load));
      addDriver(entry, tonuDriverShare(load, held));
      const payer = held[0];
      if (!entry.driverName && payer) entry.driverName = payer.partyName ?? driverName.get(payer.partyId) ?? null;
    } else {
      for (const charge of load.charges ?? []) {
        if (!isBilledAccessorial(charge)) continue;
        const entry = entryFor(accessorialTypeOf(charge.type));
        entry.billed = round(entry.billed + (Number(charge.amount) || 0));
        addDriver(entry, chargeDriverShare(load, charge, held, raw.allocations));
      }
    }

    // The dispatcher's (updater's) payout on the load's claim. A claim with no billed charge of
    // its type still pays the updater, so it is shown on its own line with Billed 0.
    for (const claim of claimsByLoad.get(load.id) ?? []) {
      const entry = entryFor(accessorialTypeOf(claim.claimType));
      entry.toDispatcher = round(entry.toDispatcher + claim.updaterPayoutCents / 100);
      entry.dispatcherName = claim.updater.trim() || entry.dispatcherName;
      entry.claimStatus = claim.status;
    }

    for (const entry of byType.values()) {
      entry.companyKeeps = entry.toDriver === null ? null : round(entry.billed - entry.toDriver - entry.toDispatcher);
      entries.push(entry);
    }
  }

  const rows: AccessorialRow[] = [];
  for (const type of ACCESSORIAL_TYPES) {
    const mine = entries.filter((e) => e.type === type);
    if (mine.length === 0) continue;
    rows.push({ type, label: ACCESSORIAL_LABELS[type], ...summarise(mine) });
  }
  const totals = summarise(entries);

  const driverBases: Partial<Record<DriverBasis, number>> = {};
  for (const e of entries) driverBases[e.driverBasis] = (driverBases[e.driverBasis] ?? 0) + 1;

  const sorted = [...entries].sort(
    (a, b) => b.day.localeCompare(a.day) || b.loadNumber.localeCompare(a.loadNumber) || ACCESSORIAL_TYPES.indexOf(a.type) - ACCESSORIAL_TYPES.indexOf(b.type),
  );
  const pageSize = Math.min(100, Math.max(1, Math.floor(paging.pageSize ?? 25)));
  const pages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const page = Math.min(pages, Math.max(1, Math.floor(paging.page ?? 1)));

  const notes: string[] = [];
  if ((driverBases.allocation ?? 0) + (driverBases.for_driver ?? 0) > 0) {
    notes.push('To driver is what approved statements paid; where no approved statement holds the load yet, it is the expected pay from Accounting’s allocation or the For driver amount.');
  }
  if (unmatchedClaims > 0) {
    notes.push(`${unmatchedClaims} dispatcher claim${unmatchedClaims === 1 ? '' : 's'} dated in this period name${unmatchedClaims === 1 ? 's' : ''} a load number that is not in NeWay Loads, so ${unmatchedClaims === 1 ? 'its' : 'their'} payout is not counted here.`);
  }

  return {
    range,
    rows,
    totals,
    loads: { items: sorted.slice((page - 1) * pageSize, page * pageSize), total: sorted.length, page, pageSize },
    driverBases,
    notes,
  };
}

// ------------------------------------------------------------------------------ driver share

interface DriverShare {
  amount: number | null;
  basis: DriverBasis;
  reason: string | null;
}

const known = (amount: number, basis: DriverBasis): DriverShare => ({ amount: round(amount), basis, reason: null });
const unknown = (reason: string): DriverShare => ({ amount: null, basis: 'unknown', reason });

function chargeDriverShare(
  load: AccessorialLoad,
  charge: NonNullable<AccessorialLoad['charges']>[number],
  held: PaidStatement[],
  allocations: Record<string, AccessorialAllocation>,
): DriverShare {
  const al = charge.id ? allocations[`${load.id}:${charge.id}`] ?? null : null;
  const forDriverCents = Math.round(chargeDriverAmount(charge) * 100);

  // 1. What approved statements paid.
  if (held.length > 0) {
    let cents = 0;
    for (const s of held) {
      for (const e of s.earnings) {
        if (e.loadId !== load.id) continue;
        if (charge.id && e.chargeId === charge.id && (e.kind === 'accessorial' || e.kind === 'reimbursement')) cents += e.cents;
      }
    }
    if (al?.treatment === 'in_percentage_base') {
      // Its part of the percentage line(s): the line's pay scaled by this charge's share of the base.
      for (const s of held) {
        for (const e of s.earnings) {
          if (e.loadId !== load.id || e.kind !== 'percentage' || e.chargeId) continue;
          if ((e.description ?? '').includes('of linehaul')) continue;
          if (!e.payBasisCents || e.payBasisCents <= 0) return unknown('Paid inside a percentage line that does not say its base.');
          cents += Math.round((e.cents * forDriverCents) / e.payBasisCents);
        }
      }
    }
    return known(cents / 100, 'statement');
  }

  // 2. Accounting's allocation on the For driver amount.
  if (al) {
    if (al.treatment === 'excluded') return known(0, 'excluded');
    if (al.treatment === 'in_percentage_base') return unknown('In the driver’s percentage base: known once the statement is approved.');
    const gross = al.mode === 'full' ? forDriverCents : al.mode === 'percent' ? Math.round((forDriverCents * al.value) / 100) : Math.round(al.value * 100);
    // Split between recipients sums back to the whole, so the driver side is `gross`.
    return known(gross / 100, 'allocation');
  }

  // 3. The For driver amount.
  if (!load.driverId) return unknown('No driver on the load and no statement pays it.');
  return known(forDriverCents / 100, 'for_driver');
}

/** A TONU: what statements paid on the load, else a For driver amount set on the TONU charge. */
function tonuDriverShare(load: AccessorialLoad, held: PaidStatement[]): DriverShare {
  if (held.length > 0) {
    let cents = 0;
    for (const s of held) {
      for (const e of s.earnings) {
        if (e.loadId === load.id && e.kind !== 'reimbursement') cents += e.cents;
      }
    }
    return known(cents / 100, 'statement');
  }
  const charge = (load.charges ?? []).find((c) => c.type === 'tonu');
  const set = charge?.driverAmount;
  if (typeof set === 'number' && Number.isFinite(set) && set >= 0) return known(set, 'for_driver');
  return unknown('No approved statement pays this TONU and no For driver amount is set on it.');
}

const BASIS_STRENGTH: Record<DriverBasis, number> = { no_charge: 5, statement: 4, excluded: 3, allocation: 2, for_driver: 1, unknown: 0 };
function weaker(a: DriverBasis, b: DriverBasis): DriverBasis {
  return BASIS_STRENGTH[a] <= BASIS_STRENGTH[b] ? a : b;
}

function summarise(entries: AccessorialEntry[]): Omit<AccessorialRow, 'type' | 'label'> {
  const unknownDriver = entries.filter((e) => e.toDriver === null).length;
  const billed = round(entries.reduce((s, e) => s + e.billed, 0));
  const toDispatcher = round(entries.reduce((s, e) => s + e.toDispatcher, 0));
  const toDriver = unknownDriver > 0 ? null : round(entries.reduce((s, e) => s + (e.toDriver ?? 0), 0));
  return {
    loads: new Set(entries.map((e) => e.loadId)).size,
    charges: entries.reduce((s, e) => s + e.charges, 0),
    claims: entries.filter((e) => e.claimStatus !== null).length,
    billed,
    toDriver,
    toDriverReason:
      unknownDriver === 0
        ? null
        : unknownDriver === 1
          ? (entries.find((e) => e.toDriver === null)?.driverReason ?? 'The driver share of one load is not known.')
          : `The driver share of ${unknownDriver} of ${entries.length} is not known yet - see the loads.`,
    unknownDriver,
    toDispatcher,
    companyKeeps: toDriver === null ? null : round(billed - toDriver - toDispatcher),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// ------------------------------------------------------------------------------ the reader

/** Every row the split reads, for one company only. */
export async function readAccessorialRaw(database: DatabaseService, companyId: string): Promise<AccessorialRaw> {
  const db = database.db;
  const [loadRows, statementRows, settingsRows, claimRows, driverRows] = await Promise.all([
    db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, companyId), eq(loadsTable.isDemo, false))),
    db
      .select({ id: acctSettlements.id, status: acctSettlements.status, partyId: acctSettlements.partyId, record: acctSettlements.record })
      .from(acctSettlements)
      .where(
        and(
          eq(acctSettlements.companyId, companyId),
          eq(acctSettlements.partyType, 'driver'),
          inArray(acctSettlements.status, [...PAID_STATUSES]),
        ),
      ),
    db.select({ record: acctSettings.record }).from(acctSettings).where(eq(acctSettings.companyId, companyId)),
    db
      .select()
      .from(dispatchClaims)
      .where(and(eq(dispatchClaims.companyId, companyId), isNull(dispatchClaims.voidedAt))),
    db
      .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(drivers)
      .where(eq(drivers.companyId, companyId)),
  ]);
  const settings = (settingsRows[0]?.record ?? {}) as { accessorialAllocations?: Record<string, AccessorialAllocation> };
  return {
    loads: loadRows.map((r) => r.record as AccessorialLoad),
    statements: statementRows.map((s) => {
      const r = (s.record ?? {}) as {
        settlementNumber?: string;
        partyName?: string;
        loadIds?: string[];
        computation?: { earnings?: PaidStatement['earnings'] } | null;
      };
      return {
        id: s.id,
        settlementNumber: r.settlementNumber ?? s.id,
        status: s.status,
        partyId: s.partyId,
        partyName: r.partyName ?? null,
        loadIds: Array.isArray(r.loadIds) ? r.loadIds : [],
        earnings: (r.computation?.earnings ?? []).map((e) => ({
          kind: e.kind ?? '',
          loadId: e.loadId ?? null,
          chargeId: e.chargeId ?? null,
          cents: Number(e.cents) || 0,
          payBasisCents: e.payBasisCents ?? null,
          description: e.description ?? '',
        })),
      };
    }),
    allocations: settings.accessorialAllocations ?? {},
    claims: claimRows.map((c) => ({
      id: c.id,
      loadNumber: c.loadNumber,
      claimType: c.claimType,
      status: c.status,
      updater: c.updater,
      updaterPayoutCents: c.updaterPayoutCents,
      claimDate: String(c.claimDate),
    })),
    drivers: driverRows.map((d) => ({ id: d.id, name: `${d.firstName} ${d.lastName}`.trim() })),
  };
}
