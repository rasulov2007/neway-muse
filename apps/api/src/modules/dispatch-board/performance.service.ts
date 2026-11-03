import { Injectable } from '@nestjs/common';
import { loadTeamNames, withTeamName } from './team-names';
import { and, eq } from 'drizzle-orm';
import {
  DEFAULT_PERFORMANCE_TARGETS,
  PerformanceTargetsSchema,
  addDays,
  buildPerformance,
  periodOf,
  shiftPeriod,
  withoutTrucklessTeams,
  type DispatcherPerformanceLoad,
  type PeriodKind,
  type PerformanceBoard,
  type PerformanceRosterRow,
  type PerformanceTargets,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { dispatchRoster } from '../../database/schema/dispatch-ops';
import { drivers, trucks } from '../../database/schema/roster';
import { loads } from '../../database/schema/loads';
import { StateService } from '../state/state.service';
import { isNoDispatcher } from './no-dispatcher';

/**
 * The Dispatcher Performance board, assembled and handed to the engine.
 *
 * This service does the reading and nothing else: the arithmetic and every judgement about it
 * live in `buildPerformance`, where they are tested. Two things are read — the loads the
 * workspace holds and the roster rows that say whose board each driver is on — and the previous
 * period is built the same way so the ▲▼ movement is a real comparison rather than a guess.
 */

/** A load as the workspace stores it; only the fields the board counts. */
interface StoredLoadRow {
  id?: unknown;
  status?: unknown;
  driverId?: unknown;
  rate?: unknown;
  loadedMiles?: unknown;
  weightLbs?: unknown;
  weight?: unknown;
  pickupAt?: unknown;
  stops?: unknown;
}

function num(value: unknown): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** A weight that was never recorded is null, not zero: zero would drag every average down. */
function weightOf(row: StoredLoadRow): number | null {
  const raw = row.weightLbs ?? row.weight;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}

@Injectable()
export class PerformanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly state: StateService,
  ) {}

  async board(
    principal: Principal,
    kind: PeriodKind,
    date: string,
  ): Promise<PerformanceBoard & { label: string; previousLabel: string }> {
    const [loads, fullRoster, targets] = await Promise.all([
      this.loads(principal.companyId),
      this.roster(principal.companyId),
      this.targets(principal.companyId),
    ]);

    const period = periodOf(kind, date);
    const previousStart = shiftPeriod(kind, period.start, -1);
    const previous = periodOf(kind, previousStart);
    // A dispatcher is on the boards once a truck is assigned to them (owner, 2026-10-26); one
    // whose drivers booked loads in the two periods shown stays, so earned history never vanishes.
    const span = bounds(previous.start, period.end);
    const [spanFrom, spanTo] = [Date.parse(span.from), Date.parse(span.to)];
    const booked = new Set(
      loads
        .filter((l) => {
          const at = Date.parse(l.pickupAt);
          return Boolean(l.driverId) && at >= spanFrom && at <= spanTo;
        })
        .map((l) => l.driverId as string),
    );
    const roster = withoutTrucklessTeams(
      fullRoster.filter((r) => !r.unassignedAt),
      (r) => Boolean(r.driverId && booked.has(r.driverId)),
    ).concat(fullRoster.filter((r) => r.unassignedAt));

    /*
     * The previous period is scored with today's roster, because the roster is not versioned by
     * day — the movement arrow compares performance, not team changes. A dispatcher who took over
     * a board mid-period therefore inherits its history, which is the honest reading of "who is
     * running this board now".
     */
    const previousBoard = buildPerformance({
      ...bounds(previous.start, previous.end),
      loads,
      roster,
      targets,
    });
    const previousRanks = Object.fromEntries(
      previousBoard.rows.map((row) => [row.dispatcherId, row.rank]),
    );

    const board = buildPerformance({
      ...bounds(period.start, period.end),
      loads,
      roster,
      targets,
      previousRanks,
    });
    // Nicknames for teams linked to employees (owner, 2026-10-26).
    const names = await loadTeamNames(this.database.db, principal.companyId);
    return {
      ...board,
      rows: board.rows.map((row) => withTeamName(row, names)),
      label: period.label,
      previousLabel: previous.label,
    };
  }

  /** The targets this company uses, or the owner's defaults until somebody changes them. */
  async targets(companyId: string): Promise<PerformanceTargets> {
    const row = await this.state.get(this.targetsKey(companyId));
    if (!row) return DEFAULT_PERFORMANCE_TARGETS;
    const parsed = PerformanceTargetsSchema.safeParse(JSON.parse(row.value));
    // A stored value that no longer fits the contract is ignored rather than crashing the board;
    // the page then shows the defaults, which is visibly wrong rather than invisibly wrong.
    return parsed.success ? parsed.data : DEFAULT_PERFORMANCE_TARGETS;
  }

  async saveTargets(companyId: string, targets: PerformanceTargets): Promise<PerformanceTargets> {
    await this.state.put(this.targetsKey(companyId), JSON.stringify(targets));
    return targets;
  }

  private targetsKey(companyId: string): string {
    return `perf-targets-${companyId.toLowerCase()}`;
  }

  private async roster(companyId: string): Promise<PerformanceRosterRow[]> {
    const rows = await this.database.db
      .select({
        driverId: dispatchRoster.driverId,
        name: dispatchRoster.name,
        payTag: dispatchRoster.payTag,
        dispatcherId: dispatchRoster.dispatcherId,
        dispatcherName: dispatchRoster.dispatcherName,
        truckUnit: dispatchRoster.truckUnit,
        // An empty board truck means "read the driver file", as on the boards.
        fileTruckUnit: trucks.unitNumber,
        unassignedAt: dispatchRoster.unassignedAt,
      })
      .from(dispatchRoster)
      .leftJoin(drivers, and(eq(drivers.companyId, companyId), eq(drivers.id, dispatchRoster.driverId)))
      .leftJoin(trucks, and(eq(trucks.companyId, companyId), eq(trucks.id, drivers.currentTruckId)))
      .where(and(eq(dispatchRoster.companyId, companyId)));
    return rows
      // A row with no dispatcher belongs to no board, so it belongs on no scoreboard either.
      .filter((r) => r.dispatcherId.trim() !== '' && !isNoDispatcher(r.dispatcherId))
      .map((r) => ({
        driverId: r.driverId,
        name: r.name,
        payTag: r.payTag,
        dispatcherId: r.dispatcherId,
        dispatcherName: r.dispatcherName || r.dispatcherId,
        truckUnit: r.truckUnit ?? r.fileTruckUnit ?? null,
        unassignedAt: r.unassignedAt ? r.unassignedAt.toISOString() : null,
      }));
  }

  private async loads(companyId: string): Promise<DispatcherPerformanceLoad[]> {
    const rows = await this.database.db
      .select({ record: loads.record })
      .from(loads)
      .where(and(eq(loads.companyId, companyId), eq(loads.isDemo, false)));
    const parsed: unknown = rows.map((r) => r.record);
    if (!Array.isArray(parsed)) return [];
    return (parsed as StoredLoadRow[]).map((l) => {
      const stops = Array.isArray(l.stops) ? (l.stops as Record<string, unknown>[]) : [];
      const firstPickup = stops.find((s) => s.kind === 'pickup');
      return {
        id: String(l.id ?? ''),
        status: String(l.status ?? ''),
        driverId: l.driverId ? String(l.driverId) : null,
        pickupAt: String(firstPickup?.appointmentStartAt ?? l.pickupAt ?? ''),
        rate: num(l.rate),
        loadedMiles: num(l.loadedMiles),
        weightLbs: weightOf(l),
        stops: stops
          .filter((s) => s.kind === 'pickup' || s.kind === 'delivery')
          .map((s) => ({
            kind: s.kind as 'pickup' | 'delivery',
            appointmentStartAt: String(s.appointmentStartAt ?? ''),
            appointmentEndAt: String(s.appointmentEndAt ?? ''),
            arrivedAt: s.arrivedAt ? String(s.arrivedAt) : null,
          })),
      };
    });
  }
}

/**
 * A period's bounds as instants, and how many weeks long it is.
 *
 * The end is the last day's final millisecond: a load picked up at four in the afternoon on the
 * last day of the period is in the period, and comparing dates alone would drop it.
 */
function bounds(start: string, end: string): { from: string; to: string; weeks: number } {
  const from = `${start}T00:00:00.000Z`;
  const to = `${end}T23:59:59.999Z`;
  const days = Math.round((Date.parse(addDays(end, 1)) - Date.parse(start)) / 86_400_000);
  return { from, to, weeks: Math.max(days / 7, 1 / 7) };
}
