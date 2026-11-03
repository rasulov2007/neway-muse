import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  COMPLIANCE_AUDIT_ACTIONS,
  type ComplianceAuditAction,
  type ComplianceAuditEntry,
  type EntityRef,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { auditLogs } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';

export interface ComplianceAuditWrite {
  action: ComplianceAuditAction;
  entity: EntityRef;
  /** The requirement or document the change concerns, when there is one. */
  subject: string | null;
  before: string | null;
  after: string | null;
  reason: string | null;
  /** The acting party when it is not the principal (a driver in the portal, the system). */
  actor?: { id: string; name: string };
  actorType?: 'user' | 'system';
  at?: Date;
}

/**
 * Compliance changes in the product's one audit trail.
 *
 * The browser demo kept a separate `complianceAudit` array. Here every compliance change is a row
 * in `audit_logs` beside every other change in the product: the compliance action is the row's
 * `action`, the requirement or document is the single `change.field`, before/after are its
 * old/new. Two consequences worth the sentence: the Administration audit screen shows compliance
 * history without a second query, and the workflow engine can react to "consent declined" like
 * any other event, because it *is* any other event.
 */
@Injectable()
export class ComplianceAuditService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async write(principal: Principal, input: ComplianceAuditWrite): Promise<string> {
    return this.audit.write(principal, {
      action: input.action,
      entityType: input.entity.type,
      entityId: input.entity.id,
      entityLabel: input.entity.label,
      summary: this.summary(input),
      changes: input.subject
        ? [{ field: input.subject, old: input.before, new: input.after }]
        : input.before !== null || input.after !== null
          ? [{ field: 'status', old: input.before, new: input.after }]
          : [],
      reason: input.reason,
      actorType: input.actorType ?? 'user',
      actor: input.actor,
      at: input.at,
    });
  }

  private summary(input: ComplianceAuditWrite): string {
    const what = input.subject ? input.subject.replace(/_/g, ' ') : input.entity.label;
    switch (input.action) {
      case 'document_uploaded':
        return `${what}: document uploaded`;
      case 'document_verified':
        return `${what}: verified`;
      case 'document_rejected':
        return `${what}: rejected`;
      case 'document_deleted':
        return `${what}: document deleted`;
      case 'item_waived':
        return `${what}: ${input.after ?? 'waived'}`;
      case 'consent_sent':
        return `${what}: consent sent`;
      case 'consent_signed':
        return `${what}: consent signed`;
      case 'consent_declined':
        return `${what}: consent declined`;
      case 'decision_recorded':
        return `Hiring decision: ${input.after ?? ''}`.trim();
      default:
        return `${what}: ${input.before ?? '—'} → ${input.after ?? '—'}`;
    }
  }

  /** Newest first, compliance actions only, optionally for one entity. */
  async list(
    principal: Principal,
    query: { entityId?: string; limit: number },
  ): Promise<ComplianceAuditEntry[]> {
    const parts = [
      eq(auditLogs.companyId, principal.companyId),
      inArray(auditLogs.action, [...COMPLIANCE_AUDIT_ACTIONS]),
    ];
    if (query.entityId) parts.push(eq(auditLogs.entityId, query.entityId));
    const rows = await this.database.db
      .select()
      .from(auditLogs)
      .where(and(...parts))
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(query.limit);
    return rows.map((row) => this.toEntry(row));
  }

  private toEntry(row: typeof auditLogs.$inferSelect): ComplianceAuditEntry {
    const changes = Array.isArray(row.changes)
      ? (row.changes as { field: string; old: string | null; new: string | null }[])
      : [];
    const change = changes[0];
    const isStatusOnly = change?.field === 'status';
    return {
      id: row.id,
      at: row.at.toISOString(),
      actorId: row.actorId ?? 'system',
      actorName: row.actorName,
      action: row.action as ComplianceAuditAction,
      entity: {
        type: row.entityType as EntityRef['type'],
        id: row.entityId,
        label: row.entityLabel,
      },
      subject: change && !isStatusOnly ? change.field : null,
      before: change?.old ?? null,
      after: change?.new ?? null,
      reason: row.reason,
      source:
        row.actorType === 'workflow' ? 'workflow' : row.actorType === 'system' ? 'system' : 'user',
    };
  }
}
