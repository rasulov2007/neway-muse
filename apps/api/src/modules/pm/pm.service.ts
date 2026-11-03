import { Injectable } from '@nestjs/common';
import { and, desc, eq, gte, inArray, isNull, lte, ne, sql } from 'drizzle-orm';
import {
  PM_SERVICE_LABEL,
  PM_SETTINGS,
  averageMilesPerDay,
  computePmStatus,
  dateInZone,
  median,
  readingConflict,
  odometerConflictMessage,
  type OdometerConflictReason,
  resolvePlan,
  type CreateReadingInput,
  type OdometerReading,
  type OdometerSource,
  type PmPlan,
  type PmService as PmServiceRecord,
  type PmServiceCode,
  type PmSettings,
  type PmStatus,
  type SetPmPlanInput,
  type SetUnitGroupInput,
  type VoidPmPlanInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { storedFiles } from '../../database/schema/files';
import { unitMaintenanceSettings, workOrders } from '../../database/schema/fleet';
import { odometerReadings, pmPlans, pmServices, pmStatus } from '../../database/schema/pm';
import { companies, trucks } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';

/**
 * Oil change / PM: the one calculation (docs/pm-module §5), and the records it reads.
 *
 * Every screen reads `pm_status`; this service is the only thing that writes it, and it does so
 * from `computePmStatus` in the shared package - the same function the tests run - so the board,
 * the truck page and Truck Health cannot disagree about a truck. Recomputed when a reading
 * arrives, a plan changes, a completion is saved, and nightly.
 *
 * The clock is a property so a test can freeze it (the acceptance tests run at 2026-09-17 07:45
 * America/Chicago); in the running product it is the wall clock, never the demo clock.
 */

type ReadingRow = typeof odometerReadings.$inferSelect;
type PlanRow = typeof pmPlans.$inferSelect;
type TruckRow = {
  id: string;
  unitNumber: string;
  status: string;
  groupName: string | null;
  pmResponsibility: string;
  lessorName: string | null;
};

const RETIRED = new Set(['sold', 'inactive', 'archived']);
const DAY_MS = 86_400_000;

export interface EldReadingInput {
  unitId: string;
  odometerMiles: number;
  engineHours: number | null;
  readingAt: string;
}

@Injectable()
export class PmService {
  /** Wall clock unless a test freezes it. */
  clock: () => Date = () => new Date();
  settings: PmSettings = PM_SETTINGS;

  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ================================================================================ catalog

  /** Seeds OIL_CHANGE for the company the first time anything asks. */
  async ensureServices(companyId: string): Promise<void> {
    await this.db
      .insert(pmServices)
      .values({
        id: `pms_${companyId}_OIL_CHANGE`,
        companyId,
        code: 'OIL_CHANGE',
        name: PM_SERVICE_LABEL.OIL_CHANGE,
        resetsInterval: true,
        defaultIntervalMiles: this.settings.fleetIntervalMiles,
      })
      .onConflictDoNothing();
  }

  async services(principal: Principal): Promise<PmServiceRecord[]> {
    await this.ensureServices(principal.companyId);
    const rows = await this.db
      .select()
      .from(pmServices)
      .where(eq(pmServices.companyId, principal.companyId));
    return rows.map((row) => ({
      code: row.code as PmServiceCode,
      name: row.name,
      resetsInterval: row.resetsInterval,
      defaultIntervalMiles: row.defaultIntervalMiles,
      defaultIntervalDays: row.defaultIntervalDays,
      defaultIntervalHours: row.defaultIntervalHours,
    }));
  }

  // ================================================================================ plans

  async plans(
    principal: Principal,
    filter: { unitId?: string; includeVoided?: boolean } = {},
  ): Promise<PmPlan[]> {
    const rows = await this.db
      .select({ plan: pmPlans, unitNumber: trucks.unitNumber })
      .from(pmPlans)
      .leftJoin(trucks, eq(trucks.id, pmPlans.unitId))
      .where(
        and(
          eq(pmPlans.companyId, principal.companyId),
          ...(filter.includeVoided ? [] : [isNull(pmPlans.voidedAt)]),
          ...(filter.unitId ? [eq(pmPlans.unitId, filter.unitId)] : []),
        ),
      )
      // Active first, then newest: a superseded plan shares its successor's set time to the second.
      .orderBy(sql`${pmPlans.voidedAt} IS NULL DESC`, desc(pmPlans.setAt), desc(pmPlans.createdAt));
    return rows.map((r) => this.toPlan(r.plan, r.unitNumber));
  }

  /**
   * Sets an interval. The previous active plan for the same target is voided as superseded,
   * so history keeps every interval the truck ever ran and the calculation reads the newest.
   * A group default takes `trucks.edit` (fleet manager); a unit override takes `maintenance.edit`
   * with a reason (§9).
   */
  async setPlan(principal: Principal, input: SetPmPlanInput): Promise<PmPlan> {
    if (input.scope === 'group' && !hasPermission(principal, 'trucks.edit')) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Changing a group default takes trucks.edit',
      });
    }
    if (
      input.scope === 'unit' &&
      !hasPermission(principal, 'maintenance.edit') &&
      !hasPermission(principal, 'trucks.edit')
    ) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Changing a unit interval takes maintenance.edit',
      });
    }
    await this.ensureServices(principal.companyId);
    let unitNumber: string | null = null;
    if (input.scope === 'unit') {
      const [truck] = await this.db
        .select({ unitNumber: trucks.unitNumber })
        .from(trucks)
        .where(
          and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.unitId as string)),
        )
        .limit(1);
      if (!truck)
        throw new AppError({
          status: 404,
          title: 'Not Found',
          detail: 'That unit is not in the fleet',
        });
      unitNumber = truck.unitNumber;
    }

    const now = this.clock();
    const previous = await this.activePlan(principal.companyId, input);
    const id = `pmp_${crypto.randomUUID()}`;
    await this.db.transaction(async (tx) => {
      if (previous) {
        await tx
          .update(pmPlans)
          .set({
            voidedAt: now,
            voidedBy: principal.userId,
            voidReason: 'superseded',
            updatedAt: now,
            version: previous.version + 1,
          })
          .where(eq(pmPlans.id, previous.id));
      }
      await tx.insert(pmPlans).values({
        id,
        companyId: principal.companyId,
        serviceCode: input.serviceCode,
        scope: input.scope,
        groupName: input.scope === 'group' ? input.groupName : null,
        unitId: input.scope === 'unit' ? input.unitId : null,
        intervalMiles: input.intervalMiles,
        intervalDays: input.intervalDays,
        intervalHours: input.intervalHours,
        dueSoonMiles: input.dueSoonMiles,
        dueSoonDays: input.dueSoonDays,
        reason: input.reason,
        setBy: principal.userId,
        setByName: principal.userName ?? principal.userId,
        setAt: now,
        createdAt: now,
        updatedAt: now,
      });
    });

    const target = input.scope === 'unit' ? `unit ${unitNumber}` : `group ${input.groupName}`;
    await this.audit.write(principal, {
      action: previous ? 'update' : 'create',
      entityType: 'pm_plan',
      entityId: id,
      entityLabel: `${PM_SERVICE_LABEL[input.serviceCode]} · ${target}`,
      summary: `${PM_SERVICE_LABEL[input.serviceCode]} interval for ${target} set to ${input.intervalMiles.toLocaleString('en-US')} mi${input.intervalDays ? ` / ${input.intervalDays} days` : ''}`,
      reason: input.reason,
      changes: [
        {
          field: 'intervalMiles',
          old: previous ? String(previous.intervalMiles) : null,
          new: String(input.intervalMiles),
        },
        {
          field: 'intervalDays',
          old:
            previous?.intervalDays === null || previous === null
              ? null
              : String(previous.intervalDays),
          new: input.intervalDays === null ? null : String(input.intervalDays),
        },
      ],
    });

    await this.recompute(
      principal.companyId,
      input.scope === 'unit' ? [input.unitId as string] : undefined,
    );
    const [saved] = await this.plans(principal, { includeVoided: true }).then((all) =>
      all.filter((p) => p.id === id),
    );
    return saved as PmPlan;
  }

  /** Removes an interval; the unit falls back to its group, then the fleet (§3.2). */
  async voidPlan(principal: Principal, id: string, input: VoidPmPlanInput): Promise<PmPlan> {
    const [row] = await this.db
      .select()
      .from(pmPlans)
      .where(and(eq(pmPlans.companyId, principal.companyId), eq(pmPlans.id, id)))
      .limit(1);
    if (!row)
      throw new AppError({ status: 404, title: 'Not Found', detail: 'That plan does not exist' });
    if (row.voidedAt)
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'That plan is already removed',
      });
    if (row.version !== input.version)
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Somebody changed this plan; reload and try again',
      });
    if (row.scope === 'group' && !hasPermission(principal, 'trucks.edit')) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Removing a group default takes trucks.edit',
      });
    }
    if (
      row.scope === 'unit' &&
      !hasPermission(principal, 'maintenance.edit') &&
      !hasPermission(principal, 'trucks.edit')
    ) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Removing a unit interval takes maintenance.edit',
      });
    }
    const now = this.clock();
    await this.db
      .update(pmPlans)
      .set({
        voidedAt: now,
        voidedBy: principal.userId,
        voidReason: input.reason,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(pmPlans.id, id));
    await this.audit.write(principal, {
      action: 'delete',
      entityType: 'pm_plan',
      entityId: id,
      entityLabel: `${PM_SERVICE_LABEL[row.serviceCode as PmServiceCode]} · ${row.scope === 'unit' ? `unit ${row.unitId}` : `group ${row.groupName}`}`,
      summary: `Interval removed (${row.intervalMiles.toLocaleString('en-US')} mi); the ${row.scope === 'unit' ? 'group default' : 'fleet default'} applies`,
      reason: input.reason,
      changes: [{ field: 'intervalMiles', old: String(row.intervalMiles), new: null }],
    });
    await this.recompute(principal.companyId, row.unitId ? [row.unitId] : undefined);
    const [saved] = await this.plans(principal, { includeVoided: true }).then((all) =>
      all.filter((p) => p.id === id),
    );
    return saved as PmPlan;
  }

  /**
   * A unit's group - the owner's "truck type" (2026-09-22). The group plan is what the engine
   * reads next after a unit plan (§3.2), so this is the one write that changes a unit's interval
   * without a plan of its own. Audited; the status is recomputed straight away.
   */
  async setUnitGroup(
    principal: Principal,
    unitId: string,
    input: SetUnitGroupInput,
  ): Promise<{ unitId: string; groupName: string | null }> {
    if (!hasPermission(principal, 'maintenance.edit') && !hasPermission(principal, 'trucks.edit')) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Changing a truck type takes maintenance.edit',
      });
    }
    const [truck] = await this.db
      .select({ id: trucks.id, unitNumber: trucks.unitNumber, groupName: trucks.groupName })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, unitId)))
      .limit(1);
    if (!truck)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That unit is not in the fleet',
      });
    const now = this.clock();
    await this.db
      .update(trucks)
      .set({ groupName: input.groupName, updatedAt: now })
      .where(eq(trucks.id, truck.id));
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'truck',
      entityId: truck.id,
      entityLabel: `Unit ${truck.unitNumber}`,
      summary: input.groupName
        ? `Unit ${truck.unitNumber} is a ${input.groupName}; its oil-change interval follows the type`
        : `Unit ${truck.unitNumber} has no truck type; it uses the fleet interval`,
      reason: null,
      changes: [{ field: 'groupName', old: truck.groupName, new: input.groupName }],
    });
    await this.recompute(principal.companyId, [truck.id]);
    return { unitId: truck.id, groupName: input.groupName };
  }

  private async activePlan(
    companyId: string,
    target: { serviceCode: string; scope: string; unitId: string | null; groupName: string | null },
  ): Promise<PlanRow | null> {
    const [row] = await this.db
      .select()
      .from(pmPlans)
      .where(
        and(
          eq(pmPlans.companyId, companyId),
          eq(pmPlans.serviceCode, target.serviceCode),
          eq(pmPlans.scope, target.scope),
          isNull(pmPlans.voidedAt),
          target.scope === 'unit'
            ? eq(pmPlans.unitId, target.unitId as string)
            : eq(pmPlans.groupName, target.groupName as string),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  // ================================================================================ readings

  async readings(principal: Principal, unitId: string, limit = 20): Promise<OdometerReading[]> {
    const rows = await this.db
      .select({ reading: odometerReadings, unitNumber: trucks.unitNumber })
      .from(odometerReadings)
      .leftJoin(trucks, eq(trucks.id, odometerReadings.unitId))
      .where(
        and(
          eq(odometerReadings.companyId, principal.companyId),
          eq(odometerReadings.unitId, unitId),
        ),
      )
      .orderBy(desc(odometerReadings.readingAt))
      .limit(limit);
    return rows.map((r) => this.toReading(r.reading, r.unitNumber ?? ''));
  }

  /** Every reading that failed validation and has not been voided: the list a person works. */
  async conflicts(principal: Principal): Promise<OdometerReading[]> {
    const rows = await this.db
      .select({ reading: odometerReadings, unitNumber: trucks.unitNumber })
      .from(odometerReadings)
      .leftJoin(trucks, eq(trucks.id, odometerReadings.unitId))
      .where(
        and(
          eq(odometerReadings.companyId, principal.companyId),
          eq(odometerReadings.status, 'conflict'),
        ),
      )
      .orderBy(desc(odometerReadings.readingAt))
      .limit(200);
    return rows.map((r) => this.toReading(r.reading, r.unitNumber ?? ''));
  }

  /**
   * A reading entered by a person, written from an invoice, or imported (§3.4, §6.4). Validated
   * against the last good reading before it; a failure is stored as a conflict and never used.
   * A manual reading needs its photo, and is audited under the person's name.
   */
  async addReading(principal: Principal, input: CreateReadingInput): Promise<OdometerReading> {
    if (
      !hasPermission(principal, 'maintenance.edit') &&
      !hasPermission(principal, 'dispatch.edit') &&
      !hasPermission(principal, 'trucks.edit')
    ) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Entering a reading takes maintenance.edit or dispatch.edit',
      });
    }
    const [truck] = await this.db
      .select({ id: trucks.id, unitNumber: trucks.unitNumber })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.unitId)))
      .limit(1);
    if (!truck)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That unit is not in the fleet',
      });

    const readingAt = new Date(input.readingAt);
    if (Number.isNaN(readingAt.getTime()))
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That reading time is not a time',
      });
    const now = this.clock();
    if (readingAt.getTime() > now.getTime() + 60 * 60_000) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'A reading cannot be taken in the future',
      });
    }
    if (input.source === 'manual' && this.settings.manualReadingPhotoRequired) {
      if (!input.photoId) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'A manual reading needs a photo of the odometer. Add one before saving.',
        });
      }
      const [photo] = await this.db
        .select({ id: storedFiles.id, contentType: storedFiles.contentType })
        .from(storedFiles)
        .where(
          and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, input.photoId)),
        )
        .limit(1);
      if (!photo)
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'That photo was not uploaded',
        });
      if (!photo.contentType.startsWith('image/'))
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'The odometer photo has to be an image',
        });
    }

    return this.recordReading(principal, truck, {
      readingAt,
      odometerMiles: input.odometerMiles,
      engineHours: input.engineHours,
      source: input.source,
      photoId: input.photoId,
      note: input.note,
    });
  }

  /**
   * A manual reading written on behalf of another module that has already checked its own
   * permission - Accounting entering the odometer at both ends of a settlement week (owner,
   * 2026-10-21). No photo is asked for; the note says where it came from. The mileage check is
   * the same as for any reading: a figure below the last good one is stored as a conflict and
   * never used, so the statement keeps saying it cannot be figured rather than guessing.
   */
  async recordManualReading(
    principal: Principal,
    input: { unitId: string; readingAt: Date; odometerMiles: number; note: string | null },
  ): Promise<OdometerReading> {
    const [truck] = await this.db
      .select({ id: trucks.id, unitNumber: trucks.unitNumber })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, input.unitId)))
      .limit(1);
    if (!truck)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That unit is not in the fleet',
      });
    if (input.readingAt.getTime() > this.clock().getTime() + 60 * 60_000) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'A reading cannot be taken in the future',
      });
    }
    return this.recordReading(principal, truck, {
      readingAt: input.readingAt,
      odometerMiles: input.odometerMiles,
      engineHours: null,
      source: 'manual',
      photoId: null,
      note: input.note,
    });
  }

  /** Writes a checked reading, audits a manual one under the person's name, recomputes the unit. */
  private async recordReading(
    principal: Principal,
    truck: { id: string; unitNumber: string },
    input: {
      readingAt: Date;
      odometerMiles: number;
      engineHours: number | null;
      source: OdometerSource;
      photoId: string | null;
      note: string | null;
    },
  ): Promise<OdometerReading> {
    const timeZone = await this.timeZone(principal.companyId);
    const saved = await this.writeReading(principal.companyId, {
      unitId: truck.id,
      readingAt: input.readingAt,
      odometerMiles: input.odometerMiles,
      engineHours: input.engineHours,
      source: input.source,
      photoId: input.photoId,
      note: input.note,
      createdBy: principal.userId,
      createdByName: principal.userName ?? principal.userId,
      timeZone,
    });

    if (input.source === 'manual') {
      await this.audit.write(principal, {
        action: 'create',
        entityType: 'odometer_reading',
        entityId: saved.id,
        entityLabel: `Unit ${truck.unitNumber}`,
        summary:
          saved.status === 'conflict'
            ? `Manual reading ${input.odometerMiles.toLocaleString('en-US')} mi stored as a conflict (${saved.conflictReason})`
            : `Manual reading ${input.odometerMiles.toLocaleString('en-US')} mi at ${input.readingAt.toISOString()}`,
        changes: [
          {
            field: 'odometerMiles',
            old: saved.conflictWith === null ? null : String(saved.conflictWith),
            new: String(input.odometerMiles),
          },
        ],
      });
    }
    await this.recompute(principal.companyId, [truck.id]);
    return this.toReading(saved, truck.unitNumber);
  }

  /**
   * The telematics feed: one `eld` row per unit per company day, kept current through the day.
   * Called by the Samsara sync with every matched vehicle's latest reading, changed or not, so a
   * parked truck still has today's reading. Validation is the same as for any reading.
   */
  async ingestEldReadings(
    companyId: string,
    inputs: EldReadingInput[],
    sourceName = 'Samsara sync',
  ): Promise<{ written: number; conflicts: number }> {
    if (inputs.length === 0) return { written: 0, conflicts: 0 };
    const timeZone = await this.timeZone(companyId);
    let written = 0;
    let conflicts = 0;
    const units: string[] = [];
    for (const input of inputs) {
      const readingAt = new Date(input.readingAt);
      if (Number.isNaN(readingAt.getTime())) continue;
      const readingDate = dateInZone(readingAt, timeZone);
      const [existing] = await this.db
        .select()
        .from(odometerReadings)
        .where(
          and(
            eq(odometerReadings.companyId, companyId),
            eq(odometerReadings.unitId, input.unitId),
            eq(odometerReadings.source, 'eld'),
            eq(odometerReadings.readingDate, readingDate),
          ),
        )
        .limit(1);
      // The day's row is replaced only by a later reading; the hourly sync re-sends the same one.
      if (existing && existing.readingAt.getTime() >= readingAt.getTime()) continue;
      if (existing)
        await this.db.delete(odometerReadings).where(eq(odometerReadings.id, existing.id));
      const saved = await this.writeReading(companyId, {
        unitId: input.unitId,
        readingAt,
        odometerMiles: input.odometerMiles,
        engineHours: input.engineHours,
        source: 'eld',
        photoId: null,
        note: null,
        createdBy: 'system',
        createdByName: sourceName,
        timeZone,
        ignoreId: existing?.id ?? null,
      });
      written += 1;
      if (saved.status === 'conflict') conflicts += 1;
      units.push(input.unitId);
    }
    if (units.length > 0) await this.recompute(companyId, units);
    return { written, conflicts };
  }

  /**
   * The mileage check for a reading another module writes itself (a work order's or an invoice's
   * odometer, keyed on the order): the same rule as any reading - below the last good one, far
   * above it (owner, 2026-10-22: more than 3,000 mi a day is implausible_jump), or above the
   * daily limit - so a typo is stored as a conflict that nothing uses, never silently as good.
   */
  async checkReading(
    companyId: string,
    input: { unitId: string; readingAt: Date; odometerMiles: number; ignoreId?: string | null },
  ): Promise<{ status: 'ok' | 'conflict'; conflictReason: OdometerConflictReason | null; conflictWith: number | null; message: string | null }> {
    const [previous] = await this.db
      .select()
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          eq(odometerReadings.unitId, input.unitId),
          eq(odometerReadings.status, 'ok'),
          lte(odometerReadings.readingAt, input.readingAt),
          ...(input.ignoreId ? [ne(odometerReadings.id, input.ignoreId)] : []),
        ),
      )
      .orderBy(desc(odometerReadings.readingAt))
      .limit(1);
    const conflict = readingConflict(
      previous ? { odometerMiles: previous.odometerMiles, readingAt: previous.readingAt.toISOString() } : null,
      { odometerMiles: input.odometerMiles, readingAt: input.readingAt.toISOString() },
      this.settings,
    );
    const conflictWith = conflict && previous ? previous.odometerMiles : null;
    return { status: conflict ? 'conflict' : 'ok', conflictReason: conflict, conflictWith, message: odometerConflictMessage(conflict, input.odometerMiles, conflictWith) };
  }

  private async writeReading(
    companyId: string,
    input: {
      unitId: string;
      readingAt: Date;
      odometerMiles: number;
      engineHours: number | null;
      source: OdometerSource;
      photoId: string | null;
      note: string | null;
      createdBy: string;
      createdByName: string;
      timeZone: string;
      ignoreId?: string | null;
      ageUnknown?: boolean;
    },
  ): Promise<ReadingRow> {
    // The last good reading before this one is what it is checked against.
    const [previous] = await this.db
      .select()
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          eq(odometerReadings.unitId, input.unitId),
          eq(odometerReadings.status, 'ok'),
          lte(odometerReadings.readingAt, input.readingAt),
          ...(input.ignoreId ? [ne(odometerReadings.id, input.ignoreId)] : []),
        ),
      )
      .orderBy(desc(odometerReadings.readingAt))
      .limit(1);
    const conflict = readingConflict(
      previous
        ? { odometerMiles: previous.odometerMiles, readingAt: previous.readingAt.toISOString() }
        : null,
      { odometerMiles: input.odometerMiles, readingAt: input.readingAt.toISOString() },
      this.settings,
    );
    const [row] = await this.db
      .insert(odometerReadings)
      .values({
        id: `odr_${crypto.randomUUID()}`,
        companyId,
        unitId: input.unitId,
        readingAt: input.readingAt,
        readingDate: dateInZone(input.readingAt, input.timeZone),
        odometerMiles: input.odometerMiles,
        engineHours: input.engineHours === null ? null : String(input.engineHours),
        source: input.source,
        status: conflict ? 'conflict' : 'ok',
        conflictReason: conflict,
        conflictWith: conflict && previous ? previous.odometerMiles : null,
        photoId: input.photoId,
        note: input.note,
        ageUnknown: input.ageUnknown ?? false,
        createdBy: input.createdBy,
        createdByName: input.createdByName,
        createdAt: this.clock(),
      })
      .returning();
    return row as ReadingRow;
  }

  // ================================================================================ status

  async status(principal: Principal, unitId: string): Promise<PmStatus> {
    const [row] = await this.db
      .select()
      .from(pmStatus)
      .where(
        and(
          eq(pmStatus.companyId, principal.companyId),
          eq(pmStatus.unitId, unitId),
          eq(pmStatus.serviceCode, 'OIL_CHANGE'),
        ),
      )
      .limit(1);
    if (!row) {
      await this.recompute(principal.companyId, [unitId]);
      const [fresh] = await this.db
        .select()
        .from(pmStatus)
        .where(
          and(
            eq(pmStatus.companyId, principal.companyId),
            eq(pmStatus.unitId, unitId),
            eq(pmStatus.serviceCode, 'OIL_CHANGE'),
          ),
        )
        .limit(1);
      if (!fresh)
        throw new AppError({
          status: 404,
          title: 'Not Found',
          detail: 'That unit is not on the PM board',
        });
      return this.toStatus(fresh, await this.truckSummary(principal.companyId, unitId));
    }
    return this.toStatus(row, await this.truckSummary(principal.companyId, unitId));
  }

  async statuses(principal: Principal): Promise<PmStatus[]> {
    const rows = await this.db
      .select({ status: pmStatus, truck: trucks })
      .from(pmStatus)
      .innerJoin(trucks, eq(trucks.id, pmStatus.unitId))
      .where(
        and(
          eq(pmStatus.companyId, principal.companyId),
          eq(pmStatus.serviceCode, 'OIL_CHANGE'),
          // Archived trucks (owner, 2026-10-05) are off the PM board and out of every count.
          ne(trucks.status, 'archived'),
        ),
      );
    return rows.map((r) => this.toStatus(r.status, this.summaryOf(r.truck)));
  }

  /** C9: how many trucks have a usable reading in the last day, and in the stale window. */
  async coverage(
    principal: Principal,
  ): Promise<{
    total: number;
    fresh: number;
    usable: number;
    noReading: number;
    conflicts: number;
  }> {
    const statuses = await this.statuses(principal);
    const active = statuses.filter((s) => !RETIRED.has(s.unitStatus));
    const fresh = active.filter(
      (s) => s.readingAgeHours !== null && s.readingAgeHours <= this.settings.coverageHours,
    ).length;
    const usable = active.filter((s) => s.readingAt !== null && !s.readingStale).length;
    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, principal.companyId),
          eq(odometerReadings.status, 'conflict'),
        ),
      );
    return {
      total: active.length,
      fresh,
      usable,
      noReading: active.length - usable,
      conflicts: counted?.count ?? 0,
    };
  }

  /**
   * The calculation, for every unit or the ones named. Reads the plans, the last completed
   * service, the readings and the group averages; writes `pm_status`. Idempotent.
   */
  async recompute(companyId: string, unitIds?: string[]): Promise<{ computed: number }> {
    await this.ensureServices(companyId);
    const now = this.clock();
    const timeZone = await this.timeZone(companyId);

    const fleet = await this.db
      .select({
        id: trucks.id,
        unitNumber: trucks.unitNumber,
        status: trucks.status,
        groupName: trucks.groupName,
        pmResponsibility: trucks.pmResponsibility,
        lessorName: trucks.lessorName,
      })
      .from(trucks)
      .where(
        and(
          eq(trucks.companyId, companyId),
          // An archived truck gets no PM status: it is not on the board.
          ne(trucks.status, 'archived'),
          ...(unitIds ? [inArray(trucks.id, unitIds)] : []),
        ),
      );
    if (fleet.length === 0) return { computed: 0 };
    const ids = fleet.map((t) => t.id);

    const plans = await this.db
      .select()
      .from(pmPlans)
      .where(
        and(
          eq(pmPlans.companyId, companyId),
          eq(pmPlans.serviceCode, 'OIL_CHANGE'),
          isNull(pmPlans.voidedAt),
        ),
      );
    const unitPlans = new Map(
      plans.filter((p) => p.scope === 'unit' && p.unitId).map((p) => [p.unitId as string, p]),
    );
    const groupPlans = new Map(
      plans
        .filter((p) => p.scope === 'group' && p.groupName)
        .map((p) => [p.groupName as string, p]),
    );

    // The baseline: the newest recorded completion for the service, else the older settings row.
    const completions = await this.db
      .select({
        id: workOrders.id,
        unitId: workOrders.unitId,
        serviceAt: workOrders.serviceAt,
        serviceOdometer: workOrders.serviceOdometer,
        enteredVia: workOrders.enteredVia,
      })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          inArray(workOrders.unitId, ids),
          eq(workOrders.status, 'completed'),
          eq(workOrders.pmServiceCode, 'OIL_CHANGE'),
          isNull(workOrders.voidedAt),
        ),
      )
      .orderBy(desc(workOrders.serviceAt));
    const lastByUnit = new Map<
      string,
      {
        id: string | null;
        at: string;
        odometerMiles: number;
        source: 'completion' | 'import' | 'baseline';
      }
    >();
    for (const c of completions) {
      if (lastByUnit.has(c.unitId) || !c.serviceAt || c.serviceOdometer === null) continue;
      lastByUnit.set(c.unitId, {
        id: c.id,
        at: c.serviceAt.toISOString(),
        odometerMiles: c.serviceOdometer,
        source: c.enteredVia === 'import' ? 'import' : 'completion',
      });
    }
    const baselines = await this.db
      .select({
        unitId: unitMaintenanceSettings.unitId,
        at: unitMaintenanceSettings.lastOilChangeAt,
        odometer: unitMaintenanceSettings.lastOilChangeOdometer,
      })
      .from(unitMaintenanceSettings)
      .where(
        and(
          eq(unitMaintenanceSettings.companyId, companyId),
          eq(unitMaintenanceSettings.assetType, 'truck'),
          inArray(unitMaintenanceSettings.unitId, ids),
        ),
      );
    for (const b of baselines) {
      if (lastByUnit.has(b.unitId) || !b.at || b.odometer === null) continue;
      lastByUnit.set(b.unitId, {
        id: null,
        at: b.at.toISOString(),
        odometerMiles: b.odometer,
        source: 'baseline',
      });
    }

    // Readings: the last 90 days for the averages, plus the newest usable one however old.
    const since = new Date(now.getTime() - 90 * DAY_MS);
    const recent = await this.db
      .select()
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          inArray(odometerReadings.unitId, ids),
          gte(odometerReadings.readingAt, since),
        ),
      );
    const newest = await this.db
      .selectDistinctOn([odometerReadings.unitId])
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          inArray(odometerReadings.unitId, ids),
          eq(odometerReadings.status, 'ok'),
        ),
      )
      .orderBy(odometerReadings.unitId, desc(odometerReadings.readingAt));
    const readingsByUnit = new Map<string, ReadingRow[]>();
    for (const r of [...recent, ...newest]) {
      const list = readingsByUnit.get(r.unitId) ?? [];
      if (!list.some((x) => x.id === r.id)) list.push(r);
      readingsByUnit.set(r.unitId, list);
    }

    // Group medians of the 30-day average, for the last fallback (§5).
    const avgByUnit = new Map<string, number>();
    for (const truck of fleet) {
      const avg = averageMilesPerDay(this.asRule(readingsByUnit.get(truck.id) ?? []), now, 30);
      if (avg !== null) avgByUnit.set(truck.id, avg);
    }
    const groupMedian = new Map<string, number | null>();
    for (const truck of fleet) {
      const key = truck.groupName ?? '';
      if (groupMedian.has(key)) continue;
      const values = fleet
        .filter((t) => (t.groupName ?? '') === key && avgByUnit.has(t.id))
        .map((t) => avgByUnit.get(t.id) as number);
      groupMedian.set(key, median(values));
    }

    let computed = 0;
    for (const truck of fleet) {
      const unitPlan = unitPlans.get(truck.id) ?? null;
      const groupPlan = truck.groupName ? (groupPlans.get(truck.groupName) ?? null) : null;
      const plan = resolvePlan(
        {
          unitPlan: unitPlan ? this.asCandidate(unitPlan) : null,
          groupPlan: groupPlan ? this.asCandidate(groupPlan) : null,
          groupName: truck.groupName,
        },
        this.settings,
      );
      const status = computePmStatus({
        unit: {
          id: truck.id,
          unitNumber: truck.unitNumber,
          status: truck.status,
          groupName: truck.groupName,
          pmResponsibility: truck.pmResponsibility === 'lessor' ? 'lessor' : 'us',
          lessorName: truck.lessorName,
        },
        serviceCode: 'OIL_CHANGE',
        plan,
        lastService: lastByUnit.get(truck.id) ?? null,
        readings: this.asRule(readingsByUnit.get(truck.id) ?? []),
        groupMedianAvg: groupMedian.get(truck.groupName ?? '') ?? null,
        now,
        timeZone,
        settings: this.settings,
      });
      await this.db
        .insert(pmStatus)
        .values(this.toRow(companyId, status))
        .onConflictDoUpdate({
          target: [pmStatus.companyId, pmStatus.unitId, pmStatus.serviceCode],
          set: this.toRow(companyId, status),
        });
      computed += 1;
    }
    return { computed };
  }

  // ================================================================================ helpers

  private asRule(rows: ReadingRow[]) {
    return rows.map((r) => ({
      id: r.id,
      readingAt: r.readingAt.toISOString(),
      odometerMiles: r.odometerMiles,
      source: r.source as OdometerSource,
      status: r.status as 'ok' | 'conflict' | 'void',
      ageUnknown: r.ageUnknown,
    }));
  }

  private asCandidate(plan: PlanRow) {
    return {
      id: plan.id,
      intervalMiles: plan.intervalMiles,
      intervalDays: plan.intervalDays,
      intervalHours: plan.intervalHours,
      dueSoonMiles: plan.dueSoonMiles,
      dueSoonDays: plan.dueSoonDays,
    };
  }

  async timeZone(companyId: string): Promise<string> {
    const [row] = await this.db
      .select({ timezone: companies.timezone })
      .from(companies)
      .where(eq(companies.id, companyId))
      .limit(1);
    return row?.timezone ?? 'America/Chicago';
  }

  private async truckSummary(companyId: string, unitId: string): Promise<TruckRow> {
    const [row] = await this.db
      .select({
        id: trucks.id,
        unitNumber: trucks.unitNumber,
        status: trucks.status,
        groupName: trucks.groupName,
        pmResponsibility: trucks.pmResponsibility,
        lessorName: trucks.lessorName,
      })
      .from(trucks)
      .where(and(eq(trucks.companyId, companyId), eq(trucks.id, unitId)))
      .limit(1);
    if (!row)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That unit is not in the fleet',
      });
    return row;
  }

  private summaryOf(truck: typeof trucks.$inferSelect): TruckRow {
    return {
      id: truck.id,
      unitNumber: truck.unitNumber,
      status: truck.status,
      groupName: truck.groupName,
      pmResponsibility: truck.pmResponsibility,
      lessorName: truck.lessorName,
    };
  }

  private toRow(companyId: string, s: PmStatus): typeof pmStatus.$inferInsert {
    return {
      id: `pmst_${companyId}_${s.unitId}_${s.serviceCode}`,
      companyId,
      unitId: s.unitId,
      serviceCode: s.serviceCode,
      lastServiceId: s.lastServiceId,
      lastServiceAt: s.lastServiceAt ? new Date(s.lastServiceAt) : null,
      lastServiceOdometer: s.lastServiceOdometer,
      lastServiceSource: s.lastServiceSource,
      intervalMiles: s.intervalMiles,
      intervalDays: s.intervalDays,
      intervalHours: s.intervalHours,
      planOrigin: s.planOrigin,
      planId: s.planId,
      dueSoonMiles: s.dueSoonMiles,
      dueSoonDays: s.dueSoonDays,
      nextServiceOdometer: s.nextServiceOdometer,
      nextServiceDate: s.nextServiceDate,
      milesSinceService: s.milesSinceService,
      milesRemaining: s.milesRemaining,
      daysSinceService: s.daysSinceService,
      daysRemaining: s.daysRemaining,
      avgMilesPerDay: s.avgMilesPerDay === null ? null : String(s.avgMilesPerDay),
      avgBasis: s.avgBasis,
      estimatedDueDate: s.estimatedDueDate,
      dueStatus: s.dueStatus,
      dueBasis: s.dueBasis,
      milesOverAtReading: s.milesOverAtReading,
      readingId: s.readingId,
      readingAt: s.readingAt ? new Date(s.readingAt) : null,
      readingOdometer: s.readingOdometer,
      readingSource: s.readingSource,
      readingAgeHours: s.readingAgeHours === null ? null : String(s.readingAgeHours),
      readingStale: s.readingStale,
      readingAgeUnknown: s.readingAgeUnknown,
      computedAt: new Date(s.computedAt),
    };
  }

  private toStatus(row: typeof pmStatus.$inferSelect, truck: TruckRow): PmStatus {
    return {
      unitId: row.unitId,
      unitNumber: truck.unitNumber,
      unitStatus: truck.status,
      groupName: truck.groupName,
      pmResponsibility: truck.pmResponsibility === 'lessor' ? 'lessor' : 'us',
      lessorName: truck.lessorName,
      serviceCode: row.serviceCode as PmServiceCode,
      lastServiceId: row.lastServiceId,
      lastServiceAt: row.lastServiceAt?.toISOString() ?? null,
      lastServiceOdometer: row.lastServiceOdometer,
      lastServiceSource: row.lastServiceSource as PmStatus['lastServiceSource'],
      intervalMiles: row.intervalMiles,
      intervalDays: row.intervalDays,
      intervalHours: row.intervalHours,
      planOrigin: row.planOrigin as PmStatus['planOrigin'],
      planId: row.planId,
      dueSoonMiles: row.dueSoonMiles,
      dueSoonDays: row.dueSoonDays,
      nextServiceOdometer: row.nextServiceOdometer,
      nextServiceDate: row.nextServiceDate,
      milesSinceService: row.milesSinceService,
      milesRemaining: row.milesRemaining,
      daysSinceService: row.daysSinceService,
      daysRemaining: row.daysRemaining,
      avgMilesPerDay: row.avgMilesPerDay === null ? null : Number(row.avgMilesPerDay),
      avgBasis: row.avgBasis as PmStatus['avgBasis'],
      estimatedDueDate: row.estimatedDueDate,
      dueStatus: row.dueStatus as PmStatus['dueStatus'],
      dueBasis: row.dueBasis as PmStatus['dueBasis'],
      milesOverAtReading: row.milesOverAtReading,
      readingId: row.readingId,
      readingAt: row.readingAt?.toISOString() ?? null,
      readingOdometer: row.readingOdometer,
      readingSource: row.readingSource as PmStatus['readingSource'],
      readingAgeHours: row.readingAgeHours === null ? null : Number(row.readingAgeHours),
      readingStale: row.readingStale,
      readingAgeUnknown: row.readingAgeUnknown,
      computedAt: row.computedAt.toISOString(),
    };
  }

  private toPlan(row: PlanRow, unitNumber: string | null): PmPlan {
    return {
      id: row.id,
      serviceCode: row.serviceCode as PmServiceCode,
      scope: row.scope as PmPlan['scope'],
      groupName: row.groupName,
      unitId: row.unitId,
      unitNumber,
      intervalMiles: row.intervalMiles,
      intervalDays: row.intervalDays,
      intervalHours: row.intervalHours,
      dueSoonMiles: row.dueSoonMiles,
      dueSoonDays: row.dueSoonDays,
      reason: row.reason,
      setBy: row.setBy,
      setByName: row.setByName,
      setAt: row.setAt.toISOString(),
      voidedAt: row.voidedAt?.toISOString() ?? null,
      voidReason: row.voidReason,
      version: row.version,
    };
  }

  private toReading(row: ReadingRow, unitNumber: string): OdometerReading {
    return {
      id: row.id,
      unitId: row.unitId,
      unitNumber,
      readingAt: row.readingAt.toISOString(),
      readingDate: row.readingDate,
      odometerMiles: row.odometerMiles,
      engineHours: row.engineHours === null ? null : Number(row.engineHours),
      source: row.source as OdometerSource,
      status: row.status as OdometerReading['status'],
      conflictReason: row.conflictReason as OdometerReading['conflictReason'],
      conflictWith: row.conflictWith,
      photoId: row.photoId,
      note: row.note,
      ageUnknown: row.ageUnknown,
      createdBy: row.createdBy,
      createdByName: row.createdByName,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
