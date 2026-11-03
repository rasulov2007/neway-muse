import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  COST_TYPES,
  COST_TYPE_LABELS,
  DEFAULT_ONBOARDING_TASKS,
  costTreatment,
  type CandidateCostRequest,
  type CandidateCostSummary,
  type CandidateCostView,
  type CostParty,
  type CostType,
  type OnboardingTaskStatus,
  type OnboardingTaskUpdateRequest,
  type OnboardingTaskView,
  type TravelItemRequest,
  type TravelItemView,
  type TravelKind,
  type TravelStatus,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { drivers } from '../../database/schema/roster';
import { employees } from '../../database/schema/people';
import {
  hiringCases,
  hiringCostEntries,
  hiringLeads,
  hiringOnboardingTasks,
  hiringTravelItems,
  type HiringCaseRow,
  type HiringCostEntryRow,
  type HiringOnboardingTaskRow,
  type HiringTravelItemRow,
} from '../../database/schema/hiring';
import { DriverAccountsService } from '../accounting/driver-accounts.service';
import { AuditService } from '../people/audit.service';
import { CostLedgerService } from './cost-ledger.service';
import { HiringService } from './hiring.service';

const num = (v: string | null | undefined) => (v === null || v === undefined ? 0 : Number(v));
const conflict = (detail: string) => new AppError({ status: 409, title: 'Conflict', detail });
const STALE = 'Someone else changed this. Reload and try again.';
const CLOSED = ['disqualified', 'withdrawn', 'no_show', 'declined_offer'];

/**
 * Onboarding, travel and costs (step 7, owner brief 2026-10-11).
 *
 * The checklist starts with the company's standard tasks (documents verified, drug test, previous
 * employer checks, orientation, arrival); each has a status, an owner, a due date and its
 * evidence. Travel is one row per booking (flight, hotel, ground), booked → rescheduled →
 * cancelled; a cancelled booking keeps its costs, refund and non-refundable fee.
 *
 * Costs reuse the candidate cost ledger and Accounting's own services — no second ledger.
 * Booking, approval and payment are separate: a booked flight is not an approved cost, and an
 * approved cost is not a paid one. Where a cost goes follows who paid and whose cost it is:
 * the company's own cost becomes one recruiting expense once approved (whoever paid it — a
 * driver who paid it is owed a reimbursement, paid only when that payment is recorded); a
 * company-paid cost the driver owes becomes a driver charge only with the driver's recorded
 * agreement and approval, once the driver is on the roster; the driver's own cost is recorded
 * and nothing is posted. Withdrawal, rejection or hire never delete a cost.
 */
@Injectable()
export class CandidateOnboardingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly ledger: CostLedgerService,
    private readonly driverAccounts: DriverAccountsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async live(principal: Principal, caseId: string | null): Promise<HiringCaseRow> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const c = await this.hiring.row(principal, caseId);
    if (CLOSED.includes(c.state)) throw conflict('This candidate is no longer in the hiring pipeline.');
    return c;
  }

  private by(principal: Principal) {
    return principal.userName ?? principal.userId;
  }

  // =============================================================================== checklist

  private taskView(t: HiringOnboardingTaskRow): OnboardingTaskView {
    return {
      id: t.id,
      code: t.code,
      label: t.label,
      required: t.required,
      status: t.status as OnboardingTaskStatus,
      ownerEmployeeId: t.ownerEmployeeId,
      ownerName: t.ownerName,
      dueOn: t.dueOn,
      completedAt: t.completedAt?.toISOString() ?? null,
      completedByName: t.completedByName,
      result: t.result,
      evidenceDocumentId: t.evidenceDocumentId,
      evidenceFileId: t.evidenceFileId,
      note: t.note,
      version: t.version,
    };
  }

  async tasks(companyId: string, caseId: string | null): Promise<OnboardingTaskView[]> {
    if (!caseId) return [];
    const rows = await this.db
      .select()
      .from(hiringOnboardingTasks)
      .where(and(eq(hiringOnboardingTasks.companyId, companyId), eq(hiringOnboardingTasks.hiringCaseId, caseId)))
      .orderBy(asc(hiringOnboardingTasks.sort), asc(hiringOnboardingTasks.createdAt));
    return rows.map((t) => this.taskView(t));
  }

  /**
   * Start onboarding (step 6 → 7): once the application was reviewed. Opens the standard checklist
   * once; starting again changes nothing.
   */
  async start(principal: Principal, caseId: string | null): Promise<void> {
    const c = await this.live(principal, caseId);
    if (!c.applicationReviewedAt) throw conflict('Review the application before starting onboarding.');
    await this.hiring.withLock(`candidate-onboarding:${c.id}`, async () => {
      const fresh = await this.hiring.row(principal, c.id);
      if (fresh.onboardingStartedAt) return;
      const at = new Date();
      const by = this.by(principal);
      const event = await this.db.transaction(async (tx) => {
        for (const [i, t] of DEFAULT_ONBOARDING_TASKS.entries()) {
          await tx
            .insert(hiringOnboardingTasks)
            .values({ id: `hot_${crypto.randomUUID()}`, companyId: principal.companyId, hiringCaseId: c.id, code: t.code, label: t.label, required: t.required, sort: i * 10, createdAt: at, updatedAt: at })
            .onConflictDoNothing();
        }
        await tx.update(hiringCases).set({ onboardingStartedAt: at, onboardingStartedBy: by, updatedAt: at }).where(eq(hiringCases.id, c.id));
        return this.audit.writeIn(tx, principal, {
          action: 'onboarding_started',
          entityType: 'hiring_case',
          entityId: c.id,
          entityLabel: c.candidateName,
          summary: 'Onboarding started: the standard checklist was opened',
          at,
        });
      });
      await this.audit.publish(event);
    });
  }

  async addTask(principal: Principal, caseId: string | null, input: { label: string; required: boolean; dueOn: string | null }): Promise<OnboardingTaskView> {
    const c = await this.live(principal, caseId);
    if (!c.onboardingStartedAt) throw conflict('Start onboarding first.');
    const id = `hot_${crypto.randomUUID()}`;
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      await tx.insert(hiringOnboardingTasks).values({
        id,
        companyId: principal.companyId,
        hiringCaseId: c.id,
        code: `custom_${id.slice(4, 12)}`,
        label: input.label,
        required: input.required,
        dueOn: input.dueOn,
        sort: 1000,
        createdAt: at,
        updatedAt: at,
      });
      return this.audit.writeIn(tx, principal, {
        action: 'onboarding_task_added',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `Onboarding task added: ${input.label}${input.required ? ' (required)' : ''}`,
        at,
      });
    });
    await this.audit.publish(event);
    const [row] = await this.db.select().from(hiringOnboardingTasks).where(eq(hiringOnboardingTasks.id, id)).limit(1);
    return this.taskView(row as HiringOnboardingTaskRow);
  }

  /** One task's status, owner, due date, outcome and evidence. Version-checked; audited. */
  async updateTask(principal: Principal, caseId: string | null, taskId: string, input: OnboardingTaskUpdateRequest): Promise<OnboardingTaskView> {
    const c = await this.live(principal, caseId);
    const [t] = await this.db
      .select()
      .from(hiringOnboardingTasks)
      .where(and(eq(hiringOnboardingTasks.companyId, principal.companyId), eq(hiringOnboardingTasks.hiringCaseId, c.id), eq(hiringOnboardingTasks.id, taskId)))
      .limit(1);
    if (!t) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such task.' });
    if (t.version !== input.version) throw conflict(STALE);
    if (input.status === 'waived' && !input.note) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Say why the task is waived.' });
    if (t.code === 'drug_test' && input.status === 'done' && !input.result) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Record the drug test result (for example Negative).' });
    }
    let ownerName = t.ownerName;
    if (input.ownerEmployeeId !== t.ownerEmployeeId) {
      ownerName = null;
      if (input.ownerEmployeeId) {
        const [e] = await this.db
          .select({ first: employees.firstName, last: employees.lastName })
          .from(employees)
          .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, input.ownerEmployeeId)))
          .limit(1);
        if (!e) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'No such employee for the owner.' });
        ownerName = `${e.first} ${e.last}`.trim();
      }
    }
    const at = new Date();
    const closing = input.status === 'done' || input.status === 'failed' || input.status === 'waived';
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringOnboardingTasks)
        .set({
          status: input.status,
          ownerEmployeeId: input.ownerEmployeeId,
          ownerName,
          dueOn: input.dueOn,
          result: input.result,
          note: input.note,
          evidenceFileId: input.evidenceFileId,
          completedAt: closing ? (t.completedAt ?? at) : null,
          completedByName: closing ? (t.completedByName ?? this.by(principal)) : null,
          version: t.version + 1,
          updatedAt: at,
        })
        .where(and(eq(hiringOnboardingTasks.id, t.id), eq(hiringOnboardingTasks.version, t.version)))
        .returning({ id: hiringOnboardingTasks.id });
      if (!done) throw conflict(STALE);
      return this.audit.writeIn(tx, principal, {
        action: 'onboarding_task_updated',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `${t.label}: ${input.status.replace(/_/g, ' ')}${input.result ? ` (${input.result})` : ''}${input.note ? ` — ${input.note}` : ''}`,
        changes: [
          { field: 'status', old: t.status, new: input.status },
          ...(input.result !== t.result ? [{ field: 'result', old: t.result, new: input.result }] : []),
          ...(input.ownerEmployeeId !== t.ownerEmployeeId ? [{ field: 'owner', old: t.ownerName, new: ownerName }] : []),
        ],
        at,
      });
    });
    await this.audit.publish(event);
    const [row] = await this.db.select().from(hiringOnboardingTasks).where(eq(hiringOnboardingTasks.id, t.id)).limit(1);
    return this.taskView(row as HiringOnboardingTaskRow);
  }

  // ================================================================================== travel

  private travelView(t: HiringTravelItemRow, cost: number | null = null): TravelItemView {
    return {
      cost,
      id: t.id,
      kind: t.kind as TravelKind,
      status: t.status as TravelStatus,
      vendor: t.vendor,
      routeFrom: t.routeFrom,
      routeTo: t.routeTo,
      bookingReference: t.bookingReference,
      departAt: t.departAt?.toISOString() ?? null,
      arriveAt: t.arriveAt?.toISOString() ?? null,
      checkInOn: t.checkInOn,
      checkOutOn: t.checkOutOn,
      notes: t.notes,
      confirmationFileId: t.confirmationFileId,
      cancelledAt: t.cancelledAt?.toISOString() ?? null,
      cancelReason: t.cancelReason,
      createdByName: t.createdByName,
      createdAt: t.createdAt.toISOString(),
      version: t.version,
    };
  }

  async travel(companyId: string, caseId: string | null): Promise<TravelItemView[]> {
    if (!caseId) return [];
    const rows = await this.db
      .select()
      .from(hiringTravelItems)
      .where(and(eq(hiringTravelItems.companyId, companyId), eq(hiringTravelItems.hiringCaseId, caseId)))
      .orderBy(asc(hiringTravelItems.departAt), asc(hiringTravelItems.createdAt));
    const costs = await this.db
      .select({ travelItemId: hiringCostEntries.travelItemId, amount: hiringCostEntries.amount, refund: hiringCostEntries.refundAmount, approval: hiringCostEntries.approvalStatus })
      .from(hiringCostEntries)
      .where(and(eq(hiringCostEntries.companyId, companyId), eq(hiringCostEntries.hiringCaseId, caseId), isNull(hiringCostEntries.voidedAt)));
    return rows.map((t) => {
      const mine = costs.filter((x) => x.travelItemId === t.id && x.approval !== 'rejected');
      return this.travelView(t, mine.length ? mine.reduce((sum, x) => sum + Math.max(0, Number(x.amount) - Number(x.refund ?? 0)), 0) : null);
    });
  }

  private checkTravel(input: { departAt: string | null; arriveAt: string | null; checkInOn: string | null; checkOutOn: string | null }) {
    if (input.departAt && input.arriveAt && input.arriveAt < input.departAt) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Arrival is before departure.' });
    }
    if (input.checkInOn && input.checkOutOn && input.checkOutOn < input.checkInOn) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Check-out is before check-in.' });
    }
  }

  async addTravel(principal: Principal, caseId: string | null, input: TravelItemRequest): Promise<TravelItemView> {
    const c = await this.live(principal, caseId);
    this.checkTravel(input);
    const id = `htv_${crypto.randomUUID()}`;
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      await tx.insert(hiringTravelItems).values({
        id,
        companyId: principal.companyId,
        hiringCaseId: c.id,
        kind: input.kind,
        status: 'booked',
        vendor: input.vendor,
        routeFrom: input.routeFrom,
        routeTo: input.routeTo,
        bookingReference: input.bookingReference,
        departAt: input.departAt ? new Date(input.departAt) : null,
        arriveAt: input.arriveAt ? new Date(input.arriveAt) : null,
        checkInOn: input.checkInOn,
        checkOutOn: input.checkOutOn,
        notes: input.notes,
        confirmationFileId: input.confirmationFileId,
        createdByName: this.by(principal),
        createdAt: at,
        updatedAt: at,
      });
      return this.audit.writeIn(tx, principal, {
        action: 'travel_booked',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `${input.kind} booked${input.vendor ? ` with ${input.vendor}` : ''}${input.routeFrom || input.routeTo ? ` · ${input.routeFrom ?? '?'} → ${input.routeTo ?? '?'}` : ''}${input.bookingReference ? ` · ${input.bookingReference}` : ''}`,
        changes: [{ field: 'travel_item', old: null, new: id }],
        at,
      });
    });
    await this.audit.publish(event);
    // The price, when given, is what this booking cost: recorded now as a spent cost on it.
    if (input.price) {
      await this.addCost(principal, c.id, {
        type: input.kind === 'hotel' ? 'lodging' : 'travel',
        amount: input.price,
        incurredOn: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }),
        vendor: input.vendor,
        paidBy: input.paidBy,
        costOwner: 'company',
        approvalStatus: 'approved',
        travelItemId: id,
        receiptFileId: null,
        driverAgreementNote: null,
        note: input.bookingReference ? `Booking ${input.bookingReference}` : null,
      });
    }
    const [row] = await this.db.select().from(hiringTravelItems).where(eq(hiringTravelItems.id, id)).limit(1);
    return this.travelView(row as HiringTravelItemRow, input.price);
  }

  private async travelRow(principal: Principal, caseId: string, id: string): Promise<HiringTravelItemRow> {
    const [t] = await this.db
      .select()
      .from(hiringTravelItems)
      .where(and(eq(hiringTravelItems.companyId, principal.companyId), eq(hiringTravelItems.hiringCaseId, caseId), eq(hiringTravelItems.id, id)))
      .limit(1);
    if (!t) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such booking.' });
    return t;
  }

  /** A change of plans: the booking is updated and marked Rescheduled; its history stays in the audit. */
  async updateTravel(principal: Principal, caseId: string | null, id: string, input: Omit<TravelItemRequest, 'kind'> & { status: 'booked' | 'rescheduled'; version: number }): Promise<TravelItemView> {
    const c = await this.live(principal, caseId);
    const t = await this.travelRow(principal, c.id, id);
    if (t.status === 'cancelled') throw conflict('A cancelled booking cannot change; book a new one.');
    if (t.version !== input.version) throw conflict(STALE);
    this.checkTravel(input);
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringTravelItems)
        .set({
          status: input.status,
          vendor: input.vendor,
          routeFrom: input.routeFrom,
          routeTo: input.routeTo,
          bookingReference: input.bookingReference,
          departAt: input.departAt ? new Date(input.departAt) : null,
          arriveAt: input.arriveAt ? new Date(input.arriveAt) : null,
          checkInOn: input.checkInOn,
          checkOutOn: input.checkOutOn,
          notes: input.notes,
          confirmationFileId: input.confirmationFileId,
          updatedByName: this.by(principal),
          version: t.version + 1,
          updatedAt: at,
        })
        .where(and(eq(hiringTravelItems.id, t.id), eq(hiringTravelItems.version, t.version)))
        .returning({ id: hiringTravelItems.id });
      if (!done) throw conflict(STALE);
      return this.audit.writeIn(tx, principal, {
        action: 'travel_updated',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `${t.kind} ${input.status === 'rescheduled' ? 'rescheduled' : 'updated'}${input.bookingReference ? ` · ${input.bookingReference}` : ''}`,
        changes: [
          { field: 'status', old: t.status, new: input.status },
          { field: 'depart_at', old: t.departAt?.toISOString() ?? null, new: input.departAt },
          { field: 'arrive_at', old: t.arriveAt?.toISOString() ?? null, new: input.arriveAt },
        ],
        at,
      });
    });
    await this.audit.publish(event);
    return this.travelView(await this.travelRow(principal, c.id, id));
  }

  /** Cancelled, not deleted: the booking and every cost on it stay, with the refund and fees. */
  async cancelTravel(principal: Principal, caseId: string | null, id: string, reason: string, version: number): Promise<TravelItemView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const c = await this.hiring.row(principal, caseId);
    const t = await this.travelRow(principal, c.id, id);
    if (t.status === 'cancelled') return this.travelView(t);
    if (t.version !== version) throw conflict(STALE);
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringTravelItems)
        .set({ status: 'cancelled', cancelledAt: at, cancelReason: reason, updatedByName: this.by(principal), version: t.version + 1, updatedAt: at })
        .where(and(eq(hiringTravelItems.id, t.id), eq(hiringTravelItems.version, t.version)))
        .returning({ id: hiringTravelItems.id });
      if (!done) throw conflict(STALE);
      return this.audit.writeIn(tx, principal, {
        action: 'travel_cancelled',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `${t.kind} cancelled: ${reason}. Its costs are kept; record any refund on them.`,
        changes: [{ field: 'status', old: t.status, new: 'cancelled' }],
        at,
      });
    });
    await this.audit.publish(event);
    return this.travelView(await this.travelRow(principal, c.id, id));
  }

  // =================================================================================== costs

  private async costRows(companyId: string, caseId: string): Promise<HiringCostEntryRow[]> {
    const [lead] = await this.db.select({ id: hiringLeads.id }).from(hiringLeads).where(and(eq(hiringLeads.companyId, companyId), eq(hiringLeads.hiringCaseId, caseId))).limit(1);
    return this.db
      .select()
      .from(hiringCostEntries)
      .where(
        and(
          eq(hiringCostEntries.companyId, companyId),
          lead ? sql`(${hiringCostEntries.hiringCaseId} = ${caseId} or ${hiringCostEntries.leadId} = ${lead.id})` : eq(hiringCostEntries.hiringCaseId, caseId),
        ),
      )
      .orderBy(desc(hiringCostEntries.incurredOn), desc(hiringCostEntries.createdAt));
  }

  private costView(r: HiringCostEntryRow): CandidateCostView {
    const paidBy = r.paidBy as CostParty;
    const costOwner = r.costOwner as CostParty;
    const treatment = costTreatment(paidBy, costOwner);
    let accounting: CandidateCostView['accounting'];
    if (treatment === 'personal') accounting = { state: 'none_needed', note: "The driver's own cost; the company pays nothing." };
    else if (treatment === 'driver_charge') {
      accounting = r.driverTransactionId
        ? { state: 'driver_charge', note: 'Charged to the driver account.' }
        : !r.driverAgreementAt
          ? { state: 'waiting_agreement', note: "Needs the driver's recorded agreement before it can be charged." }
          : { state: 'not_posted', note: r.approvalStatus === 'approved' ? 'Charged to the driver once they are on the roster.' : 'Waiting for approval.' };
    } else if (r.source !== 'manual') {
      // An automatic screening estimate (MVR, PSP, Clearinghouse at the configured price): it counts
      // toward cost per hire but is not an Accounting expense.
      accounting = { state: 'none_needed', note: 'Estimate from the screening price — Enter actual price replaces it. Not an Accounting expense.' };
    } else if (r.accountingPostedAt && r.accountingExpenseId) accounting = { state: treatment === 'reimbursement' ? 'reimbursement' : 'posted', note: r.accountingPostNote ?? (treatment === 'reimbursement' ? 'In Accounting; reimbursement owed to the driver.' : 'Posted to Accounting.') };
    else accounting = { state: 'not_posted', note: r.accountingPostNote ?? (r.approvalStatus === 'approved' ? 'Waiting for someone who can post to Accounting.' : 'Posted once approved.') };
    return {
      id: r.id,
      type: r.type,
      label: COST_TYPE_LABELS[r.type as CostType] ?? r.type.replace(/_/g, ' '),
      amount: num(r.amount),
      refundAmount: num(r.refundAmount),
      nonrefundableFee: r.nonrefundableFee === null ? null : num(r.nonrefundableFee),
      incurredOn: r.incurredOn,
      vendor: r.vendor,
      paidBy,
      costOwner,
      treatment,
      approvalStatus: r.approvalStatus as CandidateCostView['approvalStatus'],
      approvedAt: r.approvedAt?.toISOString() ?? null,
      approvedBy: r.approvedBy,
      paymentStatus: r.paymentStatus as 'unpaid' | 'paid',
      paidAt: r.paidAt?.toISOString() ?? null,
      accounting,
      travelItemId: r.travelItemId,
      receiptFileId: r.receiptFileId,
      driverAgreementNote: r.driverAgreementNote,
      note: r.note,
      source: r.source,
      voided: Boolean(r.voidedAt),
      version: r.version,
    };
  }

  async costs(companyId: string, caseId: string | null): Promise<{ entries: CandidateCostView[]; summary: CandidateCostSummary }> {
    const summary: CandidateCostSummary = { spent: 0, planned: 0, approved: 0, paid: 0, companyCost: 0, driverCost: 0 };
    if (!caseId) return { entries: [], summary };
    const entries = (await this.costRows(companyId, caseId)).map((r) => this.costView(r));
    for (const e of entries) {
      if (e.voided || e.approvalStatus === 'rejected') continue;
      // What it actually cost: the amount less any refund.
      const net = Math.max(0, e.amount - e.refundAmount);
      if (e.approvalStatus === 'planned') summary.planned += net;
      else {
        summary.approved += net;
        summary.spent += net;
      }
      if (e.paymentStatus === 'paid') summary.paid += net;
      if (e.costOwner === 'company') summary.companyCost += net;
      else summary.driverCost += net;
    }
    const round = (v: number) => Math.round(v * 100) / 100;
    return { entries, summary: { spent: round(summary.spent), planned: round(summary.planned), approved: round(summary.approved), paid: round(summary.paid), companyCost: round(summary.companyCost), driverCost: round(summary.driverCost) } };
  }

  private async costRow(principal: Principal, caseId: string, id: string): Promise<HiringCostEntryRow> {
    const rows = await this.costRows(principal.companyId, caseId);
    const r = rows.find((x) => x.id === id);
    if (!r) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such cost on this candidate.' });
    return r;
  }

  /**
   * A cost on the candidate. Saved through the cost ledger (its retry key, receipt check and audit),
   * then marked with who paid and whose cost it is. Posting follows approval, never booking.
   */
  async addCost(principal: Principal, caseId: string | null, input: CandidateCostRequest & { clientKey?: string | null }): Promise<CandidateCostView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const c = await this.hiring.row(principal, caseId);
    if (!(COST_TYPES as readonly string[]).includes(input.type)) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Choose a cost category.' });
    if (costTreatment(input.paidBy, input.costOwner) === 'driver_charge' && input.approvalStatus === 'approved' && !input.driverAgreementNote) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: "A cost the driver owes needs the driver's recorded agreement before it is approved." });
    }
    if (input.travelItemId) await this.travelRow(principal, c.id, input.travelItemId);
    // Saved planned first so nothing posts before the new columns say where it belongs.
    const entry = await this.ledger.createForJourney(principal, {
      hiringCaseId: c.id,
      leadId: null,
      campaignId: null,
      type: input.type as CostType,
      amount: input.amount,
      incurredOn: input.incurredOn,
      note: input.note,
      clientKey: input.clientKey ?? null,
      receiptFileId: input.receiptFileId,
      accountingExpenseId: null,
      paidBy: input.paidBy,
      costOwner: input.costOwner,
      vendor: input.vendor,
      approvalStatus: input.approvalStatus,
      approvedBy: input.approvalStatus === 'approved' ? this.by(principal) : null,
      travelItemId: input.travelItemId,
      driverAgreementNote: input.driverAgreementNote,
    });
    await this.replaceEstimates(principal, c, input.type);
    return this.costView(await this.costRow(principal, c.id, entry.id));
  }

  /**
   * The actual price of a screening (MVR, PSP, Clearinghouse, drug test) replaces its automatic
   * estimate, so the candidate's cost is counted once (owner, 2026-10-12). The estimate is voided
   * with the reason, never deleted.
   */
  private async replaceEstimates(principal: Principal, c: { id: string; candidateName: string }, type: string): Promise<void> {
    if (!['mvr', 'psp', 'clearinghouse', 'drug_test', 'background_check'].includes(type)) return;
    const at = new Date();
    const by = this.by(principal);
    const replaced = await this.db
      .update(hiringCostEntries)
      .set({ voidedAt: at, voidedBy: by, voidReason: 'Replaced by the actual cost entered by hand' })
      .where(
        and(
          eq(hiringCostEntries.companyId, principal.companyId),
          eq(hiringCostEntries.hiringCaseId, c.id),
          eq(hiringCostEntries.type, type),
          eq(hiringCostEntries.source, 'auto'),
          isNull(hiringCostEntries.voidedAt),
        ),
      )
      .returning({ id: hiringCostEntries.id, amount: hiringCostEntries.amount });
    for (const r of replaced) {
      await this.audit.write(principal, {
        action: 'cost_estimate_replaced',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `${type.toUpperCase()} estimate of $${Number(r.amount).toFixed(2)} replaced by the actual cost`,
        changes: [{ field: 'cost_entry', old: r.id, new: 'void' }],
        at,
      });
    }
  }

  private async changeCost(
    principal: Principal,
    caseId: string,
    id: string,
    version: number,
    patch: Partial<typeof hiringCostEntries.$inferInsert>,
    audit: { summary: string; changes: { field: string; old: string | null; new: string | null }[] },
  ): Promise<HiringCostEntryRow> {
    const r = await this.costRow(principal, caseId, id);
    if (r.version !== version) throw conflict(STALE);
    if (r.voidedAt) throw conflict('This cost is voided.');
    const at = new Date();
    const c = await this.hiring.row(principal, caseId);
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringCostEntries)
        .set({ ...patch, version: r.version + 1 })
        .where(and(eq(hiringCostEntries.id, r.id), eq(hiringCostEntries.version, r.version)))
        .returning({ id: hiringCostEntries.id });
      if (!done) throw conflict(STALE);
      return this.audit.writeIn(tx, principal, { action: 'update', entityType: 'hiring_case', entityId: caseId, entityLabel: c.candidateName, ...audit, at });
    });
    await this.audit.publish(event);
    return this.costRow(principal, caseId, id);
  }

  /** Approve or reject. Approval books it where it belongs (expense, or a driver charge at hire). */
  async decideCost(principal: Principal, caseId: string | null, id: string, input: { decision: 'approved' | 'rejected'; note: string | null; version: number }): Promise<CandidateCostView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const r = await this.costRow(principal, caseId, id);
    const treatment = costTreatment(r.paidBy as CostParty, r.costOwner as CostParty);
    if (input.decision === 'approved' && treatment === 'driver_charge' && !r.driverAgreementAt) {
      throw conflict("Record the driver's agreement before approving a cost the driver owes.");
    }
    if (r.approvalStatus === input.decision) return this.costView(r);
    const label = COST_TYPE_LABELS[r.type as CostType] ?? r.type;
    await this.changeCost(principal, caseId, id, input.version, { approvalStatus: input.decision, approvedAt: new Date(), approvedBy: this.by(principal) }, {
      summary: `Cost ${input.decision}: ${label} $${num(r.amount).toFixed(2)}${input.note ? ` — ${input.note}` : ''}`,
      changes: [{ field: 'approval_status', old: r.approvalStatus, new: input.decision }],
    });
    await this.ledger.resync(principal, id);
    if (input.decision === 'approved' && treatment === 'driver_charge') await this.chargeDriverIfOnRoster(principal, caseId, id);
    return this.costView(await this.costRow(principal, caseId, id));
  }

  /** The driver agreed to owe this cost; the agreement is kept with the cost. */
  async recordAgreement(principal: Principal, caseId: string | null, id: string, note: string, version: number): Promise<CandidateCostView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    await this.changeCost(principal, caseId, id, version, { driverAgreementNote: note, driverAgreementAt: new Date() }, {
      summary: `Driver agreed to repay a cost: ${note}`,
      changes: [{ field: 'driver_agreement', old: null, new: note }],
    });
    return this.costView(await this.costRow(principal, caseId, id));
  }

  /** Paid — only when the payment itself is recorded (a reimbursement is not paid by being approved). */
  async recordPayment(principal: Principal, caseId: string | null, id: string, paidOn: string, note: string | null, version: number): Promise<CandidateCostView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const r = await this.costRow(principal, caseId, id);
    if (r.approvalStatus !== 'approved') throw conflict('Approve the cost before recording its payment.');
    if (r.paymentStatus === 'paid') return this.costView(r);
    const treatment = costTreatment(r.paidBy as CostParty, r.costOwner as CostParty);
    if (treatment === 'personal') throw conflict("The driver's own cost has no company payment to record.");
    if (r.source !== 'manual') throw conflict('An automatic estimate has no payment to record; record the real invoice as a cost.');
    await this.changeCost(principal, caseId, id, version, { paymentStatus: 'paid', paidAt: new Date(`${paidOn}T12:00:00Z`) }, {
      summary: `${treatment === 'reimbursement' ? 'Reimbursement paid to the driver' : 'Payment recorded'} on ${paidOn}${note ? ` — ${note}` : ''}`,
      changes: [{ field: 'payment_status', old: 'unpaid', new: 'paid' }],
    });
    return this.costView(await this.costRow(principal, caseId, id));
  }

  /** A refund or a non-refundable fee on a cancelled booking: the original amount stays as it was. */
  async recordRefund(principal: Principal, caseId: string | null, id: string, input: { refundAmount: number; nonrefundableFee: number | null; note: string | null; version: number }): Promise<CandidateCostView> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const r = await this.costRow(principal, caseId, id);
    if (input.refundAmount > num(r.amount)) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The refund is more than the cost.' });
    await this.changeCost(principal, caseId, id, input.version, { refundAmount: String(input.refundAmount), nonrefundableFee: input.nonrefundableFee === null ? null : String(input.nonrefundableFee) }, {
      summary: `Refund $${input.refundAmount.toFixed(2)}${input.nonrefundableFee !== null ? `, non-refundable fee $${input.nonrefundableFee.toFixed(2)}` : ''}${input.note ? ` — ${input.note}` : ''}`,
      changes: [{ field: 'refund_amount', old: r.refundAmount, new: String(input.refundAmount) }],
    });
    return this.costView(await this.costRow(principal, caseId, id));
  }

  /**
   * A cost the driver owes, approved with their agreement, becomes one driver charge — once the
   * driver is on the roster (the account is the driver's). Idempotent: the charge id is kept on the
   * cost, and the charge's own key refuses a second copy.
   */
  async chargeDriverIfOnRoster(principal: Principal, caseId: string, id: string): Promise<void> {
    if (!hasPermission(principal, 'accounting.edit')) return;
    const r = await this.costRow(principal, caseId, id);
    if (r.driverTransactionId || r.voidedAt || r.approvalStatus !== 'approved' || !r.driverAgreementAt) return;
    if (costTreatment(r.paidBy as CostParty, r.costOwner as CostParty) !== 'driver_charge') return;
    const c = await this.hiring.row(principal, caseId);
    if (!c.driverId) return;
    const [onRoster] = await this.db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, c.driverId))).limit(1);
    if (!onRoster) return;
    const net = Math.max(0, num(r.amount) - num(r.refundAmount));
    if (net <= 0) return;
    const tx = await this.driverAccounts.manualCharge(principal, c.driverId, {
      kind: 'manual_charge',
      amountCents: Math.round(net * 100),
      onDate: r.incurredOn,
      description: `Recruiting · ${COST_TYPE_LABELS[r.type as CostType] ?? r.type} (cost ${r.id})`,
      reason: `Agreed by the driver: ${r.driverAgreementNote ?? ''}`.trim(),
      approvalRequired: false,
    });
    await this.db.update(hiringCostEntries).set({ driverTransactionId: tx.id }).where(and(eq(hiringCostEntries.id, r.id), isNull(hiringCostEntries.driverTransactionId)));
  }

  /** At hire: every approved, agreed driver charge that was waiting for the roster. */
  async chargePendingAtHire(principal: Principal, caseId: string): Promise<void> {
    const rows = await this.costRows(principal.companyId, caseId);
    for (const r of rows) {
      if (costTreatment(r.paidBy as CostParty, r.costOwner as CostParty) !== 'driver_charge') continue;
      await this.chargeDriverIfOnRoster(principal, caseId, r.id).catch(() => undefined);
    }
  }
}
