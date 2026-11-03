import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, count, desc, eq, inArray, isNotNull, lt, not, or, sql } from 'drizzle-orm';
import {
  COMPLIANCE_AUDIT_ACTIONS,
  OPEN_ONBOARDING_ITEM_STATUSES,
  defaultOnboardingItems,
  type AddOnboardingItemRequest,
  type CreateOnboardingChecklistRequest,
  type OnboardingChecklistRecord,
  type OnboardingItemRecord,
  type OnboardingQuery,
  type OnboardingStatus,
  type OnboardingSummary,
  type OnboardingTemplate,
  type TemplateItemSeed,
  type UpdateOnboardingItemRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { qualificationItems } from '../../database/schema/compliance';
import {
  onboardingChecklists,
  onboardingItems,
  onboardingTemplateItems,
  onboardingTemplates,
} from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { AuditService, type AuditEvent } from '../people/audit.service';
import { hrReach, today, assertCompanyRefs, employeeRef } from './hr.util';

/**
 * Onboarding.
 *
 * The plan's status is derived from its items every time it is read, and written back only so the
 * list can filter on it. Progress is never stored: a percentage in a column is a number that goes
 * stale the moment an item is reopened, and then it disagrees with the checklist underneath it.
 */
@Injectable()
export class OnboardingService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  onModuleInit(): void {
    this.audit.onWrite(async (event) => {
      try {
        await this.onAudit(event);
      } catch (error) {
        console.error('Onboarding file sync failed', event.id, error);
      }
    });
  }

  /**
   * An item linked to a qualification-file requirement completes from the file, never by hand:
   * when Safety verifies the CDL, the plan's "CDL verified" line ticks itself. This listens to the
   * one audit stream, like the funnel wrapper does.
   */
  private async onAudit(event: AuditEvent): Promise<void> {
    if (event.entityType !== 'driver') return;
    if (!(COMPLIANCE_AUDIT_ACTIONS as readonly string[]).includes(event.action)) return;
    await this.syncFromFile(event.companyId, event.entityId);
  }

  private systemPrincipal(companyId: string): Principal {
    return {
      companyId,
      userId: 'system',
      userName: 'Qualification file',
      companyTimezone: 'UTC',
      weekStart: 1,
      roles: [],
      permissions: new Set(),
    };
  }

  /** Completes (or reopens) every linked item on the driver's open plan from the file's state. */
  async syncFromFile(companyId: string, driverId: string): Promise<number> {
    const [driver] = await this.db
      .select({ employeeId: drivers.employeeId })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
      .limit(1);
    if (!driver?.employeeId) return 0;
    const [checklist] = await this.db
      .select({ id: onboardingChecklists.id })
      .from(onboardingChecklists)
      .where(
        and(
          eq(onboardingChecklists.companyId, companyId),
          eq(onboardingChecklists.employeeId, driver.employeeId),
          not(eq(onboardingChecklists.status, 'cancelled')),
        ),
      )
      .limit(1);
    if (!checklist) return 0;
    const linked = await this.db
      .select()
      .from(onboardingItems)
      .where(
        and(
          eq(onboardingItems.checklistId, checklist.id),
          isNotNull(onboardingItems.requirementCode),
        ),
      );
    if (linked.length === 0) return 0;
    const file = await this.db
      .select({
        code: qualificationItems.requirementCode,
        verifiedAt: qualificationItems.verifiedAt,
        notApplicable: qualificationItems.notApplicable,
        failed: qualificationItems.verificationFailed,
      })
      .from(qualificationItems)
      .where(
        and(
          eq(qualificationItems.companyId, companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, driverId),
        ),
      );
    const byCode = new Map(file.map((f) => [f.code, f]));
    let changed = 0;
    for (const item of linked) {
      const q = byCode.get(item.requirementCode as string);
      const satisfied = q !== undefined && !q.failed && (q.notApplicable || q.verifiedAt !== null);
      const next = satisfied ? 'completed' : q?.failed ? 'blocked' : 'pending';
      if (next === item.status) continue;
      await this.db
        .update(onboardingItems)
        .set({
          status: next,
          completedAt: satisfied ? (q.verifiedAt ?? new Date()) : null,
          completedByEmployeeId: null,
          notes: satisfied ? 'Completed from the qualification file' : item.notes,
        })
        .where(eq(onboardingItems.id, item.id));
      changed += 1;
    }
    if (changed > 0) {
      const principal = this.systemPrincipal(companyId);
      await this.refreshStatus(principal, checklist.id);
      await this.audit.write(principal, {
        action: 'status_change',
        entityType: 'onboarding',
        entityId: checklist.id,
        entityLabel: driverId,
        summary: `${changed} linked item${changed === 1 ? '' : 's'} updated from the qualification file`,
        changes: [{ field: 'itemStatus', old: null, new: 'from_file' }],
        actorType: 'system',
      });
    }
    return changed;
  }

  // ================================================================================= templates

  async listTemplates(principal: Principal): Promise<OnboardingTemplate[]> {
    const rows = await this.db
      .select()
      .from(onboardingTemplates)
      .where(eq(onboardingTemplates.companyId, principal.companyId))
      .orderBy(desc(onboardingTemplates.isDefault), asc(onboardingTemplates.name));
    if (rows.length === 0) return [];
    const items = await this.db
      .select()
      .from(onboardingTemplateItems)
      .where(
        inArray(
          onboardingTemplateItems.templateId,
          rows.map((r) => r.id),
        ),
      )
      .orderBy(asc(onboardingTemplateItems.sortOrder));
    return rows.map((t) => ({
      id: t.id,
      name: t.name,
      position: t.position,
      department: t.department as OnboardingTemplate['department'],
      employmentType: t.employmentType as OnboardingTemplate['employmentType'],
      driverType: t.driverType as OnboardingTemplate['driverType'],
      isDefault: t.isDefault,
      items: items
        .filter((i) => i.templateId === t.id)
        .map((i) => ({
          id: i.id,
          title: i.title,
          category: i.category as OnboardingTemplate['items'][number]['category'],
          dueOffsetDays: i.dueOffsetDays,
          sortOrder: i.sortOrder,
          blocking: i.blocking,
          ownerRole: i.ownerRole as OnboardingTemplate['items'][number]['ownerRole'],
          requirementCode: i.requirementCode,
        })),
    }));
  }

  /**
   * The template a hire gets: the one named, else the closest match — a driver type beats a
   * position, a position beats the company default — else the built-in seed list.
   */
  private async templateFor(
    companyId: string,
    input: {
      templateId: string | null;
      position: string;
      department: string;
      driverType?: string | null;
    },
  ): Promise<{ id: string | null; items: TemplateItemSeed[] }> {
    const all = await this.listTemplates(this.systemPrincipal(companyId));
    const drives = /driver/i.test(input.position);
    const chosen =
      (input.templateId ? all.find((t) => t.id === input.templateId) : undefined) ??
      (input.driverType ? all.find((t) => t.driverType === input.driverType) : undefined) ??
      all.find(
        (t) =>
          t.driverType === null &&
          t.position !== null &&
          t.position.toLowerCase() === input.position.toLowerCase(),
      ) ??
      all.find((t) => t.driverType === null && t.position === null && t.isDefault && !drives);
    if (!chosen) return { id: null, items: defaultOnboardingItems(input) };
    return {
      id: chosen.id,
      items: chosen.items.map((i) => ({
        title: i.title,
        category: i.category,
        dueOffsetDays: i.dueOffsetDays,
        blocking: i.blocking,
        ownerRole: i.ownerRole,
        requirementCode: i.requirementCode,
      })),
    };
  }

  private select() {
    return {
      checklist: onboardingChecklists,
      employeeFirst: employees.firstName,
      employeeLast: employees.lastName,
      employeeNumber: employees.employeeNumber,
      position: employees.position,
      department: employees.department,
      totalItems: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id})`,
      completedItems: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id} and i.status = 'completed')`,
      blockedItems: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id} and i.status = 'blocked')`,
      overdueItems: sql<number>`(select count(*)::int from ${onboardingItems} i where i.checklist_id = ${onboardingChecklists.id} and i.due_date < current_date and i.status in ('pending','in_progress','blocked'))`,
      /*
       * The driver behind the plan, and what their qualification file says.
       *
       * Counted here rather than fetched per row on the client: the board shows a page of cases
       * and asking the file a question per case is how a list takes four seconds to paint.
       *
       * A document is *missing* when the requirement has no document at all or the last one was
       * rejected; *pending* while Safety has it; *verified* once they have accepted it.
       */
      driverId: sql<
        string | null
      >`(select d.id from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1)`,
      driverStatus: sql<
        string | null
      >`(select d.status from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1)`,
      documentsMissing: sql<number>`(select count(*)::int from qualification_items q where q.entity_id = (select d.id from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1) and q.scope = 'driver' and q.document_id is null)`,
      documentsPending: sql<number>`(select count(*)::int from qualification_items q join compliance_documents cd on cd.id = q.document_id where q.entity_id = (select d.id from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1) and q.scope = 'driver' and cd.status = 'pending_review')`,
      documentsRejected: sql<number>`(select count(*)::int from qualification_items q join compliance_documents cd on cd.id = q.document_id where q.entity_id = (select d.id from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1) and q.scope = 'driver' and cd.status = 'rejected')`,
      documentsVerified: sql<number>`(select count(*)::int from qualification_items q join compliance_documents cd on cd.id = q.document_id where q.entity_id = (select d.id from drivers d where d.employee_id = ${onboardingChecklists.employeeId} limit 1) and q.scope = 'driver' and cd.status = 'verified')`,
    };
  }

  private toRecord(row: {
    checklist: typeof onboardingChecklists.$inferSelect;
    employeeFirst: string | null;
    employeeLast: string | null;
    employeeNumber: string | null;
    position: string | null;
    department: string | null;
    totalItems: number;
    completedItems: number;
    blockedItems: number;
    overdueItems: number;
    driverId?: string | null;
    driverStatus?: string | null;
    documentsMissing?: number;
    documentsPending?: number;
    documentsRejected?: number;
    documentsVerified?: number;
  }): OnboardingChecklistRecord {
    const c = row.checklist;
    return {
      id: c.id,
      employeeId: c.employeeId,
      employeeName: `${row.employeeFirst ?? ''} ${row.employeeLast ?? ''}`.trim(),
      employeeNumber: row.employeeNumber ?? '',
      position: row.position ?? '',
      department: (row.department ?? 'dispatch') as OnboardingChecklistRecord['department'],
      templateId: c.templateId,
      templateName: null,
      ownerEmployeeId: c.ownerEmployeeId,
      ownerName: null,
      startDate: c.startDate,
      dueDate: c.dueDate,
      status: c.status as OnboardingStatus,
      completedAt: c.completedAt?.toISOString() ?? null,
      notes: c.notes,
      totalItems: row.totalItems,
      completedItems: row.completedItems,
      blockedItems: row.blockedItems,
      overdueItems: row.overdueItems,
      driverId: row.driverId ?? null,
      documentsMissing: row.documentsMissing ?? 0,
      documentsPending: row.documentsPending ?? 0,
      documentsRejected: row.documentsRejected ?? 0,
      documentsVerified: row.documentsVerified ?? 0,
      // Cleared to work: for a driver that is the roster status, and for an office hire the plan.
      isAvailable: row.driverStatus
        ? ['available', 'driving', 'dispatched'].includes(row.driverStatus)
        : c.status === 'completed',
      createdAt: c.createdAt.toISOString(),
    };
  }

  async list(
    principal: Principal,
    query: OnboardingQuery,
  ): Promise<{ data: OnboardingChecklistRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(onboardingChecklists.companyId, principal.companyId), hrReach(principal, 'onboarding.manage', onboardingChecklists.employeeId)];
    if (query.status) parts.push(eq(onboardingChecklists.status, query.status));
    else if (!query.includeFinished) {
      parts.push(not(inArray(onboardingChecklists.status, ['completed', 'cancelled'])));
    }
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.ownerEmployeeId) {
      parts.push(eq(onboardingChecklists.ownerEmployeeId, query.ownerEmployeeId));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        sql`${employees.firstName} ilike ${term}`,
        sql`${employees.lastName} ilike ${term}`,
        sql`${employees.employeeNumber} ilike ${term}`,
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(onboardingChecklists)
      .innerJoin(employees, and(eq(onboardingChecklists.employeeId, employees.id), eq(employees.companyId, onboardingChecklists.companyId)))
      .where(where);

    const column = {
      createdAt: onboardingChecklists.createdAt,
      startDate: onboardingChecklists.startDate,
      dueDate: onboardingChecklists.dueDate,
      employeeName: employees.lastName,
      status: onboardingChecklists.status,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select(this.select())
      .from(onboardingChecklists)
      .innerJoin(employees, and(eq(onboardingChecklists.employeeId, employees.id), eq(employees.companyId, onboardingChecklists.companyId)))
      .where(where)
      .orderBy(direction(column))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toRecord(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * One plan. `internal` is for the service's own reads on behalf of another module (the hire
   * conversion opens the plan as Recruiting, which holds no onboarding code): the company scope
   * stays, the direct-report reach does not apply.
   */
  async get(principal: Principal, id: string, internal = false): Promise<OnboardingChecklistRecord> {
    const [row] = await this.db
      .select(this.select())
      .from(onboardingChecklists)
      .innerJoin(employees, and(eq(onboardingChecklists.employeeId, employees.id), eq(employees.companyId, onboardingChecklists.companyId)))
      .where(
        and(
          eq(onboardingChecklists.companyId, principal.companyId),
          or(eq(onboardingChecklists.id, id), eq(onboardingChecklists.employeeId, id)),
          internal ? undefined : hrReach(principal, 'onboarding.manage', onboardingChecklists.employeeId),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No onboarding plan ${id}` });
    }
    return this.toRecord(row);
  }

  async findForEmployee(
    principal: Principal,
    employeeId: string,
  ): Promise<OnboardingChecklistRecord | null> {
    const [row] = await this.db
      .select(this.select())
      .from(onboardingChecklists)
      .innerJoin(employees, and(eq(onboardingChecklists.employeeId, employees.id), eq(employees.companyId, onboardingChecklists.companyId)))
      .where(
        and(
          eq(onboardingChecklists.companyId, principal.companyId),
          eq(onboardingChecklists.employeeId, employeeId),
          not(eq(onboardingChecklists.status, 'cancelled')),
          hrReach(principal, 'onboarding.manage', onboardingChecklists.employeeId),
        ),
      )
      .limit(1);
    return row ? this.toRecord(row) : null;
  }

  async items(principal: Principal, checklistId: string): Promise<OnboardingItemRecord[]> {
    const checklist = await this.get(principal, checklistId);
    const rows = await this.db
      .select({
        item: onboardingItems,
        ownerFirst: employees.firstName,
        ownerLast: employees.lastName,
      })
      .from(onboardingItems)
      .leftJoin(employees, and(eq(onboardingItems.ownerEmployeeId, employees.id), eq(employees.companyId, principal.companyId)))
      .where(eq(onboardingItems.checklistId, checklist.id))
      .orderBy(asc(onboardingItems.sortOrder));

    return rows.map(({ item, ownerFirst, ownerLast }) => ({
      id: item.id,
      checklistId: item.checklistId,
      title: item.title,
      category: item.category as OnboardingItemRecord['category'],
      ownerEmployeeId: item.ownerEmployeeId,
      ownerName: ownerFirst ? `${ownerFirst} ${ownerLast ?? ''}`.trim() : null,
      dueDate: item.dueDate,
      status: item.status as OnboardingItemRecord['status'],
      completedByName: null,
      completedAt: item.completedAt?.toISOString() ?? null,
      sortOrder: item.sortOrder,
      notes: item.notes,
      blocking: item.blocking,
      ownerRole: item.ownerRole,
      requirementCode: item.requirementCode,
    }));
  }

  /**
   * Build the plan for a new hire.
   *
   * Called by the hire conversion, which is why it takes the position and department rather than
   * looking them up: the employee has just been created and the caller already holds them.
   */
  async createForHire(
    principal: Principal,
    input: {
      employeeId: string;
      position: string;
      department: string;
      startDate: string;
      templateId: string | null;
      ownerEmployeeId: string | null;
      /** A driver hire: picks the driver-type template and links items to the file. */
      driverType?: string | null;
      driverId?: string | null;
    },
  ): Promise<OnboardingChecklistRecord> {
    const [existing] = await this.db
      .select({ id: onboardingChecklists.id })
      .from(onboardingChecklists)
      .where(
        and(
          eq(onboardingChecklists.companyId, principal.companyId),
          eq(onboardingChecklists.employeeId, input.employeeId),
          not(eq(onboardingChecklists.status, 'cancelled')),
        ),
      )
      .limit(1);
    if (existing) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          'This employee already has an onboarding plan. Two competing plans is how half the tasks get missed.',
      });
    }

    const id = `onb_${crypto.randomUUID()}`;
    // Role-aware by design: an office hire is not asked to complete a road test. A driver's
    // template is chosen by driver type — a lease operator signs a lease, a company driver does not.
    const template = await this.templateFor(principal.companyId, {
      templateId: input.templateId,
      position: input.position,
      department: input.department,
      driverType: input.driverType ?? null,
    });
    const seeds = template.items;
    const dueDate = addDays(input.startDate, Math.max(...seeds.map((s) => s.dueOffsetDays), 0));

    await this.db.transaction(async (tx) => {
      await tx.insert(onboardingChecklists).values({
        id,
        companyId: principal.companyId,
        employeeId: input.employeeId,
        templateId: template.id,
        ownerEmployeeId: input.ownerEmployeeId,
        startDate: input.startDate,
        dueDate,
        status: 'not_started',
      });
      await tx.insert(onboardingItems).values(
        seeds.map((seed, index) => ({
          id: `oni_${crypto.randomUUID()}`,
          checklistId: id,
          title: seed.title,
          category: seed.category,
          ownerEmployeeId: input.ownerEmployeeId,
          dueDate: addDays(input.startDate, seed.dueOffsetDays),
          status: 'pending',
          sortOrder: index,
          blocking: seed.blocking ?? false,
          ownerRole: seed.ownerRole ?? null,
          requirementCode: seed.requirementCode ?? null,
        })),
      );
    });
    // Whatever the file already holds is done before anyone opens the plan.
    if (input.driverId) await this.syncFromFile(principal.companyId, input.driverId);

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'onboarding',
      entityId: id,
      entityLabel: input.employeeId,
      summary: `Onboarding plan created with ${seeds.length} items`,
    });

    return this.get(principal, id, true);
  }

  async create(
    principal: Principal,
    input: CreateOnboardingChecklistRequest,
  ): Promise<OnboardingChecklistRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), employeeRef(input.ownerEmployeeId, 'owner'), { table: onboardingTemplates, idColumn: onboardingTemplates.id, companyColumn: onboardingTemplates.companyId, id: input.templateId, label: 'onboarding template' }]);
    const [employee] = await this.db
      .select({ position: employees.position, department: employees.department })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, input.employeeId)))
      .limit(1);
    if (!employee) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That employee is not on the workforce',
      });
    }
    return this.createForHire(principal, {
      employeeId: input.employeeId,
      position: employee.position,
      department: employee.department,
      startDate: input.startDate,
      templateId: input.templateId,
      ownerEmployeeId: input.ownerEmployeeId,
    });
  }

  async addItem(
    principal: Principal,
    checklistId: string,
    input: AddOnboardingItemRequest,
  ): Promise<OnboardingItemRecord[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.ownerEmployeeId, 'owner')]);
    const checklist = await this.get(principal, checklistId);
    const [highest] = await this.db
      .select({ value: sql<number>`coalesce(max(${onboardingItems.sortOrder}), -1)::int` })
      .from(onboardingItems)
      .where(eq(onboardingItems.checklistId, checklist.id));

    await this.db.insert(onboardingItems).values({
      id: `oni_${crypto.randomUUID()}`,
      checklistId: checklist.id,
      title: input.title,
      category: input.category,
      ownerEmployeeId: input.ownerEmployeeId,
      dueDate: input.dueDate,
      status: 'pending',
      sortOrder: (highest?.value ?? -1) + 1,
      notes: input.notes,
    });

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'onboarding',
      entityId: checklist.id,
      entityLabel: checklist.employeeName,
      summary: `Item added: ${input.title}`,
    });
    await this.refreshStatus(principal, checklist.id);
    return this.items(principal, checklist.id);
  }

  async updateItem(
    principal: Principal,
    itemId: string,
    patch: UpdateOnboardingItemRequest,
  ): Promise<OnboardingItemRecord[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(patch.ownerEmployeeId, 'owner')]);
    const [item] = await this.db
      .select({ item: onboardingItems, companyId: onboardingChecklists.companyId })
      .from(onboardingItems)
      .innerJoin(onboardingChecklists, eq(onboardingItems.checklistId, onboardingChecklists.id))
      .where(eq(onboardingItems.id, itemId))
      .limit(1);
    if (!item || item.companyId !== principal.companyId) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such onboarding item' });
    }

    if (item.item.requirementCode && patch.status !== undefined) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `"${item.item.title}" completes from the qualification file when ${item.item.requirementCode.replace(/_/g, ' ')} is verified; it is not ticked by hand.`,
      });
    }
    const completing = patch.status === 'completed' && item.item.status !== 'completed';
    const reopening =
      patch.status !== undefined &&
      patch.status !== 'completed' &&
      item.item.status === 'completed';

    await this.db
      .update(onboardingItems)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.ownerEmployeeId !== undefined ? { ownerEmployeeId: patch.ownerEmployeeId } : {}),
        ...(patch.dueDate !== undefined ? { dueDate: patch.dueDate } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(completing ? { completedAt: new Date() } : {}),
        // Reopening clears the completion, so "who finished this and when" can never describe a
        // completion that was later undone.
        ...(reopening ? { completedAt: null, completedByEmployeeId: null } : {}),
      })
      .where(eq(onboardingItems.id, itemId));

    if (patch.status !== undefined) {
      await this.audit.write(principal, {
        action: 'status_change',
        entityType: 'onboarding',
        entityId: item.item.checklistId,
        entityLabel: item.item.title,
        summary: `${item.item.title}: ${item.item.status} → ${patch.status}`,
        changes: [{ field: 'itemStatus', old: item.item.status, new: patch.status }],
      });
    }

    await this.refreshStatus(principal, item.item.checklistId);
    return this.items(principal, item.item.checklistId);
  }

  /**
   * Recompute the plan's status from its items.
   *
   * Blocked outranks in-progress, and a plan is only complete when nothing is still open. The
   * stored status exists solely so the list can filter and sort on it in the database.
   */
  async refreshStatus(principal: Principal, checklistId: string): Promise<void> {
    const rows = await this.db
      .select({ status: onboardingItems.status })
      .from(onboardingItems)
      .where(eq(onboardingItems.checklistId, checklistId));

    const open = rows.filter((r) =>
      OPEN_ONBOARDING_ITEM_STATUSES.includes(
        r.status as (typeof OPEN_ONBOARDING_ITEM_STATUSES)[number],
      ),
    );
    const blocked = rows.some((r) => r.status === 'blocked');
    const touched = rows.some((r) => r.status !== 'pending');

    const status: OnboardingStatus =
      rows.length === 0
        ? 'not_started'
        : open.length === 0
          ? 'completed'
          : blocked
            ? 'blocked'
            : touched
              ? 'in_progress'
              : 'not_started';

    await this.db
      .update(onboardingChecklists)
      .set({
        status,
        completedAt: status === 'completed' ? new Date() : null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(onboardingChecklists.companyId, principal.companyId),
          eq(onboardingChecklists.id, checklistId),
        ),
      );
  }

  async summary(principal: Principal): Promise<OnboardingSummary> {
    const scope = and(eq(onboardingChecklists.companyId, principal.companyId), hrReach(principal, 'onboarding.manage', onboardingChecklists.employeeId));
    const soon = addDays(today(), 14);

    const [byStatus, [startingSoon], [overdue]] = await Promise.all([
      this.db
        .select({ status: onboardingChecklists.status, value: count() })
        .from(onboardingChecklists)
        .where(scope)
        .groupBy(onboardingChecklists.status),
      this.db
        .select({ value: count() })
        .from(onboardingChecklists)
        .where(
          and(
            scope,
            not(inArray(onboardingChecklists.status, ['completed', 'cancelled'])),
            sql`${onboardingChecklists.startDate} between current_date and ${soon}`,
          ),
        ),
      this.db
        .select({ value: count() })
        .from(onboardingChecklists)
        .where(
          and(
            scope,
            not(inArray(onboardingChecklists.status, ['completed', 'cancelled'])),
            lt(onboardingChecklists.dueDate, today()),
          ),
        ),
    ]);

    const at = (status: string) => byStatus.find((s) => s.status === status)?.value ?? 0;
    return {
      active: at('not_started') + at('in_progress') + at('blocked'),
      startingSoon: startingSoon?.value ?? 0,
      overdue: overdue?.value ?? 0,
      blocked: at('blocked'),
      completed: at('completed'),
    };
  }
}

function addDays(isoDate: string, days: number): string {
  const time = Date.parse(`${isoDate}T00:00:00Z`);
  if (!Number.isFinite(time)) return isoDate;
  return new Date(time + days * 86_400_000).toISOString().slice(0, 10);
}
