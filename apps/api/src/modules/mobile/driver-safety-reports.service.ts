import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DRIVER_SAFETY_REPORT_KIND_LABEL,
  safetyRules as R,
  type DriverSafetyReport,
  type DriverSafetyReportCreateInput,
  type DriverSafetyReportKind,
  type DriverSafetyReportList,
  type DriverSafetyTarget,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { isFeatureEnabled } from '../../common/flags/flags';
import { DatabaseService } from '../../database/database.service';
import { driverRelationRequests } from '../../database/schema/driver-relations';
import { driverAppSubmissions } from '../../database/schema/mobile';
import { safetyAccidents, safetyRoadsideInspections } from '../../database/schema/safety';
import { CareIntakeService } from '../driver-relations/care-intake.service';
import { AccidentsV2Service } from '../safety/accidents-v2/accidents-v2.service';
import { ViolationsService } from '../safety/violations.service';
import { DriverContextService, type DriverContext } from './driver-context.service';
import { DriverOwnershipService, isMedia } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

const notFound = () => new AppError({ status: 404, title: 'Not Found', detail: 'No such report.' });

/** Safety's own words for where its record stands - never fault, preventability or results. */
const humanize = (s: string) => s.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** 'YYYY-MM-DDTHH:mm' wall time of an instant in a zone (what Accidents v2 takes). */
function wallTime(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(iso));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/**
 * Accident, roadside inspection and violation reports from the driver (mobile M3, API.md §14).
 *
 * The report opens the real Safety record through the existing services - Accidents v2 when
 * `accidents_v2` is on, Safety's roadside inspections when `safety_v2` is on and the level and the
 * agency are known - and otherwise a Driver Relations compliance request routed to Safety. A report
 * is the driver's account of what happened: it never decides fault, never closes a case and never
 * records a result. `driver_app_submissions` points from the driver to the record it became.
 */
@Injectable()
export class DriverSafetyReportsService {
  private readonly logger = new Logger(DriverSafetyReportsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly accidents: AccidentsV2Service,
    private readonly violations: ViolationsService,
    private readonly intake: CareIntakeService,
    private readonly notifications: MobileNotificationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async create(principal: Principal, input: DriverSafetyReportCreateInput & { fileIds: string[] }, key: string): Promise<DriverSafetyReport> {
    const ctx = await this.context.resolve(principal);
    const units = await this.ownership.units(ctx, { truckId: input.truckId, trailerId: input.trailerId });
    const load = input.loadId ? await this.ownership.ownLoad(ctx, input.loadId) : null;
    await this.ownership.ownFiles(principal, input.fileIds, (t) => isMedia(t) || t === 'application/pdf');
    if (Date.parse(input.occurredAt) > Date.now() + 5 * 60_000) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The time it happened is in the future. Check the time.' });

    const safetyTeam = await this.notifications.teamUserIds(ctx.companyId, ['safety.manage']);
    let target: { type: DriverSafetyTarget; id: string; number: string };
    if (input.kind === 'accident' && isFeatureEnabled('accidents_v2')) {
      target = await this.accident(principal, ctx, input, units, load, key, safetyTeam[0] ?? null);
    } else if (input.kind === 'roadside_inspection' && isFeatureEnabled('safety_v2') && input.inspectionLevel && input.agency?.trim()) {
      const made = await this.violations.createInspection(principal, {
        inspectedAt: new Date(input.occurredAt).toISOString(),
        level: input.inspectionLevel,
        agency: input.agency.trim(),
        reportNumber: input.reportNumber?.trim() || null,
        location: input.location.text || null,
        state: input.location.state ?? null,
        driverId: ctx.driverId,
        truckId: units.truck?.id ?? null,
        trailerId: units.trailer?.id ?? null,
        oos: input.outOfService ?? false,
        oosNote: null,
        returnRequired: false,
        ownerId: safetyTeam[0] ?? null,
        nextAction: 'Review the inspection the driver reported from the app',
      });
      target = { type: 'roadside_inspection', id: made.id, number: made.number };
    } else {
      // No Safety case type for it here: a compliance request to Safety, with everything the driver said.
      const result = await this.intake.submitFromDriver(principal, {
        key: `${ctx.membershipId}:${key}`,
        driver: { id: ctx.driverId, name: ctx.driverName, phone: ctx.driver.phone ?? null, truckId: units.truck?.id ?? null, truckNumber: units.truck?.unitNumber ?? null },
        topic: 'compliance',
        description: [
          `${DRIVER_SAFETY_REPORT_KIND_LABEL[input.kind]} reported from the driver app.`,
          `When: ${input.occurredAt}.`,
          `Where: ${input.location.text || 'not given'}${input.location.state ? ` (${input.location.state})` : ''}.`,
          input.agency ? `Agency: ${input.agency}.` : null,
          input.inspectionLevel ? `Level ${input.inspectionLevel}.` : null,
          input.reportNumber ? `Report / citation #: ${input.reportNumber}.` : null,
          input.outOfService ? 'Put out of service.' : null,
          load ? `Load ${load.loadNumber}.` : null,
          units.trailer ? `Trailer ${units.trailer.unitNumber}.` : null,
          input.description.trim(),
        ]
          .filter(Boolean)
          .join(' '),
        payload: { subject: 'other', subjectLabel: DRIVER_SAFETY_REPORT_KIND_LABEL[input.kind], reportKind: input.kind, occurredAt: input.occurredAt, fileIds: input.fileIds } as never,
        confidential: false,
        team: 'safety',
        referral: null,
        files: [],
      });
      target = { type: 'driver_relation_request', id: result.requestId, number: result.number };
    }

    const [pointer] = await this.db
      .insert(driverAppSubmissions)
      .values({
        id: `das_${crypto.randomUUID()}`,
        companyId: ctx.companyId,
        driverId: ctx.driverId,
        membershipId: ctx.membershipId,
        kind: 'safety_report',
        subkind: input.kind,
        targetType: target.type,
        targetId: target.id,
        targetNumber: target.number,
        detail: { occurredAt: input.occurredAt, description: input.description.trim(), fileIds: input.fileIds, location: input.location, loadId: load?.id ?? null },
        idempotencyKey: key,
      })
      .onConflictDoNothing()
      .returning();
    await this.notifications
      .notifyUsers(ctx.companyId, safetyTeam, {
        title: `${DRIVER_SAFETY_REPORT_KIND_LABEL[input.kind]} reported by ${ctx.driverName}: ${target.number}`,
        body: `${input.location.text || ''}${load ? ` · load ${load.loadNumber}` : ''}`.trim() || null,
        pushTitle: 'Safety report',
        pushBody: `${target.number}: a driver reported ${input.kind === 'accident' ? 'an accident' : 'an inspection or a violation'}.`,
        severity: input.kind === 'accident' ? 'critical' : 'warning',
        target: { type: 'safety_report', id: target.id },
        dedupeKey: `safety_report:${target.id}`,
      })
      .catch((error: unknown) => this.logger.warn(`Notifying Safety about ${target.number} failed: ${String(error)}`));
    const list = await this.mineOf(ctx);
    return list.find((r) => r.id === (pointer?.id ?? '')) ?? list.find((r) => r.reference === target.number)!;
  }

  private async accident(
    principal: Principal,
    ctx: DriverContext,
    input: DriverSafetyReportCreateInput & { fileIds: string[] },
    units: { truck: { id: string } | null; trailer: { id: string } | null },
    load: { id: string } | null,
    key: string,
    ownerId: string | null,
  ): Promise<{ type: 'accident'; id: string; number: string }> {
    const state = input.location.state ?? null;
    const tz = (state ? R.STATE_TZ[state] : undefined) ?? ctx.companyTimezone ?? 'America/New_York';
    const description = input.description.trim();
    // Submitted when the driver gave what Safety's report needs; otherwise a draft Safety finishes.
    const submit = Boolean(state && (input.location.city || input.location.text) && description.length >= 10);
    const made = await this.accidents.report(
      principal,
      {
        submit,
        truckId: units.truck?.id ?? null,
        driverId: ctx.driverId,
        trailerId: units.trailer?.id ?? null,
        loadId: load?.id ?? null,
        assignmentSource: 'Driver app (signed-in driver)',
        occurredAtLocal: wallTime(input.occurredAt, tz),
        occurredTz: tz,
        road: input.location.text || null,
        locationDetail: input.location.lat != null && input.location.lng != null ? `GPS ${input.location.lat.toFixed(5)}, ${input.location.lng.toFixed(5)} (${input.location.source})` : null,
        city: input.location.city ?? null,
        state,
        description,
        injuries: input.injuries ?? 'unknown',
        towAway: input.towAway ?? 'unknown',
        police: input.police ?? 'unknown',
        uploads: input.fileIds.map((fileId) => ({ fileId })),
      },
      `driver_app:${ctx.membershipId}:${key}`,
    );
    if (ownerId) {
      await this.accidents.owner(principal, made.id, { version: made.version, ownerId }).catch((error: unknown) => this.logger.warn(`Accident ${made.number}: owner not set: ${String(error)}`));
    }
    return { type: 'accident', id: made.id, number: made.number };
  }

  async mine(principal: Principal): Promise<DriverSafetyReportList> {
    const ctx = await this.context.resolve(principal);
    return { reports: await this.mineOf(ctx) };
  }

  async mineOne(principal: Principal, id: string): Promise<DriverSafetyReport> {
    const ctx = await this.context.resolve(principal);
    const found = (await this.mineOf(ctx)).find((r) => r.id === id || r.reference === id);
    if (!found) throw notFound();
    return found;
  }

  private async mineOf(ctx: DriverContext): Promise<DriverSafetyReport[]> {
    const pointers = await this.db
      .select()
      .from(driverAppSubmissions)
      .where(and(eq(driverAppSubmissions.companyId, ctx.companyId), eq(driverAppSubmissions.driverId, ctx.driverId), eq(driverAppSubmissions.kind, 'safety_report')))
      .orderBy(desc(driverAppSubmissions.createdAt))
      .limit(100);
    const ids = (type: string) => pointers.filter((p) => p.targetType === type).map((p) => p.targetId);
    const acc = ids('accident').length
      ? await this.db.select({ id: safetyAccidents.id, stage: safetyAccidents.stage, voidedAt: safetyAccidents.voidedAt }).from(safetyAccidents).where(and(eq(safetyAccidents.companyId, ctx.companyId), inArray(safetyAccidents.id, ids('accident'))))
      : [];
    const rsi = ids('roadside_inspection').length
      ? await this.db.select({ id: safetyRoadsideInspections.id, stage: safetyRoadsideInspections.stage }).from(safetyRoadsideInspections).where(and(eq(safetyRoadsideInspections.companyId, ctx.companyId), inArray(safetyRoadsideInspections.id, ids('roadside_inspection'))))
      : [];
    const drr = ids('driver_relation_request').length
      ? await this.db.select({ id: driverRelationRequests.id, status: driverRelationRequests.status }).from(driverRelationRequests).where(and(eq(driverRelationRequests.companyId, ctx.companyId), inArray(driverRelationRequests.id, ids('driver_relation_request'))))
      : [];
    const status = new Map<string, string>([
      ...acc.map((a) => [a.id, a.voidedAt ? 'voided' : a.stage === 'draft' ? 'received' : a.stage] as [string, string]),
      ...rsi.map((r) => [r.id, r.stage] as [string, string]),
      ...drr.map((d) => [d.id, d.status === 'new' ? 'received' : d.status === 'contacted' ? 'in_progress' : d.status] as [string, string]),
    ]);
    return pointers.map((p) => {
      const d = p.detail as { occurredAt?: string; description?: string };
      const s = status.get(p.targetId) ?? 'received';
      return {
        id: p.id,
        kind: p.subkind as DriverSafetyReportKind,
        kindLabel: DRIVER_SAFETY_REPORT_KIND_LABEL[p.subkind as DriverSafetyReportKind] ?? p.subkind ?? '',
        reference: p.targetNumber ?? p.targetId,
        target: p.targetType as DriverSafetyTarget,
        status: s,
        statusLabel: s === 'received' ? 'Received by Safety' : humanize(s),
        occurredAt: d.occurredAt ?? p.createdAt.toISOString(),
        description: d.description ?? '',
        createdAt: p.createdAt.toISOString(),
      };
    });
  }
}
