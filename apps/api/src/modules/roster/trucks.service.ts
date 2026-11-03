import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, ne, not, or, sql } from 'drizzle-orm';
import {
  ARCHIVED_TRUCK_STATUS,
  FIRST_SERVICE_DAYS,
  INACTIVE_TRUCK_STATUSES,
  TRUCK_VENDOR_KIND,
  companyBpsOf,
  percentToBps,
  vendorShareBps,
  type ChangeTruckVendorPercentRequest,
  type CreateTruckRequest,
  type EndTruckVendorRequest,
  type MoveTruckToVendorRequest,
  type RosterPage,
  type RosterQuery,
  type TruckRecord,
  type UpdateTruckRequest,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { drivers, trucks } from '../../database/schema/roster';
import { acctVendorArrangements } from '../../database/schema/accounting';
import { vendors } from '../../database/schema/fleet';
import { AuditService, type AuditEvent } from '../people/audit.service';
import { AssignmentsService } from './assignments.service';
import { easternToday } from './driver-archive.data';
import { toTruckRecord } from './roster.mapper';
import { archiveTruck, restoreTruck, type TruckArchiveResult } from './truck-archive.data';
import { arrangementsFor, truckVendorOwners, truckVendorsOn } from './truck-vendor.data';

/** A calendar day as the `YYYY-MM-DD` the records store. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/*
 * The details a unit may not have yet — plate, plate state, colour, home terminal — are optional
 * on creation. Their columns are still NOT NULL, so until the migration that relaxes them lands
 * an absent detail is held as an empty string, which the web reads as "Not set" exactly as it
 * reads `null`. `in_service_date` is a NOT NULL date column with no empty form, so an absent
 * in-service date is stored as the day the unit was added (the day its first PM is measured
 * from) until that migration lands.
 */

/**
 * Trucks.
 *
 * Every query is filtered by `principal.companyId` and every insert stamps it. A record whose
 * company is set from anything other than the authenticated session is a record that either leaks
 * across carriers or — the failure this module was written to end — is written with no company at
 * all and then never matches the list query that would have shown it.
 */
@Injectable()
export class TrucksService {
  constructor(
    private readonly database: DatabaseService,
    private readonly assignments: AssignmentsService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal, query: RosterQuery): Promise<RosterPage<TruckRecord>> {
    const filters = [eq(trucks.companyId, principal.companyId)];
    if (!query.includeInactive && INACTIVE_TRUCK_STATUSES.length > 0) {
      filters.push(not(inArray(trucks.status, [...INACTIVE_TRUCK_STATUSES])));
    }
    // Archived trucks (owner, 2026-10-05) are left out unless asked for, like archived drivers.
    if (!query.includeArchived) filters.push(ne(trucks.status, ARCHIVED_TRUCK_STATUS));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(trucks.unitNumber, term),
        ilike(trucks.vin, term),
        ilike(trucks.make, term),
        ilike(trucks.model, term),
        ilike(trucks.plate, term),
      );
      if (match) filters.push(match);
    }
    const where = and(...filters);

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(trucks)
      .where(where);
    const total = counted?.count ?? 0;

    const rows = await this.db
      .select({ truck: trucks, driverFirst: drivers.firstName, driverLast: drivers.lastName })
      .from(trucks)
      .leftJoin(drivers, eq(trucks.currentDriverId, drivers.id))
      .where(where)
      .orderBy(asc(trucks.unitNumber))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const data = rows.map((row) =>
      toTruckRecord(
        row.truck,
        row.driverFirst ? `${row.driverFirst} ${row.driverLast ?? ''}`.trim() : null,
      ),
    );
    return {
      data: await this.withVendors(principal, data),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Resolves an id or a unit number, because links in this product carry both. */
  async find(principal: Principal, idOrUnit: string): Promise<TruckRecord | null> {
    const [row] = await this.db
      .select({ truck: trucks, driverFirst: drivers.firstName, driverLast: drivers.lastName })
      .from(trucks)
      .leftJoin(drivers, eq(trucks.currentDriverId, drivers.id))
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          or(eq(trucks.id, idOrUnit), eq(trucks.unitNumber, idOrUnit)),
        ),
      )
      .limit(1);
    if (!row) return null;
    const [record] = await this.withVendors(principal, [
      toTruckRecord(
        row.truck,
        row.driverFirst ? `${row.driverFirst} ${row.driverLast ?? ''}`.trim() : null,
      ),
    ]);
    return record ?? null;
  }

  /** Each truck's vendor today (owner, 2026-10-28); null on a company truck. */
  private async withVendors(principal: Principal, records: TruckRecord[]): Promise<TruckRecord[]> {
    const byTruck = await truckVendorsOn(this.db, principal.companyId, records.map((r) => r.id), easternToday(new Date()));
    return records.map((r) => ({ ...r, vendor: byTruck.get(r.id) ?? null }));
  }

  /** The truck owners on file, for the vendor picker. */
  vendorOwners(principal: Principal): Promise<Array<{ id: string; name: string }>> {
    return truckVendorOwners(this.db, principal.companyId);
  }

  /**
   * A truck owner's name corrected (owner, 2026-10-30: a manager typed it wrong). The vendor keeps
   * its id, so every truck, arrangement and statement that names it reads the new spelling.
   * Checked against the name as it was read; refused when another truck owner already has it.
   */
  async renameVendorOwner(principal: Principal, vendorId: string, input: { name: string; expectedName: string }): Promise<{ id: string; name: string }> {
    const name = input.name.trim().replace(/\s+/g, ' ');
    if (name.length < 2) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Type the vendor’s name.' });
    return this.db.transaction(async (tx) => {
      const [current] = await tx
        .select({ id: vendors.id, name: vendors.name, version: vendors.version })
        .from(vendors)
        .where(and(eq(vendors.companyId, principal.companyId), eq(vendors.id, vendorId), eq(vendors.kind, TRUCK_VENDOR_KIND)))
        .limit(1);
      if (!current) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such truck owner.' });
      if (current.name !== input.expectedName) {
        throw new AppError({ status: 409, title: 'Conflict', detail: `The name changed to "${current.name}" since you opened it. Reload and try again.` });
      }
      if (current.name === name) return { id: current.id, name };
      const [same] = await tx
        .select({ id: vendors.id })
        .from(vendors)
        .where(and(eq(vendors.companyId, principal.companyId), eq(vendors.kind, TRUCK_VENDOR_KIND), ne(vendors.id, vendorId), sql`lower(${vendors.name}) = lower(${name})`))
        .limit(1);
      if (same) throw new AppError({ status: 409, title: 'Conflict', detail: `Another truck owner is already called "${name}".` });
      await tx
        .update(vendors)
        .set({ name, updatedAt: new Date(), version: current.version + 1 })
        .where(and(eq(vendors.companyId, principal.companyId), eq(vendors.id, vendorId)));
      await this.audit.writeIn(tx, principal, {
        action: 'update',
        entityType: 'vendor',
        entityId: vendorId,
        entityLabel: name,
        summary: `Vendor renamed: ${current.name} → ${name}`,
        changes: [{ field: 'name', old: current.name, new: name }],
      });
      return { id: vendorId, name };
    });
  }

  /**
   * Move to vendor (owner, 2026-10-28): from `effectiveFrom` the truck runs for the vendor, the
   * company keeps `companyPercent` of its gross and its running costs are the vendor's. An
   * arrangement already open is closed the day before; a new vendor is added to the vendors list.
   * One transaction, one audit line, version-checked on the truck's updatedAt.
   */
  async moveToVendor(principal: Principal, idOrUnit: string, input: MoveTruckToVendorRequest): Promise<TruckRecord> {
    const existing = await this.get(principal, idOrUnit);
    if (existing.status === ARCHIVED_TRUCK_STATUS) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `Unit ${existing.unitNumber} is archived. Restore it first.` });
    }
    this.checkVersion(existing, input.expectedUpdatedAt);
    const companyBps = percentToBps(input.companyPercent);
    const now = new Date();
    const actor = principal.userName ?? principal.userId;
    const events: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      // The vendor: the one chosen, or the one typed - reused when a truck owner of that name exists.
      let vendorId = input.vendorId ?? null;
      let vendorName = '';
      if (vendorId) {
        const [v] = await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(and(eq(vendors.companyId, principal.companyId), eq(vendors.id, vendorId))).limit(1);
        if (!v) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That vendor is not on file.' });
        vendorName = v.name;
      } else {
        vendorName = (input.vendorName ?? '').trim();
        const [same] = await tx
          .select({ id: vendors.id, name: vendors.name })
          .from(vendors)
          .where(and(eq(vendors.companyId, principal.companyId), eq(vendors.kind, TRUCK_VENDOR_KIND), sql`lower(${vendors.name}) = lower(${vendorName})`))
          .limit(1);
        if (same) {
          vendorId = same.id;
          vendorName = same.name;
        } else {
          vendorId = `ven_${crypto.randomUUID()}`;
          await tx.insert(vendors).values({ id: vendorId, companyId: principal.companyId, name: vendorName, kind: TRUCK_VENDOR_KIND, status: 'active', source: 'user' });
          events.push(
            await this.audit.writeIn(tx, principal, { action: 'create', entityType: 'vendor', entityId: vendorId, entityLabel: vendorName, summary: `Vendor ${vendorName} added (truck owner)` }),
          );
        }
      }
      const open = (await arrangementsFor(tx, principal.companyId, [existing.id])).filter((a) => !a.effectiveTo || a.effectiveTo >= input.effectiveFrom);
      for (const a of open) {
        if (a.effectiveFrom >= input.effectiveFrom) {
          throw new AppError({ status: 409, title: 'Conflict', detail: `Unit ${existing.unitNumber} already runs for a vendor from ${a.effectiveFrom}. Move it back to the company first, or start the new vendor after that day.` });
        }
        const dayBefore = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        await tx
          .update(acctVendorArrangements)
          .set({ effectiveTo: dayBefore, record: sql`jsonb_set(${acctVendorArrangements.record}, '{effectiveTo}', to_jsonb(${dayBefore}::text))` })
          .where(and(eq(acctVendorArrangements.companyId, principal.companyId), eq(acctVendorArrangements.id, a.id)));
      }
      const id = `var_${crypto.randomUUID()}`;
      const record = {
        id,
        vendorId,
        vendorName,
        truckId: existing.id,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        percentBps: vendorShareBps(companyBps),
        companyPercentBps: companyBps,
        note: input.note?.trim() || null,
        byName: actor,
        at: now.toISOString(),
      };
      await tx.insert(acctVendorArrangements).values({
        id,
        companyId: principal.companyId,
        vendorId,
        truckId: existing.id,
        effectiveFrom: input.effectiveFrom,
        effectiveTo: null,
        percentBps: record.percentBps,
        record,
      });
      await tx.update(trucks).set({ ownership: 'vendor', updatedAt: now }).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, existing.id)));
      events.push(
        await this.audit.writeIn(tx, principal, {
          action: 'move_to_vendor',
          entityType: 'truck',
          entityId: existing.id,
          entityLabel: `Unit ${existing.unitNumber}`,
          summary: `Unit ${existing.unitNumber} moved to vendor ${vendorName} from ${input.effectiveFrom}: company keeps ${companyBps / 100}% of gross`,
          changes: [
            { field: 'ownership', old: existing.ownership, new: 'vendor' },
            { field: 'vendor', old: existing.vendor?.vendorName ?? null, new: vendorName },
            { field: 'companyPercent', old: existing.vendor ? String(existing.vendor.companyPercent) : null, new: String(companyBps / 100) },
          ],
          reason: input.note?.trim() || null,
        }),
      );
    });
    await this.audit.publish(...events);
    return this.get(principal, existing.id);
  }

  /**
   * Edit percentage (owner, 2026-10-28): the company keeps `companyPercent` from `effectiveFrom`
   * on. The same day as the arrangement began corrects it in place; a later day closes it the day
   * before and opens a new one with the same vendor, so earlier loads keep their split.
   */
  async changeVendorPercent(principal: Principal, idOrUnit: string, input: ChangeTruckVendorPercentRequest): Promise<TruckRecord> {
    const existing = await this.get(principal, idOrUnit);
    this.checkVersion(existing, input.expectedUpdatedAt);
    const all = await arrangementsFor(this.db, principal.companyId, [existing.id]);
    const current = all
      .filter((a) => !a.effectiveTo || a.effectiveTo >= input.effectiveFrom)
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
    if (!current) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `Unit ${existing.unitNumber} is not running for a vendor.` });
    }
    if (input.effectiveFrom < current.effectiveFrom) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `The vendor arrangement starts ${current.effectiveFrom}; the new percentage cannot start before it.` });
    }
    const companyBps = percentToBps(input.companyPercent);
    const before = companyBpsOf(current);
    const now = new Date();
    const actor = principal.userName ?? principal.userId;
    const events: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      if (current.effectiveFrom === input.effectiveFrom) {
        await tx
          .update(acctVendorArrangements)
          .set({
            percentBps: vendorShareBps(companyBps),
            record: sql`${acctVendorArrangements.record} || ${JSON.stringify({ percentBps: vendorShareBps(companyBps), companyPercentBps: companyBps, byName: actor, at: now.toISOString() })}::jsonb`,
          })
          .where(and(eq(acctVendorArrangements.companyId, principal.companyId), eq(acctVendorArrangements.id, current.id)));
      } else {
        const dayBefore = new Date(Date.parse(`${input.effectiveFrom}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
        await tx
          .update(acctVendorArrangements)
          .set({ effectiveTo: dayBefore, record: sql`jsonb_set(${acctVendorArrangements.record}, '{effectiveTo}', to_jsonb(${dayBefore}::text))` })
          .where(and(eq(acctVendorArrangements.companyId, principal.companyId), eq(acctVendorArrangements.id, current.id)));
        const id = `var_${crypto.randomUUID()}`;
        const record = {
          id,
          vendorId: current.vendorId,
          vendorName: existing.vendor?.vendorName ?? current.vendorName,
          truckId: existing.id,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: current.effectiveTo,
          percentBps: vendorShareBps(companyBps),
          companyPercentBps: companyBps,
          note: input.reason?.trim() || null,
          byName: actor,
          at: now.toISOString(),
        };
        await tx.insert(acctVendorArrangements).values({
          id,
          companyId: principal.companyId,
          vendorId: current.vendorId,
          truckId: existing.id,
          effectiveFrom: input.effectiveFrom,
          effectiveTo: current.effectiveTo,
          percentBps: record.percentBps,
          record,
        });
      }
      await tx.update(trucks).set({ updatedAt: now }).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, existing.id)));
      events.push(
        await this.audit.writeIn(tx, principal, {
          action: 'vendor_percent',
          entityType: 'truck',
          entityId: existing.id,
          entityLabel: `Unit ${existing.unitNumber}`,
          summary: `Unit ${existing.unitNumber}: company keeps ${companyBps / 100}% of gross from ${input.effectiveFrom} (was ${before === null ? 'not set' : `${before / 100}%`})`,
          changes: [{ field: 'companyPercent', old: before === null ? null : String(before / 100), new: String(companyBps / 100) }],
          reason: input.reason?.trim() || null,
        }),
      );
    });
    await this.audit.publish(...events);
    return this.get(principal, existing.id);
  }

  /** Move back to the company: the arrangement ends on `effectiveTo`; history stays. */
  async endVendor(principal: Principal, idOrUnit: string, input: EndTruckVendorRequest): Promise<TruckRecord> {
    const existing = await this.get(principal, idOrUnit);
    this.checkVersion(existing, input.expectedUpdatedAt);
    const open = (await arrangementsFor(this.db, principal.companyId, [existing.id])).filter((a) => !a.effectiveTo || a.effectiveTo >= input.effectiveTo);
    if (open.length === 0) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `Unit ${existing.unitNumber} is not running for a vendor.` });
    }
    const tooEarly = open.find((a) => a.effectiveFrom > input.effectiveTo);
    if (tooEarly) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `The vendor arrangement starts ${tooEarly.effectiveFrom}; the last day cannot be before it.` });
    }
    const now = new Date();
    const events: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      for (const a of open) {
        await tx
          .update(acctVendorArrangements)
          .set({ effectiveTo: input.effectiveTo, record: sql`jsonb_set(${acctVendorArrangements.record}, '{effectiveTo}', to_jsonb(${input.effectiveTo}::text))` })
          .where(and(eq(acctVendorArrangements.companyId, principal.companyId), eq(acctVendorArrangements.id, a.id)));
      }
      await tx.update(trucks).set({ ownership: 'owned', updatedAt: now }).where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, existing.id)));
      events.push(
        await this.audit.writeIn(tx, principal, {
          action: 'end_vendor',
          entityType: 'truck',
          entityId: existing.id,
          entityLabel: `Unit ${existing.unitNumber}`,
          summary: `Unit ${existing.unitNumber} back to the company after ${input.effectiveTo} (was vendor ${existing.vendor?.vendorName ?? 'truck'})`,
          changes: [{ field: 'ownership', old: existing.ownership, new: 'owned' }],
          reason: input.reason,
        }),
      );
    });
    await this.audit.publish(...events);
    return this.get(principal, existing.id);
  }

  /** A write quoting the truck as it was read; a later change is a conflict, never an overwrite. */
  private checkVersion(existing: TruckRecord, expectedUpdatedAt: string | undefined): void {
    if (!expectedUpdatedAt || !existing.updatedAt) return;
    if (Date.parse(expectedUpdatedAt) !== Date.parse(existing.updatedAt)) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `Unit ${existing.unitNumber} changed since you opened it. Reload and try again.` });
    }
  }

  async get(principal: Principal, idOrUnit: string): Promise<TruckRecord> {
    const truck = await this.find(principal, idOrUnit);
    if (!truck) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `No truck ${idOrUnit} on this fleet`,
      });
    }
    return truck;
  }

  async create(principal: Principal, input: CreateTruckRequest): Promise<TruckRecord> {
    const unitNumber = input.unitNumber.trim();
    const vin = input.vin.trim().toUpperCase();

    const clash = await this.db
      .select({ id: trucks.id, unitNumber: trucks.unitNumber, vin: trucks.vin })
      .from(trucks)
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          or(eq(trucks.unitNumber, unitNumber), sql`upper(${trucks.vin}) = ${vin}`),
        ),
      )
      .limit(1);
    if (clash[0]) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          clash[0].unitNumber === unitNumber
            ? `Unit ${unitNumber} already exists in the fleet`
            : `A truck with VIN ${vin} already exists`,
      });
    }

    let driverRow = null;
    if (input.driverId) {
      const [found] = await this.db
        .select()
        .from(drivers)
        .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, input.driverId)))
        .limit(1);
      if (!found) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'That driver is not on the roster',
        });
      }
      if (found.currentTruckId) {
        const [onUnit] = await this.db
          .select({ unitNumber: trucks.unitNumber })
          .from(trucks)
          .where(eq(trucks.id, found.currentTruckId))
          .limit(1);
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `${found.firstName} ${found.lastName} is already on unit ${onUnit?.unitNumber ?? found.currentTruckId}`,
        });
      }
      if (input.status !== 'available' && input.status !== 'idle') {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'A unit that is in a shop or out of service cannot start with a driver on it',
        });
      }
      driverRow = found;
    }

    const id = await this.nextTruckId(principal, unitNumber);
    const now = new Date();
    // A unit added before its in-service date is known is measured from the day it was added:
    // its first PM falls FIRST_SERVICE_DAYS after that, and the date is corrected from the unit's
    // page once somebody has it.
    const servicedFrom = input.inServiceDate ?? isoDay(now);
    const nextServiceDate =
      input.nextServiceDate ??
      isoDay(
        new Date(new Date(`${servicedFrom}T00:00:00Z`).getTime() + FIRST_SERVICE_DAYS * 86_400_000),
      );

    let events: AuditEvent[] = [];
    const record = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(trucks)
        .values({
          id,
          companyId: principal.companyId,
          unitNumber,
          vin,
          year: input.year,
          make: input.make.trim(),
          model: input.model.trim(),
          plate: input.plate?.trim().toUpperCase() ?? null,
          plateState: input.plateState?.trim().toUpperCase() ?? null,
          color: input.color?.trim() ?? null,
          status: input.status,
          health: input.status === 'out_of_service' ? 'critical' : 'healthy',
          ownership: input.ownership,
          odometer: input.odometer,
          odometerAt: now,
          engineHours: String(input.engineHours),
          // Null until somebody has it; the unit's page asks for it.
          inServiceDate: input.inServiceDate ?? null,
          // The driver is paired below through the assignment record, in this transaction.
          currentDriverId: null,
          currentTrailerId: null,
          currentLoadId: null,
          // No telematics feed is attached to a unit on the day it is added, so no position.
          // Reporting a location here would be an invention.
          location: null,
          nextServiceOdometer: input.odometer + input.serviceIntervalMiles,
          nextServiceDate,
          nextServiceType: input.nextServiceType,
          telematicsProvider: 'Unassigned',
          telematicsStatus: 'disconnected',
          // Fuel economy and idle are measured, not declared. A new unit has measured nothing.
          mpg30d: '0',
          mpg90d: '0',
          idlePercent30d: '0',
          idlePercent90d: '0',
          homeTerminal: input.homeTerminal?.trim() ?? null,
        })
        .returning();

      if (!inserted) {
        throw new AppError({
          status: 500,
          title: 'Internal Server Error',
          detail: 'Insert failed',
        });
      }

      // Both sides of the pairing move together or neither does, and the assignment record
      // behind them is written with them (0047).
      if (driverRow) {
        events = await this.assignments.assignIn(
          tx,
          principal,
          inserted.id,
          {
            driverId: driverRow.id,
            assignedOn: easternToday(now),
            equipment: [],
            note: null,
            pickupPhotoIds: [],
          },
          'truck_create',
          now,
        );
      }

      return toTruckRecord(
        { ...inserted, currentDriverId: driverRow?.id ?? null },
        driverRow ? `${driverRow.firstName} ${driverRow.lastName}`.trim() : null,
      );
    });
    await this.audit.publish(...events);

    // A vendor truck from the start (owner, 2026-10-28): the arrangement from the day it was added.
    if (input.vendor) {
      return this.moveToVendor(principal, record.id, {
        vendorId: input.vendor.vendorId ?? null,
        vendorName: input.vendor.vendorName ?? null,
        companyPercent: input.vendor.companyPercent,
        effectiveFrom: easternToday(new Date()),
      });
    }
    return record;
  }

  async update(
    principal: Principal,
    idOrUnit: string,
    patch: UpdateTruckRequest,
  ): Promise<TruckRecord> {
    const existing = await this.get(principal, idOrUnit);

    if (patch.unitNumber && patch.unitNumber !== existing.unitNumber) {
      const [clash] = await this.db
        .select({ id: trucks.id })
        .from(trucks)
        .where(
          and(
            eq(trucks.companyId, principal.companyId),
            eq(trucks.unitNumber, patch.unitNumber),
            not(eq(trucks.id, existing.id)),
          ),
        )
        .limit(1);
      if (clash) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `Unit ${patch.unitNumber} already exists in the fleet`,
        });
      }
    }

    await this.db
      .update(trucks)
      .set({
        ...(patch.unitNumber !== undefined ? { unitNumber: patch.unitNumber.trim() } : {}),
        ...(patch.make !== undefined ? { make: patch.make.trim() } : {}),
        ...(patch.model !== undefined ? { model: patch.model.trim() } : {}),
        ...(patch.plate !== undefined ? { plate: patch.plate.trim().toUpperCase() } : {}),
        ...(patch.plateState !== undefined
          ? { plateState: patch.plateState.trim().toUpperCase() }
          : {}),
        ...(patch.color !== undefined ? { color: patch.color.trim() } : {}),
        ...(patch.ownership !== undefined ? { ownership: patch.ownership } : {}),
        ...(patch.homeTerminal !== undefined ? { homeTerminal: patch.homeTerminal.trim() } : {}),
        ...(patch.inServiceDate !== undefined ? { inServiceDate: patch.inServiceDate } : {}),
        ...(patch.nextServiceDate !== undefined ? { nextServiceDate: patch.nextServiceDate } : {}),
        ...(patch.nextServiceType !== undefined ? { nextServiceType: patch.nextServiceType } : {}),
        ...(patch.nextServiceOdometer !== undefined
          ? { nextServiceOdometer: patch.nextServiceOdometer }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, existing.id)));

    return this.get(principal, existing.id);
  }

  /**
   * Moves a unit's availability. Selling is the end of the line: an operational record is never
   * deleted, because the loads, work orders and fuel fills behind it still have to be answerable.
   */
  async setStatus(
    principal: Principal,
    idOrUnit: string,
    status: TruckRecord['status'],
  ): Promise<TruckRecord> {
    const existing = await this.get(principal, idOrUnit);
    if (existing.status === ARCHIVED_TRUCK_STATUS || status === ARCHIVED_TRUCK_STATUS) {
      // Archive and restore carry a reason and an audit line; the plain status move does neither.
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          existing.status === ARCHIVED_TRUCK_STATUS
            ? `Unit ${existing.unitNumber} is archived. Restore it first.`
            : 'Archive a truck with Archive truck, which asks for a reason',
      });
    }
    if (existing.currentDriverId && (status === 'out_of_service' || status === 'sold')) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${existing.currentDriverName ?? 'A driver'} is still assigned to unit ${existing.unitNumber}. Move them off it first.`,
      });
    }
    await this.db
      .update(trucks)
      .set({
        status,
        health:
          status === 'out_of_service' || status === 'accident'
            ? 'critical'
            : status === 'in_shop' || status === 'maintenance'
              ? 'needs_attention'
              : existing.health,
        updatedAt: new Date(),
      })
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, existing.id)));
    return this.get(principal, existing.id);
  }

  /**
   * Archives a truck (owner, 2026-10-05): hidden from every list, picker and count of the current
   * fleet, kept with its history, reversible, audited with the reason. The `updatedAt` the page
   * read is the version check. Refused while a driver, an open assignment or an active load is on it.
   */
  async archive(
    principal: Principal,
    idOrUnit: string,
    reason: string,
    expectedUpdatedAt: string,
  ): Promise<TruckRecord> {
    const actor = {
      userId: principal.userId,
      userName: principal.userName ?? principal.userId,
      actorType: 'user' as const,
    };
    const result = await this.db.transaction((tx) =>
      archiveTruck(tx, principal.companyId, idOrUnit, actor, new Date(), reason, expectedUpdatedAt),
    );
    return this.answer(principal, result);
  }

  /** Brings an archived truck back as `available`; same version check and audit line. */
  async restore(
    principal: Principal,
    idOrUnit: string,
    reason: string | null,
    expectedUpdatedAt: string,
  ): Promise<TruckRecord> {
    const actor = {
      userId: principal.userId,
      userName: principal.userName ?? principal.userId,
      actorType: 'user' as const,
    };
    const result = await this.db.transaction((tx) =>
      restoreTruck(tx, principal.companyId, idOrUnit, actor, new Date(), reason, expectedUpdatedAt),
    );
    return this.answer(principal, result);
  }

  private async answer(principal: Principal, result: TruckArchiveResult): Promise<TruckRecord> {
    if (!result.ok) {
      throw new AppError({
        status: result.status,
        title: result.status === 404 ? 'Not Found' : 'Conflict',
        detail: result.detail,
      });
    }
    return this.get(principal, result.truckId);
  }

  /**
   * Unit numbers are the carrier's own identifier, so a new record takes its id from the number the
   * user typed when that reads as one, and otherwise continues the surrogate sequence. Either way
   * the id is checked for collision before it is used.
   */
  private async nextTruckId(_principal: Principal, unitNumber: string): Promise<string> {
    const candidate = /^\d{1,6}$/.test(unitNumber) ? `trk_${unitNumber}` : null;
    if (candidate) {
      const [taken] = await this.db
        .select({ id: trucks.id })
        .from(trucks)
        .where(eq(trucks.id, candidate))
        .limit(1);
      if (!taken) return candidate;
    }
    // The surrogate sequence is read across EVERY company, because `trucks.id` is one primary key
    // for the whole table. Taking the highest within a single company produced an id another
    // company already held, and the insert failed with a duplicate key - a 500 on adding a second
    // truck, and the same id handed out again on the next attempt.
    const [highest] = await this.db
      .select({
        value: sql<number>`coalesce(max(nullif(regexp_replace(${trucks.id}, '\\D', '', 'g'), '')::bigint), 0)::int`,
      })
      .from(trucks);
    // And the candidate is checked rather than assumed: two requests can read the same maximum.
    let next = (highest?.value ?? 0) + 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = `trk_${String(next).padStart(3, '0')}`;
      const [taken] = await this.db.select({ id: trucks.id }).from(trucks).where(eq(trucks.id, id)).limit(1);
      if (!taken) return id;
      next += 1;
    }
    throw new Error('Could not find a free truck id after 50 attempts');
  }
}
