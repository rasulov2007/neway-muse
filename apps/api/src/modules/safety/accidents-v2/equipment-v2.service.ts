import { Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { CreateWorkOrderSchema, accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import type { Database } from '../../../database/client';
import { DatabaseService } from '../../../database/database.service';
import { acctBills } from '../../../database/schema/accounting';
import { accidentUnits, downtimePeriods, safetyTasks, safetyTimelineEvents, unitStatusHistory, workOrderEstimates } from '../../../database/schema/accidents-v2';
import { workOrderActions, workOrders } from '../../../database/schema/fleet';
import { safetyAccidents, safetyClaims, type SafetyAccidentRow } from '../../../database/schema/safety';
import { PayablesService } from '../../accounting/payables.service';
import { WorkOrdersService } from '../../fleet/work-orders.service';
import { AuditService, type AuditEvent } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';
import { AccidentsV2StateService } from './state.service';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
type WoRow = typeof workOrders.$inferSelect;

const ENTITY = 'safety_accident';
const WO_ENTITY = 'work_order';
const BILL_LEDGER_CATEGORY: Record<A.CaseBillCategory, string> = {
  Towing: 'maintenance',
  Storage: 'maintenance',
  'Transload / recovery': 'other',
  'Rental equipment': 'lease',
  Other: 'other',
};

/** Fleet rows can carry microseconds (defaultNow); a token read back as a JS Date has milliseconds. */
const sameInstant = (col: typeof workOrders.updatedAt, at: Date) => sql`date_trunc('milliseconds', ${col}) = ${at.toISOString()}::timestamptz`;

function forbidden(permission: string, detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, extensions: { permission } });
}
function invalid(path: string, message: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', type: '/problems/validation', detail: message, extensions: { errors: [{ path, message }] } });
}
function stale(label: string, at: Date): AppError {
  return new AppError({ status: 409, title: 'Conflict', type: '/problems/version-conflict', detail: `${label} was changed by someone else at ${at.toISOString()}. Reload it and make your change again.`, extensions: { currentUpdatedAt: at.toISOString() } });
}

/**
 * Equipment, work orders, downtime and money on an accident (Accident & Claims v2, phase P3; SPEC §6.4–6.6).
 *
 * Fleet owns the work order: it is opened and completed through Fleet's own service (one writer), and only Fleet's
 * people (accidents.fleet) add estimates, approve, start and complete. Accounting owns the bill: it is created through
 * the AP service. Safety never changes the Daily board: completing a repair ASKS Dispatch (a `unit_ready` request) and
 * only Dispatch's confirmation writes the unit's status history. A repair never touches the unit's condition at the scene.
 */
@Injectable()
export class EquipmentV2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
    private readonly state: AccidentsV2StateService,
    private readonly fleet: WorkOrdersService,
    private readonly payables: PayablesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private needFleet(p: Principal): void {
    if (!hasPermission(p, 'accidents.fleet')) throw forbidden('accidents.fleet', 'Fleet opens, approves and completes repair work orders');
  }

  private async accident(companyId: string, id: string): Promise<SafetyAccidentRow> {
    const [row] = await this.db.select().from(safetyAccidents).where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.id, id))).limit(1);
    if (!row || row.voidedAt) throw this.core.notFound('That accident');
    if (row.stage === 'draft') throw this.core.refused(`${row.number} is a draft; submit it first`);
    return row;
  }

  private async workOrder(companyId: string, id: string, token?: string): Promise<WoRow> {
    const [w] = await this.db.select().from(workOrders).where(and(eq(workOrders.companyId, companyId), eq(workOrders.id, id))).limit(1);
    if (!w || w.voidedAt) throw this.core.notFound('That work order');
    if (token && w.updatedAt.toISOString() !== new Date(token).toISOString()) throw stale(w.number, w.updatedAt);
    return w;
  }

  private async event(tx: Tx | Database, p: Principal, accidentId: string, text: string, at: Date, opts: { source?: R.EventSource; kind?: 'milestone' | 'change' | 'note' | 'task'; workOrderId?: string } = {}) {
    await tx.insert(safetyTimelineEvents).values({
      id: this.core.newId('evt'),
      companyId: p.companyId,
      accidentId,
      workOrderId: opts.workOrderId ?? null,
      occurredAt: at,
      loggedAt: at,
      actorId: p.userId,
      actorName: this.core.actor(p),
      source: opts.source ?? 'Fleet',
      kind: opts.kind ?? 'change',
      text,
    });
  }

  private async woAction(tx: Tx, p: Principal, workOrderId: string, note: string, at: Date) {
    await tx.insert(workOrderActions).values({ id: `woa_${at.getTime()}_${Math.random().toString(36).slice(2, 8)}`, workOrderId, action: 'note_added', stage: null, note, userId: p.userId, userName: p.userName ?? p.userId, createdAt: at });
  }

  /** Bumps the case version (a change under it moved) and writes the case audit row, in the caller's transaction. */
  private async touchCase(tx: Tx, p: Principal, acc: { id: string; number: string }, action: string, summary: string, at: Date, reason?: string | null): Promise<AuditEvent> {
    await tx.update(safetyAccidents).set({ updatedAt: at, version: sql`${safetyAccidents.version} + 1` }).where(eq(safetyAccidents.id, acc.id));
    return this.audit.writeIn(tx, p, { action, entityType: ENTITY, entityId: acc.id, entityLabel: acc.number, summary, changes: [], reason: reason ?? null, at });
  }

  private async unitRow(tx: Tx | Database, companyId: string, accidentId: string, kind: string, unitId: string) {
    const [u] = await tx
      .select()
      .from(accidentUnits)
      .where(and(eq(accidentUnits.companyId, companyId), eq(accidentUnits.accidentId, accidentId), eq(accidentUnits.unitKind, kind), eq(accidentUnits.unitId, unitId)))
      .limit(1);
    return u ?? null;
  }

  // ===================================================================================== work orders

  /** I1: Fleet opens an accident-repair work order for a unit on the case (through Fleet's own service), linked to it. */
  async createWorkOrder(p: Principal, accidentId: string, input: A.CreateCaseWorkOrderInput): Promise<A.WorkOrderView['id']> {
    this.needFleet(p);
    const acc = await this.accident(p.companyId, accidentId);
    if (acc.version !== input.version) throw stale(acc.number, acc.updatedAt);
    const unitId = input.unitKind === 'truck' ? acc.truckId : acc.trailerId;
    if (!unitId) throw invalid('unitKind', `${acc.number} has no ${input.unitKind} recorded`);
    if (!input.vendorId && !input.vendorName?.trim()) throw invalid('vendorId', 'Pick the shop');
    const created = await this.fleet.create(
      p,
      CreateWorkOrderSchema.parse({
        assetType: input.unitKind,
        unitId,
        status: 'in_shop',
        workType: 'accident_repair',
        shopStage: 'diagnosing',
        title: input.title?.trim() || `Accident repair — ${acc.number}`,
        ...(input.vendorId ? { vendorId: input.vendorId } : {}),
        ...(input.vendorName?.trim() ? { vendorName: input.vendorName.trim() } : {}),
        notes: `Opened from accident ${acc.number}`,
      }),
    );
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set({ accidentId: acc.id, estimatesRequired: 1, ...(input.eta ? { eta: new Date(input.eta) } : {}) }).where(eq(workOrders.id, created.id));
      const u = await this.unitRow(tx, p.companyId, acc.id, input.unitKind, unitId);
      if (u && !['returned', 'operational', 'total_loss', 'not_involved'].includes(u.status)) {
        await tx.update(accidentUnits).set({ status: 'at_shop', updatedAt: at, version: u.version + 1 }).where(eq(accidentUnits.id, u.id));
      }
      await this.event(tx, p, acc.id, `Work order ${created.number} opened at ${created.vendorName || input.vendorName || 'the shop'}`, at, { kind: 'milestone', workOrderId: created.id });
      audits.push(await this.touchCase(tx, p, acc, 'accident_work_order_opened', `Work order ${created.number} opened (${input.unitKind})`, at));
    });
    await this.audit.publish(...audits);
    return created.id;
  }

  /** The work-order page's accident banner (I5): is this an accident repair with no case, or which case is it on? */
  async accidentLink(p: Principal, woId: string): Promise<A.WorkOrderAccidentLink> {
    const w = await this.workOrder(p.companyId, woId);
    let accident: A.WorkOrderAccidentLink['accident'] = null;
    if (w.accidentId) {
      const [a] = await this.db.select({ id: safetyAccidents.id, number: safetyAccidents.number, voidedAt: safetyAccidents.voidedAt }).from(safetyAccidents).where(and(eq(safetyAccidents.companyId, p.companyId), eq(safetyAccidents.id, w.accidentId))).limit(1);
      if (a && !a.voidedAt) accident = { id: a.id, number: a.number };
    }
    return { workOrderId: w.id, number: w.number, accidentRepair: w.workType === 'accident_repair', accident, needsAccidentLink: w.workType === 'accident_repair' && !accident, updatedAt: w.updatedAt.toISOString() };
  }

  /** I5: an accident repair opened in Fleet without a case is linked to one (its attention item goes away). */
  async linkWorkOrder(p: Principal, woId: string, input: A.LinkWorkOrderInput): Promise<{ id: string; updatedAt: string }> {
    if (!hasPermission(p, 'accidents.fleet') && !hasPermission(p, 'accidents.edit')) throw forbidden('accidents.edit', 'Linking a work order to an accident is for Safety or Fleet');
    const acc = await this.accident(p.companyId, input.accidentId);
    const w = await this.workOrder(p.companyId, woId, input.updatedAt);
    if (w.accidentId) throw this.core.refused(`${w.number} is already linked to an accident`);
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set({ accidentId: acc.id, updatedAt: at }).where(and(eq(workOrders.id, woId), sameInstant(workOrders.updatedAt, w.updatedAt)));
      await this.woAction(tx, p, woId, `Linked to accident ${acc.number}`, at);
      await this.event(tx, p, acc.id, `Work order ${w.number} linked to the case`, at, { source: 'Safety', workOrderId: woId });
      audits.push(await this.touchCase(tx, p, acc, 'accident_work_order_linked', `Work order ${w.number} linked`, at));
    });
    await this.audit.publish(...audits);
    return { id: woId, updatedAt: at.toISOString() };
  }

  /** I2: an estimate; above the threshold the work order needs N estimates (never lowered). */
  async addEstimate(p: Principal, woId: string, input: A.AddEstimateInput): Promise<{ id: string; updatedAt: string; estimatesRequired: number }> {
    this.needFleet(p);
    const w = await this.workOrder(p.companyId, woId, input.updatedAt);
    if (w.status === 'completed') throw this.core.refused(`${w.number} is completed`);
    const st = await this.state.settings(p.companyId);
    const existing = await this.db.select().from(workOrderEstimates).where(and(eq(workOrderEstimates.companyId, p.companyId), eq(workOrderEstimates.workOrderId, woId)));
    const required = R.estimatesRequiredFor(
      { estimates: [...existing.map((e) => ({ id: e.id, vendor: e.vendor, amountCents: e.amountCents, at: e.receivedAt.toISOString() })), { id: 'new', vendor: input.vendor, amountCents: input.amountCents, at: '' }], estimatesRequired: w.estimatesRequired ?? 1 },
      st.rules,
    );
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.insert(workOrderEstimates).values({ id: this.core.newId('woe'), companyId: p.companyId, workOrderId: woId, vendor: input.vendor, amountCents: input.amountCents, receivedAt: at, fileId: input.fileId ?? null, createdBy: this.core.actor(p), createdAt: at });
      const upd = await tx
        .update(workOrders)
        .set({ estimatesRequired: required, updatedAt: at })
        .where(and(eq(workOrders.id, woId), sameInstant(workOrders.updatedAt, w.updatedAt)))
        .returning({ id: workOrders.id });
      if (!upd.length) throw stale(w.number, w.updatedAt);
      await this.woAction(tx, p, woId, `Estimate ${existing.length + 1}: ${input.vendor} ${R.money(input.amountCents)}${required > 1 ? ` (${required} required)` : ''}`, at);
      if (w.accidentId) {
        const [acc] = await tx.select({ id: safetyAccidents.id, number: safetyAccidents.number }).from(safetyAccidents).where(eq(safetyAccidents.id, w.accidentId)).limit(1);
        await this.event(tx, p, w.accidentId, `${w.number}: estimate ${existing.length + 1} — ${input.vendor} ${R.money(input.amountCents)}`, at, { workOrderId: woId });
        if (acc) audits.push(await this.touchCase(tx, p, acc, 'accident_estimate_added', `${w.number}: estimate ${input.vendor} ${R.money(input.amountCents)}`, at));
      } else {
        audits.push(await this.audit.writeIn(tx, p, { action: 'work_order_estimate_added', entityType: WO_ENTITY, entityId: woId, entityLabel: w.number, summary: `Estimate ${input.vendor} ${R.money(input.amountCents)}`, changes: [], at }));
      }
    });
    await this.audit.publish(...audits);
    return { id: woId, updatedAt: at.toISOString(), estimatesRequired: required };
  }

  /** I3: approve one estimate; with fewer estimates than required a policy-exception reason is mandatory (logged). */
  async approve(p: Principal, woId: string, input: A.ApproveEstimateInput): Promise<{ id: string; updatedAt: string }> {
    this.needFleet(p);
    const w = await this.workOrder(p.companyId, woId, input.updatedAt);
    if (w.status === 'completed') throw this.core.refused(`${w.number} is completed`);
    const estimates = await this.db.select().from(workOrderEstimates).where(and(eq(workOrderEstimates.companyId, p.companyId), eq(workOrderEstimates.workOrderId, woId)));
    const e = estimates.find((x) => x.id === input.estimateId);
    if (!e) throw this.core.notFound('That estimate');
    const required = w.estimatesRequired ?? 1;
    const exception = input.exceptionReason?.trim() || null;
    if (estimates.length < required && !exception) {
      throw invalid('exceptionReason', `${estimates.length} of ${required} required estimates received — give the policy-exception reason to approve now`);
    }
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.update(workOrderEstimates).set({ selected: false }).where(and(eq(workOrderEstimates.workOrderId, woId), eq(workOrderEstimates.selected, true)));
      await tx.update(workOrderEstimates).set({ selected: true }).where(eq(workOrderEstimates.id, e.id));
      const upd = await tx
        .update(workOrders)
        .set({
          approvedCents: e.amountCents,
          approvedEstimateId: e.id,
          approvedBy: this.core.actor(p),
          approvedAt: at,
          policyExceptionReason: estimates.length < required ? exception : null,
          ...(input.eta ? { eta: new Date(input.eta) } : {}),
          updatedAt: at,
        })
        .where(and(eq(workOrders.id, woId), sameInstant(workOrders.updatedAt, w.updatedAt)))
        .returning({ id: workOrders.id });
      if (!upd.length) throw stale(w.number, w.updatedAt);
      const text = `${w.number}: ${e.vendor} estimate ${R.money(e.amountCents)} approved${estimates.length < required ? ` — policy exception (${estimates.length} of ${required} estimates): ${exception}` : ''}`;
      await this.woAction(tx, p, woId, text, at);
      if (w.accidentId) {
        const [acc] = await tx.select({ id: safetyAccidents.id, number: safetyAccidents.number }).from(safetyAccidents).where(eq(safetyAccidents.id, w.accidentId)).limit(1);
        const u = await this.unitRow(tx, p.companyId, w.accidentId, w.assetType, w.unitId);
        if (u && !['returned', 'operational', 'total_loss', 'not_involved'].includes(u.status)) await tx.update(accidentUnits).set({ status: 'in_repair', updatedAt: at, version: u.version + 1 }).where(eq(accidentUnits.id, u.id));
        await this.event(tx, p, w.accidentId, text, at, { kind: 'milestone', workOrderId: woId });
        if (acc) audits.push(await this.touchCase(tx, p, acc, 'accident_estimate_approved', text, at, exception));
      } else {
        audits.push(await this.audit.writeIn(tx, p, { action: 'work_order_estimate_approved', entityType: WO_ENTITY, entityId: woId, entityLabel: w.number, summary: text, changes: [], reason: exception, at }));
      }
    });
    await this.audit.publish(...audits);
    return { id: woId, updatedAt: at.toISOString() };
  }

  async start(p: Principal, woId: string, input: A.StartRepairInput): Promise<{ id: string; updatedAt: string }> {
    this.needFleet(p);
    const w = await this.workOrder(p.companyId, woId, input.updatedAt);
    if (!w.approvedAt) throw this.core.refused(`Approve an estimate on ${w.number} first`);
    await this.fleet.changeStage(p, woId, { stage: 'in_repair', note: 'Repair started (accident case)' });
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    const [fresh] = await this.db.select({ updatedAt: workOrders.updatedAt }).from(workOrders).where(eq(workOrders.id, woId)).limit(1);
    if (w.accidentId) {
      await this.db.transaction(async (tx) => {
        const [acc] = await tx.select({ id: safetyAccidents.id, number: safetyAccidents.number }).from(safetyAccidents).where(eq(safetyAccidents.id, w.accidentId as string)).limit(1);
        await this.event(tx, p, w.accidentId as string, `${w.number}: repair started at ${w.vendorName || 'the shop'}`, at, { workOrderId: woId });
        if (acc) audits.push(await this.touchCase(tx, p, acc, 'accident_repair_started', `${w.number}: repair started`, at));
      });
    }
    await this.audit.publish(...audits);
    return { id: woId, updatedAt: (fresh?.updatedAt ?? at).toISOString() };
  }

  /**
   * I4 / H6-3 "Mark repaired": the invoice goes on the work order, Fleet completes it (its own service: downtime frozen,
   * service clocks reset), the unit on the case is Returned to service (its condition at the scene untouched), the open
   * downtime period of that unit closes at the completion, Dispatch is ASKED to mark it ready, the tasks linked to this
   * work order complete (never by title), and the AP bill is created through the AP service.
   */
  async complete(p: Principal, woId: string, input: A.CompleteRepairInput): Promise<A.CompleteRepairResponse> {
    this.needFleet(p);
    const w = await this.workOrder(p.companyId, woId, input.updatedAt);
    if (w.status === 'completed') throw this.core.refused(`${w.number} is already completed`);
    const at = this.core.now();
    const dollars = (input.invoiceTotalCents / 100).toFixed(2);
    await this.db.transaction(async (tx) => {
      const upd = await tx
        .update(workOrders)
        .set({ invoiceNumber: input.invoiceNumber, invoiceTotal: dollars, total: dollars, laborTotal: dollars, updatedAt: at })
        .where(and(eq(workOrders.id, woId), sameInstant(workOrders.updatedAt, w.updatedAt)))
        .returning({ id: workOrders.id });
      if (!upd.length) throw stale(w.number, w.updatedAt);
      await this.woAction(tx, p, woId, `Invoice ${input.invoiceNumber}: ${R.money(input.invoiceTotalCents, { cents: input.invoiceTotalCents % 100 !== 0 })} (entered on the accident case)`, at);
    });
    await this.fleet.complete(p, woId, { workDone: input.workDone?.trim() || w.title || 'Accident repair', completedAt: at.toISOString() });
    let readyRequestId: string | null = null;
    let tasksCompleted = 0;
    const audits: AuditEvent[] = [];
    if (w.accidentId) {
      const accidentId = w.accidentId;
      await this.db.transaction(async (tx) => {
        const [acc] = await tx.select().from(safetyAccidents).where(eq(safetyAccidents.id, accidentId)).limit(1);
        const u = await this.unitRow(tx, p.companyId, accidentId, w.assetType, w.unitId);
        if (u && u.status !== 'total_loss' && u.status !== 'not_involved') {
          // Returned to service; condition_at_scene is never written by a repair (SPEC §6.5).
          await tx.update(accidentUnits).set({ status: 'returned', returnedToServiceAt: at, updatedAt: at, version: u.version + 1 }).where(eq(accidentUnits.id, u.id));
        }
        await tx
          .update(downtimePeriods)
          .set({ endedAt: at, verifiedBy: this.core.actor(p), verifiedAt: at, updatedAt: at, version: sql`${downtimePeriods.version} + 1` })
          .where(and(eq(downtimePeriods.companyId, p.companyId), eq(downtimePeriods.accidentId, accidentId), eq(downtimePeriods.unitId, w.unitId), isNull(downtimePeriods.endedAt)));
        const done = await tx
          .update(safetyTasks)
          .set({ status: 'done', completedAt: at, completedBy: this.core.actor(p), updatedAt: at, version: sql`${safetyTasks.version} + 1` })
          .where(and(eq(safetyTasks.companyId, p.companyId), eq(safetyTasks.workOrderId, woId), sql`${safetyTasks.status} not in ('done','cancelled')`, isNull(safetyTasks.requestKind)))
          .returning({ id: safetyTasks.id });
        tasksCompleted = done.length;
        const unit = w.assetType === 'truck' ? `Truck ${w.unitNumber}` : `Trailer ${w.unitNumber}`;
        readyRequestId = this.core.newId('tsk');
        await tx.insert(safetyTasks).values({
          id: readyRequestId,
          companyId: p.companyId,
          accidentId,
          workOrderId: woId,
          title: `Mark ${unit} ready on the Daily board (${acc?.number ?? ''}) — confirm when done`,
          dept: 'Dispatch',
          dueAt: new Date(at.getTime() + 3 * R.HOUR),
          priority: 'high',
          autoRule: 'Repair completed',
          requestKind: 'unit_ready',
          requestPayload: { unitKind: w.assetType, unitId: w.unitId, unit: w.unitNumber, suggestedStatus: 'READY' },
          isTest: acc?.isTest ?? false,
          createdBy: this.core.actor(p),
          createdAt: at,
          updatedAt: at,
        });
        await this.event(tx, p, accidentId, `${w.number} completed — invoice ${R.money(input.invoiceTotalCents)}; ${unit} returned to service; Dispatch asked to mark it ready`, at, { kind: 'milestone', workOrderId: woId });
        if (acc) audits.push(await this.touchCase(tx, p, acc, 'accident_repair_completed', `${w.number} completed (invoice ${input.invoiceNumber}, ${R.money(input.invoiceTotalCents)})${tasksCompleted ? `; ${tasksCompleted} linked task(s) completed` : ''}`, at));
      });
    }
    await this.audit.publish(...audits);
    // The AP bill, through Accounting's own service (repair invoices reach AP only from the work order).
    let bill: A.CompleteRepairResponse['bill'] = null;
    let billWarning: string | null = null;
    try {
      const out = await this.payables.createBillsFromWorkOrders(p, [woId]);
      const made = out.created[0];
      if (made) {
        bill = { id: made.id, number: made.billNumber };
        if (w.accidentId) await this.db.update(acctBills).set({ accidentId: w.accidentId, accidentCostCategory: w.assetType === 'truck' ? 'Tractor repair' : 'Trailer repair' }).where(eq(acctBills.id, made.id));
        if (w.accidentId) await this.event(this.db, p, w.accidentId, `${made.billNumber} created from ${w.number} — awaiting AP approval`, this.core.now(), { source: 'Accounting', workOrderId: woId });
      } else billWarning = out.skipped[0]?.reason ?? 'No bill was created';
    } catch (error) {
      billWarning = error instanceof Error ? error.message : String(error);
    }
    return { workOrderId: woId, bill, billWarning, readyRequestId, tasksCompleted };
  }

  // ===================================================================================== downtime

  async verifyDowntime(p: Principal, id: string, input: A.VerifyDowntimeInput): Promise<{ id: string; version: number }> {
    this.needFleet(p);
    return this.downtimeWrite(p, id, input.version, 'accident_downtime_verified', (d, at) => ({ patch: { verifiedBy: this.core.actor(p), verifiedAt: at, ...(input.note ? { note: input.note } : {}) }, text: `Out-of-service period verified by Fleet${d.endedAt ? '' : ' (still open)'}` }));
  }

  async patchDowntime(p: Principal, id: string, input: A.PatchDowntimeInput): Promise<{ id: string; version: number }> {
    this.needFleet(p);
    return this.downtimeWrite(p, id, input.version, 'accident_downtime_corrected', (d, at) => {
      const started = input.startedAt ? new Date(input.startedAt) : d.startedAt;
      const ended = input.endedAt === undefined ? d.endedAt : input.endedAt ? new Date(input.endedAt) : null;
      if (ended && ended.getTime() <= started.getTime()) throw invalid('endedAt', 'The period ends before it starts');
      if (ended && ended.getTime() > at.getTime() + 5 * 60_000) throw invalid('endedAt', 'The period cannot end in the future');
      return {
        patch: { startedAt: started, endedAt: ended, verifiedBy: this.core.actor(p), verifiedAt: at, ...(input.note !== undefined ? { note: input.note } : {}) },
        text: `Out-of-service period corrected by Fleet: ${R.fmtShortDateTime(started.toISOString(), R.EASTERN, at.getTime())} → ${ended ? R.fmtShortDateTime(ended.toISOString(), R.EASTERN, at.getTime()) : 'now'}`,
      };
    });
  }

  private async downtimeWrite(
    p: Principal,
    id: string,
    version: number,
    action: string,
    mutate: (d: typeof downtimePeriods.$inferSelect, at: Date) => { patch: Partial<typeof downtimePeriods.$inferInsert>; text: string },
  ): Promise<{ id: string; version: number }> {
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    const out = await this.db.transaction(async (tx) => {
      const [d] = await tx.select().from(downtimePeriods).where(and(eq(downtimePeriods.companyId, p.companyId), eq(downtimePeriods.id, id))).for('update').limit(1);
      if (!d) throw this.core.notFound('That out-of-service period');
      if (d.version !== version) throw new AppError({ status: 409, title: 'Conflict', type: '/problems/version-conflict', detail: 'The period was changed by someone else. Reload it.', extensions: { currentVersion: d.version } });
      const m = mutate(d, at);
      await tx.update(downtimePeriods).set({ ...m.patch, version: d.version + 1, updatedAt: at }).where(eq(downtimePeriods.id, id));
      const [acc] = await tx.select({ id: safetyAccidents.id, number: safetyAccidents.number }).from(safetyAccidents).where(eq(safetyAccidents.id, d.accidentId)).limit(1);
      await this.event(tx, p, d.accidentId, m.text, at);
      if (acc) audits.push(await this.touchCase(tx, p, acc, action, m.text, at));
      return { id, version: d.version + 1 };
    });
    await this.audit.publish(...audits);
    return out;
  }

  // ===================================================================================== AP bills

  async vendors(p: Principal): Promise<A.VendorOption[]> {
    return (await this.payables.vendors(p)).filter((v) => v.status !== 'inactive').map((v) => ({ id: v.id, name: v.name }));
  }

  /** L4 "Add invoice to AP" — towing, storage, transload, rental, other; repair invoices come only from work orders. */
  async addBill(p: Principal, accidentId: string, input: A.CaseBillInput): Promise<{ id: string; number: string }> {
    if (!hasPermission(p, 'accidents.edit') && !hasPermission(p, 'accidents.bills')) throw forbidden('accidents.bills', 'Bills are added by Safety or Accounting');
    const acc = await this.accident(p.companyId, accidentId);
    if (acc.version !== input.version) throw stale(acc.number, acc.updatedAt);
    if (input.claimId) {
      const [k] = await this.db.select({ id: safetyClaims.id }).from(safetyClaims).where(and(eq(safetyClaims.companyId, p.companyId), eq(safetyClaims.id, input.claimId), eq(safetyClaims.accidentId, accidentId))).limit(1);
      if (!k) throw invalid('claimId', 'That claim is not on this accident');
    }
    const { bill } = await this.payables.createBill(p, {
      vendorId: input.vendorId,
      vendorInvoiceNumber: input.invoiceNumber ?? null,
      issuedOn: this.core.today(),
      amount: input.amountCents / 100,
      categoryCode: BILL_LEDGER_CATEGORY[input.category],
      truckId: acc.truckId,
      unitNumber: acc.truckNumber,
      loadId: acc.loadId,
      notes: `${input.category}: ${input.memo} (accident ${acc.number})`,
      source: 'manual',
    });
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.update(acctBills).set({ accidentId: acc.id, claimId: input.claimId ?? null, accidentCostCategory: input.category }).where(eq(acctBills.id, bill.id));
      await this.event(tx, p, acc.id, `${bill.billNumber} added to Accounts Payable — ${input.category}, ${bill.vendorName}, ${R.money(input.amountCents)}`, at, { source: 'Accounting', kind: 'milestone' });
      audits.push(await this.touchCase(tx, p, acc, 'accident_bill_added', `${bill.billNumber}: ${input.category} ${R.money(input.amountCents)}`, at));
    });
    await this.audit.publish(...audits);
    return { id: bill.id, number: bill.billNumber };
  }

  // ===================================================================================== Dispatch confirmation hook

  /**
   * Called inside the confirmation of a Dispatch request (TasksV2Service.confirm): the ONLY place the unit's status
   * history changes. unit_unavailable → ACCIDENT (or the suggested status), unit_ready → READY; the open row closes.
   */
  async recordConfirmedStatus(tx: Tx, p: Principal, t: { id: string; accidentId: string | null; requestKind: string | null; requestPayload: unknown }, at: Date): Promise<string | null> {
    if (t.requestKind !== 'unit_unavailable' && t.requestKind !== 'unit_ready') return null;
    const payload = (t.requestPayload ?? {}) as { unitKind?: string; unitId?: string; truckId?: string; suggestedStatus?: string };
    const unitKind = payload.unitKind === 'trailer' ? 'trailer' : 'truck';
    const unitId = payload.unitId ?? payload.truckId;
    if (!unitId) return null;
    const status = payload.suggestedStatus || (t.requestKind === 'unit_ready' ? 'READY' : 'ACCIDENT');
    await tx
      .update(unitStatusHistory)
      .set({ until: at })
      .where(and(eq(unitStatusHistory.companyId, p.companyId), eq(unitStatusHistory.unitKind, unitKind), eq(unitStatusHistory.unitId, unitId), isNull(unitStatusHistory.until)));
    await tx.insert(unitStatusHistory).values({ id: this.core.newId('ush'), companyId: p.companyId, unitKind, unitId, status, since: at, setBy: this.core.actor(p), source: 'dispatch_confirmation', accidentId: t.accidentId, taskId: t.id, createdAt: at });
    return status;
  }
}
