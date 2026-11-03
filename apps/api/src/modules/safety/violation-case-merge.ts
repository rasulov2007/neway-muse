import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Database } from '../../database/client';
import { auditLogs } from '../../database/schema/people';
import { safetyCaseDocuments, safetyReviews, safetyViolations, type SafetyReviewRow, type SafetyViolationRow } from '../../database/schema/safety';

/**
 * Puts violations entered one by one from the same paper into one case (owner, 2026-10-21).
 *
 * Production example: report TNI000000001 (TN, 10/19/2026, Level I) was entered as three
 * violations, each with its own driver review (REV-003, REV-004, REV-005). The merge:
 *   - gives the rows one shared `case_id` (an existing one if a row already has it);
 *   - points every row at the earliest live review and voids the others with a reason - never
 *     deletes them - refusing when a review to void has moved past its initial status or has
 *     anything recorded on it (notes, training, outcome, evidence, documents...);
 *   - fills `state` / `inspection_level` where they are empty, when asked;
 *   - writes one audit line per changed row and per voided review; version-checked, in one
 *     transaction; a second run finds nothing to do.
 *
 * Shared by `scripts/merge-violation-case.ts` (dry run by default) and its test.
 */

export type MergeDb = Pick<Database, 'select' | 'insert' | 'update' | 'transaction'>;

export interface MergeViolationCaseOptions {
  companyId: string;
  reportNumber: string;
  /** False = dry run: reads, plans, writes nothing. */
  confirm: boolean;
  now: Date;
  actor: { userId: string; userName: string };
  /** Filled only where the row has none. */
  state?: string | null;
  inspectionLevel?: number | null;
  /** The case id to use when no row has one yet (tests pass a fixed one). */
  newCaseId?: () => string;
  /** "(owner, 2026-10-21)" - the note on the void reason. */
  reasonNote?: string;
}

export interface MergeRowChange {
  id: string;
  number: string;
  changes: { field: string; old: unknown; new: unknown }[];
}

export interface MergeViolationCaseResult {
  outcome: 'not_found' | 'nothing_to_do' | 'refused' | 'planned' | 'applied';
  caseId: string | null;
  keeper: { id: string; number: string } | null;
  violations: { id: string; number: string; code: string | null; reviewNumber: string | null }[];
  rowChanges: MergeRowChange[];
  toVoid: { id: string; number: string }[];
  voidReason: string | null;
  refusals: string[];
  /** Human lines for the console. */
  lines: string[];
}

const easternDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

/** Why a review to be voided must stay: it has moved on or holds work. Empty = safe to void. */
export function reviewProgress(r: SafetyReviewRow, documentCount: number): string[] {
  const why: string[] = [];
  if (r.status !== 'not_started') why.push(`status is ${r.status.replace(/_/g, ' ')} (beyond not started)`);
  if (r.scheduledFor) why.push(`scheduled for ${r.scheduledFor}`);
  if (r.notes?.trim()) why.push('has notes');
  if (r.outcome?.trim()) why.push('has an outcome');
  if (r.requiredTraining?.trim()) why.push('has required training');
  if (r.trainingCompletedOn) why.push(`training completed ${r.trainingCompletedOn}`);
  if (r.preventability !== 'undetermined') why.push(`preventability is ${r.preventability}`);
  if (r.followUpOn) why.push(`follow-up on ${r.followUpOn}`);
  if (r.evidenceNote?.trim()) why.push('has an evidence note');
  if (r.completedAt) why.push('is completed');
  if (r.accountingExpenseId) why.push('is linked to an Accounting expense');
  if (documentCount > 0) why.push(`has ${documentCount} document(s)`);
  return why;
}

export async function mergeViolationCase(db: MergeDb, opts: MergeViolationCaseOptions): Promise<MergeViolationCaseResult> {
  const result: MergeViolationCaseResult = {
    outcome: 'nothing_to_do',
    caseId: null,
    keeper: null,
    violations: [],
    rowChanges: [],
    toVoid: [],
    voidReason: null,
    refusals: [],
    lines: [],
  };
  const say = (line: string) => result.lines.push(line);

  const rows: SafetyViolationRow[] = await db
    .select()
    .from(safetyViolations)
    .where(and(eq(safetyViolations.companyId, opts.companyId), eq(safetyViolations.reportNumber, opts.reportNumber), isNull(safetyViolations.voidedAt)))
    .orderBy(asc(safetyViolations.createdAt), asc(safetyViolations.number));
  result.violations = rows.map((r) => ({ id: r.id, number: r.number, code: r.code, reviewNumber: r.reviewNumber }));
  if (rows.length === 0) {
    result.outcome = 'not_found';
    say(`No live violation with report ${opts.reportNumber} in ${opts.companyId}.`);
    return result;
  }
  for (const r of rows) say(`  ${r.number}  ${r.code ?? '-'}  ${r.description}  driver ${r.driverName ?? '-'}  unit ${r.truckNumber ?? '-'}  review ${r.reviewNumber ?? '-'}  case ${r.caseId ?? '-'}  state ${r.state ?? '-'}  level ${r.inspectionLevel ?? '-'}`);

  // One paper: one driver, one date. Anything else is not this merge's to decide.
  const drivers = new Set(rows.map((r) => r.driverId ?? ''));
  const dates = new Set(rows.map((r) => easternDate(r.occurredAt)));
  const caseIds = new Set(rows.map((r) => r.caseId).filter((c): c is string => Boolean(c)));
  if (drivers.size > 1) result.refusals.push(`The rows name different drivers (${[...new Set(rows.map((r) => r.driverName ?? 'none'))].join(', ')})`);
  if (dates.size > 1) result.refusals.push(`The rows carry different dates (${[...dates].join(', ')})`);
  if (caseIds.size > 1) result.refusals.push(`The rows already belong to different cases (${[...caseIds].join(', ')})`);

  const caseId = [...caseIds][0] ?? (opts.newCaseId ?? (() => `vcs_${crypto.randomUUID()}`))();
  result.caseId = caseId;

  // Every driver review the rows point at, or that was opened from one of them.
  const rowIds = rows.map((r) => r.id);
  const reviewIds = rows.map((r) => r.reviewId).filter((x): x is string => Boolean(x));
  const reviews: SafetyReviewRow[] = await db
    .select()
    .from(safetyReviews)
    .where(
      and(
        eq(safetyReviews.companyId, opts.companyId),
        or(
          reviewIds.length ? inArray(safetyReviews.id, reviewIds) : undefined,
          and(eq(safetyReviews.kind, 'driver_review'), eq(safetyReviews.linkedType, 'violation'), inArray(safetyReviews.linkedId, rowIds)),
        ),
      ),
    )
    .orderBy(asc(safetyReviews.createdAt), asc(safetyReviews.number));
  const live = reviews.filter((r) => !r.voidedAt);
  const keeper = live[0] ?? null;
  result.keeper = keeper ? { id: keeper.id, number: keeper.number } : null;
  const toVoid = live.slice(1);
  result.toVoid = toVoid.map((r) => ({ id: r.id, number: r.number }));
  const voidReason = keeper ? `Merged into ${keeper.number}: one inspection paper, one case ${opts.reasonNote ?? '(owner, 2026-10-21)'}` : null;
  result.voidReason = voidReason;

  if (toVoid.length > 0) {
    const docs = await db
      .select({ caseId: safetyCaseDocuments.caseId })
      .from(safetyCaseDocuments)
      .where(and(eq(safetyCaseDocuments.companyId, opts.companyId), eq(safetyCaseDocuments.caseType, 'safety_review'), inArray(safetyCaseDocuments.caseId, toVoid.map((r) => r.id)), isNull(safetyCaseDocuments.voidedAt)));
    for (const r of toVoid) {
      const why = reviewProgress(r, docs.filter((d) => d.caseId === r.id).length);
      if (why.length > 0) result.refusals.push(`${r.number} cannot be voided: ${why.join('; ')}`);
    }
  }

  for (const r of rows) {
    const changes: MergeRowChange['changes'] = [];
    if (r.caseId !== caseId && rows.length > 1) changes.push({ field: 'caseId', old: r.caseId, new: caseId });
    if (keeper && r.driverId && r.reviewId !== keeper.id) {
      changes.push({ field: 'reviewId', old: r.reviewId, new: keeper.id });
      changes.push({ field: 'reviewNumber', old: r.reviewNumber, new: keeper.number });
    }
    if (opts.state && !r.state) changes.push({ field: 'state', old: r.state, new: opts.state });
    if (opts.inspectionLevel && !r.inspectionLevel) changes.push({ field: 'inspectionLevel', old: r.inspectionLevel, new: opts.inspectionLevel });
    if (changes.length > 0) result.rowChanges.push({ id: r.id, number: r.number, changes });
  }

  if (result.refusals.length > 0) {
    result.outcome = 'refused';
    say('REFUSED - nothing written:');
    for (const why of result.refusals) say(`  - ${why}`);
    return result;
  }
  if (result.rowChanges.length === 0 && toVoid.length === 0) {
    result.outcome = 'nothing_to_do';
    say(`Already one case${keeper ? ` with ${keeper.number}` : ''} - nothing to do.`);
    return result;
  }

  say(`Case ${caseId}${keeper ? `, driver review ${keeper.number}` : ''}`);
  for (const c of result.rowChanges) say(`  ${c.number}: ${c.changes.map((x) => `${x.field} ${String(x.old ?? '-')} -> ${String(x.new)}`).join(', ')}`);
  for (const r of toVoid) say(`  void ${r.number}: "${voidReason}"`);
  if (!opts.confirm) {
    result.outcome = 'planned';
    say('DRY RUN - nothing written. Re-run with --confirm to apply.');
    return result;
  }

  await db.transaction(async (tx) => {
    for (const c of result.rowChanges) {
      const row = rows.find((r) => r.id === c.id)!;
      const patch: Partial<typeof safetyViolations.$inferInsert> = {};
      for (const x of c.changes) (patch as Record<string, unknown>)[x.field] = x.new;
      const updated = await tx
        .update(safetyViolations)
        .set({ ...patch, version: row.version + 1, updatedAt: opts.now })
        .where(and(eq(safetyViolations.companyId, opts.companyId), eq(safetyViolations.id, row.id), eq(safetyViolations.version, row.version)))
        .returning({ id: safetyViolations.id });
      if (updated.length === 0) throw new Error(`${row.number} was changed by someone else; nothing written. Run again.`);
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId: opts.companyId,
        actorType: 'system',
        actorId: opts.actor.userId,
        actorName: opts.actor.userName,
        action: 'violation_case_merged',
        entityType: 'safety_violation',
        entityId: row.id,
        entityLabel: row.number,
        summary: `One paper, one case: report ${opts.reportNumber}${keeper ? `, driver review ${keeper.number}` : ''}`,
        changes: c.changes,
        reason: `Report ${opts.reportNumber}: one inspection paper, one case ${opts.reasonNote ?? '(owner, 2026-10-21)'}`,
        at: opts.now,
      });
    }
    for (const r of toVoid) {
      const updated = await tx
        .update(safetyReviews)
        .set({ voidedAt: opts.now, voidedBy: opts.actor.userName, voidReason, version: r.version + 1, updatedAt: opts.now })
        .where(and(eq(safetyReviews.companyId, opts.companyId), eq(safetyReviews.id, r.id), eq(safetyReviews.version, r.version), isNull(safetyReviews.voidedAt)))
        .returning({ id: safetyReviews.id });
      if (updated.length === 0) throw new Error(`${r.number} was changed by someone else; nothing written. Run again.`);
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId: opts.companyId,
        actorType: 'system',
        actorId: opts.actor.userId,
        actorName: opts.actor.userName,
        action: 'safety_review_voided',
        entityType: 'safety_review',
        entityId: r.id,
        entityLabel: r.number,
        summary: `Voided ${r.number}`,
        changes: [{ field: 'voidedAt', old: null, new: opts.now.toISOString() }],
        reason: voidReason,
        at: opts.now,
      });
    }
  });
  result.outcome = 'applied';
  say(`APPLIED: ${result.rowChanges.length} violation(s) updated, ${toVoid.length} review(s) voided, one audit line each.`);
  return result;
}
