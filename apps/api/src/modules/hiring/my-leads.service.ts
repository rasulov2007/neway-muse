import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { LeadNote, MyLeadRow, MyLeads, MyLeadsQuery } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { hiringLeads } from '../../database/schema/hiring';
import { auditLogs, employees } from '../../database/schema/people';
import { LeadRotationService } from './lead-rotation.service';

/** Work first: leads nobody has reached, then the ones in progress, then the finished ones. */
const STATUS_RANK = sql`case ${hiringLeads.status}
  when 'new' then 0 when 'contacted' then 1 when 'prequalified' then 2
  when 'converted' then 3 else 4 end`;

/**
 * "My leads" (owner, 2026-10-07): the leads assigned to the signed-in recruiter, each with its
 * newest note or follow-up. A manager (`recruiting.manage`) may look at any recruiter's list.
 */
@Injectable()
export class MyLeadsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rotation: LeadRotationService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async employee(principal: Principal, id: string) {
    const [row] = await this.db
      .select({
        id: employees.id,
        first: employees.firstName,
        last: employees.lastName,
        position: employees.position,
        status: employees.status,
      })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such employee' });
    return {
      employeeId: row.id,
      name: `${row.first} ${row.last}`.trim(),
      isRecruiter: row.status !== 'terminated' && /recruit/i.test(row.position),
    };
  }

  async list(principal: Principal, query: MyLeadsQuery): Promise<MyLeads> {
    const own = await this.rotation.ownEmployee(principal);
    let recruiter = own;
    if (query.recruiterEmployeeId && query.recruiterEmployeeId !== own?.employeeId) {
      if (!principal.permissions.has('recruiting.manage')) {
        throw new AppError({
          status: 403,
          title: 'Forbidden',
          detail: "Only a recruiting manager can open another recruiter's leads.",
        });
      }
      recruiter = await this.employee(principal, query.recruiterEmployeeId);
    }
    if (!recruiter) return { recruiter: null, leads: [] };

    const rows = await this.db
      .select()
      .from(hiringLeads)
      .where(
        and(
          eq(hiringLeads.companyId, principal.companyId),
          eq(hiringLeads.isTest, false),
          eq(hiringLeads.recruiterEmployeeId, recruiter.employeeId),
        ),
      )
      .orderBy(STATUS_RANK, desc(hiringLeads.createdAt), desc(hiringLeads.id))
      .limit(500);
    const latest = await this.latestNotes(principal, rows.map((r) => r.id));
    const leads: MyLeadRow[] = rows.map((r) => ({
      id: r.id,
      leadNumber: r.leadNumber,
      name: `${r.firstName} ${r.lastName}`.trim(),
      phone: r.phone,
      email: r.email,
      source: r.source,
      status: r.status as MyLeadRow['status'],
      applicantId: r.applicantId,
      createdAt: r.createdAt.toISOString(),
      contactedAt: r.contactedAt?.toISOString() ?? null,
      lastNote: latest.get(r.id) ?? null,
    }));
    return { recruiter, leads };
  }

  /** The newest note or follow-up of each lead, in one query for the whole list. */
  private async latestNotes(principal: Principal, leadIds: string[]): Promise<Map<string, LeadNote>> {
    if (leadIds.length === 0) return new Map();
    const rows = await this.db
      .selectDistinctOn([auditLogs.entityId], {
        id: auditLogs.id,
        entityId: auditLogs.entityId,
        at: auditLogs.at,
        actorName: auditLogs.actorName,
        action: auditLogs.action,
        summary: auditLogs.summary,
        reason: auditLogs.reason,
      })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          eq(auditLogs.entityType, 'hiring_lead'),
          inArray(auditLogs.action, ['note', 'follow_up']),
          inArray(auditLogs.entityId, leadIds),
        ),
      )
      .orderBy(auditLogs.entityId, desc(auditLogs.at), desc(auditLogs.id));
    return new Map(
      rows.map((r) => [
        r.entityId,
        {
          id: r.id,
          leadId: r.entityId,
          at: r.at.toISOString(),
          byName: r.actorName,
          kind: r.action === 'note' ? 'note' : 'follow_up',
          text: r.reason,
          summary: r.action === 'note' ? null : r.summary.replace(/^Follow-up: /, ''),
        },
      ]),
    );
  }
}
