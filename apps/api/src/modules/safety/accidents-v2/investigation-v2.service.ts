import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { accidentsV2 as A, safetyRules as R } from '@neway/shared';
import { hasPermission, type Principal } from '../../../common/auth/principal';
import { AppError } from '../../../common/errors/app-error';
import { DatabaseService } from '../../../database/database.service';
import {
  accidentFactors,
  accidentFacts,
  accidentOtherVehicles,
  accidentQuestions,
  accidentRestricted,
  accidentReviewItems,
  accidentStatements,
  accidentWitnesses,
  restrictedAccessLog,
  safetyDocumentVersions,
  safetyTimelineEvents,
} from '../../../database/schema/accidents-v2';
import { safetyAccidents, safetyCaseDocuments, safetyReviews } from '../../../database/schema/safety';
import { FilesService } from '../../files/files.service';
import { AuditService, type AuditEvent } from '../../people/audit.service';
import { SafetyCoreService } from '../safety-core.service';
import { AccidentsV2Service, type CaseEvent } from './accidents-v2.service';
import { evidenceItem } from './investigation-views';
import { evidenceCategory } from './mapping';

function forbidden(permission: string, detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', type: '/problems/forbidden', detail, extensions: { permission } });
}
function invalid(errors: { path: string; message: string }[]): AppError {
  return new AppError({ status: 422, title: 'Unprocessable Entity', type: '/problems/validation', detail: errors.map((e) => e.message).join('; '), extensions: { errors } });
}

const VALUES = {
  fault: A.FAULT_VALUES as readonly string[],
  preventability: A.PREVENT_VALUES as readonly string[],
  cpdp: A.CPDP_VALUES as readonly string[],
  legal: A.LEGAL_VALUES as readonly string[],
};
const LABELS = { fault: 'Driver fault', preventability: 'Preventability', cpdp: 'FMCSA CPDP', legal: 'Legal liability' } as const;
const CA_STATUS: Record<(typeof A.CORRECTIVE_STATUSES)[number], string> = { Open: 'not_started', 'In progress': 'in_progress', Completed: 'completed', Waived: 'waived' };

/**
 * Investigation, determinations, corrective actions and evidence (Accident & Claims v2, phase P4; SPEC §1.4, §8).
 * Every change goes through the case's own versioned, audited write. Determinations are recorded human decisions:
 * nothing here derives one from another or from the accident type. Evidence is never deleted — versions are
 * immutable rows, removal is a reason on the record, a legal hold refuses it (and the database refuses it too).
 */
@Injectable()
export class InvestigationV2Service {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly audit: AuditService,
    private readonly accidents: AccidentsV2Service,
    private readonly files: FilesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** Writes one restricted-access log row (SPEC §8.3, ACCEPTANCE K7). */
  async logAccess(p: Principal, resource: string, refs: { accidentId?: string | null; claimId?: string | null }): Promise<void> {
    await this.db.insert(restrictedAccessLog).values({
      id: this.core.newId('ral'),
      companyId: p.companyId,
      at: this.core.now(),
      actorId: p.userId,
      actorName: this.core.actor(p),
      accidentId: refs.accidentId ?? null,
      claimId: refs.claimId ?? null,
      resource,
    });
  }

  // ===================================================================================== investigation

  async action(p: Principal, id: string, action: 'start' | 'submit' | 'approve' | 'send-back' | 'reopen', input: A.InvestigationActionInput): Promise<{ id: string; version: number }> {
    if ((action === 'approve' || action === 'send-back') && !hasPermission(p, 'accidents.approve'))
      throw forbidden('accidents.approve', 'An investigation is approved by a Safety Manager or the owner');
    const owner = input.ownerId ? await this.core.person(p.companyId, input.ownerId) : null;
    return this.accidents.write(p, id, input.version, `accident_investigation_${action.replace('-', '_')}`, async (row, _tx, at) => {
      const st = row.investigationStatus;
      const actor = this.core.actor(p);
      const ev = (text: string, kind: CaseEvent['kind'] = 'milestone'): CaseEvent[] => [{ text, source: 'Safety', kind, logged: at }];
      switch (action) {
        case 'start':
          if (st !== 'not_started') throw this.core.refused('The investigation has already started');
          return { patch: { investigationStatus: 'in_progress', investigationOwnerId: owner?.id ?? row.investigationOwnerId ?? p.userId }, summary: 'Investigation started', events: ev(`Investigation started — owner ${owner?.name ?? actor}`) };
        case 'submit': {
          if (st !== 'in_progress') throw this.core.refused('Only an investigation in progress can be submitted');
          const missing = [
            !row.investigationConclusion?.trim() ? 'Write a conclusion' : null,
            !row.fault || ['not_determined', 'undetermined', ''].includes(row.fault) ? 'Record driver fault' : null,
            !row.preventability || ['not_determined', 'undetermined', ''].includes(row.preventability) ? 'Record preventability' : null,
          ].filter((x): x is string => Boolean(x));
          if (missing.length) throw invalid(missing.map((m) => ({ path: 'investigation', message: m })));
          return { patch: { investigationStatus: 'in_review', investigationSubmittedBy: actor, investigationSubmittedAt: at }, summary: 'Investigation submitted for approval', events: ev('Investigation submitted for management approval') };
        }
        case 'approve': {
          if (st !== 'in_review') throw this.core.refused('Only an investigation awaiting approval can be approved');
          // Go-live decision (IMPLEMENTATION-PLAN §17): a small team, so the Safety Manager who ran the investigation may
          // approve it — but the approval says so, in the audit entry and on the timeline.
          const self = row.investigationOwnerId === p.userId || row.investigationSubmittedBy === actor;
          const how = self ? ' (self-approved: the approver ran this investigation)' : '';
          return {
            patch: { investigationStatus: 'complete', investigationApprovedBy: actor, investigationCompletedAt: at },
            summary: `Investigation approved by ${actor}${how}`,
            reason: [self ? 'Self-approved' : null, input.note ?? null].filter(Boolean).join(' — ') || null,
            events: ev(`Investigation approved by ${actor}${how}`),
          };
        }
        case 'send-back':
          if (st !== 'in_review') throw this.core.refused('Only an investigation awaiting approval can be sent back');
          return { patch: { investigationStatus: 'in_progress' }, summary: 'Investigation sent back for more work', reason: input.note ?? null, events: ev(`Investigation sent back for more work${input.note ? ` — ${input.note}` : ''}`) };
        case 'reopen':
          if (st !== 'complete') throw this.core.refused('Only a completed investigation can be reopened');
          if (!input.reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why the investigation is reopened' }]);
          return { patch: { investigationStatus: 'in_progress', investigationCompletedAt: null, investigationApprovedBy: null }, summary: `Investigation reopened: ${input.reason}`, reason: input.reason, events: ev(`Investigation reopened — ${input.reason}`) };
      }
    });
  }

  async patch(p: Principal, id: string, input: A.PatchInvestigationInput): Promise<{ id: string; version: number }> {
    const owner = input.ownerId ? await this.core.person(p.companyId, input.ownerId) : null;
    return this.accidents.write(p, id, input.version, 'accident_investigation_updated', async (row, _tx, at) => {
      if (row.investigationStatus === 'complete') throw this.core.refused('The investigation is approved; reopen it to change it');
      const patch: Partial<typeof safetyAccidents.$inferInsert> = {};
      if (input.conclusion !== undefined) patch.investigationConclusion = input.conclusion;
      if (input.ownerId !== undefined) patch.investigationOwnerId = owner?.id ?? null;
      return { patch, summary: input.conclusion !== undefined ? 'Conclusion updated' : 'Investigation owner changed', events: [{ text: input.conclusion !== undefined ? 'Conclusion updated' : `Investigator: ${owner?.name ?? 'none'}`, source: 'Safety', kind: 'change', logged: at }] };
    });
  }

  /** A record under the investigation (fact, question, statement, factor, review item, vehicle, witness): one case write. */
  private async record(p: Principal, id: string, version: number, action: string, insert: (tx: Parameters<Parameters<AccidentsV2Service['write']>[4]>[1], at: Date, row: typeof safetyAccidents.$inferSelect) => Promise<{ text: string; restricted?: boolean; startInvestigation?: boolean }>) {
    return this.accidents.write(p, id, version, action, async (row, tx, at) => {
      const r = await insert(tx, at, row);
      const patch: Partial<typeof safetyAccidents.$inferInsert> = r.startInvestigation && row.investigationStatus === 'not_started' ? { investigationStatus: 'in_progress', investigationOwnerId: row.investigationOwnerId ?? p.userId } : {};
      return { patch, summary: r.restricted ? 'Restricted record added' : r.text, events: [{ text: r.text, source: 'Safety', kind: 'change', logged: at, restricted: r.restricted ?? false }] };
    });
  }

  addFact(p: Principal, id: string, input: A.AddFactInput) {
    return this.record(p, id, input.version, 'accident_fact_added', async (tx, at) => {
      await tx.insert(accidentFacts).values({ id: this.core.newId('afc'), companyId: p.companyId, accidentId: id, text: input.text, source: input.source?.trim() || 'Investigator', provenance: input.provenance, createdBy: this.core.actor(p), createdAt: at });
      return { text: `Fact added: ${input.text}`, startInvestigation: true };
    });
  }

  async addQuestion(p: Principal, id: string, input: A.AddQuestionInput) {
    const owner = input.ownerId ? await this.core.person(p.companyId, input.ownerId) : null;
    return this.record(p, id, input.version, 'accident_question_added', async (tx, at) => {
      await tx.insert(accidentQuestions).values({ id: this.core.newId('aqn'), companyId: p.companyId, accidentId: id, text: input.text, ownerId: owner?.id ?? null, ownerName: owner?.name ?? null, createdBy: this.core.actor(p), createdAt: at });
      return { text: `Open question added: ${input.text}${owner ? ` (${owner.name})` : ''}` };
    });
  }

  resolveQuestion(p: Principal, id: string, qid: string, input: A.ResolveQuestionInput) {
    return this.record(p, id, input.version, 'accident_question_resolved', async (tx, at) => {
      const [q] = await tx.select().from(accidentQuestions).where(and(eq(accidentQuestions.companyId, p.companyId), eq(accidentQuestions.accidentId, id), eq(accidentQuestions.id, qid))).limit(1);
      if (!q) throw this.core.notFound('That question');
      if (q.resolvedAt) throw this.core.refused('That question is already resolved');
      await tx.update(accidentQuestions).set({ answer: input.answer, resolvedAt: at, resolvedBy: this.core.actor(p), version: q.version + 1 }).where(eq(accidentQuestions.id, qid));
      return { text: `Question resolved: ${q.text} — ${input.answer}` };
    });
  }

  addStatement(p: Principal, id: string, input: A.AddStatementInput) {
    return this.record(p, id, input.version, 'accident_statement_added', async (tx, at) => {
      if (input.takenAt && Date.parse(input.takenAt) > at.getTime() + 5 * 60_000) throw invalid([{ path: 'takenAt', message: 'The statement time is in the future' }]);
      await tx.insert(accidentStatements).values({ id: this.core.newId('ast'), companyId: p.companyId, accidentId: id, party: input.party, kind: input.kind, summary: input.summary, takenAt: input.takenAt ? new Date(input.takenAt) : at, takenBy: this.core.actor(p), createdAt: at });
      return { text: `Statement recorded: ${input.party} (${input.kind})`, startInvestigation: true };
    });
  }

  addFactor(p: Principal, id: string, input: A.AddFactorInput) {
    return this.record(p, id, input.version, 'accident_factor_added', async (tx, at) => {
      await tx.insert(accidentFactors).values({ id: this.core.newId('afa'), companyId: p.companyId, accidentId: id, category: input.category, label: input.label, createdBy: this.core.actor(p), createdAt: at, updatedAt: at });
      return { text: `Contributing factor added: ${input.label} (possible)` };
    });
  }

  factorLevel(p: Principal, id: string, fid: string, input: A.FactorLevelInput) {
    return this.record(p, id, input.version, 'accident_factor_changed', async (tx, at) => {
      const [f] = await tx.select().from(accidentFactors).where(and(eq(accidentFactors.companyId, p.companyId), eq(accidentFactors.accidentId, id), eq(accidentFactors.id, fid))).limit(1);
      if (!f) throw this.core.notFound('That factor');
      await tx.update(accidentFactors).set({ level: input.level, version: f.version + 1, updatedAt: at }).where(eq(accidentFactors.id, fid));
      return { text: `Factor “${f.label}” → ${input.level === 'ruled_out' ? 'ruled out' : input.level}` };
    });
  }


  reviewItem(p: Principal, id: string, key: string, input: A.ReviewItemInput) {
    if (input.restricted && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Restricted review items are kept by Safety Managers');
    return this.record(p, id, input.version, 'accident_review_item', async (tx, at) => {
      const [it] = await tx.select().from(accidentReviewItems).where(and(eq(accidentReviewItems.companyId, p.companyId), eq(accidentReviewItems.accidentId, id), eq(accidentReviewItems.key, key))).limit(1);
      if (it?.restricted && input.note !== undefined && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'This item’s note is restricted');
      if (!it) {
        if (!input.label) throw invalid([{ path: 'label', message: 'Name the item to review' }]);
        const count = (await tx.select({ n: sql<number>`count(*)::int` }).from(accidentReviewItems).where(and(eq(accidentReviewItems.companyId, p.companyId), eq(accidentReviewItems.accidentId, id))))[0]?.n ?? 0;
        await tx.insert(accidentReviewItems).values({ id: this.core.newId('ari'), companyId: p.companyId, accidentId: id, key, label: input.label, state: input.state ?? 'pending', note: input.note ?? null, restricted: input.restricted ?? false, sort: count, updatedBy: this.core.actor(p), updatedAt: at });
        return { text: `Review item added: ${input.label}`, restricted: input.restricted ?? false };
      }
      await tx
        .update(accidentReviewItems)
        .set({ ...(input.state ? { state: input.state } : {}), ...(input.note !== undefined ? { note: input.note } : {}), ...(input.label ? { label: input.label } : {}), version: it.version + 1, updatedBy: this.core.actor(p), updatedAt: at })
        .where(eq(accidentReviewItems.id, it.id));
      return { text: `Evidence review “${it.label}”: ${input.state ? input.state.replace('_', ' ') : 'updated'}`, restricted: it.restricted && input.note !== undefined };
    });
  }

  addVehicle(p: Principal, id: string, input: A.AddVehicleInput) {
    return this.record(p, id, input.version, 'accident_vehicle_added', async (tx, at) => {
      await tx.insert(accidentOtherVehicles).values({ id: this.core.newId('aov'), companyId: p.companyId, accidentId: id, description: input.description, ownerName: input.ownerName ?? null, driverName: input.driverName ?? null, insurer: input.insurer ?? null, policyNo: input.policyNo ?? null, plate: input.plate ?? null, damage: input.damage ?? null, towed: input.towed ?? null, createdBy: this.core.actor(p), createdAt: at });
      return { text: `Vehicle added: ${input.description}` };
    });
  }

  addWitness(p: Principal, id: string, input: A.AddWitnessInput) {
    return this.record(p, id, input.version, 'accident_witness_added', async (tx, at) => {
      await tx.insert(accidentWitnesses).values({ id: this.core.newId('awt'), companyId: p.companyId, accidentId: id, name: input.name, contact: input.contact ?? null, note: input.note ?? null, createdBy: this.core.actor(p), createdAt: at });
      return { text: `Witness added: ${input.name}` };
    });
  }

  // ===================================================================================== determinations

  /** J4–J7: a recorded human decision. Never derived from another determination or from the accident type. */
  async determination(p: Principal, id: string, kind: 'fault' | 'preventability' | 'cpdp' | 'legal', input: A.DeterminationInput): Promise<{ id: string; version: number }> {
    if (kind === 'legal' ? !hasPermission(p, 'accidents.legal') : !hasPermission(p, 'accidents.determine'))
      throw forbidden(kind === 'legal' ? 'accidents.legal' : 'accidents.determine', kind === 'legal' ? 'Legal liability is recorded by Safety Managers and the owner' : 'Fault, preventability and CPDP are recorded by Safety Managers, Operations Managers and the owner');
    if (!VALUES[kind].includes(input.value)) throw invalid([{ path: 'value', message: `Not a ${LABELS[kind]} value` }]);
    if (kind === 'cpdp') {
      const { c } = await this.accidents.ruleCase(p, id);
      const dot = R.dotRecordable(c).value;
      if (dot !== 'yes') throw invalid([{ path: 'value', message: `Only crashes that are DOT-reportable can be reviewed. Current: ${dot === 'no' ? 'not recordable' : 'recordability not determined'}.` }]);
      if (input.value === 'submitted' && !(input.rdr?.trim() || c.determinations.cpdp.rdr)) throw invalid([{ path: 'rdr', message: 'Enter the DataQs RDR number' }]);
    }
    const actor = this.core.actor(p);
    return this.accidents.write(p, id, input.version, `accident_determination_${kind}`, async (row, tx, at) => {
      let patch: Partial<typeof safetyAccidents.$inferInsert> = {};
      let restricted = false;
      if (kind === 'fault') patch = { fault: input.value, faultBasis: input.basis ?? row.faultBasis, faultBy: actor, faultAt: at };
      if (kind === 'preventability') patch = { preventability: input.value, preventabilityNote: input.basis ?? row.preventabilityNote, preventabilityBy: actor, preventabilityAt: at };
      if (kind === 'cpdp') patch = { cpdpStatus: input.value, cpdpBasis: input.basis ?? row.cpdpBasis, cpdpRdr: input.rdr?.trim() || row.cpdpRdr, cpdpBy: actor, cpdpAt: at };
      if (kind === 'legal') {
        restricted = true;
        await tx
          .insert(accidentRestricted)
          .values({ accidentId: id, companyId: p.companyId, legalLiability: input.value, legalBasis: input.basis ?? null, legalBy: actor, legalAt: at, updatedAt: at })
          .onConflictDoUpdate({ target: accidentRestricted.accidentId, set: { legalLiability: input.value, legalBasis: input.basis ?? null, legalBy: actor, legalAt: at, updatedAt: at, version: sql`${accidentRestricted.version} + 1` } });
      }
      const text = `${LABELS[kind]}: ${input.value.replace(/_/g, ' ')}${input.basis ? ` — ${input.basis}` : ''}${kind === 'cpdp' && input.rdr ? ` (${input.rdr})` : ''}`;
      return { patch, summary: restricted ? 'Legal liability recorded (restricted)' : text, events: [{ text, source: 'Safety', kind: 'change', logged: at, restricted }] };
    });
  }

  // ===================================================================================== corrective actions

  /** J8/J9: a corrective action is a safety_reviews row linked by accident_id (shows on Safety review and the driver profile). */
  async createCorrectiveAction(p: Principal, id: string, input: A.CreateCorrectiveActionInput): Promise<{ id: string; number: string }> {
    const disciplinary = input.kind === 'Disciplinary review';
    if (disciplinary && !hasPermission(p, 'accidents.discipline')) throw forbidden('accidents.discipline', 'Restricted personnel action: disciplinary reviews are created by the Safety Manager or the owner');
    const assignee = await this.core.person(p.companyId, input.assigneeId);
    const rid = this.core.newId('rev');
    const number = await this.core.nextNumber(p.companyId, 'safety_review');
    await this.accidents.write(p, id, input.version, 'accident_corrective_action_added', async (row, tx, at) => {
      await tx.insert(safetyReviews).values({
        id: rid,
        companyId: p.companyId,
        number,
        ownerId: p.userId,
        ownerName: this.core.actor(p),
        isTest: row.isTest,
        createdBy: this.core.actor(p),
        createdAt: at,
        updatedAt: at,
        kind: input.kind === 'Coaching' ? 'coaching' : 'corrective_action',
        reason: input.title,
        driverId: input.driverId ?? row.driverId,
        driverName: row.driverName,
        status: 'not_started',
        accidentId: id,
        actionKind: input.kind,
        dueAt: new Date(input.dueAt),
        assigneeId: assignee?.id ?? null,
        assigneeName: assignee?.name ?? null,
        restricted: disciplinary,
      });
      const text = disciplinary ? 'Disciplinary review opened (restricted)' : `Corrective action assigned: ${input.kind} — ${input.title}`;
      return { patch: {}, summary: text, events: [{ text, source: 'Safety', kind: 'task', logged: at, restricted: disciplinary }] };
    });
    return { id: rid, number };
  }

  async patchCorrectiveAction(p: Principal, actionId: string, input: A.PatchCorrectiveActionInput): Promise<{ id: string; version: number }> {
    const [ca] = await this.db.select().from(safetyReviews).where(and(eq(safetyReviews.companyId, p.companyId), eq(safetyReviews.id, actionId))).limit(1);
    if (!ca || !ca.accidentId) throw this.core.notFound('That corrective action');
    if (ca.restricted && !hasPermission(p, 'accidents.discipline')) throw forbidden('accidents.discipline', 'Restricted personnel action');
    if (ca.version !== input.version) throw new AppError({ status: 409, title: 'Conflict', type: '/problems/version-conflict', detail: `${ca.number} was changed by someone else. Reload it.`, extensions: { currentVersion: ca.version } });
    if (input.status === 'Waived' && !input.reason?.trim()) throw invalid([{ path: 'reason', message: 'Say why it is waived' }]);
    const assignee = input.assigneeId ? await this.core.person(p.companyId, input.assigneeId) : null;
    const at = this.core.now();
    const audits: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      const patch: Partial<typeof safetyReviews.$inferInsert> = {};
      if (input.status === 'Waived') Object.assign(patch, { voidedAt: at, voidedBy: this.core.actor(p), voidReason: `Waived: ${input.reason}` });
      else if (input.status) Object.assign(patch, { status: CA_STATUS[input.status], ...(input.status === 'Completed' ? { completedAt: at, completedBy: this.core.actor(p) } : { completedAt: null, completedBy: null }), voidedAt: null });
      if (input.completionEvidence !== undefined) patch.evidenceNote = input.completionEvidence;
      if (assignee) Object.assign(patch, { assigneeId: assignee.id, assigneeName: assignee.name });
      if (input.dueAt) patch.dueAt = new Date(input.dueAt);
      const upd = await tx
        .update(safetyReviews)
        .set({ ...patch, version: ca.version + 1, updatedAt: at })
        .where(and(eq(safetyReviews.id, actionId), eq(safetyReviews.version, ca.version)))
        .returning({ id: safetyReviews.id });
      if (!upd.length) throw new AppError({ status: 409, title: 'Conflict', type: '/problems/version-conflict', detail: `${ca.number} was changed by someone else. Reload it.` });
      const text = ca.restricted ? 'Disciplinary review updated (restricted)' : `Corrective action “${ca.reason}”: ${input.status ?? 'updated'}`;
      await tx.insert(safetyTimelineEvents).values({ id: this.core.newId('evt'), companyId: p.companyId, accidentId: ca.accidentId, occurredAt: at, loggedAt: at, actorId: p.userId, actorName: this.core.actor(p), source: 'Safety', kind: 'task', text, restricted: ca.restricted });
      await tx.update(safetyAccidents).set({ updatedAt: at, version: sql`${safetyAccidents.version} + 1` }).where(eq(safetyAccidents.id, ca.accidentId as string));
      audits.push(await this.audit.writeIn(tx, p, { action: 'safety_review_updated', entityType: 'safety_review', entityId: ca.id, entityLabel: ca.number, summary: text, changes: Object.keys(patch).map((f) => ({ field: f, old: null, new: String((patch as Record<string, unknown>)[f] ?? '') })), reason: input.reason ?? null, at }));
    });
    await this.audit.publish(...audits);
    return { id: actionId, version: ca.version + 1 };
  }

  // ===================================================================================== evidence

  async evidence(p: Principal, id: string, includeRemoved: boolean): Promise<A.EvidenceListResponse> {
    const acc = await this.accidents.row(p.companyId, id, { allowVoided: true });
    const can = hasPermission(p, 'accidents.restricted');
    const docs = await this.db
      .select()
      .from(safetyCaseDocuments)
      .where(and(eq(safetyCaseDocuments.companyId, p.companyId), eq(safetyCaseDocuments.caseType, 'accident'), eq(safetyCaseDocuments.caseId, id)))
      .orderBy(asc(safetyCaseDocuments.uploadedAt));
    const versions = docs.length ? await this.db.select().from(safetyDocumentVersions).where(and(eq(safetyDocumentVersions.companyId, p.companyId), inArray(safetyDocumentVersions.documentId, docs.map((d) => d.id)))) : [];
    const items = docs.map((d) => evidenceItem(d, evidenceCategory(d), versions.filter((v) => v.documentId === d.id), can));
    const counts: Record<string, number> = {};
    for (const it of items) if (!it.removed) counts[it.category] = (counts[it.category] ?? 0) + 1;
    if (can && items.some((x) => x.restricted)) await this.logAccess(p, 'accident.evidence.list', { accidentId: id });
    return {
      items: items.filter((x) => includeRemoved || !x.removed),
      counts,
      legalHold: acc.legalHoldSince ? { since: acc.legalHoldSince.toISOString(), by: acc.legalHoldBy ?? '', reason: acc.legalHoldReason ?? '' } : null,
    };
  }

  private async fileFor(p: Principal, fileId: string) {
    const { info, bytes } = await this.files.read(p.companyId, fileId);
    return { info, sha256: createHash('sha256').update(bytes).digest('hex') };
  }

  /** K1: one or more files with a category and description; uploader, time, size and SHA-256 recorded. */
  async upload(p: Principal, id: string, input: A.UploadEvidenceInput): Promise<{ ids: string[] }> {
    const restricted = input.restricted || (A.RESTRICTED_EVIDENCE as readonly string[]).includes(input.category);
    if (restricted && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'Restricted evidence (medical, legal, test records) is added by Safety Managers and the owner');
    const files = await Promise.all(input.files.map((f) => this.fileFor(p, f.fileId)));
    const ids: string[] = [];
    await this.accidents.write(p, id, input.version, 'accident_evidence_added', async (_row, tx, at) => {
      for (const f of files) {
        const docId = this.core.newId('sdoc');
        ids.push(docId);
        await tx.insert(safetyCaseDocuments).values({
          id: docId,
          companyId: p.companyId,
          caseType: 'accident',
          caseId: id,
          fileId: f.info.id,
          fileName: f.info.fileName,
          contentType: f.info.contentType,
          sizeBytes: f.info.sizeBytes,
          title: f.info.fileName,
          kind: input.category === 'Police report' ? 'police_report' : input.category.endsWith('photo') ? 'photos' : 'other',
          category: input.category,
          description: input.description ?? null,
          restricted,
          uploadedBy: this.core.actor(p),
          uploadedAt: at,
          currentVersion: 1,
          sha256: f.sha256,
        });
        await tx.insert(safetyDocumentVersions).values({ id: this.core.newId('sdv'), companyId: p.companyId, documentId: docId, version: 1, fileId: f.info.id, fileName: f.info.fileName, contentType: f.info.contentType, sizeBytes: f.info.sizeBytes, sha256: f.sha256, note: 'Original upload', uploadedBy: this.core.actor(p), uploadedAt: at });
      }
      const text = files.length === 1 ? `Evidence added: ${files[0]!.info.fileName} (${input.category})` : `Evidence added: ${files.length} files (${input.category})`;
      return { patch: {}, summary: restricted ? `Restricted evidence added (${input.category})` : text, events: [{ text, source: 'Safety', kind: 'change', logged: at, restricted }] };
    });
    return { ids };
  }

  private async doc(p: Principal, docId: string) {
    const [d] = await this.db.select().from(safetyCaseDocuments).where(and(eq(safetyCaseDocuments.companyId, p.companyId), eq(safetyCaseDocuments.id, docId))).limit(1);
    if (!d || d.caseType !== 'accident') throw this.core.notFound('That evidence');
    const restricted = d.restricted || (A.RESTRICTED_EVIDENCE as readonly string[]).includes(evidenceCategory(d));
    if (restricted && !hasPermission(p, 'accidents.restricted')) throw forbidden('accidents.restricted', 'This document is restricted');
    return { d, restricted };
  }

  /** K2: a new immutable version (note required); earlier versions stay downloadable. */
  async newVersion(p: Principal, docId: string, input: A.EvidenceVersionInput): Promise<{ id: string; version: number }> {
    const { d, restricted } = await this.doc(p, docId);
    if (d.voidedAt) throw this.core.refused('This evidence was removed from the case');
    const f = await this.fileFor(p, input.fileId);
    const acc = await this.accidents.row(p.companyId, d.caseId);
    let next = d.currentVersion + 1;
    await this.accidents.write(p, d.caseId, acc.version, 'accident_evidence_version', async (_row, tx, at) => {
      const existing = await tx.select({ v: safetyDocumentVersions.version }).from(safetyDocumentVersions).where(eq(safetyDocumentVersions.documentId, docId));
      if (!existing.length) {
        // A document filed before versions existed: its original becomes v1, kept as it is.
        const orig = await this.fileFor(p, d.fileId).catch(() => null);
        await tx.insert(safetyDocumentVersions).values({ id: this.core.newId('sdv'), companyId: p.companyId, documentId: docId, version: 1, fileId: d.fileId, fileName: d.fileName, contentType: d.contentType, sizeBytes: d.sizeBytes, sha256: orig?.sha256 ?? d.sha256 ?? '', note: 'Original upload', uploadedBy: d.uploadedBy, uploadedAt: d.uploadedAt });
      }
      next = Math.max(d.currentVersion, ...existing.map((x) => x.v)) + 1;
      await tx.insert(safetyDocumentVersions).values({ id: this.core.newId('sdv'), companyId: p.companyId, documentId: docId, version: next, fileId: f.info.id, fileName: f.info.fileName, contentType: f.info.contentType, sizeBytes: f.info.sizeBytes, sha256: f.sha256, note: input.note, uploadedBy: this.core.actor(p), uploadedAt: at });
      await tx.update(safetyCaseDocuments).set({ currentVersion: next, fileId: f.info.id, fileName: f.info.fileName, contentType: f.info.contentType, sizeBytes: f.info.sizeBytes }).where(eq(safetyCaseDocuments.id, docId));
      const text = `New version (v${next}) of ${d.title}: ${input.note}. Earlier versions kept.`;
      return { patch: {}, summary: restricted ? `New version of restricted evidence (v${next})` : text, events: [{ text, source: 'Safety', kind: 'change', logged: at, restricted }] };
    });
    return { id: docId, version: next };
  }

  /** K3/K4: removal hides it with a reason — never a delete; a legal hold refuses it (409, and the database trigger). */
  async remove(p: Principal, docId: string, input: A.RemoveEvidenceInput): Promise<{ id: string }> {
    const { d, restricted } = await this.doc(p, docId);
    if (d.voidedAt) throw this.core.refused('Already removed from the case');
    const acc = await this.accidents.row(p.companyId, d.caseId);
    if (acc.legalHoldSince) {
      throw new AppError({ status: 409, title: 'Conflict', type: '/problems/legal-hold', detail: `Legal hold since ${acc.legalHoldSince.toISOString()}: nothing on ${acc.number} can be removed.`, extensions: { since: acc.legalHoldSince.toISOString(), by: acc.legalHoldBy, reason: acc.legalHoldReason } });
    }
    await this.accidents.write(p, d.caseId, acc.version, 'accident_evidence_removed', async (_row, tx, at) => {
      await tx.update(safetyCaseDocuments).set({ voidedAt: at, voidedBy: this.core.actor(p), voidReason: input.reason }).where(eq(safetyCaseDocuments.id, docId));
      const text = `${d.title} removed from the case view — reason: ${input.reason}. File retained.`;
      return { patch: {}, summary: restricted ? 'Restricted evidence removed from view' : text, reason: input.reason, events: [{ text, source: 'Safety', kind: 'change', logged: at, restricted }] };
    });
    return { id: docId };
  }

  /** The file of one version (default the latest) for download through /files/:id; restricted reads are logged. */
  async download(p: Principal, docId: string, version?: number): Promise<{ fileId: string; fileName: string; contentType: string; version: number }> {
    const { d, restricted } = await this.doc(p, docId);
    const versions = await this.db.select().from(safetyDocumentVersions).where(eq(safetyDocumentVersions.documentId, docId));
    const v = version ? versions.find((x) => x.version === version) : [...versions].sort((a, b) => b.version - a.version)[0];
    if (version && !v && version !== 1) throw this.core.notFound('That version');
    if (restricted) await this.logAccess(p, `accident.evidence.download:${docId}:v${v?.version ?? 1}`, { accidentId: d.caseId });
    return v ? { fileId: v.fileId, fileName: v.fileName, contentType: v.contentType, version: v.version } : { fileId: d.fileId, fileName: d.fileName, contentType: d.contentType, version: 1 };
  }
}
