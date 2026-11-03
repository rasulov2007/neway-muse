import { Injectable } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import { reportByKey, type SaveReportRequest, type SavedReportRecord } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { savedReports } from '../../database/schema/reports';
import { AuditService } from '../people/audit.service';

/**
 * Saved report configurations.
 *
 * Stored in PostgreSQL, so a saved view survives a refresh, a new session and a server restart.
 * Only the configuration is kept — reopening one re-runs it against current data rather than
 * replaying a stored result set that has quietly gone stale.
 */
@Injectable()
export class SavedReportsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal): Promise<SavedReportRecord[]> {
    const rows = await this.db
      .select()
      .from(savedReports)
      .where(eq(savedReports.companyId, principal.companyId))
      .orderBy(desc(savedReports.updatedAt));

    return rows.flatMap((row) => {
      const definition = reportByKey(row.reportKey);
      // A saved view whose report no longer exists is skipped rather than rendered broken.
      if (!definition) return [];
      return [
        {
          id: row.id,
          name: row.name,
          reportKey: row.reportKey,
          reportName: definition.name,
          category: definition.category,
          config: row.config as Record<string, unknown>,
          ownerName: row.ownerName,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          lastRunAt: row.lastRunAt?.toISOString() ?? null,
        },
      ];
    });
  }

  async save(principal: Principal, input: SaveReportRequest): Promise<SavedReportRecord[]> {
    const definition = reportByKey(input.reportKey);
    if (!definition) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'No such report' });
    }
    const [clash] = await this.db
      .select({ id: savedReports.id })
      .from(savedReports)
      .where(
        and(eq(savedReports.companyId, principal.companyId), eq(savedReports.name, input.name)),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A saved report called "${input.name}" already exists`,
      });
    }

    const id = `srp_${crypto.randomUUID()}`;
    await this.db.insert(savedReports).values({
      id,
      companyId: principal.companyId,
      name: input.name,
      reportKey: input.reportKey,
      config: input.config,
      ownerUserId: principal.userId,
      ownerName: principal.userName ?? principal.userId,
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'saved_report',
      entityId: id,
      entityLabel: input.name,
      summary: `Saved report "${input.name}" created from ${definition.name}`,
    });
    return this.list(principal);
  }

  async remove(principal: Principal, id: string): Promise<SavedReportRecord[]> {
    const [existing] = await this.db
      .select()
      .from(savedReports)
      .where(and(eq(savedReports.companyId, principal.companyId), eq(savedReports.id, id)))
      .limit(1);
    if (!existing) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such saved report' });
    }
    await this.db.delete(savedReports).where(eq(savedReports.id, id));
    await this.audit.write(principal, {
      action: 'delete',
      entityType: 'saved_report',
      entityId: id,
      entityLabel: existing.name,
      summary: `Saved report "${existing.name}" deleted`,
    });
    return this.list(principal);
  }

  /** Records that a saved view was run, so the library can show when it was last used. */
  async touch(principal: Principal, reportKey: string): Promise<void> {
    await this.db
      .update(savedReports)
      .set({ lastRunAt: new Date() })
      .where(
        and(eq(savedReports.companyId, principal.companyId), eq(savedReports.reportKey, reportKey)),
      );
  }
}
