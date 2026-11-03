import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, notInArray, or, type SQL } from 'drizzle-orm';
import {
  groupViolationCases,
  ROADSIDE_NEXT_ACTION,
  ROADSIDE_STAGES,
  ROADSIDE_STAGE_LABEL,
  roadsideFinalStage,
  roadsideStatus,
  violationNextAction,
  violationOpenTracks,
  type CitationDisposition,
  type CorrectionStatus,
  type CreateRoadsideInspectionInput,
  type CreateViolationCaseInput,
  type CreateViolationInput,
  type DataqsStatus,
  type LinkWorkOrderInput,
  type RoadsideStage,
  type RoadsideStageInput,
  type RoadsideViolationInput,
  type SafetyCaseDetail,
  type SafetyRoadsideInspection,
  type SafetyViolation,
  type SafetyViolationCase,
  type UpdateRoadsideInspectionInput,
  type UpdateViolationInput,
  type VersionOnlyInput,
  type ViolationCategory,
  type ViolationFollowupChoice,
  type ViolationMoneyInput,
  type ViolationNote,
  type ViolationNoteInput,
  type ViolationStatus,
  type ViolationStatusInput,
  type ViolationTrainingInput,
  type ViolationTrainingStatus,
  issuedToLabel,
  parseViolationIssuedTo,
  type ViolationRecordSource,
  type ViolationType,
  type VoidInput,
  type VoidViolationCaseInput,
  type VoidViolationInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import {
  safetyCaseDocuments,
  safetyReviews,
  safetyRoadsideInspections,
  safetyViolations,
  type SafetyReviewRow,
  type SafetyRoadsideRow,
  type SafetyViolationRow,
} from '../../database/schema/safety';
import { DriverAccountsService } from '../accounting/driver-accounts.service';
import { SafetyReviewsService } from './reviews.service';
import { reviewProgress } from './violation-case-merge';
import { SafetyCoreService, baseOf, changesOf, iso } from './safety-core.service';

const STAGE_COLUMN: Record<RoadsideStage, 'receivedAt' | 'reviewedAt' | 'correctedAt' | 'certifiedAt' | 'returnedAt'> = {
  received: 'receivedAt',
  reviewed: 'reviewedAt',
  defects_corrected: 'correctedAt',
  certified: 'certifiedAt',
  returned: 'returnedAt',
};

/**
 * Violations and the roadside inspections they usually come from.
 *
 * A violation keeps three tracks apart, because they end at different times and in different
 * offices: the correction (repair, proof, certification), the citation and its court outcome, and
 * the DataQs challenge. It records who received it (driver or carrier) and which agency issued
 * it. A violation that names a driver opens a driver review, once.
 *
 * A roadside inspection walks received → reviewed → defects corrected → certified → returned (when
 * the agency asked for the report back). Violations recorded on it are ordinary violations that
 * point back at it — the same records seen from both sides, never copies.
 */
@Injectable()
export class ViolationsService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly reviews: SafetyReviewsService,
    private readonly driverAccounts: DriverAccountsService,
  ) {}

  /** Where each charge / bonus stands in Accounting, by transaction id. */
  private async txStates(principal: Principal, rows: SafetyViolationRow[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (!rows.some((r) => r.moneyTxId)) return out;
    for (const t of await this.driverAccounts.allTransactions(principal)) out.set(t.id, t.state);
    return out;
  }

  private get db() {
    return this.core.db;
  }

  // ------------------------------------------------------------------------------- violations

  toViolation(row: SafetyViolationRow, txStates?: Map<string, string>): SafetyViolation {
    const txState = row.moneyTxId ? (txStates?.get(row.moneyTxId) ?? null) : null;
    const tracks = {
      correctionStatus: row.correctionStatus as CorrectionStatus,
      citationDisposition: row.citationDisposition as CitationDisposition,
      dataqsStatus: row.dataqsStatus as DataqsStatus,
    };
    return {
      ...baseOf(row),
      occurredAt: row.occurredAt.toISOString(),
      source: row.source as ViolationRecordSource,
      inspectionId: row.inspectionId,
      inspectionNumber: row.inspectionNumber,
      reportNumber: row.reportNumber,
      code: row.code,
      description: row.description,
      category: row.category as ViolationCategory | null,
      issuedTo: parseViolationIssuedTo(row.issuedTo),
      agency: row.agency,
      violationType: (row.violationType as ViolationType | null) ?? null,
      fineNotApplicable: row.fineNotApplicable,
      driverId: row.driverId,
      driverName: row.driverName,
      truckId: row.truckId,
      truckNumber: row.truckNumber,
      oos: row.oos,
      correctionStatus: tracks.correctionStatus,
      correctionDueOn: row.correctionDueOn,
      correctionNote: row.correctionNote,
      fineCents: row.fineCents,
      courtDate: row.courtDate,
      citationDisposition: tracks.citationDisposition,
      dataqsStatus: tracks.dataqsStatus,
      dataqsFiledOn: row.dataqsFiledOn,
      dataqsReference: row.dataqsReference,
      dataqsNote: row.dataqsNote,
      reviewId: row.reviewId,
      reviewNumber: row.reviewNumber,
      closedAt: iso(row.closedAt),
      closedBy: row.closedBy,
      openTracks: row.closedAt ? [] : violationOpenTracks(tracks),
      citationNumber: row.citationNumber,
      state: row.state,
      inspectionLevel: row.inspectionLevel,
      dispute: row.dispute,
      lawyerName: row.lawyerName,
      lawyerPhone: row.lawyerPhone,
      lawyerFeeCents: row.lawyerFeeCents,
      lawyerPaid: row.lawyerPaid,
      trainingStatus: row.trainingStatus as ViolationTrainingStatus,
      trainingCompletedOn: row.trainingCompletedOn,
      trainerName: row.trainerName,
      trainingProofFileId: row.trainingProofFileId,
      followupStatus: row.followupStatus as SafetyViolation['followupStatus'],
      status: violationStatusOf(row, txState),
      moneyKind: (row.moneyKind as SafetyViolation['moneyKind']) ?? null,
      moneyCents: row.moneyCents,
      moneyParty: (row.moneyParty as SafetyViolation['moneyParty']) ?? null,
      moneyReason: row.moneyReason,
      moneyTxId: row.moneyTxId,
      moneyTxState: txState,
      moneySentAt: iso(row.moneySentAt),
      notes: Array.isArray(row.notes) ? (row.notes as ViolationNote[]) : [],
      caseId: row.caseId,
    };
  }

  async violationRow(companyId: string, id: string): Promise<SafetyViolationRow> {
    const [row] = await this.db
      .select()
      .from(safetyViolations)
      .where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That violation');
    return row;
  }

  async listViolations(principal: Principal, query: { includeVoided?: boolean; inspectionId?: string } = {}): Promise<SafetyViolation[]> {
    const parts = [eq(safetyViolations.companyId, principal.companyId)];
    if (!query.includeVoided) parts.push(isNull(safetyViolations.voidedAt));
    if (query.inspectionId) parts.push(eq(safetyViolations.inspectionId, query.inspectionId));
    const rows = await this.db.select().from(safetyViolations).where(and(...parts)).orderBy(desc(safetyViolations.occurredAt));
    const states = await this.txStates(principal, rows);
    return rows.map((r) => this.toViolation(r, states));
  }

  /** One row per paper (owner, 2026-10-21): violations that share a case come back as one case. */
  async listViolationCases(principal: Principal, query: { includeVoided?: boolean } = {}): Promise<SafetyViolationCase[]> {
    return groupViolationCases(await this.listViolations(principal, query));
  }

  /** One case by its key (the shared case id, or a lone violation's id). */
  async violationCase(principal: Principal, key: string): Promise<SafetyViolationCase> {
    const live = (match: SQL | undefined) =>
      this.db.select().from(safetyViolations).where(and(eq(safetyViolations.companyId, principal.companyId), isNull(safetyViolations.voidedAt), match));
    let rows = await live(or(eq(safetyViolations.caseId, key), eq(safetyViolations.id, key)));
    // The id of one violation on a case opens the whole case.
    const caseId = rows.find((r) => r.caseId)?.caseId;
    if (caseId && caseId !== key) rows = await live(eq(safetyViolations.caseId, caseId));
    const states = await this.txStates(principal, rows);
    const [found] = groupViolationCases(rows.map((r) => this.toViolation(r, states)));
    if (!found) throw this.core.notFound('That violation case');
    return found;
  }

  /**
   * One paper and every violation on it (owner, 2026-10-21): one case, one driver review. Each line
   * is its own violation record; the paper's date, report, state, driver and truck are shared. A
   * fine on the paper is recorded once, on the lead violation.
   */
  async createViolationCase(principal: Principal, input: CreateViolationCaseInput): Promise<SafetyViolationCase> {
    const caseId = input.lines.length > 1 ? this.core.newId('vcs') : null;
    let review: { id: string; number: string } | null = null;
    const created: SafetyViolation[] = [];
    for (const [i, line] of input.lines.entries()) {
      const v = await this.createViolation(
        principal,
        {
          occurredAt: input.occurredAt,
          reportNumber: input.reportNumber ?? null,
          code: line.code ?? null,
          description: line.description,
          category: line.category ?? null,
          issuedTo: input.issuedTo ?? null,
          agency: '',
          violationType: input.violationType ?? null,
          fineNotApplicable: input.fineNotApplicable ?? false,
          fineCents: i === 0 ? (input.fineCents ?? null) : null,
          driverId: input.driverId ?? null,
          truckId: input.truckId ?? null,
          inspectionId: input.inspectionId ?? null,
          oos: line.oos,
          state: input.state ?? null,
          inspectionLevel: input.inspectionLevel ?? null,
          isTest: input.isTest,
        },
        undefined,
        { caseId, review },
      );
      if (!review && v.reviewId && v.reviewNumber) review = { id: v.reviewId, number: v.reviewNumber };
      created.push(v);
    }
    return groupViolationCases(created)[0]!;
  }

  async violationDetail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyViolation>> {
    const row = await this.violationRow(principal.companyId, id);
    const [documents, timeline] = await Promise.all([
      this.core.documents(principal.companyId, 'violation', id),
      this.core.timeline(principal, 'violation', id),
    ]);
    return { record: this.toViolation(row, await this.txStates(principal, [row])), documents, timeline };
  }

  async createViolation(
    principal: Principal,
    input: CreateViolationInput,
    from?: { inspection: SafetyRoadsideRow },
    /** The case this violation joins and the driver review the case already has (owner, 2026-10-21). */
    joining?: { caseId: string | null; review: { id: string; number: string } | null },
  ): Promise<SafetyViolation> {
    const inspection = from?.inspection ?? (input.inspectionId ? await this.inspectionRow(principal.companyId, input.inspectionId) : null);
    if (inspection?.voidedAt) throw this.core.refused(`${inspection.number} is void`);
    const [driver, truck, owner] = await Promise.all([
      input.driverId !== undefined ? this.core.driver(principal.companyId, input.driverId) : Promise.resolve(inspection?.driverId ? { id: inspection.driverId, name: inspection.driverName ?? '' } : null),
      input.truckId !== undefined ? this.core.truck(principal.companyId, input.truckId) : Promise.resolve(inspection?.truckId ? { id: inspection.truckId, number: inspection.truckNumber ?? '' } : null),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    const correctionStatus: CorrectionStatus = input.correctionStatus ?? (input.oos ? 'open' : 'not_required');
    const citationDisposition: CitationDisposition = input.citationDisposition ?? ((input.fineCents ?? 0) > 0 ? 'pending' : 'none');
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'violation');
    const id = this.core.newId('vio');
    const derived = violationNextAction({ correctionStatus, citationDisposition, dataqsStatus: 'not_filed', oos: input.oos });
    await this.db.insert(safetyViolations).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, owner ?? (inspection?.ownerId ? { id: inspection.ownerId, name: inspection.ownerName ?? '' } : null)),
      nextAction: input.nextAction ?? derived ?? 'Review the violation with the driver',
      nextActionDueOn: input.nextActionDueOn ?? input.correctionDueOn ?? this.core.dueIn(7),
      isTest: input.isTest ?? inspection?.isTest ?? false,
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      occurredAt: new Date(input.occurredAt),
      source: inspection ? 'roadside' : 'manual',
      inspectionId: inspection?.id ?? null,
      inspectionNumber: inspection?.number ?? null,
      reportNumber: input.reportNumber ?? inspection?.reportNumber ?? null,
      code: input.code ?? null,
      description: input.description,
      category: input.category ?? null,
      issuedTo: input.issuedTo ?? null,
      agency: input.agency ?? '',
      violationType: input.violationType ?? null,
      fineNotApplicable: input.fineNotApplicable ?? false,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      truckId: truck?.id ?? null,
      truckNumber: truck?.number ?? null,
      oos: input.oos,
      correctionStatus,
      correctionDueOn: input.correctionDueOn ?? null,
      fineCents: input.fineCents ?? null,
      courtDate: input.courtDate ?? null,
      citationDisposition,
      state: input.state ?? inspection?.state ?? null,
      inspectionLevel: input.inspectionLevel ?? inspection?.level ?? null,
      caseId: joining?.caseId ?? null,
    });
    await this.core.write(principal, 'violation', { id, number }, 'violation_recorded', `${input.description}${input.issuedTo ? ` — issued to: ${issuedToLabel(input.issuedTo)}` : ''}${input.agency ? ` by ${input.agency}` : ''}${input.state ? ` in ${input.state}` : ''}${inspection ? ` on ${inspection.number}` : ''}`, { at });
    // One paper, one review (owner, 2026-10-21): a violation joining a case shares the case's review.
    if (driver && joining?.review) {
      await this.db.update(safetyViolations).set({ reviewId: joining.review.id, reviewNumber: joining.review.number }).where(and(eq(safetyViolations.companyId, principal.companyId), eq(safetyViolations.id, id)));
      await this.core.write(principal, 'violation', { id, number }, 'violation_review_shared', `Shares driver review ${joining.review.number} with the case`, { at });
    } else if (driver) {
      // A violation for a driver opens a driver review, once.
      const review = await this.reviews.openLinked(principal, {
        kind: 'driver_review',
        reason: 'Violation review',
        driver,
        linkedType: 'violation',
        linked: { id, number },
        dueDays: 7,
        isTest: input.isTest ?? inspection?.isTest ?? false,
      });
      await this.db.update(safetyViolations).set({ reviewId: review.id, reviewNumber: review.number }).where(eq(safetyViolations.id, id));
      await this.core.write(principal, 'violation', { id, number }, 'violation_review_opened', `Driver review ${review.number} opened`, { at });
    }
    return this.toViolation(await this.violationRow(principal.companyId, id));
  }

  async updateViolation(principal: Principal, id: string, input: UpdateViolationInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is closed`);
    // Only a warning may leave "issued to" blank (owner, 2026-10-19).
    const typeAfter = input.violationType !== undefined ? input.violationType : row.violationType;
    const issuedAfter = input.issuedTo !== undefined ? input.issuedTo : row.issuedTo;
    if (!issuedAfter && typeAfter !== 'warning') throw this.core.refused('Say who received it - only a warning may leave it blank');
    const patch: Partial<typeof safetyViolations.$inferInsert> = {};
    if (input.driverId !== undefined) {
      const d = await this.core.driver(principal.companyId, input.driverId);
      patch.driverId = d?.id ?? null;
      patch.driverName = d?.name ?? null;
    }
    if (input.truckId !== undefined) {
      const t = await this.core.truck(principal.companyId, input.truckId);
      patch.truckId = t?.id ?? null;
      patch.truckNumber = t?.number ?? null;
    }
    if (input.ownerId !== undefined) {
      const o = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = o?.id ?? null;
      patch.ownerName = o?.name ?? null;
    }
    if (input.occurredAt !== undefined) patch.occurredAt = new Date(input.occurredAt);
    const copy = [
      'reportNumber',
      'code',
      'description',
      'category',
      'issuedTo',
      'agency',
      'violationType',
      'fineNotApplicable',
      'oos',
      'correctionStatus',
      'correctionDueOn',
      'correctionNote',
      'fineCents',
      'courtDate',
      'citationDisposition',
      'dataqsStatus',
      'dataqsFiledOn',
      'dataqsReference',
      'dataqsNote',
      'nextAction',
      'nextActionDueOn',
      'citationNumber',
      'state',
      'inspectionLevel',
      'dispute',
      'lawyerName',
      'lawyerPhone',
      'lawyerFeeCents',
      'lawyerPaid',
    ] as const;
    for (const key of copy) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key] ?? null;
    }
    if (patch.dataqsStatus === 'filed' && !row.dataqsFiledOn && patch.dataqsFiledOn === undefined) patch.dataqsFiledOn = this.core.today();
    // The next action follows the tracks unless a person wrote one.
    if (input.nextAction === undefined) {
      patch.nextAction = violationNextAction({
        correctionStatus: (patch.correctionStatus ?? row.correctionStatus) as CorrectionStatus,
        citationDisposition: (patch.citationDisposition ?? row.citationDisposition) as CitationDisposition,
        dataqsStatus: (patch.dataqsStatus ?? row.dataqsStatus) as DataqsStatus,
        oos: patch.oos ?? row.oos,
      }) ?? 'Close the violation: every track is finished';
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyViolations)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyViolations.id, row.id), eq(safetyViolations.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>).filter((c) => c.field !== 'nextAction' || input.nextAction !== undefined);
    await this.core.write(principal, 'violation', row, 'violation_updated', `Updated ${changes.map((c) => c.field).join(', ') || row.number}`, { changes, at });
    return this.toViolation(updated[0] as SafetyViolationRow);
  }

  async closeViolation(principal: Principal, id: string, input: VersionOnlyInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is already closed`);
    const open = violationOpenTracks({
      correctionStatus: row.correctionStatus as CorrectionStatus,
      citationDisposition: row.citationDisposition as CitationDisposition,
      dataqsStatus: row.dataqsStatus as DataqsStatus,
    });
    if (open.length > 0) throw this.core.refused(`${row.number} has open tracks`, open.map((t) => `${t} is not finished`));
    const at = this.core.now();
    const updated = await this.db
      .update(safetyViolations)
      .set({ closedAt: at, closedBy: this.core.actor(principal), nextAction: null, nextActionDueOn: null, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyViolations.id, row.id), eq(safetyViolations.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'violation', row, 'violation_closed', 'Closed: correction, citation and DataQs finished', { at });
    return this.toViolation(updated[0] as SafetyViolationRow);
  }

  // ------------------------------------------------------- follow-up (owner, 2026-10-13)

  /** One version-checked write on an open violation, audited, read back with Accounting's answer. */
  private async followup(principal: Principal, id: string, version: number, patch: Partial<typeof safetyViolations.$inferInsert>, action: string, summary: string): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, version);
    if (row.closedAt) throw this.core.refused(`${row.number} is closed`);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyViolations)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyViolations.id, row.id), eq(safetyViolations.version, version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>).filter((c) => c.field !== 'notes');
    await this.core.write(principal, 'violation', row, action, summary, { changes, at });
    const fresh = updated[0] as SafetyViolationRow;
    return this.toViolation(fresh, await this.txStates(principal, [fresh]));
  }

  async setTraining(principal: Principal, id: string, input: ViolationTrainingInput): Promise<SafetyViolation> {
    const completed = input.status === 'completed';
    return this.followup(
      principal,
      id,
      input.version,
      {
        trainingStatus: input.status,
        trainingCompletedOn: completed ? (input.completedOn ?? this.core.today()) : null,
        trainerName: input.trainerName ?? null,
        trainingProofFileId: input.proofFileId ?? null,
      },
      'violation_training',
      `Training: ${input.status.replace(/_/g, ' ')}${input.trainerName ? ` · ${input.trainerName}` : ''}`,
    );
  }

  async setStatus(principal: Principal, id: string, input: ViolationStatusInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    // Once Accounting holds a charge or bonus, its own review decides; Safety does not overwrite it.
    if (row.moneyTxId && input.status === 'not_charged') {
      const tx = await this.driverAccounts.transaction(principal, row.moneyTxId).catch(() => null);
      if (tx && tx.state !== 'void') throw this.core.refused(`${row.number} has a ${row.moneyKind} with Accounting`, ['Ask Accounting to void it first']);
    }
    return this.followup(principal, id, input.version, { followupStatus: input.status as ViolationFollowupChoice }, 'violation_status', `Status: ${input.status.replace(/_/g, ' ')}`);
  }

  async sendMoney(principal: Principal, id: string, input: ViolationMoneyInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is closed`);
    if (!row.driverId) throw this.core.refused(`${row.number} has no driver`, ['Choose the driver on the violation first']);
    if (row.moneyTxId) {
      const prior = await this.driverAccounts.transaction(principal, row.moneyTxId).catch(() => null);
      if (prior && prior.state !== 'void') throw this.core.refused(`${row.number} already has a ${row.moneyKind} with Accounting`, ['Ask Accounting to void it before sending another']);
    }
    const label = input.kind === 'charge' ? 'Violation charge' : 'Safety bonus';
    const tx = await this.driverAccounts.fromSafetyViolation(principal, {
      violationId: row.id,
      reference: row.number,
      kind: input.kind,
      driverId: row.driverId,
      amountCents: input.amountCents,
      onDate: this.core.today(),
      description: `${label} · ${row.number}${row.code ? ` · ${row.code}` : ''} · ${row.description}`.slice(0, 200),
      reason: input.reason,
      truckId: row.truckId,
    });
    return this.followup(
      principal,
      id,
      input.version,
      {
        followupStatus: input.kind === 'charge' ? 'charge_pending' : 'bonus_pending',
        moneyKind: input.kind,
        moneyCents: input.amountCents,
        moneyParty: input.party,
        moneyReason: input.reason,
        moneyTxId: tx.id,
        moneySentAt: this.core.now(),
      },
      'violation_money_sent',
      `${input.kind === 'charge' ? 'Charge' : 'Bonus'} $${(input.amountCents / 100).toFixed(2)} sent to Accounting: ${input.reason}`,
    );
  }

  async addNote(principal: Principal, id: string, input: ViolationNoteInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    const note: ViolationNote = { id: `vn_${crypto.randomUUID()}`, body: input.body, by: this.core.actor(principal), at: this.core.now().toISOString() };
    const notes = [note, ...(Array.isArray(row.notes) ? (row.notes as ViolationNote[]) : [])];
    return this.followup(principal, id, input.version, { notes }, 'violation_note', `Note: ${input.body.slice(0, 120)}`);
  }

  /** "Delete" one violation (owner, 2026-10-21): voided, kept on record, audited. */
  async voidViolation(principal: Principal, id: string, input: VoidViolationInput): Promise<SafetyViolation> {
    const row = await this.violationRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const { rows: [voided] } = await this.voidRows(principal, [row], { [row.id]: input.version }, input.reason);
    return this.toViolation(voided!);
  }

  /** "Delete" a whole case: every live violation on the paper, and its driver review. */
  async voidViolationCase(principal: Principal, key: string, input: VoidViolationCaseInput): Promise<{ voided: string[]; reviewsVoided: string[] }> {
    const found = await this.violationCase(principal, key);
    const rows = await this.db
      .select()
      .from(safetyViolations)
      .where(and(eq(safetyViolations.companyId, principal.companyId), isNull(safetyViolations.voidedAt), inArray(safetyViolations.id, found.violations.map((v) => v.id))));
    for (const row of rows) {
      const version = input.versions[row.id];
      if (version === undefined) throw this.core.stale(row.number, row);
      this.core.checkWritable(row.number, row, version);
    }
    const done = await this.voidRows(principal, rows, input.versions, input.reason);
    return { voided: done.rows.map((r) => r.number), reviewsVoided: done.reviews };
  }

  /**
   * Voids the rows, and any driver review no live violation points at afterwards. Refused as a
   * whole - nothing written - when money already went to Accounting, a DataQs challenge was filed,
   * or the review to void has moved on or holds work (the merge script's test).
   */
  private async voidRows(principal: Principal, rows: SafetyViolationRow[], versions: Record<string, number>, reason: string): Promise<{ rows: SafetyViolationRow[]; reviews: string[] }> {
    const blockers: string[] = [];
    for (const r of rows) {
      if (r.moneyTxId || r.moneySentAt) blockers.push(`${r.number} has a ${r.moneyKind ?? 'charge'} sent to Accounting - ask Accounting to void it first`);
      if (r.dataqsStatus !== 'not_filed' || r.dataqsFiledOn) blockers.push(`${r.number} has a DataQs filing (${r.dataqsStatus.replace(/_/g, ' ')})`);
    }
    // Reviews left with no live violation once these are gone.
    const ids = rows.map((r) => r.id);
    const reviewIds = [...new Set(rows.map((r) => r.reviewId).filter((x): x is string => Boolean(x)))];
    const orphaned: SafetyReviewRow[] = [];
    if (reviewIds.length > 0) {
      const stillUsed = await this.db
        .select({ reviewId: safetyViolations.reviewId })
        .from(safetyViolations)
        .where(and(eq(safetyViolations.companyId, principal.companyId), isNull(safetyViolations.voidedAt), inArray(safetyViolations.reviewId, reviewIds), notInArray(safetyViolations.id, ids)));
      const keep = new Set(stillUsed.map((s) => s.reviewId));
      const reviews = await this.db
        .select()
        .from(safetyReviews)
        .where(and(eq(safetyReviews.companyId, principal.companyId), inArray(safetyReviews.id, reviewIds.filter((x) => !keep.has(x))), isNull(safetyReviews.voidedAt)));
      if (reviews.length > 0) {
        const docs = await this.db
          .select({ caseId: safetyCaseDocuments.caseId })
          .from(safetyCaseDocuments)
          .where(and(eq(safetyCaseDocuments.companyId, principal.companyId), eq(safetyCaseDocuments.caseType, 'safety_review'), inArray(safetyCaseDocuments.caseId, reviews.map((r) => r.id)), isNull(safetyCaseDocuments.voidedAt)));
        for (const review of reviews) {
          const why = reviewProgress(review, docs.filter((d) => d.caseId === review.id).length);
          if (why.length > 0) blockers.push(`driver review ${review.number} ${why.join(', ')} - finish or void it in Safety review first`);
          else orphaned.push(review);
        }
      }
    }
    if (blockers.length > 0) throw this.core.refused(`Cannot delete ${rows.length === 1 ? rows[0]!.number : `these ${rows.length} violations`}`, blockers);

    const at = this.core.now();
    const by = this.core.actor(principal);
    const out = await this.db.transaction(async (tx) => {
      const done: SafetyViolationRow[] = [];
      for (const r of rows) {
        const version = versions[r.id]!;
        const updated = await tx
          .update(safetyViolations)
          .set({ voidedAt: at, voidedBy: by, voidReason: reason, version: version + 1, updatedAt: at })
          .where(and(eq(safetyViolations.companyId, principal.companyId), eq(safetyViolations.id, r.id), eq(safetyViolations.version, version), isNull(safetyViolations.voidedAt)))
          .returning();
        if (updated.length === 0) throw this.core.stale(r.number, r);
        done.push(updated[0] as SafetyViolationRow);
      }
      for (const review of orphaned) {
        const updated = await tx
          .update(safetyReviews)
          .set({ voidedAt: at, voidedBy: by, voidReason: reason, version: review.version + 1, updatedAt: at })
          .where(and(eq(safetyReviews.companyId, principal.companyId), eq(safetyReviews.id, review.id), eq(safetyReviews.version, review.version), isNull(safetyReviews.voidedAt)))
          .returning({ id: safetyReviews.id });
        if (updated.length === 0) throw this.core.stale(review.number, review);
      }
      return done;
    });
    for (const r of rows) await this.core.write(principal, 'violation', r, 'violation_voided', `Deleted (voided) ${r.number}${r.code ? ` · ${r.code}` : ''}`, { reason, at, changes: [{ field: 'voidedAt', old: null, new: at.toISOString() }] });
    for (const review of orphaned) await this.core.write(principal, 'safety_review', review, 'safety_review_voided', `Voided ${review.number}: its violations were deleted`, { reason, at });
    return { rows: out, reviews: orphaned.map((r) => r.number) };
  }

  // ------------------------------------------------------------------------ roadside inspections

  async inspectionRow(companyId: string, id: string): Promise<SafetyRoadsideRow> {
    const [row] = await this.db
      .select()
      .from(safetyRoadsideInspections)
      .where(and(eq(safetyRoadsideInspections.companyId, companyId), eq(safetyRoadsideInspections.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That inspection');
    return row;
  }

  private toInspection(row: SafetyRoadsideRow, violations: SafetyViolationRow[]): SafetyRoadsideInspection {
    const live = violations.filter((v) => !v.voidedAt);
    return {
      ...baseOf(row),
      inspectedAt: row.inspectedAt.toISOString(),
      level: row.level,
      reportNumber: row.reportNumber,
      agency: row.agency,
      location: row.location,
      state: row.state,
      driverId: row.driverId,
      driverName: row.driverName,
      truckId: row.truckId,
      truckNumber: row.truckNumber,
      trailerId: row.trailerId,
      trailerNumber: row.trailerNumber,
      oos: row.oos,
      oosNote: row.oosNote,
      correctionDueOn: row.correctionDueOn,
      returnRequired: row.returnRequired,
      stage: row.stage as RoadsideStage,
      stageDates: {
        received: iso(row.receivedAt),
        reviewed: iso(row.reviewedAt),
        defects_corrected: iso(row.correctedAt),
        certified: iso(row.certifiedAt),
        returned: iso(row.returnedAt),
      },
      workOrderId: row.workOrderId,
      workOrderNumber: row.workOrderNumber,
      violationCount: live.length,
      violations: live.map((v) => ({ id: v.id, number: v.number, description: v.description, oos: v.oos, correctionStatus: v.correctionStatus as CorrectionStatus })),
      status: roadsideStatus({ stage: row.stage as RoadsideStage, violationCount: live.length, returnRequired: row.returnRequired, oos: row.oos }),
    };
  }

  private async violationsOn(companyId: string, inspectionId: string): Promise<SafetyViolationRow[]> {
    return this.db
      .select()
      .from(safetyViolations)
      .where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.inspectionId, inspectionId)))
      .orderBy(asc(safetyViolations.createdAt));
  }

  async getInspection(principal: Principal, id: string): Promise<SafetyRoadsideInspection> {
    const row = await this.inspectionRow(principal.companyId, id);
    return this.toInspection(row, await this.violationsOn(principal.companyId, id));
  }

  async listInspections(principal: Principal, query: { includeVoided?: boolean } = {}): Promise<SafetyRoadsideInspection[]> {
    const parts = [eq(safetyRoadsideInspections.companyId, principal.companyId)];
    if (!query.includeVoided) parts.push(isNull(safetyRoadsideInspections.voidedAt));
    const rows = await this.db.select().from(safetyRoadsideInspections).where(and(...parts)).orderBy(desc(safetyRoadsideInspections.inspectedAt));
    const violations = await this.db.select().from(safetyViolations).where(eq(safetyViolations.companyId, principal.companyId));
    return rows.map((r) => this.toInspection(r, violations.filter((v) => v.inspectionId === r.id)));
  }

  async inspectionDetail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyRoadsideInspection>> {
    const [record, documents, timeline] = await Promise.all([
      this.getInspection(principal, id),
      this.core.documents(principal.companyId, 'roadside_inspection', id),
      this.core.timeline(principal, 'roadside_inspection', id),
    ]);
    return { record, documents, timeline };
  }

  async createInspection(principal: Principal, input: CreateRoadsideInspectionInput): Promise<SafetyRoadsideInspection> {
    if (Date.parse(input.inspectedAt) > this.core.now().getTime() + 5 * 60_000) throw this.core.invalid('The inspection time is in the future');
    const [driver, truck, trailer, owner] = await Promise.all([
      this.core.driver(principal.companyId, input.driverId),
      this.core.truck(principal.companyId, input.truckId),
      this.core.trailer(principal.companyId, input.trailerId),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'roadside_inspection');
    const id = this.core.newId('rsi');
    await this.db.insert(safetyRoadsideInspections).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, owner),
      nextAction: input.nextAction ?? ROADSIDE_NEXT_ACTION.received,
      nextActionDueOn: input.nextActionDueOn ?? (input.oos ? this.core.today() : this.core.dueIn(2)),
      isTest: input.isTest ?? false,
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      inspectedAt: new Date(input.inspectedAt),
      level: input.level,
      reportNumber: input.reportNumber ?? null,
      agency: input.agency,
      location: input.location ?? null,
      state: input.state ?? null,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      truckId: truck?.id ?? null,
      truckNumber: truck?.number ?? null,
      trailerId: trailer?.id ?? null,
      trailerNumber: trailer?.number ?? null,
      oos: input.oos,
      oosNote: input.oosNote ?? null,
      correctionDueOn: input.correctionDueOn ?? null,
      returnRequired: input.returnRequired,
      stage: 'received',
      receivedAt: at,
    });
    await this.core.write(principal, 'roadside_inspection', { id, number }, 'roadside_recorded', `Level ${input.level} inspection by ${input.agency}${input.oos ? ' — vehicle out of service' : ''}`, { at });
    return this.getInspection(principal, id);
  }

  async updateInspection(principal: Principal, id: string, input: UpdateRoadsideInspectionInput): Promise<SafetyRoadsideInspection> {
    const row = await this.inspectionRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const patch: Partial<typeof safetyRoadsideInspections.$inferInsert> = {};
    if (input.driverId !== undefined) {
      const d = await this.core.driver(principal.companyId, input.driverId);
      patch.driverId = d?.id ?? null;
      patch.driverName = d?.name ?? null;
    }
    if (input.truckId !== undefined) {
      const t = await this.core.truck(principal.companyId, input.truckId);
      patch.truckId = t?.id ?? null;
      patch.truckNumber = t?.number ?? null;
    }
    if (input.trailerId !== undefined) {
      const t = await this.core.trailer(principal.companyId, input.trailerId);
      patch.trailerId = t?.id ?? null;
      patch.trailerNumber = t?.number ?? null;
    }
    if (input.ownerId !== undefined) {
      const o = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = o?.id ?? null;
      patch.ownerName = o?.name ?? null;
    }
    if (input.inspectedAt !== undefined) patch.inspectedAt = new Date(input.inspectedAt);
    const copy = ['level', 'reportNumber', 'agency', 'location', 'state', 'oos', 'oosNote', 'correctionDueOn', 'returnRequired', 'nextAction', 'nextActionDueOn'] as const;
    for (const key of copy) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key] ?? null;
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyRoadsideInspections)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyRoadsideInspections.id, row.id), eq(safetyRoadsideInspections.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'roadside_inspection', row, 'roadside_updated', `Updated ${changes.map((c) => c.field).join(', ') || row.number}`, { changes, at });
    return this.getInspection(principal, id);
  }

  /** One step along the checklist. Only the next stage; nothing past the last one owed. */
  async setStage(principal: Principal, id: string, input: RoadsideStageInput): Promise<SafetyRoadsideInspection> {
    const row = await this.inspectionRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const violations = (await this.violationsOn(principal.companyId, id)).filter((v) => !v.voidedAt);
    const order = [...ROADSIDE_STAGES];
    const from = order.indexOf(row.stage as RoadsideStage);
    const to = order.indexOf(input.stage);
    const final = roadsideFinalStage({ violationCount: violations.length, returnRequired: row.returnRequired, oos: row.oos });
    if (to !== from + 1) {
      throw this.core.refused(`${row.number} is at ${ROADSIDE_STAGE_LABEL[row.stage as RoadsideStage]}; the next step is ${order[from + 1] ? ROADSIDE_STAGE_LABEL[order[from + 1] as RoadsideStage] : 'none'}`);
    }
    if (from >= order.indexOf(final)) throw this.core.refused(`${row.number} has nothing more owed`);
    if (input.stage === 'certified') {
      const uncorrected = violations.filter((v) => v.correctionStatus !== 'not_required' && v.correctionStatus !== 'certified' && v.correctionStatus !== 'proof_submitted' && v.correctionStatus !== 'repaired');
      if (uncorrected.length > 0) {
        throw this.core.refused('Certify the inspection once every violation is corrected', uncorrected.map((v) => `${v.number}: ${v.description}`));
      }
    }
    const at = this.core.now();
    const reachedFinal = input.stage === final;
    const nextStage = order[to + 1] as RoadsideStage | undefined;
    const patch: Partial<typeof safetyRoadsideInspections.$inferInsert> = {
      stage: input.stage,
      [STAGE_COLUMN[input.stage]]: at,
      nextAction: reachedFinal || !nextStage ? null : ROADSIDE_NEXT_ACTION[input.stage === 'reviewed' && violations.length === 0 && row.oos ? 'reviewed' : input.stage],
      nextActionDueOn: reachedFinal ? null : (row.correctionDueOn ?? this.core.dueIn(3)),
    };
    const updated = await this.db
      .update(safetyRoadsideInspections)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyRoadsideInspections.id, row.id), eq(safetyRoadsideInspections.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'roadside_inspection', row, 'roadside_stage_changed', `${ROADSIDE_STAGE_LABEL[row.stage as RoadsideStage]} → ${ROADSIDE_STAGE_LABEL[input.stage]}`, {
      changes: [{ field: 'stage', old: row.stage, new: input.stage }],
      at,
    });
    return this.getInspection(principal, id);
  }

  /** Records a violation found on this inspection. The inspection's version guards a double click. */
  async addViolation(principal: Principal, id: string, input: RoadsideViolationInput): Promise<SafetyViolation> {
    const row = await this.inspectionRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const bumped = await this.db
      .update(safetyRoadsideInspections)
      .set({ version: row.version + 1, updatedAt: at, oos: row.oos || input.oos })
      .where(and(eq(safetyRoadsideInspections.id, row.id), eq(safetyRoadsideInspections.version, input.version)))
      .returning();
    if (missed(bumped)) throw this.core.stale(row.number, row);
    const violation = await this.createViolation(
      principal,
      {
        occurredAt: row.inspectedAt.toISOString(),
        reportNumber: row.reportNumber,
        code: input.code ?? null,
        description: input.description,
        category: input.category ?? null,
        issuedTo: input.issuedTo,
        agency: row.agency,
        oos: input.oos,
        fineCents: input.fineCents ?? null,
        correctionDueOn: input.correctionDueOn ?? row.correctionDueOn ?? null,
        inspectionId: row.id,
      },
      { inspection: bumped[0] as SafetyRoadsideRow },
    );
    await this.core.write(principal, 'roadside_inspection', row, 'roadside_violation_recorded', `Violation ${violation.number} recorded: ${input.description}`, { at });
    return violation;
  }

  async linkWorkOrder(principal: Principal, id: string, input: LinkWorkOrderInput): Promise<SafetyRoadsideInspection> {
    const row = await this.inspectionRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const wo = await this.core.workOrder(principal.companyId, input.workOrderId);
    const at = this.core.now();
    const result = await this.db
      .update(safetyRoadsideInspections)
      .set({ workOrderId: wo.id, workOrderNumber: wo.number, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyRoadsideInspections.id, row.id), eq(safetyRoadsideInspections.version, input.version)))
      .returning();
    if (missed(result)) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'roadside_inspection', row, 'roadside_work_order_linked', `Repair ${wo.number} linked`, {
      changes: [{ field: 'workOrderId', old: row.workOrderId, new: wo.id }],
      at,
    });
    return this.getInspection(principal, id);
  }

  async voidInspection(principal: Principal, id: string, input: VoidInput): Promise<SafetyRoadsideInspection> {
    const row = await this.inspectionRow(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const result = await this.db
      .update(safetyRoadsideInspections)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyRoadsideInspections.id, row.id), eq(safetyRoadsideInspections.version, input.version)))
      .returning();
    if (missed(result)) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'roadside_inspection', row, 'roadside_voided', `Voided ${row.number}`, { reason: input.reason, at });
    return this.getInspection(principal, id);
  }
}

/** True when an optimistic update matched nothing (the version moved). */
function missed(rows: unknown[]): boolean {
  return rows.length === 0;
}


/**
 * What the row shows (owner, 2026-10-13): Safety's decision, moved on by Accounting's answer -
 * a charge is Charged and a bonus Received once Accounting approves it; nothing charged with the
 * training done and every track finished is Ready to close.
 */
export function violationStatusOf(row: SafetyViolationRow, txState: string | null): ViolationStatus {
  if (row.closedAt) return 'closed';
  const accepted = txState === 'approved' || txState === 'applied';
  if (row.followupStatus === 'charge_pending') return accepted ? 'charged' : 'charge_pending';
  if (row.followupStatus === 'bonus_pending') return accepted ? 'bonus_received' : 'bonus_pending';
  // Set by Safety itself (owner, 2026-10-19).
  if (row.followupStatus === 'charged') return 'charged';
  if (row.followupStatus === 'bonus_received') return 'bonus_received';
  if (row.followupStatus === 'bonus_dismissed') return 'bonus_dismissed';
  if (row.followupStatus === 'not_charged') {
    const trained = row.trainingStatus === 'completed' || row.trainingStatus === 'not_required';
    const open = violationOpenTracks({
      correctionStatus: row.correctionStatus as CorrectionStatus,
      citationDisposition: row.citationDisposition as CitationDisposition,
      dataqsStatus: row.dataqsStatus as DataqsStatus,
    });
    return trained && open.length === 0 ? 'ready_to_close' : 'not_charged';
  }
  return 'undecided';
}
