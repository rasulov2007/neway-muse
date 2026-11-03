import { Injectable, ForbiddenException, NotFoundException, UnprocessableEntityException } from '@nestjs/common';
import { and, eq, inArray, sql } from 'drizzle-orm';
import {
  suggestMatches,
  type LinkRosterRowInput,
  type MatchDriver,
  type MergeConflict,
  type MergePreview,
  type RosterMatchReport,
  type RowMatchView,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import {
  dispatchBoardCells,
  dispatchBoardEdits,
  dispatchBoardFills,
  dispatchRoster,
  dispatchRosterAssignments,
  drivers,
  trucks,
} from '../../database/schema';
import { AuditService } from '../people/audit.service';

/**
 * Matching the board's roster rows to driver files, one confirmed row at a time.
 *
 * The board was imported from the company's sheet, so a row is a name and a truck number. A row
 * only sees loads once it carries a driver file's id, and the two are joined here - by a person,
 * never by the machine. This service suggests, and it applies exactly what was confirmed.
 *
 * Confirming can mean merging: a driver file already has a board row of its own (every active
 * driver gets one), so linking an imported row to that driver brings two rows together. That is
 * done in one transaction - the typed cells, the fills and the assignment history move to the
 * surviving row, the imported row is retired with a reason, and nothing is deleted.
 */
/** What a board column is called when a person has to choose between two of them. */
const COLUMN_LABEL: Record<string, string> = {
  load_number: 'Load #',
  status: 'Status',
  truck: 'Truck #',
  trailer: 'Trailer #',
  phone: 'Phone',
  eta: 'ETA',
  miles: 'Miles',
  route: 'Route',
  notes: 'Notes',
};

@Injectable()
export class RosterMatchService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  private manageOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch.manage')) {
      throw new ForbiddenException('Matching board rows to drivers takes dispatch.manage');
    }
  }

  /** Every unlinked row with its candidates, plus what the row would carry into a merge. */
  async report(principal: Principal): Promise<RosterMatchReport> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    const [rosterRows, driverRows] = await Promise.all([
      this.db.select().from(dispatchRoster).where(eq(dispatchRoster.companyId, companyId)),
      this.db
        .select({
          id: drivers.id,
          firstName: drivers.firstName,
          lastName: drivers.lastName,
          phone: drivers.phone,
          status: drivers.status,
          truckUnit: trucks.unitNumber,
        })
        .from(drivers)
        .leftJoin(trucks, eq(trucks.id, drivers.currentTruckId))
        .where(eq(drivers.companyId, companyId)),
    ]);

    const linkedDriverIds = new Set(rosterRows.map((r) => r.driverId).filter((x): x is string => Boolean(x)));
    const candidates: MatchDriver[] = driverRows.map((d) => ({
      id: d.id,
      firstName: d.firstName,
      lastName: d.lastName,
      phone: d.phone,
      truckUnit: d.truckUnit ?? null,
      status: d.status,
      hasRosterRow: linkedDriverIds.has(d.id),
    }));

    const unlinked = rosterRows.filter((r) => !r.driverId && !r.unassignedAt);
    const typed = await this.typedCounts(companyId, unlinked.map((r) => r.id));

    const rows: RowMatchView[] = unlinked
      .map((r) => {
        const match = suggestMatches(
          { id: r.id, name: r.name, coDriver: r.coDriver, truckUnit: r.truckUnit, phone: r.phone },
          candidates,
        );
        const counts = typed.get(r.id) ?? { cells: 0, lastAt: null };
        return {
          row: {
            id: r.id,
            name: r.name,
            coDriver: r.coDriver,
            truckUnit: r.truckUnit,
            phone: r.phone,
            dispatcherName: r.dispatcherName,
            version: r.version,
            typedCells: counts.cells,
            lastTypedAt: counts.lastAt,
          },
          candidates: match.candidates,
          ambiguous: match.ambiguous,
          none: match.none,
        };
      })
      .sort((a, b) => {
        // The rows somebody is actually typing on come first; then the ones with a candidate.
        if (a.row.typedCells !== b.row.typedCells) return b.row.typedCells - a.row.typedCells;
        if (a.none !== b.none) return a.none ? 1 : -1;
        return a.row.name.localeCompare(b.row.name);
      });

    return {
      rows,
      linkedCount: rosterRows.filter((r) => r.driverId).length,
      unlinkedCount: unlinked.length,
      driverFileCount: driverRows.length,
    };
  }

  /** How much typed work each row carries, so the screen can say what a merge would move. */
  private async typedCounts(
    companyId: string,
    rosterIds: string[],
  ): Promise<Map<string, { cells: number; lastAt: string | null }>> {
    const out = new Map<string, { cells: number; lastAt: string | null }>();
    if (rosterIds.length === 0) return out;
    const rows = await this.db
      .select({
        driverId: dispatchBoardCells.driverId,
        cells: sql<number>`count(*)::int`,
        lastAt: sql<string | null>`max(${dispatchBoardCells.setAt})`,
      })
      .from(dispatchBoardCells)
      .where(and(eq(dispatchBoardCells.companyId, companyId), inArray(dispatchBoardCells.driverId, rosterIds)))
      .groupBy(dispatchBoardCells.driverId);
    for (const r of rows) out.set(r.driverId, { cells: Number(r.cells), lastAt: r.lastAt ? String(r.lastAt) : null });
    return out;
  }

  /**
   * The two rows side by side, what moves, and every place they disagree.
   *
   * Nothing is decided here. A disagreement is reported with both values and both times, and the
   * person picks - because "the newer one wins" is a rule that silently moves a load number onto
   * the wrong driver on the one day it matters.
   */
  async preview(principal: Principal, rosterId: string, driverId: string): Promise<MergePreview> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    const [from] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.id, rosterId), eq(dispatchRoster.companyId, companyId)))
      .limit(1);
    if (!from) throw new NotFoundException('That board row is not on this company');
    const [into] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, driverId)))
      .limit(1);

    const shape = (r: typeof from) => ({
      id: r.id,
      name: r.name,
      truckUnit: r.truckUnit,
      phone: r.phone,
      coDriver: r.coDriver,
      payTag: r.payTag,
      dispatcherName: r.dispatcherName,
      comment: r.comment,
      version: r.version,
    });

    if (!into) {
      return { from: shape(from), into: null, movingCells: 0, keptCells: 0, conflicts: [] };
    }

    const conflicts: MergeConflict[] = [];
    const fieldRows: { key: keyof typeof from; label: string; operational: boolean }[] = [
      { key: 'truckUnit', label: 'Truck number', operational: true },
      { key: 'coDriver', label: 'Co-driver', operational: true },
      { key: 'dispatcherName', label: 'Team', operational: true },
      { key: 'payTag', label: 'Pay tag', operational: false },
      { key: 'phone', label: 'Phone', operational: false },
      { key: 'comment', label: 'Comment', operational: false },
    ];
    for (const f of fieldRows) {
      const keep = (into[f.key] as string | null) ?? null;
      const take = (from[f.key] as string | null) ?? null;
      if (!take || !keep) continue; // one side empty: it simply fills, nobody disagrees
      if (String(keep).trim() === String(take).trim()) continue;
      conflicts.push({
        key: `field:${String(f.key)}`,
        kind: 'field',
        label: f.label,
        keepValue: String(keep),
        takeValue: String(take),
        keepDetail: `${into.name}'s row`,
        takeDetail: `${from.name} (imported)`,
        operational: f.operational,
      });
    }

    const [theirs, mine] = await Promise.all([
      this.db.select().from(dispatchBoardCells).where(and(eq(dispatchBoardCells.companyId, companyId), eq(dispatchBoardCells.driverId, from.id))),
      this.db.select().from(dispatchBoardCells).where(and(eq(dispatchBoardCells.companyId, companyId), eq(dispatchBoardCells.driverId, into.id))),
    ]);
    const mineKey = new Map(mine.map((c) => [`${String(c.day)}|${c.column}`, c]));
    let movingCells = 0;
    const OPERATIONAL_COLUMNS = new Set(['load_number', 'status', 'truck', 'trailer', 'eta', 'route']);
    for (const cell of theirs) {
      const key = `${String(cell.day)}|${cell.column}`;
      const held = mineKey.get(key);
      if (!held) {
        movingCells += 1;
        continue;
      }
      if ((held.value ?? '') === (cell.value ?? '')) continue;
      conflicts.push({
        key: `cell:${key}`,
        kind: 'cell',
        label: `${COLUMN_LABEL[cell.column] ?? cell.column} on ${String(cell.day)}`,
        keepValue: held.value,
        takeValue: cell.value,
        keepDetail: `${held.setByName || 'someone'} · ${held.setAt.toISOString()}`,
        takeDetail: `${cell.setByName || 'someone'} · ${cell.setAt.toISOString()}`,
        operational: OPERATIONAL_COLUMNS.has(cell.column),
      });
    }

    return {
      from: shape(from),
      into: shape(into),
      movingCells,
      keptCells: mine.length,
      conflicts: conflicts.sort((a, b) => Number(b.operational) - Number(a.operational) || a.label.localeCompare(b.label)),
    };
  }

  /**
   * Apply one confirmed match.
   *
   * Everything happens in one transaction: either the row carries the driver's id and the typed
   * work has moved with it, or nothing changed. Where both rows typed the same cell on the same
   * day, the newer one wins and the older is dropped - the edit history of both is kept, so the
   * dropped value is still readable.
   */
  async link(principal: Principal, rosterId: string, input: LinkRosterRowInput): Promise<{ survivingRowId: string; movedCells: number; retiredRowId: string | null }> {
    this.manageOrThrow(principal);
    const companyId = principal.companyId;
    const now = this.clock();

    const [row] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.id, rosterId), eq(dispatchRoster.companyId, companyId)))
      .limit(1);
    if (!row) throw new NotFoundException('That board row is not on this company');
    if (row.driverId) {
      throw new UnprocessableEntityException(`${row.name} is already linked to a driver file`);
    }
    if (row.version !== input.expectedVersion) {
      throw new UnprocessableEntityException(`${row.name} changed while you were looking at it. Reload and try again.`);
    }

    const [driver] = await this.db
      .select({ id: drivers.id, firstName: drivers.firstName, lastName: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.id, input.driverId), eq(drivers.companyId, companyId)))
      .limit(1);
    if (!driver) throw new NotFoundException('That driver file is not on this company');
    const driverName = `${driver.firstName} ${driver.lastName}`.trim();

    const [existing] = await this.db
      .select()
      .from(dispatchRoster)
      .where(and(eq(dispatchRoster.companyId, companyId), eq(dispatchRoster.driverId, driver.id)))
      .limit(1);
    if (existing && !input.mergeAcknowledged) {
      throw new UnprocessableEntityException(
        `${driverName} already has a board row. Confirming this match merges the two rows - the screen has to say so first.`,
      );
    }

    // Every disagreement the preview reported has to carry an answer.
    const preview = existing ? await this.preview(principal, rosterId, driver.id) : null;
    const unresolved = (preview?.conflicts ?? []).filter((c) => !input.resolutions[c.key]);
    if (unresolved.length > 0) {
      throw new UnprocessableEntityException(
        `Choose which value to keep for: ${unresolved.map((c) => c.label).join(', ')}.`,
      );
    }

    let movedCells = 0;
    await this.db.transaction(async (tx) => {
      if (!existing) {
        // The simple case: the row takes the driver's id and keeps everything it has.
        await tx
          .update(dispatchRoster)
          .set({ driverId: driver.id, updatedAt: now, version: row.version + 1 })
          .where(and(eq(dispatchRoster.id, rosterId), eq(dispatchRoster.version, row.version)));
        return;
      }

      /*
       * The merge. The driver's own row survives, because typed cells elsewhere in the system
       * key on it; the imported row hands over its work and is retired.
       */
      const theirs = await tx
        .select()
        .from(dispatchBoardCells)
        .where(and(eq(dispatchBoardCells.companyId, companyId), eq(dispatchBoardCells.driverId, rosterId)));
      const mine = await tx
        .select()
        .from(dispatchBoardCells)
        .where(and(eq(dispatchBoardCells.companyId, companyId), eq(dispatchBoardCells.driverId, existing.id)));
      const mineKey = new Map(mine.map((c) => [`${String(c.day)}|${c.column}`, c]));

      for (const cell of theirs) {
        const key = `${String(cell.day)}|${cell.column}`;
        const held = mineKey.get(key);
        if (held && (held.value ?? '') !== (cell.value ?? '')) {
          // A disagreement: the person's choice decides, never the clock.
          const choice = input.resolutions[`cell:${key}`];
          if (choice === 'keep') {
            await tx.delete(dispatchBoardCells).where(eq(dispatchBoardCells.id, cell.id));
            continue;
          }
          await tx.delete(dispatchBoardCells).where(eq(dispatchBoardCells.id, held.id));
          await tx.update(dispatchBoardCells).set({ driverId: existing.id }).where(eq(dispatchBoardCells.id, cell.id));
          movedCells += 1;
          continue;
        }
        if (held) {
          // The same value on both rows: one copy is enough.
          await tx.delete(dispatchBoardCells).where(eq(dispatchBoardCells.id, cell.id));
          continue;
        }
        await tx.update(dispatchBoardCells).set({ driverId: existing.id }).where(eq(dispatchBoardCells.id, cell.id));
        movedCells += 1;
      }

      // Fills and history follow their cells; the history is never rewritten, only re-pointed.
      await tx
        .update(dispatchBoardFills)
        .set({ driverId: existing.id })
        .where(and(eq(dispatchBoardFills.companyId, companyId), eq(dispatchBoardFills.driverId, rosterId)));
      await tx
        .update(dispatchBoardEdits)
        .set({ driverId: existing.id })
        .where(and(eq(dispatchBoardEdits.companyId, companyId), eq(dispatchBoardEdits.driverId, rosterId)));
      await tx
        .update(dispatchRosterAssignments)
        .set({ rosterId: existing.id })
        .where(and(eq(dispatchRosterAssignments.companyId, companyId), eq(dispatchRosterAssignments.rosterId, rosterId)));

      /*
       * Facts the driver file does not carry - the sheet's truck number, pay tag, co-driver and
       * team - move across only where the surviving row has nothing. A driver's own record is
       * never overwritten by an import.
       */
      // Retired, never deleted: the row stays readable with the reason it stopped.
      await tx
        .update(dispatchRoster)
        .set({
          unassignedAt: now,
          unassignedFrom: now.toISOString().slice(0, 10),
          unassignedReason: `Merged into ${driverName}'s board row`,
          importKey: null,
          updatedAt: now,
          version: row.version + 1,
        })
        .where(and(eq(dispatchRoster.id, rosterId), eq(dispatchRoster.version, row.version)));

      /*
       * A field the surviving row lacks is filled from the import; a field they disagree on takes
       * the person's answer. Nothing is decided by which row was written last.
       */
      const pick = (field: string, keep: string | null, take: string | null): string | null => {
        if (!take) return keep;
        if (!keep) return take;
        if (keep.trim() === take.trim()) return keep;
        return input.resolutions[`field:${field}`] === 'take' ? take : keep;
      };
      await tx
        .update(dispatchRoster)
        .set({
          truckUnit: pick('truckUnit', existing.truckUnit, row.truckUnit),
          payTag: pick('payTag', existing.payTag, row.payTag),
          coDriver: pick('coDriver', existing.coDriver, row.coDriver),
          phone: pick('phone', existing.phone || null, row.phone || null) ?? '',
          dispatcherId: existing.dispatcherId || row.dispatcherId,
          dispatcherName: pick('dispatcherName', existing.dispatcherName || null, row.dispatcherName || null) ?? '',
          comment: pick('comment', existing.comment || null, row.comment || null) ?? '',
          sourceName: existing.sourceName ?? row.sourceName,
          importKey: existing.importKey ?? row.importKey,
          updatedAt: now,
          version: existing.version + 1,
        })
        .where(and(eq(dispatchRoster.id, existing.id), eq(dispatchRoster.version, existing.version)));
    });

    await this.audit.write(principal, {
      action: 'dispatch.roster.linked',
      entityType: 'dispatch_roster',
      entityId: existing ? existing.id : rosterId,
      entityLabel: row.name,
      summary: existing
        ? `${row.name} matched to ${driverName}; two board rows merged, ${movedCells} typed cell${movedCells === 1 ? '' : 's'} moved`
        : `${row.name} matched to ${driverName}`,
      changes: [
        { field: 'driverId', old: null, new: driver.id },
        ...(existing ? [{ field: 'mergedInto', old: rosterId, new: existing.id }] : []),
        /*
         * Both values of every disagreement, and which one was chosen. The audit is the only
         * place the value that lost is still readable, so it is written in full.
         */
        ...(preview?.conflicts ?? []).map((c) => ({
          field: `conflict.${c.key}`,
          old: `${c.label}: kept "${c.keepValue ?? ''}" / imported "${c.takeValue ?? ''}"`,
          new: input.resolutions[c.key] === 'take' ? `took "${c.takeValue ?? ''}"` : `kept "${c.keepValue ?? ''}"`,
        })),
      ],
      reason: null,
    });

    return {
      survivingRowId: existing ? existing.id : rosterId,
      movedCells,
      retiredRowId: existing ? rosterId : null,
    };
  }
}
