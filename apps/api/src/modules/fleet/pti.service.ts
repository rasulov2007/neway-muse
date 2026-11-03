import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  canTransition,
  CLOSED_DEFECT_STATES,
  componentKeyFromName,
  DEFAULT_PTI_COMPONENT_KEYS,
  defectDueAt,
  describeDescriptionProblem,
  ptiDueDateOf,
  ptiWeekStartOf,
  ptiIssuesByUnit,
  queuesFor,
  UNFIXED_DEFECT_STATES,
  receiptStatusFor,
  describeScreenshotProblem,
  screenshotRequired,
  unitServiceStatus,
  type CreateDefectInput,
  type DefectEvidence,
  type DefectResolution,
  type DispatchOverrideInput,
  type DispatchOverrideResult,
  type PtiBoard,
  type PtiBoardRow,
  type PtiDefect,
  type PtiDefectSeverity,
  type PtiDefectState,
  type PtiInspection,
  type PtiUnitIssues,
  type PtiUnitHistoryEntry,
  type ReceiptInput,
  type ReviewInput,
  type TelegramSource,
  type TransitionDefectInput,
  type UpdateDefectInput,
  type DriverPtiSubmission,
  type DriverPtiSubmitInput,
  type PtiCorrection,
  type RequestPtiCorrectionInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { storedFiles } from '../../database/schema/files';
import { ptiDefectHistory, ptiDefects, ptiInspections } from '../../database/schema/pti';
import { drivers, trucks } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';
import { StateService } from '../state/state.service';

type InspectionRow = typeof ptiInspections.$inferSelect;

/** `pti_inspections.source` when the walk-around came from the driver app (0081). */
interface DriverAppSource {
  kind: 'driver_app';
  current: DriverPtiSubmission;
  history: DriverPtiSubmission[];
  corrections: PtiCorrection[];
}

function driverSourceOf(source: unknown): DriverAppSource | null {
  return source && typeof source === 'object' && (source as { kind?: string }).kind === 'driver_app' ? (source as DriverAppSource) : null;
}

/** Who sent the walk-around from the app, and on what (resolved on the server from the assignment). */
export interface DriverPtiContext {
  driverId: string;
  driverName: string;
  truckId: string;
  truckUnit: string;
  trailerId: string | null;
  trailerUnit: string | null;
}

export type PtiDriverEvent = { kind: 'reviewed' | 'correction_requested'; inspection: PtiInspection };
type DefectRow = typeof ptiDefects.$inferSelect;
/** The handle a transaction callback receives; the same API as the connection. */
type Tx = Parameters<Parameters<DatabaseService['db']['transaction']>[0]>[0];

/** Truck statuses that take a unit off the weekly cycle, and the ones that mean "in a shop". */
// Archived trucks (owner, 2026-10-05) owe no PTI and leave the board.
const NOT_ELIGIBLE = new Set(['inactive', 'sold', 'out_of_service', 'archived']);
const IN_SHOP = new Set(['in_shop', 'maintenance']);

/**
 * The weekly walk-around.
 *
 * Every rule the specification calls the point of the rebuild lives here, on the server, where a
 * curl cannot walk around it: a clean review changes no defect (§4.3); closure is proposed by a
 * reviewer or a shop and confirmed by a person (§4.4); the unit's service status is derived from
 * its open defects and never typed (§4.2); a description has to be one (WP7); a serious defect
 * has to carry a screenshot (§3.3). Every write checks the caller's version and writes an audit
 * entry, and a defect's history is append-only.
 */
@Injectable()
export class PtiService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly state: StateService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Told after a review or a correction request on a walk-around the driver sent from the app
   * (0081): the mobile module notifies the driver. A listener's failure never fails the write.
   */
  readonly afterDriverEvent: Array<(principal: Principal, event: PtiDriverEvent) => Promise<void>> = [];

  private async tellDriver(principal: Principal, event: PtiDriverEvent): Promise<void> {
    if (!event.inspection.driverSubmission) return;
    for (const listener of this.afterDriverEvent) {
      try {
        await listener(principal, event);
      } catch {
        // The listener records its own failure.
      }
    }
  }

  // ==================================================================================== week

  /**
   * Opens a week: one inspection per eligible truck, idempotent.
   *
   * A truck with no row would be a truck nobody noticed, so the row exists before the video does.
   * Rows already there keep everything they hold; unreviewed ones re-read the driver and the
   * dispatcher, because the driver on a unit changes mid-week and the row follows the truck.
   */
  async openWeek(principal: Principal, weekStart: string, today: string): Promise<void> {
    const fleet = await this.db
      .select({
        id: trucks.id,
        unitNumber: trucks.unitNumber,
        status: trucks.status,
        currentDriverId: trucks.currentDriverId,
      })
      .from(trucks)
      .where(eq(trucks.companyId, principal.companyId));
    const eligible = fleet.filter((t) => !NOT_ELIGIBLE.has(t.status));

    const driverIds = eligible.flatMap((t) => (t.currentDriverId ? [t.currentDriverId] : []));
    const driverRows =
      driverIds.length === 0
        ? []
        : await this.db
            .select({
              id: drivers.id,
              firstName: drivers.firstName,
              lastName: drivers.lastName,
              driverType: drivers.driverType,
              dispatcherId: drivers.dispatcherId,
              dispatcherName: drivers.dispatcherName,
            })
            .from(drivers)
            .where(and(eq(drivers.companyId, principal.companyId), inArray(drivers.id, driverIds)));
    const driversById = new Map(driverRows.map((d) => [d.id, d]));

    const existing = await this.db
      .select({
        id: ptiInspections.id,
        unitId: ptiInspections.unitId,
        reviewState: ptiInspections.reviewState,
      })
      .from(ptiInspections)
      .where(
        and(
          eq(ptiInspections.companyId, principal.companyId),
          eq(ptiInspections.weekStart, weekStart),
        ),
      );
    const byUnit = new Map(existing.map((row) => [row.unitId, row]));

    const dueAt = ptiDueDateOf(weekStart);
    const now = new Date();
    for (const truck of eligible) {
      const driver = truck.currentDriverId
        ? (driversById.get(truck.currentDriverId) ?? null)
        : null;
      const people = {
        driverId: driver?.id ?? null,
        driverName: driver ? `${driver.firstName} ${driver.lastName}`.trim() : null,
        driverType: driver?.driverType ?? null,
        dispatcherId: driver?.dispatcherId ?? null,
        dispatcherName: driver?.dispatcherName ?? null,
      };
      const row = byUnit.get(truck.id);
      if (!row) {
        await this.db
          .insert(ptiInspections)
          .values({
            id: `pti_${crypto.randomUUID()}`,
            companyId: principal.companyId,
            unitId: truck.id,
            unitNumber: truck.unitNumber,
            weekStart,
            dueAt,
            ...people,
            receiptStatus: receiptStatusFor({
              weekStart,
              today,
              receivedOn: null,
              inShop: IN_SHOP.has(truck.status),
            }),
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing();
      } else if (row.reviewState === 'unreviewed') {
        await this.db
          .update(ptiInspections)
          .set({ ...people, unitNumber: truck.unitNumber })
          .where(eq(ptiInspections.id, row.id));
      }
    }
  }

  /** Everything the board shows for a week, in one answer, with counts that equal its rows. */
  async board(principal: Principal, weekStart: string, today: string): Promise<PtiBoard> {
    await this.openWeek(principal, weekStart, today);

    const [inspections, fleet, openDefects, latestReviewed] = await Promise.all([
      this.db
        .select()
        .from(ptiInspections)
        .where(
          and(
            eq(ptiInspections.companyId, principal.companyId),
            eq(ptiInspections.weekStart, weekStart),
          ),
        )
        .orderBy(asc(ptiInspections.unitNumber)),
      this.db
        .select({ id: trucks.id, status: trucks.status })
        .from(trucks)
        .where(eq(trucks.companyId, principal.companyId)),
      this.db
        .select()
        .from(ptiDefects)
        .where(
          and(
            eq(ptiDefects.companyId, principal.companyId),
            sql`${ptiDefects.state} NOT IN ('verified', 'dismissed')`,
          ),
        )
        .orderBy(desc(ptiDefects.createdAt)),
      this.db
        .select({
          unitId: ptiInspections.unitId,
          id: ptiInspections.id,
          weekStart: ptiInspections.weekStart,
          reviewedAt: ptiInspections.reviewedAt,
          reviewResult: ptiInspections.reviewResult,
        })
        .from(ptiInspections)
        .where(
          and(
            eq(ptiInspections.companyId, principal.companyId),
            eq(ptiInspections.reviewState, 'reviewed'),
          ),
        )
        .orderBy(desc(ptiInspections.reviewedAt)),
    ]);

    const statusByUnit = new Map(fleet.map((t) => [t.id, t.status]));
    const histories = await this.historiesFor(openDefects.map((d) => d.id));
    const defectsByUnit = new Map<string, PtiDefect[]>();
    for (const row of openDefects) {
      const list = defectsByUnit.get(row.unitId) ?? [];
      list.push(this.toDefect(row, histories.get(row.id) ?? []));
      defectsByUnit.set(row.unitId, list);
    }
    const latestByUnit = new Map<string, (typeof latestReviewed)[number]>();
    for (const row of latestReviewed)
      if (!latestByUnit.has(row.unitId)) latestByUnit.set(row.unitId, row);

    const rows: PtiBoardRow[] = [];
    for (const row of inspections) {
      // An archived truck is off the board and out of every count, including a week opened before it was archived.
      if (statusByUnit.get(row.unitId) === 'archived') continue;
      const inShop = IN_SHOP.has(statusByUnit.get(row.unitId) ?? '');
      // Receipt follows the calendar and the truck, recomputed on every read (§4.6).
      const receiptStatus = receiptStatusFor({
        weekStart,
        today,
        receivedOn: row.receivedAt ? row.receivedAt.toISOString().slice(0, 10) : null,
        inShop,
      });
      if (receiptStatus !== row.receiptStatus) {
        await this.db
          .update(ptiInspections)
          .set({ receiptStatus })
          .where(eq(ptiInspections.id, row.id));
      }
      const defects = defectsByUnit.get(row.unitId) ?? [];
      const verdict = unitServiceStatus(defects);
      const oldest = defects.reduce<number | null>((min, d) => {
        const t = Date.parse(d.createdAt);
        return min === null || t < min ? t : min;
      }, null);
      const latest = latestByUnit.get(row.unitId);
      rows.push({
        inspection: this.toInspection({ ...row, receiptStatus }),
        latestReviewed:
          latest && latest.reviewedAt && latest.reviewResult
            ? {
                id: latest.id,
                weekStart: latest.weekStart,
                reviewedAt: latest.reviewedAt.toISOString(),
                reviewResult: latest.reviewResult as 'no_issues' | 'issues_found',
              }
            : null,
        openDefects: defects,
        verdict,
        ageDays:
          oldest === null
            ? 0
            : Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - oldest) / 86_400_000)),
        inShop,
      });
    }

    const queues = { chase: 0, review: 0, defects: 0, verify: 0 };
    let cleanAndClosed = 0;
    let inShopExempt = 0;
    let dueSoon = 0;
    const soon = Date.parse(`${today}T00:00:00Z`) + 14 * 86_400_000;
    for (const row of rows) {
      const q = queuesFor(row);
      for (const key of q) queues[key] += 1;
      if (q.length === 0 && row.inspection.reviewState === 'reviewed') cleanAndClosed += 1;
      if (row.inspection.receiptStatus === 'exempt_in_shop') inShopExempt += 1;
      if (row.openDefects.some((d) => d.dueAt && Date.parse(d.dueAt) <= soon)) dueSoon += 1;
    }

    return {
      weekStart,
      dueAt: ptiDueDateOf(weekStart),
      today,
      rows,
      queues,
      quiet: { cleanAndClosed, inShopExempt, dueSoon },
    };
  }

  // ============================================================================ inspections

  /** The unit's last few weeks, newest first, with the defects each review raised (§6.1 history). */
  async unitHistory(
    principal: Principal,
    unitId: string,
    weeks = 4,
  ): Promise<PtiUnitHistoryEntry[]> {
    const rows = await this.db
      .select()
      .from(ptiInspections)
      .where(
        and(eq(ptiInspections.companyId, principal.companyId), eq(ptiInspections.unitId, unitId)),
      )
      .orderBy(desc(ptiInspections.weekStart))
      .limit(weeks);
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({ inspectionId: ptiDefects.foundOnInspectionId, n: sql<number>`count(*)::int` })
      .from(ptiDefects)
      .where(
        and(
          eq(ptiDefects.companyId, principal.companyId),
          inArray(
            ptiDefects.foundOnInspectionId,
            rows.map((r) => r.id),
          ),
        ),
      )
      .groupBy(ptiDefects.foundOnInspectionId);
    const byInspection = new Map(counts.map((c) => [c.inspectionId, c.n]));
    return rows.map((row) => {
      const i = this.toInspection(row);
      return {
        id: i.id,
        weekStart: i.weekStart,
        receiptStatus: i.receiptStatus,
        receivedAt: i.receivedAt,
        reviewState: i.reviewState,
        reviewResult: i.reviewResult,
        reviewerName: i.reviewerName,
        reviewedAt: i.reviewedAt,
        defectCount: byInspection.get(row.id) ?? 0,
      };
    });
  }

  async inspection(principal: Principal, id: string): Promise<PtiInspection> {
    return this.toInspection(await this.inspectionRow(principal, id));
  }

  /** The video arrived. Where it lives comes with it, once, for every defect on the inspection. */
  async receive(
    principal: Principal,
    id: string,
    input: ReceiptInput,
    today: string,
  ): Promise<PtiInspection> {
    this.requireWrite(principal);
    const row = await this.inspectionRow(principal, id);
    this.checkVersion(row.version, input.version);
    const receivedAt = new Date(input.receivedAt);
    const inShop = await this.unitInShop(principal, row.unitId);
    const [updated] = await this.db
      .update(ptiInspections)
      .set({
        receivedAt,
        source: input.source ?? row.source,
        receiptStatus: receiptStatusFor({
          weekStart: row.weekStart,
          today,
          receivedOn: receivedAt.toISOString().slice(0, 10),
          inShop,
        }),
        updatedAt: new Date(),
        version: row.version + 1,
      })
      .where(eq(ptiInspections.id, row.id))
      .returning();
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pti_inspection',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · week of ${row.weekStart}`,
      summary: `Walk-around received${input.source ? ` (${input.source.chatTitle})` : ''}`,
      changes: [
        {
          field: 'receivedAt',
          old: row.receivedAt?.toISOString() ?? null,
          new: receivedAt.toISOString(),
        },
      ],
    });
    return this.toInspection(updated as InspectionRow);
  }

  /** A soft lock: "Elena is reviewing this". Shown, never enforced. */
  async lock(principal: Principal, id: string, on: boolean): Promise<PtiInspection> {
    this.requireWrite(principal);
    const row = await this.inspectionRow(principal, id);
    if (row.reviewState === 'reviewed') return this.toInspection(row);
    const [updated] = await this.db
      .update(ptiInspections)
      .set(
        on
          ? {
              reviewState: 'in_review',
              inReviewBy: principal.userId,
              inReviewByName: principal.userName ?? principal.userId,
              inReviewSince: new Date(),
            }
          : {
              reviewState: 'unreviewed',
              inReviewBy: null,
              inReviewByName: null,
              inReviewSince: null,
            },
      )
      .where(eq(ptiInspections.id, row.id))
      .returning();
    return this.toInspection(updated as InspectionRow);
  }

  /**
   * The review, saved.
   *
   * The rules, in the order they run: every open defect on the unit must have been dispositioned
   * on a clean review, and no disposition closes anything — `looks_fixed` proposes closure and
   * nothing more (§4.3, §4.4). Then the defects this video found are created, each checked for
   * a real description and, above `replace_soon`, a screenshot. Then the inspection is marked
   * reviewed. All of it in one transaction, so a rejected defect leaves the review unsaved.
   */
  async review(
    principal: Principal,
    id: string,
    input: ReviewInput,
    today: string,
  ): Promise<{ inspection: PtiInspection; defects: PtiDefect[] }> {
    this.requireWrite(principal);
    const row = await this.inspectionRow(principal, id);
    this.checkVersion(row.version, input.version);

    const open = await this.db
      .select()
      .from(ptiDefects)
      .where(
        and(
          eq(ptiDefects.companyId, principal.companyId),
          eq(ptiDefects.unitId, row.unitId),
          sql`${ptiDefects.state} NOT IN ('verified', 'dismissed')`,
        ),
      );
    const answered = new Map(input.dispositions.map((d) => [d.defectId, d.seen]));
    if (input.result === 'no_issues') {
      const missing = open.filter((d) => !answered.has(d.id));
      if (missing.length > 0) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: `Say what this video showed for ${missing.map((d) => d.defectNumber).join(', ')} before saving a clean review`,
        });
      }
    }
    for (const defectId of answered.keys()) {
      if (!open.some((d) => d.id === defectId)) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: `${defectId} is not an open defect on this unit`,
        });
      }
    }

    const catalog = await this.componentCatalog(principal);
    for (const defect of input.defects) this.checkDefectInput(defect, catalog);
    await this.checkScreenshots(
      principal,
      input.defects.flatMap((d) => d.evidence.screenshots.map((s) => s.fileId)),
    );

    const now = new Date();
    const created: PtiDefect[] = [];
    await this.db.transaction(async (tx) => {
      // 1 · dispositions: history entries, and a proposal to verify where the reviewer saw a fix.
      for (const defect of open) {
        const seen = answered.get(defect.id);
        if (!seen) continue;
        if (
          seen === 'looks_fixed' &&
          canTransition(defect.state as PtiDefectState, 'fixed_pending_verify')
        ) {
          await tx
            .update(ptiDefects)
            .set({
              state: 'fixed_pending_verify',
              resolution: {
                ...(defect.resolution as object),
                fixedAt: now.toISOString(),
                fixedVia: (defect.resolution as DefectResolution).fixedVia ?? null,
              },
              updatedAt: now,
              version: defect.version + 1,
            })
            .where(eq(ptiDefects.id, defect.id));
          await tx.insert(ptiDefectHistory).values({
            id: `pdh_${crypto.randomUUID()}`,
            defectId: defect.id,
            at: now,
            byId: principal.userId,
            byName: principal.userName ?? principal.userId,
            fromState: defect.state,
            toState: 'fixed_pending_verify',
            note: `Looked fixed on the walk-around of ${row.weekStart}; proposed for verification`,
          });
        } else {
          await tx.insert(ptiDefectHistory).values({
            id: `pdh_${crypto.randomUUID()}`,
            defectId: defect.id,
            at: now,
            byId: principal.userId,
            byName: principal.userName ?? principal.userId,
            fromState: defect.state,
            toState: defect.state as PtiDefectState,
            note:
              seen === 'still_present'
                ? `Still present on the walk-around of ${row.weekStart}`
                : `Not visible on the walk-around of ${row.weekStart}`,
          });
        }
      }

      // 2 · the defects this video found
      for (const defect of input.defects) {
        const inserted = await this.insertDefect(
          tx,
          principal,
          { ...defect, unitId: row.unitId, foundOnInspectionId: row.id },
          row.unitNumber,
          catalog,
          now,
        );
        created.push(inserted);
      }

      // 3 · the review itself. A clean review touched no defect's state above; it cannot here.
      await tx
        .update(ptiInspections)
        .set({
          ...(input.receivedAt
            ? {
                receivedAt: new Date(input.receivedAt),
                receiptStatus: receiptStatusFor({
                  weekStart: row.weekStart,
                  today,
                  receivedOn: input.receivedAt.slice(0, 10),
                  inShop: false,
                }),
              }
            : {}),
          ...(input.source ? { source: input.source } : {}),
          reviewState: 'reviewed',
          reviewerId: principal.userId,
          reviewerName: principal.userName ?? principal.userId,
          reviewedAt: now,
          reviewResult: input.result,
          inReviewBy: null,
          inReviewByName: null,
          inReviewSince: null,
          openDefectDispositions: input.dispositions,
          // A review answers any correction still open: the reviewer has decided.
          correctionRequestedAt: null,
          correctionRequestedBy: null,
          correctionReason: null,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(ptiInspections.id, row.id));
    });

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pti_inspection',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · week of ${row.weekStart}`,
      summary:
        input.result === 'no_issues'
          ? `Walk-around reviewed: no issues${open.length > 0 ? ` (${open.length} defect${open.length === 1 ? '' : 's'} still open)` : ''}`
          : `Walk-around reviewed: ${created.length} issue${created.length === 1 ? '' : 's'} found`,
      changes: [{ field: 'reviewResult', old: row.reviewResult, new: input.result }],
    });

    const inspection = this.toInspection(await this.inspectionRow(principal, id));
    await this.tellDriver(principal, { kind: 'reviewed', inspection });
    return { inspection, defects: created };
  }

  // ============================================================ the driver app (0081)

  /** This week's row for one truck, opening the week first so the row exists. */
  async inspectionForUnit(principal: Principal, unitId: string, today: string): Promise<PtiInspection | null> {
    const weekStart = ptiWeekStartOf(today);
    await this.openWeek(principal, weekStart, today);
    const [row] = await this.db
      .select()
      .from(ptiInspections)
      .where(and(eq(ptiInspections.companyId, principal.companyId), eq(ptiInspections.unitId, unitId), eq(ptiInspections.weekStart, weekStart)))
      .limit(1);
    if (!row) return null;
    const inShop = await this.unitInShop(principal, unitId);
    const receiptStatus = receiptStatusFor({ weekStart, today, receivedOn: row.receivedAt ? row.receivedAt.toISOString().slice(0, 10) : null, inShop });
    return this.toInspection({ ...row, receiptStatus });
  }

  /** The walk-around checklist: the component catalog, in the administrator's order. */
  async checklistTemplate(principal: Principal): Promise<Array<{ key: string; label: string }>> {
    const catalog = await this.componentCatalog(principal);
    return [...catalog.entries()].map(([key, label]) => ({ key, label }));
  }

  /** Defects found on one inspection, with their Fleet state (the driver reads these apart from the review). */
  async defectsForInspection(principal: Principal, inspectionId: string): Promise<PtiDefect[]> {
    const rows = await this.db
      .select()
      .from(ptiDefects)
      .where(and(eq(ptiDefects.companyId, principal.companyId), eq(ptiDefects.foundOnInspectionId, inspectionId)))
      .orderBy(asc(ptiDefects.createdAt));
    const histories = await this.historiesFor(rows.map((r) => r.id));
    return rows.map((r) => this.toDefect(r, histories.get(r.id) ?? []));
  }

  /**
   * The driver's walk-around, from the app: this week's inspection for their truck becomes
   * received and unreviewed (Safety → PTI "Received — Needs review"), the checklist, photos and
   * notes are kept on it, and each item marked Defect becomes an open defect. Nothing here marks
   * anything repaired or reviewed. A resubmission (after a correction, or before anyone reviewed)
   * keeps every earlier submission in the history.
   */
  async submitFromDriver(
    principal: Principal,
    ctx: DriverPtiContext,
    input: DriverPtiSubmitInput,
    today: string,
  ): Promise<{ inspection: PtiInspection; defects: PtiDefect[] }> {
    const weekStart = ptiWeekStartOf(today);
    await this.openWeek(principal, weekStart, today);
    const [row] = await this.db
      .select()
      .from(ptiInspections)
      .where(and(eq(ptiInspections.companyId, principal.companyId), eq(ptiInspections.unitId, ctx.truckId), eq(ptiInspections.weekStart, weekStart)))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `Truck ${ctx.truckUnit} owes no walk-around this week (it is not in service).` });
    }
    if (input.version !== undefined) this.checkVersion(row.version, input.version);
    if (row.reviewState === 'reviewed' && !row.correctionRequestedAt) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Safety has already reviewed this week\'s walk-around. Ask Safety if something needs to change.' });
    }

    const catalog = await this.componentCatalog(principal);
    const seen = new Set<string>();
    for (const item of input.checklist) {
      if (!catalog.has(item.key)) {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${item.key} is not on the walk-around checklist` });
      }
      if (seen.has(item.key)) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${catalog.get(item.key)} is on the checklist twice` });
      seen.add(item.key);
      if (item.result === 'defect') {
        const problem = describeDescriptionProblem(item.note ?? '');
        if (problem) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `${catalog.get(item.key)}: ${problem}` });
      }
    }
    const photoIds = [...new Set([...input.photoFileIds, ...input.checklist.flatMap((i) => i.photoFileIds)])];
    const photos = await this.driverPhotos(principal, photoIds);

    const prior = driverSourceOf(row.source);
    const now = new Date();
    const submissionNumber = (row.driverSubmissionCount ?? 0) + 1;
    const inShop = await this.unitInShop(principal, row.unitId);
    const created: PtiDefect[] = [];
    const existingOpen = await this.db
      .select({ component: ptiDefects.component })
      .from(ptiDefects)
      .where(and(eq(ptiDefects.companyId, principal.companyId), eq(ptiDefects.foundOnInspectionId, row.id), sql`${ptiDefects.state} NOT IN ('verified', 'dismissed')`));
    const alreadyRaised = new Set(existingOpen.map((d) => d.component));

    await this.db.transaction(async (tx) => {
      for (const item of input.checklist) {
        // One open defect per component per week: a resubmission does not raise the same one twice.
        if (item.result !== 'defect' || alreadyRaised.has(item.key)) continue;
        const screenshots = item.photoFileIds.map((fileId) => ({
          fileId,
          fileName: photos.get(fileId)?.fileName ?? 'photo',
          uploadedAt: photos.get(fileId)?.createdAt ?? now.toISOString(),
          uploadedBy: ctx.driverName,
        }));
        created.push(
          await this.insertDefect(
            tx,
            principal,
            {
              unitId: row.unitId,
              foundOnInspectionId: row.id,
              component: item.key,
              description: (item.note ?? '').trim(),
              quickPick: null,
              // The driver says it is a defect; how serious is Safety's call on review.
              severity: 'replace_soon',
              evidence: { clipTime: null, screenshots },
              ownerId: null,
              dueAt: null,
            },
            row.unitNumber,
            catalog,
            now,
          ),
        );
      }
      const submission: DriverPtiSubmission = {
        kind: 'driver_app',
        submissionNumber,
        submittedAt: now.toISOString(),
        driverId: ctx.driverId,
        driverName: ctx.driverName,
        truckId: ctx.truckId,
        truckUnit: ctx.truckUnit,
        trailerId: ctx.trailerId,
        trailerUnit: ctx.trailerUnit,
        checklist: input.checklist,
        photos: photoIds,
        notes: input.notes,
        odometer: input.odometer,
        defectIds: created.map((d) => d.id),
      };
      const source: DriverAppSource = {
        kind: 'driver_app',
        current: submission,
        history: prior ? [...prior.history, prior.current] : [],
        corrections: (prior?.corrections ?? []).map((c) => (c.answeredAt ? c : { ...c, answeredAt: now.toISOString() })),
      };
      await tx
        .update(ptiInspections)
        .set({
          receivedAt: now,
          receiptStatus: receiptStatusFor({ weekStart: row.weekStart, today, receivedOn: today, inShop }),
          source,
          driverId: ctx.driverId,
          driverName: ctx.driverName,
          reviewState: 'unreviewed',
          reviewResult: null,
          reviewerId: null,
          reviewerName: null,
          reviewedAt: null,
          inReviewBy: null,
          inReviewByName: null,
          inReviewSince: null,
          correctionRequestedAt: null,
          correctionRequestedBy: null,
          correctionReason: null,
          driverSubmissionCount: submissionNumber,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(ptiInspections.id, row.id));
    });

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pti_inspection',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · week of ${row.weekStart}`,
      summary: `Walk-around sent from the driver app by ${ctx.driverName} (submission ${submissionNumber}${created.length ? `, ${created.length} defect${created.length === 1 ? '' : 's'} raised` : ''})`,
      changes: [
        { field: 'receivedAt', old: row.receivedAt?.toISOString() ?? null, new: now.toISOString() },
        { field: 'driverSubmissionCount', old: String(row.driverSubmissionCount ?? 0), new: String(submissionNumber) },
      ],
    });
    return { inspection: this.toInspection(await this.inspectionRow(principal, row.id)), defects: created };
  }

  /**
   * Safety sends the walk-around back to the driver with a reason (0081). The submission stays in
   * the history; the row waits for the driver again (receipt follows: awaiting, or missing past the
   * due day), and the driver is notified.
   */
  async requestCorrection(principal: Principal, id: string, input: RequestPtiCorrectionInput): Promise<PtiInspection> {
    this.requireWrite(principal);
    const row = await this.inspectionRow(principal, id);
    this.checkVersion(row.version, input.version);
    const prior = driverSourceOf(row.source);
    if (!prior) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Only a walk-around the driver sent from the app can be sent back for a correction.' });
    }
    if (row.correctionRequestedAt) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'A correction is already requested; the driver has not resubmitted yet.' });
    }
    const now = new Date();
    const by = principal.userName ?? principal.userId;
    const reason = input.reason.trim();
    const source: DriverAppSource = { ...prior, corrections: [...prior.corrections, { requestedAt: now.toISOString(), requestedBy: by, reason, answeredAt: null }] };
    await this.db
      .update(ptiInspections)
      .set({
        source,
        receivedAt: null,
        reviewState: 'unreviewed',
        reviewResult: null,
        reviewerId: null,
        reviewerName: null,
        reviewedAt: null,
        inReviewBy: null,
        inReviewByName: null,
        inReviewSince: null,
        correctionRequestedAt: now,
        correctionRequestedBy: by,
        correctionReason: reason,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(ptiInspections.id, row.id));
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pti_inspection',
      entityId: row.id,
      entityLabel: `Unit ${row.unitNumber} · week of ${row.weekStart}`,
      summary: `Correction requested from the driver: ${reason}`,
      reason,
      changes: [{ field: 'correctionRequestedAt', old: null, new: now.toISOString() }],
    });
    const inspection = this.toInspection(await this.inspectionRow(principal, row.id));
    await this.tellDriver(principal, { kind: 'correction_requested', inspection });
    return inspection;
  }

  /** Photos from the app: files of this company, images, uploaded by this person. */
  private async driverPhotos(principal: Principal, fileIds: string[]): Promise<Map<string, { fileName: string; createdAt: string }>> {
    const out = new Map<string, { fileName: string; createdAt: string }>();
    if (fileIds.length === 0) return out;
    const rows = await this.db
      .select({ id: storedFiles.id, fileName: storedFiles.fileName, contentType: storedFiles.contentType, sizeBytes: storedFiles.sizeBytes, uploadedBy: storedFiles.uploadedBy, createdAt: storedFiles.createdAt })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), inArray(storedFiles.id, fileIds), sql`${storedFiles.deletedAt} is null`));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of fileIds) {
      const file = found.get(id);
      if (!file || file.uploadedBy !== principal.userId) {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `Photo ${id} was not uploaded from this account` });
      }
      const problem = describeScreenshotProblem(file);
      if (problem) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: problem.replace('A screenshot', 'A photo') });
      out.set(id, { fileName: file.fileName, createdAt: file.createdAt.toISOString() });
    }
    return out;
  }

  // ================================================================================ defects

  async listDefects(
    principal: Principal,
    filter: { unitId?: string; state?: PtiDefectState; open?: boolean },
  ): Promise<PtiDefect[]> {
    const rows = await this.db
      .select()
      .from(ptiDefects)
      .where(
        and(
          eq(ptiDefects.companyId, principal.companyId),
          ...(filter.unitId ? [eq(ptiDefects.unitId, filter.unitId)] : []),
          ...(filter.state ? [eq(ptiDefects.state, filter.state)] : []),
          ...(filter.open ? [sql`${ptiDefects.state} NOT IN ('verified', 'dismissed')`] : []),
          // A fleet-wide list leaves archived trucks out; a unit's own page still sees its history.
          ...(filter.unitId
            ? []
            : [
                sql`${ptiDefects.unitId} NOT IN (select ${trucks.id} from ${trucks} where ${trucks.companyId} = ${principal.companyId} and ${trucks.status} = 'archived')`,
              ]),
        ),
      )
      .orderBy(desc(ptiDefects.createdAt));
    const histories = await this.historiesFor(rows.map((r) => r.id));
    return rows.map((row) => this.toDefect(row, histories.get(row.id) ?? []));
  }

  async defect(principal: Principal, id: string): Promise<PtiDefect> {
    const row = await this.defectRow(principal, id);
    const histories = await this.historiesFor([row.id]);
    return this.toDefect(row, histories.get(row.id) ?? []);
  }

  /**
   * Every unit's PTI issues, keyed by unit id, for the sign beside a unit's status on the Trucks
   * list, the truck header and the dispatch board (owner, 2026-10-21). One read for the company;
   * which defects count is `isPtiIssue`, so the screens never decide it themselves.
   */
  async unitIssues(principal: Principal): Promise<Record<string, PtiUnitIssues>> {
    const rows = await this.db
      .select({
        id: ptiDefects.id,
        unitId: ptiDefects.unitId,
        // The truck's number today, when the unit is a truck; the number on the defect otherwise.
        unitNumber: sql<string>`coalesce(${trucks.unitNumber}, ${ptiDefects.unitNumber})`,
        defectNumber: ptiDefects.defectNumber,
        component: ptiDefects.component,
        componentName: ptiDefects.componentName,
        description: ptiDefects.description,
        severity: ptiDefects.severity,
        state: ptiDefects.state,
      })
      .from(ptiDefects)
      .leftJoin(
        trucks,
        and(eq(trucks.id, ptiDefects.unitId), eq(trucks.companyId, principal.companyId)),
      )
      .where(
        and(
          eq(ptiDefects.companyId, principal.companyId),
          inArray(ptiDefects.state, [...UNFIXED_DEFECT_STATES, 'fixed_pending_verify']),
        ),
      );
    return ptiIssuesByUnit(
      rows.map((row) => ({
        ...row,
        severity: row.severity as PtiDefectSeverity,
        state: row.state as PtiDefectState,
      })),
    );
  }

  /** The unit's verdict and the defects behind it, for the truck header and Truck Health. */
  async unitStatus(
    principal: Principal,
    unitId: string,
  ): Promise<{ verdict: ReturnType<typeof unitServiceStatus>; defects: PtiDefect[] }> {
    const defects = await this.listDefects(principal, { unitId, open: true });
    return { verdict: unitServiceStatus(defects), defects };
  }

  /**
   * A load assigned over a hold (§9.1).
   *
   * The block is the rule and this is the exception to it: named, reasoned, and written on every
   * defect it drives over, so the defect's history says who dispatched the truck and why. It
   * changes no state - the hold stands, and the next assignment has to be overridden again.
   * Needs `loads.assign`: it is a dispatch decision, not a fleet one.
   */
  async dispatchOverride(
    principal: Principal,
    unitId: string,
    input: DispatchOverrideInput,
  ): Promise<DispatchOverrideResult> {
    if (!hasPermission(principal, 'loads.assign')) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Missing permission: loads.assign',
      });
    }
    const { verdict, defects } = await this.unitStatus(principal, unitId);
    if (!verdict.dispatchBlocked) return { overridden: false, verdict };

    const blocking = defects.filter((d) => verdict.defectIds.includes(d.id));
    const now = new Date();
    const unitNumber = blocking[0]?.unitNumber ?? unitId;
    await this.db.transaction(async (tx) => {
      for (const defect of blocking) {
        await tx.insert(ptiDefectHistory).values({
          id: `pdh_${crypto.randomUUID()}`,
          defectId: defect.id,
          at: now,
          byId: principal.userId,
          byName: principal.userName ?? principal.userId,
          fromState: defect.state,
          toState: defect.state,
          note: `Dispatched on ${input.loadRef} over the hold - ${input.reason}`,
        });
      }
    });
    await this.audit.write(principal, {
      action: 'approve',
      entityType: 'truck',
      entityId: unitId,
      entityLabel: `Unit ${unitNumber}`,
      summary: `Dispatched on ${input.loadRef} over the hold (${blocking.map((d) => d.defectNumber).join(', ')})`,
      changes: [{ field: 'dispatchOverride', old: null, new: input.reason }],
    });
    return { overridden: true, verdict };
  }

  /** A defect raised on its own: from the truck page, the shop, or a roadside call. */
  async createDefect(principal: Principal, input: CreateDefectInput): Promise<PtiDefect> {
    this.requireWrite(principal);
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
    if (input.foundOnInspectionId) await this.inspectionRow(principal, input.foundOnInspectionId);
    const catalog = await this.componentCatalog(principal);
    this.checkDefectInput(input, catalog);
    await this.checkScreenshots(
      principal,
      input.evidence.screenshots.map((s) => s.fileId),
    );
    const now = new Date();
    return this.db.transaction((tx) =>
      this.insertDefect(tx, principal, input, truck.unitNumber, catalog, now),
    );
  }

  async updateDefect(
    principal: Principal,
    id: string,
    input: UpdateDefectInput,
  ): Promise<PtiDefect> {
    this.requireWrite(principal);
    const row = await this.defectRow(principal, id);
    this.checkVersion(row.version, input.version);
    if (CLOSED_DEFECT_STATES.includes(row.state as PtiDefectState)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${row.defectNumber} is ${row.state}; a closed defect is not edited`,
      });
    }
    const catalog = await this.componentCatalog(principal);
    const severity = input.severity ?? (row.severity as PtiDefect['severity']);
    const evidence = (input.evidence ?? (row.evidence as DefectEvidence)) as DefectEvidence;
    if (input.component && !catalog.has(input.component)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${input.component} is not a component in the catalog`,
      });
    }
    if (screenshotRequired(severity) && evidence.screenshots.length === 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${severity.replace('_', ' ')} defect needs at least one screenshot. Add one from the video.`,
      });
    }
    if (input.evidence)
      await this.checkScreenshots(
        principal,
        input.evidence.screenshots.map((s) => s.fileId),
      );

    // A severity change re-proposes the due date; it never overwrites a date somebody set.
    const severityChanged = input.severity !== undefined && input.severity !== row.severity;
    const dueAt =
      input.dueAt !== undefined
        ? input.dueAt
          ? new Date(input.dueAt)
          : null
        : severityChanged && !row.dueAt
          ? defectDueAt(severity, new Date())
          : row.dueAt;

    // `null` clears the owner; a string names a new one; absent leaves it alone.
    const owner = input.ownerId ? await this.person(principal, input.ownerId) : null;
    const now = new Date();
    await this.db
      .update(ptiDefects)
      .set({
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.component !== undefined
          ? {
              component: input.component,
              componentName: catalog.get(input.component) ?? input.component,
            }
          : {}),
        ...(input.severity !== undefined ? { severity: input.severity } : {}),
        ...(input.evidence !== undefined ? { evidence: input.evidence } : {}),
        ...(input.ownerId !== undefined
          ? { ownerId: owner?.id ?? null, ownerName: owner?.name ?? null }
          : {}),
        ...(input.needsReview !== undefined ? { needsReview: input.needsReview } : {}),
        dueAt,
        updatedAt: now,
        version: row.version + 1,
      })
      .where(eq(ptiDefects.id, row.id));

    const changes: { field: string; old: string | null; new: string | null }[] = [];
    if (input.severity !== undefined && input.severity !== row.severity)
      changes.push({ field: 'severity', old: row.severity, new: input.severity });
    if (input.ownerId !== undefined && (owner?.id ?? null) !== row.ownerId)
      changes.push({ field: 'owner', old: row.ownerName, new: owner?.name ?? null });
    if (input.description !== undefined && input.description !== row.description)
      changes.push({ field: 'description', old: row.description, new: input.description });
    if (input.component !== undefined && input.component !== row.component)
      changes.push({ field: 'component', old: row.component, new: input.component });
    if (input.dueAt !== undefined)
      changes.push({
        field: 'dueAt',
        old: row.dueAt?.toISOString() ?? null,
        new: dueAt?.toISOString() ?? null,
      });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pti_defect',
      entityId: row.id,
      entityLabel: `${row.defectNumber} · unit ${row.unitNumber}`,
      summary: `${row.defectNumber} edited`,
      changes,
    });

    // Assigning an owner is the step out of "open".
    if (owner && row.state === 'open') {
      await this.transition(principal, row.id, {
        version: row.version + 1,
        to: 'assigned',
        note: null,
        reason: null,
        fixedVia: null,
        workOrderId: null,
        workOrderNumber: null,
        ownerId: null,
      });
    }
    return this.defect(principal, row.id);
  }

  /**
   * Moves a defect through its life.
   *
   * The machine is in the contract (`PTI_DEFECT_TRANSITIONS`) and enforced here: `verified` is
   * reachable only from `fixed_pending_verify`, and only with `safety.manage`, because a shop
   * closing a work order is not safety confirming a repair. The hold on the unit lifts at that
   * one transition and no other.
   */
  async transition(
    principal: Principal,
    id: string,
    input: TransitionDefectInput,
  ): Promise<PtiDefect> {
    this.requireWrite(principal);
    const row = await this.defectRow(principal, id);
    this.checkVersion(row.version, input.version);
    const from = row.state as PtiDefectState;
    if (!canTransition(from, input.to)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${row.defectNumber} cannot go from ${from} to ${input.to}`,
      });
    }
    if (input.to === 'verified' && !hasPermission(principal, 'safety.manage') && !hasPermission(principal, 'pti.verify')) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Verifying a repair takes safety.manage or pti.verify',
      });
    }

    const now = new Date();
    const resolution = { ...(row.resolution as DefectResolution) };
    if (input.to === 'fixed_pending_verify') {
      resolution.fixedAt = now.toISOString();
      resolution.fixedVia = input.fixedVia ?? resolution.fixedVia ?? null;
    }
    if (input.to === 'verified') {
      resolution.verifiedAt = now.toISOString();
      resolution.verifiedBy = principal.userName ?? principal.userId;
    }
    if (input.to === 'dismissed') resolution.dismissedReason = input.reason;
    const owner = input.ownerId ? await this.person(principal, input.ownerId) : null;

    await this.db.transaction(async (tx) => {
      await tx
        .update(ptiDefects)
        .set({
          state: input.to,
          resolution,
          ...(input.workOrderId !== null
            ? { workOrderId: input.workOrderId, workOrderNumber: input.workOrderNumber }
            : {}),
          ...(owner ? { ownerId: owner.id, ownerName: owner.name } : {}),
          updatedAt: now,
          version: row.version + 1,
        })
        .where(eq(ptiDefects.id, row.id));
      await tx.insert(ptiDefectHistory).values({
        id: `pdh_${crypto.randomUUID()}`,
        defectId: row.id,
        at: now,
        byId: principal.userId,
        byName: principal.userName ?? principal.userId,
        fromState: from,
        toState: input.to,
        note: input.note ?? input.reason ?? null,
      });
    });

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'pti_defect',
      entityId: row.id,
      entityLabel: `${row.defectNumber} · unit ${row.unitNumber}`,
      summary: `${row.defectNumber}: ${from} → ${input.to}${input.reason ? ` — ${input.reason}` : ''}`,
      changes: [{ field: 'state', old: from, new: input.to }],
      reason: input.reason,
    });
    return this.defect(principal, row.id);
  }

  /**
   * A linked work order closed. The shop's word proposes closure; a person confirms it (§4.4).
   * Called by the work-order paths; returns the defects it moved so the caller can say so.
   */
  async workOrderClosed(principal: Principal, workOrderId: string): Promise<PtiDefect[]> {
    const rows = await this.db
      .select()
      .from(ptiDefects)
      .where(
        and(
          eq(ptiDefects.companyId, principal.companyId),
          eq(ptiDefects.workOrderId, workOrderId),
          sql`${ptiDefects.state} NOT IN ('verified', 'dismissed', 'fixed_pending_verify')`,
        ),
      );
    const moved: PtiDefect[] = [];
    for (const row of rows) {
      if (!canTransition(row.state as PtiDefectState, 'fixed_pending_verify')) continue;
      moved.push(
        await this.transition(principal, row.id, {
          version: row.version,
          to: 'fixed_pending_verify',
          note: `Work order ${row.workOrderNumber ?? workOrderId} closed by the shop; awaiting verification`,
          reason: null,
          fixedVia: 'work_order',
          workOrderId: null,
          workOrderNumber: null,
          ownerId: null,
        }),
      );
    }
    return moved;
  }

  // ================================================================================ helpers

  private async insertDefect(
    tx: Tx,
    principal: Principal,
    input: CreateDefectInput,
    unitNumber: string,
    catalog: Map<string, string>,
    now: Date,
  ): Promise<PtiDefect> {
    const [next] = await tx
      .select({
        seq: sql<number>`coalesce(max(nullif(regexp_replace(${ptiDefects.defectNumber}, '\\D', '', 'g'), '')::int), 0) + 1`,
      })
      .from(ptiDefects)
      .where(eq(ptiDefects.companyId, principal.companyId));
    const seq = next?.seq ?? 1;
    const owner = input.ownerId ? await this.person(principal, input.ownerId) : null;
    const id = `pdf_${crypto.randomUUID()}`;
    const state: PtiDefectState = owner ? 'assigned' : 'open';
    const [row] = await tx
      .insert(ptiDefects)
      .values({
        id,
        companyId: principal.companyId,
        defectNumber: `DEF-${String(seq).padStart(4, '0')}`,
        unitId: input.unitId,
        unitNumber,
        foundOnInspectionId: input.foundOnInspectionId,
        component: input.component,
        componentName: catalog.get(input.component) ?? input.component,
        description: input.description,
        quickPick: input.quickPick,
        severity: input.severity,
        state,
        evidence: input.evidence,
        ownerId: owner?.id ?? null,
        ownerName: owner?.name ?? null,
        dueAt: input.dueAt ? new Date(input.dueAt) : defectDueAt(input.severity, now),
        resolution: {},
        createdBy: principal.userName ?? principal.userId,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    await tx.insert(ptiDefectHistory).values({
      id: `pdh_${crypto.randomUUID()}`,
      defectId: id,
      at: now,
      byId: principal.userId,
      byName: principal.userName ?? principal.userId,
      fromState: null,
      toState: state,
      note: input.foundOnInspectionId ? 'Found on the weekly walk-around' : 'Raised directly',
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'pti_defect',
      entityId: id,
      entityLabel: `${row?.defectNumber} · unit ${unitNumber}`,
      summary: `${row?.defectNumber} raised: ${catalog.get(input.component) ?? input.component} — ${input.description}`,
      changes: [
        { field: 'severity', old: null, new: input.severity },
        { field: 'component', old: null, new: input.component },
      ],
    });
    return this.toDefect(row as DefectRow, [
      {
        id: '',
        at: now.toISOString(),
        byId: principal.userId,
        byName: principal.userName ?? principal.userId,
        from: null,
        to: state,
        note: null,
      },
    ]);
  }

  /** The description rule, the catalog rule and the screenshot rule, in one place. */
  private checkDefectInput(
    input: { component: string; severity: PtiDefect['severity']; evidence: DefectEvidence },
    catalog: Map<string, string>,
  ): void {
    if (!catalog.has(input.component)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${input.component} is not a component in the walk-around catalog`,
      });
    }
    if (screenshotRequired(input.severity) && input.evidence.screenshots.length === 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${input.severity.replace('_', ' ')} defect needs at least one screenshot from the video. Add one before saving.`,
      });
    }
  }

  /** Every screenshot must be a file this company uploaded, an image, and screenshot-sized. */
  private async checkScreenshots(principal: Principal, fileIds: string[]): Promise<void> {
    if (fileIds.length === 0) return;
    const rows = await this.db
      .select({
        id: storedFiles.id,
        contentType: storedFiles.contentType,
        sizeBytes: storedFiles.sizeBytes,
      })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), inArray(storedFiles.id, fileIds)));
    const found = new Map(rows.map((r) => [r.id, r]));
    for (const id of fileIds) {
      const file = found.get(id);
      if (!file)
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: `Screenshot ${id} was not uploaded`,
        });
      const problem = describeScreenshotProblem(file);
      if (problem)
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: problem });
    }
  }

  /**
   * The component catalog: key → name.
   *
   * Read from the workspace store, where the administrator edits it; the defaults stand in until
   * a store exists. A defect's component is checked against this, so nothing can produce a
   * defect on a component that is not on the walk-around.
   */
  private async componentCatalog(principal: Principal): Promise<Map<string, string>> {
    const workspace = await this.state.workspace(principal.companyId);
    const stored =
      (workspace?.data.ptiComponents as
        { name?: string; key?: string; active?: boolean }[] | undefined) ?? [];
    const catalog = new Map<string, string>();
    for (const entry of stored) {
      if (!entry?.name) continue;
      catalog.set(entry.key ?? componentKeyFromName(entry.name), entry.name);
    }
    if (catalog.size === 0) {
      for (const key of DEFAULT_PTI_COMPONENT_KEYS) catalog.set(key, key.replace(/_/g, ' '));
    }
    return catalog;
  }

  private async person(
    principal: Principal,
    userId: string,
  ): Promise<{ id: string; name: string }> {
    // Owners are accounts; the audit already carries names, so the name is read once here.
    const found = (await this.assignees(principal)).find((a) => a.id === userId);
    if (!found)
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That owner is not an account in this company',
      });
    return { id: found.id, name: found.name };
  }

  /**
   * Who a defect can be given to: the company's active accounts, with their role codes, so the
   * drawer can apply the routing rule (§6.3: oos_risk and replace_now to the shop, the rest to
   * the unit's dispatcher) and still offer everyone as the override.
   */
  async assignees(principal: Principal): Promise<{ id: string; name: string; roles: string[] }[]> {
    const rows = await this.db.execute(sql`
      SELECT u.id, u.first_name AS "firstName", u.last_name AS "lastName",
             COALESCE(array_agg(r.code) FILTER (WHERE r.code IS NOT NULL), '{}') AS roles
      FROM users u
      JOIN memberships m ON m.user_id = u.id AND m.company_id = ${principal.companyId} AND m.status = 'active'
      LEFT JOIN membership_roles mr ON mr.membership_id = m.id
      LEFT JOIN roles r ON r.id = mr.role_id AND r.status = 'active'
      WHERE u.is_active = true
      GROUP BY u.id, u.first_name, u.last_name
      ORDER BY u.first_name, u.last_name
    `);
    return (
      rows as unknown as { id: string; firstName: string; lastName: string; roles: string[] }[]
    ).map((row) => ({
      id: row.id,
      name: `${row.firstName} ${row.lastName}`.trim(),
      roles: Array.isArray(row.roles) ? row.roles : [],
    }));
  }

  private async unitInShop(principal: Principal, unitId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ status: trucks.status })
      .from(trucks)
      .where(and(eq(trucks.companyId, principal.companyId), eq(trucks.id, unitId)))
      .limit(1);
    return IN_SHOP.has(row?.status ?? '');
  }

  private async inspectionRow(principal: Principal, id: string): Promise<InspectionRow> {
    const [row] = await this.db
      .select()
      .from(ptiInspections)
      .where(and(eq(ptiInspections.companyId, principal.companyId), eq(ptiInspections.id, id)))
      .limit(1);
    if (!row)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That inspection no longer exists',
      });
    return row;
  }

  private async defectRow(principal: Principal, id: string): Promise<DefectRow> {
    const [row] = await this.db
      .select()
      .from(ptiDefects)
      .where(and(eq(ptiDefects.companyId, principal.companyId), eq(ptiDefects.id, id)))
      .limit(1);
    if (!row)
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: 'That defect no longer exists',
      });
    return row;
  }

  private async historiesFor(defectIds: string[]): Promise<Map<string, PtiDefect['history']>> {
    const out = new Map<string, PtiDefect['history']>();
    if (defectIds.length === 0) return out;
    const rows = await this.db
      .select()
      .from(ptiDefectHistory)
      .where(inArray(ptiDefectHistory.defectId, defectIds))
      .orderBy(asc(ptiDefectHistory.at));
    for (const row of rows) {
      const list = out.get(row.defectId) ?? [];
      list.push({
        id: row.id,
        at: row.at.toISOString(),
        byId: row.byId,
        byName: row.byName,
        from: (row.fromState as PtiDefectState | null) ?? null,
        to: row.toState as PtiDefectState,
        note: row.note,
      });
      out.set(row.defectId, list);
    }
    return out;
  }

  private requireWrite(principal: Principal): void {
    if (
      !hasPermission(principal, 'maintenance.edit') &&
      !hasPermission(principal, 'safety.manage')
    ) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Missing permission: maintenance.edit or safety.manage',
      });
    }
  }

  private checkVersion(current: number, given: number): void {
    if (current !== given) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Somebody saved this record after you opened it. Reload and try again.',
      });
    }
  }

  private toInspection(row: InspectionRow): PtiInspection {
    const fromApp = driverSourceOf(row.source);
    const corrections = fromApp?.corrections ?? [];
    const open = corrections.find((c) => !c.answeredAt) ?? null;
    return {
      id: row.id,
      unitId: row.unitId,
      unitNumber: row.unitNumber,
      weekStart: row.weekStart,
      dueAt: row.dueAt,
      driverId: row.driverId,
      driverName: row.driverName,
      driverType: row.driverType,
      dispatcherId: row.dispatcherId,
      dispatcherName: row.dispatcherName,
      receiptStatus: row.receiptStatus as PtiInspection['receiptStatus'],
      receivedAt: row.receivedAt?.toISOString() ?? null,
      // The Telegram pointer only; a walk-around from the driver app reads as driverSubmission.
      source: fromApp ? null : ((row.source as TelegramSource | null) ?? null),
      driverSubmission: fromApp?.current ?? null,
      driverHistory: fromApp?.history ?? [],
      correction: row.correctionRequestedAt ? (open ?? { requestedAt: row.correctionRequestedAt.toISOString(), requestedBy: row.correctionRequestedBy ?? '', reason: row.correctionReason ?? '', answeredAt: null }) : null,
      corrections,
      reviewState: row.reviewState as PtiInspection['reviewState'],
      reviewerId: row.reviewerId,
      reviewerName: row.reviewerName,
      reviewedAt: row.reviewedAt?.toISOString() ?? null,
      reviewResult: (row.reviewResult as PtiInspection['reviewResult']) ?? null,
      inReviewBy: row.inReviewBy,
      inReviewByName: row.inReviewByName,
      inReviewSince: row.inReviewSince?.toISOString() ?? null,
      openDefectDispositions:
        (row.openDefectDispositions as PtiInspection['openDefectDispositions']) ?? [],
      legacyRecordId: row.legacyRecordId,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }

  private toDefect(row: DefectRow, history: PtiDefect['history']): PtiDefect {
    const resolution = (row.resolution as Partial<DefectResolution>) ?? {};
    return {
      id: row.id,
      defectNumber: row.defectNumber,
      unitId: row.unitId,
      unitNumber: row.unitNumber,
      foundOnInspectionId: row.foundOnInspectionId,
      component: row.component,
      componentName: row.componentName,
      description: row.description,
      quickPick: row.quickPick,
      severity: row.severity as PtiDefect['severity'],
      state: row.state as PtiDefectState,
      evidence: (row.evidence as DefectEvidence) ?? { clipTime: null, screenshots: [] },
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      dueAt: row.dueAt?.toISOString() ?? null,
      workOrderId: row.workOrderId,
      workOrderNumber: row.workOrderNumber,
      resolution: {
        fixedAt: resolution.fixedAt ?? null,
        fixedVia: resolution.fixedVia ?? null,
        verifiedAt: resolution.verifiedAt ?? null,
        verifiedBy: resolution.verifiedBy ?? null,
        dismissedReason: resolution.dismissedReason ?? null,
      },
      needsReview: row.needsReview,
      legacyRecordId: row.legacyRecordId,
      history,
      createdBy: row.createdBy,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
      version: row.version,
    };
  }
}
