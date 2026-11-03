import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { acctBills } from '../../database/schema/accounting';
import { loads as loadsTable } from '../../database/schema/loads';
import {
  type VoidWorkOrderInput,
  MAINTENANCE_DEFAULTS,
  SERVICE_RESETTING_TYPES,
  SHOP_STAGES,
  downtimeMinutes,
  workOrderLabel,
  type AddWorkOrderNoteInput,
  type AttachInvoiceInput,
  type ChangeShopStageInput,
  type CheckInWorkOrderInput,
  type CompleteWorkOrderInput,
  type CreateWorkOrderInput,
  DRIVER_NOT_INFORMED_FLAG,
  type SetWorkOrderChargeInput,
  type WorkOrderCharge,
  type WorkOrderChargeParty,
  type MaintenanceDefaults,
  type ShopStage,
  defaultInvoiceNumber,
  type UpdateWorkOrderInput,
  type WorkOrder,
  type WorkOrderAction,
  type WorkOrderDetail,
  type WorkOrderStatus,
  type WorkOrderWithCost,
  type WorkType,
  type MergeVendorInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { isFeatureEnabled } from '../../common/flags/flags';
import { DatabaseService } from '../../database/database.service';
import { PtiService } from './pti.service';
import { PmService } from '../pm/pm.service';
import {
  drivers,
  odometerReadings,
  trailers,
  trucks,
  storedFiles,
  unitMaintenanceSettings,
  workOrderActions,
  workOrderLines,
  workOrders,
  repairTireEvents,
} from '../../database/schema';
import { FilesService } from '../files/files.service';
import { AuditService } from '../people/audit.service';

/** The permission that lets somebody see what maintenance cost. */
export const MAINTENANCE_COST_PERMISSION = 'maintenance_costs.view';

type Row = typeof workOrders.$inferSelect;
type ActionRow = typeof workOrderActions.$inferSelect;

/**
 * Work orders, and the rule that a mechanic never receives a price.
 *
 * The serialisers are the heart of this file. `toWorkOrder` builds an object with no cost fields
 * on it at all — not blanked, not zeroed, absent — and `toWorkOrderWithCost` adds them for a
 * principal holding the cost permission. Redacting after the fact is how a total eventually leaks
 * through a field somebody forgot; a shape with nowhere to put one cannot.
 *
 * Fleet specification §5. Every method takes the principal and scopes by its company.
 */
@Injectable()
export class WorkOrdersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly pti: PtiService,
    private readonly pm: PmService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Company defaults for the service clocks. Settings, not constants: a carrier changes them. */
  defaults(): MaintenanceDefaults {
    return MAINTENANCE_DEFAULTS;
  }

  // ------------------------------------------------------------------------------------- reads

  /**
   * The work orders for a company, newest shop-in first.
   *
   * Returns the cost-bearing shape only when the principal may see money. The caller cannot get
   * that wrong: there is one branch, here, and both return types are distinct.
   */
  /** The units an unvoided work order has in the shop: asset type and id only. */
  async inShopUnits(principal: Principal): Promise<{ assetType: string; unitId: string }[]> {
    const rows = await this.db
      .selectDistinct({ assetType: workOrders.assetType, unitId: workOrders.unitId })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.status, 'in_shop'), isNull(workOrders.voidedAt)));
    return rows;
  }

  /**
   * Trucks driven by a lease operator (owner, 2026-11-03): on these the invoice is optional - a
   * work order or an oil change saves without one and is not listed as missing it. The driver's
   * own Driver type on the profile decides; the oil-change clock runs the same.
   */
  async leaseOperatorTruckIds(companyId: string): Promise<string[]> {
    const rows = await this.db
      .select({ id: trucks.id })
      .from(trucks)
      .innerJoin(drivers, and(eq(drivers.id, trucks.currentDriverId), eq(drivers.companyId, trucks.companyId)))
      .where(and(eq(trucks.companyId, companyId), eq(drivers.driverType, 'lease_operator')));
    return rows.map((r) => r.id);
  }

  async list(
    principal: Principal,
    filter: { status?: WorkOrderStatus; unitId?: string } = {},
  ): Promise<WorkOrder[] | WorkOrderWithCost[]> {
    // Voided orders stay in the table for the audit trail but leave every list.
    const where = [eq(workOrders.companyId, principal.companyId), isNull(workOrders.voidedAt)];
    // PM-board import baselines ("last oil change" rows from the owner's sheet) are not repairs
    // anyone did through the product: they feed the PM board and stay out of the repair log
    // (owner, 2026-10-02). Kept, not voided - voiding them would erase each unit's last change.
    where.push(or(isNull(workOrders.enteredVia), ne(workOrders.enteredVia, 'import'))!);
    if (filter.status) where.push(eq(workOrders.status, filter.status));
    if (filter.unitId) where.push(eq(workOrders.unitId, filter.unitId));

    const rows = await this.db
      .select()
      .from(workOrders)
      .where(and(...where))
      .orderBy(desc(workOrders.shopInAt));

    const latest = await this.latestActions(rows.map((row) => row.id));
    await this.loadDriverNames(principal.companyId);
    const now = Date.now();
    return this.maySeeCost(principal)
      ? rows.map((row) => this.toWorkOrderWithCost(row, latest.get(row.id) ?? null, now))
      : rows.map((row) => this.toWorkOrder(row, latest.get(row.id) ?? null, now));
  }

  /**
   * The units a work order can be opened against, for the picker.
   *
   * Trucks and trailers answer separately because the dialog asks for the asset type first: a
   * combined list is a list somebody can file a trailer repair against a truck from.
   */
  async units(
    principal: Principal,
    assetType: 'truck' | 'trailer',
  ): Promise<{
    data: { id: string; unitNumber: string; description: string; odometer: number | null }[];
  }> {
    if (assetType === 'trailer') {
      const rows = await this.db
        .select()
        .from(trailers)
        .where(eq(trailers.companyId, principal.companyId))
        .orderBy(asc(trailers.unitNumber));
      return {
        data: rows.map((row) => ({
          id: row.id,
          unitNumber: row.unitNumber,
          description: [row.year, row.make, row.type?.replace(/_/g, ' ')].filter(Boolean).join(' '),
          odometer: null,
        })),
      };
    }
    const rows = await this.db
      .select()
      .from(trucks)
      // An archived truck is not offered for new work (owner, 2026-10-05).
      .where(and(eq(trucks.companyId, principal.companyId), ne(trucks.status, 'archived')))
      .orderBy(asc(trucks.unitNumber));
    return {
      data: rows.map((row) => ({
        id: row.id,
        unitNumber: row.unitNumber,
        description: `${row.year} ${row.make} ${row.model}`,
        odometer: row.odometer,
      })),
    };
  }

  /** One work order with its whole history. Still no costs unless the principal may see them. */
  async detail(principal: Principal, id: string): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    const history = await this.db
      .select()
      .from(workOrderActions)
      .where(eq(workOrderActions.workOrderId, id))
      .orderBy(asc(workOrderActions.createdAt));

    const now = Date.now();
    const actions = history.map(toAction);
    const seesCost = this.maySeeCost(principal);
    const base = seesCost
      ? this.toWorkOrderWithCost(row, actions.at(-1) ?? null, now)
      : this.toWorkOrder(row, actions.at(-1) ?? null, now);

    const lineRows = await this.db
      .select()
      .from(workOrderLines)
      .where(eq(workOrderLines.workOrderId, id))
      .orderBy(asc(workOrderLines.sort));
    const fileIds = Array.isArray(row.invoiceFileIds) ? (row.invoiceFileIds as string[]) : [];
    const fileRows =
      fileIds.length === 0
        ? []
        : await this.db
            .select()
            .from(storedFiles)
            .where(
              and(eq(storedFiles.companyId, principal.companyId), inArray(storedFiles.id, fileIds)),
            );
    const byId = new Map(fileRows.map((f) => [f.id, f]));

    return {
      ...base,
      actions: [...actions].reverse(),
      notes: row.notes,
      title: row.title ?? null,
      lines: lineRows.map((l) => ({
        id: l.id,
        systemCode: l.systemCode,
        description: l.description,
        ...(seesCost ? { amount: Number(l.totalAmount) } : {}),
      })),
      invoiceFiles: fileIds.flatMap((fileId) => {
        const f = byId.get(fileId);
        return f
          ? [
              {
                id: f.id,
                fileName: f.fileName,
                contentType: f.contentType,
                sizeBytes: f.sizeBytes,
                url: FilesService.urlFor(f.id),
              },
            ]
          : [];
      }),
      invoiceNumber: row.invoiceNumber ?? null,
      ...(seesCost
        ? { invoiceTotal: row.invoiceTotal === null ? null : Number(row.invoiceTotal) }
        : {}),
    };
  }

  // ------------------------------------------------------------------------------------ writes

  /**
   * Opens a work order, or records one that is already finished.
   *
   * Both are normal. Work is written up after the fact more often than during it, so `completed`
   * is a first-class way to create a record — and the one rule is that a completed record says
   * what was done, because a completed work order nobody can be asked about cannot be audited.
   */
  async create(principal: Principal, input: CreateWorkOrderInput): Promise<WorkOrder> {
    const unit = await this.requireUnit(principal, input.assetType, input.unitId);

    // What was done: the words given, or the lines joined. A completed record with neither is a
    // row nobody can be asked about, and the schema has already refused it.
    const workDone =
      input.workDone?.trim() ||
      input.lines
        .map((l) => `${l.description.trim()}`)
        .join(' · ')
        .slice(0, 500) ||
      null;
    if (input.status === 'completed' && !workDone) {
      throw new BadRequestException('Say what was done before completing it');
    }
    // Opened for a defect: it has to be this unit's, and open. Checked before anything is written.
    const defect = input.defectId ? await this.pti.defect(principal, input.defectId) : null;
    if (defect && defect.unitId !== input.unitId) {
      throw new BadRequestException(
        `${defect.defectNumber} is on unit ${defect.unitNumber}, not this one`,
      );
    }
    if (defect && (defect.state === 'verified' || defect.state === 'dismissed')) {
      throw new BadRequestException(
        `${defect.defectNumber} is ${defect.state}; a closed defect does not open a work order`,
      );
    }

    const now = new Date();
    let shopInAt = input.shopInAt ? new Date(input.shopInAt) : now;
    if (Number.isNaN(shopInAt.getTime()))
      throw new BadRequestException('That shop-in date is not a date');
    const completed = input.status === 'completed';
    /*
     * Back in service (specification §2.3): the date the unit went back on the road. Downtime is
     * measured to it, so it cannot be before the unit went in or after now — a repair that ends
     * in the future has not happened yet.
     */
    let completedAt: Date | null = null;
    if (completed) {
      completedAt = input.completedAt ? new Date(input.completedAt) : now;
      if (Number.isNaN(completedAt.getTime()))
        throw new BadRequestException('That back-in-service date is not a date');
      // Written up after the job with no shop-in date: the visit is the day it came back.
      if (!input.shopInAt) shopInAt = completedAt;
      if (completedAt.getTime() > now.getTime() + 60_000)
        throw new BadRequestException('Back in service cannot be in the future');
      if (completedAt.getTime() < shopInAt.getTime())
        throw new BadRequestException(
          'Back in service cannot be before the unit went into the shop',
        );
    }
    /*
     * An oil change written up here is the same record the Oil change board writes (owner,
     * 2026-10-18): it asks the mileage, it becomes the board's new baseline, and a second entry of
     * the same oil change - here or on the board - is refused instead of billed twice.
     */
    const oilChange = completed && input.assetType === 'truck' && input.workType === 'oil_change';
    if (oilChange) {
      if (input.odometer === undefined || input.odometer === null) {
        throw new BadRequestException('Enter the odometer (miles) at the oil change');
      }
      const twin = await this.oilChangeNear(principal.companyId, input.unitId, completedAt as Date);
      if (twin) {
        throw new BadRequestException(
          `This oil change is already recorded as ${twin.number} (${twin.completedAt?.toLocaleDateString('en-US', { timeZone: 'America/New_York' })}). Open it to correct it instead of adding another.`,
        );
      }
    }
    let scheduledFor: Date | null = null;
    if (input.status === 'scheduled' && input.scheduledFor) {
      scheduledFor = new Date(input.scheduledFor);
      if (Number.isNaN(scheduledFor.getTime()))
        throw new BadRequestException('That appointment date is not a date');
    }

    // Money. The invoice total is the total; the lines say where it went. Lines that do not add
    // up to it save and are flagged, never refused (§2.3): the person holding the invoice is right
    // about the total and the review queue is where the arithmetic gets sorted out.
    const linesTotal = input.lines.reduce((sum, l) => sum + l.amount, 0);
    const invoiceTotal = input.invoiceTotal ?? null;
    const total = invoiceTotal ?? (input.lines.length > 0 ? linesTotal : 0);
    const flags: string[] = [];
    if (completed && invoiceTotal === null) flags.push('cost_missing');
    if (
      completed &&
      input.invoiceFileIds.length === 0 &&
      !(input.assetType === 'truck' && (await this.leaseOperatorTruckIds(principal.companyId)).includes(input.unitId))
    )
      flags.push('invoice_missing');
    if (
      invoiceTotal !== null &&
      input.lines.length > 0 &&
      Math.abs(linesTotal - invoiceTotal) > 0.005
    )
      flags.push('lines_mismatch');
    if (input.warranty || input.chargeParty === 'warranty') flags.push('warranty_claim');

    /*
     * Who pays. A driver charge names the driver - the one given, or the one on the unit - and
     * carries the answer to "has the driver been told". Until that answer is yes the order is
     * flagged, and accounting holds the money instead of taking it off the driver's earnings.
     */
    const charge = await this.resolveCharge(principal, {
      party: input.chargeParty,
      driverId: input.chargeDriverId ?? null,
      assetType: input.assetType,
      unitId: input.unitId,
      informed: input.driverInformed ?? null,
    });
    if (charge.party === 'driver' && charge.driverInformed !== true) {
      flags.push(DRIVER_NOT_INFORMED_FLAG);
    }

    const id = `wo_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    const number = await this.nextNumber(principal.companyId);

    const row: typeof workOrders.$inferInsert = {
      id,
      companyId: principal.companyId,
      number,
      assetType: input.assetType,
      unitId: input.unitId,
      unitNumber: unit.unitNumber,
      status: input.status,
      // A stage only means something while the shop has the unit.
      shopStage: completed ? null : (input.shopStage ?? 'diagnosing'),
      workType: input.workType,
      workDone,
      title: input.title?.trim() || null,
      shopInAt,
      scheduledFor,
      completedAt,
      downtimeMinutes:
        completed && completedAt
          ? downtimeMinutes(shopInAt.toISOString(), completedAt.toISOString(), now.getTime())
          : null,
      odometer: input.assetType === 'trailer' ? null : (input.odometer ?? unit.odometer ?? null),
      pmServiceCode: oilChange ? 'OIL_CHANGE' : null,
      serviceAt: oilChange ? completedAt : null,
      serviceOdometer: oilChange ? (input.odometer ?? null) : null,
      assignedTo: input.assignedTo?.trim() || null,
      vendorId: input.vendorId ?? null,
      vendorName: input.vendorName?.trim() ?? '',
      invoiceTotal: invoiceTotal === null ? null : invoiceTotal.toFixed(2),
      total: total.toFixed(2),
      partsTotal: '0',
      laborTotal: total.toFixed(2),
      feesTotal: '0',
      // The shop's number when given; otherwise the record numbers its invoice after itself.
      invoiceNumber: input.invoiceNumber?.trim() || defaultInvoiceNumber(number),
      invoiceFileIds: input.invoiceFileIds,
      zeroReason: invoiceTotal === 0 ? (input.zeroReason ?? null) : null,
      paymentTerms: input.paymentTerms ?? null,
      chargeParty: charge.party,
      chargeDriverId: charge.driverId,
      chargeDriverName: charge.driverName,
      driverInformed: charge.driverInformed,
      driverInformedAt: charge.driverInformed === true ? now : null,
      driverInformedBy:
        charge.driverInformed === true ? (principal.userName ?? principal.userId) : null,
      enteredVia: 'work_order_form',
      flags,
      notes: input.notes?.trim() || null,
      defectId: defect?.id ?? null,
      createdBy: principal.userName ?? principal.userId,
    };

    // A trailer's tire on a truck's order is the trailer's: the trailer has to be this company's.
    const owners = [...new Set((input.tirePositions ?? []).map((t) => t.ownerUnitId).filter((u): u is string => Boolean(u) && u !== input.unitId))];
    if (owners.length > 0) {
      const found = await this.db
        .select({ id: trailers.id })
        .from(trailers)
        .where(and(eq(trailers.companyId, principal.companyId), inArray(trailers.id, owners)));
      if (found.length !== owners.length) throw new BadRequestException('A tire is filed to a trailer that is not in this company');
    }

    const timeZone = oilChange ? await this.pm.timeZone(principal.companyId) : null;
    // The odometer typed is checked like any reading (owner, 2026-10-22): a typo far above the
    // last good reading is kept as a conflict that nothing uses, and the answer says so.
    const odoCheck = oilChange && completedAt ? await this.pm.checkReading(principal.companyId, { unitId: input.unitId, readingAt: completedAt, odometerMiles: input.odometer as number, ignoreId: 'odo_wo_' + id }) : null;
    await this.db.transaction(async (tx) => {
      await tx.insert(workOrders).values(row);
      // The mileage at the oil change, kept as a reading the way the board keeps it, keyed on the
      // order so a void finds it again.
      if (oilChange && completedAt && timeZone) {
        await tx.insert(odometerReadings).values({
          id: `odo_wo_${id}`,
          companyId: principal.companyId,
          unitId: input.unitId,
          readingAt: completedAt,
          readingDate: completedAt.toLocaleDateString('en-CA', { timeZone }),
          odometerMiles: input.odometer as number,
          source: 'invoice',
          status: odoCheck?.status ?? 'ok',
          conflictReason: odoCheck?.conflictReason ?? null,
          conflictWith: odoCheck?.conflictWith ?? null,
          note: `From ${number}${row.vendorName ? ` · ${row.vendorName}` : ''}`,
          createdBy: principal.userId,
          createdByName: principal.userName ?? principal.userId,
          createdAt: now,
        });
      }
      if (input.lines.length > 0) {
        await tx.insert(workOrderLines).values(
          input.lines.map((l, i) => ({
            id: `wol_${now.getTime()}_${i}`,
            companyId: principal.companyId,
            workOrderId: id,
            systemCode: l.systemCode,
            lineKind: l.systemCode === 'pm' ? 'pm' : l.systemCode === 'fees' ? 'fee' : 'repair',
            description: l.description.trim(),
            totalAmount: l.amount.toFixed(2),
            sort: i,
          })),
        );
      }
      // The tire positions the form confirmed: a person's word, so they stand as a manual tag.
      const tires = (input.tirePositions ?? []).filter((t) => t.quantity > 0);
      if (tires.length > 0) {
        const tireCents = Math.round(
          (input.lines.filter((l) => l.systemCode === 'tires_wheels').reduce((s, l) => s + l.amount, 0) || total) * 100,
        );
        const qty = tires.reduce((s, t) => s + t.quantity, 0);
        // A tire work order prices each tire itself; otherwise the tire lines split evenly.
        const priced = tires.every((t) => typeof t.tireCostCents === 'number');
        let left = tireCents;
        const eventOn = completedAt ? completedAt.toLocaleDateString('en-CA', { timeZone: 'America/New_York' }) : null;
        await tx.insert(repairTireEvents).values(
          tires.map((t, i) => {
            const split = i === tires.length - 1 ? left : Math.round((tireCents * t.quantity) / qty);
            left -= split;
            const cents = priced ? (t.tireCostCents ?? 0) + (t.laborCents ?? 0) : split;
            const ownedElsewhere = t.ownerUnitId && t.ownerUnitId !== input.unitId;
            return {
              id: `rte_${crypto.randomUUID()}`,
              companyId: principal.companyId,
              recordKind: 'work_order',
              recordId: id,
              unitId: ownedElsewhere ? (t.ownerUnitId as string) : input.unitId,
              unitKind: ownedElsewhere ? (t.ownerUnitKind ?? 'trailer') : input.assetType,
              positionId: t.positionId,
              eventType: t.eventType,
              quantity: t.quantity,
              allocatedCostCents: cents,
              source: 'manual',
              confidence: '1',
              note: null,
              parsedFrom: null,
              action: t.action ?? null,
              brand: t.brand?.trim() || null,
              model: t.model?.trim() || null,
              reason: t.reason?.trim() || null,
              treadRemoved32: t.treadRemoved32 === null || t.treadRemoved32 === undefined ? null : String(t.treadRemoved32),
              tireCostCents: t.tireCostCents ?? null,
              laborCents: t.laborCents ?? null,
              odometer: ownedElsewhere ? null : (input.odometer ?? null),
              vendorName: input.vendorName?.trim() || null,
              recordedOnUnitId: ownedElsewhere ? input.unitId : null,
              eventOn,
              createdBy: principal.userName ?? principal.userId,
            };
          }),
        );
      }
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'created',
          stage: row.shopStage as ShopStage | null,
          note: completed ? 'Recorded as completed' : null,
          principal,
          at: now,
        }),
      );
      if (completed) {
        await this.applyServiceReset(
          tx,
          principal,
          row.assetType as 'truck' | 'trailer',
          row.unitId,
          row.workType as WorkType,
          now,
          row.odometer ?? null,
        );
      }
    });

    // The defect follows the order: into repair while the shop has the unit, and, when the order
    // is written up already finished, to awaiting-verify. Never to verified (§4.4).
    if (defect) {
      await this.pti.transition(principal, defect.id, {
        version: defect.version,
        to: 'in_repair',
        note: `${number} opened`,
        reason: null,
        fixedVia: null,
        workOrderId: id,
        workOrderNumber: number,
        ownerId: null,
      });
      if (completed) await this.pti.workOrderClosed(principal, id);
    }

    if (completed && isFeatureEnabled('pm_module'))
      await this.pm.recompute(principal.companyId, [input.unitId]);

    // Read back rather than echo the insert: the timestamps are the database's defaults, and an
    // echo without them was answering 500 to every create.
    const saved = await this.require(principal, id);
    return { ...this.toWorkOrder(saved, null, now.getTime()), odometerWarning: odoCheck?.message ?? null };
  }

  /**
   * Moves every order of one vendor record onto another (owner, 2026-10-14: the same shop entered
   * twice). Orders keep their history; each move is audited. The old vendor record itself lives in
   * the workspace and is retired by the caller, never deleted.
   */
  async mergeVendor(principal: Principal, input: MergeVendorInput): Promise<{ moved: number }> {
    if (input.fromVendorId === input.toVendorId) throw new BadRequestException('Pick a different vendor to merge into');
    const rows = await this.db
      .select({ id: workOrders.id, number: workOrders.number, vendorName: workOrders.vendorName })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.vendorId, input.fromVendorId)));
    if (rows.length === 0) return { moved: 0 };
    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({ vendorId: input.toVendorId, vendorName: input.toVendorName, updatedAt: new Date() })
        .where(and(eq(workOrders.companyId, principal.companyId), eq(workOrders.vendorId, input.fromVendorId)));
      for (const r of rows)
        await this.audit.writeIn(tx, principal, {
          action: 'fleet.work_order.vendor_merged',
          entityType: 'work_order',
          entityId: r.id,
          entityLabel: r.number,
          summary: `Vendor merged: ${r.vendorName} → ${input.toVendorName}`,
          changes: [
            { field: 'vendorId', old: input.fromVendorId, new: input.toVendorId },
            { field: 'vendorName', old: r.vendorName, new: input.toVendorName },
          ],
          reason: input.reason,
        });
    });
    return { moved: rows.length };
  }

  /**
   * The trailer a truck pulls now, for the tire work order: the truck's own record, else the
   * trailer on its most recent load. A guess the form shows and the person can change.
   */
  async hookedTrailer(principal: Principal, truckId: string): Promise<{ trailerId: string | null; trailerNumber: string | null; source: 'truck' | 'load' | null }> {
    const [truck] = await this.db
      .select({ trailerId: trucks.currentTrailerId })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, truckId)))
      .limit(1);
    let trailerId = truck?.trailerId ?? null;
    let source: 'truck' | 'load' | null = trailerId ? 'truck' : null;
    if (!trailerId) {
      const [load] = await this.db
        .select({ trailerId: loadsTable.trailerId })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, principal.companyId), eq(loadsTable.truckId, truckId), isNotNull(loadsTable.trailerId), eq(loadsTable.isDemo, false)))
        .orderBy(desc(loadsTable.updatedAt))
        .limit(1);
      trailerId = load?.trailerId ?? null;
      source = trailerId ? 'load' : null;
    }
    if (!trailerId) return { trailerId: null, trailerNumber: null, source: null };
    const [trailer] = await this.db
      .select({ id: trailers.id, number: trailers.unitNumber })
      .from(trailers)
      .where(and(eq(trailers.companyId, principal.companyId), eq(trailers.id, trailerId)))
      .limit(1);
    return trailer ? { trailerId: trailer.id, trailerNumber: trailer.number, source } : { trailerId: null, trailerNumber: null, source: null };
  }

  /** Field edits that are not the lifecycle: what was done, the odometer, who has it. */
  async update(principal: Principal, id: string, input: UpdateWorkOrderInput): Promise<WorkOrder> {
    const row = await this.require(principal, id);
    const patch: Partial<typeof workOrders.$inferInsert> = { updatedAt: new Date() };
    if (input.workType !== undefined) patch.workType = input.workType;
    if (input.workDone !== undefined) patch.workDone = input.workDone.trim() || null;
    if (input.odometer !== undefined) patch.odometer = input.odometer;
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo?.trim() || null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.shopInAt !== undefined) {
      const at = new Date(input.shopInAt);
      if (Number.isNaN(at.getTime()))
        throw new BadRequestException('That shop-in date is not a date');
      patch.shopInAt = at;
    }

    await this.db.update(workOrders).set(patch).where(eq(workOrders.id, id));
    return this.toWorkOrder({ ...row, ...patch } as Row, null, Date.now());
  }

  /**
   * A booked work order taken into the shop (owner, 2026-10-30). Only a scheduled order: the same
   * record becomes In the shop - the unit leaves dispatch - with the fields the person corrected
   * on the way in. Written to the order's history and the audit log.
   */
  async checkIn(principal: Principal, id: string, input: CheckInWorkOrderInput): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    if (row.voidedAt) throw new BadRequestException('That work order is voided');
    if (row.status !== 'scheduled') {
      throw new ConflictException(`${row.number} is ${row.status === 'in_shop' ? 'already in the shop' : row.status}; reload it.`);
    }
    const now = new Date();
    const shopInAt = input.shopInAt ? new Date(input.shopInAt) : now;
    if (Number.isNaN(shopInAt.getTime())) throw new BadRequestException('That shop-in date is not a date');
    if (shopInAt.getTime() > now.getTime() + 60_000) throw new BadRequestException('The unit cannot go into the shop in the future');
    const patch: Partial<typeof workOrders.$inferInsert> = { status: 'in_shop', shopStage: 'diagnosing', shopInAt, updatedAt: now };
    if (input.workType !== undefined) patch.workType = input.workType;
    if (input.title !== undefined) patch.title = input.title.trim() || null;
    if (input.vendorId !== undefined) patch.vendorId = input.vendorId;
    if (input.vendorName !== undefined) patch.vendorName = input.vendorName.trim();
    if (input.assignedTo !== undefined) patch.assignedTo = input.assignedTo?.trim() || null;
    if (input.notes !== undefined) patch.notes = input.notes?.trim() || null;
    if (input.invoiceNumber !== undefined) patch.invoiceNumber = input.invoiceNumber?.trim() || defaultInvoiceNumber(row.number);
    const changes = (Object.keys(patch) as Array<keyof typeof patch>)
      .filter((k) => k !== 'updatedAt' && k !== 'shopStage')
      .map((k) => {
        const before = (row as Record<string, unknown>)[k];
        const after = patch[k];
        const text = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : String(v));
        return { field: String(k), old: text(before), new: text(after) };
      })
      .filter((c) => c.old !== c.new);
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set(patch).where(and(eq(workOrders.id, id), eq(workOrders.companyId, principal.companyId), eq(workOrders.status, 'scheduled')));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'stage_changed',
          stage: 'diagnosing',
          note: `Into the shop${row.scheduledFor ? ` (booked for ${row.scheduledFor.toLocaleDateString('en-US', { timeZone: 'America/New_York' })})` : ''}`,
          principal,
          at: now,
        }),
      );
      await this.audit.writeIn(tx, principal, {
        action: 'status_change',
        entityType: 'work_order',
        entityId: id,
        entityLabel: row.number,
        summary: `${row.number} into the shop: scheduled → in shop`,
        changes,
      });
    });
    if (row.workType === 'oil_change' && isFeatureEnabled('pm_module')) await this.pm.recompute(principal.companyId, [row.unitId]);
    return this.detail(principal, id);
  }

  /**
   * Moves a work order to another shop stage, and writes it down.
   *
   * Only while the shop has the unit: a stage on a finished record would be describing work that
   * is over. The note is where the useful part usually is ("ordered air compressor, ETA Friday"),
   * which is why it is kept as history rather than overwriting the last one.
   */
  async changeStage(
    principal: Principal,
    id: string,
    input: ChangeShopStageInput,
  ): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    if (row.status !== 'in_shop') {
      throw new BadRequestException('That work order is completed; its stage cannot change');
    }
    if (!SHOP_STAGES.includes(input.stage)) throw new BadRequestException('Unknown shop stage');

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({ shopStage: input.stage, updatedAt: now })
        .where(eq(workOrders.id, id));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'stage_changed',
          stage: input.stage,
          note: input.note?.trim() || null,
          principal,
          at: now,
        }),
      );
    });
    return this.detail(principal, id);
  }

  /**
   * A note on the order (owner, 2026-10-15: "Add note" on a truck in maintenance). Its own entry,
   * with who wrote it and when; it changes nothing else. A voided order takes no notes.
   */
  async addNote(principal: Principal, id: string, input: AddWorkOrderNoteInput): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    if (row.voidedAt) throw new BadRequestException('That work order is voided; it takes no notes');
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set({ updatedAt: now }).where(eq(workOrders.id, id));
      await tx.insert(workOrderActions).values(this.actionRow(id, { action: 'note_added', stage: null, note: input.note.trim(), principal, at: now }));
    });
    return this.detail(principal, id);
  }

  /**
   * Completes a work order.
   *
   * Three things happen at once and all of them are consequences of the same fact. Downtime is
   * frozen, so a closed record's duration never moves again. The service clock the work type
   * belongs to is reset, which is what takes the unit off the Today board. And the description
   * becomes required, because this is the last moment anybody remembers what was done.
   */
  async complete(
    principal: Principal,
    id: string,
    input: CompleteWorkOrderInput,
  ): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    if (row.status === 'completed')
      throw new BadRequestException('That work order is already completed');
    if (!input.workDone.trim())
      throw new BadRequestException('Say what was done before completing it');

    const completedAt = input.completedAt ? new Date(input.completedAt) : new Date();
    if (Number.isNaN(completedAt.getTime()))
      throw new BadRequestException('That completion date is not a date');
    // An appointment completed before its slot went into the shop when it was completed; the
    // check below is for orders the shop actually had.
    const shopInAt =
      row.status === 'scheduled' && completedAt.getTime() < row.shopInAt.getTime()
        ? completedAt
        : row.shopInAt;
    if (completedAt.getTime() < shopInAt.getTime()) {
      throw new BadRequestException('It cannot come out of the shop before it went in');
    }

    const odometer = row.assetType === 'trailer' ? null : (input.odometer ?? row.odometer ?? null);
    // An oil change closed here is the board's baseline too, and only once (owner, 2026-10-18).
    const oilChange = row.assetType === 'truck' && row.workType === 'oil_change' && odometer !== null;
    if (oilChange) {
      const twin = await this.oilChangeNear(principal.companyId, row.unitId, completedAt, row.id);
      if (twin) {
        throw new BadRequestException(
          `This oil change is already recorded as ${twin.number}. Void this one instead of completing it.`,
        );
      }
    }
    const timeZone = oilChange ? await this.pm.timeZone(principal.companyId) : null;
    const odoCheck = oilChange ? await this.pm.checkReading(principal.companyId, { unitId: row.unitId, readingAt: completedAt, odometerMiles: odometer as number, ignoreId: 'odo_wo_' + row.id }) : null;

    await this.db.transaction(async (tx) => {
      if (oilChange && timeZone) {
        await tx.delete(odometerReadings).where(eq(odometerReadings.id, `odo_wo_${row.id}`));
        await tx.insert(odometerReadings).values({
          id: `odo_wo_${row.id}`,
          companyId: principal.companyId,
          unitId: row.unitId,
          readingAt: completedAt,
          readingDate: completedAt.toLocaleDateString('en-CA', { timeZone }),
          odometerMiles: odometer as number,
          source: 'invoice',
          status: odoCheck?.status ?? 'ok',
          conflictReason: odoCheck?.conflictReason ?? null,
          conflictWith: odoCheck?.conflictWith ?? null,
          note: `From ${row.number}${row.vendorName ? ` · ${row.vendorName}` : ''}`,
          createdBy: principal.userId,
          createdByName: principal.userName ?? principal.userId,
          createdAt: new Date(),
        });
      }
      await tx
        .update(workOrders)
        .set({
          status: 'completed',
          shopStage: null,
          shopInAt,
          workDone: input.workDone.trim(),
          completedAt,
          odometer,
          ...(oilChange ? { pmServiceCode: 'OIL_CHANGE', serviceAt: completedAt, serviceOdometer: odometer } : {}),
          downtimeMinutes: downtimeMinutes(
            shopInAt.toISOString(),
            completedAt.toISOString(),
            completedAt.getTime(),
          ),
          updatedAt: completedAt,
        })
        .where(eq(workOrders.id, id));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'completed',
          stage: null,
          note: input.workDone.trim(),
          principal,
          at: completedAt,
        }),
      );
      await this.applyServiceReset(
        tx,
        principal,
        row.assetType as 'truck' | 'trailer',
        row.unitId,
        row.workType as WorkType,
        completedAt,
        odometer,
      );
    });

    // A closed work order proposes closure of its defects; a person verifies (§4.4).
    await this.pti.workOrderClosed(principal, id);
    // The PM verdict follows whatever baseline the completion moved (Phase 1A; the completion
    // form of Phase 1E is what makes an oil change a baseline at all).
    if (isFeatureEnabled('pm_module')) await this.pm.recompute(principal.companyId, [row.unitId]);

    return { ...(await this.detail(principal, id)), odometerWarning: odoCheck?.message ?? null };
  }

  /**
   * Puts a completed work order back in the shop.
   *
   * Restricted to whoever may edit the roster, not because mechanics are untrusted but because a
   * completed record has already moved money and reset a service clock. It is logged either way.
   */
  async reopen(principal: Principal, id: string, note?: string): Promise<WorkOrderDetail> {
    if (!hasPermission(principal, 'trucks.edit')) {
      throw new ForbiddenException('Only a fleet manager or administrator can reopen a work order');
    }
    const row = await this.require(principal, id);
    if (row.status !== 'completed')
      throw new BadRequestException('That work order is not completed');

    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({
          status: 'in_shop',
          shopStage: 'in_repair',
          completedAt: null,
          downtimeMinutes: null,
          updatedAt: now,
        })
        .where(eq(workOrders.id, id));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'reopened',
          stage: 'in_repair',
          note: note?.trim() || null,
          principal,
          at: now,
        }),
      );
    });
    return this.detail(principal, id);
  }

  /**
   * Voids a work order entered by mistake (owner, 2026-09-30), most often a duplicate. The row is
   * kept and marked - who, when, why - and the history gets a line; every list, the spend reports
   * and the dashboard already leave voided orders out. Refused while the order still drives
   * something that would be left dangling: the unit in the shop on it, a driver charge, or a bill
   * in Accounts Payable. Those are undone where they live first.
   */
  async void(principal: Principal, id: string, input: VoidWorkOrderInput): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    if (row.voidedAt) throw new BadRequestException(`${row.number} is already void`);
    if (row.status === 'in_shop') {
      throw new BadRequestException(
        `The unit is still in the shop on ${row.number}. Complete it first, then void it.`,
      );
    }
    if (row.chargeParty === 'driver') {
      throw new BadRequestException(
        `${row.number} is charged to a driver. Change "Who pays" to the company first, so the driver's deduction is withdrawn.`,
      );
    }
    const [bill] = await this.db
      .select({ billNumber: acctBills.billNumber, status: acctBills.status })
      .from(acctBills)
      .where(
        and(
          eq(acctBills.companyId, principal.companyId),
          inArray(acctBills.sourceKey, [`repair_order:${id}`, `work_order:${id}`]),
        ),
      )
      .limit(1);
    if (bill && bill.status !== 'void') {
      throw new BadRequestException(
        `${row.number} is billed in Accounts Payable as ${bill.billNumber}. Void that bill first.`,
      );
    }
    const now = new Date();
    const who = principal.userName ?? principal.userId;
    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({ voidedAt: now, voidedBy: who, voidReason: input.reason.trim(), pmServiceCode: null, updatedAt: now })
        .where(and(eq(workOrders.id, id), eq(workOrders.companyId, principal.companyId), isNull(workOrders.voidedAt)));
      // The mileage it gave the oil change board goes with it.
      await tx
        .update(odometerReadings)
        .set({ status: 'void', voidedAt: now, voidReason: input.reason.trim() })
        .where(and(eq(odometerReadings.id, `odo_wo_${id}`), eq(odometerReadings.companyId, principal.companyId)));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, { action: 'voided', stage: null, note: input.reason.trim(), principal, at: now }),
      );
    });
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'work_order',
      entityId: id,
      entityLabel: row.number,
      summary: `Voided: ${input.reason.trim()}`,
      changes: [{ field: 'voided', old: null, new: now.toISOString() }],
      reason: input.reason.trim(),
    });
    if (row.workType === 'oil_change' && isFeatureEnabled('pm_module'))
      await this.pm.recompute(principal.companyId, [row.unitId]);
    return this.detail(principal, id);
  }

  /**
   * Attaches the shop's invoice to a record that was written up without it.
   *
   * The file is one the company already stored; the number and the total are what it says. The
   * record's own total follows the invoice, and the review flags the missing paperwork raised are
   * cleared, because the paperwork is now there. Written to the history like every other change.
   */
  async attachInvoice(
    principal: Principal,
    id: string,
    input: AttachInvoiceInput,
  ): Promise<WorkOrderDetail> {
    const row = await this.require(principal, id);
    const [file] = await this.db
      .select({ id: storedFiles.id, fileName: storedFiles.fileName })
      .from(storedFiles)
      .where(and(eq(storedFiles.id, input.fileId), eq(storedFiles.companyId, principal.companyId)))
      .limit(1);
    if (!file) throw new NotFoundException('That file was not uploaded');

    const existing = Array.isArray(row.invoiceFileIds) ? (row.invoiceFileIds as string[]) : [];
    const flags = (Array.isArray(row.flags) ? (row.flags as string[]) : []).filter(
      (f) => f !== 'invoice_missing' && (input.invoiceTotal == null || f !== 'cost_missing'),
    );
    const now = new Date();
    const patch: Partial<typeof workOrders.$inferInsert> = {
      invoiceFileIds: existing.includes(file.id) ? existing : [...existing, file.id],
      flags,
      updatedAt: now,
    };
    if (input.invoiceNumber !== undefined)
      patch.invoiceNumber = input.invoiceNumber?.trim() || null;
    if (input.invoiceTotal !== undefined && input.invoiceTotal !== null) {
      patch.invoiceTotal = input.invoiceTotal.toFixed(2);
      patch.total = input.invoiceTotal.toFixed(2);
      patch.laborTotal = input.invoiceTotal.toFixed(2);
    }
    await this.db.transaction(async (tx) => {
      await tx.update(workOrders).set(patch).where(eq(workOrders.id, id));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'note_added',
          stage: null,
          note: `Invoice attached: ${file.fileName}${input.invoiceNumber?.trim() ? ` · #${input.invoiceNumber.trim()}` : ''}`,
          principal,
          at: now,
        }),
      );
    });
    return this.detail(principal, id);
  }

  // ------------------------------------------------------------------------------- serialising

  private maySeeCost(principal: Principal): boolean {
    return hasPermission(principal, MAINTENANCE_COST_PERMISSION);
  }

  /**
   * The shape without money.
   *
   * There is no `total` here to set to zero or to null, which is the whole idea: a response built
   * from this cannot carry a price, however the caller behaves afterwards.
   */
  /** Unit id → the name of the driver on it, for the list; read once per request. */
  private driverNames = new Map<string, string>();

  private async loadDriverNames(companyId: string): Promise<void> {
    const rows = await this.db
      .select({ unitId: trucks.id, first: drivers.firstName, last: drivers.lastName })
      .from(trucks)
      .innerJoin(drivers, eq(drivers.id, trucks.currentDriverId))
      .where(eq(trucks.companyId, companyId));
    this.driverNames = new Map(rows.map((r) => [r.unitId, `${r.first} ${r.last}`.trim()]));
  }

  private toWorkOrder(row: Row, lastAction: WorkOrderAction | null, now: number): WorkOrder {
    return {
      id: row.id,
      number: row.number,
      assetType: row.assetType as 'truck' | 'trailer',
      unitId: row.unitId,
      unitNumber: row.unitNumber,
      status: row.status as WorkOrderStatus,
      shopStage: (row.shopStage as ShopStage | null) ?? null,
      workType: row.workType as WorkType,
      workDone: row.workDone,
      shopInAt: row.shopInAt.toISOString(),
      completedAt: row.completedAt?.toISOString() ?? null,
      downtimeMinutes:
        row.downtimeMinutes ??
        downtimeMinutes(row.shopInAt.toISOString(), row.completedAt?.toISOString() ?? null, now),
      odometer: row.odometer,
      assignedTo: row.assignedTo,
      label: workOrderLabel(row.unitNumber, row.workType as WorkType),
      lastAction,
      defectId: row.defectId ?? null,
      pmServiceCode: row.pmServiceCode ?? null,
      scheduledFor: row.scheduledFor?.toISOString() ?? null,
      responsibleName: row.responsibleName ?? null,
      vendorName: row.vendorName ?? null,
      driverName: this.driverNames.get(row.unitId) ?? null,
      charge: {
        party: (row.chargeParty as WorkOrderChargeParty) ?? 'company',
        driverId: row.chargeDriverId ?? null,
        driverName: row.chargeDriverName ?? null,
        driverInformed: row.driverInformed ?? null,
        informedAt: row.driverInformedAt?.toISOString() ?? null,
        informedBy: row.driverInformedBy ?? null,
      },
      voided: row.voidedAt
        ? { at: row.voidedAt.toISOString(), by: row.voidedBy ?? null, reason: row.voidReason ?? null }
        : null,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  private toWorkOrderWithCost(
    row: Row,
    lastAction: WorkOrderAction | null,
    now: number,
  ): WorkOrderWithCost {
    return {
      ...this.toWorkOrder(row, lastAction, now),
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      partsTotal: Number(row.partsTotal),
      laborTotal: Number(row.laborTotal),
      feesTotal: Number(row.feesTotal),
      total: Number(row.total),
      estimatedCost:
        row.estimatedCost === null || row.estimatedCost === undefined
          ? null
          : Number(row.estimatedCost),
      invoiceTotal:
        row.invoiceTotal === null || row.invoiceTotal === undefined
          ? null
          : Number(row.invoiceTotal),
      invoiceNumber: row.invoiceNumber,
      invoiceFileIds: Array.isArray(row.invoiceFileIds) ? (row.invoiceFileIds as string[]) : [],
    };
  }

  // ------------------------------------------------------------------------------------ helpers

  private async require(principal: Principal, id: string): Promise<Row> {
    const [row] = await this.db
      .select()
      .from(workOrders)
      .where(and(eq(workOrders.id, id), eq(workOrders.companyId, principal.companyId)))
      .limit(1);
    if (!row) throw new NotFoundException('That work order does not exist');
    return row;
  }

  /** The unit, so a work order can never point at something that is not in this company's fleet. */
  /**
   * Who a charge belongs to.
   *
   * A company expense carries no driver and no answer. A driver charge names a driver - the one
   * chosen, or failing that whoever is on the unit - and keeps the yes/no it was given. Naming a
   * driver who is not on this company's roster is refused rather than stored as a loose string.
   */
  private async resolveCharge(
    principal: Principal,
    input: {
      party: WorkOrderChargeParty;
      driverId: string | null;
      assetType: 'truck' | 'trailer';
      unitId: string;
      informed: boolean | null;
    },
  ): Promise<WorkOrderCharge> {
    // Under investigation names the driver in question when there is one (given, or on the unit)
    // so it shows on that driver; nothing is charged. A warranty claim is nobody's on the roster.
    if (input.party === 'investigation') {
      let driverId = input.driverId;
      if (!driverId && input.assetType === 'truck') {
        const [truck] = await this.db
          .select({ driverId: trucks.currentDriverId })
          .from(trucks)
          .where(and(eq(trucks.id, input.unitId), eq(trucks.companyId, principal.companyId)))
          .limit(1);
        driverId = truck?.driverId ?? null;
      }
      const [driver] = driverId
        ? await this.db
            .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName })
            .from(drivers)
            .where(and(eq(drivers.id, driverId), eq(drivers.companyId, principal.companyId)))
            .limit(1)
        : [];
      return {
        party: 'investigation',
        driverId: driver?.id ?? null,
        driverName: driver ? `${driver.first} ${driver.last}`.trim() : null,
        driverInformed: null,
        informedAt: null,
        informedBy: null,
      };
    }
    if (input.party !== 'driver') {
      return {
        party: input.party === 'warranty' ? 'warranty' : 'company',
        driverId: null,
        driverName: null,
        driverInformed: null,
        informedAt: null,
        informedBy: null,
      };
    }
    let driverId = input.driverId;
    if (!driverId && input.assetType === 'truck') {
      const [truck] = await this.db
        .select({ driverId: trucks.currentDriverId })
        .from(trucks)
        .where(and(eq(trucks.id, input.unitId), eq(trucks.companyId, principal.companyId)))
        .limit(1);
      driverId = truck?.driverId ?? null;
    }
    if (!driverId) {
      throw new BadRequestException(
        'A driver charge needs a driver: this unit has nobody on it, so pick the driver to charge',
      );
    }
    const [driver] = await this.db
      .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.id, driverId), eq(drivers.companyId, principal.companyId)))
      .limit(1);
    if (!driver) throw new NotFoundException('That driver is not on the roster');
    return {
      party: 'driver',
      driverId: driver.id,
      driverName: `${driver.first} ${driver.last}`.trim(),
      driverInformed: input.informed ?? false,
      informedAt: null,
      informedBy: null,
    };
  }

  /**
   * Change who pays, or record that the driver has now been told.
   *
   * This is the door the held money goes out of: accounting may take a driver charge off what the
   * driver earned only once this has been called with `driverInformed: true`. Every call writes an
   * audit entry and a line in the order's own history, because it moves money between two people.
   */
  async setCharge(
    principal: Principal,
    id: string,
    input: SetWorkOrderChargeInput,
  ): Promise<WorkOrder> {
    const before = await this.require(principal, id);
    // Safety may settle an investigation (owner, 2026-10-13); changing any other payer is Fleet's.
    const safetySettles =
      hasPermission(principal, 'compliance.manage') && before.chargeParty === 'investigation';
    if (!hasPermission(principal, 'maintenance.edit') && !safetySettles) {
      throw new ForbiddenException('You cannot change who pays for a repair');
    }
    const charge = await this.resolveCharge(principal, {
      party: input.party,
      driverId: input.driverId ?? before.chargeDriverId ?? null,
      assetType: before.assetType as 'truck' | 'trailer',
      unitId: before.unitId,
      informed: input.driverInformed ?? null,
    });
    const now = new Date();
    const informedNow = charge.party === 'driver' && charge.driverInformed === true;
    // The flag is the list's version of the same fact, so it is rewritten, never appended to.
    const flags = (Array.isArray(before.flags) ? (before.flags as string[]) : []).filter(
      (f) => f !== DRIVER_NOT_INFORMED_FLAG,
    );
    if (charge.party === 'driver' && !informedNow) flags.push(DRIVER_NOT_INFORMED_FLAG);
    const informedAt = informedNow
      ? before.driverInformed === true
        ? before.driverInformedAt
        : now
      : null;
    const informedBy = informedNow
      ? before.driverInformed === true
        ? before.driverInformedBy
        : (principal.userName ?? principal.userId)
      : null;

    await this.db.transaction(async (tx) => {
      await tx
        .update(workOrders)
        .set({
          chargeParty: charge.party,
          chargeDriverId: charge.driverId,
          chargeDriverName: charge.driverName,
          driverInformed: charge.driverInformed,
          driverInformedAt: informedAt,
          driverInformedBy: informedBy,
          flags,
          updatedAt: now,
        })
        .where(and(eq(workOrders.id, id), eq(workOrders.companyId, principal.companyId)));
      await tx.insert(workOrderActions).values(
        this.actionRow(id, {
          action: 'note_added',
          stage: null,
          note:
            charge.party === 'driver'
              ? `Charged to ${charge.driverName ?? 'the driver'} - driver ${informedNow ? 'informed' : 'not informed yet'}${input.note ? ` - ${input.note}` : ''}`
              : `${chargeWords(charge.party)}${input.note ? ` - ${input.note}` : ''}`,
          principal,
          at: now,
        }),
      );
    });

    await this.audit.write(principal, {
      action: 'fleet.work_order.charge_changed',
      entityType: 'work_order',
      entityId: id,
      entityLabel: before.number,
      summary:
        charge.party === 'driver'
          ? `${before.number} charged to ${charge.driverName ?? 'a driver'}, driver ${informedNow ? 'informed' : 'NOT informed'}`
          : `${before.number}: ${chargeWords(charge.party).toLowerCase()}`,
      changes: [
        { field: 'chargeParty', old: before.chargeParty ?? 'company', new: charge.party },
        { field: 'chargeDriverName', old: before.chargeDriverName ?? null, new: charge.driverName },
        {
          field: 'driverInformed',
          old:
            before.driverInformed === null || before.driverInformed === undefined
              ? null
              : String(before.driverInformed),
          new: charge.driverInformed === null ? null : String(charge.driverInformed),
        },
      ],
      reason: input.note ?? null,
    });

    return this.readBack(principal, id);
  }

  /** The order as a list reads it, after a write. */
  private async readBack(principal: Principal, id: string): Promise<WorkOrder> {
    const row = await this.require(principal, id);
    await this.loadDriverNames(principal.companyId);
    const actions = await this.latestActions([id]);
    return this.toWorkOrder(row, actions.get(id) ?? null, Date.now());
  }

  private async requireUnit(
    principal: Principal,
    assetType: 'truck' | 'trailer',
    unitId: string,
  ): Promise<{ unitNumber: string; odometer: number | null }> {
    if (assetType === 'truck') {
      const [row] = await this.db
        .select({ unitNumber: trucks.unitNumber, odometer: trucks.odometer })
        .from(trucks)
        .where(and(eq(trucks.id, unitId), eq(trucks.companyId, principal.companyId)))
        .limit(1);
      if (!row) throw new NotFoundException('That truck is not in the fleet');
      return { unitNumber: row.unitNumber, odometer: row.odometer };
    }
    const [row] = await this.db
      .select({ unitNumber: trailers.unitNumber })
      .from(trailers)
      .where(and(eq(trailers.id, unitId), eq(trailers.companyId, principal.companyId)))
      .limit(1);
    if (!row) throw new NotFoundException('That trailer is not in the fleet');
    return { unitNumber: row.unitNumber, odometer: null };
  }

  /** `RO-2026-1041`, continuing the series the workspace already used. */
  private async nextNumber(companyId: string): Promise<string> {
    const year = new Date().getFullYear();
    const rows = await this.db
      .select({ number: workOrders.number })
      .from(workOrders)
      .where(eq(workOrders.companyId, companyId));
    const highest = rows.reduce((max, row) => {
      const tail = Number.parseInt(row.number.replace(/\D/g, '').slice(-4), 10);
      return Number.isNaN(tail) ? max : Math.max(max, tail);
    }, 1000);
    return `RO-${year}-${highest + 1}`;
  }

  private actionRow(
    workOrderId: string,
    input: {
      action: WorkOrderAction['action'];
      stage: ShopStage | null;
      note: string | null;
      principal: Principal;
      at: Date;
    },
  ): typeof workOrderActions.$inferInsert {
    return {
      id: `woa_${input.at.getTime()}_${Math.random().toString(36).slice(2, 8)}`,
      workOrderId,
      action: input.action,
      stage: input.stage,
      note: input.note,
      userId: input.principal.userId,
      userName: input.principal.userName ?? input.principal.userId,
      createdAt: input.at,
    };
  }

  private async latestActions(ids: string[]): Promise<Map<string, WorkOrderAction>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select()
      .from(workOrderActions)
      .where(inArray(workOrderActions.workOrderId, ids))
      .orderBy(asc(workOrderActions.createdAt));
    const latest = new Map<string, WorkOrderAction>();
    for (const row of rows) latest.set(row.workOrderId, toAction(row));
    return latest;
  }

  /**
   * Resets the service clock the completed work belongs to.
   *
   * This is what takes a unit off the Today board, and it is why the work type matters more than
   * the description: an oil change resets the oil clock, a PM resets the PM clock, and a repair
   * resets nothing however thoroughly it was done.
   */
  /**
   * A completed oil change on the unit within a day of `at`, from either door - Repairs or the
   * Oil change board. The same invoice entered twice is what billed it twice (owner, 2026-10-18).
   */
  async oilChangeNear(
    companyId: string,
    unitId: string,
    at: Date,
    exceptId?: string,
  ): Promise<{ id: string; number: string; completedAt: Date | null } | null> {
    const rows = await this.db
      .select({ id: workOrders.id, number: workOrders.number, completedAt: workOrders.completedAt })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.unitId, unitId),
          eq(workOrders.assetType, 'truck'),
          eq(workOrders.workType, 'oil_change'),
          eq(workOrders.status, 'completed'),
          isNull(workOrders.voidedAt),
        ),
      );
    const day = 36 * 3_600_000;
    return (
      rows.find(
        (r) => r.id !== exceptId && r.completedAt && Math.abs(r.completedAt.getTime() - at.getTime()) <= day,
      ) ?? null
    );
  }

  private async applyServiceReset(
    tx: Parameters<Parameters<typeof this.db.transaction>[0]>[0],
    principal: Principal,
    assetType: 'truck' | 'trailer',
    unitId: string,
    workType: WorkType,
    at: Date,
    odometer: number | null,
  ): Promise<void> {
    const clock = SERVICE_RESETTING_TYPES[workType];
    if (!clock) return;

    const patch: Partial<typeof unitMaintenanceSettings.$inferInsert> = { updatedAt: at };
    if (clock === 'oil') {
      patch.lastOilChangeAt = at;
      patch.lastOilChangeOdometer = odometer;
    } else if (clock === 'pm') {
      patch.lastPmAt = at;
      patch.lastPmOdometer = odometer;
    } else {
      patch.lastAnnualInspectionAt = at;
    }

    await tx
      .insert(unitMaintenanceSettings)
      .values({
        id: `ums_${principal.companyId}_${assetType}_${unitId}`,
        companyId: principal.companyId,
        assetType,
        unitId,
        ...patch,
      })
      .onConflictDoUpdate({
        target: [
          unitMaintenanceSettings.companyId,
          unitMaintenanceSettings.assetType,
          unitMaintenanceSettings.unitId,
        ],
        set: patch,
      });
  }
}

function toAction(row: ActionRow): WorkOrderAction {
  return {
    id: row.id,
    action: row.action as WorkOrderAction['action'],
    stage: (row.stage as ShopStage | null) ?? null,
    note: row.note,
    userName: row.userName,
    createdAt: row.createdAt.toISOString(),
  };
}

/** How a non-driver payer reads in the history and the audit. */
function chargeWords(party: WorkOrderChargeParty): string {
  if (party === 'investigation') return 'Under investigation - who pays is not decided yet';
  if (party === 'warranty') return 'Warranty claim - claimed back from the maker or the shop';
  return 'Charged to the company';
}
