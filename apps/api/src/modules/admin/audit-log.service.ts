import { redactPersonalAuditLine } from '../../common/auth/personal-audit';
import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import {
  AUDIT_ACTION_LABELS,
  type AuditCoverage,
  type AuditEntry,
  type AuditQuery,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { auditLogs } from '../../database/schema/people';
import { StolenUnitsService } from '../state/stolen-units.service';

/**
 * Reading the audit trail.
 *
 * This service has no write path, no update path and no delete path — deliberately, and not as
 * something to add later. `AuditService.write` is the only way an entry is ever created, and it is
 * called by the module doing the work, never by an administrator. There is no endpoint anywhere in
 * this codebase that edits or removes an audit record.
 *
 * Every list is returned with its coverage window, so a filter that finds nothing can distinguish
 * "that never happened" from "that happened before this system started recording".
 */
@Injectable()
export class AuditLogService {
  constructor(
    private readonly database: DatabaseService,
    private readonly stolen: StolenUnitsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private conditions(principal: Principal, query: Partial<AuditQuery>) {
    const parts = [eq(auditLogs.companyId, principal.companyId)];
    if (query.action) parts.push(eq(auditLogs.action, query.action));
    if (query.entityType) parts.push(eq(auditLogs.entityType, query.entityType));
    if (query.entityId) parts.push(eq(auditLogs.entityId, query.entityId));
    if (query.actorId) parts.push(eq(auditLogs.actorId, query.actorId));
    if (query.actorType) parts.push(eq(auditLogs.actorType, query.actorType));
    if (query.from) {
      parts.push(gte(auditLogs.at, this.startOfDay(query.from, principal.companyTimezone)));
    }
    if (query.to) {
      parts.push(lte(auditLogs.at, this.endOfDay(query.to, principal.companyTimezone)));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(auditLogs.entityLabel, term),
        ilike(auditLogs.summary, term),
        ilike(auditLogs.actorName, term),
        ilike(auditLogs.entityId, term),
      );
      if (match) parts.push(match);
    }
    return and(...parts);
  }

  /**
   * Day boundaries in the company's timezone, not the server's.
   *
   * A carrier in Chicago filtering "6 September" means their 6 September. Resolving it in UTC would
   * silently shift the window by five hours and drop the evening's changes off the end.
   */
  private startOfDay(date: string, timezone: string): Date {
    return new Date(
      new Date(`${date}T00:00:00Z`).getTime() + this.offsetMs(`${date}T00:00:00Z`, timezone),
    );
  }

  private endOfDay(date: string, timezone: string): Date {
    return new Date(
      new Date(`${date}T23:59:59.999Z`).getTime() +
        this.offsetMs(`${date}T23:59:59Z`, timezone),
    );
  }

  private offsetMs(iso: string, timezone: string): number {
    const at = new Date(iso);
    const local = new Date(at.toLocaleString('en-US', { timeZone: timezone }));
    const utc = new Date(at.toLocaleString('en-US', { timeZone: 'UTC' }));
    return utc.getTime() - local.getTime();
  }

  async list(
    principal: Principal,
    query: AuditQuery,
  ): Promise<{
    data: AuditEntry[];
    total: number;
    page: number;
    pageSize: number;
    coverage: AuditCoverage;
  }> {
    const where = this.conditions(principal, query);

    const [counted] = await this.db.select({ value: count() }).from(auditLogs).where(where);
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(where)
      .orderBy(desc(auditLogs.at))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      // Lines about a stolen unit read "Restricted (stolen unit)" to everyone but an administrator.
      data: await this.stolen.redactAuditLines(principal, rows.map((row) => redactPersonalAuditLine(principal, this.toEntry(row)))),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
      coverage: await this.coverage(principal),
    };
  }

  async get(principal: Principal, id: string): Promise<AuditEntry> {
    const [row] = await this.db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, principal.companyId), eq(auditLogs.id, id)))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No audit entry ${id}` });
    }
    const [entry] = await this.stolen.redactAuditLines(principal, [redactPersonalAuditLine(principal, this.toEntry(row))]);
    return entry ?? redactPersonalAuditLine(principal, this.toEntry(row));
  }

  /** Everything recorded about one record, oldest first: the record's own history. */
  async forEntity(
    principal: Principal,
    entityType: string,
    entityId: string,
  ): Promise<AuditEntry[]> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          eq(auditLogs.entityType, entityType),
          eq(auditLogs.entityId, entityId),
        ),
      )
      .orderBy(asc(auditLogs.at))
      .limit(500);
    return this.stolen.redactAuditLines(principal, rows.map((row) => redactPersonalAuditLine(principal, this.toEntry(row))));
  }

  /** The distinct values actually present, so the filters offer nothing that returns nothing. */
  async facets(principal: Principal) {
    const [actions, entityTypes, actors] = await Promise.all([
      this.db
        .selectDistinct({ value: auditLogs.action })
        .from(auditLogs)
        .where(eq(auditLogs.companyId, principal.companyId)),
      this.db
        .selectDistinct({ value: auditLogs.entityType })
        .from(auditLogs)
        .where(eq(auditLogs.companyId, principal.companyId)),
      this.db
        .selectDistinct({ id: auditLogs.actorId, name: auditLogs.actorName })
        .from(auditLogs)
        .where(eq(auditLogs.companyId, principal.companyId)),
    ]);
    return {
      actions: actions
        .map((a) => ({ value: a.value, label: AUDIT_ACTION_LABELS[a.value] ?? a.value }))
        .sort((a, b) => a.label.localeCompare(b.label)),
      entityTypes: entityTypes.map((e) => e.value).sort(),
      actors: actors
        .filter((a) => a.id !== null)
        .map((a) => ({ id: a.id as string, name: a.name }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    };
  }

  async coverage(principal: Principal): Promise<AuditCoverage> {
    const [row] = await this.db
      .select({
        earliest: sql<Date | null>`min(${auditLogs.at})`,
        latest: sql<Date | null>`max(${auditLogs.at})`,
        total: count(),
      })
      .from(auditLogs)
      .where(eq(auditLogs.companyId, principal.companyId));

    const earliest = row?.earliest ? new Date(row.earliest).toISOString() : null;
    return {
      earliest,
      latest: row?.latest ? new Date(row.latest).toISOString() : null,
      total: row?.total ?? 0,
      note: earliest
        ? `Changes made before ${earliest.slice(0, 10)} are not in this trail — recording began when the audit table was introduced.`
        : 'Nothing has been recorded yet.',
    };
  }

  /** CSV of the current filter, capped so an export cannot be used to page the whole table. */
  async exportCsv(principal: Principal, query: AuditQuery): Promise<string> {
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(this.conditions(principal, query))
      .orderBy(desc(auditLogs.at))
      .limit(10_000);

    const escape = (value: string | null): string =>
      value === null ? '' : `"${value.replace(/"/g, '""')}"`;

    const lines = [
      'timestamp,actor,actor_type,action,entity_type,entity_id,entity,summary,reason,changes',
    ];
    const entries = await this.stolen.redactAuditLines(principal, rows.map((row) => redactPersonalAuditLine(principal, this.toEntry(row))));
    for (const entry of entries) {
      lines.push(
        [
          entry.at,
          escape(entry.actorName),
          entry.actorType,
          entry.action,
          entry.entityType,
          escape(entry.entityId),
          escape(entry.entityLabel),
          escape(entry.summary),
          escape(entry.reason),
          escape(
            entry.changes.map((c) => `${c.field}: ${c.old ?? '—'} → ${c.new ?? '—'}`).join('; '),
          ),
        ].join(','),
      );
    }
    return lines.join('\n');
  }

  private toEntry(row: typeof auditLogs.$inferSelect): AuditEntry {
    const changes = Array.isArray(row.changes)
      ? (row.changes as AuditEntry['changes'])
      : [];
    return {
      id: row.id,
      at: row.at.toISOString(),
      actorType: row.actorType,
      actorId: row.actorId,
      actorName: row.actorName,
      action: row.action,
      actionLabel: AUDIT_ACTION_LABELS[row.action] ?? row.action,
      entityType: row.entityType,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      summary: row.summary,
      reason: row.reason,
      changes,
    };
  }
}
