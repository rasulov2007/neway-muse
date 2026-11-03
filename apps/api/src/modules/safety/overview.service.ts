import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import {
  ACCIDENT_STAGE_LABEL,
  CLAIM_STAGE_LABEL,
  addDaysIso,
  ptiWeekStartOf,
  type PreTripSummary,
  type AccidentStage,
  type AttentionPriority,
  type ClaimStage,
  type SafetyAttentionItem,
  type SafetyOpenCase,
  type SafetyOverview,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { qualificationItems } from '../../database/schema/compliance';
import { ptiDefects, ptiInspections } from '../../database/schema/pti';
import {
  drugAlcoholTests,
  safetyAccidents,
  safetyClaims,
  safetyRoadsideInspections,
  safetyReviews,
  safetyViolations,
} from '../../database/schema/safety';
import { SafetyCoreService } from './safety-core.service';
import { DrugTestsService } from './tests.service';

const PRIORITY_RANK: Record<AttentionPriority, number> = { high: 0, medium: 1, low: 2 };

/**
 * The Safety overview: five numbers and the work behind them.
 *
 * Every number is a count of rows the page can list. "Needs attention" is the next action of
 * every open case, highest priority first, then by due date. Test records (`is_test`) and voided
 * records are kept out of every total.
 */
@Injectable()
export class SafetyOverviewService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly tests: DrugTestsService,
  ) {}

  private get db() {
    return this.core.db;
  }

  async overview(principal: Principal): Promise<SafetyOverview> {
    const companyId = principal.companyId;
    const today = this.core.today();
    const soon = addDaysIso(today, 2);
    const horizon = addDaysIso(today, 30);

    const [accidents, claims, violations, roadside, reviews, tests, quals] = await Promise.all([
      this.db.select().from(safetyAccidents).where(and(eq(safetyAccidents.companyId, companyId), isNull(safetyAccidents.voidedAt), eq(safetyAccidents.isTest, false))),
      this.db.select().from(safetyClaims).where(and(eq(safetyClaims.companyId, companyId), isNull(safetyClaims.voidedAt), eq(safetyClaims.isTest, false))),
      this.db.select().from(safetyViolations).where(and(eq(safetyViolations.companyId, companyId), isNull(safetyViolations.voidedAt), eq(safetyViolations.isTest, false))),
      this.db.select().from(safetyRoadsideInspections).where(and(eq(safetyRoadsideInspections.companyId, companyId), isNull(safetyRoadsideInspections.voidedAt), eq(safetyRoadsideInspections.isTest, false))),
      this.db.select().from(safetyReviews).where(and(eq(safetyReviews.companyId, companyId), isNull(safetyReviews.voidedAt), eq(safetyReviews.isTest, false))),
      this.db.select().from(drugAlcoholTests).where(and(eq(drugAlcoholTests.companyId, companyId), isNull(drugAlcoholTests.voidedAt), eq(drugAlcoholTests.isTest, false))),
      this.db
        .select({ expiresOn: qualificationItems.expiresOn, notApplicable: qualificationItems.notApplicable, waivedUntil: qualificationItems.waivedUntil })
        .from(qualificationItems)
        .where(eq(qualificationItems.companyId, companyId)),
    ]);

    const attention: SafetyAttentionItem[] = [];
    const push = (base: Omit<SafetyAttentionItem, 'priority' | 'overdue' | 'key'>, forceHigh = false) => {
      if (!base.task) return;
      const overdue = Boolean(base.dueOn && base.dueOn < today);
      const priority: AttentionPriority = forceHigh || overdue ? 'high' : base.dueOn && base.dueOn <= soon ? 'medium' : 'low';
      attention.push({ ...base, key: `${base.caseType}:${base.caseId}`, priority, overdue });
    };

    const openAccidents = accidents.filter((a) => !a.closedAt);
    for (const a of openAccidents) {
      push({ task: a.nextAction ?? '', caseType: 'accident', caseId: a.id, caseNumber: a.number, driverName: a.driverName, truckNumber: a.truckNumber, ownerName: a.ownerName, dueOn: a.nextActionDueOn });
    }
    const openClaims = claims.filter((c) => c.stage !== 'closed');
    for (const c of openClaims) {
      push({ task: c.nextAction ?? '', caseType: 'claim', caseId: c.id, caseNumber: c.number, driverName: c.driverName, truckNumber: c.truckNumber, ownerName: c.ownerName, dueOn: c.nextActionDueOn });
    }
    const openViolations = violations.filter((v) => !v.closedAt);
    for (const v of openViolations) {
      push(
        { task: v.nextAction ?? '', caseType: 'violation', caseId: v.id, caseNumber: v.number, driverName: v.driverName, truckNumber: v.truckNumber, ownerName: v.ownerName, dueOn: v.nextActionDueOn ?? v.correctionDueOn },
        v.oos && v.correctionStatus === 'open',
      );
    }
    for (const r of roadside) {
      if (!r.nextAction) continue;
      push(
        { task: r.nextAction, caseType: 'roadside_inspection', caseId: r.id, caseNumber: r.number, driverName: r.driverName, truckNumber: r.truckNumber, ownerName: r.ownerName, dueOn: r.nextActionDueOn },
        r.oos && r.stage === 'received',
      );
    }
    for (const r of reviews) {
      if (!r.nextAction) continue;
      push({ task: r.nextAction, caseType: 'safety_review', caseId: r.id, caseNumber: r.number, driverName: r.driverName, truckNumber: null, ownerName: r.ownerName, dueOn: r.nextActionDueOn });
    }
    const visible = this.tests.canSeeResults(principal);
    for (const t of tests) {
      const status = this.tests.rawStatus(t);
      if (status.resolved) continue;
      push(
        {
          task: visible ? (status.nextAction ?? 'Resolve the test') : `Resolve the ${t.substance} test (restricted)`,
          caseType: 'drug_test',
          caseId: t.id,
          caseNumber: t.number,
          driverName: t.driverName,
          truckNumber: null,
          ownerName: t.ownerName,
          dueOn: status.dueAt ? status.dueAt.slice(0, 10) : t.nextActionDueOn,
        },
        t.testType === 'post_accident',
      );
    }
    attention.sort((a, b) => PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));

    const openCases: SafetyOpenCase[] = [
      ...openAccidents.map((a) => ({
        caseType: 'accident' as const,
        caseId: a.id,
        caseNumber: a.number,
        stageLabel: ACCIDENT_STAGE_LABEL[a.stage as AccidentStage] ?? a.stage,
        nextAction: a.nextAction,
        ownerName: a.ownerName,
        dueOn: a.nextActionDueOn,
      })),
      ...openClaims.map((c) => ({
        caseType: 'claim' as const,
        caseId: c.id,
        caseNumber: c.number,
        stageLabel: CLAIM_STAGE_LABEL[c.stage as ClaimStage] ?? c.stage,
        nextAction: c.nextAction,
        ownerName: c.ownerName,
        dueOn: c.nextActionDueOn,
      })),
    ].sort((a, b) => (a.dueOn ?? '9999').localeCompare(b.dueOn ?? '9999'));

    // Qualification items expiring within 30 days (or already expired): what the compliance
    // workbench will ask for next. Not-applicable and waived items owe nothing.
    const complianceDue30 = quals.filter(
      (i) => !i.notApplicable && !(i.waivedUntil && i.waivedUntil >= today) && i.expiresOn !== null && i.expiresOn <= horizon,
    ).length;

    return {
      today,
      tiles: {
        urgentTasks: attention.filter((i) => i.priority === 'high').length,
        openAccidents: openAccidents.length,
        activeClaims: openClaims.length,
        unresolvedViolations: openViolations.length,
        complianceDue30,
      },
      needsAttention: attention,
      openCases,
    };
  }

  /**
   * The weekly walk-around, read for Safety: this week's counts and the latest submissions.
   * Read-only — it never opens a week on the board (the Pre-trip board does that) — and readable
   * with safety.view, so Safety sees it without the shop's permissions.
   */
  async pretrip(principal: Principal): Promise<PreTripSummary> {
    const companyId = principal.companyId;
    const weekStart = ptiWeekStartOf(this.core.today());
    const [week, open, recent] = await Promise.all([
      this.db.select().from(ptiInspections).where(and(eq(ptiInspections.companyId, companyId), eq(ptiInspections.weekStart, weekStart))),
      this.db
        .select({ unitId: ptiDefects.unitId, severity: ptiDefects.severity, description: ptiDefects.description, inspectionId: ptiDefects.foundOnInspectionId })
        .from(ptiDefects)
        .where(and(eq(ptiDefects.companyId, companyId), inArray(ptiDefects.state, ['open', 'assigned', 'scheduled', 'in_repair', 'fixed_pending_verify']))),
      this.db
        .select()
        .from(ptiInspections)
        .where(and(eq(ptiInspections.companyId, companyId), isNotNull(ptiInspections.receivedAt)))
        .orderBy(desc(ptiInspections.receivedAt))
        .limit(10),
    ]);
    const monitorUnits = new Set(open.filter((d) => d.severity === 'monitor').map((d) => d.unitId));
    const issueUnits = new Set(open.filter((d) => d.severity !== 'monitor').map((d) => d.unitId));
    const counts = {
      missing: week.filter((r) => r.receiptStatus === 'missing').length,
      awaitingReview: week.filter((r) => (r.receiptStatus === 'received' || r.receiptStatus === 'late') && r.reviewState !== 'reviewed').length,
      issueFound: issueUnits.size,
      monitoring: [...monitorUnits].filter((u) => !issueUnits.has(u)).length,
    };
    return {
      weekStart,
      counts,
      recent: recent.map((r) => {
        const found = open.filter((d) => d.inspectionId === r.id);
        const result: PreTripSummary['recent'][number]['result'] =
          r.reviewState !== 'reviewed'
            ? 'awaiting_review'
            : r.reviewResult === 'issues_found'
              ? found.some((d) => d.severity !== 'monitor')
                ? 'issue_found'
                : found.length > 0
                  ? 'monitoring'
                  : 'issue_found'
              : 'good';
        return {
          inspectionId: r.id,
          unitId: r.unitId,
          unitNumber: r.unitNumber,
          driverName: r.driverName,
          receivedAt: (r.receivedAt as Date).toISOString(),
          result,
          notes: found[0]?.description ?? (result === 'good' ? 'No issues noted' : null),
        };
      }),
    };
  }
}
