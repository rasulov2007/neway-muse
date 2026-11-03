import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import type { Database } from '../../../database/client';
import { DatabaseService } from '../../../database/database.service';
import { safetyTaskUpdates, safetyTasks, safetyTimelineEvents } from '../../../database/schema/accidents-v2';
import { workOrders } from '../../../database/schema/fleet';
import { safetyAccidents, safetyClaims } from '../../../database/schema/safety';
import { AuditService, type AuditEvent } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';
import { EquipmentV2Service } from './equipment-v2.service';
import { AccidentsV2StateService } from './state.service';
import * as V from './views';

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
const ENTITY = 'safety_task';
const STATUS_WORD: Record<string, string> = { open: 'open', in_progress: 'in progress', blocked: 'blocked', done: 'done', cancelled: 'cancelled' };

function forbidden(permission: string, detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, extensions: { permission } });
}
function invalid(path: string, message: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', type: '/problems/validation', detail: message, extensions: { errors: [{ path, message }] } });
}

/**
 * Tasks and cross-department requests on accident cases (SPEC §7.8, §6.4; API.md §3).
 * Next action = earliest-due open task. A request (request_kind set) belongs to the department it asks — it is
 * reassigned only within it and closed only by that department's confirmation (`accidents.confirm` for Dispatch).
 */
@Injectable()
export class TasksV2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
    private readonly state: AccidentsV2StateService,
    private readonly equipment: EquipmentV2Service,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(p: Principal, q: A.TaskListQuery): Promise<A.TaskView[]> {
    const st = await this.state.load(p.companyId);
    const now = this.core.now().getTime();
    const assignee = q.assigneeId === 'me' ? p.userId : q.assigneeId;
    const status = q.status ?? 'open';
    return st.all.tasks
      .filter((t) => (!q.accidentId || t.caseId === q.accidentId) && (!q.claimId || t.claimId === q.claimId) && (!assignee || t.assigneeId === assignee))
      .filter((t) =>
        status === 'all' ? true : status === 'done' ? t.status === 'done' : status === 'overdue' ? R.isOverdue(t, now) : R.openTask(t),
      )
      .sort((a, b) => Date.parse(a.due) - Date.parse(b.due))
      .map((t) => V.taskView(st, t, now));
  }

  private async view(p: Principal, id: string): Promise<A.TaskView> {
    const st = await this.state.load(p.companyId);
    const t = R.byId(st.all.tasks, id);
    if (!t) throw this.core.notFound('That task');
    return V.taskView(st, t, this.core.now().getTime());
  }

  private async accident(companyId: string, id: string) {
    const [row] = await this.db
      .select({ id: safetyAccidents.id, number: safetyAccidents.number, stage: safetyAccidents.stage, voidedAt: safetyAccidents.voidedAt, isTest: safetyAccidents.isTest })
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.id, id)))
      .limit(1);
    if (!row || row.voidedAt) throw this.core.notFound('That accident');
    return row;
  }

  private async event(tx: Tx, p: Principal, accidentId: string | null, text: string, source: R.EventSource, at: Date, claimId: string | null = null) {
    if (!accidentId && !claimId) return;
    await tx.insert(safetyTimelineEvents).values({
      id: this.core.newId('evt'),
      companyId: p.companyId,
      accidentId,
      claimId,
      occurredAt: at,
      loggedAt: at,
      actorId: p.userId,
      actorName: this.core.actor(p),
      source,
      kind: 'task',
      text,
    });
  }

  private async claim(companyId: string, id: string) {
    const [row] = await this.db
      .select({ id: safetyClaims.id, number: safetyClaims.number, voidedAt: safetyClaims.voidedAt, isTest: safetyClaims.isTest })
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), eq(safetyClaims.id, id)))
      .limit(1);
    if (!row || row.voidedAt) throw this.core.notFound('That claim');
    return row;
  }

  private async deptOf(p: Principal, userId: string): Promise<R.Dept | null> {
    const st = await this.state.load(p.companyId);
    return st.peopleDept.get(userId) ?? null;
  }

  /** POST /tasks — default assignee per department from settings (Safety falls back to the creator). */
  async create(p: Principal, input: A.CreateTaskInput): Promise<A.TaskView> {
    const target = input.claimId ? await this.claim(p.companyId, input.claimId) : await this.accident(p.companyId, input.accidentId as string);
    if ('stage' in target && target.stage === 'draft') throw this.core.refused('A draft has no tasks; submit it first');
    const acc = { id: 'stage' in target ? target.id : null, number: target.number, isTest: target.isTest };
    const claimId = input.claimId ?? null;
    if (input.workOrderId) {
      const [w] = await this.db.select({ id: workOrders.id, accidentId: workOrders.accidentId }).from(workOrders).where(and(eq(workOrders.companyId, p.companyId), eq(workOrders.id, input.workOrderId))).limit(1);
      if (!w || (acc.id && w.accidentId !== acc.id)) throw invalid('workOrderId', 'That work order is not on this accident');
    }
    const settings = await this.state.settings(p.companyId);
    const who = input.assigneeId
      ? await this.core.person(p.companyId, input.assigneeId)
      : (settings.deptAssignees[input.dept] ?? (input.dept === 'Safety' ? { id: p.userId, name: this.core.actor(p) } : null));
    const at = this.core.now();
    const id = this.core.newId('tsk');
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.insert(safetyTasks).values({
        id,
        companyId: p.companyId,
        accidentId: acc.id,
        claimId,
        workOrderId: input.workOrderId ?? null,
        title: input.title,
        dept: input.dept,
        assigneeId: who?.id ?? null,
        assigneeName: who?.name ?? null,
        dueAt: new Date(input.dueAt),
        priority: input.priority ?? 'normal',
        instructions: input.instructions ?? null,
        isTest: acc.isTest,
        createdBy: this.core.actor(p),
        createdAt: at,
        updatedAt: at,
      });
      await this.event(tx, p, acc.id, `Task assigned to ${input.dept}${who ? ` — ${who.name}` : ''}: ${input.title} (due ${R.fmtShort(input.dueAt, R.EASTERN, at.getTime())})`, claimId ? 'Claims' : 'Safety', at, claimId);
      audits.push(await this.audit.writeIn(tx, p, { action: 'safety_task_created', entityType: ENTITY, entityId: id, entityLabel: acc.number, summary: `Task created: ${input.title}`, at }));
    });
    await this.audit.publish(...audits);
    return this.view(p, id);
  }

  /**
   * PATCH /tasks/:id. Done stamps completed at/by; reopening clears them. Reassigning an ordinary task moves it to
   * the assignee's department; a request stays in its department. The assignee may change the status of their own
   * ordinary task with view access; everything else needs accidents.edit.
   */
  async patch(p: Principal, id: string, input: A.PatchTaskInput): Promise<A.TaskView> {
    const at = this.core.now();
    const edit = hasPermission(p, 'accidents.edit');
    const newDept = input.assigneeId ? await this.deptOf(p, input.assigneeId) : null;
    const person = input.assigneeId ? await this.core.person(p.companyId, input.assigneeId) : null;
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(safetyTasks).where(and(eq(safetyTasks.companyId, p.companyId), eq(safetyTasks.id, id))).for('update').limit(1);
      if (!t) throw this.core.notFound('That task');
      if (t.version !== input.version) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          type: '/problems/version-conflict',
          detail: `The task was changed by someone else at ${t.updatedAt.toISOString()}. Reload it and make your change again.`,
          extensions: { currentVersion: t.version },
        });
      }
      const onlyStatus = input.assigneeId === undefined && input.dueAt === undefined && input.priority === undefined;
      if (!edit && !(onlyStatus && t.assigneeId === p.userId)) throw forbidden('accidents.edit', 'Only the assignee can update this task with your access');
      if (t.requestKind && input.status === 'done') throw invalid('status', `${t.dept} confirms this request with “Confirm done”`);
      if (input.status === 'blocked' && !(input.blockedReason ?? t.blockedReason)?.trim()) throw invalid('blockedReason', 'Say what the task is waiting on');
      const patch: Partial<typeof safetyTasks.$inferInsert> = {};
      const words: string[] = [];
      if (input.status && input.status !== t.status) {
        patch.status = input.status;
        if (input.status === 'done') Object.assign(patch, { completedAt: at, completedBy: this.core.actor(p) });
        else Object.assign(patch, { completedAt: null, completedBy: null });
        if (input.status === 'blocked') patch.blockedReason = input.blockedReason ?? t.blockedReason;
        words.push(input.status === 'done' ? `Task completed: ${t.title}` : `Task “${t.title}”: ${STATUS_WORD[t.status]} → ${STATUS_WORD[input.status]}`);
      }
      if (input.assigneeId !== undefined && input.assigneeId !== t.assigneeId) {
        if (t.requestKind && person && newDept && newDept !== t.dept) throw invalid('assigneeId', `A ${t.dept} request can only be reassigned within ${t.dept}`);
        Object.assign(patch, { assigneeId: person?.id ?? null, assigneeName: person?.name ?? null });
        if (!t.requestKind && newDept) patch.dept = newDept;
        words.push(`Task “${t.title}” reassigned to ${person?.name ?? 'nobody'}`);
      }
      if (input.dueAt && input.dueAt !== t.dueAt.toISOString()) {
        patch.dueAt = new Date(input.dueAt);
        words.push(`Task “${t.title}” due ${R.fmtShort(input.dueAt, R.EASTERN, at.getTime())}`);
      }
      if (input.priority && input.priority !== t.priority) {
        patch.priority = input.priority;
        words.push(`Task “${t.title}” priority ${input.priority}`);
      }
      if (input.blockedReason !== undefined && input.status !== 'blocked') patch.blockedReason = input.blockedReason;
      await tx.update(safetyTasks).set({ ...patch, version: t.version + 1, updatedAt: at }).where(eq(safetyTasks.id, id));
      const text = words.join('; ') || `Task “${t.title}” updated`;
      await this.event(tx, p, t.accidentId, text, t.dept === 'Driver Relations' ? 'Safety' : (t.dept as R.EventSource), at, t.claimId);
      const changes = Object.entries(patch).map(([field, v]) => ({
        field,
        old: ((t as Record<string, unknown>)[field] ?? null) === null ? null : String((t as Record<string, unknown>)[field] instanceof Date ? ((t as Record<string, unknown>)[field] as Date).toISOString() : (t as Record<string, unknown>)[field]),
        new: v === null || v === undefined ? null : String(v instanceof Date ? v.toISOString() : v),
      }));
      audits.push(await this.audit.writeIn(tx, p, { action: 'safety_task_updated', entityType: ENTITY, entityId: id, entityLabel: t.title, summary: text, changes, at }));
    });
    await this.audit.publish(...audits);
    return this.view(p, id);
  }

  async addUpdate(p: Principal, id: string, input: A.TaskUpdateInput): Promise<A.TaskView> {
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(safetyTasks).where(and(eq(safetyTasks.companyId, p.companyId), eq(safetyTasks.id, id))).limit(1);
      if (!t) throw this.core.notFound('That task');
      if (!hasPermission(p, 'accidents.edit') && t.assigneeId !== p.userId) throw forbidden('accidents.edit', 'Only the assignee can post an update with your access');
      await tx.insert(safetyTaskUpdates).values({ id: this.core.newId('tku'), companyId: p.companyId, taskId: id, at, byId: p.userId, byName: this.core.actor(p), text: input.text });
      audits.push(await this.audit.writeIn(tx, p, { action: 'safety_task_update_posted', entityType: ENTITY, entityId: id, entityLabel: t.title, summary: `Update: ${input.text}`, at }));
    });
    await this.audit.publish(...audits);
    return this.view(p, id);
  }

  /** POST /tasks/:id/confirm — the owning department confirms a request (the only path that closes one). */
  async confirm(p: Principal, id: string, input: A.ConfirmRequestInput): Promise<A.TaskView> {
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      const [t] = await tx.select().from(safetyTasks).where(and(eq(safetyTasks.companyId, p.companyId), eq(safetyTasks.id, id))).for('update').limit(1);
      if (!t) throw this.core.notFound('That task');
      if (!t.requestKind) throw invalid('id', 'This is not a request; mark it done instead');
      // Every request kind in P1 is Dispatch's; Fleet requests (P3) will check their own department's code.
      if (t.dept === 'Dispatch' && !hasPermission(p, 'accidents.confirm')) throw forbidden('accidents.confirm', 'Dispatch confirms this request');
      if (t.version !== input.version)
        throw new AppError({ status: 409, title: 'Conflict', type: '/problems/version-conflict', detail: 'The request was changed by someone else. Reload it.', extensions: { currentVersion: t.version } });
      if (t.status === 'done' || t.status === 'cancelled') throw this.core.refused('This request is already closed');
      await tx
        .update(safetyTasks)
        .set({ status: 'done', completedAt: at, completedBy: this.core.actor(p), confirmedAt: at, confirmedBy: this.core.actor(p), version: t.version + 1, updatedAt: at })
        .where(eq(safetyTasks.id, id));
      if (input.note) await tx.insert(safetyTaskUpdates).values({ id: this.core.newId('tku'), companyId: p.companyId, taskId: id, at, byId: p.userId, byName: this.core.actor(p), text: input.note });
      // P3: Dispatch's confirmation is the only thing that writes the unit's status history (SPEC §6.4).
      const status = await this.equipment.recordConfirmedStatus(tx, p, t, at);
      await this.event(tx, p, t.accidentId, `${t.dept} confirmed: ${t.title}${status ? ` — unit status ${status}` : ''}${input.note ? ` — ${input.note}` : ''}`, t.dept as R.EventSource, at);
      audits.push(await this.audit.writeIn(tx, p, { action: 'safety_request_confirmed', entityType: ENTITY, entityId: id, entityLabel: t.title, summary: `${t.dept} confirmed the request`, at }));
    });
    await this.audit.publish(...audits);
    return this.view(p, id);
  }
}
