import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, like } from 'drizzle-orm';
import {
  ACCOUNTING_ENTRY_KIND_LABEL,
  CLAIM_KIND_LABEL,
  CLAIM_NEXT_ACTION,
  CLAIM_STAGE_LABEL,
  claimAdvanceBlockers,
  nextClaimStage,
  type AccountingEntryKind,
  type AccountingEntryState,
  type ClaimDecision,
  type ClaimKind,
  type ClaimStage,
  type CreateClaimInput,
  type RecordClaimPaymentInput,
  type ReviewAccountingEntryInput,
  type SafetyAccountingEntry,
  type SafetyCaseDetail,
  type SafetyClaim,
  type SafetyClaimPayment,
  type UpdateClaimInput,
  type VersionOnlyInput,
  type VoidInput,
  LIABILITY_PARTY_LABEL,
  type LogClaimUpdateInput,
  type SetLiabilityInput,
  CLAIM_LINE_KIND_LABEL,
  type ClaimLineKind,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import {
  safetyAccidents,
  safetyAccountingEntries,
  safetyClaimLines,
  safetyClaimPayments,
  safetyClaims,
  type SafetyAccountingEntryRow,
  type SafetyClaimLineRow,
  type SafetyClaimPaymentRow,
  type SafetyClaimRow,
} from '../../database/schema/safety';
import { DriverChargesService } from './driver-charges.service';
import { SafetyCoreService, baseOf, changesOf, iso } from './safety-core.service';

/**
 * Insurance claims, their payments, and the money they suggest to Accounting.
 *
 * Claimed, approved and received are three facts kept apart: what we asked for, what the insurer
 * decided, and the sum of the payments that actually arrived. Money goes to Accounting as entries
 * to review and confirm — the accounting module's review-before-post rule, keyed on a source so a
 * second save is the same entry. Safety never posts, and a driver deduction is only ever a
 * proposal for Accounting to decide.
 */
@Injectable()
export class ClaimsService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly charges: DriverChargesService,
  ) {}

  private get db() {
    return this.core.db;
  }

  async row(companyId: string, id: string): Promise<SafetyClaimRow> {
    const [row] = await this.db
      .select()
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), eq(safetyClaims.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That claim');
    return row;
  }

  private async payments(companyId: string, claimId: string): Promise<SafetyClaimPaymentRow[]> {
    return this.db
      .select()
      .from(safetyClaimPayments)
      .where(and(eq(safetyClaimPayments.companyId, companyId), eq(safetyClaimPayments.claimId, claimId)))
      .orderBy(asc(safetyClaimPayments.receivedOn), asc(safetyClaimPayments.createdAt));
  }

  private async entries(companyId: string, claimId: string): Promise<SafetyAccountingEntryRow[]> {
    return this.db
      .select()
      .from(safetyAccountingEntries)
      .where(and(eq(safetyAccountingEntries.companyId, companyId), eq(safetyAccountingEntries.claimId, claimId)))
      .orderBy(asc(safetyAccountingEntries.createdAt));
  }

  private toClaim(row: SafetyClaimRow, payments: SafetyClaimPaymentRow[], entries: SafetyAccountingEntryRow[], driverCharge: SafetyClaim['driverCharge'] = null, lines: SafetyClaimLineRow[] = []): SafetyClaim {
    const receivedCents = payments.filter((p) => !p.voidedAt).reduce((sum, p) => sum + p.amountCents, 0);
    return {
      ...baseOf(row),
      kind: row.kind as ClaimKind,
      accidentId: row.accidentId,
      accidentNumber: row.accidentNumber,
      loadId: row.loadId,
      loadNumber: row.loadNumber,
      driverId: row.driverId,
      driverName: row.driverName,
      truckId: row.truckId,
      truckNumber: row.truckNumber,
      description: row.description,
      insurer: row.insurer,
      policyNumber: row.policyNumber,
      insurerReference: row.insurerReference,
      adjusterName: row.adjusterName,
      adjusterPhone: row.adjusterPhone,
      adjusterEmail: row.adjusterEmail,
      openedOn: row.openedOn,
      submittedOn: row.submittedOn,
      decisionOn: row.decisionOn,
      decision: row.decision as ClaimDecision | null,
      stage: row.stage as ClaimStage,
      claimedCents: row.claimedCents,
      approvedCents: row.approvedCents,
      deductibleCents: row.deductibleCents,
      receivedCents,
      remainingApprovedCents: row.approvedCents === null ? null : Math.max(0, row.approvedCents - receivedCents),
      driverDeductionProposedCents: row.driverDeductionProposedCents,
      driverDeductionNote: row.driverDeductionNote,
      closedAt: iso(row.closedAt),
      closedBy: row.closedBy,
      payments: payments.map(toPayment),
      accountingEntries: entries.map(toEntry),
      liabilityParty: (row.liabilityParty as SafetyClaim['liabilityParty']) ?? null,
      liabilityPct: row.liabilityPct ?? null,
      lastActivityAt: row.lastActivityAt.toISOString(),
      driverCharge,
      lines: lines
        .filter((l) => !l.voidedAt)
        .map((l) => ({ id: l.id, kind: l.kind as ClaimLineKind, status: l.status, insurer: l.insurer, reserveCents: l.reserveCents, createdAt: l.createdAt.toISOString(), createdBy: l.createdBy })),
      advanceBlockers: claimAdvanceBlockers({
        stage: row.stage as ClaimStage,
        decision: row.decision as ClaimDecision | null,
        approvedCents: row.approvedCents,
        receivedCents,
        submittedOn: row.submittedOn,
        insurer: row.insurer,
      }),
    };
  }

  async get(principal: Principal, id: string): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    const [payments, entries, charges, lines] = await Promise.all([
      this.payments(principal.companyId, id),
      this.entries(principal.companyId, id),
      this.charges.summaries(principal, [id]),
      this.db.select().from(safetyClaimLines).where(and(eq(safetyClaimLines.companyId, principal.companyId), eq(safetyClaimLines.claimId, id))),
    ]);
    return redactRestricted(principal, row, this.toClaim(row, payments, entries, charges.get(id) ?? null, lines));
  }

  async list(principal: Principal, query: { includeVoided?: boolean; stage?: ClaimStage } = {}): Promise<SafetyClaim[]> {
    const parts = [eq(safetyClaims.companyId, principal.companyId)];
    if (!query.includeVoided) parts.push(isNull(safetyClaims.voidedAt));
    if (query.stage) parts.push(eq(safetyClaims.stage, query.stage));
    const rows = await this.db.select().from(safetyClaims).where(and(...parts)).orderBy(desc(safetyClaims.createdAt));
    const [payments, entries, charges, allLines] = await Promise.all([
      this.db.select().from(safetyClaimPayments).where(eq(safetyClaimPayments.companyId, principal.companyId)),
      this.db.select().from(safetyAccountingEntries).where(eq(safetyAccountingEntries.companyId, principal.companyId)),
      this.charges.summaries(principal, rows.map((r) => r.id)),
      this.db.select().from(safetyClaimLines).where(eq(safetyClaimLines.companyId, principal.companyId)),
    ]);
    return rows.map((r) =>
      redactRestricted(principal, r, this.toClaim(
        r,
        payments.filter((p) => p.claimId === r.id),
        entries.filter((e) => e.claimId === r.id),
        charges.get(r.id) ?? null,
        allLines.filter((l) => l.claimId === r.id),
      )),
    );
  }

  async detail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyClaim>> {
    const [record, documents, timeline] = await Promise.all([
      this.get(principal, id),
      this.core.documents(principal.companyId, 'claim', id),
      this.core.timeline(principal, 'claim', id),
    ]);
    return { record, documents, timeline };
  }

  /**
   * Opens a claim. From an accident it inherits driver, truck and load, and an accident has at
   * most one live claim: asking again returns the claim already open (`created: false`).
   */
  async create(principal: Principal, input: CreateClaimInput): Promise<{ claim: SafetyClaim; created: boolean }> {
    const result = await this.createFile(principal, input);
    if (!input.lines || input.lines.length === 0) return result;
    const at = this.core.now();
    const added: ClaimLineKind[] = [];
    for (const kind of input.lines) {
      const inserted = await this.db
        .insert(safetyClaimLines)
        .values({ id: this.core.newId('cln'), companyId: principal.companyId, claimId: result.claim.id, kind, insurer: input.insurer ?? null, reserveCents: result.created ? (input.claimedCents ?? null) : null, createdBy: this.core.actor(principal), createdAt: at })
        .onConflictDoNothing()
        .returning({ id: safetyClaimLines.id });
      if (inserted.length > 0) added.push(kind);
    }
    if (added.length > 0) {
      await this.db.update(safetyClaims).set({ lastActivityAt: at }).where(eq(safetyClaims.id, result.claim.id));
      await this.core.write(principal, 'claim', result.claim, 'claim_lines_added', `Lines: ${added.map((k) => CLAIM_LINE_KIND_LABEL[k]).join(', ')}`, { at });
    }
    return { claim: await this.get(principal, result.claim.id), created: result.created };
  }

  private async createFile(principal: Principal, input: CreateClaimInput): Promise<{ claim: SafetyClaim; created: boolean }> {
    let accident: typeof safetyAccidents.$inferSelect | null = null;
    if (input.accidentId) {
      const [row] = await this.db
        .select()
        .from(safetyAccidents)
        .where(and(eq(safetyAccidents.companyId, principal.companyId), eq(safetyAccidents.id, input.accidentId)))
        .limit(1);
      if (!row) throw this.core.invalid('That accident is not in this company');
      if (row.voidedAt) throw this.core.refused(`${row.number} is void`);
      accident = row;
      const existing = await this.liveClaimFor(principal.companyId, row.id);
      if (existing) return { claim: await this.get(principal, existing.id), created: false };
    }
    const [driver, truck, load, owner] = await Promise.all([
      input.driverId ? this.core.driver(principal.companyId, input.driverId) : Promise.resolve(accident?.driverId ? { id: accident.driverId, name: accident.driverName ?? '' } : null),
      input.truckId ? this.core.truck(principal.companyId, input.truckId) : Promise.resolve(accident?.truckId ? { id: accident.truckId, number: accident.truckNumber ?? '' } : null),
      input.loadId ? this.core.load(principal.companyId, input.loadId) : Promise.resolve(accident?.loadId ? { id: accident.loadId, number: accident.loadNumber ?? '' } : null),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'claim');
    const id = this.core.newId('clm');
    const next = CLAIM_NEXT_ACTION.opened;
    const inserted = await this.db
      .insert(safetyClaims)
      .values({
        id,
        companyId: principal.companyId,
        number,
        ...this.core.ownerOf(principal, owner ?? (accident?.ownerId ? { id: accident.ownerId, name: accident.ownerName ?? '' } : null)),
        nextAction: input.nextAction ?? next?.text ?? null,
        nextActionDueOn: input.nextActionDueOn ?? this.core.dueIn(next?.days ?? 3),
        isTest: input.isTest ?? accident?.isTest ?? false,
        createdBy: this.core.actor(principal),
        createdAt: at,
        updatedAt: at,
        kind: input.kind,
        accidentId: accident?.id ?? null,
        accidentNumber: accident?.number ?? null,
        loadId: load?.id ?? null,
        loadNumber: load?.number ?? null,
        driverId: driver?.id ?? null,
        driverName: driver?.name ?? null,
        truckId: truck?.id ?? null,
        truckNumber: truck?.number ?? null,
        description: input.description || accident?.description || '',
        insurer: input.insurer ?? null,
        policyNumber: input.policyNumber ?? null,
        openedOn: input.openedOn ?? this.core.today(),
        claimedCents: input.claimedCents ?? accident?.damageEstimateCents ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: safetyClaims.id });
    if (inserted.length === 0 && accident) {
      const again = await this.liveClaimFor(principal.companyId, accident.id);
      if (again) return { claim: await this.get(principal, again.id), created: false };
      throw this.core.refused('The claim could not be opened');
    }
    await this.core.write(principal, 'claim', { id, number }, 'claim_opened', `${CLAIM_KIND_LABEL[input.kind]} claim opened${accident ? ` from ${accident.number}` : load ? ` for load ${load.number}` : ''}`, { at });
    if (accident) {
      await this.db
        .update(safetyAccidents)
        .set({ claimId: id, claimNumber: number, version: accident.version + 1, updatedAt: at })
        .where(eq(safetyAccidents.id, accident.id));
      await this.core.write(principal, 'accident', accident, 'accident_claim_linked', `Claim ${number} opened`, {
        changes: [{ field: 'claimId', old: accident.claimId, new: id }],
        at,
      });
    }
    return { claim: await this.get(principal, id), created: true };
  }

  private async liveClaimFor(companyId: string, accidentId: string): Promise<SafetyClaimRow | null> {
    const [row] = await this.db
      .select()
      .from(safetyClaims)
      .where(and(eq(safetyClaims.companyId, companyId), eq(safetyClaims.accidentId, accidentId), isNull(safetyClaims.voidedAt)))
      .limit(1);
    return row ?? null;
  }

  async update(principal: Principal, id: string, input: UpdateClaimInput): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.stage === 'closed') throw this.core.refused(`${row.number} is closed`);
    const patch: Partial<typeof safetyClaims.$inferInsert> = {};
    const copy = [
      'description',
      'insurer',
      'policyNumber',
      'insurerReference',
      'adjusterName',
      'adjusterPhone',
      'adjusterEmail',
      'submittedOn',
      'decisionOn',
      'decision',
      'claimedCents',
      'approvedCents',
      'deductibleCents',
      'driverDeductionProposedCents',
      'driverDeductionNote',
      'nextAction',
      'nextActionDueOn',
    ] as const;
    for (const key of copy) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key] ?? null;
    }
    if (patch.decision === 'denied') patch.approvedCents = 0;
    if (patch.decision && !row.decisionOn && patch.decisionOn === undefined) patch.decisionOn = this.core.today();
    if (input.ownerId !== undefined) {
      const owner = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = owner?.id ?? null;
      patch.ownerName = owner?.name ?? null;
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyClaims)
      .set({ ...patch, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'claim', row, 'claim_updated', `Updated ${changes.map((c) => c.field).join(', ') || row.number}`, { changes, at });
    await this.syncEntries(principal, updated[0] as SafetyClaimRow);
    return this.get(principal, id);
  }

  /** Who is responsible (Claims v2): what lets a driver deductible be applied. */
  async setLiability(principal: Principal, id: string, input: SetLiabilityInput): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const pct = input.party === 'our_driver' ? 100 : input.party === 'other_party' || input.party === 'none' ? 0 : (input.pct ?? null);
    const updated = await this.db
      .update(safetyClaims)
      .set({ liabilityParty: input.party, liabilityPct: pct, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'claim', row, 'claim_liability', `Liability: ${LIABILITY_PARTY_LABEL[input.party]}${pct !== null ? ` (${pct}%)` : ''}`, {
      changes: [{ field: 'liabilityParty', old: row.liabilityParty ?? null, new: input.party }],
      reason: input.note ?? null,
      at,
    });
    return this.get(principal, id);
  }

  /** "Log update / set next": a note on the timeline, and the next action, its owner and due date. */
  async logUpdate(principal: Principal, id: string, input: LogClaimUpdateInput): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const patch: Partial<typeof safetyClaims.$inferInsert> = {};
    if (input.nextAction !== undefined) patch.nextAction = input.nextAction?.trim() || null;
    if (input.nextActionDueOn !== undefined) patch.nextActionDueOn = input.nextActionDueOn ?? null;
    if (input.ownerId !== undefined) {
      const owner = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = owner?.id ?? null;
      patch.ownerName = owner?.name ?? null;
    }
    const updated = await this.db
      .update(safetyClaims)
      .set({ ...patch, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'claim', row, 'claim_update_logged', `Update: ${input.note}`, { changes, at });
    return this.get(principal, id);
  }

  /** "Mark complete" on the next action: the claim moves to its next stage, if nothing forbids it. */
  async advance(principal: Principal, id: string, input: VersionOnlyInput): Promise<SafetyClaim> {
    const claim = await this.get(principal, id);
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (claim.advanceBlockers.length > 0) throw this.core.refused(`${row.number} cannot move on yet`, claim.advanceBlockers);
    const to = nextClaimStage(row.stage as ClaimStage, row.decision as ClaimDecision | null);
    if (!to) throw this.core.refused(`${row.number} is closed`);
    const at = this.core.now();
    const next = CLAIM_NEXT_ACTION[to];
    const patch: Partial<typeof safetyClaims.$inferInsert> = {
      stage: to,
      nextAction: next?.text ?? null,
      nextActionDueOn: next ? this.core.dueIn(next.days) : null,
    };
    if (to === 'submitted' && !row.submittedOn) patch.submittedOn = this.core.today();
    if (to === 'closed') {
      patch.closedAt = at;
      patch.closedBy = this.core.actor(principal);
    }
    const updated = await this.db
      .update(safetyClaims)
      .set({ ...patch, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'claim', row, 'claim_stage_changed', `${CLAIM_STAGE_LABEL[row.stage as ClaimStage]} → ${CLAIM_STAGE_LABEL[to]}`, {
      changes: [{ field: 'stage', old: row.stage, new: to }],
      at,
    });
    return this.get(principal, id);
  }

  /** Closes a claim at any stage with a note (withdrawn, settled outside the insurer, …). */
  async close(principal: Principal, id: string, input: { version: number; reason: string }): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.stage === 'closed') throw this.core.refused(`${row.number} is already closed`);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyClaims)
      .set({ stage: 'closed', closedAt: at, closedBy: this.core.actor(principal), nextAction: null, nextActionDueOn: null, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'claim', row, 'claim_closed', `Closed from ${CLAIM_STAGE_LABEL[row.stage as ClaimStage]}`, {
      changes: [{ field: 'stage', old: row.stage, new: 'closed' }],
      reason: input.reason,
      at,
    });
    return this.get(principal, id);
  }

  async recordPayment(principal: Principal, id: string, input: RecordClaimPaymentInput): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.decision === 'denied') throw this.core.refused('The insurer denied this claim; there is no payment to record');
    const at = this.core.now();
    // The claim's version is the idempotency guard: a double click sends the same version twice,
    // and the second is refused before a second payment exists.
    const bumped = await this.db
      .update(safetyClaims)
      .set({ version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning({ id: safetyClaims.id });
    if (bumped.length === 0) throw this.core.stale(row.number, row);
    const paymentId = this.core.newId('scp');
    await this.db.insert(safetyClaimPayments).values({
      id: paymentId,
      companyId: principal.companyId,
      claimId: row.id,
      receivedOn: input.receivedOn,
      amountCents: input.amountCents,
      method: input.method ?? null,
      reference: input.reference ?? null,
      note: input.note ?? null,
      createdBy: this.core.actor(principal),
      createdAt: at,
    });
    await this.core.write(principal, 'claim', row, 'claim_payment_recorded', `Payment of ${dollars(input.amountCents)} received ${input.receivedOn}`, {
      changes: [{ field: 'payments', old: null, new: paymentId }],
      at,
    });
    await this.upsertEntry(principal, row, `payment:${paymentId}`, 'insurer_payment_received', input.amountCents, `${row.number}: insurer payment received ${input.receivedOn}${input.reference ? ` (ref ${input.reference})` : ''}`);
    return this.get(principal, id);
  }

  async voidPayment(principal: Principal, id: string, paymentId: string, input: VoidInput): Promise<SafetyClaim> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const [payment] = await this.db
      .select()
      .from(safetyClaimPayments)
      .where(and(eq(safetyClaimPayments.companyId, principal.companyId), eq(safetyClaimPayments.claimId, id), eq(safetyClaimPayments.id, paymentId)))
      .limit(1);
    if (!payment) throw this.core.notFound('That payment');
    if (payment.voidedAt) throw this.core.refused('That payment is already void');
    const at = this.core.now();
    const bumped = await this.db
      .update(safetyClaims)
      .set({ version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning({ id: safetyClaims.id });
    if (bumped.length === 0) throw this.core.stale(row.number, row);
    await this.db
      .update(safetyClaimPayments)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason })
      .where(eq(safetyClaimPayments.id, payment.id));
    await this.core.write(principal, 'claim', row, 'claim_payment_voided', `Payment of ${dollars(payment.amountCents)} voided`, {
      changes: [{ field: 'payments', old: payment.id, new: null }],
      reason: input.reason,
      at,
    });
    // The suggestion follows: withdrawn while Accounting has not acted, reversed (a negative
    // suggestion) once it has.
    const [entry] = await this.db
      .select()
      .from(safetyAccountingEntries)
      .where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.sourceKey, `payment:${payment.id}`)))
      .limit(1);
    if (entry?.state === 'pending_review') {
      await this.db
        .update(safetyAccountingEntries)
        .set({ state: 'superseded', reviewNote: 'Payment voided before Accounting reviewed it', version: entry.version + 1, updatedAt: at })
        .where(eq(safetyAccountingEntries.id, entry.id));
    } else if (entry?.state === 'confirmed') {
      await this.upsertEntry(principal, row, `payment:${payment.id}:void`, 'insurer_payment_received', -payment.amountCents, `${row.number}: payment of ${dollars(payment.amountCents)} voided — reverse the confirmed entry`);
    }
    return this.get(principal, id);
  }

  async void(principal: Principal, id: string, input: VoidInput): Promise<SafetyClaim> {
    await this.charges.cancelForClaim(principal, id, input.reason);
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyClaims)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason, version: row.version + 1, updatedAt: at, lastActivityAt: at })
      .where(and(eq(safetyClaims.id, row.id), eq(safetyClaims.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'claim', row, 'claim_voided', `Voided ${row.number}`, { reason: input.reason, at });
    // Pending suggestions are withdrawn; confirmed ones stay for Accounting to reverse.
    await this.db
      .update(safetyAccountingEntries)
      .set({ state: 'superseded', reviewNote: 'Claim voided before Accounting reviewed it', updatedAt: at })
      .where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.claimId, row.id), eq(safetyAccountingEntries.state, 'pending_review')));
    if (row.accidentId) {
      const [accident] = await this.db.select().from(safetyAccidents).where(eq(safetyAccidents.id, row.accidentId)).limit(1);
      if (accident && accident.claimId === row.id) {
        await this.db.update(safetyAccidents).set({ claimId: null, claimNumber: null, version: accident.version + 1, updatedAt: at }).where(eq(safetyAccidents.id, accident.id));
        await this.core.write(principal, 'accident', accident, 'accident_claim_unlinked', `Claim ${row.number} voided`, { reason: input.reason, at });
      }
    }
    return this.get(principal, id);
  }

  // ------------------------------------------------------------------------- accounting entries

  /** The suggestions the claim's money calls for. Saving the same facts twice changes nothing. */
  private async syncEntries(principal: Principal, row: SafetyClaimRow): Promise<void> {
    if (row.decision && row.decision !== 'denied' && (row.approvedCents ?? 0) > 0) {
      await this.upsertEntry(principal, row, `claim:${row.id}:approved`, 'insurer_recovery_approved', row.approvedCents as number, `${row.number}: insurer approved ${dollars(row.approvedCents as number)}`);
    } else {
      await this.withdraw(principal, `claim:${row.id}:approved`);
    }
    if ((row.deductibleCents ?? 0) > 0) {
      await this.upsertEntry(principal, row, `claim:${row.id}:deductible`, 'company_deductible', row.deductibleCents as number, `${row.number}: company deductible`);
    } else {
      await this.withdraw(principal, `claim:${row.id}:deductible`);
    }
    if ((row.driverDeductionProposedCents ?? 0) > 0) {
      await this.upsertEntry(
        principal,
        row,
        `claim:${row.id}:driver_deduction`,
        'driver_deduction_proposal',
        row.driverDeductionProposedCents as number,
        `${row.number}: proposed driver deduction${row.driverName ? ` (${row.driverName})` : ''} — Accounting decides; nothing is deducted automatically`,
      );
    } else {
      await this.withdraw(principal, `claim:${row.id}:driver_deduction`);
    }
  }

  private async upsertEntry(principal: Principal, claim: SafetyClaimRow, key: string, kind: AccountingEntryKind, amountCents: number, memo: string): Promise<void> {
    const at = this.core.now();
    const [existing] = await this.db
      .select()
      .from(safetyAccountingEntries)
      .where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.sourceKey, key)))
      .limit(1);
    if (!existing) {
      await this.db
        .insert(safetyAccountingEntries)
        .values({ id: this.core.newId('sae'), companyId: principal.companyId, claimId: claim.id, claimNumber: claim.number, kind, amountCents, sourceKey: key, memo, createdAt: at, updatedAt: at })
        .onConflictDoNothing();
      await this.core.write(principal, 'claim', claim, 'claim_accounting_suggested', `Suggested for accounting: ${ACCOUNTING_ENTRY_KIND_LABEL[kind]} ${dollars(amountCents)}`, { at });
      return;
    }
    if (existing.amountCents === amountCents && existing.state !== 'superseded') return;
    if (existing.state === 'pending_review' || existing.state === 'superseded') {
      await this.db
        .update(safetyAccountingEntries)
        .set({ amountCents, memo, state: 'pending_review', reviewNote: null, version: existing.version + 1, updatedAt: at })
        .where(eq(safetyAccountingEntries.id, existing.id));
      await this.core.write(principal, 'claim', claim, 'claim_accounting_suggested', `Suggestion revised: ${ACCOUNTING_ENTRY_KIND_LABEL[kind]} ${dollars(amountCents)}`, {
        changes: [{ field: 'accounting.amountCents', old: String(existing.amountCents), new: String(amountCents) }],
        at,
      });
      return;
    }
    // Accounting already acted on the old amount: the change is a new suggestion beside it,
    // keyed on the new amount so saving it again is still one entry.
    const revisedKey = `${key}@${amountCents}`;
    const inserted = await this.db
      .insert(safetyAccountingEntries)
      .values({
        id: this.core.newId('sae'),
        companyId: principal.companyId,
        claimId: claim.id,
        claimNumber: claim.number,
        kind,
        amountCents,
        sourceKey: revisedKey,
        memo: `${memo} (revised after Accounting ${existing.state} ${dollars(existing.amountCents)})`,
        createdAt: at,
        updatedAt: at,
      })
      .onConflictDoNothing()
      .returning({ id: safetyAccountingEntries.id });
    if (inserted.length > 0) {
      await this.core.write(principal, 'claim', claim, 'claim_accounting_suggested', `Revised suggestion for accounting: ${ACCOUNTING_ENTRY_KIND_LABEL[kind]} ${dollars(amountCents)}`, { at });
    }
  }

  private async withdraw(principal: Principal, keyPrefix: string): Promise<void> {
    const at = this.core.now();
    await this.db
      .update(safetyAccountingEntries)
      .set({ state: 'superseded', reviewNote: 'Withdrawn: the claim no longer calls for it', updatedAt: at })
      .where(
        and(
          eq(safetyAccountingEntries.companyId, principal.companyId),
          like(safetyAccountingEntries.sourceKey, `${keyPrefix}%`),
          eq(safetyAccountingEntries.state, 'pending_review'),
        ),
      );
  }

  /** The Accounting review queue. */
  async accountingEntries(principal: Principal, query: { state?: AccountingEntryState } = {}): Promise<SafetyAccountingEntry[]> {
    const parts = [eq(safetyAccountingEntries.companyId, principal.companyId)];
    if (query.state) parts.push(eq(safetyAccountingEntries.state, query.state));
    const rows = await this.db.select().from(safetyAccountingEntries).where(and(...parts)).orderBy(desc(safetyAccountingEntries.createdAt));
    return rows.map(toEntry);
  }

  /** Accounting's decision. Confirming records agreement; the ledger posting stays in Accounting. */
  async reviewEntry(principal: Principal, id: string, decision: 'confirmed' | 'rejected', input: ReviewAccountingEntryInput): Promise<SafetyAccountingEntry> {
    if (!hasPermission(principal, 'accounting.edit')) {
      throw this.core.forbidden('Confirming or rejecting an entry takes accounting.edit');
    }
    const [kindRow] = await this.db.select({ kind: safetyAccountingEntries.kind }).from(safetyAccountingEntries).where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.id, id))).limit(1);
    if (kindRow?.kind === 'driver_charge') throw this.core.refused('A driver charge is approved or rejected on its charge card, with the checklist');
    const [row] = await this.db
      .select()
      .from(safetyAccountingEntries)
      .where(and(eq(safetyAccountingEntries.companyId, principal.companyId), eq(safetyAccountingEntries.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That accounting entry');
    if (row.version !== input.version) throw this.core.stale('The entry', row);
    if (row.state !== 'pending_review') throw this.core.refused(`The entry is already ${row.state.replace('_', ' ')}`);
    if (decision === 'rejected' && !(input.note ?? '').trim()) throw this.core.invalid('Say why the entry is rejected');
    const at = this.core.now();
    const updated = await this.db
      .update(safetyAccountingEntries)
      .set({ state: decision, reviewedAt: at, reviewedBy: this.core.actor(principal), reviewNote: input.note ?? null, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyAccountingEntries.id, row.id), eq(safetyAccountingEntries.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale('The entry', row);
    await this.core.write(principal, 'claim', { id: row.claimId, number: row.claimNumber }, `claim_accounting_${decision}`, `Accounting ${decision} ${ACCOUNTING_ENTRY_KIND_LABEL[row.kind as AccountingEntryKind]} ${dollars(row.amountCents)}`, {
      reason: input.note ?? null,
      at,
    });
    return toEntry(updated[0] as SafetyAccountingEntryRow);
  }
}

/**
 * Accident & Claims v2 (P2): a bodily-injury claim marked restricted keeps its money, payments and adjuster from a
 * caller without accidents.restricted on these endpoints too (API.md §4, SPEC §7.13 rule 7). Only v2 sets the flag,
 * so every claim written before it reads exactly as before.
 */
function redactRestricted(principal: Principal, row: SafetyClaimRow, claim: SafetyClaim): SafetyClaim {
  if (!row.restricted || hasPermission(principal, 'accidents.restricted')) return claim;
  return {
    ...claim,
    description: 'Restricted claim',
    adjusterName: null,
    adjusterPhone: null,
    adjusterEmail: null,
    claimedCents: null,
    approvedCents: null,
    deductibleCents: null,
    receivedCents: 0,
    remainingApprovedCents: null,
    driverDeductionProposedCents: null,
    driverDeductionNote: null,
    payments: [],
    accountingEntries: [],
  };
}

function toPayment(row: SafetyClaimPaymentRow): SafetyClaimPayment {
  return {
    id: row.id,
    receivedOn: row.receivedOn,
    amountCents: row.amountCents,
    method: row.method,
    reference: row.reference,
    note: row.note,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    voidedAt: iso(row.voidedAt),
    voidReason: row.voidReason,
  };
}

function toEntry(row: SafetyAccountingEntryRow): SafetyAccountingEntry {
  return {
    id: row.id,
    claimId: row.claimId,
    claimNumber: row.claimNumber,
    kind: row.kind as AccountingEntryKind,
    amountCents: row.amountCents,
    state: row.state as AccountingEntryState,
    sourceKey: row.sourceKey,
    memo: row.memo,
    createdAt: row.createdAt.toISOString(),
    reviewedAt: iso(row.reviewedAt),
    reviewedBy: row.reviewedBy,
    reviewNote: row.reviewNote,
    version: row.version,
  };
}

export function dollars(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  return `${sign}$${(Math.abs(cents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
