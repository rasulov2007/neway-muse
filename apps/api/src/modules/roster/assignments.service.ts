import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  ASSIGNMENT_PHOTO_MAX_BYTES,
  ASSIGNMENT_PHOTO_TYPES,
  INACTIVE_TRUCK_STATUSES,
  cleanTruck,
  type AssignDriverInput,
  type AssignmentEquipment,
  type AssignmentPhoto,
  type AssignmentPhotoStage,
  type AssignmentPhotoUpload,
  type DropDetailsInput,
  type EndAssignmentInput,
  type TruckAssignmentView,
  type TruckDriverAssignment,
  type UpdateAssignmentInput,
  type UploadAssignmentPhotoInput,
  type VoidAssignmentInput,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import type { Database } from '../../database/client';
import { DatabaseService } from '../../database/database.service';
import { dispatchRoster } from '../../database/schema/dispatch-ops';
import { storedFiles } from '../../database/schema/files';
import { truckAssignmentPhotos, truckDriverAssignments } from '../../database/schema/fleet';
import { drivers, trucks } from '../../database/schema/roster';
import { audit as dispatchAudit } from '../dispatch-board/ops.helpers';
import { FilesService, parseDataUrl } from '../files/files.service';
import { declaredMatches, sniffImage } from '../files/image-sniff';
import { AuditService, type AuditEvent, type WriteAuditInput } from '../people/audit.service';
import { easternToday } from './driver-archive.data';

type Row = typeof truckDriverAssignments.$inferSelect;
type PhotoRow = typeof truckAssignmentPhotos.$inferSelect;
type TruckRow = typeof trucks.$inferSelect;
/** A transaction: everything one assignment change writes commits together or not at all. */
export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

/** Where the pairing was asked for; recorded on the row. */
export type AssignmentSource = 'truck_page' | 'driver_page' | 'truck_create' | 'backfill';

const ARCHIVED_DRIVER_STATUSES = new Set(['terminated', 'archived']);
/** `source` of a voided row: kept for the record, left out of the unit's history. */
const VOIDED_SOURCE = 'voided';

function unprocessable(detail: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', detail });
}
function conflict(detail: string): AppError {
  return new AppError({ status: 409, title: 'Conflict', detail });
}
function notFound(detail: string): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail });
}

/**
 * Who is in a truck, since when, and what went with it (2026-09-21; single source of truth 0047).
 *
 * The open assignment row IS the pairing. Every change — assigning from the truck page, moving a
 * driver from the driver page, adding a truck with its driver, unassigning — goes through here and
 * writes, in ONE transaction: the rows it closes (the unit's previous driver, and the moved
 * driver's row on the unit they left), the two pointers (`trucks.current_driver_id`,
 * `drivers.current_truck_id`), the new row, its photos, the audit entries for both units and the
 * dispatch-board rows that must follow. The database refuses a second open row for a truck or a
 * driver (partial unique indexes), so a race ends in a 409 rather than two drivers in one unit.
 *
 * End dates: a row closed because somebody else took the unit, or because its driver moved to
 * another unit, ends ON the new assignment's date — the handover day, which is also what the
 * Unassign modal records as the drop date. A handover is one day on which both people touched the
 * unit; ending the old row the day before would make a same-day assign-and-replace end before it
 * started.
 */
@Injectable()
export class AssignmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly files: FilesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------ reads

  async view(principal: Principal, truckIdOrUnit: string): Promise<TruckAssignmentView> {
    const truck = await this.truck(principal, truckIdOrUnit);
    const rows = await this.db
      .select()
      .from(truckDriverAssignments)
      .where(
        and(
          eq(truckDriverAssignments.companyId, principal.companyId),
          eq(truckDriverAssignments.truckId, truck.id),
          // A voided row (test or mistaken entry) is kept and audited but no longer part of the unit's history.
          ne(truckDriverAssignments.source, VOIDED_SOURCE),
        ),
      )
      .orderBy(desc(truckDriverAssignments.assignedOn), desc(truckDriverAssignments.createdAt));
    const names = await this.driverNames(principal, rows.map((r) => r.driverId));
    const photos = await this.photosFor(principal, rows.map((r) => r.id));
    const all = rows.map((r) => this.toRecord(r, truck.unitNumber, names, photos.get(r.id) ?? []));
    // The open row is the current assignment: the pointers are written with it.
    const current = all.find((a) => a.endedOn === null) ?? null;
    return { current, history: all.filter((a) => a !== current) };
  }

  // ------------------------------------------------------------------------------ photos

  /**
   * Stores one pickup or drop photo, not yet linked to an assignment: the assign, unassign and
   * edit calls link the ids they are given. Images only, checked by their bytes, not their name.
   */
  async uploadPhoto(
    principal: Principal,
    truckIdOrUnit: string,
    input: UploadAssignmentPhotoInput,
  ): Promise<AssignmentPhotoUpload> {
    await this.truck(principal, truckIdOrUnit);
    const parsed = parseDataUrl(input.content);
    if (!parsed) throw unprocessable('The photo is empty or not a data URL.');
    if (parsed.bytes.byteLength > ASSIGNMENT_PHOTO_MAX_BYTES) {
      throw new AppError({
        status: 413,
        title: 'Too Large',
        detail: `Photos are limited to ${Math.round(ASSIGNMENT_PHOTO_MAX_BYTES / 1024 / 1024)} MB each.`,
      });
    }
    const sniffed = sniffImage(parsed.bytes);
    if (!sniffed || !declaredMatches(parsed.contentType, sniffed)) {
      throw new AppError({
        status: 415,
        title: 'Unsupported Media Type',
        detail: 'Only JPEG, PNG, WebP or HEIC photos can be attached here.',
      });
    }
    const stored = await this.files.store(principal.companyId, {
      fileName: input.fileName,
      contentType: sniffed,
      bytes: parsed.bytes,
      uploadedBy: principal.userName ?? principal.userId,
    });
    return {
      fileId: stored.id,
      url: stored.url,
      fileName: stored.fileName,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
    };
  }

  // ------------------------------------------------------------------------------ writes

  async assign(
    principal: Principal,
    truckIdOrUnit: string,
    input: AssignDriverInput,
    source: AssignmentSource = 'truck_page',
  ): Promise<TruckAssignmentView> {
    const truck = await this.truck(principal, truckIdOrUnit);
    const now = new Date();
    const events = await this.run(() =>
      this.db.transaction((tx) => this.assignIn(tx, principal, truck.id, input, source, now)),
    );
    await this.audit.publish(...events);
    return this.view(principal, truck.id);
  }

  /**
   * The whole pairing inside `tx`. Exposed so truck creation can pair its driver in the same
   * transaction that inserts the truck. Returns the audit events to publish after commit.
   */
  async assignIn(
    tx: Tx,
    principal: Principal,
    truckId: string,
    input: AssignDriverInput,
    source: AssignmentSource,
    now: Date,
  ): Promise<AuditEvent[]> {
    const today = easternToday(now);
    const events: AuditEvent[] = [];
    // Lock the unit and the driver: two assigns to the same unit or of the same driver queue here.
    const [truck] = await tx
      .select()
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, truckId)))
      .for('update');
    if (!truck) throw notFound(`No truck ${truckId}`);
    const [driver] = await tx
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, input.driverId)))
      .for('update');
    if (!driver) throw unprocessable('That driver is not on the roster');
    const driverName = `${driver.firstName} ${driver.lastName}`.trim();

    if (truck.status === 'archived') {
      throw conflict(`Unit ${truck.unitNumber} is archived. Restore it before assigning a driver.`);
    }
    if (INACTIVE_TRUCK_STATUSES.includes(truck.status as (typeof INACTIVE_TRUCK_STATUSES)[number])) {
      throw conflict(
        `Unit ${truck.unitNumber} is ${truck.status.replace(/_/g, ' ')} and cannot be assigned`,
      );
    }
    if (ARCHIVED_DRIVER_STATUSES.has(driver.status)) {
      throw conflict(`${driverName} is ${driver.status} and cannot be put in a unit`);
    }
    if (input.assignedOn > today) {
      throw unprocessable('The assigned date cannot be in the future.');
    }

    const truckOpen = await this.openRow(tx, principal, { truckId: truck.id });
    if (input.expectedCurrentId !== undefined && (truckOpen?.id ?? null) !== input.expectedCurrentId) {
      throw conflict(
        'The driver on this unit was changed by somebody else meanwhile; reload and try again.',
      );
    }
    if (truckOpen && truckOpen.driverId === driver.id) {
      throw conflict(
        `${driverName} is already in unit ${truck.unitNumber}. Use Change to edit the assignment.`,
      );
    }
    const driverOpen = await this.openRow(tx, principal, { driverId: driver.id });
    const names = await this.driverNames(principal, [truckOpen?.driverId ?? '', driver.id], tx);

    // 1. The unit's previous driver hands it back (Change records that drop in full).
    if (truckOpen) {
      const drop: DropDetailsInput = input.previousDrop ?? {
        endedOn: input.assignedOn,
        returnedEquipment: [],
        dropNote: null,
        dropPhotoIds: [],
      };
      if (drop.endedOn > input.assignedOn) {
        throw unprocessable(
          `The unit cannot come back from ${names.get(truckOpen.driverId)?.name ?? 'the previous driver'} after ${driverName} took it.`,
        );
      }
      events.push(
        ...(await this.closeIn(tx, principal, truckOpen, {
          endedOn: drop.endedOn,
          reason: `Replaced by ${driverName}`,
          returnedEquipment: input.previousDrop ? drop.returnedEquipment : null,
          dropNote: drop.dropNote ?? null,
          dropPhotoIds: drop.dropPhotoIds,
          unitNumber: truck.unitNumber,
          driverName: names.get(truckOpen.driverId)?.name ?? truckOpen.driverId,
          today,
          now,
        })),
      );
    }

    // 2. The moved driver lets go of the unit they were in.
    let previousUnit: string | null = null;
    if (driverOpen && driverOpen.truckId !== truck.id) {
      const [prevTruck] = await tx
        .select({ id: trucks.id, unitNumber: trucks.unitNumber })
        .from(trucks)
        .where(eq(trucks.id, driverOpen.truckId))
        .limit(1);
      previousUnit = prevTruck?.unitNumber ?? driverOpen.truckId;
      events.push(
        ...(await this.closeIn(tx, principal, driverOpen, {
          endedOn: input.assignedOn,
          reason: `Moved to unit ${truck.unitNumber}`,
          returnedEquipment: null,
          dropNote: null,
          dropPhotoIds: [],
          unitNumber: previousUnit,
          driverName,
          today,
          now,
        })),
      );
    } else if (driver.currentTruckId && driver.currentTruckId !== truck.id) {
      const [prevTruck] = await tx
        .select({ unitNumber: trucks.unitNumber })
        .from(trucks)
        .where(eq(trucks.id, driver.currentTruckId))
        .limit(1);
      previousUnit = prevTruck?.unitNumber ?? null;
    }

    // 3. The pointers: nobody else points at this driver or this unit any more.
    await tx
      .update(trucks)
      .set({ currentDriverId: null, updatedAt: now })
      .where(
        and(
          eq(trucks.companyId, principal.companyId),
          eq(trucks.currentDriverId, driver.id),
          ne(trucks.id, truck.id),
        ),
      );
    await tx
      .update(drivers)
      .set({ currentTruckId: null, updatedAt: now })
      .where(
        and(
          eq(drivers.companyId, principal.companyId),
          eq(drivers.currentTruckId, truck.id),
          ne(drivers.id, driver.id),
        ),
      );
    await tx
      .update(trucks)
      .set({ currentDriverId: driver.id, updatedAt: now })
      .where(eq(trucks.id, truck.id));
    await tx
      .update(drivers)
      .set({ currentTruckId: truck.id, updatedAt: now })
      .where(eq(drivers.id, driver.id));

    // 4. The new row and its pickup photos.
    const id = `tda_${now.getTime()}_${Math.random().toString(36).slice(2, 8)}`;
    await tx.insert(truckDriverAssignments).values({
      id,
      companyId: principal.companyId,
      truckId: truck.id,
      driverId: driver.id,
      assignedOn: input.assignedOn,
      equipment: input.equipment,
      note: input.note?.trim() || null,
      createdBy: principal.userId,
      createdByName: principal.userName ?? principal.userId,
      createdAt: now,
      updatedAt: now,
      source,
    });
    await this.linkPhotos(tx, principal, id, 'pickup', input.pickupPhotoIds, now);

    events.push(
      await this.audit.writeIn(tx, principal, {
        action: 'create',
        entityType: 'truck_driver_assignment',
        entityId: id,
        entityLabel: `Unit ${truck.unitNumber} · ${driverName}`,
        summary: `${driverName} assigned to unit ${truck.unitNumber} from ${input.assignedOn}${input.equipment.length > 0 ? ` with ${input.equipment.map((e) => e.label).join(', ')}` : ''}`,
        changes: [
          { field: 'driver', old: truckOpen ? (names.get(truckOpen.driverId)?.name ?? null) : null, new: driverName },
          { field: 'assignedOn', old: null, new: input.assignedOn },
          { field: 'equipment', old: null, new: equipmentWords(input.equipment) },
          { field: 'pickupPhotos', old: null, new: input.pickupPhotoIds.length ? String(input.pickupPhotoIds.length) : null },
        ],
        at: now,
      }),
      await this.audit.writeIn(tx, principal, {
        action: 'update',
        entityType: 'truck',
        entityId: truck.id,
        entityLabel: `Unit ${truck.unitNumber}`,
        summary: `Driver: ${truckOpen ? (names.get(truckOpen.driverId)?.name ?? 'previous driver') : 'none'} → ${driverName}`,
        changes: [
          {
            field: 'currentDriver',
            old: truckOpen ? (names.get(truckOpen.driverId)?.name ?? null) : null,
            new: driverName,
          },
        ],
        at: now,
      }),
      await this.audit.writeIn(tx, principal, {
        action: 'update',
        entityType: 'driver',
        entityId: driver.id,
        entityLabel: driverName,
        summary: `Assigned to unit ${truck.unitNumber}${previousUnit ? ` (was unit ${previousUnit})` : ''}`,
        changes: [{ field: 'currentTruckUnit', old: previousUnit, new: truck.unitNumber }],
        at: now,
      }),
    );

    // 5. The dispatch board follows the pairing for both drivers.
    await this.boardFollows(tx, principal, driver.id, truck.unitNumber, now);
    if (truckOpen) await this.boardFollows(tx, principal, truckOpen.driverId, null, now);
    return events;
  }

  /** Takes the driver out of the unit: the Unassign modal. */
  async end(
    principal: Principal,
    truckIdOrUnit: string,
    id: string,
    input: EndAssignmentInput,
  ): Promise<TruckAssignmentView> {
    const truck = await this.truck(principal, truckIdOrUnit);
    const now = new Date();
    const today = easternToday(now);
    const events = await this.run(() =>
      this.db.transaction(async (tx) => {
        const row = await this.require(principal, truck.id, id, tx, true);
        if (row.version !== input.version) throw stale();
        if (row.endedOn) throw conflict('This assignment is already closed; reload to see it.');
        const names = await this.driverNames(principal, [row.driverId], tx);
        const name = names.get(row.driverId)?.name ?? row.driverId;
        const out = await this.closeIn(tx, principal, row, {
          endedOn: input.endedOn ?? today,
          reason: input.reason?.trim() || null,
          returnedEquipment: input.returnedEquipment ?? null,
          dropNote: input.dropNote ?? null,
          dropPhotoIds: input.dropPhotoIds,
          unitNumber: truck.unitNumber,
          driverName: name,
          today,
          now,
        });
        await tx
          .update(trucks)
          .set({ currentDriverId: null, updatedAt: now })
          .where(and(eq(trucks.id, truck.id), eq(trucks.currentDriverId, row.driverId)));
        await tx
          .update(drivers)
          .set({ currentTruckId: null, updatedAt: now })
          .where(and(eq(drivers.id, row.driverId), eq(drivers.currentTruckId, truck.id)));
        out.push(
          await this.audit.writeIn(tx, principal, {
            action: 'update',
            entityType: 'driver',
            entityId: row.driverId,
            entityLabel: name,
            summary: `Taken out of unit ${truck.unitNumber}`,
            changes: [{ field: 'currentTruckUnit', old: truck.unitNumber, new: null }],
            at: now,
          }),
        );
        await this.boardFollows(tx, principal, row.driverId, null, now);
        return out;
      }),
    );
    await this.audit.publish(...events);
    return this.view(principal, truck.id);
  }

  /**
   * Takes a driver out of whatever unit they are in (the driver page's "no unit", termination).
   * Closes the open row as of today and clears both pointers. Returns the audit events.
   */
  async releaseDriverIn(
    tx: Tx,
    principal: Principal,
    driverId: string,
    reason: string,
    now: Date,
  ): Promise<AuditEvent[]> {
    const today = easternToday(now);
    const events: AuditEvent[] = [];
    const open = await this.openRow(tx, principal, { driverId }, true);
    const [driver] = await tx
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, driverId)))
      .limit(1);
    if (!driver) throw notFound(`No driver ${driverId}`);
    const name = `${driver.firstName} ${driver.lastName}`.trim();
    const truckId = open?.truckId ?? driver.currentTruckId;
    let unitNumber: string | null = null;
    if (truckId) {
      const [t] = await tx
        .select({ unitNumber: trucks.unitNumber })
        .from(trucks)
        .where(eq(trucks.id, truckId))
        .limit(1);
      unitNumber = t?.unitNumber ?? truckId;
    }
    if (open) {
      events.push(
        ...(await this.closeIn(tx, principal, open, {
          // A row that started today or later (or a backfilled guess after today) ends on its start.
          endedOn: open.assignedOn > today ? open.assignedOn : today,
          reason,
          returnedEquipment: null,
          dropNote: null,
          dropPhotoIds: [],
          unitNumber: unitNumber ?? open.truckId,
          driverName: name,
          today: open.assignedOn > today ? open.assignedOn : today,
          now,
        })),
      );
    }
    await tx
      .update(trucks)
      .set({ currentDriverId: null, updatedAt: now })
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.currentDriverId, driverId)));
    await tx
      .update(drivers)
      .set({ currentTruckId: null, updatedAt: now })
      .where(eq(drivers.id, driverId));
    if (unitNumber) {
      events.push(
        await this.audit.writeIn(tx, principal, {
          action: 'update',
          entityType: 'driver',
          entityId: driverId,
          entityLabel: name,
          summary: `Taken out of unit ${unitNumber}`,
          reason,
          changes: [{ field: 'currentTruckUnit', old: unitNumber, new: null }],
          at: now,
        }),
      );
      await this.boardFollows(tx, principal, driverId, null, now);
    }
    return events;
  }

  async releaseDriver(principal: Principal, driverId: string, reason: string): Promise<void> {
    const now = new Date();
    const events = await this.run(() =>
      this.db.transaction((tx) => this.releaseDriverIn(tx, principal, driverId, reason, now)),
    );
    await this.audit.publish(...events);
  }

  /** Edits any assignment, open or closed. Version-checked, audited with before and after. */
  async update(
    principal: Principal,
    truckIdOrUnit: string,
    id: string,
    input: UpdateAssignmentInput,
  ): Promise<TruckAssignmentView> {
    const truck = await this.truck(principal, truckIdOrUnit);
    const now = new Date();
    const today = easternToday(now);
    const events = await this.run(() =>
      this.db.transaction(async (tx) => {
        const row = await this.require(principal, truck.id, id, tx, true);
        if (row.version !== input.version) throw stale();
        const patch: Partial<typeof truckDriverAssignments.$inferInsert> = {
          version: row.version + 1,
          updatedAt: now,
          updatedBy: principal.userId,
          updatedByName: principal.userName ?? principal.userId,
        };
        const changes: { field: string; old: string | null; new: string | null }[] = [];

        const assignedOn = input.assignedOn ?? row.assignedOn;
        const endedOn = input.endedOn ?? row.endedOn ?? null;
        if (input.endedOn !== undefined && !row.endedOn) {
          throw unprocessable('This driver is still in the unit. Use Unassign to record the drop.');
        }
        if (
          (input.returnedEquipment !== undefined || input.addDropPhotoIds?.length) &&
          !row.endedOn
        ) {
          throw unprocessable('Returned items and drop photos belong to a recorded drop.');
        }
        if (assignedOn > today) throw unprocessable('The assigned date cannot be in the future.');
        if (endedOn && endedOn > today) throw unprocessable('The drop date cannot be in the future.');
        if (endedOn && endedOn < assignedOn) {
          throw unprocessable('The drop date cannot be before the assigned date.');
        }

        if (input.assignedOn !== undefined && input.assignedOn !== row.assignedOn) {
          patch.assignedOn = input.assignedOn;
          changes.push({
            field: 'assignedOn',
            old: `${row.assignedOn}${row.assignedOnApproximate ? ' (approximate)' : ''}`,
            new: input.assignedOn,
          });
          // A date somebody typed is no longer a guess.
          patch.assignedOnApproximate = false;
        }
        if (input.endedOn !== undefined && input.endedOn !== row.endedOn) {
          patch.endedOn = input.endedOn;
          changes.push({ field: 'endedOn', old: row.endedOn, new: input.endedOn });
        }
        if (input.equipment !== undefined) {
          const before = equipmentWords(row.equipment as AssignmentEquipment[]);
          const after = equipmentWords(input.equipment);
          if (before !== after) {
            patch.equipment = input.equipment;
            changes.push({ field: 'equipment', old: before, new: after });
          }
        }
        if (input.returnedEquipment !== undefined) {
          const before = row.returnedEquipment
            ? equipmentWords(row.returnedEquipment as AssignmentEquipment[], 'returned')
            : null;
          const after = equipmentWords(input.returnedEquipment, 'returned');
          if (before !== after) {
            patch.returnedEquipment = input.returnedEquipment;
            changes.push({ field: 'returnedEquipment', old: before, new: after });
          }
        }
        if (input.note !== undefined) {
          const next = input.note?.trim() || null;
          if (next !== (row.note ?? null)) {
            patch.note = next;
            changes.push({ field: 'note', old: row.note, new: next });
          }
        }
        if (input.dropNote !== undefined) {
          const next = input.dropNote?.trim() || null;
          if (next !== (row.dropNote ?? null)) {
            patch.dropNote = next;
            changes.push({ field: 'dropNote', old: row.dropNote, new: next });
          }
        }
        if (input.addPickupPhotoIds?.length) {
          await this.linkPhotos(tx, principal, row.id, 'pickup', input.addPickupPhotoIds, now);
          changes.push({ field: 'pickupPhotos', old: null, new: `+${input.addPickupPhotoIds.length}` });
        }
        if (input.addDropPhotoIds?.length) {
          await this.linkPhotos(tx, principal, row.id, 'drop', input.addDropPhotoIds, now);
          changes.push({ field: 'dropPhotos', old: null, new: `+${input.addDropPhotoIds.length}` });
        }
        if (input.removePhotoIds?.length) {
          const voided = await tx
            .update(truckAssignmentPhotos)
            .set({
              voidedAt: now,
              voidedBy: principal.userName ?? principal.userId,
              voidReason: 'Removed in an assignment edit',
            })
            .where(
              and(
                eq(truckAssignmentPhotos.companyId, principal.companyId),
                eq(truckAssignmentPhotos.assignmentId, row.id),
                inArray(truckAssignmentPhotos.id, input.removePhotoIds),
                isNull(truckAssignmentPhotos.voidedAt),
              ),
            )
            .returning({ id: truckAssignmentPhotos.id, fileName: truckAssignmentPhotos.fileName });
          if (voided.length > 0) {
            changes.push({ field: 'photosRemoved', old: voided.map((p) => p.fileName).join(', '), new: null });
          }
        }
        if (changes.length === 0) return [] as AuditEvent[];

        const updated = await tx
          .update(truckDriverAssignments)
          .set(patch)
          .where(and(eq(truckDriverAssignments.id, id), eq(truckDriverAssignments.version, row.version)))
          .returning({ id: truckDriverAssignments.id });
        if (updated.length === 0) throw stale();
        const names = await this.driverNames(principal, [row.driverId], tx);
        return [
          await this.audit.writeIn(tx, principal, {
            action: 'update',
            entityType: 'truck_driver_assignment',
            entityId: id,
            entityLabel: `Unit ${truck.unitNumber} · ${names.get(row.driverId)?.name ?? row.driverId}`,
            summary: `Assignment on unit ${truck.unitNumber} edited`,
            changes,
            at: now,
          }),
        ];
      }),
    );
    await this.audit.publish(...events);
    return this.view(principal, truck.id);
  }

  /**
   * Voids a closed assignment entered by mistake or as a test (owner, 2026-10-08): never deleted,
   * hidden from the unit's history, with who, when and why in the audit log. An open row cannot be
   * voided - it holds the unit's driver; Unassign it first.
   */
  async void(
    principal: Principal,
    truckIdOrUnit: string,
    id: string,
    input: VoidAssignmentInput,
  ): Promise<TruckAssignmentView> {
    const truck = await this.truck(principal, truckIdOrUnit);
    const now = new Date();
    const events = await this.run(() =>
      this.db.transaction(async (tx) => {
        const row = await this.require(principal, truck.id, id, tx, true);
        if (row.version !== input.version) throw stale();
        if (row.endedOn === null) {
          throw unprocessable('This driver is still in the unit. Unassign them before voiding the entry.');
        }
        if (row.source === VOIDED_SOURCE) return [] as AuditEvent[];
        const updated = await tx
          .update(truckDriverAssignments)
          .set({
            source: VOIDED_SOURCE,
            version: row.version + 1,
            updatedAt: now,
            updatedBy: principal.userId,
            updatedByName: principal.userName ?? principal.userId,
          })
          .where(and(eq(truckDriverAssignments.id, id), eq(truckDriverAssignments.version, row.version)))
          .returning({ id: truckDriverAssignments.id });
        if (updated.length === 0) throw stale();
        const names = await this.driverNames(principal, [row.driverId], tx);
        const who = names.get(row.driverId)?.name ?? row.driverId;
        return [
          await this.audit.writeIn(tx, principal, {
            action: 'void',
            entityType: 'truck_driver_assignment',
            entityId: id,
            entityLabel: `Unit ${truck.unitNumber} · ${who}`,
            summary: `${who} on unit ${truck.unitNumber} (${row.assignedOn} – ${row.endedOn}) voided and removed from the unit's history`,
            reason: input.reason,
            changes: [{ field: 'source', old: row.source, new: VOIDED_SOURCE }],
            at: now,
          }),
        ];
      }),
    );
    await this.audit.publish(...events);
    return this.view(principal, truck.id);
  }

  // ------------------------------------------------------------------------------ helpers

  /** Closes one open row with its drop. Validates the date; links drop photos; audits. */
  private async closeIn(
    tx: Tx,
    principal: Principal,
    row: Row,
    drop: {
      endedOn: string;
      reason: string | null;
      returnedEquipment: AssignmentEquipment[] | null;
      dropNote: string | null;
      dropPhotoIds: string[];
      unitNumber: string;
      driverName: string;
      today: string;
      now: Date;
    },
  ): Promise<AuditEvent[]> {
    if (drop.endedOn < row.assignedOn) {
      throw unprocessable(
        `The drop date cannot be before ${drop.driverName}'s assigned date (${row.assignedOn}).`,
      );
    }
    if (drop.endedOn > drop.today) throw unprocessable('The drop date cannot be in the future.');
    const closed = await tx
      .update(truckDriverAssignments)
      .set({
        endedOn: drop.endedOn,
        endReason: drop.reason,
        endedBy: principal.userId,
        endedByName: principal.userName ?? principal.userId,
        endedAt: drop.now,
        returnedEquipment: drop.returnedEquipment,
        dropNote: drop.dropNote?.trim() || null,
        version: row.version + 1,
        updatedAt: drop.now,
      })
      .where(
        and(
          eq(truckDriverAssignments.id, row.id),
          eq(truckDriverAssignments.version, row.version),
          isNull(truckDriverAssignments.endedOn),
        ),
      )
      .returning({ id: truckDriverAssignments.id });
    if (closed.length === 0) throw stale();
    await this.linkPhotos(tx, principal, row.id, 'drop', drop.dropPhotoIds, drop.now);
    const input: WriteAuditInput = {
      action: 'update',
      entityType: 'truck_driver_assignment',
      entityId: row.id,
      entityLabel: `Unit ${drop.unitNumber} · ${drop.driverName}`,
      summary: `${drop.driverName} taken out of unit ${drop.unitNumber} on ${drop.endedOn}${drop.reason ? ` (${drop.reason})` : ''}`,
      reason: drop.reason,
      changes: [
        { field: 'endedOn', old: null, new: drop.endedOn },
        ...(drop.returnedEquipment
          ? [{ field: 'returnedEquipment', old: null, new: equipmentWords(drop.returnedEquipment, 'returned') }]
          : []),
        ...(drop.dropNote ? [{ field: 'dropNote', old: null, new: drop.dropNote }] : []),
        ...(drop.dropPhotoIds.length
          ? [{ field: 'dropPhotos', old: null, new: String(drop.dropPhotoIds.length) }]
          : []),
      ],
      at: drop.now,
    };
    return [
      await this.audit.writeIn(tx, principal, input),
      await this.audit.writeIn(tx, principal, {
        action: 'update',
        entityType: 'truck',
        entityId: row.truckId,
        entityLabel: `Unit ${drop.unitNumber}`,
        summary: `${drop.driverName} out of the unit on ${drop.endedOn}`,
        changes: [{ field: 'currentDriver', old: drop.driverName, new: null }],
        at: drop.now,
      }),
    ];
  }

  /** Links stored images to an assignment. Only images of this company, each linked once. */
  private async linkPhotos(
    tx: Tx,
    principal: Principal,
    assignmentId: string,
    stage: AssignmentPhotoStage,
    fileIds: string[],
    now: Date,
  ): Promise<void> {
    const wanted = [...new Set(fileIds)];
    if (wanted.length === 0) return;
    const files = await tx
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), inArray(storedFiles.id, wanted)));
    const allowed = new Set<string>(ASSIGNMENT_PHOTO_TYPES);
    for (const fileId of wanted) {
      const file = files.find((f) => f.id === fileId);
      if (!file) throw unprocessable('A photo was not found; upload it again.');
      if (!allowed.has(file.contentType)) throw unprocessable(`${file.fileName} is not a photo.`);
    }
    const taken = await tx
      .select({ fileId: truckAssignmentPhotos.fileId })
      .from(truckAssignmentPhotos)
      .where(
        and(
          eq(truckAssignmentPhotos.companyId, principal.companyId),
          inArray(truckAssignmentPhotos.fileId, wanted),
          isNull(truckAssignmentPhotos.voidedAt),
        ),
      );
    if (taken.length > 0) throw unprocessable('A photo is already attached to an assignment.');
    await tx.insert(truckAssignmentPhotos).values(
      wanted.map((fileId) => {
        const file = files.find((f) => f.id === fileId)!;
        return {
          id: `tap_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          assignmentId,
          stage,
          fileId,
          fileName: file.fileName,
          contentType: file.contentType,
          uploadedBy: principal.userId,
          uploadedByName: principal.userName ?? principal.userId,
          uploadedAt: now,
        };
      }),
    );
  }

  /**
   * The dispatch board's row for this driver follows the truck page (0047).
   *
   * A board row with no truck of its own reads the driver file's truck, so it already follows. A
   * row with a truck typed on the board that now disagrees with the pairing would keep showing the
   * old unit; its typed truck is cleared so it reads the pairing from here on. Versioned and
   * written to the board's own audit log; the board appends the dated history row on its next
   * read, as it does for every change that comes from the driver file.
   */
  private async boardFollows(
    tx: Tx,
    principal: Principal,
    driverId: string,
    unitNumber: string | null,
    now: Date,
  ): Promise<void> {
    const rows = await tx
      .select()
      .from(dispatchRoster)
      .where(
        and(
          eq(dispatchRoster.companyId, principal.companyId),
          eq(dispatchRoster.driverId, driverId),
          isNull(dispatchRoster.unassignedAt),
        ),
      );
    for (const r of rows) {
      if (!r.truckUnit) continue;
      if (unitNumber !== null && cleanTruck(r.truckUnit) === cleanTruck(unitNumber)) continue;
      await tx
        .update(dispatchRoster)
        .set({ truckUnit: null, version: r.version + 1, updatedAt: now })
        .where(and(eq(dispatchRoster.id, r.id), eq(dispatchRoster.version, r.version)));
      await dispatchAudit(
        tx,
        principal,
        now,
        'roster',
        r.id,
        'truck-follows-assignment',
        { truckUnit: r.truckUnit },
        { truckUnit: null, followsTruckPage: unitNumber },
      );
    }
  }

  private async openRow(
    tx: Tx,
    principal: Principal,
    by: { truckId?: string; driverId?: string },
    lock = true,
  ): Promise<Row | null> {
    const q = tx
      .select()
      .from(truckDriverAssignments)
      .where(
        and(
          eq(truckDriverAssignments.companyId, principal.companyId),
          by.truckId ? eq(truckDriverAssignments.truckId, by.truckId) : undefined,
          by.driverId ? eq(truckDriverAssignments.driverId, by.driverId) : undefined,
          isNull(truckDriverAssignments.endedOn),
        ),
      )
      .limit(1);
    const [row] = lock ? await q.for('update') : await q;
    return row ?? null;
  }

  /** Maps races to a 409: a unique-index clash (two open rows) or a deadlock between two assigns. */
  private async run<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      const code = pgCode(error);
      if (code === '23505' || code === '40P01' || code === '40001') {
        throw conflict(
          'Somebody else changed this unit or driver at the same moment; reload and try again.',
        );
      }
      throw error;
    }
  }

  private async truck(principal: Principal, idOrUnit: string): Promise<TruckRow> {
    const [byId] = await this.db
      .select()
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, idOrUnit)))
      .limit(1);
    const row =
      byId ??
      (
        await this.db
          .select()
          .from(trucks)
          .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.unitNumber, idOrUnit)))
          .limit(1)
      )[0];
    if (!row) throw notFound(`No truck ${idOrUnit}`);
    return row;
  }

  private async require(
    principal: Principal,
    truckId: string,
    id: string,
    tx: Tx | Database = this.db,
    lock = false,
  ): Promise<Row> {
    const q = tx
      .select()
      .from(truckDriverAssignments)
      .where(
        and(
          eq(truckDriverAssignments.companyId, principal.companyId),
          eq(truckDriverAssignments.truckId, truckId),
          eq(truckDriverAssignments.id, id),
        ),
      )
      .limit(1);
    const [row] = lock ? await q.for('update') : await q;
    if (!row) throw notFound('No such assignment');
    return row;
  }

  private async driverNames(principal: Principal, ids: string[], tx: Tx | Database = this.db) {
    const map = new Map<string, { name: string; number: string }>();
    const wanted = [...new Set(ids.filter(Boolean))];
    if (wanted.length === 0) return map;
    const rows = await tx
      .select({
        id: drivers.id,
        first: drivers.firstName,
        last: drivers.lastName,
        number: drivers.driverNumber,
      })
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), inArray(drivers.id, wanted)));
    for (const r of rows) map.set(r.id, { name: `${r.first} ${r.last}`.trim(), number: r.number });
    return map;
  }

  private async photosFor(principal: Principal, assignmentIds: string[]) {
    const map = new Map<string, PhotoRow[]>();
    if (assignmentIds.length === 0) return map;
    const rows = await this.db
      .select()
      .from(truckAssignmentPhotos)
      .where(
        and(
          eq(truckAssignmentPhotos.companyId, principal.companyId),
          inArray(truckAssignmentPhotos.assignmentId, assignmentIds),
          isNull(truckAssignmentPhotos.voidedAt),
        ),
      )
      .orderBy(truckAssignmentPhotos.uploadedAt);
    for (const r of rows) map.set(r.assignmentId, [...(map.get(r.assignmentId) ?? []), r]);
    return map;
  }

  private toRecord(
    row: Row,
    unitNumber: string,
    names: Map<string, { name: string; number: string }>,
    photos: PhotoRow[],
  ): TruckDriverAssignment {
    const who = names.get(row.driverId);
    const photo = (p: PhotoRow): AssignmentPhoto => ({
      id: p.id,
      stage: p.stage === 'drop' ? 'drop' : 'pickup',
      fileId: p.fileId,
      url: FilesService.urlFor(p.fileId),
      fileName: p.fileName,
      contentType: p.contentType,
      uploadedByName: p.uploadedByName,
      uploadedAt: p.uploadedAt.toISOString(),
    });
    return {
      id: row.id,
      truckId: row.truckId,
      unitNumber,
      driverId: row.driverId,
      driverName: who?.name ?? 'Unknown driver',
      driverNumber: who?.number ?? '',
      assignedOn: row.assignedOn,
      endedOn: row.endedOn ?? null,
      endReason: row.endReason ?? null,
      equipment: Array.isArray(row.equipment) ? (row.equipment as AssignmentEquipment[]) : [],
      note: row.note ?? null,
      version: row.version,
      createdByName: row.createdByName,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      assignedOnApproximate: row.assignedOnApproximate,
      source: row.source,
      returnedEquipment: Array.isArray(row.returnedEquipment)
        ? (row.returnedEquipment as AssignmentEquipment[])
        : null,
      dropNote: row.dropNote ?? null,
      // Rows closed before 0047 kept the name in ended_by.
      endedByName: row.endedByName ?? (row.endedOn ? (row.endedBy ?? null) : null),
      endedAt: row.endedAt ? row.endedAt.toISOString() : null,
      editedByName: row.updatedByName ?? null,
      editedAt: row.updatedByName ? row.updatedAt.toISOString() : null,
      pickupPhotos: photos.filter((p) => p.stage !== 'drop').map(photo),
      dropPhotos: photos.filter((p) => p.stage === 'drop').map(photo),
    };
  }
}

function stale(): AppError {
  return conflict('This assignment was changed by somebody else; reload and try again');
}

function pgCode(error: unknown): string | null {
  let e: unknown = error;
  for (let i = 0; i < 4 && e && typeof e === 'object'; i += 1) {
    const code = (e as { code?: unknown }).code;
    if (typeof code === 'string' && /^[0-9A-Z]{5}$/.test(code)) return code;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

function equipmentWords(items: AssignmentEquipment[], mode: 'handed' | 'returned' = 'handed'): string | null {
  if (items.length === 0) return null;
  const not = mode === 'returned' ? ' (not returned)' : ' (not handed over)';
  return items.map((e) => `${e.label}${e.detail ? ` ${e.detail}` : ''}${e.handedOver ? '' : not}`).join(', ');
}
