import { Injectable } from '@nestjs/common';
import { and, eq, isNotNull, isNull } from 'drizzle-orm';
import {
  DRUG_ALCOHOL_TEST_TYPES,
  SYSTEM_REQUIREMENTS,
  evaluateItem,
  requirementsFor,
  type CompanyChecklistRow,
  type ComplianceCell,
  type DriverComplianceColumn,
  type DriverComplianceRow,
  type DriverComplianceView,
  type DrugAlcoholTestType,
  type QualificationItem,
  type QualificationRequirement,
  type TestingSummary,
  type UnitComplianceRow,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { qualificationItems } from '../../database/schema/compliance';
import { trailers } from '../../database/schema/fleet';
import { hiringCases } from '../../database/schema/hiring';
import { drivers, trucks } from '../../database/schema/roster';
import { drugAlcoholTests } from '../../database/schema/safety';
import { ComplianceService } from '../compliance/compliance.service';
import { SafetyCoreService } from './safety-core.service';
import { DrugTestsService } from './tests.service';

/** The grid's columns and the requirement each one reads. */
const DRIVER_COLUMN_REQUIREMENT: Record<DriverComplianceColumn, string> = {
  cdl: 'cdl',
  medical_card: 'medical_card',
  mvr_review: 'mvr_review',
  clearinghouse_query: 'clearinghouse_query',
  // The testing programme column reads the pre-employment test the recruiting file already
  // carries; random-pool enrolment is not a record this system holds yet.
  testing_program: 'pre_employment_drug_test',
};

/**
 * Compliance, read through the engine.
 *
 * Every chip is `evaluateItem` over the qualification item on file and the server's Eastern
 * today — the same function the compliance workbench and dispatch run, so the three cannot
 * disagree. Nothing here is hand-ticked: the company checklist turns green when its document is
 * on file and verified, not when somebody clicks a box.
 */
@Injectable()
export class ComplianceViewService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly compliance: ComplianceService,
    private readonly tests: DrugTestsService,
  ) {}

  private get db() {
    return this.core.db;
  }

  private async itemsByEntity(companyId: string, scope: string): Promise<Map<string, Map<string, QualificationItem>>> {
    // With each document's upload time: an MVR or PSP without a report date ages from it.
    const rows = await this.compliance.itemsWhere(
      and(eq(qualificationItems.companyId, companyId), eq(qualificationItems.scope, scope)),
    );
    const out = new Map<string, Map<string, QualificationItem>>();
    for (const item of rows) {
      const byCode = out.get(item.entityId) ?? new Map<string, QualificationItem>();
      byCode.set(item.requirementCode, item);
      out.set(item.entityId, byCode);
    }
    return out;
  }

  private cell(requirement: QualificationRequirement | undefined, item: QualificationItem | null, entity: { id: string; label: string }, today: string): ComplianceCell {
    if (!requirement) return { status: 'unknown', date: null };
    const evaluated = evaluateItem(requirement, item, entity, { today });
    return {
      status: evaluated.status,
      date: evaluated.expiresOn ?? (item?.verifiedAt ? item.verifiedAt.slice(0, 10) : (item?.issuedOn ?? null)),
    };
  }

  /** Every roster driver, then every candidate in hiring with a reserved driver id. */
  async drivers(principal: Principal): Promise<DriverComplianceView> {
    const today = this.core.today();
    const byCode = new Map(SYSTEM_REQUIREMENTS.map((r) => [r.code, r]));
    const [roster, hiring, items] = await Promise.all([
      this.db
        .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName })
        .from(drivers)
        .where(and(eq(drivers.companyId, principal.companyId), isNull(drivers.archivedAt))),
      this.db
        .select({ driverId: hiringCases.driverId, name: hiringCases.candidateName })
        .from(hiringCases)
        .where(
          and(
            eq(hiringCases.companyId, principal.companyId),
            eq(hiringCases.isTest, false),
            isNotNull(hiringCases.driverId),
            isNull(hiringCases.closedAt),
          ),
        ),
      this.itemsByEntity(principal.companyId, 'driver'),
    ]);
    const onRoster = new Set(roster.map((d) => d.id));
    const rows: DriverComplianceRow[] = [];
    const build = (id: string, name: string, group: DriverComplianceRow['group']) => {
      const mine = items.get(id) ?? new Map<string, QualificationItem>();
      const cells = {} as Record<DriverComplianceColumn, ComplianceCell>;
      for (const [column, code] of Object.entries(DRIVER_COLUMN_REQUIREMENT) as [DriverComplianceColumn, string][]) {
        cells[column] = this.cell(byCode.get(code), mine.get(code) ?? null, { id, label: name }, today);
      }
      rows.push({ driverId: id, driverName: name, group, cells });
    };
    for (const d of roster.sort((a, b) => `${a.first} ${a.last}`.localeCompare(`${b.first} ${b.last}`))) build(d.id, `${d.first} ${d.last}`.trim(), 'roster');
    const seen = new Set<string>();
    for (const h of hiring.sort((a, b) => a.name.localeCompare(b.name))) {
      // Hired (on the roster) or listed already: a candidate appears once, in one group.
      if (!h.driverId || onRoster.has(h.driverId) || seen.has(h.driverId)) continue;
      seen.add(h.driverId);
      build(h.driverId, h.name, 'in_hiring');
    }
    const totals = { expired: 0, dueSoon: 0, missing: 0 };
    for (const row of rows) {
      for (const c of Object.values(row.cells)) {
        if (c.status === 'expired' || c.status === 'verification_failed') totals.expired += 1;
        else if (c.status === 'expiring') totals.dueSoon += 1;
        else if (c.status === 'missing') totals.missing += 1;
      }
    }
    return { today, totals, rows };
  }

  /** Trucks and trailers against their own requirements (registration, annual inspection, …). */
  async vehicles(principal: Principal): Promise<UnitComplianceRow[]> {
    const today = this.core.today();
    const [truckRows, trailerRows, truckItems, trailerItems] = await Promise.all([
      this.db.select({ id: trucks.id, number: trucks.unitNumber, status: trucks.status }).from(trucks).where(eq(trucks.companyId, principal.companyId)),
      this.db.select({ id: trailers.id, number: trailers.unitNumber, status: trailers.status }).from(trailers).where(eq(trailers.companyId, principal.companyId)),
      this.itemsByEntity(principal.companyId, 'truck'),
      this.itemsByEntity(principal.companyId, 'trailer'),
    ]);
    const out: UnitComplianceRow[] = [];
    const unit = (scope: 'truck' | 'trailer', id: string, number: string, items: Map<string, QualificationItem> | undefined) => {
      out.push({
        unitId: id,
        unitNumber: number,
        scope,
        cells: requirementsFor(scope).map((r) => ({
          code: r.code,
          name: r.name,
          ...this.cell(r, items?.get(r.code) ?? null, { id, label: number }, today),
        })),
      });
    };
    for (const t of truckRows.filter((t) => !['sold', 'inactive', 'archived'].includes(t.status)).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))) {
      unit('truck', t.id, t.number, truckItems.get(t.id));
    }
    for (const t of trailerRows.filter((t) => !['sold', 'inactive', 'archived'].includes(t.status)).sort((a, b) => a.number.localeCompare(b.number, undefined, { numeric: true }))) {
      unit('trailer', t.id, t.number, trailerItems.get(t.id));
    }
    return out;
  }

  /** The carrier's own checklist: derived from the company's documents, never hand-ticked. */
  async company(principal: Principal): Promise<CompanyChecklistRow[]> {
    const today = this.core.today();
    const items = (await this.itemsByEntity(principal.companyId, 'company')).get(principal.companyId);
    return requirementsFor('company').map((r) => {
      const item = items?.get(r.code) ?? null;
      const evaluated = evaluateItem(r, item, { id: principal.companyId, label: 'Company' }, { today });
      return {
        code: r.code,
        name: r.name,
        authority: r.authority ?? '',
        status: evaluated.status,
        expiresOn: evaluated.expiresOn,
        documentId: item?.documentId ?? null,
      };
    });
  }

  /** Testing & Clearinghouse: counts by test type. Results never leave the server here. */
  async testing(principal: Principal): Promise<TestingSummary> {
    const [tests, preEmployment, roster] = await Promise.all([
      this.db
        .select()
        .from(drugAlcoholTests)
        .where(and(eq(drugAlcoholTests.companyId, principal.companyId), isNull(drugAlcoholTests.voidedAt), eq(drugAlcoholTests.isTest, false))),
      this.db
        .select({ entityId: qualificationItems.entityId, documentId: qualificationItems.documentId })
        .from(qualificationItems)
        .where(and(eq(qualificationItems.companyId, principal.companyId), eq(qualificationItems.requirementCode, 'pre_employment_drug_test'))),
      this.db.select({ id: drivers.id }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), isNull(drivers.archivedAt))),
    ]);
    const rows = DRUG_ALCOHOL_TEST_TYPES.map((testType) => {
      const mine = tests.filter((t) => t.testType === testType);
      return {
        testType: testType as DrugAlcoholTestType,
        openTasks: mine.filter((t) => !this.tests.rawStatus(t).resolved).length,
        restrictedRecords: mine.filter((t) => t.result !== 'pending' || t.notCompletedReason).length,
      };
    });
    const withDoc = new Set(preEmployment.filter((p) => p.documentId).map((p) => p.entityId));
    const onFile = roster.filter((d) => withDoc.has(d.id)).length;
    return { rows, preEmploymentFromQualificationFile: { onFile, missing: roster.length - onFile } };
  }
}
