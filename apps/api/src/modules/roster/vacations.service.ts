import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNull, or } from 'drizzle-orm';
import {
  RETURN_DRUG_TEST_AFTER_DAYS,
  vacationDaysBetween,
  type CancelVacationInput,
  type DriverVacationList,
  type DriverVacationView,
  type RecordVacationReturnInput,
  type StartVacationInput,
  type UpdateVacationInput,
  type DecideVacationRequestInput,
  type VacationRequestList,
  type VacationRequestRow,
  type VacationRequestStatus,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { driverVacations, drivers, trucks, type DriverVacationRow } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';
import { easternToday } from './driver-archive.data';

const forbidden = (detail: string) => new AppError({ status: 403, title: 'Forbidden', detail });
const conflict = (detail: string) => new AppError({ status: 409, title: 'Conflict', detail });
const invalid = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/** Statuses a driver can go on vacation from (the lifecycle's Send on vacation). */
const CAN_LEAVE = ['available', 'off_duty'];

/**
 * A row that is (or was) an actual vacation: entered by the office, or a driver request that has
 * started (0082). A request still requested / approved / rejected / cancelled is not a vacation yet.
 */
const LIVE = or(isNull(driverVacations.requestStatus), eq(driverVacations.requestStatus, 'started'));

/**
 * Driver vacations (owner, 2026-10-17): start, edit dates, record the actual return, cancel a
 * mistake. Each write checks the version, moves the driver's status in the same transaction and
 * writes an audit line. The expected return never ends a vacation; only Record actual return does.
 */
@Injectable()
export class VacationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private canWrite(principal: Principal) {
    if (!principal.permissions.has('drivers.edit') && !principal.permissions.has('dispatch.manage')) {
      throw forbidden('Vacations need drivers.edit or dispatch.manage.');
    }
  }

  private async driver(principal: Principal, driverId: string) {
    const [d] = await this.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), or(eq(drivers.id, driverId), eq(drivers.driverNumber, driverId))))
      .limit(1);
    if (!d) throw new AppError({ status: 404, title: 'Not Found', detail: `No driver ${driverId}` });
    return d;
  }

  private async row(principal: Principal, driverId: string, id: string) {
    const [v] = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, driverId), eq(driverVacations.id, id), LIVE))
      .limit(1);
    // A request that has not started is worked through its own routes (decide, parked), never here.
    if (!v) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such vacation' });
    return v;
  }

  private async views(principal: Principal, rows: DriverVacationRow[], today: string): Promise<DriverVacationView[]> {
    if (rows.length === 0) return [];
    const ids = [...new Set(rows.map((r) => r.driverId))];
    const people = await this.db
      .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName, driverNumber: drivers.driverNumber, dispatcherName: drivers.dispatcherName, phone: drivers.phone })
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), inArray(drivers.id, ids)));
    const units = await this.db
      .select({ driverId: trucks.currentDriverId, unit: trucks.unitNumber })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), inArray(trucks.currentDriverId, ids)));
    const byId = new Map(people.map((p) => [p.id, p]));
    const unitOf = new Map(units.map((u) => [u.driverId, u.unit]));
    return rows.map((v) => {
      const d = byId.get(v.driverId);
      const daysAway = vacationDaysBetween(v.startedOn, v.endedOn ?? today);
      return {
        id: v.id,
        driverId: v.driverId,
        driverName: d ? `${d.firstName} ${d.lastName}`.trim() : v.driverId,
        driverNumber: d?.driverNumber ?? null,
        unitNumber: unitOf.get(v.driverId) ?? null,
        dispatcherName: d?.dispatcherName ?? null,
        phone: d?.phone ?? null,
        state: v.cancelledAt ? 'cancelled' : v.endedOn ? 'returned' : 'away',
        startedOn: v.startedOn,
        expectedReturnOn: v.expectedReturnOn,
        endedOn: v.endedOn,
        daysAway,
        drugTestRequired: !v.cancelledAt && daysAway >= RETURN_DRUG_TEST_AFTER_DAYS,
        note: v.note,
        startedBy: v.startedBy,
        endedBy: v.endedBy,
        cancelledAt: v.cancelledAt?.toISOString() ?? null,
        cancelledBy: v.cancelledBy,
        cancelReason: v.cancelReason,
        version: v.version,
      };
    });
  }

  /** Away now, and back in the last 30 days. */
  async list(principal: Principal): Promise<DriverVacationList> {
    const today = easternToday(new Date());
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - 30 * 86_400_000).toISOString().slice(0, 10);
    const weekEnd = new Date(Date.parse(`${today}T00:00:00Z`) + 7 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), LIVE, isNull(driverVacations.cancelledAt), or(isNull(driverVacations.endedOn), gte(driverVacations.endedOn, since))))
      .orderBy(desc(driverVacations.startedOn));
    const all = await this.views(principal, rows, today);
    const away = all.filter((v) => v.state === 'away').sort((a, b) => b.daysAway - a.daysAway);
    const returned = all.filter((v) => v.state === 'returned').sort((a, b) => (b.endedOn ?? '').localeCompare(a.endedOn ?? ''));
    return {
      today,
      testAfterDays: RETURN_DRUG_TEST_AFTER_DAYS,
      away,
      returned,
      counts: {
        away: away.length,
        returningThisWeek: away.filter((v) => v.expectedReturnOn !== null && v.expectedReturnOn >= today && v.expectedReturnOn <= weekEnd).length,
        away30Plus: away.filter((v) => v.drugTestRequired).length,
      },
    };
  }

  /**
   * For Safety (owner, 2026-10-17): vacations long enough for the company's return test, away now
   * or back in the last 60 days. Cancelled vacations never count.
   */
  async longVacations(principal: Principal, minDays: number): Promise<DriverVacationView[]> {
    const today = easternToday(new Date());
    const since = new Date(Date.parse(`${today}T00:00:00Z`) - 60 * 86_400_000).toISOString().slice(0, 10);
    const rows = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), LIVE, isNull(driverVacations.cancelledAt), or(isNull(driverVacations.endedOn), gte(driverVacations.endedOn, since))))
      .orderBy(desc(driverVacations.startedOn));
    return (await this.views(principal, rows, today)).filter((v) => v.daysAway >= minDays);
  }

  /** One vacation by id, for Safety. */
  async one(principal: Principal, id: string): Promise<DriverVacationView> {
    const [v] = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.id, id)))
      .limit(1);
    if (!v) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such vacation' });
    return (await this.views(principal, [v], easternToday(new Date())))[0]!;
  }

  /** Every vacation of one driver, newest first, cancelled ones included (they are kept). */
  async history(principal: Principal, driverId: string): Promise<DriverVacationView[]> {
    const d = await this.driver(principal, driverId);
    const rows = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, d.id), LIVE))
      .orderBy(desc(driverVacations.startedOn));
    return this.views(principal, rows, easternToday(new Date()));
  }

  /**
   * The Daily board's status word drives the vacation (owner, 2026-10-17): VACATION opens one from
   * that day, and an on-duty word on a later day records the return. The board write itself is
   * the authority (dispatch.edit), so this never refuses it: a driver who cannot go on vacation
   * (on a load, already away, an overlapping vacation) is left as is and the reason is returned.
   */
  async syncFromBoard(principal: Principal, driverId: string, day: string, word: string, onDuty: boolean): Promise<string | null> {
    const today = easternToday(new Date());
    if (day > today) return 'future day';
    const [d] = await this.db.select().from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, driverId))).limit(1);
    if (!d) return 'no driver file';
    const name = `${d.firstName} ${d.lastName}`;
    const now = new Date();
    const by = `${principal.userName ?? principal.userId} (Daily board)`;
    const [open] = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, d.id), LIVE, isNull(driverVacations.endedOn), isNull(driverVacations.cancelledAt)))
      .limit(1);
    if (word === 'VACATION') {
      if (open) return 'already on vacation';
      if (!CAN_LEAVE.includes(d.status)) return `driver is ${d.status}`;
      if (await this.overlapping(principal, d.id, day, null, null)) return 'overlaps a vacation';
      try {
        await this.db.transaction(async (tx) => {
          const adopted = await this.adoptApprovedRequest(tx, principal.companyId, d.id, day, null, by, now);
          if (!adopted) await tx.insert(driverVacations).values({ id: `dvac_${crypto.randomUUID()}`, companyId: principal.companyId, driverId: d.id, startedOn: day, note: 'Marked VACATION on the Daily board', startedBy: by, createdAt: now, updatedAt: now });
          await tx.update(drivers).set({ status: 'vacation', updatedAt: now }).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, d.id)));
        });
      } catch (error) {
        if ((error as { code?: string }).code === '23505') return 'already on vacation';
        throw error;
      }
      await this.audit.write(principal, { action: 'vacation_started', entityType: 'driver', entityId: d.id, entityLabel: name, summary: `On vacation from ${day} (Daily board)`, changes: [{ field: 'status', old: d.status, new: 'vacation' }], at: now });
      return null;
    }
    if (onDuty && open && day > open.startedOn) {
      await this.db.transaction(async (tx) => {
        await tx.update(driverVacations).set({ endedOn: day, endedBy: by, version: open.version + 1, updatedAt: now }).where(and(eq(driverVacations.id, open.id), eq(driverVacations.version, open.version)));
        if (d.status === 'vacation') await tx.update(drivers).set({ status: 'available', updatedAt: now }).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, d.id)));
      });
      await this.audit.write(principal, { action: 'vacation_returned', entityType: 'driver', entityId: d.id, entityLabel: name, summary: `Back from vacation on ${day}: ${word} on the Daily board`, changes: [{ field: 'status', old: d.status, new: 'available' }], at: now });
      return null;
    }
    return 'nothing to change';
  }

  /** A live (not cancelled) vacation of this driver whose days meet [from, to]; `to` null = still open. */
  private async overlapping(principal: Principal, driverId: string, from: string, to: string | null, exceptId: string | null) {
    const rows = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, driverId), LIVE, isNull(driverVacations.cancelledAt)));
    // The return day is a day back at work, so a new vacation may start on it.
    return rows.find((v) => v.id !== exceptId && (v.endedOn === null || v.endedOn > from) && (to === null || v.startedOn <= to)) ?? null;
  }

  async start(principal: Principal, driverId: string, input: StartVacationInput): Promise<DriverVacationView> {
    this.canWrite(principal);
    const d = await this.driver(principal, driverId);
    const today = easternToday(new Date());
    if (input.startedOn > today) throw invalid('A vacation starts today or earlier; a future start is not supported.');
    if (input.expectedReturnOn && input.expectedReturnOn < input.startedOn) throw invalid('The expected return cannot be before the start.');
    if (d.status === 'vacation') throw conflict(`${d.firstName} ${d.lastName} is already on vacation.`);
    if (!CAN_LEAVE.includes(d.status)) throw conflict(`A driver who is ${d.status.replace(/_/g, ' ')} cannot be sent on vacation; only available or off duty.`);
    const clash = await this.overlapping(principal, d.id, input.startedOn, null, null);
    if (clash) throw conflict(`This overlaps the vacation from ${clash.startedOn}${clash.endedOn ? ` to ${clash.endedOn}` : ''}; correct or cancel that one first.`);
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    let id = `dvac_${crypto.randomUUID()}`;
    try {
      await this.db.transaction(async (tx) => {
        // A request the driver sent from the app and the office approved becomes this vacation (0082).
        const adopted = await this.adoptApprovedRequest(tx, principal.companyId, d.id, input.startedOn, input.expectedReturnOn ?? null, by, now, input.note ?? null);
        if (adopted) id = adopted;
        else await tx.insert(driverVacations).values({ id, companyId: principal.companyId, driverId: d.id, startedOn: input.startedOn, expectedReturnOn: input.expectedReturnOn ?? null, note: input.note ?? null, startedBy: by, createdAt: now, updatedAt: now });
        await tx.update(drivers).set({ status: 'vacation', updatedAt: now }).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, d.id)));
      });
    } catch (error) {
      if ((error as { code?: string }).code === '23505') throw conflict('This driver already has an open vacation.');
      throw error;
    }
    await this.audit.write(principal, {
      action: 'vacation_started',
      entityType: 'driver',
      entityId: d.id,
      entityLabel: `${d.firstName} ${d.lastName}`,
      summary: `On vacation from ${input.startedOn}${input.expectedReturnOn ? `, expected back ${input.expectedReturnOn}` : ''}`,
      changes: [{ field: 'status', old: d.status, new: 'vacation' }],
      at: now,
    });
    return (await this.views(principal, [await this.row(principal, d.id, id)], today))[0]!;
  }

  async update(principal: Principal, driverId: string, id: string, input: UpdateVacationInput): Promise<DriverVacationView> {
    this.canWrite(principal);
    const d = await this.driver(principal, driverId);
    const v = await this.row(principal, d.id, id);
    if (v.cancelledAt) throw conflict('This vacation was cancelled.');
    const startedOn = input.startedOn ?? v.startedOn;
    const expected = input.expectedReturnOn === undefined ? v.expectedReturnOn : input.expectedReturnOn;
    const today = easternToday(new Date());
    if (startedOn > today) throw invalid('A vacation starts today or earlier.');
    if (expected && expected < startedOn) throw invalid('The expected return cannot be before the start.');
    if (v.endedOn && startedOn > v.endedOn) throw invalid('The start cannot be after the actual return.');
    const clash = await this.overlapping(principal, d.id, startedOn, v.endedOn, v.id);
    if (clash) throw conflict(`This overlaps the vacation from ${clash.startedOn}${clash.endedOn ? ` to ${clash.endedOn}` : ''}.`);
    const now = new Date();
    const [saved] = await this.db
      .update(driverVacations)
      .set({ startedOn, expectedReturnOn: expected, note: input.note === undefined ? v.note : input.note || null, version: v.version + 1, updatedAt: now })
      .where(and(eq(driverVacations.id, v.id), eq(driverVacations.version, input.version)))
      .returning();
    if (!saved) throw conflict('This vacation was changed by someone else. Reload and try again.');
    await this.audit.write(principal, {
      action: 'vacation_updated',
      entityType: 'driver',
      entityId: d.id,
      entityLabel: `${d.firstName} ${d.lastName}`,
      summary: 'Vacation dates changed',
      changes: [
        { field: 'started_on', old: v.startedOn, new: startedOn },
        { field: 'expected_return_on', old: v.expectedReturnOn, new: expected },
      ],
      at: now,
    });
    return (await this.views(principal, [saved], today))[0]!;
  }

  /** Ends the vacation on the actual return date; the driver is available again. No Safety clearance is implied. */
  async recordReturn(principal: Principal, driverId: string, id: string, input: RecordVacationReturnInput): Promise<DriverVacationView> {
    this.canWrite(principal);
    const d = await this.driver(principal, driverId);
    const v = await this.row(principal, d.id, id);
    if (v.cancelledAt) throw conflict('This vacation was cancelled.');
    if (v.endedOn) throw conflict(`The return was already recorded on ${v.endedOn}.`);
    const today = easternToday(new Date());
    if (input.returnedOn > today) throw invalid('The actual return cannot be in the future.');
    if (input.returnedOn < v.startedOn) throw invalid('The actual return cannot be before the start.');
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const saved = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(driverVacations)
        .set({ endedOn: input.returnedOn, endedBy: by, version: v.version + 1, updatedAt: now })
        .where(and(eq(driverVacations.id, v.id), eq(driverVacations.version, input.version), isNull(driverVacations.endedOn)))
        .returning();
      if (!row) return null;
      if (d.status === 'vacation') await tx.update(drivers).set({ status: 'available', updatedAt: now }).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, d.id)));
      return row;
    });
    if (!saved) throw conflict('This vacation was changed by someone else. Reload and try again.');
    const view = (await this.views(principal, [saved], today))[0]!;
    await this.audit.write(principal, {
      action: 'vacation_returned',
      entityType: 'driver',
      entityId: d.id,
      entityLabel: `${d.firstName} ${d.lastName}`,
      summary: `Back from vacation on ${input.returnedOn} after ${view.daysAway} days${view.drugTestRequired ? ' · vacation-return drug test due (company policy)' : ''}`,
      changes: [{ field: 'status', old: d.status, new: d.status === 'vacation' ? 'available' : d.status }],
      at: now,
    });
    return view;
  }

  /** A vacation entered by mistake: kept, marked cancelled with the reason; the driver is available again. */
  async cancel(principal: Principal, driverId: string, id: string, input: CancelVacationInput): Promise<DriverVacationView> {
    this.canWrite(principal);
    const d = await this.driver(principal, driverId);
    const v = await this.row(principal, d.id, id);
    if (v.cancelledAt) throw conflict('This vacation is already cancelled.');
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const saved = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(driverVacations)
        .set({ cancelledAt: now, cancelledBy: by, cancelReason: input.reason, version: v.version + 1, updatedAt: now })
        .where(and(eq(driverVacations.id, v.id), eq(driverVacations.version, input.version)))
        .returning();
      if (!row) return null;
      if (!v.endedOn && d.status === 'vacation') await tx.update(drivers).set({ status: 'available', updatedAt: now }).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, d.id)));
      return row;
    });
    if (!saved) throw conflict('This vacation was changed by someone else. Reload and try again.');
    await this.audit.write(principal, {
      action: 'vacation_cancelled',
      entityType: 'driver',
      entityId: d.id,
      entityLabel: `${d.firstName} ${d.lastName}`,
      summary: `Vacation from ${v.startedOn} cancelled: ${input.reason}`,
      changes: [{ field: 'cancelled', old: null, new: input.reason }],
      at: now,
    });
    return (await this.views(principal, [saved], easternToday(now)))[0]!;
  }
  // ===================================================================== requests (mobile M3, 0082)

  /**
   * Called after a request event is written: the driver asked, the office decided, the truck was
   * confirmed parked. The mobile module registers here to tell the driver and the teams. A
   * listener's failure never fails the write.
   */
  readonly afterRequestEvent: Array<(principal: Principal, event: { kind: 'requested' | 'approved' | 'rejected' | 'parked' | 'cancelled' | 'started'; row: DriverVacationRow; by: 'driver' | 'office' }) => Promise<void>> = [];

  private async announce(principal: Principal, kind: 'requested' | 'approved' | 'rejected' | 'parked' | 'cancelled' | 'started', row: DriverVacationRow, by: 'driver' | 'office') {
    for (const listener of this.afterRequestEvent) {
      try {
        await listener(principal, { kind, row, by });
      } catch {
        // The listener records its own failure.
      }
    }
  }

  /**
   * The existing Start vacation path (the form, the Daily board) adopting the driver's approved
   * request: the request row becomes the vacation, started on the day given. Approval alone never
   * started anything - this is the one place a request turns into a vacation.
   */
  private async adoptApprovedRequest(
    tx: Pick<typeof this.database.db, 'select' | 'update'>,
    companyId: string,
    driverId: string,
    startedOn: string,
    expectedReturnOn: string | null,
    by: string,
    now: Date,
    note: string | null = null,
  ): Promise<string | null> {
    const [req] = await tx
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, companyId), eq(driverVacations.driverId, driverId), eq(driverVacations.requestStatus, 'approved'), isNull(driverVacations.cancelledAt)))
      .orderBy(asc(driverVacations.startedOn))
      .limit(1);
    if (!req) return null;
    const expected = expectedReturnOn ?? (req.requestedEndOn ? dayAfter(req.requestedEndOn) : null);
    await tx
      .update(driverVacations)
      .set({ requestStatus: 'started', startedOn, expectedReturnOn: expected, startedBy: by, note: note ?? req.note, version: req.version + 1, updatedAt: now })
      .where(and(eq(driverVacations.id, req.id), eq(driverVacations.version, req.version)));
    return req.id;
  }

  /** A request from the driver app: requested, nothing else changes (the driver stays as they are). */
  async requestFromDriver(principal: Principal, driverId: string, input: { from: string; to: string; note: string | null }, by: string): Promise<DriverVacationRow> {
    const today = easternToday(new Date());
    if (input.from < today) throw invalid('A vacation request starts today or later.');
    if (input.to < input.from) throw invalid('The last day cannot be before the first.');
    const open = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, driverId), isNull(driverVacations.cancelledAt), or(eq(driverVacations.requestStatus, 'requested'), eq(driverVacations.requestStatus, 'approved'))));
    const clash = open.find((r) => r.startedOn <= input.to && (r.requestedEndOn ?? r.startedOn) >= input.from);
    if (clash) throw conflict(`You already asked for ${clash.startedOn} to ${clash.requestedEndOn ?? clash.startedOn} (${clash.requestStatus}).`);
    const now = new Date();
    const [row] = await this.db
      .insert(driverVacations)
      .values({
        id: `dvac_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        driverId,
        startedOn: input.from,
        requestedEndOn: input.to,
        note: input.note,
        startedBy: '',
        requestStatus: 'requested',
        requestedAt: now,
        requestedByDriver: true,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await this.audit.write(principal, {
      action: 'vacation_requested',
      entityType: 'driver',
      entityId: driverId,
      entityLabel: by,
      summary: `Vacation requested from the driver app: ${input.from} to ${input.to}`,
      changes: [{ field: 'vacation_request', old: null, new: 'requested' }],
      at: now,
    });
    await this.announce(principal, 'requested', row!, 'driver');
    return row!;
  }

  /** The driver's own requests (and what they became), newest first. */
  async driverRequests(principal: Principal, driverId: string): Promise<DriverVacationRow[]> {
    return this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.driverId, driverId), eq(driverVacations.requestedByDriver, true)))
      .orderBy(desc(driverVacations.requestedAt))
      .limit(50);
  }

  async requestRow(principal: Principal, id: string): Promise<DriverVacationRow> {
    const [v] = await this.db
      .select()
      .from(driverVacations)
      .where(and(eq(driverVacations.companyId, principal.companyId), eq(driverVacations.id, id), eq(driverVacations.requestedByDriver, true)))
      .limit(1);
    if (!v) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such vacation request' });
    return v;
  }

  /** Requests waiting for a decision or a start, and those decided in the last 30 days. */
  async requests(principal: Principal): Promise<VacationRequestList> {
    const since = new Date(Date.now() - 30 * 86_400_000);
    const rows = await this.db
      .select()
      .from(driverVacations)
      .where(
        and(
          eq(driverVacations.companyId, principal.companyId),
          eq(driverVacations.requestedByDriver, true),
          or(eq(driverVacations.requestStatus, 'requested'), eq(driverVacations.requestStatus, 'approved'), gte(driverVacations.updatedAt, since)),
        ),
      )
      .orderBy(desc(driverVacations.requestedAt));
    const views = await this.views(principal, rows, easternToday(new Date()));
    const byId = new Map(views.map((v) => [v.id, v]));
    const requests: VacationRequestRow[] = rows.map((r) => {
      const v = byId.get(r.id)!;
      return {
        id: r.id,
        driverId: r.driverId,
        driverName: v.driverName,
        driverNumber: v.driverNumber,
        unitNumber: v.unitNumber,
        dispatcherName: v.dispatcherName,
        from: r.startedOn,
        to: r.requestedEndOn ?? r.startedOn,
        note: r.note,
        status: (r.cancelledAt && r.requestStatus === 'requested' ? 'cancelled' : r.requestStatus) as VacationRequestStatus,
        requestedAt: r.requestedAt?.toISOString() ?? null,
        decidedBy: r.decidedBy,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decidedReason: r.decidedReason,
        truckParkedAt: r.truckParkedAt?.toISOString() ?? null,
        truckParkedBy: r.truckParkedBy,
        truckParkedNote: r.truckParkedNote,
        truckParkedPhotoFileId: r.truckParkedFileId,
        keysHandedAt: r.keysHandedAt?.toISOString() ?? null,
        version: r.version,
      };
    });
    return { requests, counts: { requested: requests.filter((r) => r.status === 'requested').length, approved: requests.filter((r) => r.status === 'approved').length } };
  }

  /** Approve or reject (with a reason the driver reads). Approval starts nothing and parks nothing. */
  async decide(principal: Principal, id: string, input: DecideVacationRequestInput): Promise<DriverVacationRow> {
    this.canWrite(principal);
    const v = await this.requestRow(principal, id);
    if (v.requestStatus !== 'requested' || v.cancelledAt) throw conflict(`This request is already ${v.cancelledAt ? 'cancelled' : v.requestStatus}.`);
    const to = input.decision === 'approve' ? 'approved' : 'rejected';
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const [saved] = await this.db
      .update(driverVacations)
      .set({ requestStatus: to, decidedBy: by, decidedAt: now, decidedReason: input.reason?.trim() || null, version: v.version + 1, updatedAt: now })
      .where(and(eq(driverVacations.id, v.id), eq(driverVacations.companyId, principal.companyId), eq(driverVacations.version, input.version)))
      .returning();
    if (!saved) throw conflict('This request was changed by someone else. Reload and try again.');
    await this.audit.write(principal, {
      action: to === 'approved' ? 'vacation_request_approved' : 'vacation_request_rejected',
      entityType: 'driver',
      entityId: v.driverId,
      entityLabel: v.driverId,
      summary: `Vacation request ${v.startedOn} to ${v.requestedEndOn ?? v.startedOn} ${to}${input.reason ? `: ${input.reason}` : ''}`,
      changes: [{ field: 'vacation_request', old: 'requested', new: to }],
      at: now,
    });
    await this.announce(principal, to, saved, 'office');
    return saved;
  }

  /**
   * The truck was left parked (and, when said, the keys handed over): confirmed by the driver in
   * the app or by the office. Only after approval; it never starts the vacation by itself.
   */
  async confirmParked(
    principal: Principal,
    id: string,
    input: { version?: number; note?: string | null; keysHandedOver?: boolean; photoFileId?: string | null },
    by: { kind: 'driver' | 'office'; name: string; driverId?: string },
  ): Promise<DriverVacationRow> {
    if (by.kind === 'office') this.canWrite(principal);
    const v = await this.requestRow(principal, id);
    if (by.kind === 'driver' && v.driverId !== by.driverId) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such vacation request' });
    if (v.cancelledAt || (v.requestStatus !== 'approved' && v.requestStatus !== 'started')) throw conflict('The truck is confirmed parked after the request is approved.');
    if (input.version !== undefined && input.version !== v.version) throw conflict('This request was changed by someone else. Reload and try again.');
    const now = new Date();
    const [saved] = await this.db
      .update(driverVacations)
      .set({
        truckParkedAt: v.truckParkedAt ?? now,
        truckParkedBy: v.truckParkedBy ?? by.name,
        truckParkedNote: input.note?.trim() || v.truckParkedNote,
        truckParkedFileId: input.photoFileId ?? v.truckParkedFileId,
        truckParkedSource: v.truckParkedSource ?? by.kind,
        ...(input.keysHandedOver && !v.keysHandedAt ? { keysHandedAt: now, keysHandedBy: by.name } : {}),
        version: v.version + 1,
        updatedAt: now,
      })
      .where(and(eq(driverVacations.id, v.id), eq(driverVacations.companyId, principal.companyId), eq(driverVacations.version, v.version)))
      .returning();
    if (!saved) throw conflict('This request was changed by someone else. Reload and try again.');
    await this.audit.write(principal, {
      action: 'vacation_truck_parked',
      entityType: 'driver',
      entityId: v.driverId,
      entityLabel: v.driverId,
      summary: `Truck confirmed parked by ${by.name} (${by.kind})${input.keysHandedOver ? '; keys handed over' : ''}${input.note ? `: ${input.note}` : ''}`,
      changes: [
        { field: 'truck_parked_at', old: v.truckParkedAt?.toISOString() ?? null, new: saved.truckParkedAt?.toISOString() ?? null },
        { field: 'keys_handed_at', old: v.keysHandedAt?.toISOString() ?? null, new: saved.keysHandedAt?.toISOString() ?? null },
      ],
      at: now,
    });
    await this.announce(principal, 'parked', saved, by.kind);
    return saved;
  }

  /** The driver takes back a request nobody has decided yet. */
  async cancelRequestByDriver(principal: Principal, id: string, driverId: string, by: string): Promise<DriverVacationRow> {
    const v = await this.requestRow(principal, id);
    if (v.driverId !== driverId) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such vacation request' });
    if (v.requestStatus !== 'requested' || v.cancelledAt) throw conflict(`Only a request still waiting can be cancelled here; this one is ${v.cancelledAt ? 'cancelled' : v.requestStatus}. Call Dispatch.`);
    const now = new Date();
    const [saved] = await this.db
      .update(driverVacations)
      .set({ requestStatus: 'cancelled', cancelledAt: now, cancelledBy: by, cancelReason: 'Cancelled by the driver in the app', version: v.version + 1, updatedAt: now })
      .where(and(eq(driverVacations.id, v.id), eq(driverVacations.version, v.version)))
      .returning();
    if (!saved) throw conflict('This request was changed. Reload and try again.');
    await this.audit.write(principal, { action: 'vacation_request_cancelled', entityType: 'driver', entityId: driverId, entityLabel: by, summary: `Vacation request ${v.startedOn} cancelled by the driver`, changes: [{ field: 'vacation_request', old: 'requested', new: 'cancelled' }], at: now });
    await this.announce(principal, 'cancelled', saved, 'driver');
    return saved;
  }
}

function dayAfter(day: string): string {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
