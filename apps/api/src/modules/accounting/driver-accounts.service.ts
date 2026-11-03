import { Injectable } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import {
  LEASE_PLAN_KINDS,
  LEASE_SECURITY_DEPOSIT,
  defaultLeasePlan,
  CONTRACT_TYPES,
  UpdateDriverProfileSchema,
  debtSummary,
  defaultSwitches,
  escrowSummary,
  profileOn,
  readRosterPercent,
  type CompletionRecord,
  type DriverProfileRecord,
  type DriverTx,
  type RecoveryLogEntry,
  type ManualChargeInput,
  type ProfileVersion,
  type RecurringDeduction,
  type RecurringDeductionInput,
  type UpdateDriverProfileInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { drivers, workOrders } from '../../database/schema';
import { AuditService } from '../people/audit.service';
import { forbidden, newId, notFound, unprocessable } from '../dispatch-board/ops.helpers';
import { StateService } from '../state/state.service';
import { AccountingStore } from './store.service';

/**
 * A load marked as test data (`loads.is_demo`) earns nobody anything: its completion stays on
 * file but is left out of what a driver is owed, as settlements already leave the load out.
 */
const NOT_DEMO_LOAD = sql`not exists (select 1 from loads l where l.company_id = acct_completions.company_id and l.id = acct_completions.record->>'loadId' and l.is_demo)`;

/**
 * The driver's financial account (§7): profile, transactions, debt, escrow, company costs.
 *
 * Fleet may read summaries; only Accounting writes. The profile is versioned by effective date,
 * so a change today never rewrites a statement already computed on yesterday's terms. Balances
 * are computed from the transactions every time - nothing stores a running total that could
 * drift from its history.
 */
@Injectable()
export class DriverAccountsService {
  constructor(
    private readonly store: AccountingStore,
    private readonly audit: AuditService,
    private readonly state: StateService,
  ) {}

  clock: () => Date = () => new Date();

  /** Called after a profile is saved (a plan, a switch, a confirmed rate). The completion pipeline listens. */
  readonly afterProfileChange: Array<(principal: Principal, driverId: string) => Promise<void>> = [];

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can change a driver’s financial account.');
  }

  async driverName(principal: Principal, driverId: string): Promise<string | null> {
    const [row] = await this.store.db.select({ first: drivers.firstName, last: drivers.lastName }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, driverId))).limit(1);
    return row ? `${row.first} ${row.last}`.trim() : null;
  }

  // ------------------------------------------------------------ profile

  /** The profile record; a driver without one gets the defaults of their roster type, unsaved. */
  /** The driver must be this company's; a foreign id is not found, never a defaulted profile. */
  private async requireDriver(principal: Principal, driverId: string): Promise<void> {
    const [row] = await this.store.db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, driverId))).limit(1);
    if (!row) throw notFound(`Driver ${driverId} is not on this company's roster.`);
  }

  async profile(principal: Principal, driverId: string): Promise<{ driverId: string; version: number; record: DriverProfileRecord; current: ProfileVersion | null; defaulted: boolean }> {
    await this.requireDriver(principal, driverId);
    const stored = await this.store.driverProfile(principal.companyId, driverId);
    const today = this.clock().toISOString().slice(0, 10);
    if (stored) {
      const record = stored.record as unknown as DriverProfileRecord;
      return { driverId, version: stored.version, record, current: profileOn(record, today), defaulted: false };
    }
    const [row] = await this.store.db.select({ type: drivers.driverType, kind: drivers.payPlanKind, rate: drivers.payPlanRate }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, driverId))).limit(1);
    const leaseKind = LEASE_PLAN_KINDS.find((k) => k === row?.kind) ?? null;
    const contract = leaseKind === 'owner_truck' ? 'OO' : leaseKind ? 'LO' : row?.type === 'owner_operator' ? 'OO' : row?.type === 'lease_operator' ? 'LO' : 'CD';
    const rate = Number(row?.rate ?? 0);
    if (leaseKind) {
      // Lease owner / leasing to owner / owner truck (owner, 2026-10-12): paid the whole gross, less
      // the lease sheet's charges and the $3,000 deposit at $350 a week - ready without set-up.
      const lease: ProfileVersion = {
        effectiveFrom: today,
        contractType: contract,
        switches: { ...defaultSwitches(contract), recurringDeductions: true, escrowEnabled: true },
        loadedPlan: { kind: 'percent_of_gross', rate: 100 },
        emptyPlan: { kind: 'none', rate: 0 },
        escrow: { ...LEASE_SECURITY_DEPOSIT, openingBalanceCents: 0, openingReconciled: true },
        lease: defaultLeasePlan(leaseKind),
        byId: '',
        byName: 'lease sheet default (unsaved)',
        at: today,
      };
      return { driverId, version: 0, record: { versions: [], openingDebtCents: 0, openingDebtReconciled: true, notes: [] }, current: lease, defaulted: true };
    }
    const draft: ProfileVersion = {
      effectiveFrom: today,
      contractType: contract,
      switches: defaultSwitches(contract),
      // The roster's basis is kept as it is (linehaul), never rewritten to gross by default.
      loadedPlan: row?.kind === 'percent_of_linehaul' ? { kind: 'percent_of_linehaul', rate } : row?.kind === 'per_mile' && rate > 0 ? { kind: 'per_mile', rate } : { kind: 'none', rate: 0 },
      emptyPlan: { kind: 'none', rate: 0 },
      escrow: { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: null, openingReconciled: false },
      byId: '',
      byName: 'roster default (unsaved)',
      at: today,
    };
    return { driverId, version: 0, record: { versions: [], openingDebtCents: null, openingDebtReconciled: false, notes: [] }, current: draft, defaulted: true };
  }

  async profileOn(principal: Principal, driverId: string, date: string): Promise<ProfileVersion | null> {
    const p = await this.profile(principal, driverId);
    return p.defaulted ? p.current : profileOn(p.record, date);
  }

  async updateProfile(principal: Principal, driverId: string, raw: UpdateDriverProfileInput) {
    this.requireEdit(principal);
    const input = UpdateDriverProfileSchema.parse(raw);
    if (!CONTRACT_TYPES.includes(input.contractType)) throw unprocessable('Unknown contract type.');
    const existing = await this.profile(principal, driverId);
    if (existing.version !== input.expectedVersion) throw unprocessable(`The profile changed since you read it (version ${existing.version}).`);
    const now = this.clock().toISOString();
    const version: ProfileVersion = { effectiveFrom: input.effectiveFrom, contractType: input.contractType, switches: input.switches, loadedPlan: input.loadedPlan, emptyPlan: input.emptyPlan, escrow: input.escrow, lease: input.lease ?? null, byId: principal.userId, byName: principal.userName ?? principal.userId, at: now, reason: input.reason };
    const record: DriverProfileRecord = {
      versions: [...existing.record.versions.filter((v) => v.effectiveFrom !== input.effectiveFrom), version].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom)),
      openingDebtCents: input.openingDebtCents === undefined ? existing.record.openingDebtCents : input.openingDebtCents,
      openingDebtReconciled: input.openingDebtReconciled ?? existing.record.openingDebtReconciled,
      notes: existing.record.notes,
      rateConfirmedAt: input.confirmRate ? now : (existing.record.rateConfirmedAt ?? null),
      rateConfirmedBy: input.confirmRate ? (principal.userName ?? principal.userId) : (existing.record.rateConfirmedBy ?? null),
    };
    const saved = await this.store.saveDriverProfile(principal.companyId, driverId, existing.version, input.contractType, record as unknown as Record<string, unknown>);
    // A reconciled opening debt becomes the oldest open charge, recovered like any other - once.
    if (record.openingDebtReconciled && (record.openingDebtCents ?? 0) > 0) {
      const existingTx = (await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`driver_id = ${driverId} and source = 'opening'`))[0];
      const opening: DriverTx = { id: existingTx?.record.id ?? newId('dtx'), driverId, kind: 'carry_forward', onDate: input.effectiveFrom, amountCents: record.openingDebtCents ?? 0, recoveredCents: existingTx?.record.recoveredCents ?? 0, state: 'approved', source: 'opening', sourceKey: `opening:${driverId}`, truckId: null, loadId: null, settlementId: null, description: 'Opening debt (reconciled)', companyCost: false, reason: input.reason ?? 'Opening balance reconciled' };
      if (existingTx) {
        if (existingTx.record.recoveredCents === 0) await this.store.update('acct_driver_transactions', principal.companyId, existingTx.id, existingTx.version, opening);
      } else await this.store.insert('acct_driver_transactions', principal.companyId, opening);
    }
    const before = existing.current;
    await this.audit.write(principal, {
      action: 'driver_profile_updated',
      entityType: 'driver',
      entityId: driverId,
      entityLabel: (await this.driverName(principal, driverId)) ?? driverId,
      summary: `Financial profile effective ${input.effectiveFrom}: ${input.contractType}, fuel ${input.switches.deductFuel ? 'deducted' : 'company'}, tolls ${input.switches.deductTolls ? 'deducted' : 'company'}, escrow ${input.switches.escrowEnabled ? 'on' : 'off'}`,
      reason: input.reason ?? null,
      changes: [
        { field: 'contractType', old: before?.contractType ?? null, new: input.contractType },
        { field: 'switches', old: before ? JSON.stringify(before.switches) : null, new: JSON.stringify(input.switches) },
        { field: 'loadedPlan', old: before ? JSON.stringify(before.loadedPlan) : null, new: JSON.stringify(input.loadedPlan) },
        { field: 'emptyPlan', old: before ? JSON.stringify(before.emptyPlan) : null, new: JSON.stringify(input.emptyPlan) },
      ],
    });
    for (const listener of this.afterProfileChange) {
      try {
        await listener(principal, driverId);
      } catch {
        // The listener records its own failure; the profile stands.
      }
    }
    return { version: saved.version, record, current: profileOn(record, this.clock().toISOString().slice(0, 10)) };
  }

  async addNote(principal: Principal, driverId: string, body: string) {
    const existing = await this.profile(principal, driverId);
    const record: DriverProfileRecord = { ...existing.record, notes: [...existing.record.notes, { id: newId('note'), at: this.clock().toISOString(), byName: principal.userName ?? principal.userId, body: body.trim() }] };
    const contract = existing.current?.contractType ?? 'CD';
    await this.store.saveDriverProfile(principal.companyId, driverId, existing.version, contract, record as unknown as Record<string, unknown>);
    return record.notes.at(-1);
  }

  // ------------------------------------------------------------ transactions

  async transactions(principal: Principal, driverId: string): Promise<DriverTx[]> {
    return (await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`driver_id = ${driverId}`, 'on_date desc, created_at desc')).map((r) => r.record);
  }

  async allTransactions(principal: Principal): Promise<DriverTx[]> {
    return (await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId)).map((r) => r.record);
  }

  /** A charge born from an import (fuel, tolls, EFS): linked by source key, so a re-import lands once. */
  async chargeFromImport(principal: Principal, input: { driverId: string; kind: 'fuel' | 'tolls' | 'advance'; onDate: string; amountCents: number; description: string; sourceKey: string; truckId: string | null; state: 'pending' | 'approved' | 'applied'; companyCost: boolean; expenseId: string }): Promise<DriverTx> {
    const tx: DriverTx & { expenseId: string } = { id: newId('dtx'), driverId: input.driverId, kind: input.kind, onDate: input.onDate, amountCents: input.amountCents, recoveredCents: 0, state: input.state, source: 'import', sourceKey: input.sourceKey, truckId: input.truckId, loadId: null, settlementId: null, description: input.description, companyCost: input.companyCost, expenseId: input.expenseId };
    const { stored } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    return stored.record;
  }

  /** A manual charge, reimbursement, adjustment, advance or escrow movement, with reason and evidence. */
  async manualCharge(principal: Principal, driverId: string, input: ManualChargeInput): Promise<DriverTx> {
    this.requireEdit(principal);
    // A driver id from another company is not found. Without this the charge would be written
    // against this company with an id that names nobody on its roster.
    await this.requireDriver(principal, driverId);
    const now = this.clock().toISOString();
    const approved = !input.approvalRequired;
    const tx: DriverTx = {
      id: newId('dtx'),
      driverId,
      kind: input.kind,
      onDate: input.onDate,
      amountCents: input.amountCents,
      recoveredCents: 0,
      state: approved ? 'approved' : 'pending',
      source: 'manual',
      sourceKey: `manual:${driverId}:${input.kind}:${input.onDate}:${input.amountCents}:${input.description.trim().toLowerCase()}`,
      truckId: input.truckId ?? null,
      loadId: input.loadId ?? null,
      settlementId: null,
      description: input.description.trim(),
      companyCost: false,
      reason: input.reason,
      evidenceFileId: input.evidenceFileId ?? null,
      approvedBy: approved ? (principal.userName ?? principal.userId) : null,
      approvedAt: approved ? now : null,
      installments: input.installments && input.installments > 1 ? { total: input.installments, remaining: input.installments, perPeriodCents: Math.ceil(input.amountCents / input.installments) } : null,
    };
    const { stored, created } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    if (!created) throw unprocessable(`That charge is already on file (${stored.id}).`);
    await this.audit.write(principal, { action: 'driver_charge', entityType: 'driver', entityId: driverId, entityLabel: (await this.driverName(principal, driverId)) ?? driverId, summary: `${input.kind.replace(/_/g, ' ')} $${(input.amountCents / 100).toFixed(2)} on ${input.onDate}: ${input.description}`, reason: input.reason, changes: [] });
    return tx;
  }

  async setTransactionState(principal: Principal, id: string, state: 'approved' | 'disputed' | 'paused' | 'void', reason: string): Promise<DriverTx> {
    this.requireEdit(principal);
    const stored = await this.store.get<DriverTx>('acct_driver_transactions', principal.companyId, id);
    const tx = stored.record;
    if (tx.state === 'applied' && state === 'void') throw unprocessable('An applied charge cannot be voided; post an adjustment instead.');
    const after: DriverTx = { ...tx, state, reason: reason || tx.reason, approvedBy: state === 'approved' ? (principal.userName ?? principal.userId) : tx.approvedBy, approvedAt: state === 'approved' ? this.clock().toISOString() : tx.approvedAt };
    await this.store.update('acct_driver_transactions', principal.companyId, id, stored.version, after);
    await this.audit.write(principal, { action: 'driver_charge_state', entityType: 'driver', entityId: tx.driverId, entityLabel: tx.driverId, summary: `${tx.description}: ${tx.state} → ${state}`, reason, changes: [{ field: 'state', old: tx.state, new: state }] });
    return after;
  }

  // ------------------------------------------------------------ fleet expense charges

  /**
   * The driver charge a Fleet Expense raises (company paid, driver bears it). Keyed by the expense,
   * so a retried or concurrent post lands once. It starts Pending review: nothing is deducted until
   * Accounting adds it to a settlement.
   */
  async chargeFromFleetExpense(principal: Principal, input: { expenseId: string; reference: string; driverId: string; amountCents: number; onDate: string; description: string; reason: string; truckId: string; evidenceFileId: string | null }): Promise<DriverTx> {
    this.requireEdit(principal);
    await this.requireDriver(principal, input.driverId);
    const tx: DriverTx = {
      id: newId('dtx'),
      driverId: input.driverId,
      kind: 'manual_charge',
      onDate: input.onDate,
      amountCents: input.amountCents,
      recoveredCents: 0,
      state: 'pending',
      source: 'fleet_expense',
      sourceKey: `fleet_expense:${input.expenseId}`,
      truckId: input.truckId,
      loadId: null,
      settlementId: null,
      description: input.description,
      companyCost: false,
      reason: input.reason,
      evidenceFileId: input.evidenceFileId,
      approvedBy: null,
      approvedAt: null,
      installments: null,
      recoveryLog: [],
      fleetExpenseId: input.expenseId,
    };
    const { stored, created } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    if (created) await this.audit.write(principal, { action: 'driver_charge', entityType: 'driver', entityId: input.driverId, entityLabel: (await this.driverName(principal, input.driverId)) ?? input.driverId, summary: `Charge $${(input.amountCents / 100).toFixed(2)} from fleet expense ${input.reference}: ${input.description}`, reason: input.reason, changes: [] });
    return stored.record;
  }

  /**
   * A charge or a bonus Safety raises on a violation (owner, 2026-10-13). It lands pending: nothing
   * moves until Accounting approves it. A charge is then recovered on settlements like any other;
   * a bonus is a credit Accounting adds to the statement. Safety's own permission is checked by
   * the caller; this never approves anything.
   */
  async fromSafetyViolation(principal: Principal, input: { violationId: string; reference: string; kind: 'charge' | 'bonus'; driverId: string; amountCents: number; onDate: string; description: string; reason: string; truckId: string | null }): Promise<DriverTx> {
    await this.requireDriver(principal, input.driverId);
    const tx: DriverTx = {
      id: newId('dtx'),
      driverId: input.driverId,
      kind: input.kind === 'charge' ? 'manual_charge' : 'adjustment',
      onDate: input.onDate,
      amountCents: input.amountCents,
      recoveredCents: 0,
      state: 'pending',
      source: input.kind === 'charge' ? 'safety_violation' : 'safety_bonus',
      sourceKey: `safety_violation:${input.violationId}:${input.kind}:${Date.now()}`,
      truckId: input.truckId,
      loadId: null,
      settlementId: null,
      description: input.description,
      companyCost: false,
      reason: input.reason,
      evidenceFileId: null,
      approvedBy: null,
      approvedAt: null,
      installments: null,
    };
    const { stored } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    await this.audit.write(principal, { action: input.kind === 'charge' ? 'driver_charge' : 'driver_bonus', entityType: 'driver', entityId: input.driverId, entityLabel: (await this.driverName(principal, input.driverId)) ?? input.driverId, summary: `${input.kind === 'charge' ? 'Charge' : 'Bonus'} $${(input.amountCents / 100).toFixed(2)} from Safety ${input.reference}: ${input.description} (pending Accounting)`, reason: input.reason, changes: [] });
    return stored.record;
  }

  /**
   * The money behind a claim's driver charge (Claims v2, 2026-10-14), created when Accounting
   * approves it on the charge card: approved, capped per settlement, keyed by the charge so a
   * retried approval lands once. The settlement engine recovers it like any other approved charge.
   */
  async fromDriverCharge(principal: Principal, input: { chargeId: string; reference: string; driverId: string; amountCents: number; onDate: string; description: string; reason: string; truckId: string | null; perSettlementCents: number }): Promise<DriverTx> {
    await this.requireDriver(principal, input.driverId);
    const now = this.clock().toISOString();
    const who = principal.userName ?? principal.userId;
    const total = Math.max(1, Math.ceil(input.amountCents / Math.max(1, input.perSettlementCents)));
    const tx: DriverTx = {
      id: newId('dtx'),
      driverId: input.driverId,
      kind: 'manual_charge',
      onDate: input.onDate,
      amountCents: input.amountCents,
      recoveredCents: 0,
      state: 'approved',
      source: 'driver_charge',
      sourceKey: `driver_charge:${input.chargeId}`,
      truckId: input.truckId,
      loadId: null,
      settlementId: null,
      description: input.description,
      companyCost: false,
      reason: input.reason,
      evidenceFileId: null,
      approvedBy: who,
      approvedAt: now,
      installments: { total, remaining: total, perPeriodCents: Math.min(input.perSettlementCents, input.amountCents) },
      recoveryLog: [],
    };
    const { stored, created } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
    if (created) await this.audit.write(principal, { action: 'driver_charge', entityType: 'driver', entityId: input.driverId, entityLabel: (await this.driverName(principal, input.driverId)) ?? input.driverId, summary: `${input.reference}: $${(input.amountCents / 100).toFixed(2)} approved, ${total} × $${(Math.min(input.perSettlementCents, input.amountCents) / 100).toFixed(2)} from settlements`, reason: input.reason, changes: [] });
    return stored.record;
  }

  /** A claim charge paused, disputed, resumed or cancelled from the charge card; the caller checks who may. */
  async setChargeTxState(principal: Principal, id: string, state: 'approved' | 'disputed' | 'paused' | 'void', reason: string): Promise<DriverTx> {
    const { record } = await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => {
      if (tx.state === 'applied' && state !== 'approved') return tx;
      if (tx.state === state) return tx;
      return { ...tx, state, reason: reason || tx.reason };
    });
    return record;
  }

  /** A claim charge reduced by Management: never below what was already recovered. */
  async adjustChargeTx(principal: Principal, id: string, amountCents: number, reason: string): Promise<DriverTx> {
    const { record } = await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => {
      if (amountCents < tx.recoveredCents) throw unprocessable(`$${(tx.recoveredCents / 100).toFixed(2)} is already recovered; the charge cannot go below it.`);
      return { ...tx, amountCents, state: tx.recoveredCents >= amountCents ? 'applied' : tx.state === 'applied' ? 'approved' : tx.state, reason: reason || tx.reason };
    });
    return record;
  }

  /** Money the driver paid outside a settlement (or from escrow): counted as recovered, once per reference. */
  async recordDirectRecovery(principal: Principal, id: string, input: { key: string; cents: number; label: string; at: string }): Promise<DriverTx> {
    const { record } = await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => {
      const log = tx.recoveryLog ?? [];
      if (log.some((l) => l.settlementId === input.key)) return tx;
      const owed = tx.amountCents - tx.recoveredCents;
      if (input.cents > owed) throw unprocessable(`At most $${(owed / 100).toFixed(2)} is still outstanding.`);
      const recovered = tx.recoveredCents + input.cents;
      return {
        ...tx,
        recoveredCents: recovered,
        state: recovered >= tx.amountCents ? 'applied' : tx.state,
        recoveryLog: [...log, { settlementId: input.key, settlementNumber: input.label, cents: input.cents, at: input.at }],
      };
    });
    return record;
  }

  async transaction(principal: Principal, id: string): Promise<DriverTx> {
    return (await this.store.get<DriverTx>('acct_driver_transactions', principal.companyId, id)).record;
  }

  /**
   * Adds a charge to the next eligible settlement, optionally capped per settlement (a partial
   * deduction). The draft that picks it up only previews it; the balance falls when that
   * statement is approved.
   */
  async scheduleRecovery(principal: Principal, id: string, perSettlementCents: number | null, reason: string): Promise<DriverTx> {
    this.requireEdit(principal);
    const now = this.clock().toISOString();
    const who = principal.userName ?? principal.userId;
    const { record } = await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => {
      if (tx.state === 'void') throw unprocessable('This charge was cancelled.');
      if (tx.state === 'applied' || tx.recoveredCents >= tx.amountCents) throw unprocessable('This charge is already fully deducted.');
      const owed = tx.amountCents - tx.recoveredCents;
      if (perSettlementCents !== null && perSettlementCents > owed) throw unprocessable(`At most $${(owed / 100).toFixed(2)} is still outstanding.`);
      return {
        ...tx,
        state: 'approved',
        approvedBy: tx.state === 'approved' ? tx.approvedBy : who,
        approvedAt: tx.state === 'approved' ? tx.approvedAt : now,
        installments: perSettlementCents === null ? null : { total: Math.ceil(owed / perSettlementCents), remaining: Math.ceil(owed / perSettlementCents), perPeriodCents: perSettlementCents },
      };
    });
    await this.audit.write(principal, { action: 'driver_charge_state', entityType: 'driver', entityId: record.driverId, entityLabel: (await this.driverName(principal, record.driverId)) ?? record.driverId, summary: `${record.description}: added to the next settlement${perSettlementCents !== null ? ` at $${(perSettlementCents / 100).toFixed(2)} per settlement` : ''}`, reason: reason || null, changes: [{ field: 'state', old: null, new: 'approved' }] });
    return record;
  }

  /**
   * Reverses one posted deduction of a charge: the balance comes back by exactly what that
   * statement took, and the driver is paid it back on the next statement (one refund
   * transaction, keyed by charge and statement, so a retry refunds once).
   */
  async reverseRecovery(principal: Principal, id: string, settlementId: string, reason: string): Promise<DriverTx> {
    this.requireEdit(principal);
    const now = this.clock().toISOString();
    const who = principal.userName ?? principal.userId;
    let reversed: RecoveryLogEntry | null = null;
    const { record } = await this.store.modify<DriverTx>('acct_driver_transactions', principal.companyId, id, (tx) => {
      const log = tx.recoveryLog ?? [];
      const entry = log.find((l) => l.settlementId === settlementId && !l.reversedAt);
      if (!entry) {
        if (log.some((l) => l.settlementId === settlementId)) return tx;
        throw unprocessable('That settlement did not deduct from this charge.');
      }
      reversed = entry;
      return {
        ...tx,
        recoveredCents: Math.max(0, tx.recoveredCents - entry.cents),
        state: tx.state === 'applied' ? 'approved' : tx.state,
        recoveryLog: log.map((l) => (l === entry ? { ...l, reversedAt: now, reversedBy: who, reason } : l)),
      };
    });
    const entry = reversed as RecoveryLogEntry | null;
    const done = entry ?? (record.recoveryLog ?? []).find((l) => l.settlementId === settlementId) ?? null;
    if (done) {
      const refund: DriverTx = { id: newId('dtx'), driverId: record.driverId, kind: 'adjustment', onDate: now.slice(0, 10), amountCents: done.cents, recoveredCents: 0, state: 'approved', source: 'recovery_reversal', sourceKey: `recovery_reversal:${record.id}:${settlementId}`, truckId: record.truckId, loadId: null, settlementId: null, description: `Refund of deduction · ${record.description}${done.settlementNumber ? ` (${done.settlementNumber})` : ''}`, companyCost: false, reason, approvedBy: who, approvedAt: now, fleetExpenseId: record.fleetExpenseId ?? null };
      await this.store.insert('acct_driver_transactions', principal.companyId, refund);
    }
    if (entry) await this.audit.write(principal, { action: 'driver_deduction_reversed', entityType: 'driver', entityId: record.driverId, entityLabel: (await this.driverName(principal, record.driverId)) ?? record.driverId, summary: `${record.description}: $${(entry.cents / 100).toFixed(2)} deducted on ${entry.settlementNumber ?? settlementId} reversed; refunded on the next settlement`, reason, changes: [{ field: 'recovered_cents', old: String(record.recoveredCents + entry.cents), new: String(record.recoveredCents) }] });
    return record;
  }

  /** Every transaction a set of Fleet Expenses raised, including refunds of reversed deductions. */
  async fleetExpenseTransactions(principal: Principal, expenseIds: string[]): Promise<DriverTx[]> {
    if (expenseIds.length === 0) return [];
    const rows = (await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`source in ('fleet_expense', 'recovery_reversal')`)).map((r) => r.record);
    const ids = new Set(expenseIds);
    return rows.filter((t) => t.fleetExpenseId && ids.has(t.fleetExpenseId));
  }

  // ------------------------------------------------------------ recurring deductions

  /** Every driver's recurring deductions, for the Expenses › Recurring tab (read-only there). */
  async recurringAll(principal: Principal): Promise<Array<RecurringDeduction & { driverName: string | null }>> {
    const rows = (await this.store.list<RecurringDeduction>('acct_recurring_deductions', principal.companyId)).map((r) => r.record);
    const out: Array<RecurringDeduction & { driverName: string | null }> = [];
    for (const r of rows) out.push({ ...r, driverName: await this.driverName(principal, r.driverId) });
    return out;
  }

  async recurring(principal: Principal, driverId: string): Promise<RecurringDeduction[]> {
    return (await this.store.list<RecurringDeduction>('acct_recurring_deductions', principal.companyId, sql`driver_id = ${driverId}`)).map((r) => r.record);
  }

  async saveRecurring(principal: Principal, driverId: string, input: RecurringDeductionInput & { id?: string; expectedVersion?: number }): Promise<RecurringDeduction> {
    this.requireEdit(principal);
    if (input.status === 'cancelled') this.requireAdmin(principal);
    await this.requireDriver(principal, driverId);
    if (input.id) {
      const stored = await this.store.get<RecurringDeduction>('acct_recurring_deductions', principal.companyId, input.id);
      const after: RecurringDeduction = { ...stored.record, ...input, id: input.id, driverId };
      await this.store.update('acct_recurring_deductions', principal.companyId, input.id, input.expectedVersion ?? stored.version, after);
      return after;
    }
    const rec: RecurringDeduction = { ...input, id: newId('rcd'), driverId, chargedCents: 0 };
    await this.store.insert('acct_recurring_deductions', principal.companyId, rec);
    await this.audit.write(principal, { action: 'recurring_deduction', entityType: 'driver', entityId: driverId, entityLabel: driverId, summary: `${rec.category} ${rec.cadence} $${(rec.amountCents / 100).toFixed(2)} from ${rec.startsOn}`, changes: [] });
    return rec;
  }

  // ------------------------------------------------------------ one-week changes (owner, 2026-10-20)

  /** Stopping a recurring deduction is for an administrator; everybody else edits or skips a week. */
  private requireAdmin(principal: Principal): void {
    if (!principal.roles.includes('administrator')) throw forbidden('Only an administrator can delete (stop) a recurring deduction.');
  }

  private async recurringOne(principal: Principal, driverId: string, id: string) {
    const stored = await this.store.get<RecurringDeduction>('acct_recurring_deductions', principal.companyId, id);
    if (stored.record.driverId !== driverId) throw unprocessable('That recurring deduction belongs to another driver.');
    return stored;
  }

  /** Skip (0), change (cents) or undo (null) one week of a recurring deduction. */
  async recurringWeek(principal: Principal, driverId: string, id: string, input: { periodStart: string; cents: number | null; reason: string }): Promise<RecurringDeduction> {
    this.requireEdit(principal);
    const stored = await this.recurringOne(principal, driverId, id);
    const others = stored.record.overrides.filter((o) => o.periodStart !== input.periodStart);
    const after: RecurringDeduction = { ...stored.record, overrides: input.cents === null ? others : [...others, { periodStart: input.periodStart, amountCents: input.cents, reason: input.reason }] };
    await this.store.update('acct_recurring_deductions', principal.companyId, id, stored.version, after);
    const what = input.cents === null ? 'put back' : input.cents === 0 ? 'skipped' : `changed to $${(input.cents / 100).toFixed(2)}`;
    await this.audit.write(principal, { action: 'recurring_deduction', entityType: 'driver', entityId: driverId, entityLabel: driverId, summary: `${stored.record.label || stored.record.category}: week of ${input.periodStart} ${what} - ${input.reason}`, changes: [] });
    return after;
  }

  /** A recurring deduction's amount from now on. */
  async recurringAmount(principal: Principal, driverId: string, id: string, input: { amountCents: number; label?: string; reason: string }): Promise<RecurringDeduction> {
    this.requireEdit(principal);
    const stored = await this.recurringOne(principal, driverId, id);
    const after: RecurringDeduction = { ...stored.record, amountCents: input.amountCents, label: input.label?.trim() || stored.record.label };
    await this.store.update('acct_recurring_deductions', principal.companyId, id, stored.version, after);
    await this.audit.write(principal, { action: 'recurring_deduction', entityType: 'driver', entityId: driverId, entityLabel: driverId, summary: `${after.label || after.category}: $${(stored.record.amountCents / 100).toFixed(2)} -> $${(input.amountCents / 100).toFixed(2)} from now on - ${input.reason}`, changes: [{ field: 'amountCents', old: String(stored.record.amountCents), new: String(input.amountCents) }] });
    return after;
  }

  /** Stops it for good: kept on record as cancelled, never deleted (administrators only). */
  async stopRecurring(principal: Principal, driverId: string, id: string, reason: string): Promise<RecurringDeduction> {
    this.requireEdit(principal);
    this.requireAdmin(principal);
    const stored = await this.recurringOne(principal, driverId, id);
    const today = this.clock().toISOString().slice(0, 10);
    const after: RecurringDeduction = { ...stored.record, status: 'cancelled', endsOn: stored.record.endsOn && stored.record.endsOn < today ? stored.record.endsOn : today };
    await this.store.update('acct_recurring_deductions', principal.companyId, id, stored.version, after);
    await this.audit.write(principal, { action: 'recurring_deduction', entityType: 'driver', entityId: driverId, entityLabel: driverId, summary: `${after.label || after.category} stopped - ${reason}`, changes: [{ field: 'status', old: stored.record.status, new: 'cancelled' }] });
    return after;
  }

  /** Skip (0), change (cents) or undo (null) one lease charge for one week. */
  async leaseWeek(principal: Principal, driverId: string, input: { periodStart: string; code: string; cents: number | null; reason: string }): Promise<DriverProfileRecord> {
    this.requireEdit(principal);
    const existing = await this.profile(principal, driverId);
    if (existing.defaulted) throw unprocessable("This driver's lease plan is the unsaved default. Save the financial profile once (Fix pay setup › Save profile), then change a week.");
    const others = (existing.record.leaseOverrides ?? []).filter((o) => !(o.periodStart === input.periodStart && o.code === input.code));
    const record: DriverProfileRecord = {
      ...existing.record,
      leaseOverrides: input.cents === null ? others : [...others, { periodStart: input.periodStart, code: input.code, cents: input.cents, reason: input.reason, byName: principal.userName ?? principal.userId, at: this.clock().toISOString() }],
    };
    await this.store.saveDriverProfile(principal.companyId, driverId, existing.version, existing.current?.contractType ?? 'CD', record as unknown as Record<string, unknown>);
    const what = input.cents === null ? 'put back' : input.cents === 0 ? 'skipped' : `changed to $${(input.cents / 100).toFixed(2)}`;
    await this.audit.write(principal, { action: 'update', entityType: 'driver', entityId: driverId, entityLabel: driverId, summary: `Lease charge ${input.code}: week of ${input.periodStart} ${what} - ${input.reason}`, changes: [] });
    return record;
  }

  // ------------------------------------------------------------ overview

  async overview(principal: Principal, driverId: string) {
    await this.syncWorkOrderCharges(principal, driverId);
    const [profile, txs, recurring] = await Promise.all([this.profile(principal, driverId), this.transactions(principal, driverId), this.recurring(principal, driverId)]);
    const current = profile.current;
    const debt = debtSummary(profile.record.openingDebtReconciled ? (profile.record.openingDebtCents ?? 0) : profile.record.openingDebtCents, txs);
    // Escrow balance and history exist whether or not collection is switched on (section 4).
    const escrow = { ...escrowSummary(current?.escrow ?? { targetCents: 250_000, perSettlementCents: 35_000, openingBalanceCents: 0, openingReconciled: true }, txs), collectionEnabled: Boolean(current?.switches.escrowEnabled) };
    const pending = txs.filter((t) => t.state === 'pending' && !t.companyCost).reduce((s, t) => s + t.amountCents, 0);
    const companyCosts = txs.filter((t) => t.companyCost && t.state !== 'void');
    const settlements = (await this.store.list<{ id: string; status: string; netCents: number; payableCents: number; periodStart: string; periodEnd: string; paidAt?: string | null; settlementNumber?: string; exceptions?: string[]; loadIds?: string[] }>('acct_settlements', principal.companyId, sql`party_type = 'driver' and party_id = ${driverId}`, 'period_start desc')).map((s) => s.record);
    const paidToDate = settlements.filter((s) => s.status === 'paid').reduce((s, x) => s + x.payableCents, 0);
    // The three payable states, kept apart (section 2).
    const approvedUnpaid = settlements.filter((s) => s.status === 'approved').reduce((s, x) => s + x.payableCents, 0);
    const drafts = settlements.filter((s) => s.status === 'draft' || s.status === 'review');
    const draftNet = drafts.reduce((s, x) => s + x.netCents, 0);
    // Earned but not yet on an approved statement: from the completion pipeline's candidates.
    const completions = (await this.store.list<CompletionRecord>('acct_completions', principal.companyId, sql`record->'earnings' @> ${JSON.stringify([{ recipientId: driverId }])}::jsonb and ${NOT_DEMO_LOAD}`)).map((c) => c.record);
    const earnings = completions.map((c) => {
      const e = c.earnings.find((x) => x.recipientId === driverId)!;
      // The statement is read live: an approval after the completion was processed still counts.
      const stm = settlements.find((s) => s.status !== 'reversed' && (s.loadIds ?? []).includes(c.loadId)) ?? null;
      return { loadId: c.loadId, loadNumber: c.loadNumber, loadStatus: c.loadStatus, completedAt: c.completedAt, grossCents: c.grossCents, linehaulCents: c.linehaulCents, cents: e.cents, planKind: e.planKind, planRate: e.planRate, planEffectiveFrom: e.planEffectiveFrom, rateConfirmed: e.rateConfirmed, blockers: e.blockers, settlementId: stm?.id ?? e.settlementId, settlementStatus: stm?.status ?? e.settlementStatus, invoiceQueue: c.invoiceCandidate.queue, invoiceStatus: c.invoiceCandidate.invoiceStatus, pipelineState: c.state, pipelineError: c.error };
    });
    const unsettled = earnings.filter((e) => e.settlementStatus !== 'approved' && e.settlementStatus !== 'paid');
    // A blocked candidate (ambiguous rate, missing profile) makes the total 'Cannot calculate' with its reason, never a confident number.
    const earnedUnsettled = unsettled.some((e) => e.cents === null || e.blockers.length > 0) ? null : unsettled.reduce((s, e) => s + (e.cents ?? 0), 0);
    const rate = current && (current.loadedPlan.kind === 'percent_of_gross' || current.loadedPlan.kind === 'percent_of_linehaul') ? readRosterPercent(current.loadedPlan.rate) : null;
    return {
      driverId,
      name: await this.driverName(principal, driverId),
      profile,
      rate: rate ? { ...rate, confirmed: Boolean(profile.record.rateConfirmedAt), confirmedBy: profile.record.rateConfirmedBy ?? null, basis: current!.loadedPlan.kind } : null,
      debt,
      escrow,
      pendingDeductionsCents: pending,
      currentPayableCents: approvedUnpaid,
      approvedUnpaidCents: approvedUnpaid,
      draftNetCents: draftNet,
      draftCount: drafts.length,
      earnedUnsettledCents: earnedUnsettled,
      earnedBlockers: [...new Set(unsettled.flatMap((e) => e.blockers))],
      earnings,
      paidToDateCents: paidToDate,
      companyCosts,
      transactions: txs,
      recurring,
      statements: settlements,
      history: profile.record.notes,
    };
  }

  /**
   * The financial review, grouped by driver (corrective brief 2, section 2): one row per driver
   * with the issues kept apart - rate ambiguity, basis unconfirmed, pay plan not reviewed,
   * opening debt / escrow unreconciled, no payee, no email - each with the values already on
   * record so the reviewer confirms rather than re-enters. Resolving one never clears another.
   */
  async review(principal: Principal): Promise<Array<{ driverId: string; driverNumber: string; name: string; contractType: string; plan: { kind: string; rate: number; basis: string } | null; rate: ReturnType<typeof readRosterPercent> | null; rateConfirmed: boolean; profileSaved: boolean; issues: Array<{ kind: 'rate_ambiguous' | 'basis_unconfirmed' | 'plan_unreviewed' | 'opening_debt' | 'opening_escrow' | 'no_payee' | 'no_email'; label: string; detail: string }>; completedLoads: number; earnedPreviewCents: number | null; blockedLoads: number }>> {
    const rows = await this.store.db.select({ id: drivers.id, driverNumber: drivers.driverNumber, first: drivers.firstName, last: drivers.lastName, email: drivers.email, status: drivers.status }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), sql`${drivers.status} <> 'terminated'`));
    const completions = (await this.store.list<CompletionRecord>('acct_completions', principal.companyId, NOT_DEMO_LOAD)).map((c) => c.record);
    const out = [];
    for (const d of rows) {
      const profile = await this.profile(principal, d.id);
      const cur = profile.current;
      const mine = completions.flatMap((c) => c.earnings.filter((e) => e.recipientId === d.id && e.settlementStatus !== 'approved' && e.settlementStatus !== 'paid').map((e) => ({ c, e })));
      if (mine.length === 0 && d.status !== 'active') continue;
      const issues: Array<{ kind: 'rate_ambiguous' | 'basis_unconfirmed' | 'plan_unreviewed' | 'opening_debt' | 'opening_escrow' | 'no_payee' | 'no_email'; label: string; detail: string }> = [];
      const percentPlan = cur && (cur.loadedPlan.kind === 'percent_of_gross' || cur.loadedPlan.kind === 'percent_of_linehaul');
      const rate = percentPlan ? readRosterPercent(cur.loadedPlan.rate) : null;
      if (profile.defaulted) issues.push({ kind: 'plan_unreviewed', label: 'Pay plan not reviewed', detail: `Roster says ${cur ? `${cur.loadedPlan.kind.replace(/_/g, ' ')} ${cur.loadedPlan.rate}` : 'nothing'}; Accounting has not saved a financial profile.` });
      if (rate?.ambiguous && !profile.record.rateConfirmedAt) issues.push({ kind: 'rate_ambiguous', label: 'Rate reading', detail: `${rate.percent} reads as ${rate.asPercent} or, as a multiplier, ${rate.asMultiplier}.` });
      if (percentPlan && cur!.loadedPlan.kind === 'percent_of_linehaul' && !profile.record.rateConfirmedAt) issues.push({ kind: 'basis_unconfirmed', label: 'Basis', detail: 'Legacy linehaul basis; the owner stated a total-gross policy. Needs a reviewed conversion, not a silent rewrite.' });
      if (profile.record.openingDebtCents === null || !profile.record.openingDebtReconciled) issues.push({ kind: 'opening_debt', label: 'Opening debt', detail: 'Not reconciled: final net waits; earnings preview does not.' });
      if (cur && !cur.escrow.openingReconciled) issues.push({ kind: 'opening_escrow', label: 'Opening escrow', detail: 'Recorded movements are shown; the opening balance is unreconciled.' });
      // Bank details are optional while payroll (ADP) is not connected: drivers are paid from the
      // bank by hand and the payment is recorded on the statement (owner, 2026-10-20).
      if (!d.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(d.email)) issues.push({ kind: 'no_email', label: 'No email', detail: 'Statements cannot be emailed; earnings are not affected.' });
      const earned = mine.some(({ e }) => e.cents === null || e.blockers.length > 0) ? null : mine.reduce((s, { e }) => s + (e.cents ?? 0), 0);
      out.push({ driverId: d.id, driverNumber: d.driverNumber, name: `${d.first} ${d.last}`.trim(), contractType: cur?.contractType ?? 'CD', plan: cur ? { kind: cur.loadedPlan.kind, rate: cur.loadedPlan.rate, basis: cur.loadedPlan.kind === 'percent_of_linehaul' ? 'linehaul' : cur.loadedPlan.kind === 'percent_of_gross' ? 'gross' : 'n/a' } : null, rate, rateConfirmed: Boolean(profile.record.rateConfirmedAt), profileSaved: !profile.defaulted, issues, completedLoads: mine.length, earnedPreviewCents: earned, blockedLoads: mine.filter(({ e }) => e.blockers.length > 0).length });
    }
    return out.filter((r) => r.issues.length > 0 || r.completedLoads > 0).sort((a, b) => b.issues.length - a.issues.length || a.name.localeCompare(b.name));
  }

  /**
   * Repairs charged to this driver on the server's work orders become transactions in the one
   * account (section 6): key `work_order:<id>`, so a corrected order corrects the line instead of
   * adding a second. A charge the driver has not been told about stays `pending` and is never
   * deducted; an order billed back to the company, or voided, voids the line. A line already
   * applied on a statement is left alone - the correction then needs an adjustment, on purpose.
   */
  async syncWorkOrderCharges(principal: Principal, driverId: string): Promise<{ created: number; updated: number }> {
    const rows = await this.store.db
      .select({ id: workOrders.id, number: workOrders.number, unitId: workOrders.unitId, assetType: workOrders.assetType, title: workOrders.title, total: workOrders.total, invoiceTotal: workOrders.invoiceTotal, completedAt: workOrders.completedAt, shopInAt: workOrders.shopInAt, chargeParty: workOrders.chargeParty, chargeDriverId: workOrders.chargeDriverId, driverInformed: workOrders.driverInformed, driverInformedAt: workOrders.driverInformedAt, voidedAt: workOrders.voidedAt })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.chargeDriverId, driverId)));
    const existing = await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`driver_id = ${driverId} and source = 'work_order'`);
    let created = 0;
    let updated = 0;
    for (const wo of rows) {
      const sourceKey = `work_order:${wo.id}`;
      const amountCents = Math.round(Number(wo.invoiceTotal ?? wo.total ?? 0) * 100);
      const live = wo.chargeParty === 'driver' && !wo.voidedAt && amountCents > 0;
      const state: DriverTx['state'] = !live ? 'void' : wo.driverInformed ? 'approved' : 'pending';
      const onDate = (wo.completedAt ?? wo.shopInAt).toISOString().slice(0, 10);
      const description = `Shop charge - ${wo.number}${wo.title ? ` ${wo.title}` : ''}`.trim();
      const found = existing.find((t) => t.record.sourceKey === sourceKey);
      if (!found) {
        if (!live) continue;
        const tx: DriverTx = { id: newId('dtx'), driverId, kind: 'repair', onDate, amountCents, recoveredCents: 0, state, source: 'work_order', sourceKey, truckId: wo.assetType === 'truck' ? wo.unitId : null, loadId: null, settlementId: null, description, companyCost: false, reason: wo.driverInformed ? `Driver informed ${wo.driverInformedAt?.toISOString().slice(0, 10) ?? ''}`.trim() : 'Held: the driver has not been told yet', approvedBy: wo.driverInformed ? 'work order' : null, approvedAt: wo.driverInformed ? (wo.driverInformedAt?.toISOString() ?? null) : null };
        const { created: c } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
        if (c) created += 1;
        continue;
      }
      const t = found.record;
      if (t.state === 'applied' || (t.state === 'void' && !live)) continue;
      if (t.amountCents === amountCents && t.state === state && t.description === description) continue;
      await this.store.update('acct_driver_transactions', principal.companyId, found.id, found.version, { ...t, amountCents, state, description, onDate, reason: !live ? 'The work order is no longer charged to the driver' : wo.driverInformed ? `Driver informed ${wo.driverInformedAt?.toISOString().slice(0, 10) ?? ''}`.trim() : 'Held: the driver has not been told yet' });
      updated += 1;
    }
    return { created, updated };
  }

  /**
   * The legacy escrow movements the browser kept in the workspace (`ws2-escrowentries`, on the
   * server as app_state) become canonical transactions, once each: the legacy id is the source
   * key, so a rerun is a no-op. Nothing is posted to the ledger and no cash is recorded twice -
   * these are the same movements, now in the one history every screen reads.
   */
  async importLegacyEscrow(principal: Principal, apply: boolean): Promise<{ dryRun: boolean; found: number; imported: number; alreadyImported: number; skipped: Array<{ id: string; reason: string }>; movements: Array<{ legacyId: string; driverId: string; kind: string; amountCents: number; date: string; recordedBy: string; state: 'new' | 'already' }> }> {
    this.requireEdit(principal);
    const ws = await this.state.workspace(principal.companyId);
    const entries = ((ws?.data['escrowEntries'] as Array<{ id: string; driverId: string; date: string; kind: string; amount: number; reason: string; reference: string | null; recordedByName: string; createdAt: string }> | undefined) ?? []);
    const existing = new Set((await this.store.list<DriverTx>('acct_driver_transactions', principal.companyId, sql`source = 'legacy_escrow'`)).map((t) => t.record.sourceKey));
    const skipped: Array<{ id: string; reason: string }> = [];
    const movements: Array<{ legacyId: string; driverId: string; kind: string; amountCents: number; date: string; recordedBy: string; state: 'new' | 'already' }> = [];
    let imported = 0;
    for (const e of entries) {
      const kind = e.kind === 'payment' ? 'escrow_deposit' : e.kind === 'refund' ? 'escrow_refund' : e.kind === 'charge' || e.kind === 'offset' ? 'escrow_offset' : null;
      if (!kind) {
        skipped.push({ id: e.id, reason: `Unknown legacy kind ${e.kind}` });
        continue;
      }
      const sourceKey = `legacy-escrow:${e.id}`;
      const already = existing.has(sourceKey);
      movements.push({ legacyId: e.id, driverId: e.driverId, kind, amountCents: Math.round(e.amount * 100), date: e.date, recordedBy: e.recordedByName, state: already ? 'already' : 'new' });
      if (already || !apply) continue;
      const tx: DriverTx = { id: newId('dtx'), driverId: e.driverId, kind, onDate: e.date, amountCents: Math.round(e.amount * 100), recoveredCents: 0, state: 'applied', source: 'legacy_escrow', sourceKey, truckId: null, loadId: null, settlementId: null, description: e.reason || 'Escrow movement (legacy)', companyCost: false, reason: `Imported from the legacy escrow record ${e.id}, recorded by ${e.recordedByName} on ${e.createdAt}` };
      const { created } = await this.store.insert('acct_driver_transactions', principal.companyId, tx);
      if (created) imported += 1;
    }
    if (apply) await this.audit.write(principal, { action: 'legacy_escrow_imported', entityType: 'company', entityId: principal.companyId, entityLabel: 'accounting', summary: `Legacy escrow: ${entries.length} found, ${imported} imported, ${movements.filter((m) => m.state === 'already').length} already there`, changes: [] });
    return { dryRun: !apply, found: entries.length, imported, alreadyImported: movements.filter((m) => m.state === 'already').length, skipped, movements };
  }
}
