import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  BREAKDOWN_CATEGORY_LABEL,
  BREAKDOWN_STATUS_LABEL,
  CreateWorkOrderSchema,
  breakdownSteps,
  canMoveBreakdown,
  type BreakdownAssignInput,
  type BreakdownCategory,
  type BreakdownHistoryEntry,
  type BreakdownNoteInput,
  type BreakdownShopInput,
  type BreakdownStatus,
  type BreakdownStatusInput,
  type BreakdownWorkOrderInput,
  type DriverBreakdown,
  type DriverBreakdownCreateInput,
  type DriverBreakdownList,
  type DriverLocation,
  type FleetBreakdown,
  type FleetBreakdownList,
  type WorkType,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships, users } from '../../database/schema/admin';
import { trailers, vendors, workOrders } from '../../database/schema/fleet';
import { loads as loadsTable } from '../../database/schema/loads';
import { fleetBreakdowns } from '../../database/schema/mobile';
import { drivers, trucks } from '../../database/schema/roster';
import { WorkOrdersService } from '../fleet/work-orders.service';
import { LoadProblemsService } from '../loads/load-problems.service';
import { AuditService } from '../people/audit.service';
import { DriverContextService } from './driver-context.service';
import { DriverOwnershipService } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

type Row = typeof fleetBreakdowns.$inferSelect;

const notFound = () => new AppError({ status: 404, title: 'Not Found', detail: 'No such breakdown.' });
const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });
const stale = () => new AppError({ status: 409, title: 'Conflict', detail: 'This breakdown was changed by someone else. Reload and try again.' });

/** What the shop does for each kind of breakdown, in the work order's own words. */
const WORK_TYPE: Partial<Record<BreakdownCategory, WorkType>> = {
  tire: 'tires',
  engine: 'engine',
  electrical: 'electrical_harness',
  lights: 'electrical_harness',
};

/** A breakdown on the trailer is the trailer's work, not the truck's. */
const TRAILER_CATEGORIES = new Set<BreakdownCategory>(['trailer', 'reefer']);

/**
 * Breakdowns a driver reports from the road, and Fleet's work on them (mobile M3, API.md §7).
 *
 * Persist first, then tell people: the case is written (and audited) before the load's flag, the
 * office notification or the driver's push. Nothing here repairs a unit: "In repair" requires the
 * linked work order to be in the shop - the existing down-period path - and neither Ready nor
 * Closed touches the work order or the unit.
 */
@Injectable()
export class BreakdownsService {
  private readonly logger = new Logger(BreakdownsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly workOrders: WorkOrdersService,
    private readonly loadProblems: LoadProblemsService,
    private readonly notifications: MobileNotificationsService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ================================================================================ driver

  async create(principal: Principal, input: DriverBreakdownCreateInput & { fileIds: string[] }, idempotencyKey: string | undefined): Promise<DriverBreakdown> {
    const ctx = await this.context.resolve(principal);
    const units = await this.ownership.units(ctx, { truckId: input.truckId, trailerId: input.trailerId });
    if (!units.truck && !units.trailer) throw unprocessable('Pick the truck or trailer that broke down: you have no unit assigned.');
    const load = input.loadId ? await this.ownership.ownLoad(ctx, input.loadId) : null;
    await this.ownership.ownFiles(principal, input.fileIds, (t) => t.startsWith('image/') || t.startsWith('video/') || t === 'application/pdf');

    const now = new Date();
    const byName = `${ctx.driverName} (driver app)`;
    const location: DriverLocation = { ...input.location, text: input.location.text ?? '', captured_at: input.location.captured_at ?? now.toISOString() };
    const id = `bd_${crypto.randomUUID()}`;
    const history: BreakdownHistoryEntry[] = [{ at: now.toISOString(), kind: 'created', status: 'received', byName, note: null }];
    let number = '';
    for (let attempt = 0; ; attempt += 1) {
      number = await this.nextNumber(ctx.companyId);
      try {
        await this.db.insert(fleetBreakdowns).values({
          id,
          companyId: ctx.companyId,
          number,
          driverId: ctx.driverId,
          truckId: units.truck?.id ?? null,
          trailerId: units.trailer?.id ?? null,
          loadId: load?.id ?? null,
          category: input.category,
          description: input.description.trim(),
          location,
          status: 'received',
          files: input.fileIds,
          history,
          source: 'driver_app',
          idempotencyKey: idempotencyKey?.trim() || null,
          createdByUserId: principal.userId,
          createdAt: now,
          updatedAt: now,
        });
        break;
      } catch (error) {
        const code = (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
        if (code !== '23505' || attempt >= 4) throw error;
        // The same Idempotency-Key raced in twice: answer with the first.
        const again = idempotencyKey ? await this.byKey(ctx.companyId, idempotencyKey) : null;
        if (again) return this.driverView(again);
      }
    }
    const unitLabel = units.truck ? `truck ${units.truck.unitNumber}` : `trailer ${units.trailer?.unitNumber}`;
    await this.audit.write(principal, {
      action: 'breakdown_reported',
      entityType: 'fleet_breakdown',
      entityId: id,
      entityLabel: number,
      summary: `${BREAKDOWN_CATEGORY_LABEL[input.category]} on ${unitLabel}${load ? ` (load ${load.loadNumber})` : ''}, reported from the driver app`,
      changes: [{ field: 'status', old: null, new: 'received' }],
      at: now,
    });

    // Dispatch sees it on the load: a Breakdown flag through the existing load-problems service.
    if (load) {
      try {
        const flag = await this.loadProblems.flag(principal, load.id, { kind: 'breakdown', note: `${number} · ${BREAKDOWN_CATEGORY_LABEL[input.category]} on ${unitLabel}: ${input.description.trim()}`.slice(0, 1000) });
        await this.db.update(fleetBreakdowns).set({ loadProblemId: flag.id }).where(and(eq(fleetBreakdowns.companyId, ctx.companyId), eq(fleetBreakdowns.id, id)));
      } catch (error) {
        this.logger.warn(`Breakdown ${number}: could not flag load ${load.loadNumber}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    // Fleet (maintenance.edit) and the load's dispatcher, nobody else.
    const recipients = await this.notifications.teamUserIds(ctx.companyId, ['maintenance.edit']);
    const dispatcher = load?.dispatcherId ? await this.officeUser(ctx.companyId, load.dispatcherId) : null;
    if (dispatcher) recipients.push(dispatcher.id);
    await this.notifications
      .notifyUsers(ctx.companyId, recipients, {
        title: `Breakdown ${number}: ${BREAKDOWN_CATEGORY_LABEL[input.category]} on ${unitLabel}`,
        body: `${ctx.driverName}${load ? ` · load ${load.loadNumber}` : ''} · ${location.text || 'location not given'}`,
        pushTitle: 'Breakdown reported',
        pushBody: `${number}: a driver reported a breakdown.`,
        severity: 'warning',
        target: { type: 'breakdown', id },
        dedupeKey: `breakdown:${id}:created`,
      })
      .catch((error: unknown) => this.logger.warn(`Breakdown ${number}: notifying Fleet failed: ${String(error)}`));

    return this.driverView((await this.row(ctx.companyId, id))!);
  }

  async mine(principal: Principal): Promise<DriverBreakdownList> {
    const ctx = await this.context.resolve(principal);
    const rows = await this.db
      .select()
      .from(fleetBreakdowns)
      .where(and(eq(fleetBreakdowns.companyId, ctx.companyId), eq(fleetBreakdowns.driverId, ctx.driverId), isNull(fleetBreakdowns.voidedAt)))
      .orderBy(desc(fleetBreakdowns.createdAt))
      .limit(100);
    return { breakdowns: await Promise.all(rows.map((r) => this.driverView(r))) };
  }

  async mineOne(principal: Principal, id: string): Promise<DriverBreakdown> {
    const ctx = await this.context.resolve(principal);
    const row = await this.row(ctx.companyId, id);
    if (!row || row.driverId !== ctx.driverId || row.voidedAt) throw notFound();
    return this.driverView(row);
  }

  // ================================================================================ office

  async list(principal: Principal, filter: { status?: string; open?: boolean }): Promise<FleetBreakdownList> {
    const rows = await this.db
      .select()
      .from(fleetBreakdowns)
      .where(and(eq(fleetBreakdowns.companyId, principal.companyId), isNull(fleetBreakdowns.voidedAt)))
      .orderBy(desc(fleetBreakdowns.createdAt))
      .limit(500);
    const byStatus = { received: 0, assigned: 0, shop_arranged: 0, in_repair: 0, ready: 0, closed: 0 } as Record<BreakdownStatus, number>;
    for (const r of rows) byStatus[r.status as BreakdownStatus] += 1;
    let shown = rows;
    if (filter.status) shown = shown.filter((r) => r.status === filter.status);
    if (filter.open) shown = shown.filter((r) => r.status !== 'closed');
    return {
      breakdowns: await Promise.all(shown.map((r) => this.officeView(r))),
      counts: { open: rows.filter((r) => r.status !== 'closed').length, received: byStatus.received, byStatus },
    };
  }

  /** The shops a case can be sent to: the active vendors on file (the same table work orders use). */
  async shops(principal: Principal): Promise<Array<{ id: string; name: string; city: string | null; state: string | null }>> {
    const rows = await this.db
      .select({ id: vendors.id, name: vendors.name, city: vendors.city, state: vendors.state, status: vendors.status })
      .from(vendors)
      .where(eq(vendors.companyId, principal.companyId))
      .orderBy(vendors.name);
    return rows.filter((r) => r.status !== 'inactive').map(({ status: _status, ...v }) => v);
  }

  /** Who a case can be assigned to: the Fleet team (maintenance codes), owners when there is none. */
  async people(principal: Principal): Promise<Array<{ id: string; name: string }>> {
    const ids = await this.notifications.teamUserIds(principal.companyId, ['maintenance.edit', 'maintenance.view']);
    if (!ids.includes(principal.userId)) ids.push(principal.userId);
    const out: Array<{ id: string; name: string }> = [];
    for (const id of ids) {
      const person = await this.officeUser(principal.companyId, id);
      if (person) out.push(person);
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async detail(principal: Principal, id: string): Promise<FleetBreakdown> {
    const row = await this.row(principal.companyId, id);
    if (!row || row.voidedAt) throw notFound();
    return this.officeView(row);
  }

  async assign(principal: Principal, id: string, input: BreakdownAssignInput): Promise<FleetBreakdown> {
    const person = await this.officeUser(principal.companyId, input.userId);
    if (!person) throw unprocessable('That person does not work in this company.');
    return this.change(principal, id, input.version, (row) => {
      if (row.status === 'closed') throw unprocessable('This breakdown is closed.');
      const to: BreakdownStatus = row.status === 'received' ? 'assigned' : (row.status as BreakdownStatus);
      return {
        set: { assignedUserId: person.id, assignedUserName: person.name, status: to },
        entry: { kind: 'assigned', status: to, note: input.note?.trim() || `Assigned to ${person.name}` },
        audit: { action: 'breakdown_assigned', summary: `Assigned to ${person.name}`, changes: [{ field: 'assignedTo', old: row.assignedUserName, new: person.name }] },
        driver: { title: `${row.number}: ${person.name} is working your breakdown`, push: 'Your breakdown was assigned.' },
      };
    });
  }

  async arrangeShop(principal: Principal, id: string, input: BreakdownShopInput): Promise<FleetBreakdown> {
    const [vendor] = await this.db
      .select({ id: vendors.id, name: vendors.name })
      .from(vendors)
      .where(and(eq(vendors.companyId, principal.companyId), eq(vendors.id, input.vendorId)))
      .limit(1);
    if (!vendor) throw unprocessable('That shop is not on the vendor list.');
    return this.change(principal, id, input.version, (row) => {
      const from = row.status as BreakdownStatus;
      if (from !== 'shop_arranged' && !canMoveBreakdown(from, 'shop_arranged')) throw unprocessable(`A breakdown that is ${BREAKDOWN_STATUS_LABEL[from].toLowerCase()} cannot have a shop arranged.`);
      return {
        set: { vendorId: vendor.id, vendorName: vendor.name, estimateCents: input.estimateCents ?? null, status: 'shop_arranged' },
        entry: { kind: 'shop_arranged', status: 'shop_arranged', note: input.note?.trim() || `Shop: ${vendor.name}` },
        audit: {
          action: 'breakdown_shop_arranged',
          summary: `Shop arranged: ${vendor.name}${input.estimateCents != null ? `, estimate $${(input.estimateCents / 100).toFixed(2)}` : ''}`,
          changes: [
            { field: 'vendor', old: row.vendorName, new: vendor.name },
            { field: 'estimateCents', old: row.estimateCents === null ? null : String(row.estimateCents), new: input.estimateCents == null ? null : String(input.estimateCents) },
          ],
        },
        driver: { title: `${row.number}: shop arranged — ${vendor.name}`, push: 'A shop was arranged for your breakdown.' },
      };
    });
  }

  /**
   * Links an existing work order, or opens one through the existing work-order service. The repair
   * costs then follow the existing expense and accounting rules of that work order. A work order
   * that has the unit in the shop moves the case to In repair; nothing is ever marked repaired.
   */
  async workOrder(principal: Principal, id: string, input: BreakdownWorkOrderInput): Promise<FleetBreakdown> {
    const row = await this.row(principal.companyId, id);
    if (!row || row.voidedAt) throw notFound();
    if (row.version !== input.version) throw stale();
    if (row.status === 'closed') throw unprocessable('This breakdown is closed.');
    if (row.workOrderId) throw unprocessable('A work order is already linked to this breakdown.');

    let wo: { id: string; number: string; status: string; unitId: string };
    if (input.workOrderId) {
      const [found] = await this.db
        .select({ id: workOrders.id, number: workOrders.number, status: workOrders.status, unitId: workOrders.unitId, voidedAt: workOrders.voidedAt })
        .from(workOrders)
        .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.id, input.workOrderId)))
        .limit(1);
      if (!found || found.voidedAt) throw unprocessable('That work order is not in this company.');
      if (found.unitId !== row.truckId && found.unitId !== row.trailerId) throw unprocessable(`${found.number} is on another unit, not this breakdown's truck or trailer.`);
      wo = found;
    } else {
      const create = input.create!;
      const assetType = create.assetType ?? (row.trailerId && (TRAILER_CATEGORIES.has(row.category as BreakdownCategory) || !row.truckId) ? 'trailer' : 'truck');
      const unitId = assetType === 'trailer' ? row.trailerId : row.truckId;
      if (!unitId) throw unprocessable(`This breakdown has no ${assetType} to open a work order on.`);
      const parsed = CreateWorkOrderSchema.parse({
        assetType,
        unitId,
        status: create.status,
        workType: WORK_TYPE[row.category as BreakdownCategory] ?? 'repair',
        title: (create.title?.trim() || `${row.number} · ${BREAKDOWN_CATEGORY_LABEL[row.category as BreakdownCategory]}`).slice(0, 160),
        notes: [create.notes?.trim(), `From breakdown ${row.number} reported by the driver: ${row.description}`].filter(Boolean).join('\n\n'),
        ...(row.vendorId ? { vendorId: row.vendorId, vendorName: row.vendorName ?? undefined } : {}),
      });
      const made = await this.workOrders.create(principal, parsed);
      wo = { id: made.id, number: made.number, status: made.status, unitId };
    }

    const inShop = wo.status === 'in_shop';
    return this.change(principal, id, input.version, (current) => {
      const from = current.status as BreakdownStatus;
      const to: BreakdownStatus = inShop && from !== 'in_repair' && from !== 'ready' && canMoveBreakdown(from, 'in_repair') ? 'in_repair' : from;
      return {
        set: { workOrderId: wo.id, status: to },
        entry: { kind: 'work_order_linked', status: to, note: `Work order ${wo.number}${inShop ? ' — the unit is in the shop' : ''}` },
        audit: { action: 'breakdown_work_order_linked', summary: `Work order ${wo.number} linked${input.create ? ' (opened from the breakdown)' : ''}`, changes: [{ field: 'workOrderId', old: null, new: wo.id }, ...(to !== from ? [{ field: 'status', old: from, new: to }] : [])] },
        driver: to !== from ? { title: `${current.number}: your unit is in the shop`, push: 'Your breakdown is in repair.' } : null,
      };
    });
  }

  async setStatus(principal: Principal, id: string, input: BreakdownStatusInput): Promise<FleetBreakdown> {
    const row = await this.row(principal.companyId, id);
    if (!row || row.voidedAt) throw notFound();
    if (input.status === 'in_repair') {
      const [wo] = row.workOrderId
        ? await this.db
            .select({ status: workOrders.status, number: workOrders.number, voidedAt: workOrders.voidedAt })
            .from(workOrders)
            .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.id, row.workOrderId)))
            .limit(1)
        : [];
      // In repair is an open down period, and that only comes from a work order in the shop.
      if (!wo || wo.voidedAt || wo.status !== 'in_shop') throw unprocessable('In repair needs a linked work order with the unit in the shop. Open or link one, or set the work order to In shop first.');
    }
    const closing = input.status === 'closed';
    const updated = await this.change(principal, id, input.version, (current) => {
      const from = current.status as BreakdownStatus;
      if (!canMoveBreakdown(from, input.status)) throw unprocessable(`A breakdown that is ${BREAKDOWN_STATUS_LABEL[from].toLowerCase()} cannot move to ${BREAKDOWN_STATUS_LABEL[input.status].toLowerCase()}.`);
      return {
        set: { status: input.status, ...(closing ? { closedAt: new Date() } : {}) },
        entry: { kind: input.status, status: input.status, note: input.note?.trim() || null },
        audit: { action: `breakdown_${input.status}`, summary: `${BREAKDOWN_STATUS_LABEL[from]} → ${BREAKDOWN_STATUS_LABEL[input.status]}${input.note ? `: ${input.note}` : ''}`, changes: [{ field: 'status', old: from, new: input.status }] },
        driver: {
          title: `${current.number}: ${BREAKDOWN_STATUS_LABEL[input.status]}${input.note ? ` — ${input.note.trim()}` : ''}`,
          push: input.status === 'ready' ? 'Your unit is ready.' : input.status === 'closed' ? 'Your breakdown case was closed.' : 'Your breakdown is in repair.',
        },
      };
    });
    // The load's Breakdown flag closes with the case, saying so.
    if (closing && row.loadProblemId && row.loadId) {
      await this.loadProblems
        .close(principal, row.loadId, row.loadProblemId, { note: `Breakdown ${row.number} closed${input.note ? `: ${input.note.trim()}` : ''}`.slice(0, 1000) })
        .catch((error: unknown) => this.logger.warn(`Breakdown ${row.number}: closing the load flag failed: ${String(error)}`));
    }
    return updated;
  }

  /** An office note: internal, never shown to the driver. */
  async addNote(principal: Principal, id: string, input: BreakdownNoteInput): Promise<FleetBreakdown> {
    return this.change(principal, id, input.version, (row) => ({
      set: {},
      entry: { kind: 'note', status: row.status as BreakdownStatus, note: input.note.trim() },
      audit: { action: 'breakdown_note', summary: 'Note added', changes: [] },
      driver: null,
    }));
  }

  // ============================================================================== plumbing

  private async change(
    principal: Principal,
    id: string,
    version: number,
    decide: (row: Row) => {
      set: Partial<typeof fleetBreakdowns.$inferInsert>;
      entry: { kind: string; status: BreakdownStatus; note: string | null };
      audit: { action: string; summary: string; changes: Array<{ field: string; old: string | null; new: string | null }> };
      driver: { title: string; push: string } | null;
    },
  ): Promise<FleetBreakdown> {
    const row = await this.row(principal.companyId, id);
    if (!row || row.voidedAt) throw notFound();
    if (row.version !== version) throw stale();
    const plan = decide(row);
    const now = new Date();
    const entry: BreakdownHistoryEntry = { at: now.toISOString(), kind: plan.entry.kind, status: plan.entry.status, byName: principal.userName ?? principal.userId, note: plan.entry.note };
    const history = [...((row.history as BreakdownHistoryEntry[]) ?? []), entry];
    const [saved] = await this.db
      .update(fleetBreakdowns)
      .set({ ...plan.set, history, version: row.version + 1, updatedAt: now })
      .where(and(eq(fleetBreakdowns.companyId, principal.companyId), eq(fleetBreakdowns.id, id), eq(fleetBreakdowns.version, row.version)))
      .returning();
    if (!saved) throw stale();
    await this.audit.write(principal, { action: plan.audit.action, entityType: 'fleet_breakdown', entityId: id, entityLabel: row.number, summary: plan.audit.summary, changes: plan.audit.changes, at: now });
    if (plan.driver && row.driverId) {
      await this.notifications
        .notifyDriver(principal.companyId, row.driverId, {
          title: plan.driver.title,
          body: null,
          pushTitle: 'Breakdown update',
          pushBody: plan.driver.push,
          severity: 'info',
          target: { type: 'breakdown', id },
          dedupeKey: `breakdown:${id}:v${saved.version}`,
        })
        .catch((error: unknown) => this.logger.warn(`Breakdown ${row.number}: notifying the driver failed: ${String(error)}`));
    }
    return this.officeView(saved);
  }

  private async row(companyId: string, id: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(fleetBreakdowns)
      .where(and(eq(fleetBreakdowns.companyId, companyId), sql`(${fleetBreakdowns.id} = ${id} or ${fleetBreakdowns.number} = ${id})`))
      .limit(1);
    return row ?? null;
  }

  private async byKey(companyId: string, key: string): Promise<Row | null> {
    const [row] = await this.db
      .select()
      .from(fleetBreakdowns)
      .where(and(eq(fleetBreakdowns.companyId, companyId), eq(fleetBreakdowns.idempotencyKey, key.trim())))
      .limit(1);
    return row ?? null;
  }

  private async nextNumber(companyId: string): Promise<string> {
    const rows = (await this.db.execute(
      sql`select coalesce(max(nullif(regexp_replace(number, '\\D', '', 'g'), '')::int), 0) + 1 as n from fleet_breakdowns where company_id = ${companyId}`,
    )) as unknown as Array<{ n: number }>;
    return `BD-${String(Number(rows[0]?.n) || 1).padStart(4, '0')}`;
  }

  /** An active office account in this company (never a driver login). */
  private async officeUser(companyId: string, userId: string): Promise<{ id: string; name: string } | null> {
    const [row] = await this.db
      .select({ id: users.id, firstName: users.firstName, lastName: users.lastName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId), eq(memberships.status, 'active'), isNull(memberships.driverId)))
      .limit(1);
    return row ? { id: row.id, name: `${row.firstName} ${row.lastName}`.trim() } : null;
  }

  private async refs(row: Row) {
    const [truck] = row.truckId ? await this.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(and(eq(trucks.companyId, row.companyId), eq(trucks.id, row.truckId))).limit(1) : [];
    const [trailer] = row.trailerId ? await this.db.select({ id: trailers.id, unitNumber: trailers.unitNumber }).from(trailers).where(and(eq(trailers.companyId, row.companyId), eq(trailers.id, row.trailerId))).limit(1) : [];
    const [load] = row.loadId ? await this.db.select({ id: loadsTable.id, loadNumber: loadsTable.loadNumber }).from(loadsTable).where(and(eq(loadsTable.companyId, row.companyId), eq(loadsTable.id, row.loadId))).limit(1) : [];
    return { truck: truck ?? null, trailer: trailer ?? null, load: load ?? null };
  }

  private async driverView(row: Row): Promise<DriverBreakdown> {
    const refs = await this.refs(row);
    const history = (row.history as BreakdownHistoryEntry[]) ?? [];
    const status = row.status as BreakdownStatus;
    // The driver reads the status changes and the words written with them; office notes stay inside.
    const update = [...history].reverse().find((h) => h.kind !== 'note');
    return {
      id: row.id,
      number: row.number,
      category: row.category as BreakdownCategory,
      categoryLabel: BREAKDOWN_CATEGORY_LABEL[row.category as BreakdownCategory] ?? row.category,
      description: row.description,
      status,
      statusLabel: BREAKDOWN_STATUS_LABEL[status],
      steps: breakdownSteps(status, history.filter((h) => h.kind !== 'note')),
      truck: refs.truck,
      trailer: refs.trailer,
      load: refs.load,
      location: (row.location as DriverLocation | null) ?? null,
      responsible: row.assignedUserName ? { name: row.assignedUserName } : null,
      shopName: row.vendorName ?? null,
      latestUpdate: update ? { at: update.at, text: `${BREAKDOWN_STATUS_LABEL[update.status]}${update.note ? ` — ${update.note}` : ''}` } : null,
      fileIds: (row.files as string[]) ?? [],
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private async officeView(row: Row): Promise<FleetBreakdown> {
    const base = await this.driverView(row);
    const [driver] = row.driverId
      ? await this.db.select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName }).from(drivers).where(and(eq(drivers.companyId, row.companyId), eq(drivers.id, row.driverId))).limit(1)
      : [];
    const [wo] = row.workOrderId
      ? await this.db.select({ id: workOrders.id, number: workOrders.number, status: workOrders.status }).from(workOrders).where(and(eq(workOrders.companyId, row.companyId), eq(workOrders.id, row.workOrderId))).limit(1)
      : [];
    const history = (row.history as BreakdownHistoryEntry[]) ?? [];
    const update = history.at(-1);
    return {
      ...base,
      latestUpdate: update ? { at: update.at, text: `${update.kind === 'note' ? 'Note' : BREAKDOWN_STATUS_LABEL[update.status]}${update.note ? ` — ${update.note}` : ''}` } : null,
      driver: driver ? { id: driver.id, name: `${driver.firstName} ${driver.lastName}`.trim() } : null,
      assignedUserId: row.assignedUserId,
      vendor: row.vendorId ? { id: row.vendorId, name: row.vendorName ?? row.vendorId } : null,
      estimateCents: row.estimateCents ?? null,
      workOrder: wo ?? null,
      loadProblemId: row.loadProblemId ?? null,
      history: [...history].reverse(),
      source: row.source,
      closedAt: row.closedAt?.toISOString() ?? null,
      version: row.version,
    };
  }
}
