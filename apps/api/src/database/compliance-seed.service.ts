import { Inject, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { Rng, buildComplianceSeed, type ComplianceAuditEntry } from '@neway/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../common/auth/principal';
import { CLOCK, type Clock } from '../modules/dashboard/clock';
import { AuditService } from '../modules/people/audit.service';
import { DatabaseService } from './database.service';
import {
  complianceDocuments,
  consentEvents,
  consentRequests,
  qualificationItems,
  verificationCases,
} from './schema/compliance';
import { drivers } from './schema/roster';
import { ROSTER_SEED } from './seed/roster.seed';
import { STAFF_SEED } from './seed/staff.seed';
import { TRAILER_SEED } from './seed/trailers.seed';

/** The seed the browser demo used; kept so the persisted file is the one people have been looking at. */
const COMPLIANCE_SEED = 7;

/**
 * Builds the qualification file for the fleet this carrier already runs.
 *
 * For a year this ran in the browser on every page load. Moving it here is a migration of the
 * records people have been working with, not an invention of new ones: the same generator, the
 * same seed, the same driver and unit ids, so `qi_0001` is still the CDL of the same driver.
 *
 * Runs once, conditional on the table being empty, and is never an upsert. A document verified
 * yesterday must not be un-verified by tonight's restart.
 */
@Injectable()
export class ComplianceSeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(ComplianceSeedService.name);
  }

  private get db() {
    return this.database.db;
  }

  async seed(): Promise<{ seeded: boolean; items: number; cases: number }> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(qualificationItems)
      .where(eq(qualificationItems.companyId, companyId));
    if ((existing?.value ?? 0) > 0) {
      this.logger.info({ items: existing?.value }, 'Qualification file already present');
      return { seeded: false, items: existing?.value ?? 0, cases: 0 };
    }

    const out = buildComplianceSeed(new Rng(COMPLIANCE_SEED), {
      drivers: ROSTER_SEED.drivers.map((d) => ({
        id: d.id,
        driverNumber: d.driverNumber,
        firstName: d.firstName,
        name: `${d.firstName} ${d.lastName}`,
        hireDate: d.hireDate,
        cdlStatus: d.cdlStatus,
        cdlExpiresOn: d.cdlExpiresOn,
        medicalCardStatus: d.medicalCardStatus,
        medicalCardExpiresOn: d.medicalCardExpiresOn,
      })),
      // A unit with no in-service date yet has nothing to seed a document from.
      trucks: ROSTER_SEED.trucks.flatMap((t) =>
        t.inServiceDate
          ? [
              {
                id: t.id,
                unitNumber: t.unitNumber,
                status: t.status,
                inServiceDate: t.inServiceDate,
              },
            ]
          : [],
      ),
      trailers: TRAILER_SEED,
      people: STAFF_SEED.map((s) => ({
        id: s.userId,
        name: `${s.firstName} ${s.lastName}`,
        department: s.department,
      })),
      now: this.clock(),
    });

    await this.db.transaction(async (tx) => {
      await tx.insert(complianceDocuments).values(
        out.documents.map((d) => ({
          id: d.id,
          companyId,
          ownerType: d.ownerType,
          ownerId: d.ownerId,
          ownerLabel: d.ownerLabel,
          requirementCode: d.requirementCode,
          title: d.title,
          fileName: d.fileName,
          contentType: d.contentType,
          sizeBytes: d.sizeBytes,
          issuedOn: d.issuedOn,
          expiresOn: d.expiresOn,
          status: d.status,
          source: d.source,
          uploadedAt: new Date(d.uploadedAt),
          uploadedBy: d.uploadedBy,
          verifiedAt: d.verifiedAt ? new Date(d.verifiedAt) : null,
          verifiedBy: d.verifiedBy,
          rejectionReason: d.rejectionReason,
          version: d.version,
          supersedesDocumentId: d.supersedesDocumentId,
          containsPii: d.containsPii,
        })),
      );
      await tx.insert(qualificationItems).values(
        out.items.map((i) => ({
          id: i.id,
          companyId,
          requirementCode: i.requirementCode,
          scope: i.scope,
          entityId: i.entityId,
          entityLabel: i.entityLabel,
          documentId: i.documentId,
          issuedOn: i.issuedOn,
          expiresOn: i.expiresOn,
          verifiedAt: i.verifiedAt ? new Date(i.verifiedAt) : null,
          verifiedBy: i.verifiedBy,
          verificationFailed: i.verificationFailed,
          verificationNote: i.verificationNote,
          waivedUntil: i.waivedUntil,
          waivedReason: i.waivedReason,
          notApplicable: i.notApplicable,
          notes: i.notes,
        })),
      );
      await tx.insert(consentRequests).values(
        out.consents.map((c) => ({
          id: c.id,
          companyId,
          driverId: c.driverId,
          driverName: c.driverName,
          purpose: c.purpose,
          requirementCode: c.requirementCode,
          status: c.status,
          requestedAt: new Date(c.requestedAt),
          requestedBy: c.requestedBy,
          sentAt: c.sentAt ? new Date(c.sentAt) : null,
          viewedAt: c.viewedAt ? new Date(c.viewedAt) : null,
          signedAt: c.signedAt ? new Date(c.signedAt) : null,
          declinedAt: c.declinedAt ? new Date(c.declinedAt) : null,
          expiresAt: new Date(c.expiresAt),
          signerName: c.signerName,
          signerChannel: c.signerChannel,
          signedDocumentId: c.signedDocumentId,
        })),
      );
      const events = out.consents.flatMap((c) =>
        c.history.map((h, index) => ({
          id: `cev_${c.id.slice(4)}_${index + 1}`,
          consentRequestId: c.id,
          at: new Date(h.at),
          status: h.status,
          actor: h.actor,
          note: h.note,
          sortOrder: index + 1,
        })),
      );
      for (let i = 0; i < events.length; i += 500) {
        await tx.insert(consentEvents).values(events.slice(i, i + 500));
      }
      if (out.caseRecords.length > 0) {
        await tx.insert(verificationCases).values(
          out.caseRecords.map((c) => ({
            id: c.id,
            companyId,
            driverId: c.driverId,
            driverName: c.driverName,
            openedAt: new Date(c.openedAt),
            ownerId: c.ownerId,
            ownerName: c.ownerName,
            safetyReviewStatus: c.safetyReviewStatus,
            safetyReviewAt: c.safetyReviewAt ? new Date(c.safetyReviewAt) : null,
            safetyReviewBy: c.safetyReviewBy,
            decision: c.decision,
            decisionAt: c.decisionAt ? new Date(c.decisionAt) : null,
            decisionBy: c.decisionBy,
            conditions: c.conditions,
            decisionNote: c.decisionNote,
          })),
        );
      }
    });

    // History into the one audit trail, oldest first, with the timestamps it actually carries.
    const principal: Principal = {
      userId: 'system',
      userName: 'System import',
      companyId,
      companyTimezone: ROSTER_SEED.company.timezone,
      weekStart: 1,
      roles: [],
      permissions: new Set(),
    };
    const oldestFirst = [...out.audit].reverse();
    for (const entry of oldestFirst) await this.writeAudit(principal, entry);

    this.logger.info(
      {
        items: out.items.length,
        documents: out.documents.length,
        consents: out.consents.length,
        cases: out.caseRecords.length,
        audit: out.audit.length,
      },
      'Qualification file built from the fleet',
    );
    return { seeded: true, items: out.items.length, cases: out.caseRecords.length };
  }

  /**
   * The DOT application became a requirement after the file was seeded. Every driver already on
   * a roster was hired, so an application was accepted for them; it is on the paper file, and
   * this system does not hold a PDF of it. The backfilled item says exactly that, is verified at
   * the case's opening (or the hire date), and is the only reason a veteran does not read
   * `missing` for a rule that did not exist when they were hired.
   *
   * Runs on every boot, inserts only what is absent, touches no other row. Reversible with
   * `delete from qualification_items where requirement_code = 'dot_application' and notes like
   * 'Backfilled%'`.
   */
  async backfillDotApplicationItems(): Promise<number> {
    const missing = await this.db
      .select({
        id: drivers.id,
        companyId: drivers.companyId,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
        hireDate: drivers.hireDate,
        openedAt: verificationCases.openedAt,
      })
      .from(drivers)
      .leftJoin(
        qualificationItems,
        and(
          eq(qualificationItems.companyId, drivers.companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, drivers.id),
          eq(qualificationItems.requirementCode, 'dot_application'),
        ),
      )
      .leftJoin(
        verificationCases,
        and(
          eq(verificationCases.companyId, drivers.companyId),
          eq(verificationCases.driverId, drivers.id),
        ),
      )
      .where(isNull(qualificationItems.id));
    if (missing.length === 0) return 0;
    const now = new Date();
    await this.db.insert(qualificationItems).values(
      missing.map((d) => ({
        id: `qi_${crypto.randomUUID()}`,
        companyId: d.companyId,
        requirementCode: 'dot_application',
        scope: 'driver',
        entityId: d.id,
        entityLabel: `${d.firstName} ${d.lastName}`,
        documentId: null,
        issuedOn: d.hireDate,
        expiresOn: null,
        verifiedAt: d.openedAt ?? new Date(`${d.hireDate}T09:00:00Z`),
        verifiedBy: 'Requirement backfill',
        notes:
          'Backfilled when the DOT application requirement was introduced: accepted at hire and held on the paper file. This system has no PDF of it.',
        createdAt: now,
        updatedAt: now,
      })),
    );
    this.logger.info(
      { items: missing.length },
      'DOT application items backfilled for hired drivers',
    );
    return missing.length + (await this.backfillRoadTestItems());
  }

  /**
   * The road test requirement arrived with the hiring funnel. Every driver on a roster holds a
   * CDL, which 391.33 lets a carrier accept in lieu of the test — so the backfilled item is
   * "not applicable" with that reason, which is what the seed generator also produces for a
   * fresh database. Idempotent; reversible by deleting rows with this note.
   */
  private async backfillRoadTestItems(): Promise<number> {
    const missing = await this.db
      .select({
        id: drivers.id,
        companyId: drivers.companyId,
        firstName: drivers.firstName,
        lastName: drivers.lastName,
      })
      .from(drivers)
      .leftJoin(
        qualificationItems,
        and(
          eq(qualificationItems.companyId, drivers.companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, drivers.id),
          eq(qualificationItems.requirementCode, 'road_test'),
        ),
      )
      .where(isNull(qualificationItems.id));
    if (missing.length === 0) return 0;
    const now = new Date();
    await this.db.insert(qualificationItems).values(
      missing.map((d) => ({
        id: `qi_${crypto.randomUUID()}`,
        companyId: d.companyId,
        requirementCode: 'road_test',
        scope: 'driver',
        entityId: d.id,
        entityLabel: `${d.firstName} ${d.lastName}`,
        documentId: null,
        notApplicable: true,
        notes: 'Backfilled: CDL accepted in lieu of a road test (49 CFR 391.33)',
        createdAt: now,
        updatedAt: now,
      })),
    );
    this.logger.info({ items: missing.length }, 'Road test items backfilled as CDL-in-lieu');
    return missing.length;
  }

  private async writeAudit(principal: Principal, entry: ComplianceAuditEntry): Promise<void> {
    await this.audit.write(principal, {
      action: entry.action,
      entityType: entry.entity.type,
      entityId: entry.entity.id,
      entityLabel: entry.entity.label,
      summary: entry.subject
        ? `${entry.subject.replace(/_/g, ' ')}: ${entry.after ?? entry.action.replace(/_/g, ' ')}`
        : `${entry.action.replace(/_/g, ' ')}: ${entry.after ?? ''}`.trim(),
      changes: entry.subject
        ? [{ field: entry.subject, old: entry.before, new: entry.after }]
        : [{ field: 'status', old: entry.before, new: entry.after }],
      reason: entry.reason,
      actorType: entry.source === 'system' ? 'system' : 'user',
      actor: { id: entry.actorId, name: entry.actorName },
      at: new Date(entry.at),
    });
  }
}
