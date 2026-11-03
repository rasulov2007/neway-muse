import { and, eq, or } from 'drizzle-orm';
import type { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import { hiringLeads } from '../../database/schema/hiring';

/**
 * Tells Recruiting the driver sent something back (owner, 2026-10-12: a signed consent or an
 * application sat unseen for minutes because nothing announced it). The lead's own recruiter
 * hears it; with nobody assigned, everyone who manages recruiting does. Never throws: a bell that
 * fails must not undo the driver's submission.
 */
export async function notifyRecruiters(
  db: DatabaseService['db'],
  input: { companyId: string; caseId: string | null; leadId: string | null; applicantId: string | null; key: string; title: string; body: string },
): Promise<void> {
  try {
    if (!input.applicantId && !input.leadId) return;
    const leads = await db
      .select({ recruiter: hiringLeads.recruiterEmployeeId })
      .from(hiringLeads)
      .where(
        and(
          eq(hiringLeads.companyId, input.companyId),
          or(...[input.leadId ? eq(hiringLeads.id, input.leadId) : null, input.caseId ? eq(hiringLeads.hiringCaseId, input.caseId) : null].filter((c): c is NonNullable<typeof c> => c !== null)),
        ),
      )
      .limit(1);
    const recruiter = leads[0]?.recruiter ?? null;
    let users: string[] = [];
    if (recruiter) {
      users = (
        await db
          .select({ userId: memberships.userId })
          .from(memberships)
          .where(and(eq(memberships.companyId, input.companyId), eq(memberships.employeeId, recruiter), eq(memberships.status, 'active')))
      ).map((r) => r.userId);
    }
    if (users.length === 0) {
      users = (
        await db
          .selectDistinct({ userId: memberships.userId })
          .from(memberships)
          .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
          .leftJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
          .where(and(eq(memberships.companyId, input.companyId), eq(memberships.status, 'active'), eq(rolePermissions.permissionCode, 'recruiting.manage')))
      ).map((r) => r.userId);
    }
    const unique = [...new Set(users)];
    if (unique.length === 0) return;
    const entity = input.applicantId ? { entityType: 'applicant', entityId: input.applicantId } : { entityType: 'lead', entityId: input.leadId as string };
    await db
      .insert(notifications)
      .values(unique.map((userId) => ({ id: `ntf_${crypto.randomUUID()}`, companyId: input.companyId, recipientUserId: userId, severity: 'info', title: input.title, body: input.body, ...entity, source: 'system', dedupeKey: `${input.key}:${userId}` })))
      .onConflictDoNothing();
  } catch {
    // The submission stands; the candidate page shows it on its next refresh.
  }
}
