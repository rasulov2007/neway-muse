import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  type WeekOdometer,
  leaseAssignmentsInWeek,
  earningsPreview, readRosterPercent,
  AccountingSettingsSchema,
  AccessorialAllocationSchema,
  batchTotals,
  computeStatement,
  computeVendorStatement,
  periodForCompletion,
  postSettlementFinalized,
  postSettlementPaid,
  reimbursableCents,
  settlementKindFor,
  settlementPeriodFor,
  loadCompletedTime,
  loadPayTime,
  payDateOverrideOf,
  payPeriodLabel,
  planFuelCharges,
  type FuelPurchase,
  type PayDateOverride,
  type SetPayDateInput,
  type AccessorialAllocation,
  type AccountingSettings,
  type DriverTx,
  type JournalEntry,
  type SettleableLoadV2,
  type SettlementKind,
  type SettlementPeriod,
  type StatementComputation,
  type StoredLoad,
  type VendorStatementComputation,
  type VendorTruckInput,
  LATE_ACCESSORIAL_SOURCE,
  accessorialShareCents,
  lateAccessorialKey,
  odometerConflictMessage,
  parseLateAccessorialKey,
  settleableAmounts,
  chargeDriverAmount,
  type LoadPayFactsInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { drivers, trucks } from '../../database/schema';
import { AuditService } from '../people/audit.service';
import { LoadsService } from '../loads/loads.service';
import type { PaymentBatchRecord } from './payees.service';
import { forbidden, newId, unprocessable } from '../dispatch-board/ops.helpers';
import { PmService } from '../pm/pm.service';
import { DriverAccountsService } from './driver-accounts.service';
import { LedgerService } from './ledger.service';
import { PayablesService } from './payables.service';
import { ReimbursementsService } from './reimbursements.service';
import { AccountingStore } from './store.service';
import { StateService } from '../state/state.service';

/** The Fleet › Fuel ledger: the workspace collection Relay's sync and the Fuel page write. */
const FUEL_LEDGER_KEY = 'ws2-fueltransactions';

/** The calendar day in US Eastern: every money day in the product is Eastern. */
const easternDay = (iso: string) => new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** Load statuses that are completed work. */
const DONE_STATUSES = ['delivered', 'closed', 'tonu'];

/** A load taken off a draft statement, kept on it so it can be put back in one click. */
export interface RemovedLoad {
  loadId: string;
  loadNumber: string;
  reason: string;
  by: string;
  at: string;
}

/**
 * A load placed on a statement by a person rather than by its pay time: put back, carried from
 * a statement it was taken off, paid as late, or moved here by a pay-date override. A regenerate
 * keeps these where they were put.
 */
export interface AddedLoad {
  loadId: string;
  loadNumber: string;
  how: 'put_back' | 'carried' | 'late' | 'pay_date';
  by: string;
  at: string;
}

/** What membership checks need of a statement, read in one query. */
interface IndexRow {
  id: string;
  partyType: 'driver' | 'vendor';
  partyId: string;
  periodStart: string;
  status: StatementRecord['status'];
  settlementNumber: string;
  partyName: string;
  loadIds: string[];
  removedLoads: RemovedLoad[];
  addedLoads: AddedLoad[];
}

/**
 * What every draft of a list read shares, read once (owner, 2026-10-22: the week list never
 * shows a stale draft): the settings, the loads, the allocations, the funded invoices, the
 * statement index and the fuel ledger.
 */
interface RecomputeCtx {
  settings: AccountingSettings;
  allocations: Record<string, AccessorialAllocation>;
  loads: StoredLoad[];
  funded: Set<string>;
  index: IndexRow[];
  fuel: FuelPurchase[] | null;
}

/** The lease side of a pay week: whether the driver had a truck, which one, and its odometer. */
interface WeekLease {
  assigned: boolean;
  truckId: string | null;
  odometer: WeekOdometer | null;
}

/** What a list read compares to decide whether a recomputed draft is worth saving. */
/** JSON with its keys sorted: a record read back from jsonb has its keys in another order. */
const stableJson = (v: unknown): string => JSON.stringify(v, (_k, x: unknown) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : x));
const moneyOf = (r: StatementRecord) => stableJson([r.status, r.netCents, r.payableCents, r.carryCents, r.exceptions, r.computation]);

/**
 * Settlement batches and statements (§8, §9): CD, LO & OO and VT (vendor) batches, generated
 * per Monday–Sunday week, reviewed, approved (frozen), exported, paid.
 *
 * Generation is idempotent: one statement per driver per week (source key). Approval writes
 * the recoveries, recurring charges, escrow deposit and carry-forward as transactions - each
 * once, each linked to the statement - and posts the ledger entry. An approved statement can be
 * reopened until its payment is posted (owner, 2026-10-21): reopening undoes each effect of the
 * approval and the statement is a draft again. Once paid, nothing mutates the statement;
 * corrections are new transactions on the next week.
 */

/**
 * The ledger's idempotency key for one approval of a statement. The first approval keeps the
 * key the posting builder gives it (every entry on file today); each approval after a reopen
 * carries the version, so the ledger does not mistake it for the entry that was reversed.
 */
export function finalizedSourceKey(settlementId: string, version: number): string {
  return version <= 1 ? `settlement_finalized:${settlementId}` : `settlement_finalized:${settlementId}:v${version}`;
}

/** Transactions approval writes from nothing: recurring, lease, escrow deposit, carry-forward. */
const APPROVAL_WRITTEN_SOURCES = new Set(['settlement', 'lease']);

/** The instant a wall-clock time on a calendar day falls at in `timeZone` (DST-safe, two passes). */
export function localTimeToUtc(day: string, hour: number, minute: number, timeZone: string): Date {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const wanted = Date.UTC(y, m - 1, d, hour, minute, 0);
  const offsetAt = (at: number) => {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(at));
    const n = (t: string) => Number(parts.find((p) => p.type === t)?.value ?? 0);
    return Date.UTC(n('year'), n('month') - 1, n('day'), n('hour'), n('minute'), n('second')) - at;
  };
  let guess = wanted - offsetAt(wanted);
  guess = wanted - offsetAt(guess);
  return new Date(guess);
}

export interface StatementRecord {
  id: string;
  sourceKey: string;
  settlementNumber: string;
  batchId: string;
  kind: SettlementKind;
  partyType: 'driver' | 'vendor';
  partyId: string;
  partyName: string;
  truckId: string | null;
  unitNumber: string | null;
  periodStart: string;
  periodEnd: string;
  /** When the pay period opens (Monday noon Eastern); absent on statements made before 2026-10-21. */
  startsAt?: string | null;
  cutoffAt: string;
  payDate: string;
  status: 'draft' | 'review' | 'approved' | 'paid' | 'reversed';
  netCents: number;
  payableCents: number;
  carryCents: number;
  /** The computation, frozen at approval; recomputed on every read before that. */
  computation: StatementComputation | null;
  vendor: VendorStatementComputation | null;
  /** The profile version, allocations and payee version the approval froze. */
  snapshot: { profileEffectiveFrom: string | null; payeeVersion: number | null; documents: string[] } | null;
  loadIds: string[];
  /** Loads taken off this statement while it was a draft ("Not on this statement"). */
  removedLoads?: RemovedLoad[];
  /** Loads a person put on this statement, kept there by a regenerate. */
  addedLoads?: AddedLoad[];
  exceptions: string[];
  approvedAt: string | null;
  approvedBy: string | null;
  paidAt: string | null;
  paymentId: string | null;
  paidCents: number | null;
  reversedAt: string | null;
  notes: string | null;
  /** Approved statement versions, each immutable. */
  versions: Array<{ version: number; at: string; by: string; netCents: number; payableCents: number }>;
  createdAt: string;
  updatedAt: string;
}

export interface BatchRecord {
  id: string;
  kind: SettlementKind;
  periodStart: string;
  periodEnd: string;
  startsAt?: string | null;
  cutoffAt: string;
  payDate: string;
  timezone: string;
  cutoffBasis: string;
  status: 'open' | 'review' | 'approved' | 'closed';
  generatedAt: string;
  generatedBy: string;
  statementIds: string[];
  /** Loads completed after the cutoff, listed for Accounting to assign - never dropped. */
  lateLoads: Array<{ loadId: string; loadNumber: string; completedAt: string; driverId: string | null }>;
  totals: { count: number; signedNetCents: number; payableCents: number; carryCents: number };
  closedAt: string | null;
  notes: string | null;
}

@Injectable()
export class SettlementsService {
  constructor(
    private readonly store: AccountingStore,
    private readonly ledger: LedgerService,
    private readonly loads: LoadsService,
    private readonly audit: AuditService,
    private readonly accounts: DriverAccountsService,
    private readonly payables: PayablesService,
    private readonly reimbursements: ReimbursementsService,
    private readonly pm: PmService,
    private readonly state: StateService,
  ) {}

  clock: () => Date = () => new Date();

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can change settlements.');
  }

  async settings(companyId: string): Promise<AccountingSettings> {
    return AccountingSettingsSchema.parse((await this.store.settings(companyId)).record);
  }

  /** Called after a statement is approved or paid, per load on it: the completion pipeline listens. */
  readonly afterChange: Array<(principal: Principal, loadId: string) => Promise<void>> = [];

  /**
   * The pay-week clock (owner, 2026-10-21): Monday at the configured time (12:00 noon by default)
   * to the next Monday, US Eastern - never the browser's zone and no longer the company record's.
   */
  periodCfg(_principal: Principal, s: AccountingSettings) {
    return { timezone: s.payPeriodTimezone, cutoffTime: s.payPeriodCutoffTime, payDay: s.payDay };
  }

  /** When a load counts for pay: Accounting's override, else its completion by the cutoff basis. */
  private payTimeOf(l: StoredLoad, settings: AccountingSettings): string {
    return loadPayTime(l, settings.cutoffBasis ?? 'delivered_at').at;
  }

  /**
   * Every statement that is not reversed, lean: who, which week, its status and which loads are
   * on it, taken off it, or put on it by a person. One query, read before deciding where a load goes.
   */
  private async statementIndex(principal: Principal, partyId?: string): Promise<IndexRow[]> {
    const rows = (await this.store.db.execute(sql`
      select id, party_type, party_id, period_start, status, record->>'settlementNumber' as number, record->>'partyName' as party_name,
             coalesce(record->'loadIds', '[]'::jsonb) as load_ids, coalesce(record->'removedLoads', '[]'::jsonb) as removed, coalesce(record->'addedLoads', '[]'::jsonb) as added
        from acct_settlements
       where company_id = ${principal.companyId} and status <> 'reversed' ${partyId ? sql`and party_id = ${partyId}` : sql``}`)) as unknown as Array<{ id: string; party_type: string; party_id: string; period_start: string; status: string; number: string; party_name: string; load_ids: unknown; removed: unknown; added: unknown }>;
    const json = <T>(v: unknown): T => (typeof v === 'string' ? JSON.parse(v) : v) as T;
    return rows.map((r) => ({ id: r.id, partyType: r.party_type as 'driver' | 'vendor', partyId: r.party_id, periodStart: String(r.period_start).slice(0, 10), status: r.status as StatementRecord['status'], settlementNumber: r.number, partyName: r.party_name, loadIds: json<string[]>(r.load_ids) ?? [], removedLoads: json<RemovedLoad[]>(r.removed) ?? [], addedLoads: json<AddedLoad[]>(r.added) ?? [] }));
  }

  /**
   * Rewrites a draft statement - its loads changed - and saves it recomputed, version-checked.
   * An approved or paid statement is never rewritten here.
   */
  private async rewriteDraft(principal: Principal, id: string, change: (r: StatementRecord) => StatementRecord): Promise<StatementRecord> {
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, id);
    if (stored.record.status !== 'draft' && stored.record.status !== 'review') throw unprocessable(`${stored.record.settlementNumber} is ${stored.record.status}; reopen it before its loads change.`);
    const changed = change(structuredClone(stored.record));
    const recomputed = changed.partyType === 'driver' ? await this.recomputeDriver(principal, changed) : changed;
    const after = { ...recomputed, updatedAt: this.clock().toISOString() };
    await this.store.update('acct_settlements', principal.companyId, id, stored.version, after);
    return after;
  }

  /** Takes a load off a draft entirely: its list, and any record of it being taken off or put on. */
  private static withoutLoad(r: StatementRecord, loadId: string): StatementRecord {
    return { ...r, loadIds: r.loadIds.filter((x) => x !== loadId), removedLoads: (r.removedLoads ?? []).filter((x) => x.loadId !== loadId), addedLoads: (r.addedLoads ?? []).filter((x) => x.loadId !== loadId) };
  }

  /** Puts a load on a draft, placed there by a person. */
  private static withLoad(r: StatementRecord, add: AddedLoad): StatementRecord {
    const base = SettlementsService.withoutLoad(r, add.loadId);
    return { ...base, loadIds: [...base.loadIds, add.loadId], addedLoads: [...(base.addedLoads ?? []), add] };
  }

  // ------------------------------------------------------------ reads

  async batches(principal: Principal): Promise<BatchRecord[]> {
    return (await this.store.list<BatchRecord>('acct_settlement_batches', principal.companyId, undefined, 'period_start desc')).map((r) => r.record);
  }

  async statements(principal: Principal, where?: { batchId?: string; partyId?: string; kind?: string }): Promise<StatementRecord[]> {
    const conds = [];
    if (where?.batchId) conds.push(sql`batch_id = ${where.batchId}`);
    if (where?.partyId) conds.push(sql`party_id = ${where.partyId}`);
    if (where?.kind) conds.push(sql`kind = ${where.kind}`);
    const rows = await this.store.list<StatementRecord>('acct_settlements', principal.companyId, conds.length ? sql.join(conds, sql` and `) : undefined, 'period_start desc');
    return rows.map((r) => r.record);
  }

  /**
   * The statements as the week list shows them (owner, 2026-10-22): every driver draft (draft or
   * review) is recomputed on read, exactly as opening it does, so a voided odometer reading, a
   * new charge or a changed override shows in the list at once - nobody has to press "Update
   * draft statements". A draft whose figures changed is saved, version-checked (a row changed
   * meanwhile is left for the next read, never overwritten) and audited, and its batch totals
   * follow. Approved and paid statements are never recomputed. What every draft shares is read
   * once for the whole list. Only a list of one week (batchId) or one driver (partyId) is
   * recomputed; the unfiltered list of every week is returned as stored.
   */
  async freshStatements(principal: Principal, where?: { batchId?: string; partyId?: string; kind?: string }): Promise<StatementRecord[]> {
    const conds = [];
    if (where?.batchId) conds.push(sql`batch_id = ${where.batchId}`);
    if (where?.partyId) conds.push(sql`party_id = ${where.partyId}`);
    if (where?.kind) conds.push(sql`kind = ${where.kind}`);
    const rows = await this.store.list<StatementRecord>('acct_settlements', principal.companyId, conds.length ? sql.join(conds, sql` and `) : undefined, 'period_start desc');
    // One week (a batch) or one driver: bounded. The whole list of every week is read as stored -
    // drafts of every week ever made would make it slow, and the week list asks by batch.
    if (!where?.batchId && !where?.partyId) return rows.map((r) => r.record);
    const open = rows.filter((r) => r.record.partyType === 'driver' && (r.record.status === 'draft' || r.record.status === 'review'));
    if (open.length === 0) return rows.map((r) => r.record);
    const ctx = await this.recomputeContext(principal);
    const fresh = new Map<string, StatementRecord>();
    const touched = new Set<string>();
    const now = this.clock().toISOString();
    // A few drafts at a time: each is a handful of per-driver reads.
    const queue = [...open];
    const worker = async () => {
      for (let r = queue.shift(); r; r = queue.shift()) {
        let next: StatementRecord;
        try {
          next = await this.recomputeDriver(principal, r.record, ctx);
        } catch {
          continue; // the stored figures stand; opening the statement shows the error
        }
        fresh.set(r.id, next);
        if (moneyOf(next) === moneyOf(r.record)) continue;
        try {
          await this.store.update('acct_settlements', principal.companyId, r.id, r.version, { ...next, updatedAt: now });
        } catch {
          continue; // changed since this read: the next read saves it
        }
        touched.add(next.batchId);
        await this.audit.write(principal, {
          action: 'settlement_draft_refreshed',
          entityType: 'settlement',
          entityId: r.id,
          entityLabel: r.record.settlementNumber,
          summary: `${r.record.settlementNumber} recomputed on read: net ${r.record.netCents / 100} → ${next.netCents / 100}, payable ${r.record.payableCents / 100} → ${next.payableCents / 100}, carry ${r.record.carryCents / 100} → ${next.carryCents / 100}`,
          changes: [
            { field: 'netCents', old: String(r.record.netCents), new: String(next.netCents) },
            { field: 'payableCents', old: String(r.record.payableCents), new: String(next.payableCents) },
            { field: 'carryCents', old: String(r.record.carryCents), new: String(next.carryCents) },
          ],
        });
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, open.length) }, worker));
    for (const b of touched) await this.refreshBatch(principal, b);
    return rows.map((r) => fresh.get(r.id) ?? r.record);
  }

  /** Reads what every draft recompute shares, once. */
  private async recomputeContext(principal: Principal): Promise<RecomputeCtx> {
    const [settings, allocations, loadsAll, invoices, index, fuel] = await Promise.all([
      this.settings(principal.companyId),
      this.allocations(principal),
      this.loads.list(principal, { includeDemo: false }),
      this.store.list<{ loadId: string }>('acct_invoices', principal.companyId, sql`is_current = true and status in ('funded','paid','partially_paid') and record->>'supplementOf' is null`),
      this.statementIndex(principal),
      this.fuelLedger(principal),
    ]);
    return { settings, allocations, loads: loadsAll, funded: new Set(invoices.map((i) => i.record.loadId)), index, fuel };
  }

  async statement(principal: Principal, id: string): Promise<StatementRecord> {
    const rows = await this.store.list<StatementRecord>('acct_settlements', principal.companyId, sql`(id = ${id} or record->>'settlementNumber' = ${id})`);
    if (!rows[0]) throw unprocessable(`Statement ${id} is not on file.`);
    const rec = rows[0].record;
    // A draft is recomputed on read so it reflects the account as it stands now.
    if (rec.status === 'draft' || rec.status === 'review') return rec.partyType === 'driver' ? this.recomputeDriver(principal, rec) : this.recomputeVendor(principal, rec);
    return rec;
  }

  // ------------------------------------------------------------ the loads of a week

  private toSettleable(l: StoredLoad, allocations: Record<string, AccessorialAllocation>, invoiced: Set<string>): SettleableLoadV2 {
    const r = l as StoredLoad & Record<string, unknown>;
    // Driver pay reads the For driver amounts; the real ones ride along for the statement's Real
    // column and the gross stays what the broker pays (owner, 2026-10-23).
    const money = settleableAmounts(r);
    return {
      id: l.id,
      loadNumber: l.loadNumber,
      brokerReference: (r['brokerReference'] as string | null | undefined) ?? null,
      loadUpdatedAt: l.updatedAt,
      completedAt: l.deliveredAt ?? l.updatedAt,
      // The day the freight actually went on, preferred over the appointment it was booked for.
      pickedUpOn: (() => {
        const p = l.stops.find((s) => s.kind === 'pickup') ?? l.stops[0];
        return p ? (p.loadedAt ?? p.departedAt ?? p.arrivedAt ?? p.appointmentStartAt ?? null) : null;
      })(),
      originLabel: `${l.stops[0]?.city ?? ''}, ${l.stops[0]?.state ?? ''}`,
      destinationLabel: `${l.stops.at(-1)?.city ?? ''}, ${l.stops.at(-1)?.state ?? ''}`,
      loadedMiles: Number(r['loadedMiles']) || 0,
      emptyMiles: Number(r['emptyMiles']) || 0,
      grossCents: money.grossCents,
      linehaulCents: money.linehaulCents,
      realLinehaulCents: money.realLinehaulCents,
      driverIds: [l.driverId, (r['coDriverId'] as string | null | undefined) ?? null].filter((d): d is string => Boolean(d)),
      accessorials: money.accessorials.map((a) => ({ id: a.id, type: a.type, description: a.description, amountCents: a.amountCents, realAmountCents: a.realAmountCents, allocation: allocations[`${l.id}:${a.id}`] ?? null })),
      funded: invoiced.has(l.id),
      status: l.status,
    };
  }

  private async allocations(principal: Principal): Promise<Record<string, AccessorialAllocation>> {
    const raw = (await this.store.settings(principal.companyId)).record;
    return ((raw['accessorialAllocations'] as Record<string, AccessorialAllocation>) ?? {});
  }

  /** Accounting's answer to "Include in driver statement?" for one charge on one load. */
  async allocateAccessorial(principal: Principal, loadId: string, input: unknown) {
    this.requireEdit(principal);
    const allocation = AccessorialAllocationSchema.parse(input);
    const settings = await this.store.settings(principal.companyId);
    const map = ((settings.record['accessorialAllocations'] as Record<string, AccessorialAllocation>) ?? {});
    map[`${loadId}:${allocation.chargeId}`] = { ...allocation, decidedBy: principal.userName ?? principal.userId, decidedAt: this.clock().toISOString() };
    await this.store.saveSettings(principal.companyId, settings.version, { ...settings.record, accessorialAllocations: map }, principal.userName ?? principal.userId);
    await this.audit.write(principal, { action: 'accessorial_allocated', entityType: 'load', entityId: loadId, entityLabel: loadId, summary: `${allocation.chargeId}: ${allocation.treatment} · ${allocation.nature} · ${allocation.recipients.length} recipient(s)`, changes: [] });
    await this.syncLateAccessorial(principal, loadId, allocation.chargeId);
    return allocation;
  }

  /**
   * An accessorial that reaches a load after the load's statement was approved or paid - a layover
   * billed on a supplemental invoice (owner, 2026-10-21) - is paid by a transaction of its own: the
   * driver's share by Accounting's allocation, on the first statement whose pay week was still open
   * when the charge was added. The approved statement is never touched, and load pay skips a charge
   * a transaction carries, so it is paid once even if that statement is reopened.
   *
   * Re-runnable: one transaction per load, charge and driver (its source key). An unclaimed one
   * follows a changed allocation or amount, or is voided with the reason when it no longer pays;
   * one a statement has approved is never changed here.
   */
  async syncLateAccessorial(principal: Principal, loadId: string, chargeId: string): Promise<{ written: number; voided: number }> {
    const load = await this.loads.get(principal, loadId).catch(() => null);
    if (!load) return { written: 0, voided: 0 };
    const r = load as StoredLoad & Record<string, unknown>;
    const charge = ((r['charges'] as Array<{ id: string; type: string; description: string; amount: number; driverAmount?: number | null; status?: string; addedAfterInvoice?: { invoiceId: string } | null }>) ?? []).find((c) => c.id === chargeId) ?? null;
    const live = Boolean(charge && charge.type !== 'linehaul' && charge.status !== 'draft' && charge.status !== 'dropped');
    const al = (await this.allocations(principal))[`${load.id}:${chargeId}`] ?? null;
    const existing = await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`source = ${LATE_ACCESSORIAL_SOURCE} and load_id = ${load.id} and source_key like ${`${LATE_ACCESSORIAL_SOURCE}:${load.id}:${chargeId}:%`}`);
    const now = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    let written = 0;
    let voided = 0;
    const settled = new Map<string, IndexRow>();
    const driverIds = [load.driverId, (r['coDriverId'] as string | null | undefined) ?? null].filter((d): d is string => Boolean(d));
    for (const driverId of new Set([...driverIds, ...(al?.recipients ?? [])])) {
      const holder = (await this.statementIndex(principal, driverId)).find((s) => s.partyType === 'driver' && (s.status === 'approved' || s.status === 'paid') && s.loadIds.includes(load.id));
      if (holder) settled.set(driverId, holder);
    }
    for (const [driverId, holder] of settled) {
      // The driver's share of the For driver amount, as on the statement (owner, 2026-10-23).
      const cents = live ? accessorialShareCents(Math.round(chargeDriverAmount(charge!) * 100), al, driverId) : 0;
      const key = lateAccessorialKey(load.id, chargeId, driverId);
      const mine = existing.find((e) => e.record.sourceKey === key) ?? null;
      // Already paid on the statement that holds the load (it was on the load when approved). A
      // charge added after invoicing was not; an older statement without charge ids is read by
      // the charge's description.
      const stm = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, holder.id);
      const lines = (stm?.record.computation?.earnings ?? []).filter((e) => e.loadId === load.id && (e.kind === 'accessorial' || e.kind === 'reimbursement') && !e.txId);
      const legacy = lines.every((e) => !e.chargeId);
      const paidThere = !charge?.addedAfterInvoice && lines.some((e) => e.chargeId === chargeId || (legacy && Boolean(charge) && e.description.startsWith(charge!.description)));
      if (cents <= 0 || paidThere) {
        if (mine && mine.record.state !== 'void' && !mine.record.settlementId) {
          await this.store.update<DriverTx>('acct_driver_transactions', principal.companyId, mine.id, mine.version, { ...mine.record, state: 'void', reason: paidThere ? `Already paid on ${holder.settlementNumber}` : 'The charge no longer pays this driver (allocation or charge changed)' });
          voided += 1;
        }
        continue;
      }
      const tx: DriverTx = {
        id: mine?.id ?? newId('dtx'),
        driverId,
        kind: 'adjustment',
        onDate: easternDay(now),
        occurredAt: now,
        amountCents: cents,
        recoveredCents: 0,
        state: 'approved',
        source: LATE_ACCESSORIAL_SOURCE,
        sourceKey: key,
        truckId: load.truckId ?? null,
        loadId: load.id,
        loadNumber: load.loadNumber,
        nature: al?.nature === 'reimbursement' ? 'reimbursement' : 'earning',
        settlementId: null,
        description: `${charge!.description} · ${load.loadNumber} (added after ${holder.settlementNumber})`,
        companyCost: false,
        approvedBy: by,
        approvedAt: now,
        reason: null,
      };
      if (!mine) {
        if ((await this.store.insert('acct_driver_transactions', principal.companyId, tx)).created) written += 1;
      } else if (!mine.record.settlementId && (mine.record.state === 'void' || mine.record.amountCents !== cents || mine.record.nature !== tx.nature)) {
        await this.store.update<DriverTx>('acct_driver_transactions', principal.companyId, mine.id, mine.version, { ...mine.record, ...tx, id: mine.id, onDate: mine.record.state === 'void' ? tx.onDate : mine.record.onDate, occurredAt: mine.record.state === 'void' ? tx.occurredAt : mine.record.occurredAt });
        written += 1;
      }
    }
    // A driver no longer holding the load on a settled statement, or no longer a recipient: unclaimed rows go.
    for (const e of existing) {
      const k = parseLateAccessorialKey(e.record.sourceKey);
      if (!k || settled.has(k.driverId) || e.record.state === 'void' || e.record.settlementId) continue;
      await this.store.update<DriverTx>('acct_driver_transactions', principal.companyId, e.id, e.version, { ...e.record, state: 'void', reason: 'The load is no longer on a settled statement of this driver' });
      voided += 1;
    }
    if (written + voided > 0) {
      await this.audit.write(principal, { action: 'late_accessorial_synced', entityType: 'load', entityId: load.id, entityLabel: load.loadNumber, summary: `${charge?.description ?? chargeId} added after the load was settled: ${written} driver pay line(s) written for the next statement, ${voided} voided.`, changes: [] });
    }
    return { written, voided };
  }

  /**
   * The loads that count for pay in a period: completed, with their pay time (Accounting's
   * override, else the completion) inside the Monday-noon window. Loads from an earlier period
   * that are on no statement are listed as late for Accounting to place - except the ones a
   * person took off a statement, which carry to the next statement by themselves.
   */
  private async weekLoads(principal: Principal, period: SettlementPeriod, settings: AccountingSettings) {
    const [all, allocations, invoices, index] = await Promise.all([this.loads.list(principal, { includeDemo: false }), this.allocations(principal), this.store.list<{ loadId: string; status: string }>('acct_invoices', principal.companyId, sql`is_current = true and status in ('funded','paid','partially_paid') and record->>'supplementOf' is null`), this.statementIndex(principal)]);
    const funded = new Set(invoices.map((i) => i.record.loadId));
    const cfg = this.periodCfg(principal, settings);
    const done = all.filter((l) => DONE_STATUSES.includes(l.status));
    const onStatement = new Set(index.flatMap((s) => s.loadIds));
    const takenOff = new Set(index.flatMap((s) => s.removedLoads.map((r) => r.loadId)));
    const inWeek: StoredLoad[] = [];
    const late: BatchRecord['lateLoads'] = [];
    for (const l of done) {
      const payAt = this.payTimeOf(l, settings);
      const p = periodForCompletion(payAt, cfg);
      if (p.start === period.start) inWeek.push(l);
      // Counted for an earlier week but never on a statement: surfaced as late, for assignment.
      else if (p.start < period.start && !onStatement.has(l.id) && !takenOff.has(l.id)) late.push({ loadId: l.id, loadNumber: l.loadNumber, completedAt: payAt, driverId: l.driverId });
    }
    return { loads: inWeek.map((l) => this.toSettleable(l, allocations, funded)), late, raw: inWeek, done, index, allocations, funded };
  }

  /**
   * Which loads go on one driver's draft for a period, and where each came from:
   *   - put there by a person earlier (put back, carried, paid as late, moved by a pay date): kept;
   *   - the loads whose pay time is in the period ("own");
   *   - loads taken off one of the driver's earlier statements and on no statement since: carried;
   *   - late loads Accounting chose to pay this week.
   * A load taken off this statement stays off. A load on another of the driver's statements that
   * is approved or paid is never added - one load is paid once. An own load sitting on another
   * draft only because of an older rule moves here (`strip`); one a person put there stays there.
   */
  private placeLoads(a: {
    driverId: string;
    period: SettlementPeriod;
    stmId: string;
    here: IndexRow | null;
    others: IndexRow[];
    own: SettleableLoadV2[];
    late: StoredLoad[];
    doneById: Map<string, StoredLoad>;
    by: string;
    at: string;
    settleable: (l: StoredLoad) => SettleableLoadV2;
  }): { loads: SettleableLoadV2[]; added: AddedLoad[]; strip: Array<{ statementId: string; settlementNumber: string; loadId: string; loadNumber: string }> } {
    const removedHere = new Set((a.here?.removedLoads ?? []).map((r) => r.loadId));
    const out = new Map<string, SettleableLoadV2>();
    const added: AddedLoad[] = [];
    const strip: Array<{ statementId: string; settlementNumber: string; loadId: string; loadNumber: string }> = [];
    const holder = (loadId: string) => a.others.find((s) => s.loadIds.includes(loadId)) ?? null;
    const consider = (l: SettleableLoadV2, how: 'own' | AddedLoad['how'], existing?: AddedLoad) => {
      if (out.has(l.id) || removedHere.has(l.id) || !l.driverIds.includes(a.driverId)) return;
      const other = holder(l.id);
      if (other) {
        if (other.status === 'approved' || other.status === 'paid') return;
        if (how !== 'own' || other.addedLoads.some((x) => x.loadId === l.id)) return;
        strip.push({ statementId: other.id, settlementNumber: other.settlementNumber, loadId: l.id, loadNumber: l.loadNumber });
      }
      out.set(l.id, l);
      if (how !== 'own') added.push(existing ?? { loadId: l.id, loadNumber: l.loadNumber, how, by: a.by, at: a.at });
    };
    for (const x of a.here?.addedLoads ?? []) {
      const l = a.doneById.get(x.loadId);
      if (l) consider(a.settleable(l), x.how, x);
    }
    for (const l of a.own) consider(l, 'own');
    for (const s of a.others) {
      if (s.periodStart >= a.period.start) continue;
      for (const r of s.removedLoads) {
        const l = a.doneById.get(r.loadId);
        if (l && !a.others.some((o) => o.loadIds.includes(r.loadId))) consider(a.settleable(l), 'carried');
      }
    }
    for (const l of a.late) consider(a.settleable(l), 'late');
    return { loads: [...out.values()], added, strip };
  }

  /**
   * Fuel on the driver statement (owner, 2026-10-21): the Fleet › Fuel ledger's purchases for the
   * driver in the pay period become `fuel` transactions on their account - once each, keyed by
   * the purchase - which the statement takes as deductions when the profile deducts fuel, and
   * shows as the company's cost when it does not. Approval applies them and Reopen gives them
   * back exactly like any other deduction. A purchase the ledger changed is brought in line while
   * no statement has taken it; one no longer the driver's is voided with the reason, never deleted.
   */
  private async fuelLedger(principal: Principal): Promise<FuelPurchase[] | null> {
    const stored = await this.state.getFor(principal.companyId, FUEL_LEDGER_KEY);
    if (!stored) return null;
    try {
      const parsed = JSON.parse(stored.value) as unknown;
      return Array.isArray(parsed) ? (parsed as FuelPurchase[]) : null;
    } catch {
      return null;
    }
  }

  private async syncFuel(principal: Principal, input: { driverId: string; truckId: string | null; period: SettlementPeriod; deductFuel: boolean }, ledger?: FuelPurchase[] | null): Promise<void> {
    const rows = ledger === undefined ? await this.fuelLedger(principal) : ledger;
    if (!rows) return;
    const existing = await this.accounts.transactions(principal, input.driverId);
    const plan = planFuelCharges({ driverId: input.driverId, truckId: input.truckId, period: input.period, purchases: rows, existing, deductFuel: input.deductFuel, timezone: input.period.timezone });
    let added = 0;
    for (const t of plan.add) if ((await this.store.insert('acct_driver_transactions', principal.companyId, { ...t, id: newId('dtx') } as DriverTx)).created) added += 1;
    for (const u of plan.update) {
      await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, u.id, (tx) => (tx.settlementId || tx.recoveredCents > 0 || tx.state === 'void' ? tx : { ...tx, amountCents: u.amountCents, description: u.description, onDate: u.onDate, occurredAt: u.occurredAt }));
    }
    for (const id of plan.void) {
      await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => (tx.settlementId || tx.recoveredCents > 0 || tx.state === 'void' ? tx : { ...tx, state: 'void', reason: 'No longer this driver’s purchase in the Fleet › Fuel ledger' }));
    }
    if (added + plan.update.length + plan.void.length > 0) {
      await this.audit.write(principal, { action: 'driver_fuel_synced', entityType: 'driver', entityId: input.driverId, entityLabel: input.driverId, summary: `Fuel ledger → driver account for ${payPeriodLabel(input.period)}: ${added} added, ${plan.update.length} updated, ${plan.void.length} voided${plan.alreadyImported.length ? `, ${plan.alreadyImported.length} already imported from Relay CSV` : ''}.`, changes: [] });
    }
  }

  /** On a statement that is approved or paid: the load has been settled and must not earn again. */
  private async onSettledStatement(principal: Principal, loadId: string): Promise<boolean> {
    const rows = (await this.store.db.execute(sql`select 1 from acct_settlements where company_id = ${principal.companyId} and status in ('approved','paid') and record->'loadIds' ? ${loadId} limit 1`)) as unknown as unknown[];
    return rows.length > 0;
  }


  // ------------------------------------------------------------ preview

  /**
   * What a batch for this kind and week would contain, before anything is written: the period
   * the date maps to, the setup that is still missing, and per driver the loads, the earning
   * preview and the blockers. Never generates, never approves.
   */
  async preview(principal: Principal, input: { kind: SettlementKind; weekOf: string }) {
    const settings = await this.settings(principal.companyId);
    const cfg = this.periodCfg(principal, settings);
    const period = settlementPeriodFor(input.weekOf, cfg);
    const setup: Array<{ key: string; label: string; detail: string }> = [];
    if (settings.cutoffBasis === null) setup.push({ key: 'cutoffBasis', label: 'Cutoff time source', detail: 'Which timestamp (actual delivery or status update) decides the week. Not decided.' });
    if (settings.cutoffTimezoneConfirmed !== true) setup.push({ key: 'cutoffTimezoneConfirmed', label: 'Cutoff clock', detail: `The pay week runs Monday ${settings.payPeriodCutoffTime} to Monday ${settings.payPeriodCutoffTime}, US Eastern (${settings.payPeriodTimezone}); nobody has confirmed it in Settings › Accounting yet.` });
    if (input.kind !== 'vt' && settings.teamBaseMileageSplit === null) setup.push({ key: 'teamBaseMileageSplit', label: 'Team base-mileage split', detail: 'Only team loads are affected.' });
    const basisForPreview = settings.cutoffBasis ?? 'delivered_at';
    const { loads, late } = await this.weekLoads(principal, period, { ...settings, cutoffBasis: basisForPreview });
    const existing = (await this.store.list<BatchRecord>('acct_settlement_batches', principal.companyId, sql`kind = ${input.kind} and period_start = ${period.start}`))[0] ?? null;
    if (input.kind === 'vt') {
      return { kind: input.kind, period, periodLabel: payPeriodLabel(period), timezone: period.timezone, cutoffBasis: settings.cutoffBasis, previewBasis: basisForPreview, setup, canGenerate: setup.filter((s) => s.key !== 'teamBaseMileageSplit').length === 0, existingBatch: existing ? { id: existing.id, status: existing.record.status, statements: existing.record.statementIds.length } : null, lateLoads: late.length, loadsInWeek: loads.length, drivers: [] as never[] };
    }
    const profiles = await this.store.driverProfiles(principal.companyId);
    const driverRows = await this.store.db.select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, driverNumber: drivers.driverNumber, truckId: drivers.currentTruckId, status: drivers.status }).from(drivers).where(eq(drivers.companyId, principal.companyId));
    const out: Array<{ driverId: string; driverNumber: string; name: string; unitNumber: string | null; contractType: string; settledLoads: string[]; loads: Array<{ loadId: string; loadNumber: string; grossCents: number; cents: number | null; blockers: string[] }>; grossCents: number; earnedCents: number | null; blockers: string[]; statementStatus: string | null; statementId: string | null; statementNumber: string | null }> = [];
    for (const d of driverRows) {
      const prof = await this.accounts.profileOn(principal, d.id, period.end);
      const profileRec = await this.accounts.profile(principal, d.id);
      const contract = prof?.contractType ?? (profiles.find((p) => p.driverId === d.id)?.contractType as 'CD' | 'LO' | 'OO' | undefined) ?? 'CD';
      if (settlementKindFor(contract) !== input.kind) continue;
      const mineAll = loads.filter((l) => l.driverIds.includes(d.id));
      const settledIds = new Set<string>();
      for (const l of mineAll) if (await this.onSettledStatement(principal, l.id)) settledIds.add(l.id);
      const mine = mineAll.filter((l) => !settledIds.has(l.id));
      if (mineAll.length === 0 && d.status !== 'active') continue;
      const ambiguous = Boolean(prof && (prof.loadedPlan.kind === 'percent_of_gross' || prof.loadedPlan.kind === 'percent_of_linehaul') && readRosterPercent(prof.loadedPlan.rate).ambiguous && !profileRec.record.rateConfirmedAt);
      const rows = mine.map((l) => {
        const pv = earningsPreview(l, d.id, prof, { teamBaseMileageSplit: settings.teamBaseMileageSplit }, ambiguous);
        const blockers = [...pv.blockers];
        if (profileRec.defaulted) blockers.unshift('Pay plan not reviewed');
        return { loadId: l.id, loadNumber: l.loadNumber, grossCents: l.grossCents, cents: pv.cents, blockers };
      });
      const driverBlockers = [...new Set(rows.flatMap((r) => r.blockers))];
      if (profileRec.record.openingDebtCents === null || !profileRec.record.openingDebtReconciled) driverBlockers.push('Opening debt not reconciled (final net waits; earnings preview does not)');
      const truck = d.truckId ? (await this.store.db.select({ unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.id, d.truckId)).limit(1))[0] : null;
      const stm = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, `stm_${d.id}_${period.start}`);
      out.push({ driverId: d.id, driverNumber: d.driverNumber, name: `${d.first} ${d.last}`.trim(), unitNumber: truck?.unitNumber ?? null, contractType: contract, settledLoads: mineAll.filter((l) => settledIds.has(l.id)).map((l) => l.loadNumber), loads: rows, grossCents: rows.reduce((s, r) => s + r.grossCents, 0), earnedCents: rows.some((r) => r.cents === null || r.blockers.length > 0) ? null : rows.reduce((s, r) => s + (r.cents ?? 0), 0), blockers: driverBlockers, statementStatus: stm?.record.status ?? null, statementId: stm?.record.id ?? null, statementNumber: stm?.record.settlementNumber ?? null });
    }
    return { kind: input.kind, period, periodLabel: payPeriodLabel(period), timezone: period.timezone, cutoffBasis: settings.cutoffBasis, previewBasis: basisForPreview, setup, canGenerate: setup.filter((s) => s.key !== 'teamBaseMileageSplit').length === 0, existingBatch: existing ? { id: existing.id, status: existing.record.status, statements: existing.record.statementIds.length } : null, lateLoads: late.length, loadsInWeek: loads.length, drivers: out };
  }

  // ------------------------------------------------------------ generate

  /** Generates (or refreshes) the batch for a kind and a week. Approved statements are left alone. */
  async generate(principal: Principal, input: { kind: SettlementKind; weekOf: string; includeLateLoadIds?: string[] }): Promise<BatchRecord> {
    this.requireEdit(principal);
    const settings = await this.settings(principal.companyId);
    if (settings.cutoffBasis === null) throw unprocessable('Cutoff time source is not configured (Settings › Accounting): which timestamp decides the week. Batches wait until it is chosen.');
    if (settings.cutoffTimezoneConfirmed !== true) throw unprocessable(`The cutoff clock (${settings.payPeriodTimezone}) has not been confirmed in Settings › Accounting. Batches wait until it is.`);
    const period = settlementPeriodFor(input.weekOf, this.periodCfg(principal, settings));
    const now = this.clock().toISOString();
    const existing = (await this.store.list<BatchRecord>('acct_settlement_batches', principal.companyId, sql`kind = ${input.kind} and period_start = ${period.start}`))[0] ?? null;
    const batchId = existing?.id ?? `bat_${principal.companyId}_${input.kind}_${period.start}`;
    if (existing && existing.record.status === 'closed') throw unprocessable(`${input.kind.toUpperCase()} ${period.start} is closed.`);
    const { loads, late, done, index, allocations, funded } = await this.weekLoads(principal, period, settings);
    const extra = done.filter((l) => (input.includeLateLoadIds ?? []).includes(l.id));
    const all = [...loads, ...extra.map((l) => this.toSettleable(l, allocations, funded))];
    const by = principal.userName ?? principal.userId;
    const placed = new Set<string>();

    const statementIds: string[] = [];
    if (input.kind === 'vt') {
      statementIds.push(...(await this.generateVendorStatements(principal, batchId, period, all, settings)));
    } else {
      const profiles = await this.store.driverProfiles(principal.companyId);
      const driverRows = await this.store.db.select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, type: drivers.driverType, truckId: drivers.currentTruckId, status: drivers.status }).from(drivers).where(eq(drivers.companyId, principal.companyId));
      const doneById = new Map(done.map((l) => [l.id, l]));
      for (const d of driverRows) {
        const prof = await this.accounts.profileOn(principal, d.id, period.end);
        const contract = prof?.contractType ?? (profiles.find((p) => p.driverId === d.id)?.contractType as 'CD' | 'LO' | 'OO' | undefined) ?? 'CD';
        if (settlementKindFor(contract) !== input.kind) continue;
        const stmId = `stm_${d.id}_${period.start}`;
        const mineIndex = index.filter((s) => s.partyType === 'driver' && s.partyId === d.id);
        const here = mineIndex.find((s) => s.id === stmId) ?? null;
        if (here && (here.status === 'approved' || here.status === 'paid')) {
          statementIds.push(stmId);
          continue;
        }
        const placement = this.placeLoads({ driverId: d.id, period, stmId, here, others: mineIndex.filter((s) => s.id !== stmId), own: loads.filter((l) => l.driverIds.includes(d.id)), late: extra.filter((l) => this.toSettleable(l, allocations, funded).driverIds.includes(d.id)), doneById, by, at: now, settleable: (l) => this.toSettleable(l, allocations, funded) });
        // A load whose pay time is this week, still on another week's draft (moved by the noon
        // rule or a pay-date override), leaves that draft: one load, one statement.
        for (const s of placement.strip) {
          await this.rewriteDraft(principal, s.statementId, (r) => SettlementsService.withoutLoad(r, s.loadId));
          await this.audit.write(principal, { action: 'settlement_load_moved', entityType: 'settlement', entityId: s.statementId, entityLabel: s.settlementNumber, summary: `${s.loadNumber} left ${s.settlementNumber}: it counts for pay in ${payPeriodLabel(period)}.`, changes: [{ field: 'loadIds', old: s.loadId, new: null }] });
          const batchOf = (await this.store.find<StatementRecord>('acct_settlements', principal.companyId, s.statementId))?.record.batchId;
          if (batchOf) await this.refreshBatch(principal, batchOf);
        }
        const mine = placement.loads;
        for (const l of mine) placed.add(l.id);
        await this.accounts.syncWorkOrderCharges(principal, d.id);
        if (prof) await this.syncFuel(principal, { driverId: d.id, truckId: d.truckId ?? null, period, deductFuel: prof.switches.deductFuel === true });
        const txs = await this.accounts.transactions(principal, d.id);
        const recurring = await this.accounts.recurring(principal, d.id);
        const weekActivity = mine.length > 0 || txs.some((t) => t.onDate >= period.start && t.onDate <= period.end) || recurring.some((r) => r.status === 'active' && r.appliesWhenNoWork);
        if (!weekActivity && d.status !== 'active') continue;
        const id = `stm_${d.id}_${period.start}`;
        const already = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, id);
        if (already && (already.record.status === 'approved' || already.record.status === 'paid')) {
          statementIds.push(id);
          continue;
        }
        const profileRec = await this.accounts.profile(principal, d.id);
        const owed = await this.reimbursements.eligibleFor(principal, { driverId: d.id, periodStart: period.start, periodEnd: period.end, settlementId: id });
        const lease = prof?.lease ? await this.weekLease(principal, d.id, period) : null;
        const comp = computeStatement({ odometer: lease?.odometer ?? null, leaseTruckAssigned: lease ? lease.assigned : undefined, driverId: d.id, period, profile: prof, loads: mine, transactions: txs, recurring, openingDebtCents: profileRec.record.openingDebtReconciled ? (profileRec.record.openingDebtCents ?? 0) : profileRec.record.openingDebtCents, reimbursements: owed.map((e) => ({ id: e.id, loadId: e.loadId, loadNumber: e.loadNumber, description: e.description, cents: reimbursableCents(e.reimbursement!), onDate: e.onDate })), settings: { teamBaseMileageSplit: settings.teamBaseMileageSplit, payOnFundingOnly: settings.payOnFundingOnly }, leaseOverrides: profileRec.record.leaseOverrides ?? [] });
        await this.reimbursements.syncFor(principal, { id, settlementNumber: `ST-${period.start.replace(/-/g, '')}-${d.id.slice(-6).toUpperCase()}` }, owed.map((e) => e.id));
        const truck = d.truckId ? (await this.store.db.select({ unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.id, d.truckId)).limit(1))[0] : null;
        const rec: StatementRecord = {
          id,
          sourceKey: id,
          settlementNumber: `ST-${period.start.replace(/-/g, '')}-${d.id.slice(-6).toUpperCase()}`,
          batchId,
          kind: input.kind,
          partyType: 'driver',
          partyId: d.id,
          partyName: `${d.first} ${d.last}`.trim(),
          truckId: d.truckId ?? null,
          unitNumber: truck?.unitNumber ?? null,
          periodStart: period.start,
          periodEnd: period.end,
          startsAt: period.startsAt ?? null,
          cutoffAt: period.cutoffAt,
          payDate: period.payDate,
          status: comp.exceptions.length > 0 ? 'review' : 'draft',
          netCents: comp.netCents,
          payableCents: comp.payableCents,
          carryCents: comp.carryCents,
          computation: comp,
          vendor: null,
          snapshot: null,
          loadIds: mine.map((l) => l.id),
          removedLoads: already?.record.removedLoads ?? [],
          addedLoads: placement.added,
          exceptions: comp.exceptions,
          approvedAt: null,
          approvedBy: null,
          paidAt: null,
          paymentId: null,
          paidCents: null,
          reversedAt: null,
          notes: null,
          versions: already?.record.versions ?? [],
          createdAt: already?.record.createdAt ?? now,
          updatedAt: now,
        };
        if (already) await this.store.update('acct_settlements', principal.companyId, id, already.version, rec);
        else await this.store.insert('acct_settlements', principal.companyId, rec);
        statementIds.push(id);
      }
    }
    const rows = await Promise.all(statementIds.map((id) => this.store.get<StatementRecord>('acct_settlements', principal.companyId, id)));
    const batch: BatchRecord = {
      id: batchId,
      kind: input.kind,
      periodStart: period.start,
      periodEnd: period.end,
      startsAt: period.startsAt ?? null,
      cutoffAt: period.cutoffAt,
      payDate: period.payDate,
      timezone: period.timezone,
      cutoffBasis: settings.cutoffBasis,
      status: existing?.record.status === 'approved' ? 'approved' : 'open',
      generatedAt: now,
      generatedBy: principal.userName ?? principal.userId,
      statementIds,
      lateLoads: late.filter((l) => !placed.has(l.loadId)),
      totals: batchTotals(rows.map((r) => r.record)),
      closedAt: null,
      notes: existing?.record.notes ?? null,
    };
    if (existing) await this.store.update('acct_settlement_batches', principal.companyId, batchId, existing.version, batch);
    else await this.store.insert('acct_settlement_batches', principal.companyId, batch);
    await this.audit.write(principal, { action: 'settlement_batch_generated', entityType: 'settlement_batch', entityId: batchId, entityLabel: batchId, summary: `${input.kind.toUpperCase()} ${period.start}–${period.end}: ${statementIds.length} statement(s), ${late.length} late load(s)`, changes: [] });
    return batch;
  }

  private async generateVendorStatements(principal: Principal, batchId: string, period: SettlementPeriod, loads: SettleableLoadV2[], settings: AccountingSettings): Promise<string[]> {
    const arrangements = (await this.store.list<{ id: string; vendorId: string; truckId: string; effectiveFrom: string; effectiveTo: string | null; percentBps: number | null }>('acct_vendor_arrangements', principal.companyId)).map((r) => r.record);
    const inForce = arrangements.filter((a) => a.effectiveFrom <= period.end && (!a.effectiveTo || a.effectiveTo >= period.start));
    const vendorsList = await this.payables.vendors(principal);
    const truckRows = await this.store.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(eq(trucks.companyId, principal.companyId));
    const rawLoads = await this.loads.list(principal, { includeDemo: false });
    const expenses = (await this.payables.expenses(principal)).filter((e) => e.onDate >= period.start && e.onDate <= period.end);
    const driverStatements = await this.statements(principal, {});
    const ids: string[] = [];
    const byVendor = new Map<string, typeof inForce>();
    for (const a of inForce) (byVendor.get(a.vendorId) ?? byVendor.set(a.vendorId, []).get(a.vendorId)!).push(a);
    for (const [vendorId, arrs] of byVendor) {
      const vendor = vendorsList.find((v) => v.id === vendorId);
      const trucksIn: VendorTruckInput[] = arrs.map((a) => {
        const unit = truckRows.find((t) => t.id === a.truckId)?.unitNumber ?? a.truckId;
        const truckLoads = rawLoads.filter((l) => l.truckId === a.truckId && ['delivered', 'closed', 'tonu'].includes(l.status)).map((l) => loads.find((x) => x.id === l.id)).filter((x): x is SettleableLoadV2 => Boolean(x));
        const driverPay = driverStatements
          .filter((s) => s.periodStart === period.start && s.partyType === 'driver' && s.truckId === a.truckId && s.status !== 'reversed')
          .map((s) => ({ driverId: s.partyId, driverName: s.partyName, settlementId: s.id, cents: s.computation?.grossCents ?? 0 }));
        const fuel = expenses.filter((e) => e.truckId === a.truckId && e.categoryCode === 'fuel').reduce((s, e) => s + Math.round(e.amount * 100), 0);
        const tolls = expenses.filter((e) => e.truckId === a.truckId && e.categoryCode === 'tolls').reduce((s, e) => s + Math.round(e.amount * 100), 0);
        const other = expenses.filter((e) => e.truckId === a.truckId && e.categoryCode !== 'fuel' && e.categoryCode !== 'tolls' && e.burden === 'recoverable_vendor').map((e) => ({ description: e.description, cents: Math.round(e.amount * 100), sourceKey: e.sourceKey }));
        return { truckId: a.truckId, unitNumber: unit, percentBps: a.percentBps, loads: truckLoads.map((l) => ({ loadId: l.id, loadNumber: l.loadNumber, completedAt: l.completedAt, route: `${l.originLabel} → ${l.destinationLabel}`, grossCents: l.grossCents })), driverPay, fuelCents: fuel, tollsCents: tolls, other, adjustments: [] };
      });
      const id = `stm_v_${vendorId}_${period.start}`;
      const already = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, id);
      if (already && (already.record.status === 'approved' || already.record.status === 'paid')) {
        ids.push(id);
        continue;
      }
      const vendorAdj = (already?.record.vendor?.vendorAdjustmentsCents ? [{ description: 'Vendor adjustment', cents: already.record.vendor.vendorAdjustmentsCents, reason: 'carried' }] : []);
      const comp = computeVendorStatement(trucksIn, vendorAdj, settings.vendorDefaultPercentBps);
      const now = this.clock().toISOString();
      const rec: StatementRecord = {
        id,
        sourceKey: id,
        settlementNumber: `VT-${period.start.replace(/-/g, '')}-${vendorId.slice(-6).toUpperCase()}`,
        batchId,
        kind: 'vt',
        partyType: 'vendor',
        partyId: vendorId,
        partyName: vendor?.name ?? vendorId,
        truckId: null,
        unitNumber: trucksIn.map((t) => t.unitNumber).join(', '),
        periodStart: period.start,
        periodEnd: period.end,
        cutoffAt: period.cutoffAt,
        payDate: period.payDate,
        status: comp.exceptions.length > 0 ? 'review' : 'draft',
        netCents: comp.payoutCents,
        payableCents: Math.max(0, comp.payoutCents),
        carryCents: Math.max(0, -comp.payoutCents),
        computation: null,
        vendor: comp,
        snapshot: null,
        loadIds: trucksIn.flatMap((t) => t.loads.map((l) => l.loadId)),
        exceptions: comp.exceptions,
        approvedAt: null,
        approvedBy: null,
        paidAt: null,
        paymentId: null,
        paidCents: null,
        reversedAt: null,
        notes: null,
        versions: already?.record.versions ?? [],
        createdAt: already?.record.createdAt ?? now,
        updatedAt: now,
      };
      if (already) await this.store.update('acct_settlements', principal.companyId, id, already.version, rec);
      else await this.store.insert('acct_settlements', principal.companyId, rec);
      ids.push(id);
    }
    return ids;
  }

  private async recomputeDriver(principal: Principal, rec: StatementRecord, ctx?: RecomputeCtx): Promise<StatementRecord> {
    const settings = ctx?.settings ?? (await this.settings(principal.companyId));
    const period: SettlementPeriod = { start: rec.periodStart, end: rec.periodEnd, ...(rec.startsAt ? { startsAt: rec.startsAt } : {}), cutoffAt: rec.cutoffAt, payDate: rec.payDate, timezone: settings.payPeriodTimezone };
    const allocations = ctx?.allocations ?? (await this.allocations(principal));
    const onIt = (ctx?.loads ?? (await this.loads.list(principal, { includeDemo: false }))).filter((l) => rec.loadIds.includes(l.id));
    // A load already on another of the driver's approved or paid statements is never paid twice,
    // however it came to be listed here too.
    const index = ctx ? ctx.index.filter((s) => s.partyId === rec.partyId) : await this.statementIndex(principal, rec.partyId);
    const settledElsewhere = new Map(index.filter((s) => s.id !== rec.id && s.partyType === 'driver' && (s.status === 'approved' || s.status === 'paid')).flatMap((s) => s.loadIds.map((id) => [id, s.settlementNumber] as const)));
    const raw = onIt.filter((l) => !settledElsewhere.has(l.id));
    const funded = ctx?.funded ?? new Set((await this.store.list<{ loadId: string }>('acct_invoices', principal.companyId, sql`is_current = true and status in ('funded','paid','partially_paid') and record->>'supplementOf' is null`)).map((i) => i.record.loadId));
    const prof = await this.accounts.profileOn(principal, rec.partyId, rec.periodEnd);
    const profileRec = await this.accounts.profile(principal, rec.partyId);
    if (prof) await this.syncFuel(principal, { driverId: rec.partyId, truckId: rec.truckId, period, deductFuel: prof.switches.deductFuel === true }, ctx ? ctx.fuel : undefined);
    // What this driver laid out and has been approved for: their own items only, so on a team
    // load the reimbursement follows the driver who actually paid, never both of them.
    const owed = await this.reimbursements.eligibleFor(principal, { driverId: rec.partyId, periodStart: rec.periodStart, periodEnd: rec.periodEnd, settlementId: rec.id });
    const lease = prof?.lease ? await this.weekLease(principal, rec.partyId, period) : null;
    const comp = computeStatement({ odometer: lease?.odometer ?? null, leaseTruckAssigned: lease ? lease.assigned : undefined, driverId: rec.partyId, period, profile: prof, loads: raw.map((l) => this.toSettleable(l, allocations, funded)), transactions: await this.accounts.transactions(principal, rec.partyId), recurring: await this.accounts.recurring(principal, rec.partyId), openingDebtCents: profileRec.record.openingDebtReconciled ? (profileRec.record.openingDebtCents ?? 0) : profileRec.record.openingDebtCents, reimbursements: owed.map((e) => ({ id: e.id, loadId: e.loadId, loadNumber: e.loadNumber, description: e.description, cents: reimbursableCents(e.reimbursement!), onDate: e.onDate })), settings: { teamBaseMileageSplit: settings.teamBaseMileageSplit, payOnFundingOnly: settings.payOnFundingOnly }, leaseOverrides: profileRec.record.leaseOverrides ?? [] });
    // Claiming is idempotent: the same items land on the same statement however often a draft
    // recomputes, and an item already spoken for by another statement was never in `owed`.
    await this.reimbursements.syncFor(principal, { id: rec.id, settlementNumber: rec.settlementNumber }, owed.map((e) => e.id));
    for (const l of onIt) if (settledElsewhere.has(l.id)) comp.excluded.push({ loadId: l.id, loadNumber: l.loadNumber, reason: `Already paid on ${settledElsewhere.get(l.id)}` });
    return { ...rec, computation: comp, exceptions: comp.exceptions, netCents: comp.netCents, payableCents: comp.payableCents, carryCents: comp.carryCents, status: comp.exceptions.length > 0 ? 'review' : rec.status === 'review' ? 'draft' : rec.status };
  }

  /**
   * The truck's odometer for a settlement week, from the ELD (Samsara) readings the PM module
   * keeps: the latest good reading by the week's last day, and the latest before it began. The
   * lease tier and the maintenance fee are figured from these; a draft recomputes as new readings
   * arrive, and approval freezes what it was paid on.
   */
  private async weekOdometer(principal: Principal, truckId: string | null, window: { start: string; end: string }): Promise<WeekOdometer | null> {
    if (!truckId) return null;
    const [truck] = await this.store.db.select({ unitNumber: trucks.unitNumber }).from(trucks).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, truckId))).limit(1);
    const read = async (cond: ReturnType<typeof sql>) => {
      const rows = (await this.store.db.execute(sql`select odometer_miles, reading_at from odometer_readings where company_id = ${principal.companyId} and unit_id = ${truckId} and status = 'ok' and ${cond} order by reading_at desc limit 1`)) as unknown as Array<{ odometer_miles: number; reading_at: string | Date }>;
      return rows[0] ?? null;
    };
    const end = await read(sql`reading_date <= ${window.end}`);
    const start = await read(sql`reading_date < ${window.start}`);
    return { unitNumber: truck?.unitNumber ?? null, endMiles: end ? Number(end.odometer_miles) : null, startMiles: start ? Number(start.odometer_miles) : null, endReadAt: end ? new Date(end.reading_at).toISOString() : null };
  }

  /**
   * Lease charges only while a truck is assigned (owner, 2026-10-22). The driver's truck
   * assignments (truck_driver_assignments, this company's) that overlap the pay week decide
   * whether the lease sheet is taken at all - any overlap is the whole week, none is no charge -
   * and which truck's odometer the tier and the maintenance fee are figured from: each assigned
   * truck inside its own window, the miles of two trucks in one week added up, the tier from the
   * truck held last.
   */
  private async weekLease(principal: Principal, driverId: string, period: SettlementPeriod): Promise<WeekLease> {
    const rows = (await this.store.db.execute(sql`select truck_id, assigned_on::text as assigned_on, ended_on::text as ended_on from truck_driver_assignments where company_id = ${principal.companyId} and driver_id = ${driverId} and assigned_on <= ${period.end} and (ended_on is null or ended_on > ${period.start})`)) as unknown as Array<{ truck_id: string; assigned_on: string; ended_on: string | null }>;
    const windows = leaseAssignmentsInWeek(rows.map((r) => ({ truckId: r.truck_id, assignedOn: String(r.assigned_on).slice(0, 10), endedOn: r.ended_on ? String(r.ended_on).slice(0, 10) : null })), period);
    if (windows.length === 0) return { assigned: false, truckId: null, odometer: null };
    const segments = await Promise.all(windows.map((w) => this.weekOdometer(principal, w.truckId, { start: w.from, end: w.to })));
    const last = segments.at(-1)!;
    const lastTruck = windows.at(-1)!.truckId;
    if (segments.length === 1) return { assigned: true, truckId: lastTruck, odometer: last };
    const complete = segments.every((o) => o && o.endMiles !== null && o.startMiles !== null);
    const miles = complete ? segments.reduce((t, o) => t + Math.max(0, o!.endMiles! - o!.startMiles!), 0) : null;
    return { assigned: true, truckId: lastTruck, odometer: last ? { ...last, startMiles: complete ? last.startMiles : null, miles } : null };
  }

  /**
   * The odometer typed in from the statement (owner, 2026-10-21): a truck without ELD readings
   * leaves the lease tier and the maintenance fee unfigured, so Accounting enters what the
   * odometer said at the start of the week (the day before it began) and at its end. Each figure
   * becomes a manual reading on the truck, at 23:59 of that day on the company clock, written
   * through the PM module so its mileage check applies: a figure below the last good reading is
   * stored as a conflict and never used, and the statement keeps saying so. The draft is then read
   * again, which recomputes it from the readings.
   */
  async enterOdometer(principal: Principal, id: string, input: { startMiles?: number | null; endMiles?: number | null; note?: string | null }) {
    this.requireEdit(principal);
    const rec = await this.statement(principal, id);
    if (rec.partyType !== 'driver') throw unprocessable('Only a driver statement has a truck odometer.');
    if (rec.status !== 'draft' && rec.status !== 'review') throw unprocessable(`${rec.settlementNumber} is ${rec.status}; it is locked and its odometer cannot change.`);
    const settingsNow = await this.settings(principal.companyId);
    const assignedTruck = (await this.weekLease(principal, rec.partyId, { start: rec.periodStart, end: rec.periodEnd, cutoffAt: rec.cutoffAt, payDate: rec.payDate, timezone: settingsNow.payPeriodTimezone })).truckId;
    const truckId = assignedTruck ?? rec.truckId;
    if (!truckId) throw unprocessable(`${rec.settlementNumber} has no truck: assign the driver's truck first.`);
    const start = input.startMiles ?? null;
    const end = input.endMiles ?? null;
    if (start === null && end === null) throw unprocessable('Enter the odometer at the start of the week, at its end, or both.');
    if (start !== null && end !== null && end < start) throw unprocessable('The odometer at the end of the week cannot be below the start.');
    const now = this.clock();
    const tz = principal.companyTimezone;
    const dayBefore = (day: string) => { const d = new Date(`${day}T12:00:00Z`); d.setUTCDate(d.getUTCDate() - 1); return d.toISOString().slice(0, 10); };
    // 23:59 on the company clock; a week still running is read as of now, never in the future.
    const at = (day: string) => { const t = localTimeToUtc(day, 23, 59, tz); return t.getTime() > now.getTime() ? now : t; };
    const note = [`Entered on statement ${rec.settlementNumber}`, input.note?.trim() || null].filter(Boolean).join(' · ');
    const readings = [] as Array<{ end: 'start' | 'end'; readingAt: string; odometerMiles: number; status: string; conflictReason: string | null; conflictWith?: number | null; message?: string | null }>;
    if (start !== null) {
      const r = await this.pm.recordManualReading(principal, { unitId: truckId, readingAt: at(dayBefore(rec.periodStart)), odometerMiles: start, note });
      readings.push({ end: 'start', readingAt: r.readingAt, odometerMiles: r.odometerMiles, status: r.status, conflictReason: r.conflictReason, conflictWith: r.conflictWith, message: odometerConflictMessage(r.conflictReason, r.odometerMiles, r.conflictWith) });
    }
    if (end !== null) {
      const r = await this.pm.recordManualReading(principal, { unitId: truckId, readingAt: at(rec.periodEnd), odometerMiles: end, note });
      readings.push({ end: 'end', readingAt: r.readingAt, odometerMiles: r.odometerMiles, status: r.status, conflictReason: r.conflictReason, conflictWith: r.conflictWith, message: odometerConflictMessage(r.conflictReason, r.odometerMiles, r.conflictWith) });
    }
    await this.audit.write(principal, {
      action: 'settlement_odometer_entered',
      entityType: 'settlement',
      entityId: rec.id,
      entityLabel: rec.settlementNumber,
      summary: `Odometer for unit ${rec.unitNumber ?? rec.truckId} entered by hand: ${readings.map((r) => `${r.end} ${r.odometerMiles.toLocaleString('en-US')} mi${r.status === 'conflict' ? ` (conflict: ${r.conflictReason})` : ''}`).join(', ')}`,
      changes: readings.map((r) => ({ field: `odometer.${r.end}`, old: null, new: String(r.odometerMiles) })),
    });
    // The recomputed draft is saved too, so the week's list and the batch read the same figures
    // the drawer shows. Version-checked: a stale row is a conflict, never a silent overwrite.
    const statement = await this.statement(principal, rec.id);
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, rec.id);
    await this.store.update('acct_settlements', principal.companyId, rec.id, stored.version, { ...statement, updatedAt: now.toISOString() });
    return { statement, readings };
  }

  // ------------------------------------------------------------ a load's place on statements

  /**
   * Takes a load off a draft statement (owner, 2026-10-21). It stays listed on the statement as
   * "Not on this statement" with the reason, so it can be put back in one click; if it is not, it
   * goes on the driver's next statement by itself - now, when next week's draft already exists,
   * or when that week's statements are made. It is never lost and never paid twice.
   */
  async removeLoad(principal: Principal, id: string, loadId: string, reason: string) {
    this.requireEdit(principal);
    const why = reason.trim();
    if (why.length < 3) throw unprocessable('Say why the load comes off this statement (at least 3 characters).');
    const s = (await this.store.get<StatementRecord>('acct_settlements', principal.companyId, (await this.statement(principal, id)).id)).record;
    if (s.partyType !== 'driver') throw unprocessable('Only a driver statement has loads taken off it here.');
    if (s.status !== 'draft' && s.status !== 'review') return { ok: false as const, blocked: `${s.settlementNumber} is ${s.status}; reopen it before a load comes off.`, statement: s };
    if (!s.loadIds.includes(loadId)) return { ok: false as const, blocked: 'That load is not on this statement.', statement: s };
    const load = await this.loads.get(principal, loadId);
    const by = principal.userName ?? principal.userId;
    const at = this.clock().toISOString();
    const after = await this.rewriteDraft(principal, s.id, (r) => ({ ...SettlementsService.withoutLoad(r, loadId), removedLoads: [...(r.removedLoads ?? []).filter((x) => x.loadId !== loadId), { loadId, loadNumber: load.loadNumber, reason: why, by, at }] }));
    await this.refreshBatch(principal, s.batchId);
    // Next week's draft, when it is already there, takes it now.
    const nextStart = new Date(Date.parse(`${s.periodStart}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const next = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, `stm_${s.partyId}_${nextStart}`);
    let carriedTo: string | null = null;
    if (next && (next.record.status === 'draft' || next.record.status === 'review') && !next.record.loadIds.includes(loadId)) {
      await this.rewriteDraft(principal, next.id, (r) => SettlementsService.withLoad(r, { loadId, loadNumber: load.loadNumber, how: 'carried', by, at }));
      await this.refreshBatch(principal, next.record.batchId);
      carriedTo = next.record.settlementNumber;
    }
    await this.audit.write(principal, { action: 'settlement_load_removed', entityType: 'settlement', entityId: s.id, entityLabel: s.settlementNumber, summary: `${load.loadNumber} taken off ${s.settlementNumber}: ${why}. ${carriedTo ? `Now on ${carriedTo}.` : 'It goes on the next statement made for this driver.'}`, reason: why, changes: [{ field: 'loadIds', old: loadId, new: null }] });
    return { ok: true as const, statement: after, carriedTo };
  }

  /**
   * Puts a load taken off this statement back on it, in one click. If the load has meanwhile gone
   * on another draft (next week's), it leaves that draft; if that statement is approved or paid,
   * the put-back is refused - one load is paid once - until that statement is reopened.
   */
  async putBackLoad(principal: Principal, id: string, loadId: string) {
    this.requireEdit(principal);
    const s = (await this.store.get<StatementRecord>('acct_settlements', principal.companyId, (await this.statement(principal, id)).id)).record;
    if (s.status !== 'draft' && s.status !== 'review') return { ok: false as const, blocked: `${s.settlementNumber} is ${s.status}; reopen it before a load is put back.`, statement: s };
    const entry = (s.removedLoads ?? []).find((r) => r.loadId === loadId);
    if (!entry) return { ok: false as const, blocked: 'That load was not taken off this statement.', statement: s };
    const others = (await this.statementIndex(principal, s.partyId)).filter((x) => x.id !== s.id && x.partyType === 'driver' && x.loadIds.includes(loadId));
    const locked = others.find((x) => x.status === 'approved' || x.status === 'paid');
    if (locked) return { ok: false as const, blocked: `${entry.loadNumber} is already on ${locked.settlementNumber} (${locked.status}). Reopen that statement first, then put it back here.`, statement: s };
    const by = principal.userName ?? principal.userId;
    const at = this.clock().toISOString();
    for (const o of others) {
      await this.rewriteDraft(principal, o.id, (r) => SettlementsService.withoutLoad(r, loadId));
      const batchOf = (await this.store.find<StatementRecord>('acct_settlements', principal.companyId, o.id))?.record.batchId;
      if (batchOf) await this.refreshBatch(principal, batchOf);
    }
    const after = await this.rewriteDraft(principal, s.id, (r) => SettlementsService.withLoad(r, { loadId, loadNumber: entry.loadNumber, how: 'put_back', by, at }));
    await this.refreshBatch(principal, s.batchId);
    await this.audit.write(principal, { action: 'settlement_load_put_back', entityType: 'settlement', entityId: s.id, entityLabel: s.settlementNumber, summary: `${entry.loadNumber} put back on ${s.settlementNumber} (taken off ${entry.at} by ${entry.by}: ${entry.reason})${others.length ? `; taken off ${others.map((o) => o.settlementNumber).join(', ')}` : ''}.`, changes: [{ field: 'loadIds', old: null, new: loadId }] });
    return { ok: true as const, statement: after };
  }

  /**
   * Real vs For driver, and the REF, corrected on the statement (owner, 2026-10-23). Accounting
   * changes what the driver is paid on - the For driver rate, a For driver detention or layover -
   * or the broker's REF number, right on the draft; the load is written (version-checked against
   * the copy the statement showed, audited) and the draft recomputes. Billing reads the real
   * figures and is not touched. Refused once the statement is approved or paid, and while the
   * load sits on any approved or paid statement (a team load's other driver): reopen that first.
   */
  async setLoadPayFacts(principal: Principal, id: string, loadId: string, input: LoadPayFactsInput) {
    this.requireEdit(principal);
    const s = (await this.store.get<StatementRecord>('acct_settlements', principal.companyId, (await this.statement(principal, id)).id)).record;
    if (s.partyType !== 'driver') throw unprocessable('Only a driver statement pays on the For driver rate.');
    if (s.status !== 'draft' && s.status !== 'review') throw unprocessable(`${s.settlementNumber} is ${s.status}; reopen it before its loads' pay changes.`);
    if (!s.loadIds.includes(loadId)) throw unprocessable('That load is not on this statement.');
    const settledElsewhere = (await this.statementIndex(principal)).find((x) => x.id !== s.id && x.partyType === 'driver' && x.loadIds.includes(loadId) && (x.status === 'approved' || x.status === 'paid'));
    if (settledElsewhere) throw unprocessable(`The load is also on ${settledElsewhere.settlementNumber} for ${settledElsewhere.partyName}, which is ${settledElsewhere.status}. Reopen that statement first.`);
    const written = await this.loads.setPayFacts(principal, loadId, input);
    // Every draft carrying the load follows (a team load is on both drivers' drafts).
    const drafts = (await this.statementIndex(principal)).filter((x) => x.partyType === 'driver' && x.loadIds.includes(loadId) && (x.status === 'draft' || x.status === 'review'));
    let after: StatementRecord | null = null;
    for (const d of drafts) {
      const rec = await this.rewriteDraft(principal, d.id, (r) => r);
      await this.refreshBatch(principal, rec.batchId);
      if (d.id === s.id) after = rec;
    }
    await this.audit.write(principal, {
      action: 'settlement_load_pay_facts_set',
      entityType: 'settlement',
      entityId: s.id,
      entityLabel: s.settlementNumber,
      summary: `${written.load.loadNumber} corrected on ${s.settlementNumber}: ${[input.driverRate !== undefined ? `For driver rate ${input.driverRate === null ? 'same as real' : input.driverRate.toFixed(2)}` : null, ...(input.charges ?? []).map((c) => `accessorial ${c.chargeId} For driver ${c.driverAmount === null ? 'same as real' : c.driverAmount.toFixed(2)}`), input.brokerReference !== undefined ? `REF ${input.brokerReference.trim()}` : null].filter(Boolean).join(', ')}`,
      reason: input.reason?.trim() || null,
      changes: [],
    });
    return { statement: after ?? (await this.statement(principal, s.id)), load: written.load };
  }

  /** Where a load stands for pay: when it counts, which period, who set an override, and which statements list it. */
  async loadPay(principal: Principal, loadIdOrNumber: string) {
    const load = await this.loads.get(principal, loadIdOrNumber);
    const settings = await this.settings(principal.companyId);
    const basis = settings.cutoffBasis ?? 'delivered_at';
    const pay = loadPayTime(load, basis);
    const done = DONE_STATUSES.includes(load.status);
    const period = done ? periodForCompletion(pay.at, this.periodCfg(principal, settings)) : null;
    const statements = (await this.statementIndex(principal))
      .filter((s) => s.partyType === 'driver' && (s.loadIds.includes(load.id) || s.removedLoads.some((r) => r.loadId === load.id)))
      .map((s) => ({ id: s.id, settlementNumber: s.settlementNumber, partyName: s.partyName, periodStart: s.periodStart, status: s.status, onIt: s.loadIds.includes(load.id), removed: s.removedLoads.find((r) => r.loadId === load.id) ?? null }));
    return {
      loadId: load.id,
      loadNumber: load.loadNumber,
      status: load.status,
      updatedAt: load.updatedAt,
      deliveredAt: load.deliveredAt ?? null,
      completedAt: loadCompletedTime(load, basis),
      basis,
      payAt: pay.at,
      source: pay.source,
      override: payDateOverrideOf(load),
      period: period ? { ...period, label: payPeriodLabel(period) } : null,
      timezone: settings.payPeriodTimezone,
      statements,
    };
  }

  /**
   * "Counts for pay on" (owner, 2026-10-21): Accounting sets the moment a load counts for driver
   * pay, overriding its delivered time for settlements only. The load then belongs to exactly one
   * week: it leaves any draft of another week and joins the new week's draft when there is one
   * (or when that week's statements are made). Refused while the load is on an approved or paid
   * statement, or while the week it would move into is approved for one of its drivers: reopen
   * that statement first. Version-checked against the load the screen read; audited on the load
   * and on each statement it moves between.
   */
  async setLoadPayDate(principal: Principal, loadIdOrNumber: string, input: SetPayDateInput) {
    this.requireEdit(principal);
    const load = await this.loads.get(principal, loadIdOrNumber);
    if (!DONE_STATUSES.includes(load.status)) throw unprocessable(`${load.loadNumber} is ${load.status}; the pay date is set once the load is completed.`);
    const settings = await this.settings(principal.companyId);
    const basis = settings.cutoffBasis ?? 'delivered_at';
    const cfg = this.periodCfg(principal, settings);
    const before = loadPayTime(load, basis);
    const newAt = input.at === null ? loadCompletedTime(load, basis) : new Date(input.at).toISOString();
    const target = periodForCompletion(newAt, cfg);
    const index = (await this.statementIndex(principal)).filter((s) => s.partyType === 'driver');
    const holding = index.find((s) => s.loadIds.includes(load.id) && (s.status === 'approved' || s.status === 'paid'));
    if (holding) {
      throw unprocessable(holding.status === 'paid'
        ? `${load.loadNumber} is on ${holding.settlementNumber} for ${holding.partyName}, which is paid. Its pay date cannot change; a correction goes on next week's statement.`
        : `${load.loadNumber} is on ${holding.settlementNumber} for ${holding.partyName}, which is approved. Reopen that statement first, then change the pay date.`);
    }
    const driverIds = [load.driverId, (load['coDriverId'] as string | null | undefined) ?? null].filter((d): d is string => Boolean(d));
    for (const driverId of driverIds) {
      const there = index.find((s) => s.id === `stm_${driverId}_${target.start}`);
      if (there && (there.status === 'approved' || there.status === 'paid')) throw unprocessable(`${there.settlementNumber} for ${there.partyName} (${payPeriodLabel(target)}) is ${there.status}. Reopen it first, then move ${load.loadNumber} into that week.`);
    }
    const now = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    const override: PayDateOverride | null = input.at === null ? null : { at: newAt, reason: input.reason.trim(), by: principal.userId, byName: by, changedAt: now, previousAt: before.at };
    await this.loads.setPayDate(principal, load.id, { override, reason: input.reason.trim(), expectedUpdatedAt: input.expectedUpdatedAt, previousAt: before.at });

    // One source of truth: the load leaves every draft of another week, and every record of it
    // being taken off a draft, then joins the target week's drafts that exist.
    const batches = new Set<string>();
    for (const s of index) {
      if (s.status !== 'draft' && s.status !== 'review') continue;
      const listed = s.loadIds.includes(load.id);
      const removed = s.removedLoads.some((r) => r.loadId === load.id);
      if (!(listed && s.periodStart !== target.start) && !removed) continue;
      const after = await this.rewriteDraft(principal, s.id, (r) => SettlementsService.withoutLoad(r, load.id));
      batches.add(after.batchId);
      if (listed) await this.audit.write(principal, { action: 'settlement_load_moved', entityType: 'settlement', entityId: s.id, entityLabel: s.settlementNumber, summary: `${load.loadNumber} left ${s.settlementNumber}: its pay date was set to ${newAt} (${payPeriodLabel(target)}). ${input.reason.trim()}`, reason: input.reason.trim(), changes: [{ field: 'loadIds', old: load.id, new: null }] });
    }
    for (const driverId of driverIds) {
      const there = await this.store.find<StatementRecord>('acct_settlements', principal.companyId, `stm_${driverId}_${target.start}`);
      if (!there || (there.record.status !== 'draft' && there.record.status !== 'review') || there.record.loadIds.includes(load.id)) continue;
      const after = await this.rewriteDraft(principal, there.id, (r) => SettlementsService.withLoad(r, { loadId: load.id, loadNumber: load.loadNumber, how: 'pay_date', by, at: now }));
      batches.add(after.batchId);
      await this.audit.write(principal, { action: 'settlement_load_moved', entityType: 'settlement', entityId: there.id, entityLabel: there.record.settlementNumber, summary: `${load.loadNumber} joined ${there.record.settlementNumber}: its pay date was set to ${newAt}. ${input.reason.trim()}`, reason: input.reason.trim(), changes: [{ field: 'loadIds', old: null, new: load.id }] });
    }
    for (const b of batches) await this.refreshBatch(principal, b);
    return this.loadPay(principal, load.id);
  }

  private async recomputeVendor(_principal: Principal, rec: StatementRecord): Promise<StatementRecord> {
    return rec;
  }

  // ------------------------------------------------------------ approve · pay · reverse

  /**
   * Approval freezes the statement and writes its effects, each once: the recoveries on the
   * charges they recover, the recurring charges, the escrow deposit, the carry-forward. Then the
   * ledger entry. Payee version is frozen so a later bank change cannot redirect this payout.
   */
  async approve(principal: Principal, id: string) {
    this.requireEdit(principal);
    const fresh = await this.statement(principal, id);
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, fresh.id);
    if (fresh.status === 'approved' || fresh.status === 'paid') return { ok: false as const, blocked: `${fresh.settlementNumber} is already ${fresh.status}.`, statement: fresh };
    if (fresh.exceptions.length > 0) return { ok: false as const, blocked: `Resolve the exceptions first: ${fresh.exceptions.join(' ')}`, statement: fresh };
    const settings = await this.settings(principal.companyId);
    if (fresh.partyType === 'driver') {
      const prof = await this.accounts.profileOn(principal, fresh.partyId, fresh.periodEnd);
      if (prof && prof.contractType !== 'CD' && settings.payOnFundingOnly === null) return { ok: false as const, blocked: 'Pay-on-funding-only is not configured for LO/OO (Settings › Accounting).', statement: fresh };
    }
    const now = this.clock().toISOString();
    const onDate = now.slice(0, 10);
    const comp = fresh.computation;
    const gross = comp ? comp.grossCents / 100 : fresh.vendor ? fresh.vendor.totalEarningsCents / 100 : 0;
    const deductions = comp ? comp.deductionsCents / 100 : fresh.vendor ? fresh.vendor.totalDeductionsCents / 100 : 0;
    const escrow = comp ? comp.escrowCents / 100 : 0;
    // A reimbursement was expensed and became owed to the driver when its receipt was approved.
    // It is part of what they are paid here, but posting it again would expense the same cost
    // twice, so it is carved out of the new payable rather than added to driver pay.
    const reimbursed = comp ? comp.reimbursementsCents / 100 : 0;
    const built = postSettlementFinalized({ settlementId: fresh.id, settlementNumber: fresh.settlementNumber, onDate, driverName: fresh.partyName, gross, deductions, escrow, reimbursements: reimbursed, net: fresh.netCents / 100 });
    // An approval after a reopen is a new entry; the earlier one stands, reversed.
    const version = fresh.versions.length + 1;
    const posted = await this.ledger.commit(principal, built.ok ? { ok: true, entry: { ...built.entry, sourceKey: finalizedSourceKey(fresh.id, version) } } : built);
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, statement: fresh };

    if (comp && fresh.partyType === 'driver') {
      // Recoveries: mark each charge recovered by the cents this statement took, once.
      // The row is locked while it changes, and a statement already in the charge's log is not
      // taken again: a retried or concurrent approval deducts once.
      for (const r of comp.recoveries) {
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, r.txId, (tx) => {
          if ((tx.recoveryLog ?? []).some((l) => l.settlementId === fresh.id && !l.reversedAt)) return tx;
          const cents = Math.min(r.cents, tx.amountCents - tx.recoveredCents);
          if (cents <= 0) return tx;
          return {
            ...tx,
            recoveredCents: tx.recoveredCents + cents,
            state: tx.recoveredCents + cents >= tx.amountCents ? 'applied' : tx.state,
            installments: tx.installments ? { ...tx.installments, remaining: Math.max(0, tx.installments.remaining - 1) } : tx.installments,
            recoveryLog: [...(tx.recoveryLog ?? []), { settlementId: fresh.id, settlementNumber: fresh.settlementNumber, cents, at: now }],
          };
        });
      }
      // This week's fuel/tolls/advances taken as deductions: applied on this statement. The
      // cents taken go in the log too, so a reopen gives back exactly what was taken.
      for (const d of comp.deductions) {
        if (!d.txId || d.kind === 'debt_recovery') continue;
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, d.txId, (tx) => {
          if (tx.settlementId === fresh.id) return tx;
          return { ...tx, recoveredCents: tx.amountCents, state: 'applied', settlementId: fresh.id, recoveryLog: [...(tx.recoveryLog ?? []), { settlementId: fresh.id, settlementNumber: fresh.settlementNumber, cents: tx.amountCents - tx.recoveredCents, at: now }] };
        });
      }
      // Accessorials added after their load was settled: this statement pays them, once.
      for (const e of comp.earnings) {
        if (!e.txId) continue;
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, e.txId, (tx) => (tx.settlementId || tx.state === 'void' ? tx : { ...tx, state: 'applied', settlementId: fresh.id }));
      }
      for (const rc of comp.recurringCharges) {
        const written = await this.writeApprovalTx(principal, { id: newId('dtx'), driverId: fresh.partyId, kind: 'recurring', onDate: fresh.periodEnd, amountCents: rc.cents, recoveredCents: rc.cents, state: 'applied', source: 'settlement', sourceKey: `recurring:${rc.deductionId}:${fresh.periodStart}`, truckId: fresh.truckId, loadId: null, settlementId: fresh.id, description: rc.description, companyCost: false });
        if (written) await this.store.modify<{ chargedCents: number }>('acct_recurring_deductions', principal.companyId, rc.deductionId, (r) => ({ ...r, chargedCents: (r.chargedCents ?? 0) + rc.cents }));
      }
      // Lease owner charges: written once each, keyed by driver, charge and week.
      for (const lc of comp.leaseCharges ?? []) {
        await this.writeApprovalTx(principal, { id: newId('dtx'), driverId: fresh.partyId, kind: 'recurring', onDate: fresh.periodEnd, amountCents: lc.cents, recoveredCents: lc.cents, state: 'applied', source: 'lease', sourceKey: `lease:${lc.code}:${fresh.partyId}:${fresh.periodStart}`, truckId: fresh.truckId, loadId: null, settlementId: fresh.id, description: lc.description, companyCost: false });
      }
      if (comp.escrowCents > 0) {
        await this.writeApprovalTx(principal, { id: newId('dtx'), driverId: fresh.partyId, kind: 'escrow_deposit', onDate: fresh.periodEnd, amountCents: comp.escrowCents, recoveredCents: 0, state: 'applied', source: 'settlement', sourceKey: `escrow:${fresh.id}`, truckId: fresh.truckId, loadId: null, settlementId: fresh.id, description: `Escrow · ${fresh.settlementNumber}`, companyCost: false });
      }
      if (comp.carryCents > 0) {
        await this.writeApprovalTx(principal, { id: newId('dtx'), driverId: fresh.partyId, kind: 'carry_forward', onDate: fresh.periodEnd, amountCents: comp.carryCents, recoveredCents: 0, state: 'approved', source: 'settlement', sourceKey: `carry:${fresh.id}`, truckId: fresh.truckId, loadId: null, settlementId: fresh.id, description: `Carried from ${fresh.settlementNumber}`, companyCost: false });
      }
    }
    const payee = (await this.store.list<{ version: number }>('acct_payee_profiles', principal.companyId, sql`party_type = ${fresh.partyType} and party_id = ${fresh.partyId}`))[0] ?? null;
    const prof = fresh.partyType === 'driver' ? await this.accounts.profileOn(principal, fresh.partyId, fresh.periodEnd) : null;
    const after: StatementRecord = {
      ...fresh,
      status: 'approved',
      approvedAt: now,
      approvedBy: principal.userName ?? principal.userId,
      snapshot: { profileEffectiveFrom: prof?.effectiveFrom ?? null, payeeVersion: payee?.version ?? null, documents: [] },
      versions: [...fresh.versions, { version: fresh.versions.length + 1, at: now, by: principal.userName ?? principal.userId, netCents: fresh.netCents, payableCents: fresh.payableCents }],
      updatedAt: now,
    };
    await this.store.update('acct_settlements', principal.companyId, fresh.id, stored.version, after);
    await this.refreshBatch(principal, fresh.batchId);
    await this.audit.write(principal, { action: 'settlement_approved', entityType: 'settlement', entityId: fresh.id, entityLabel: fresh.settlementNumber, summary: `${fresh.settlementNumber} approved: net ${fresh.netCents / 100}, payable ${fresh.payableCents / 100}, carry ${fresh.carryCents / 100}; ${posted.entry.id}`, changes: [{ field: 'status', old: fresh.status, new: 'approved' }] });
    for (const loadId of after.loadIds) for (const listener of this.afterChange) { try { await listener(principal, loadId); } catch { /* the listener records its own failure */ } }
    return { ok: true as const, statement: after };
  }

  async markPaid(principal: Principal, id: string, input: { paidOn: string; reference: string; method: string; amountCents?: number }) {
    this.requireEdit(principal);
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, id);
    const s = stored.record;
    if (s.status !== 'approved') return { ok: false as const, blocked: `${s.settlementNumber} is ${s.status}; only an approved statement is paid.`, statement: s };
    const amount = input.amountCents ?? s.payableCents;
    const paymentId = newId('pay');
    const posted = await this.ledger.commit(principal, postSettlementPaid({ settlementId: s.id, settlementNumber: s.settlementNumber, onDate: input.paidOn, driverName: s.partyName, net: amount / 100 }));
    if (!posted.ok) return { ok: false as const, blocked: posted.blocked, statement: s };
    const at = this.clock().toISOString();
    await this.store.insert('acct_payments', principal.companyId, { id: paymentId, sourceKey: `settlement_payment:${s.id}:${input.reference.trim()}`, direction: 'out', partyType: s.partyType, partyId: s.partyId, partyName: s.partyName, amount: amount / 100, method: input.method, receivedOn: input.paidOn, reference: input.reference.trim(), unappliedAmount: 0, applications: [], notes: `Statement ${s.settlementNumber}`, createdAt: at, createdBy: principal.userName ?? principal.userId });
    const after: StatementRecord = { ...s, status: 'paid', paidAt: at, paymentId, paidCents: amount, updatedAt: at };
    await this.store.update('acct_settlements', principal.companyId, id, stored.version, after);
    await this.refreshBatch(principal, s.batchId);
    // The money has left; only now is a reimbursement on this statement paid.
    await this.reimbursements.markPaid(principal, s.id, input.paidOn);
    await this.audit.write(principal, { action: 'settlement_paid', entityType: 'settlement', entityId: id, entityLabel: s.settlementNumber, summary: `${s.settlementNumber} paid $${(amount / 100).toFixed(2)} (${input.reference})`, changes: [{ field: 'status', old: 'approved', new: 'paid' }] });
    for (const loadId of after.loadIds) for (const listener of this.afterChange) { try { await listener(principal, loadId); } catch { /* the listener records its own failure */ } }
    return { ok: true as const, statement: after };
  }

  /**
   * A transaction approval writes from nothing. The source key makes it land once; a row the
   * same key already holds is the one a reopen voided, and it is brought back rather than
   * written beside - so the account shows one row per charge per week. Returns whether the
   * charge now stands (first write or revival); false when it already stood.
   */
  private async writeApprovalTx(principal: Principal, tx: DriverTx): Promise<boolean> {
    const { stored, created } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    if (created) return true;
    if (stored.record.state !== 'void') return false;
    await this.store.update<DriverTx>('acct_driver_transactions', principal.companyId, stored.id, stored.version, { ...stored.record, ...tx, id: stored.id, reason: null });
    return true;
  }

  /**
   * Reopening an approved statement (owner, 2026-10-21): until the payment is posted, approval
   * is not final. Each effect of the approval is undone, in the ledger's own way - the entry is
   * reversed, never deleted; the transactions approval wrote are voided with the reason, never
   * deleted; the recoveries are given back from their log - and the statement is a draft again,
   * recomputed like any draft. A statement that is paid, in a closed settlement batch or on a
   * payment batch is refused whole: nothing is half-undone.
   */
  async reopen(principal: Principal, id: string, reason: string) {
    this.requireEdit(principal);
    const resolved = await this.statement(principal, id);
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, resolved.id);
    const s = stored.record;
    const why = reason.trim();
    if (s.status === 'paid') return { ok: false as const, blocked: `${s.settlementNumber} is already paid; a correction goes on next week's statement.`, statement: s };
    if (s.status !== 'approved') return { ok: false as const, blocked: `${s.settlementNumber} is ${s.status === 'review' ? 'a draft under review' : `a ${s.status}`}; only an approved statement is reopened.`, statement: s };
    const batch = await this.store.find<BatchRecord>('acct_settlement_batches', principal.companyId, s.batchId);
    if (batch?.record.status === 'closed') return { ok: false as const, blocked: `${s.settlementNumber} is in ${s.kind.toUpperCase()} ${s.periodStart}, which is closed; a correction goes on next week's statement.`, statement: s };
    const holding = (await this.store.list<PaymentBatchRecord>('acct_payment_batches', principal.companyId, sql`status <> 'rejected' and record->'lines' @> ${JSON.stringify([{ statementId: s.id }])}::jsonb`))[0] ?? null;
    if (holding) return { ok: false as const, blocked: `${s.settlementNumber} is on payment batch ${holding.id} (${holding.record.status}); take it off the batch first, or if the money has gone, record the payment and put the correction on next week's statement.`, statement: s };

    const now = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    const note = `${s.settlementNumber} reopened: ${why}`;

    // 1. The ledger: the finalised entry is mirrored and linked, once. A reversal already on
    //    file (an earlier reopen that stopped short) is not posted again.
    const entry = (await this.store.list<JournalEntry>('acct_journal_entries', principal.companyId, sql`source_key = ${finalizedSourceKey(s.id, s.versions.length)}`))[0] ?? null;
    let reversalId: string | null = null;
    if (entry) {
      const reversed = await this.ledger.reverse(principal, entry.id, note);
      if (reversed.ok) reversalId = reversed.entry.id;
      else if (/already reversed by (\S+)\./.test(reversed.blocked)) reversalId = /already reversed by (\S+)\./.exec(reversed.blocked)![1] ?? null;
      else return { ok: false as const, blocked: reversed.blocked, statement: s };
    }

    const comp = s.computation;
    const undone = { recoveries: 0, deductions: 0, written: 0, chargedCents: 0 };
    if (comp && s.partyType === 'driver') {
      // 2. Debt recoveries: each log entry this statement wrote is given back - cents, state,
      //    the installment it counted - and marked reversed, so it is neither given back twice
      //    nor counted as taken.
      for (const r of comp.recoveries) {
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, r.txId, (tx) => {
          const mine = (tx.recoveryLog ?? []).filter((l) => l.settlementId === s.id && !l.reversedAt);
          if (mine.length === 0) return tx;
          const cents = mine.reduce((t, l) => t + l.cents, 0);
          const recoveredCents = Math.max(0, tx.recoveredCents - cents);
          undone.recoveries += 1;
          return {
            ...tx,
            recoveredCents,
            state: tx.state === 'applied' && recoveredCents < tx.amountCents ? 'approved' : tx.state,
            installments: tx.installments ? { ...tx.installments, remaining: Math.min(tx.installments.total, tx.installments.remaining + mine.length) } : tx.installments,
            recoveryLog: (tx.recoveryLog ?? []).map((l) => (l.settlementId === s.id && !l.reversedAt ? { ...l, reversedAt: now, reversedBy: by, reason: why } : l)),
          };
        });
      }
      // 3. This week's fuel, tolls, advances and refunds: back to approved and unclaimed, with
      //    the cents the approval took given back (all of it, for a row approved before the
      //    log was kept).
      for (const d of comp.deductions) {
        if (!d.txId || d.kind === 'debt_recovery') continue;
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, d.txId, (tx) => {
          if (tx.settlementId !== s.id) return tx;
          const mine = (tx.recoveryLog ?? []).filter((l) => l.settlementId === s.id && !l.reversedAt);
          const taken = mine.length > 0 ? mine.reduce((t, l) => t + l.cents, 0) : tx.recoveredCents;
          undone.deductions += 1;
          return {
            ...tx,
            recoveredCents: Math.max(0, tx.recoveredCents - taken),
            state: 'approved',
            settlementId: null,
            recoveryLog: (tx.recoveryLog ?? []).map((l) => (l.settlementId === s.id && !l.reversedAt ? { ...l, reversedAt: now, reversedBy: by, reason: why } : l)),
          };
        });
      }
      // 3b. Late accessorials this statement paid: unclaimed again, so the recomputed draft (or
      //     the next statement) pays them - still once.
      for (const e of comp.earnings) {
        if (!e.txId) continue;
        await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, e.txId, (tx) => (tx.settlementId !== s.id ? tx : { ...tx, state: 'approved', settlementId: null }));
      }
      // 4. What approval wrote from nothing - recurring and lease charges, the escrow deposit,
      //    the carry-forward - is voided with the reason, the module's way of taking a charge
      //    off an account; the recurring plan's running total gives the cents back.
      const written = await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`settlement_id = ${s.id} and state <> 'void'`);
      for (const w of written) {
        if (!APPROVAL_WRITTEN_SOURCES.has(w.record.source) || !['recurring', 'escrow_deposit', 'carry_forward'].includes(w.record.kind)) continue;
        await this.store.update<DriverTx>('acct_driver_transactions', principal.companyId, w.id, w.version, { ...w.record, state: 'void', reason: note });
        undone.written += 1;
        const m = /^recurring:(.+):\d{4}-\d{2}-\d{2}$/.exec(w.record.sourceKey);
        if (m && w.record.source === 'settlement') {
          const plan = await this.store.find<{ chargedCents: number }>('acct_recurring_deductions', principal.companyId, m[1]!);
          if (plan) {
            await this.store.update('acct_recurring_deductions', principal.companyId, plan.id, plan.version, { ...plan.record, chargedCents: Math.max(0, (plan.record.chargedCents ?? 0) - w.record.amountCents) });
            undone.chargedCents += w.record.amountCents;
          }
        }
      }
    }

    // 5. The statement itself: a draft again, its approval cleared, its versions kept as
    //    history; then recomputed and saved the way every draft is.
    const reopened: StatementRecord = { ...s, status: 'draft', approvedAt: null, approvedBy: null, snapshot: null, updatedAt: now };
    await this.store.update('acct_settlements', principal.companyId, s.id, stored.version, reopened);
    const recomputed = await this.statement(principal, s.id);
    const again = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, s.id);
    await this.store.update('acct_settlements', principal.companyId, s.id, again.version, { ...recomputed, updatedAt: now });
    await this.refreshBatch(principal, s.batchId);
    await this.audit.write(principal, {
      action: 'settlement_reopened',
      entityType: 'settlement',
      entityId: s.id,
      entityLabel: s.settlementNumber,
      summary: `${s.settlementNumber} reopened (approved ${s.approvedAt ?? '?'} by ${s.approvedBy ?? '?'}): ${why}. Ledger ${entry ? `${entry.id} reversed by ${reversalId ?? '?'}` : 'had no entry'}; ${undone.recoveries} recovery(ies) given back, ${undone.deductions} deduction(s) unapplied, ${undone.written} charge(s) voided, ${undone.chargedCents / 100} off recurring totals.`,
      reason: why,
      changes: [{ field: 'status', old: 'approved', new: recomputed.status }],
    });
    for (const loadId of s.loadIds) for (const listener of this.afterChange) { try { await listener(principal, loadId); } catch { /* the listener records its own failure */ } }
    return { ok: true as const, statement: recomputed };
  }

  async setStatus(principal: Principal, id: string, status: 'draft' | 'review', note?: string) {
    this.requireEdit(principal);
    const stored = await this.store.get<StatementRecord>('acct_settlements', principal.companyId, id);
    if (stored.record.status === 'approved' || stored.record.status === 'paid') throw unprocessable('An approved statement is not edited; corrections go on the next week.');
    const after = { ...stored.record, status, notes: note ?? stored.record.notes, updatedAt: this.clock().toISOString() };
    await this.store.update('acct_settlements', principal.companyId, id, stored.version, after);
    return after;
  }

  async closeBatch(principal: Principal, batchId: string) {
    this.requireEdit(principal);
    const stored = await this.store.get<BatchRecord>('acct_settlement_batches', principal.companyId, batchId);
    const rows = await this.statements(principal, { batchId });
    const open = rows.filter((r) => r.status === 'draft' || r.status === 'review');
    if (open.length > 0) throw unprocessable(`${open.length} statement(s) are not approved yet.`);
    const after: BatchRecord = { ...stored.record, status: 'closed', closedAt: this.clock().toISOString() };
    await this.store.update('acct_settlement_batches', principal.companyId, batchId, stored.version, after);
    return after;
  }

  private async refreshBatch(principal: Principal, batchId: string) {
    const stored = await this.store.find<BatchRecord>('acct_settlement_batches', principal.companyId, batchId);
    if (!stored) return;
    const rows = await this.statements(principal, { batchId });
    const status: BatchRecord['status'] = rows.every((r) => r.status === 'approved' || r.status === 'paid') && rows.length > 0 ? 'approved' : rows.some((r) => r.status === 'review') ? 'review' : stored.record.status === 'closed' ? 'closed' : 'open';
    await this.store.update('acct_settlement_batches', principal.companyId, batchId, stored.version, { ...stored.record, totals: batchTotals(rows), status });
  }

  // ------------------------------------------------------------ vendor arrangements

  async arrangements(principal: Principal) {
    return (await this.store.list('acct_vendor_arrangements', principal.companyId)).map((r) => ({ ...r.record, version: r.version }));
  }

  async saveArrangement(principal: Principal, input: { id?: string; vendorId: string; truckId: string; effectiveFrom: string; effectiveTo: string | null; percentBps: number | null; note?: string }) {
    this.requireEdit(principal);
    const [truck] = await this.store.db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.truckId))).limit(1);
    if (!truck) throw unprocessable('That truck is not in the fleet.');
    const rec = { id: input.id ?? newId('var'), vendorId: input.vendorId, truckId: input.truckId, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo, percentBps: input.percentBps, note: input.note ?? null, byName: principal.userName ?? principal.userId, at: this.clock().toISOString() };
    if (input.id) {
      const stored = await this.store.get('acct_vendor_arrangements', principal.companyId, input.id);
      await this.store.update('acct_vendor_arrangements', principal.companyId, input.id, stored.version, rec);
    } else await this.store.insert('acct_vendor_arrangements', principal.companyId, rec);
    await this.audit.write(principal, { action: 'vendor_arrangement', entityType: 'vendor', entityId: input.vendorId, entityLabel: input.vendorId, summary: `Truck ${input.truckId} → vendor from ${input.effectiveFrom}${input.percentBps !== null ? ` at ${input.percentBps / 100}%` : ' (percentage not set)'}`, changes: [] });
    return rec;
  }
}
