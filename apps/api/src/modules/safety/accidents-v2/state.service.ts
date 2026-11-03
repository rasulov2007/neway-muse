import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, ne, or, sql } from 'drizzle-orm';
import { safetyRules as R } from '@neway/shared';
import { DatabaseService } from '../../../database/database.service';
import { memberships, membershipRoles, roles, users } from '../../../database/schema/admin';
import {
  accidentRestricted,
  accidentUnits,
  downtimePeriods,
  safetyClaimDocuments,
  safetyClaimLog,
  safetyDocumentVersions,
  unitStatusHistory,
  accidentFactors,
  accidentFacts,
  accidentOtherVehicles,
  accidentQuestions,
  accidentReviewItems,
  accidentStatements,
  accidentWitnesses,
  workOrderEstimates,
  type UnitStatusHistoryRow,
  safetySettings,
  safetyTaskUpdates,
  safetyTasks,
  safetyTimelineEvents,
  type AccidentRestrictedRow,
  type AccidentUnitRow,
  type DowntimePeriodRow,
  type SafetyTaskRow,
} from '../../../database/schema/accidents-v2';
import { acctBills } from '../../../database/schema/accounting';
import { trailers, workOrders } from '../../../database/schema/fleet';
import { loads } from '../../../database/schema/loads';
import { drivers, trucks } from '../../../database/schema/roster';
import { odometerReadings } from '../../../database/schema/pm';
import { mileageFor } from '../../fleet/expense-summary.engine';
import {
  drugAlcoholTests,
  safetyAccidents,
  safetyCaseDocuments,
  safetyClaimLines,
  safetyClaimPayments,
  safetyClaims,
  safetyReviews,
  type SafetyClaimRow,
  type DrugAlcoholTestRow,
  type SafetyAccidentRow,
  type SafetyReviewRow,
} from '../../../database/schema/safety';
import { accidentInjured, billOf, caseOf, claimOf, legacyClaimView, downtimeOf, eventOf, evidenceOf, taskOf, workOrderOf, type AcctBillRow, type WorkOrderRow } from './mapping';

const VOID_BILL = new Set(['void', 'voided', 'cancelled']);

/** A department for a person, from their system role (SPEC §7.8 departments). */
const ROLE_DEPT: Record<string, R.Dept> = {
  safety_manager: 'Safety',
  fleet_manager: 'Fleet',
  maintenance: 'Fleet',
  dispatcher: 'Dispatch',
  dispatch_lead: 'Dispatch',
  accounting: 'Accounting',
  operations_manager: 'Management',
  administrator: 'Management',
  driver_relations: 'Driver Relations',
};

export interface LoadInfo {
  id: string;
  number: string;
  truckId: string | null;
  customer: string | null;
  broker: string | null;
  commodity: string | null;
  origin: string | null;
  destination: string | null;
  hazmat: boolean | null;
}

/** Everything a company's accident board and cases read, assembled for the rules. */
export interface CompanyState {
  /** Every live (not voided) case, test data included — the board lists test rows with a badge. */
  all: R.SafetyRulesState;
  /** The same without test data: every count, total, KPI, register and attention list reads this (API.md §0). */
  live: R.SafetyRulesState;
  rows: Map<string, SafetyAccidentRow>;
  units: Map<string, AccidentUnitRow[]>;
  taskRows: Map<string, SafetyTaskRow>;
  /** Live (not voided) claims of the company, by id. */
  claimRows: Map<string, SafetyClaimRow>;
  /** Work orders the accidents read (P3): linked to a case, or accident repairs with no case. */
  woRows: Map<string, WorkOrderRow>;
  /** Corrective actions (safety_reviews rows) by accident (P4 views need number and version). */
  actionRows: Map<string, SafetyReviewRow[]>;
  /** Open (current) unit status rows written by Dispatch confirmations (P3). */
  unitStatus: UnitStatusHistoryRow[];
  billRows: Map<string, AcctBillRow>;
  downtimeRows: DowntimePeriodRow[];
  settings: Partial<R.SafetyRuleSettings>;
  deptAssignees: Partial<Record<R.Dept, { id: string; name: string }>>;
  peopleDept: Map<string, R.Dept | null>;
  loadInfo: Map<string, LoadInfo>;
}

/**
 * Reads a company's accident data and maps it onto the rules' model. P1 sources: cases, units, restricted
 * details, post-accident tests, corrective actions, tasks, timeline events, downtime and case documents.
 * P2 adds every live claim of the company (linked or standalone) with its payments, checklist and log.
 * P3 adds the work orders linked to a case (and accident repairs with no case), their estimates, the AP bills of a case
 * (direct, through a claim, or through its work order) and each truck's daily contribution for lost revenue.
 */
@Injectable()
export class AccidentsV2StateService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async settings(companyId: string): Promise<{ rules: Partial<R.SafetyRuleSettings>; deptAssignees: CompanyState['deptAssignees'] }> {
    const rows = await this.db.select().from(safetySettings).where(eq(safetySettings.companyId, companyId));
    const rules = (rows.find((r) => r.key === 'rules')?.value ?? {}) as Partial<R.SafetyRuleSettings>;
    const deptAssignees = (rows.find((r) => r.key === 'dept_default_assignee')?.value ?? {}) as CompanyState['deptAssignees'];
    return { rules, deptAssignees };
  }

  /**
   * Fleet miles per month and odometer coverage (SPEC §6 "Odometer miles + coverage", §7.14). A truck's miles in a
   * month come from Fleet's own rule (`mileageFor` — the Expense summary engine: readings must span most of the
   * month and never go backwards); coverage is the share of the fleet's non-archived trucks that have miles that
   * month. A range with no readings at all returns [] ("No mileage data").
   */
  async mileage(companyId: string, months: string[]): Promise<R.MileageMonth[]> {
    if (!months.length) return [];
    const fleet = await this.db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, companyId), ne(trucks.status, 'archived')));
    if (!fleet.length) return [];
    const ids = fleet.map((t) => t.id);
    const monthEnd = (m: string) => {
      const [y, mo] = m.split('-').map(Number) as [number, number];
      return `${m}-${String(new Date(Date.UTC(y, mo, 0)).getUTCDate()).padStart(2, '0')}`;
    };
    const rows = await this.db
      .select({ unitId: odometerReadings.unitId, date: odometerReadings.readingDate, odometer: odometerReadings.odometerMiles })
      .from(odometerReadings)
      .where(
        and(
          eq(odometerReadings.companyId, companyId),
          ne(odometerReadings.status, 'void'),
          inArray(odometerReadings.unitId, ids),
          gte(odometerReadings.readingDate, `${months[0]}-01`),
          lte(odometerReadings.readingDate, monthEnd(months[months.length - 1] as string)),
        ),
      );
    if (!rows.length) return [];
    const byUnit = new Map<string, { date: string; odometer: number }[]>();
    for (const r of rows) byUnit.set(r.unitId, [...(byUnit.get(r.unitId) ?? []), { date: String(r.date), odometer: r.odometer }]);
    return months.map((m) => {
      let miles = 0;
      let covered = 0;
      for (const id of ids) {
        const res = mileageFor(id, byUnit.get(id) ?? [], `${m}-01`, monthEnd(m));
        if (res.miles !== null) {
          miles += res.miles;
          covered += 1;
        }
      }
      return { month: m, miles, coverage: covered / ids.length };
    });
  }

  async load(companyId: string, opts: { events?: boolean; accidentId?: string } = {}): Promise<CompanyState> {
    const db = this.db;
    const accidentRows = await db
      .select()
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, companyId), isNull(safetyAccidents.voidedAt)))
      .orderBy(desc(safetyAccidents.occurredAt));
    const ids = accidentRows.map((r) => r.id);
    const none = ids.length === 0;
    const [unitRows, restrictedRows, testRows, actionRows, taskRows, downtimeRows, docRows, settings] = await Promise.all([
      none ? [] : db.select().from(accidentUnits).where(and(eq(accidentUnits.companyId, companyId), inArray(accidentUnits.accidentId, ids))),
      none ? [] : db.select().from(accidentRestricted).where(and(eq(accidentRestricted.companyId, companyId), inArray(accidentRestricted.accidentId, ids))),
      none
        ? []
        : db
            .select()
            .from(drugAlcoholTests)
            .where(and(eq(drugAlcoholTests.companyId, companyId), inArray(drugAlcoholTests.accidentId, ids), isNull(drugAlcoholTests.voidedAt))),
      none
        ? []
        : db
            .select()
            .from(safetyReviews)
            .where(
              and(
                eq(safetyReviews.companyId, companyId),
                or(
                  inArray(safetyReviews.accidentId, ids),
                  and(eq(safetyReviews.linkedType, 'accident'), inArray(safetyReviews.linkedId, ids), inArray(safetyReviews.kind, ['coaching', 'corrective_action'])),
                ),
              ),
            ),
      db.select().from(safetyTasks).where(eq(safetyTasks.companyId, companyId)),
      none ? [] : db.select().from(downtimePeriods).where(and(eq(downtimePeriods.companyId, companyId), inArray(downtimePeriods.accidentId, ids))),
      none
        ? []
        : db
            .select()
            .from(safetyCaseDocuments)
            .where(and(eq(safetyCaseDocuments.companyId, companyId), eq(safetyCaseDocuments.caseType, 'accident'), inArray(safetyCaseDocuments.caseId, ids))),
      this.settings(companyId),
    ]);
    const updateRows =
      taskRows.length === 0
        ? []
        : await db.select().from(safetyTaskUpdates).where(eq(safetyTaskUpdates.companyId, companyId)).orderBy(asc(safetyTaskUpdates.at));
    // Claims (P2): every live claim of the company — linked to a case or standalone — with its payments (the one
    // source of claim money), checklist and correspondence.
    const claimRows = await db
      .select()
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), isNull(safetyClaims.voidedAt)))
      .orderBy(asc(safetyClaims.createdAt), asc(safetyClaims.number));
    const claimIds = claimRows.map((k) => k.id);
    // Claims written before v2 (no claim_type) are read as cutover C2 would write them: their first live line.
    const legacyClaimIds = claimRows.filter((k) => !k.claimType).map((k) => k.id);
    const lineRows = legacyClaimIds.length
      ? await db
          .select()
          .from(safetyClaimLines)
          .where(and(eq(safetyClaimLines.companyId, companyId), inArray(safetyClaimLines.claimId, legacyClaimIds), isNull(safetyClaimLines.voidedAt)))
          .orderBy(asc(safetyClaimLines.createdAt), asc(safetyClaimLines.id))
      : [];
    const firstLineBy = new Map<string, (typeof lineRows)[number]>();
    for (const l of lineRows) if (!firstLineBy.has(l.claimId)) firstLineBy.set(l.claimId, l);
    const injuredIds = new Set(accidentRows.filter(accidentInjured).map((a) => a.id));
    const [paymentRows, claimDocRows, claimLogRows] = claimIds.length
      ? await Promise.all([
          db
            .select()
            .from(safetyClaimPayments)
            .where(and(eq(safetyClaimPayments.companyId, companyId), inArray(safetyClaimPayments.claimId, claimIds), isNull(safetyClaimPayments.voidedAt))),
          db.select().from(safetyClaimDocuments).where(and(eq(safetyClaimDocuments.companyId, companyId), inArray(safetyClaimDocuments.claimId, claimIds))).orderBy(asc(safetyClaimDocuments.sort)),
          db.select().from(safetyClaimLog).where(and(eq(safetyClaimLog.companyId, companyId), inArray(safetyClaimLog.claimId, claimIds))).orderBy(desc(safetyClaimLog.at)),
        ])
      : [[], [], []];
    const eventRows = opts.events
      ? await db
          .select()
          .from(safetyTimelineEvents)
          .where(
            and(
              eq(safetyTimelineEvents.companyId, companyId),
              opts.accidentId ? eq(safetyTimelineEvents.accidentId, opts.accidentId) : isNull(safetyTimelineEvents.claimId),
            ),
          )
          .orderBy(asc(safetyTimelineEvents.occurredAt))
      : [];

    const byAccident = <T extends { accidentId: string | null }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) if (x.accidentId) m.set(x.accidentId, [...(m.get(x.accidentId) ?? []), x]);
      return m;
    };
    const unitsBy = byAccident(unitRows as AccidentUnitRow[]);
    const restrictedBy = new Map((restrictedRows as AccidentRestrictedRow[]).map((r) => [r.accidentId, r]));
    const testsBy = byAccident(testRows as DrugAlcoholTestRow[]);
    const actionsBy = new Map<string, SafetyReviewRow[]>();
    for (const a of actionRows as SafetyReviewRow[]) {
      const key = a.accidentId ?? a.linkedId;
      if (key) actionsBy.set(key, [...(actionsBy.get(key) ?? []), a]);
    }
    const updatesBy = new Map<string, typeof updateRows>();
    for (const u of updateRows) updatesBy.set(u.taskId, [...(updatesBy.get(u.taskId) ?? []), u]);

    // P4: parties and investigation records of every live case, and the versions of their documents.
    const [vehicleRows, witnessRows, factRows, questionRows, statementRows, factorRows, reviewRows, versionRows] = none
      ? [[], [], [], [], [], [], [], []]
      : await Promise.all([
          db.select().from(accidentOtherVehicles).where(and(eq(accidentOtherVehicles.companyId, companyId), inArray(accidentOtherVehicles.accidentId, ids))).orderBy(asc(accidentOtherVehicles.createdAt)),
          db.select().from(accidentWitnesses).where(and(eq(accidentWitnesses.companyId, companyId), inArray(accidentWitnesses.accidentId, ids))).orderBy(asc(accidentWitnesses.createdAt)),
          db.select().from(accidentFacts).where(and(eq(accidentFacts.companyId, companyId), inArray(accidentFacts.accidentId, ids))).orderBy(asc(accidentFacts.createdAt)),
          db.select().from(accidentQuestions).where(and(eq(accidentQuestions.companyId, companyId), inArray(accidentQuestions.accidentId, ids))).orderBy(asc(accidentQuestions.createdAt)),
          db.select().from(accidentStatements).where(and(eq(accidentStatements.companyId, companyId), inArray(accidentStatements.accidentId, ids))).orderBy(asc(accidentStatements.takenAt)),
          db.select().from(accidentFactors).where(and(eq(accidentFactors.companyId, companyId), inArray(accidentFactors.accidentId, ids))).orderBy(asc(accidentFactors.createdAt)),
          db.select().from(accidentReviewItems).where(and(eq(accidentReviewItems.companyId, companyId), inArray(accidentReviewItems.accidentId, ids))).orderBy(asc(accidentReviewItems.sort)),
          docRows.length ? db.select().from(safetyDocumentVersions).where(and(eq(safetyDocumentVersions.companyId, companyId), inArray(safetyDocumentVersions.documentId, docRows.map((d) => d.id)))) : [],
        ]);
    const inv = (id: string) => ({
      vehicles: vehicleRows.filter((x) => x.accidentId === id),
      witnesses: witnessRows.filter((x) => x.accidentId === id),
      facts: factRows.filter((x) => x.accidentId === id),
      questions: questionRows.filter((x) => x.accidentId === id),
      statements: statementRows.filter((x) => x.accidentId === id),
      factors: factorRows.filter((x) => x.accidentId === id),
      review: reviewRows.filter((x) => x.accidentId === id),
    });
    const cases = accidentRows.map((row) =>
      caseOf({ row, units: unitsBy.get(row.id) ?? [], restricted: restrictedBy.get(row.id), tests: testsBy.get(row.id) ?? [], actions: actionsBy.get(row.id) ?? [], inv: inv(row.id) }),
    );
    const liveIds = new Set(ids);
    const liveClaimIds = new Set(claimIds);
    const tasks = (taskRows as SafetyTaskRow[])
      .filter((t) => (!t.accidentId || liveIds.has(t.accidentId)) && (!t.claimId || liveClaimIds.has(t.claimId)))
      .map((t) => taskOf(t, updatesBy.get(t.id) ?? []));
    const group = <T extends { claimId: string }>(xs: T[]) => {
      const m = new Map<string, T[]>();
      for (const x of xs) m.set(x.claimId, [...(m.get(x.claimId) ?? []), x]);
      return m;
    };
    const paymentsBy = group(paymentRows);
    const docsBy = group(claimDocRows);
    const logBy = group(claimLogRows);
    // A claim linked to a voided case keeps its row but leaves the case's ledger (the case is gone from every view).
    const claims = claimRows.map((k) =>
      claimOf({
        row: k,
        payments: paymentsBy.get(k.id) ?? [],
        docs: docsBy.get(k.id) ?? [],
        log: logBy.get(k.id) ?? [],
        liveAccident: !k.accidentId || liveIds.has(k.accidentId),
        legacy: legacyClaimView(k, firstLineBy.get(k.id), Boolean(k.accidentId && injuredIds.has(k.accidentId))),
      }),
    );
    // Work orders (P3): every one linked to a live case, plus accident repairs nobody linked to a case (attention).
    const woRows = await db
      .select()
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          isNull(workOrders.voidedAt),
          or(isNotNull(workOrders.accidentId), and(eq(workOrders.workType, 'accident_repair'), eq(workOrders.historic, false))),
        ),
      )
      .orderBy(asc(workOrders.createdAt));
    const woIds = woRows.map((w) => w.id);
    const [estimateRows, billRows] = await Promise.all([
      woIds.length ? db.select().from(workOrderEstimates).where(and(eq(workOrderEstimates.companyId, companyId), inArray(workOrderEstimates.workOrderId, woIds))).orderBy(asc(workOrderEstimates.receivedAt)) : [],
      db
        .select()
        .from(acctBills)
        .where(
          and(
            eq(acctBills.companyId, companyId),
            or(isNotNull(acctBills.accidentId), isNotNull(acctBills.claimId), woIds.length ? inArray(acctBills.sourceKey, woIds.map((w) => `repair_order:${w}`)) : sql`false`),
          ),
        )
        .orderBy(asc(acctBills.createdAt)),
    ]);
    const statusRows = await db.select().from(unitStatusHistory).where(and(eq(unitStatusHistory.companyId, companyId), isNull(unitStatusHistory.until)));
    const liveBills = billRows.filter((b) => !VOID_BILL.has(String((b.record as { status?: string })?.status ?? b.status)));
    const woById = new Map(woRows.map((w) => [w.id, w]));
    const billByWo = new Map<string, string>();
    for (const b of liveBills) if (b.sourceKey.startsWith('repair_order:')) billByWo.set(b.sourceKey.slice('repair_order:'.length), b.id);
    const workOrderList = woRows
      .filter((w) => !w.accidentId || liveIds.has(w.accidentId))
      .map((w) => workOrderOf(w, estimateRows.filter((e) => e.workOrderId === w.id), billByWo.get(w.id), settings.rules));
    const bills = liveBills.map((b) => billOf(b, woById)).filter((b) => !b.caseId || liveIds.has(b.caseId));
    const downtime = (downtimeRows as DowntimePeriodRow[]).map(downtimeOf);
    const evidence = docRows.map((d) => evidenceOf(d, versionRows.filter((v) => v.documentId === d.id)));
    const events = eventRows.map(eventOf);

    // People, drivers, units and loads: the roster where it has them, the case's own denormalised names otherwise.
    const [people, peopleDept] = await this.people(companyId, accidentRows, taskRows as SafetyTaskRow[], actionRows as SafetyReviewRow[], claimRows);
    const driverIds = [...new Set(accidentRows.map((r) => r.driverId).filter((x): x is string => Boolean(x)))];
    const truckIds = [...new Set([...accidentRows.map((r) => r.truckId), ...woRows.filter((w) => w.assetType === 'truck').map((w) => w.unitId)].filter((x): x is string => Boolean(x)))];
    const trailerIds = [...new Set([...accidentRows.map((r) => r.trailerId), ...woRows.filter((w) => w.assetType !== 'truck').map((w) => w.unitId)].filter((x): x is string => Boolean(x)))];
    const loadIds = [...new Set(accidentRows.map((r) => r.loadId).filter((x): x is string => Boolean(x)))];
    const [driverRows, truckRows, trailerRows, loadInfo] = await Promise.all([
      driverIds.length
        ? db.select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName }).from(drivers).where(and(eq(drivers.companyId, companyId), inArray(drivers.id, driverIds)))
        : [],
      truckIds.length
        ? db.select({ id: trucks.id, unit: trucks.unitNumber, status: trucks.status, contribution: trucks.dailyContributionCents }).from(trucks).where(and(eq(trucks.companyId, companyId), inArray(trucks.id, truckIds)))
        : [],
      trailerIds.length
        ? db.select({ id: trailers.id, unit: trailers.unitNumber }).from(trailers).where(and(eq(trailers.companyId, companyId), inArray(trailers.id, trailerIds)))
        : [],
      this.loadInfo(companyId, loadIds),
    ]);
    const driverList = new Map<string, R.Driver>();
    for (const d of driverRows) driverList.set(d.id, driverStub(d.id, `${d.first} ${d.last}`.trim()));
    const truckList = new Map<string, R.Truck>();
    for (const t of truckRows) truckList.set(t.id, { ...truckStub(t.id, t.unit), dailyContributionCents: t.contribution ?? null });
    const trailerList = new Map<string, R.Trailer>();
    for (const t of trailerRows) trailerList.set(t.id, trailerStub(t.id, t.unit));
    const loadList = new Map<string, R.Load>();
    for (const l of loadInfo.values()) loadList.set(l.id, loadStub(l));
    for (const r of accidentRows) {
      if (r.driverId && !driverList.has(r.driverId)) driverList.set(r.driverId, driverStub(r.driverId, r.driverName ?? 'Driver'));
      if (r.truckId && !truckList.has(r.truckId)) truckList.set(r.truckId, truckStub(r.truckId, r.truckNumber ?? '?'));
      if (r.trailerId && !trailerList.has(r.trailerId)) trailerList.set(r.trailerId, trailerStub(r.trailerId, r.trailerNumber ?? '?'));
      if (r.loadId && !loadList.has(r.loadId)) {
        const info: LoadInfo = { id: r.loadId, number: r.loadNumber ?? '?', truckId: r.truckId, customer: null, broker: null, commodity: null, origin: null, destination: null, hazmat: null };
        loadInfo.set(r.loadId, info);
        loadList.set(r.loadId, loadStub(info));
      }
    }

    for (const w of woRows) {
      if (w.assetType === 'truck' && !truckList.has(w.unitId)) truckList.set(w.unitId, truckStub(w.unitId, w.unitNumber || '?'));
      if (w.assetType !== 'truck' && !trailerList.has(w.unitId)) trailerList.set(w.unitId, trailerStub(w.unitId, w.unitNumber || '?'));
    }

    const all: R.SafetyRulesState = {
      people,
      drivers: [...driverList.values()],
      trucks: [...truckList.values()],
      trailers: [...trailerList.values()],
      loads: [...loadList.values()],
      assignments: [],
      cases,
      claims,
      tasks,
      evidence,
      events,
      workOrders: workOrderList,
      bills,
      downtime,
      mileage: [],
    };
    const testIds = new Set(cases.filter((c) => c.isTest).map((c) => c.id));
    const live: R.SafetyRulesState = {
      ...all,
      cases: cases.filter((c) => !c.isTest),
      claims: claims.filter((k) => !k.isTest && (!k.caseId || !testIds.has(k.caseId))),
      tasks: tasks.filter((t) => !t.caseId || !testIds.has(t.caseId)),
      workOrders: workOrderList.filter((w) => !w.caseId || !testIds.has(w.caseId)),
      bills: bills.filter((b) => !b.caseId || !testIds.has(b.caseId)),
      downtime: downtime.filter((d) => !testIds.has(d.caseId)),
      evidence: evidence.filter((e) => !e.caseId || !testIds.has(e.caseId)),
      events: events.filter((e) => !e.caseId || !testIds.has(e.caseId)),
    };
    return {
      all,
      live,
      rows: new Map(accidentRows.map((r) => [r.id, r])),
      units: unitsBy,
      taskRows: new Map((taskRows as SafetyTaskRow[]).map((t) => [t.id, t])),
      claimRows: new Map(claimRows.map((k) => [k.id, k])),
      woRows: woById,
      actionRows: actionsBy,
      unitStatus: statusRows,
      billRows: new Map(liveBills.map((b) => [b.id, b])),
      downtimeRows: downtimeRows as DowntimePeriodRow[],
      settings: settings.rules,
      deptAssignees: settings.deptAssignees,
      peopleDept,
      loadInfo,
    };
  }

  /** Company members by name (with a department from their role), plus every name a case or task carries. */
  private async people(
    companyId: string,
    accidentRows: SafetyAccidentRow[],
    taskRows: SafetyTaskRow[],
    actionRows: SafetyReviewRow[],
    claimRows: SafetyClaimRow[] = [],
  ): Promise<[R.Person[], Map<string, R.Dept | null>]> {
    const rows = await this.db
      .select({ id: users.id, first: users.firstName, last: users.lastName, role: roles.code })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(eq(memberships.companyId, companyId));
    const out = new Map<string, R.Person>();
    const dept = new Map<string, R.Dept | null>();
    for (const r of rows) {
      const name = `${r.first} ${r.last}`.trim();
      const d = r.role ? (ROLE_DEPT[r.role] ?? null) : null;
      if (!out.has(r.id)) out.set(r.id, personStub(r.id, name, d ?? 'Safety'));
      if (d && !dept.get(r.id)) dept.set(r.id, d);
      else if (!dept.has(r.id)) dept.set(r.id, null);
    }
    const add = (id: string | null | undefined, name: string | null | undefined) => {
      if (id && !out.has(id)) out.set(id, personStub(id, name || id, 'Safety'));
    };
    for (const a of accidentRows) {
      add(a.ownerId, a.ownerName);
      // "By" fields store the actor's name (the legacy convention); a name resolves to itself.
      add(a.closedBy, a.closedBy);
      add(a.createdBy, a.createdBy);
      add(a.investigationOwnerId, a.investigationOwnerId);
    }
    for (const t of taskRows) {
      add(t.assigneeId, t.assigneeName);
      add(t.createdBy, t.createdBy);
      add(t.completedBy, t.completedBy);
    }
    for (const a of actionRows) add(a.assigneeId, a.assigneeName);
    for (const k of claimRows) {
      add(k.ownerId, k.ownerName);
      add(k.nextFollowUpAssigneeId, k.nextFollowUpAssigneeName);
    }
    return [[...out.values()], dept];
  }

  async loadInfo(companyId: string, ids: string[]): Promise<Map<string, LoadInfo>> {
    const out = new Map<string, LoadInfo>();
    if (!ids.length) return out;
    const rows = await this.db
      .select({ id: loads.id, number: loads.loadNumber, truckId: loads.truckId, record: loads.record })
      .from(loads)
      .where(and(eq(loads.companyId, companyId), inArray(loads.id, ids)));
    for (const r of rows) out.set(r.id, loadInfoOf(r));
    return out;
  }
}

/** A load's display facts from its record (broker, customer, lane, hazmat). */
export function loadInfoOf(r: { id: string; number: string; truckId: string | null; record: unknown }): LoadInfo {
  const rec = (r.record ?? {}) as {
    customerName?: string | null;
    brokerName?: string | null;
    commodity?: string | null;
    hazmat?: boolean | null;
    stops?: { kind?: string; city?: string | null; state?: string | null }[];
  };
  const stops = Array.isArray(rec.stops) ? rec.stops : [];
  const place = (s?: { city?: string | null; state?: string | null }) => (s && (s.city || s.state) ? [s.city, s.state].filter(Boolean).join(', ') : null);
  const pickup = stops.find((s) => s.kind === 'pickup');
  const delivery = [...stops].reverse().find((s) => s.kind === 'delivery');
  return {
    id: r.id,
    number: r.number,
    truckId: r.truckId,
    customer: rec.customerName ?? null,
    broker: rec.brokerName ?? null,
    commodity: rec.commodity ?? null,
    origin: place(pickup),
    destination: place(delivery),
    hazmat: typeof rec.hazmat === 'boolean' ? rec.hazmat : null,
  };
}

const initials = (name: string) => R.initials(name);
function personStub(id: string, name: string, dept: R.Dept): R.Person {
  return { id, name, title: '', dept, initials: initials(name), base: 'US', role: 'safety_specialist' };
}
function driverStub(id: string, name: string): R.Driver {
  return { id, name, type: 'Company driver', hired: '', phone: '', terminal: '', cdlState: '' };
}
function truckStub(id: string, unit: string): R.Truck {
  return { id, unit, year: 0, make: '', model: '', vinTail: '', status: 'Available', location: '' };
}
function trailerStub(id: string, unit: string): R.Trailer {
  return { id, unit, year: 0, make: '', status: 'Available', location: '' };
}
function loadStub(l: LoadInfo): R.Load {
  return {
    id: l.id,
    number: l.number,
    customer: l.customer ?? '',
    ...(l.broker ? { broker: l.broker } : {}),
    commodity: l.commodity ?? '',
    valueCents: 0,
    weightLbs: 0,
    origin: l.origin ?? '',
    destination: l.destination ?? '',
    pickupAt: '',
    deliveryDue: '',
    status: 'In transit',
    ...(l.truckId ? { truckId: l.truckId } : {}),
    hazmat: l.hazmat,
  };
}
