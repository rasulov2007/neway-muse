import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  DRIVER_VACATION_STEP_LABEL,
  RETURN_DRUG_TEST_AFTER_DAYS,
  VACATION_REQUEST_STATUS_LABEL,
  vacationDaysBetween,
  type DriverTruckParkedInput,
  type DriverVacationRequestInput,
  type DriverVacationRequestList,
  type DriverVacationRequestView,
  type DriverVacationStep,
  type VacationRequestStatus,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import type { DriverVacationRow } from '../../database/schema/roster';
import { safetyReviews } from '../../database/schema/safety';
import { VacationsService } from '../roster/vacations.service';
import { DriverContextService } from './driver-context.service';
import { DriverOwnershipService, isImage } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

/** Safety's review words, as the driver may read them: a state, never a result. */
const REVIEW_LABEL: Record<string, string> = {
  not_started: 'Safety review to do',
  in_progress: 'Safety is reviewing',
  waiting: 'Safety is waiting on a step',
  completed: 'Safety review done',
  closed: 'Safety review done',
};

/**
 * Vacation requests in the driver app (mobile M3, API.md §12). The request lives on
 * `driver_vacations` through VacationsService; the start, the return and Safety's vacation-return
 * review stay the existing paths, read here only to show the driver where it stands.
 */
@Injectable()
export class DriverVacationsService {
  private readonly logger = new Logger(DriverVacationsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly vacations: VacationsService,
    private readonly notifications: MobileNotificationsService,
  ) {}

  async request(principal: Principal, input: DriverVacationRequestInput): Promise<DriverVacationRequestView> {
    const ctx = await this.context.resolve(principal);
    const row = await this.vacations.requestFromDriver(principal, ctx.driverId, { from: input.from, to: input.to, note: input.note?.trim() || null }, ctx.driverName);
    return (await this.views([row]))[0]!;
  }

  async mine(principal: Principal): Promise<DriverVacationRequestList> {
    const ctx = await this.context.resolve(principal);
    return { vacations: await this.views(await this.vacations.driverRequests(principal, ctx.driverId)) };
  }

  async parked(principal: Principal, id: string, input: DriverTruckParkedInput): Promise<DriverVacationRequestView> {
    const ctx = await this.context.resolve(principal);
    if (input.photoFileId) await this.ownership.ownFiles(principal, [input.photoFileId], isImage);
    const row = await this.vacations.confirmParked(principal, id, { note: input.note ?? null, keysHandedOver: input.keysHandedOver, photoFileId: input.photoFileId ?? null }, { kind: 'driver', name: `${ctx.driverName} (driver app)`, driverId: ctx.driverId });
    return (await this.views([row]))[0]!;
  }

  async cancel(principal: Principal, id: string): Promise<DriverVacationRequestView> {
    const ctx = await this.context.resolve(principal);
    const row = await this.vacations.cancelRequestByDriver(principal, id, ctx.driverId, `${ctx.driverName} (driver app)`);
    return (await this.views([row]))[0]!;
  }

  private async views(rows: DriverVacationRow[]): Promise<DriverVacationRequestView[]> {
    if (rows.length === 0) return [];
    const reviews = await this.database.db
      .select({ linkedId: safetyReviews.linkedId, status: safetyReviews.status, createdAt: safetyReviews.createdAt })
      .from(safetyReviews)
      .where(and(eq(safetyReviews.companyId, rows[0]!.companyId), eq(safetyReviews.kind, 'vacation_return'), eq(safetyReviews.linkedType, 'vacation'), inArray(safetyReviews.linkedId, rows.map((r) => r.id)), isNull(safetyReviews.voidedAt)));
    const reviewOf = new Map(reviews.map((r) => [r.linkedId, r]));
    return rows.map((r) => {
      const status = (r.cancelledAt && r.requestStatus !== 'started' ? 'cancelled' : r.requestStatus) as VacationRequestStatus;
      const review = reviewOf.get(r.id);
      const started = r.requestStatus === 'started';
      const steps: DriverVacationRequestView['steps'] = [];
      const step = (s: DriverVacationStep, at: Date | string | null | undefined, by: string | null = null, note: string | null = null, label?: string) =>
        steps.push({ step: s, label: label ?? DRIVER_VACATION_STEP_LABEL[s], at: at ? (typeof at === 'string' ? at : at.toISOString()) : null, by, note });
      step('requested', r.requestedAt, null, r.note);
      step('decided', r.decidedAt, r.decidedBy, r.decidedReason, r.requestStatus === 'rejected' ? 'Rejected' : DRIVER_VACATION_STEP_LABEL.decided);
      if (r.requestStatus !== 'rejected' && status !== 'cancelled') {
        step('truck_parked', r.truckParkedAt, r.truckParkedBy, r.truckParkedNote);
        step('keys_handed', r.keysHandedAt, r.keysHandedBy);
        step('started', started ? r.startedOn : null, started ? r.startedBy : null);
        step('returned', r.endedOn, r.endedBy);
        const long = started && vacationDaysBetween(r.startedOn, r.endedOn ?? r.startedOn) >= RETURN_DRUG_TEST_AFTER_DAYS;
        if (review || long) step('return_review', review?.createdAt ?? null, null, null, review ? (REVIEW_LABEL[review.status] ?? 'Safety return review') : DRIVER_VACATION_STEP_LABEL.return_review);
      }
      return {
        id: r.id,
        from: r.startedOn,
        to: r.requestedEndOn ?? r.startedOn,
        note: r.note,
        status,
        statusLabel: r.endedOn ? 'Back from vacation' : VACATION_REQUEST_STATUS_LABEL[status],
        decidedReason: r.decidedReason,
        steps,
        truckParked: r.truckParkedAt ? { at: r.truckParkedAt.toISOString(), by: r.truckParkedBy, note: r.truckParkedNote, photoFileId: r.truckParkedFileId } : null,
        keysHandedAt: r.keysHandedAt?.toISOString() ?? null,
        returnReview: review ? { state: review.status, label: REVIEW_LABEL[review.status] ?? review.status.replace(/_/g, ' ') } : null,
        canCancel: status === 'requested',
        canConfirmParked: (status === 'approved' || status === 'started') && !r.truckParkedAt,
        version: r.version,
        createdAt: (r.requestedAt ?? r.createdAt).toISOString(),
      };
    });
  }

  /** Hook on VacationsService.afterRequestEvent: Dispatch hears of a request, the driver of a decision. */
  async onEvent(_principal: Principal, event: { kind: string; row: DriverVacationRow; by: 'driver' | 'office' }): Promise<void> {
    const { row } = event;
    const range = `${row.startedOn} to ${row.requestedEndOn ?? row.startedOn}`;
    try {
      if (event.kind === 'requested' || (event.kind === 'parked' && event.by === 'driver') || (event.kind === 'cancelled' && event.by === 'driver')) {
        const users = await this.notifications.teamUserIds(row.companyId, ['dispatch.manage']);
        const verb = event.kind === 'requested' ? 'asks for a vacation' : event.kind === 'parked' ? 'confirmed the truck is parked' : 'cancelled a vacation request';
        await this.notifications.notifyUsers(row.companyId, users, {
          title: `Vacation: driver ${verb} (${range})`,
          body: row.note ?? null,
          pushTitle: 'Vacation request',
          pushBody: `A driver ${verb}.`,
          target: { type: 'vacation', id: row.id },
          dedupeKey: `vacation:${row.id}:${event.kind}:v${row.version}`,
        });
        return;
      }
      if (event.kind === 'approved' || event.kind === 'rejected' || (event.kind === 'parked' && event.by === 'office')) {
        const words = event.kind === 'approved' ? 'approved' : event.kind === 'rejected' ? 'rejected' : 'truck parked confirmed';
        await this.notifications.notifyDriver(row.companyId, row.driverId, {
          title: `Vacation ${range}: ${words}${event.kind === 'rejected' && row.decidedReason ? ` — ${row.decidedReason}` : ''}`,
          body: event.kind === 'approved' ? 'Park the truck and confirm it in the app before you leave.' : null,
          pushTitle: 'Vacation request',
          pushBody: `Your vacation request was ${event.kind === 'parked' ? 'updated' : words}.`,
          severity: event.kind === 'rejected' ? 'warning' : 'info',
          target: { type: 'vacation', id: row.id },
          dedupeKey: `vacation:${row.id}:${event.kind}:v${row.version}`,
        });
        // A vacation long enough for the company's return test: Safety hears of it when it is approved.
        if (event.kind === 'approved' && vacationDaysBetween(row.startedOn, row.requestedEndOn ?? row.startedOn) + 1 >= RETURN_DRUG_TEST_AFTER_DAYS) {
          const safety = await this.notifications.teamUserIds(row.companyId, ['safety.manage']);
          await this.notifications.notifyUsers(row.companyId, safety, {
            title: `Long vacation approved (${range}): a vacation-return test will be due`,
            body: null,
            pushTitle: 'Vacation approved',
            pushBody: 'A long vacation was approved.',
            target: { type: 'vacation', id: row.id },
            dedupeKey: `vacation:${row.id}:safety`,
          });
        }
      }
    } catch (error) {
      this.logger.warn(`Vacation ${row.id}: notifying failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
