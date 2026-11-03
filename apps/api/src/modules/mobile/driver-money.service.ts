import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DRIVER_REIMBURSEMENT_STATE_LABEL,
  REIMBURSEMENT_CATEGORY_LABEL,
  reimbursableCents,
  type DriverReimbursement,
  type DriverReimbursementCreateInput,
  type DriverReimbursementList,
  type DriverReimbursementState,
  type DriverSettlementDetail,
  type DriverSettlementList,
  type DriverSettlementSummary,
  type FleetExpenseCategory,
  type ReimbursementCategory,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { fleetExpenses } from '../../database/schema/fleet';
import { driverAppSubmissions } from '../../database/schema/mobile';
import type { ExpenseRecord } from '../accounting/payables.service';
import { ReimbursementsService } from '../accounting/reimbursements.service';
import { StatementPdfService } from '../accounting/statement-pdf.service';
import { SettlementsService, type StatementRecord } from '../accounting/settlements.service';
import { FleetExpensesService } from '../fleet-expenses/fleet-expenses.service';
import { DriverContextService, type DriverContext } from './driver-context.service';
import { DriverOwnershipService, isImageOrPdf } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

const notFound = (what: string) => new AppError({ status: 404, title: 'Not Found', detail: `No such ${what}.` });
const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/** A company-card receipt is a Fleet expense; its category in Fleet's own words. */
const FLEET_CATEGORY: Record<ReimbursementCategory, FleetExpenseCategory> = {
  lumper: 'lumper',
  scale: 'scale',
  parking: 'parking',
  repair_supplies: 'supplies',
  other: 'other',
};

const STEP_ORDER: DriverReimbursementState[] = ['received', 'under_review', 'approved', 'added_to_settlement', 'paid'];

/**
 * The driver's money in the app (mobile M3, API.md §8-§9): receipts filed through the existing
 * Accounting (reimbursement) or Fleet (company-card expense) paths, and the driver's own finalized
 * statements, read as stored - never recomputed. "Paid" is read from the settlement that carries
 * the reimbursement, never from the reimbursement alone.
 */
@Injectable()
export class DriverMoneyService {
  private readonly logger = new Logger(DriverMoneyService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly reimbursements: ReimbursementsService,
    private readonly settlements: SettlementsService,
    private readonly pdfs: StatementPdfService,
    private readonly fleetExpenses: FleetExpensesService,
    private readonly notifications: MobileNotificationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ============================================================================== receipts

  async fileReceipt(principal: Principal, input: DriverReimbursementCreateInput & { currency: 'USD' }, idempotencyKey: string): Promise<DriverReimbursement> {
    const ctx = await this.context.resolve(principal);
    await this.ownership.ownFiles(principal, [input.receiptFileId], isImageOrPdf);
    const load = input.loadId ? await this.ownership.ownLoad(ctx, input.loadId) : null;
    const assigned = await this.ownership.units(ctx, { truckId: input.truckId, trailerId: input.trailerId });
    // Named on one of their own loads and no truck chosen: the load's truck is the one it was for.
    const units = { ...assigned, truck: input.truckId === undefined && load?.truckId ? { id: load.truckId, unitNumber: '' } : assigned.truck };
    const label = REIMBURSEMENT_CATEGORY_LABEL[input.category];
    const where = input.location?.text?.trim() || null;

    if (input.paidBy === 'driver') {
      const out = await this.reimbursements.createFromDriver(
        principal,
        {
          payerDriverId: ctx.driverId,
          truckId: units.truck?.id ?? null,
          loadId: load?.id ?? null,
          onDate: input.date,
          category: input.category,
          receiptCents: input.amountCents,
          driverFundedCents: input.amountCents,
          currency: 'USD',
          description: `${label}${load ? ` · ${load.loadNumber}` : ''} (driver app)`,
          paymentSource: 'driver_personal',
          receiptFileId: input.receiptFileId,
          missingReceiptReason: null,
          note: [input.note?.trim(), where ? `Where: ${where}` : null, units.trailer ? `Trailer ${units.trailer.unitNumber}` : null].filter(Boolean).join(' · ') || null,
        },
        { driverId: ctx.driverId, idempotencyKey, location: where },
      );
      if (!out.ok) throw unprocessable(out.blocked);
      const recipients = await this.notifications.teamUserIds(ctx.companyId, ['accounting.edit']);
      await this.notifications
        .notifyUsers(ctx.companyId, recipients, {
          title: `Reimbursement ${out.expense.expenseNumber} to review: ${label} $${(input.amountCents / 100).toFixed(2)}`,
          body: `Filed by ${ctx.driverName} from the driver app${load ? ` · load ${load.loadNumber}` : ''}.`,
          pushTitle: 'Reimbursement to review',
          pushBody: `${out.expense.expenseNumber}: a driver filed a receipt.`,
          target: { type: 'reimbursement', id: out.expense.id },
          dedupeKey: `reimbursement:${out.expense.id}:filed`,
        })
        .catch((error: unknown) => this.logger.warn(`Notifying Accounting about ${out.expense.expenseNumber} failed: ${String(error)}`));
      return this.reimbursementView(out.expense, await this.settlementMap(principal, ctx.driverId));
    }

    // Company card: the company's own expense, a draft for Fleet to check. Nothing is owed back.
    const made = await this.fleetExpenses.createDraftFromDriver(
      principal,
      {
        truckId: units.truck?.id ?? '',
        category: FLEET_CATEGORY[input.category],
        expenseDate: input.date,
        amountCents: input.amountCents,
        description: `${label}${load ? ` · ${load.loadNumber}` : ''} (driver app, company card)`,
        notes: [input.note?.trim(), units.trailer ? `Trailer ${units.trailer.unitNumber}` : null].filter(Boolean).join(' · ') || null,
        location: { placeName: null, address: where, city: input.location?.city ?? null, state: input.location?.state ?? null, postalCode: null },
      },
      { driverId: ctx.driverId, driverName: ctx.driverName, receiptFileId: input.receiptFileId },
    );
    await this.db.insert(driverAppSubmissions).values({
      id: `das_${crypto.randomUUID()}`,
      companyId: ctx.companyId,
      driverId: ctx.driverId,
      membershipId: ctx.membershipId,
      kind: 'company_expense',
      subkind: input.category,
      targetType: 'fleet_expense',
      targetId: made.id,
      targetNumber: made.reference,
      detail: { category: input.category, amountCents: input.amountCents, date: input.date, loadId: load?.id ?? null, loadNumber: load?.loadNumber ?? null, receiptFileId: input.receiptFileId, location: input.location ?? null },
      idempotencyKey,
    });
    const recipients = await this.notifications.teamUserIds(ctx.companyId, ['maintenance.edit']);
    await this.notifications
      .notifyUsers(ctx.companyId, recipients, {
        title: `Company-card receipt ${made.reference}: ${label} $${(input.amountCents / 100).toFixed(2)} (draft)`,
        body: `Filed by ${ctx.driverName} from the driver app; check it and record it in Fleet expenses.`,
        pushTitle: 'Company-card receipt',
        pushBody: `${made.reference}: a driver filed a company-card receipt.`,
        target: { type: 'reimbursement', id: made.id },
        dedupeKey: `fleet_expense:${made.id}:filed`,
      })
      .catch((error: unknown) => this.logger.warn(`Notifying Fleet about ${made.reference} failed: ${String(error)}`));
    return (await this.companyExpenses(ctx, [made.id]))[0]!;
  }

  async myReceipts(principal: Principal): Promise<DriverReimbursementList> {
    const ctx = await this.context.resolve(principal);
    const settlements = await this.settlementMap(principal, ctx.driverId);
    const owed = (await this.reimbursements.forDriver(principal, ctx.driverId)).map((e) => this.reimbursementView(e, settlements));
    const company = await this.companyExpenses(ctx);
    return { reimbursements: [...owed, ...company].sort((a, b) => b.createdAt.localeCompare(a.createdAt)) };
  }

  async myReceipt(principal: Principal, id: string): Promise<DriverReimbursement> {
    const all = await this.myReceipts(principal);
    const found = all.reimbursements.find((r) => r.id === id || r.number === id);
    if (!found) throw notFound('receipt');
    return found;
  }

  /** The statements carrying this driver's reimbursements, by id: the truth about "paid". */
  private async settlementMap(principal: Principal, driverId: string): Promise<Map<string, StatementRecord>> {
    const rows = await this.settlements.statements(principal, { partyId: driverId });
    return new Map(rows.filter((s) => s.partyType === 'driver' && s.partyId === driverId).map((s) => [s.id, s]));
  }

  private reimbursementView(e: ExpenseRecord, settlements: Map<string, StatementRecord>): DriverReimbursement {
    const b = e.reimbursement!;
    const statement = b.settlementId ? (settlements.get(b.settlementId) ?? null) : null;
    let state: DriverReimbursementState;
    if (b.status === 'rejected') state = 'rejected';
    else if (b.status === 'pending') state = 'under_review';
    else if (b.status === 'approved') state = 'approved';
    // On a statement: paid only when that statement is paid; a reversed one hands it back.
    else if (statement?.status === 'paid') state = 'paid';
    else if (statement && statement.status !== 'reversed') state = 'added_to_settlement';
    else state = 'approved';
    const reachedAt: Partial<Record<DriverReimbursementState, string | null>> = {
      received: b.submittedAt,
      under_review: b.submittedAt,
      approved: b.status === 'rejected' ? null : b.reviewedAt,
      rejected: b.status === 'rejected' ? b.reviewedAt : null,
      added_to_settlement: state === 'added_to_settlement' || state === 'paid' ? b.includedAt : null,
      paid: state === 'paid' ? (statement?.paidAt ?? b.paidAt) : null,
    };
    const order = state === 'rejected' ? (['received', 'under_review', 'rejected'] as DriverReimbursementState[]) : STEP_ORDER;
    const last = [reachedAt.paid, reachedAt.added_to_settlement, b.reviewedAt, b.submittedAt].find(Boolean) ?? b.submittedAt;
    return {
      id: e.id,
      number: e.expenseNumber,
      kind: 'reimbursement',
      category: b.category,
      amountCents: b.receiptCents,
      reimbursableCents: reimbursableCents(b),
      currency: 'USD',
      date: e.onDate,
      state,
      stateLabel: DRIVER_REIMBURSEMENT_STATE_LABEL[state],
      steps: order.map((s) => ({ state: s, label: DRIVER_REIMBURSEMENT_STATE_LABEL[s], reachedAt: reachedAt[s] ?? null, current: s === state })),
      rejectedReason: b.status === 'rejected' ? b.rejectedReason : null,
      reviewer: { name: b.reviewedBy ?? 'Accounting' },
      settlement: statement ? { id: statement.id, number: statement.settlementNumber, status: statement.status, paidAt: statement.paidAt } : null,
      load: e.loadId ? { id: e.loadId, loadNumber: e.loadNumber ?? null } : null,
      truckId: e.truckId,
      location: b.location ? { text: b.location, source: 'manual' } : null,
      receiptFileId: e.receiptFileId ?? null,
      lastUpdate: last,
      createdAt: b.submittedAt,
    };
  }

  /** Company-card receipts this driver filed: draft Fleet expenses, nothing owed back. */
  private async companyExpenses(ctx: DriverContext, onlyIds?: string[]): Promise<DriverReimbursement[]> {
    const pointers = await this.db
      .select()
      .from(driverAppSubmissions)
      .where(and(eq(driverAppSubmissions.companyId, ctx.companyId), eq(driverAppSubmissions.driverId, ctx.driverId), eq(driverAppSubmissions.kind, 'company_expense'), ...(onlyIds ? [inArray(driverAppSubmissions.targetId, onlyIds)] : [])))
      .orderBy(desc(driverAppSubmissions.createdAt));
    if (pointers.length === 0) return [];
    const rows = await this.db
      .select()
      .from(fleetExpenses)
      .where(and(eq(fleetExpenses.companyId, ctx.companyId), inArray(fleetExpenses.id, pointers.map((p) => p.targetId))));
    const byId = new Map(rows.map((r) => [r.id, r]));
    return pointers.flatMap((p) => {
      const row = byId.get(p.targetId);
      if (!row) return [];
      const d = p.detail as { category?: ReimbursementCategory; loadId?: string | null; loadNumber?: string | null; receiptFileId?: string; location?: DriverReimbursement['location'] };
      return [
        {
          id: row.id,
          number: row.reference,
          kind: 'company_expense' as const,
          category: d.category ?? 'other',
          amountCents: row.amountCents,
          reimbursableCents: 0,
          currency: 'USD' as const,
          date: String(row.expenseDate),
          state: 'company_expense' as const,
          stateLabel: DRIVER_REIMBURSEMENT_STATE_LABEL.company_expense,
          steps: [{ state: 'received' as const, label: DRIVER_REIMBURSEMENT_STATE_LABEL.received, reachedAt: p.createdAt.toISOString(), current: false }, { state: 'company_expense' as const, label: DRIVER_REIMBURSEMENT_STATE_LABEL.company_expense, reachedAt: p.createdAt.toISOString(), current: true }],
          rejectedReason: row.status === 'void' ? row.voidReason : null,
          reviewer: { name: 'Fleet' },
          settlement: null,
          load: d.loadId ? { id: d.loadId, loadNumber: d.loadNumber ?? null } : null,
          truckId: row.truckId || null,
          location: d.location ?? null,
          receiptFileId: d.receiptFileId ?? null,
          lastUpdate: row.updatedAt.toISOString(),
          createdAt: p.createdAt.toISOString(),
        },
      ];
    });
  }

  // =========================================================================== statements

  private visible(s: StatementRecord, driverId: string): boolean {
    return s.partyType === 'driver' && s.partyId === driverId && (s.status === 'approved' || s.status === 'paid');
  }

  async mySettlements(principal: Principal, week: string | undefined): Promise<DriverSettlementList> {
    const ctx = await this.context.resolve(principal);
    if (week && !/^\d{4}-\d{2}-\d{2}$/.test(week)) throw unprocessable('week must be a day, YYYY-MM-DD');
    const rows = (await this.settlements.statements(principal, { partyId: ctx.driverId }))
      .filter((s) => this.visible(s, ctx.driverId))
      .filter((s) => !week || (s.periodStart <= week && s.periodEnd >= week))
      .sort((a, b) => b.periodStart.localeCompare(a.periodStart));
    return { settlements: rows.map((s) => this.summary(s)) };
  }

  async mySettlement(principal: Principal, id: string): Promise<DriverSettlementDetail> {
    const s = await this.own(principal, id);
    const c = s.computation;
    return {
      ...this.summary(s),
      earnings: (c?.earnings ?? []).filter((e) => e.kind !== 'reimbursement').map((e) => ({ loadNumber: e.loadNumber, description: e.description, amountCents: e.cents })),
      deductions: (c?.deductions ?? []).map((d) => ({ description: d.description, amountCents: d.cents })),
      reimbursements: (c?.earnings ?? []).filter((e) => e.kind === 'reimbursement').map((e) => ({ loadNumber: e.loadNumber, description: e.description, amountCents: e.cents })),
      carryCents: s.carryCents,
      escrowCents: c?.escrowCents ?? 0,
      loadCount: c?.loadCount ?? 0,
      totalMiles: c?.totalMiles ?? 0,
      notes: c?.notes ?? [],
    };
  }

  async mySettlementPdf(principal: Principal, id: string): Promise<{ pdf: Buffer; fileName: string }> {
    const s = await this.own(principal, id);
    return this.pdfs.render(principal, s);
  }

  private async own(principal: Principal, id: string): Promise<StatementRecord> {
    const ctx = await this.context.resolve(principal);
    const s = (await this.settlements.statements(principal, { partyId: ctx.driverId })).find((r) => r.id === id || r.settlementNumber === id);
    if (!s || !this.visible(s, ctx.driverId)) throw notFound('statement');
    return s;
  }

  private summary(s: StatementRecord): DriverSettlementSummary {
    const c = s.computation;
    const paid = s.status === 'paid';
    return {
      id: s.id,
      number: s.settlementNumber,
      periodStart: s.periodStart,
      periodEnd: s.periodEnd,
      payDate: s.payDate,
      state: paid ? 'paid' : 'finalized',
      stateLabel: paid ? 'Paid' : 'Finalized',
      grossCents: c?.grossCents ?? 0,
      reimbursementsCents: c?.reimbursementsCents ?? 0,
      deductionsCents: c?.deductionsCents ?? 0,
      netCents: s.netCents,
      payableCents: s.payableCents,
      paidAt: s.paidAt,
    };
  }
}
