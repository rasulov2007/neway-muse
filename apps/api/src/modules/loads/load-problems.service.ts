import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { CloseLoadProblemInput, FlagLoadInput, LoadProblem } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { loadProblems, type LoadProblemRow } from '../../database/schema/load-problems';
import { loads as loadsTable } from '../../database/schema/loads';
import { AuditService } from '../people/audit.service';

/**
 * Flags on loads (rule 1.10).
 *
 * Opening one is a person saying "this needs a person"; closing one is a person saying what was
 * done. Both are audited. A flag never changes the load's status and never blocks a write; it
 * only keeps the load in front of everybody until it is closed.
 */
@Injectable()
export class LoadProblemsService {
  constructor(
    private readonly audit: AuditService,
    private readonly database: DatabaseService,
  ) {}

  /** The clock every write stamps; a test replaces it. */
  clock: () => Date = () => new Date();

  /** Every flag in the company, open ones only unless asked otherwise, newest first. */
  async list(principal: Principal, options: { open: boolean }): Promise<LoadProblem[]> {
    const where = options.open
      ? and(eq(loadProblems.companyId, principal.companyId), isNull(loadProblems.closedAt))
      : eq(loadProblems.companyId, principal.companyId);
    const rows = await this.database.db.select().from(loadProblems).where(where).orderBy(desc(loadProblems.openedAt));
    return rows.map(toProblem);
  }

  /** The flags on one load, open and closed, newest first. */
  async forLoad(principal: Principal, loadId: string): Promise<LoadProblem[]> {
    const rows = await this.database.db
      .select()
      .from(loadProblems)
      .where(and(eq(loadProblems.companyId, principal.companyId), eq(loadProblems.loadId, loadId)))
      .orderBy(desc(loadProblems.openedAt));
    return rows.map(toProblem);
  }

  async flag(principal: Principal, loadId: string, input: FlagLoadInput): Promise<LoadProblem> {
    const at = this.clock();
    const [load] = await this.database.db
      .select({ id: loadsTable.id, loadNumber: loadsTable.loadNumber })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, principal.companyId), eq(loadsTable.id, loadId)))
      .limit(1);
    if (!load) throw new NotFoundException('That load is not in this company.');
    const row: typeof loadProblems.$inferInsert = {
      id: `lpr_${at.getTime().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
      companyId: principal.companyId,
      loadId: load.id,
      loadNumber: load.loadNumber,
      kind: input.kind,
      note: input.note.trim(),
      openedById: principal.userId,
      openedByName: principal.userName ?? 'Signed-in user',
      openedAt: at,
    };
    await this.database.db.insert(loadProblems).values(row);
    await this.audit.write(principal, {
      action: 'load_flagged',
      entityType: 'load',
      entityId: load.id,
      entityLabel: load.loadNumber,
      summary: `Flagged ${load.loadNumber}: ${input.kind.replace(/_/g, ' ')}.`,
      reason: row.note,
      changes: [{ field: 'problems', old: null, new: row.id }],
      at,
    });
    const [stored] = await this.database.db.select().from(loadProblems).where(eq(loadProblems.id, row.id)).limit(1);
    return toProblem(stored as LoadProblemRow);
  }

  async close(principal: Principal, loadId: string, problemId: string, input: CloseLoadProblemInput): Promise<LoadProblem> {
    const at = this.clock();
    const [row] = await this.database.db
      .select()
      .from(loadProblems)
      .where(and(eq(loadProblems.companyId, principal.companyId), eq(loadProblems.loadId, loadId), eq(loadProblems.id, problemId)))
      .limit(1);
    if (!row) throw new NotFoundException('That flag is not on this load.');
    if (row.closedAt) throw new ConflictException(`That flag was already closed by ${row.closedByName ?? 'somebody'}.`);
    await this.database.db
      .update(loadProblems)
      .set({
        closedById: principal.userId,
        closedByName: principal.userName ?? 'Signed-in user',
        closedAt: at,
        closeNote: input.note.trim(),
        version: row.version + 1,
      })
      .where(and(eq(loadProblems.id, row.id), eq(loadProblems.version, row.version)));
    await this.audit.write(principal, {
      action: 'load_flag_closed',
      entityType: 'load',
      entityId: row.loadId,
      entityLabel: row.loadNumber,
      summary: `Closed the ${row.kind.replace(/_/g, ' ')} flag on ${row.loadNumber}.`,
      reason: input.note.trim(),
      changes: [{ field: `problems.${row.id}.closedAt`, old: null, new: at.toISOString() }],
      at,
    });
    const [stored] = await this.database.db.select().from(loadProblems).where(eq(loadProblems.id, row.id)).limit(1);
    return toProblem(stored as LoadProblemRow);
  }
}

function toProblem(row: LoadProblemRow): LoadProblem {
  return {
    id: row.id,
    loadId: row.loadId,
    loadNumber: row.loadNumber,
    kind: row.kind as LoadProblem['kind'],
    note: row.note,
    openedById: row.openedById,
    openedByName: row.openedByName,
    openedAt: row.openedAt.toISOString(),
    closedById: row.closedById,
    closedByName: row.closedByName,
    closedAt: row.closedAt ? row.closedAt.toISOString() : null,
    closeNote: row.closeNote,
  };
}
