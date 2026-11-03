import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import type {
  AssignRecruiterRequest,
  FollowUpRequest,
  HiringActivityEntry,
  LatestFollowUp,
  LeadNote,
  LeadNoteRequest,
} from '@neway/shared';
import { FOLLOW_UP_METHOD_LABELS, FOLLOW_UP_OUTCOME_LABELS } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { hiringCases, hiringLeads } from '../../database/schema/hiring';
import { applicants } from '../../database/schema/hr';
import { auditLogs, employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';
import { HiringService } from './hiring.service';

/**
 * The recruiter's own record of a candidate (owner, 2026-09-30): who is working them, and each
 * time somebody reached out. A follow-up is recorded after it happened — this never sends a
 * message and never claims one was sent. Both land in the shared audit trail, which is what the
 * candidate's Activity tab reads beside the stage history.
 */
@Injectable()
export class HiringActivityService {
  constructor(
    private readonly database: DatabaseService,
    private readonly hiring: HiringService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async lead(principal: Principal, id: string) {
    const [row] = await this.db
      .select()
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No lead ${id}` });
    return row;
  }

  private async recruiter(principal: Principal, employeeId: string) {
    const [row] = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, employeeId)))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That recruiter is not an employee of this company' });
    }
    return { id: row.id, name: `${row.first} ${row.last}` };
  }

  /** One recruiter across the lead, the case and the candidate record, in one transaction. */
  async assignRecruiter(principal: Principal, caseId: string, input: AssignRecruiterRequest): Promise<void> {
    const row = await this.hiring.row(principal, caseId);
    const next = input.employeeId ? await this.recruiter(principal, input.employeeId) : null;
    if ((row.recruiterId ?? null) === (next?.id ?? null)) return;
    await this.db.transaction(async (tx) => {
      await tx
        .update(hiringCases)
        .set({ recruiterId: next?.id ?? null, recruiterName: next?.name ?? null })
        .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, caseId)));
      if (row.applicantId) {
        await tx
          .update(applicants)
          .set({ assignedRecruiterEmployeeId: next?.id ?? null })
          .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, row.applicantId)));
      }
      await tx
        .update(hiringLeads)
        .set({ recruiterEmployeeId: next?.id ?? null })
        .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.hiringCaseId, caseId)));
    });
    await this.audit.write(principal, {
      action: 'assign',
      entityType: 'hiring_case',
      entityId: caseId,
      entityLabel: row.candidateName,
      summary: next ? `Recruiter set to ${next.name}` : 'Recruiter removed',
      changes: [{ field: 'recruiter', old: row.recruiterName ?? null, new: next?.name ?? null }],
    });
  }

  /** Records a contact attempt that already happened. Nothing is sent from here. */
  async recordFollowUp(
    principal: Principal,
    target: { kind: 'case' | 'lead'; id: string },
    input: FollowUpRequest,
  ): Promise<LatestFollowUp> {
    let label: string;
    if (target.kind === 'case') {
      label = (await this.hiring.row(principal, target.id)).candidateName;
    } else {
      const l = await this.lead(principal, target.id);
      label = `${l.firstName} ${l.lastName}`;
    }
    const summary = `Follow-up: ${FOLLOW_UP_METHOD_LABELS[input.method]} — ${FOLLOW_UP_OUTCOME_LABELS[input.outcome]}`;
    const at = new Date();
    await this.audit.write(principal, {
      action: 'follow_up',
      entityType: target.kind === 'case' ? 'hiring_case' : 'hiring_lead',
      entityId: target.id,
      entityLabel: label,
      summary,
      reason: input.note,
      changes: [
        { field: 'method', old: null, new: input.method },
        { field: 'outcome', old: null, new: input.outcome },
      ],
      at,
    });
    return {
      entityId: target.id,
      at: at.toISOString(),
      byName: principal.userName ?? principal.userId,
      method: input.method,
      outcome: input.outcome,
      note: input.note,
    };
  }

  /**
   * A plain note on a lead (owner, 2026-10-07): free text, kept in the audit trail beside the
   * follow-ups, with who wrote it and when. Notes are never edited or removed.
   */
  async addLeadNote(principal: Principal, leadId: string, input: LeadNoteRequest): Promise<LeadNote> {
    const l = await this.lead(principal, leadId);
    const at = new Date();
    const id = await this.audit.write(principal, {
      action: 'note',
      entityType: 'hiring_lead',
      entityId: l.id,
      entityLabel: `${l.firstName} ${l.lastName}`.trim(),
      summary: 'Note added',
      reason: input.note,
      at,
    });
    return {
      id,
      leadId: l.id,
      at: at.toISOString(),
      byName: principal.userName ?? principal.userId,
      kind: 'note',
      text: input.note,
      summary: null,
    };
  }

  /** Notes and follow-ups on leads, newest first; one lead, or every lead in `leadIds`. */
  async leadNotes(principal: Principal, leadIds: string[], limit = 500): Promise<LeadNote[]> {
    if (leadIds.length === 0) return [];
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          eq(auditLogs.entityType, 'hiring_lead'),
          inArray(auditLogs.action, ['note', 'follow_up']),
          inArray(auditLogs.entityId, leadIds),
        ),
      )
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      leadId: r.entityId,
      at: r.at.toISOString(),
      byName: r.actorName,
      kind: r.action === 'note' ? ('note' as const) : ('follow_up' as const),
      text: r.reason,
      summary: r.action === 'note' ? null : r.summary.replace(/^Follow-up: /, ''),
    }));
  }

  /** The notes on one lead of this company, newest first. */
  async notesForLead(principal: Principal, leadId: string): Promise<LeadNote[]> {
    const l = await this.lead(principal, leadId);
    return this.leadNotes(principal, [l.id]);
  }

  /** The newest follow-up for each case and lead, for the pipeline cards. */
  async latestFollowUps(principal: Principal): Promise<LatestFollowUp[]> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          eq(auditLogs.action, 'follow_up'),
          inArray(auditLogs.entityType, ['hiring_case', 'hiring_lead']),
        ),
      )
      .orderBy(desc(auditLogs.at))
      .limit(2000);
    const seen = new Map<string, LatestFollowUp>();
    for (const r of rows) {
      if (seen.has(r.entityId)) continue;
      const changes = (r.changes as { field: string; new: string }[] | null) ?? [];
      seen.set(r.entityId, {
        entityId: r.entityId,
        at: r.at.toISOString(),
        byName: r.actorName,
        method: (changes.find((c) => c.field === 'method')?.new ?? 'other') as LatestFollowUp['method'],
        outcome: (changes.find((c) => c.field === 'outcome')?.new ?? 'other') as LatestFollowUp['outcome'],
        note: r.reason,
      });
    }
    return [...seen.values()];
  }

  /**
   * What happened to a candidate, newest first: every stage move (with who and why), every
   * follow-up, recruiter change, drop and document upload — from the lead through the case.
   */
  async activity(principal: Principal, caseId: string): Promise<HiringActivityEntry[]> {
    const c = await this.hiring.get(principal, caseId);
    const [lead] = await this.db
      .select({ id: hiringLeads.id })
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.hiringCaseId, caseId)))
      .limit(1);
    const ids = [caseId, ...(c.applicantId ? [c.applicantId] : []), ...(lead ? [lead.id] : [])];
    const logs = await this.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, principal.companyId), inArray(auditLogs.entityId, ids)))
      .orderBy(desc(auditLogs.at))
      .limit(300);
    const entries: HiringActivityEntry[] = [
      ...c.events.map((e) => ({
        id: e.id,
        at: e.at,
        kind: 'stage' as const,
        title: `Moved to ${e.toState.replace(/_/g, ' ')}`,
        detail: [e.reason?.replace(/_/g, ' '), e.note].filter(Boolean).join(' — ') || null,
        byName: e.byName,
      })),
      ...logs.map((l) => ({
        id: l.id,
        at: l.at.toISOString(),
        kind: (l.action === 'follow_up' ? 'follow_up' : 'record') as HiringActivityEntry['kind'],
        title: l.summary,
        detail: l.reason,
        byName: l.actorName,
      })),
    ];
    return entries.sort((a, b) => b.at.localeCompare(a.at));
  }
}
