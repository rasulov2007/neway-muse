import { Injectable } from '@nestjs/common';
import { compareTeams, loadTeamNames, withTeamName } from './team-names';
import { and, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  BOARD_WORDS_NEEDING_A_LOAD,
  boardLoadsFor,
  loadInHandSince,
  typedForEarlierLoad,
  BOARD_COLUMNS,
  CARRY_COLUMNS,
  WEEKLY_COLUMNS,
  WEEK_COMMENT_COLUMN,
  addDays,
  assignmentInForce,
  presenceInWeek,
  presenceOnDay,
  daysWorked,
  dispatcherCommission,
  dollarsToCents,
  payableCommissionCents,
  efficiencyPct,
  evaluateFormula,
  isFormula,
  isoWeek,
  localParts,
  parseAmount,
  parseMiles,
  payBlockOf,
  planAdjustedCents,
  planReachCents,
  statusDef,
  statusRank,
  timeInZone,
  updateDue,
  weekDays,
  weekStartMonday,
  withoutTrucklessTeams,
  vacationDaysBetween,
  type AtHomeList,
  type BoardCell,
  type BoardColumn,
  type BoardEdit,
  type BoardLoad,
  type CommissionView,
  type DailyBoard,
  type DailyBoardRow,
  type PolicyVersion,
  type StoredLoad,
  type WeeklyBoard,
  type WeeklyBoardRow,
  type WeeklyDay,
  type WriteBoardCellsInput,
  type WriteBoardFillInput,
  type WriteWeekFlagsInput,
  type WriteWeekOverrideInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import {
  dispatchBoardCells,
  dispatchBoardEdits,
  dispatchBoardFills,
} from '../../database/schema/dispatch-board';
import { dispatchAllocations, dispatchWeekFlags, dispatchWeekOverrides } from '../../database/schema/dispatch-ops';
import { employees } from '../../database/schema/people';
import { trailers } from '../../database/schema/fleet';
import { loads as loadsTable } from '../../database/schema/loads';
import { loadProblems } from '../../database/schema/load-problems';
import { audit, companyToday, conflict, forbidden, iso, newId, unprocessable } from './ops.helpers';
import { PolicyService } from './policy.service';
import { RosterService, teamInForce, type ResolvedRow } from './roster.service';
import { VacationsService } from '../roster/vacations.service';

/** Loads the boards count as on a driver: booked or moving, not finished and not cancelled. */
const LIVE_LOAD_STATUSES = new Set([
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);
/** Money never lands on a cancelled or TONU load. */
const NO_MONEY_STATUSES = new Set(['cancelled', 'tonu']);
/** The sheet counted a load's money on the US-Eastern day of its pickup. */
const MONEY_ZONE = 'America/New_York';

type CellRow = typeof dispatchBoardCells.$inferSelect;
type OverrideRow = typeof dispatchWeekOverrides.$inferSelect;
type FlagRow = typeof dispatchWeekFlags.$inferSelect;

/** A truck-week priced: what the salary report and the weekly board both read. */
export interface PricedWeek {
  row: WeeklyBoardRow;
  commission: CommissionView;
}

/**
 * The Daily Dispatch Board and the Weekly Production Board (owner's brief, 2026-09-22).
 *
 * Every automatic value comes from the roster and the loads; every typed value comes from
 * `dispatch_board_cells`; every money figure goes through the shared policy engine, in cents,
 * under the policy version in force for the week. The service never invents a status - a
 * status on the board is one a person chose - and never invents an ETA, a mile or a location:
 * live tracking is not connected, and the board says so.
 */
@Injectable()
export class DispatchBoardService {
  constructor(
    private readonly database: DatabaseService,
    private readonly roster: RosterService,
    private readonly policies: PolicyService,
    private readonly vacations: VacationsService,
  ) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------ daily

  async daily(principal: Principal, day: string): Promise<DailyBoard> {
    const companyId = principal.companyId;
    const now = this.clock();
    const roster = await this.roster.rows(companyId);
    const [loads, cells, fills, histories] = await Promise.all([
      this.loads(companyId),
      this.cellsInForce(companyId, day),
      this.fillsFor(companyId, day, day),
      this.roster.histories(companyId),
    ]);
    const [trailerNumbers, openFlags] = await Promise.all([
      this.trailerNumbers(
        companyId,
        loads.map((l) => l.trailerId).filter((x): x is string => Boolean(x)),
      ),
      this.openFlags(companyId),
    ]);
    const nowIso = now.toISOString();
    // The trailer each driver last pulled (owner, 2026-11-01): READY empties the load columns, not
    // the trailer - the truck still has it. The driver's newest load that named one.
    const lastTrailer = new Map<string, string>();
    for (const l of [...loads].sort((a, b) => this.pickupOf(b).localeCompare(this.pickupOf(a)))) {
      if (!l.driverId || !l.trailerId || lastTrailer.has(l.driverId)) continue;
      const n = trailerNumbers.get(l.trailerId);
      if (n) lastTrailer.set(l.driverId, n);
    }
    /*
     * The day's roster (owner, 2026-10-01): a row is on the board from its first assignment, off
     * it from the week it was unassigned from, and sits in the team that held it ON this day - so
     * a driver added today is not on yesterday's board and a moved driver stays with the old team
     * on the days before the move. A row somebody typed into that day always stays.
     */
    const onBoard = roster.flatMap((r) => {
      const h = histories.get(r.id);
      const typedThatDay =
        [...(cells.get(r.id)?.values() ?? [])].some((c) => String(c.day).slice(0, 10) === day) ||
        Object.keys(fills.get(`${r.id}|${day}`) ?? {}).length > 0;
      const presence = presenceOnDay({ onBoardFrom: h?.onBoardFrom ?? null, unassignedFrom: r.unassignedFrom }, day, typedThatDay);
      if (presence !== 'on') return [];
      const pin = h ? assignmentInForce(h.history, day) : null;
      if (!pin) return [r];
      // An Unassign in force that day puts the row in Unassigned drivers (owner, 2026-10-26).
      return [
        {
          ...r,
          ...teamInForce(pin, r),
          truckUnit: pin.truckUnit ?? r.truckUnit,
          coDriver: pin.coDriver ?? null,
          payTag: pin.payTag ?? r.payTag,
        },
      ];
    });
    const allRows: DailyBoardRow[] = onBoard.map((d) => {
      const mine = d.driverId
        ? loads
            .filter((l) => l.driverId === d.driverId && LIVE_LOAD_STATUSES.has(l.status))
            .map((l) => this.boardLoad(l, trailerNumbers, { nowIso, openFlags }))
            .sort((a, b) => Date.parse(a.pickupAt) - Date.parse(b.pickupAt))
        : [];
      const driverCells = cells.get(d.id) ?? new Map<string, CellRow>();
      const cellMap: Record<string, BoardCell> = {};
      for (const [column, row] of driverCells) cellMap[column] = this.toCell(row);
      const typedStatus = cellMap.status?.value ?? null;
      /*
       * The Load # column is the load the driver is actually on: one that is moving, or one a
       * person has dispatched. A prebook waits in Notes until somebody dispatches it - the
       * office puts it in the Load column themselves, which is the moment it becomes today's
       * work rather than next week's. And on READY the row carries nothing at all: the truck is
       * empty, so the columns are too. The rule is in `boardLoadsFor`, with its tests.
       */
      // A load assigned to a waiting driver reads DISPATCHED (owner, 2026-09-30): `status` is
      // the word the row shows, which may be that automatic one rather than the typed cell.
      const { primary, queued, status } = boardLoadsFor(typedStatus, mine);
      // LOAD # / ETA / ROUTE / MILES typed for the load before this one give way to this load's own.
      if (primary && d.driverId) {
        const stored = loads.find((l) => l.id === primary.id);
        const since = loadInHandSince(
          { id: primary.id, dispatchedAt: stored?.dispatchedAt ?? null },
          loads.filter((l) => l.driverId === d.driverId),
          nowIso,
        );
        for (const [column, cell] of Object.entries(cellMap)) {
          if (typedForEarlierLoad(column, cell.setAt, since)) cellMap[column] = { ...cell, earlierLoad: true };
        }
      }
      return {
        driverId: d.id,
        driverName: d.name.toUpperCase(),
        coDriver: d.coDriver ? d.coDriver.toUpperCase() : null,
        payTag: d.payTag,
        driverNumber: d.driverNumber,
        driverType: d.driverType,
        dispatcherId: d.dispatcherId,
        dispatcherName: d.dispatcherName,
        phone: d.phone,
        truckUnit: d.truckUnit,
        truckConflict: d.truckConflict,
        cdlHold: this.cdlHold(d, day),
        primaryLoad: primary,
        queuedLoads: queued,
        auto: this.autoValues(d, primary, status, day, d.driverId ? (lastTrailer.get(d.driverId) ?? null) : null),
        cells: cellMap,
        fills: fills.get(`${d.id}|${day}`) ?? {},
        status,
        statusSince: cellMap.status?.setAt ?? null,
        rosterVersion: d.version,
      };
    });
    // A dispatcher is on the board once a truck is assigned to them (owner, 2026-10-26): a team
    // with no truck that day is left out, unless one of its drivers is on a live load.
    const rows = withoutTrucklessTeams(allRows, (r) => r.primaryLoad !== null || r.queuedLoads.length > 0);
    // Board order (owner, 2026-10-26): teams by their number, then solo dispatchers, then Unassigned.
    const names = await loadTeamNames(this.db, companyId);
    const byTeam = compareTeams(names);
    rows.sort((a, b) => {
      const team = byTeam(a, b);
      if (team !== 0) return team;
      const rank = statusRank(a.status) - statusRank(b.status);
      if (rank !== 0) return rank;
      return a.driverName.localeCompare(b.driverName);
    });
    const teams = new Map<string, { dispatcherId: string; dispatcherName: string; driverCount: number }>();
    for (const r of rows) {
      const t = teams.get(r.dispatcherId) ?? { dispatcherId: r.dispatcherId, dispatcherName: r.dispatcherName, driverCount: 0 };
      t.driverCount += 1;
      teams.set(r.dispatcherId, t);
    }
    return {
      day,
      today: companyToday(principal, now),
      nowIso: now.toISOString(),
      rows: rows.map((r) => withTeamName(r, names)),
      teams: [...teams.values()].sort(byTeam).map((t) => withTeamName(t, names)),
      canWrite: hasPermission(principal, 'dispatch.edit'),
      canManage: hasPermission(principal, 'dispatch.manage'),
      liveTracking: false,
    };
  }

  // ------------------------------------------------------------------------------ weekly

  async weekly(principal: Principal, weekStartInput: string): Promise<WeeklyBoard> {
    const weekStart = weekStartMonday(weekStartInput);
    // Commission is dispatcher pay: Accounting and Administrator see all of it (owner, 2026-10-26);
    // a dispatcher sees only the commission of the teams they are split into (owner, 2026-11-01).
    const seesAll = hasPermission(principal, 'dispatch_pay.view');
    const [{ priced, policy, days }, ownTeams] = await Promise.all([
      this.priceWeek(principal.companyId, weekStart),
      seesAll ? Promise.resolve(null) : this.ownTeams(principal, weekStart),
    ]);
    const seesCommission = seesAll || (ownTeams?.size ?? 0) > 0;
    const sees = (dispatcherId: string) => seesAll || (ownTeams?.has(dispatcherId) ?? false);
    const rows: WeeklyBoardRow[] = [];
    const unassigned: WeeklyBoardRow[] = [];
    for (const p of priced) {
      const row = !p.row.unassignedAt && sees(p.row.dispatcherId) ? { ...p.row, commission: p.commission } : { ...p.row, commission: null };
      if (row.unassignedAt) unassigned.push(row);
      else rows.push(row);
    }
    const names = await loadTeamNames(this.db, principal.companyId);
    const byTeam = compareTeams(names);
    rows.sort((a, b) => byTeam(a, b) || b.total - a.total);

    const teams = new Map<string, WeeklyBoard['teams'][number]>();
    for (const r of rows) {
      const t =
        teams.get(r.dispatcherId) ??
        ({
          dispatcherId: r.dispatcherId,
          dispatcherName: r.dispatcherName,
          total: 0,
          miles: 0,
          rpm: null,
          goal: 0,
          dayTotals: [0, 0, 0, 0, 0, 0, 0],
          trucks: 0,
          commissionCents: sees(r.dispatcherId) ? 0 : null,
        } as WeeklyBoard['teams'][number]);
      t.total = round2(t.total + r.total);
      t.miles += r.miles;
      t.goal += r.goal;
      t.trucks += 1;
      r.days.forEach((x, i) => (t.dayTotals[i] = round2((t.dayTotals[i] ?? 0) + x.amount)));
      if (t.commissionCents !== null && r.commission) t.commissionCents += r.commission.payableCents;
      teams.set(r.dispatcherId, t);
    }
    for (const t of teams.values()) t.rpm = t.miles > 0 ? round2(t.total / t.miles) : null;
    const grandTotal = round2(rows.reduce((s, r) => s + r.total, 0));
    const grandMiles = rows.reduce((s, r) => s + r.miles, 0);
    return {
      weekStart,
      days,
      payBlock: payBlockOf(weekStart),
      isoWeek: isoWeek(weekStart),
      policyVersion: policy.version,
      rows: rows.map((r) => withTeamName(r, names)),
      unassigned: unassigned.map((r) => withTeamName(r, names)),
      teams: [...teams.values()].sort(byTeam).map((t) => withTeamName(t, names)),
      grand: {
        total: grandTotal,
        miles: grandMiles,
        rpm: grandMiles > 0 ? round2(grandTotal / grandMiles) : null,
        dayTotals: days.map((_, i) => round2(rows.reduce((s, r) => s + (r.days[i]?.amount ?? 0), 0))),
        trucks: rows.length,
        commissionCents: seesCommission ? rows.reduce((s, r) => s + (r.commission?.payableCents ?? 0), 0) : null,
      },
      canWrite: hasPermission(principal, 'dispatch.edit'),
      canManage: hasPermission(principal, 'dispatch.manage'),
      seesCommission,
    };
  }

  /**
   * The teams whose commission a dispatcher may see (owner, 2026-11-01): the ones whose split in
   * force on the week's Monday names an employee linked to this login, or whose board id is that
   * employee (a one-person team keyed on the employee, as at Harbor Line).
   */
  private async ownTeams(principal: Principal, weekStart: string): Promise<Set<string>> {
    const mine = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.userId, principal.userId)));
    const ids = new Set(mine.map((e) => e.id));
    const out = new Set<string>(ids);
    if (ids.size === 0) return out;
    const rows = await this.db
      .select({ dispatcherId: dispatchAllocations.dispatcherId, shares: dispatchAllocations.shares })
      .from(dispatchAllocations)
      .where(and(eq(dispatchAllocations.companyId, principal.companyId), lte(dispatchAllocations.effectiveFrom, weekStart)))
      .orderBy(desc(dispatchAllocations.effectiveFrom), desc(dispatchAllocations.at));
    const seen = new Set<string>();
    for (const r of rows) {
      if (seen.has(r.dispatcherId)) continue;
      seen.add(r.dispatcherId);
      let shares: { employeeId?: string | null }[] = [];
      try {
        shares = JSON.parse(r.shares) as { employeeId?: string | null }[];
      } catch {
        shares = [];
      }
      if (shares.some((s) => s.employeeId && ids.has(s.employeeId))) out.add(r.dispatcherId);
    }
    return out;
  }

  /**
   * Every row's week, priced under the policy in force for that Monday. The salary report
   * calls this for each week of its period, so the two can never disagree.
   */
  async priceWeek(companyId: string, weekStart: string): Promise<{ priced: PricedWeek[]; policy: PolicyVersion; days: string[] }> {
    const days = weekDays(weekStart);
    const last = days[6]!;
    // The roster first: reading it records any team change made outside the board, which the
    // history read below must see.
    const roster = await this.roster.rows(companyId);
    const [loads, weekCells, fills, overrides, flags, policy, histories] = await Promise.all([
      this.loads(companyId),
      this.weekCells(companyId, weekStart, last),
      this.fillsFor(companyId, weekStart, last),
      this.overridesFor(companyId, weekStart),
      this.flagsFor(companyId, weekStart),
      this.policies.inForce(companyId, weekStart),
      this.roster.histories(companyId),
    ]);
    const priced: PricedWeek[] = [];
    for (const d of roster) {
      if (d.unassignedFrom && d.unassignedFrom <= weekStart && !d.unassignedAt) continue;
      const hiddenThisWeek = Boolean(d.unassignedFrom && d.unassignedFrom <= weekStart);
      const history = histories.get(d.id);
      const pin = history ? assignmentInForce(history.history, last) : null;
      // The week's team, truck and co-driver: pinned when an assignment row is dated on or before
      // the week's Sunday, so a reassignment today never moves this week's earnings.
      // An Unassign in force for the week puts the row in Unassigned drivers (owner, 2026-10-26).
      const { dispatcherId, dispatcherName } = teamInForce(pin, d);
      const truckUnit = pin ? (pin.truckUnit ?? d.truckUnit) : d.truckUnit;
      const coDriver = pin ? (pin.coDriver ?? null) : d.coDriver;
      const pinned = Boolean(pin) && (dispatcherId !== d.dispatcherId || truckUnit !== d.truckUnit || coDriver !== d.coDriver);
      const mine = d.driverId ? loads.filter((l) => l.driverId === d.driverId && !NO_MONEY_STATUSES.has(l.status)) : [];
      const dayRows: WeeklyDay[] = days.map((day) => {
        const onDay = mine.filter((l) => localParts(this.pickupOf(l), MONEY_ZONE)?.date === day);
        const autoAmount = round2(onDay.reduce((s, l) => s + (Number(l.rate) || 0), 0));
        // Miles = loaded + deadhead (owner, 2026-10-29): the week's RPM and commission read the whole trip.
        const autoMiles = onDay.reduce((s, l) => s + boardMilesOf(l as unknown as Record<string, unknown>), 0);
        const key = `${d.id}|${day}`;
        const amountCell = weekCells.get(`${key}|amount`) ?? null;
        const milesCell = weekCells.get(`${key}|wk_miles`) ?? null;
        const loadCell = weekCells.get(`${key}|wk_load`) ?? null;
        const word = amountCell?.value && statusDef(amountCell.value) ? statusDef(amountCell.value)!.code : null;
        const amount =
          word !== null ? 0 : amountCell && amountCell.value !== null ? Number(amountCell.value) || 0 : amountCell ? 0 : autoAmount;
        const miles = milesCell && milesCell.value !== null ? Number(milesCell.value) || 0 : milesCell ? 0 : autoMiles;
        return {
          day,
          autoAmount,
          autoMiles,
          loadNumbers: onDay.map((l) => l.loadNumber),
          // Load # row: the broker reference first, then the load number - `4471823 - L-100015` (owner, 2026-10-27).
          loadLabels: onDay.map((l) => {
            const ref = typeof l['brokerReference'] === 'string' ? l['brokerReference'].trim() : '';
            return ref ? `${ref} - ${l.loadNumber}` : l.loadNumber;
          }),
          loads: onDay.map((l) => ({ loadNumber: l.loadNumber, amount: round2(Number(l.rate) || 0), miles: boardMilesOf(l as unknown as Record<string, unknown>) })),
          amount: round2(amount),
          miles,
          // Only a word typed in the Amount cell paints the day; the daily board's status stays on the daily board.
          statusWord: word,
          amountCell: amountCell ? this.toCell(amountCell) : null,
          milesCell: milesCell ? this.toCell(milesCell) : null,
          loadCell: loadCell ? this.toCell(loadCell) : null,
          fills: fills.get(key) ?? {},
        };
      });
      // The week's Comment: free text on the Monday, outside every total.
      const weekComment = weekCells.get(`${d.id}|${weekStart}|${WEEK_COMMENT_COLUMN}`) ?? null;
      // Not on the board yet this week (added later): left out, unless the week already holds
      // something of theirs - a typed cell, a fill, money from a load, an override or a flag.
      const hasDataThisWeek =
        weekComment !== null ||
        overrides.has(d.id) ||
        flags.has(d.id) ||
        dayRows.some(
          (x) => x.amountCell || x.milesCell || x.loadCell || x.loadNumbers.length > 0 || Object.keys(x.fills).length > 0,
        );
      if (presenceInWeek({ onBoardFrom: history?.onBoardFrom ?? null, unassignedFrom: null }, weekStart, hasDataThisWeek) === 'not-yet')
        continue;
      const totalCents = dayRows.reduce((s, x) => s + dollarsToCents(x.amount), 0);
      const total = totalCents / 100;
      const miles = dayRows.reduce((s, x) => s + x.miles, 0);
      const unit = coDriver ? ('team' as const) : ('solo' as const);
      const goal = policy.policy[unit].goal;
      const goalCents = dollarsToCents(goal);
      const worked = daysWorked(dayRows.map((x) => x.statusWord));
      const flag = flags.get(d.id) ?? null;
      const engine = dispatcherCommission(
        { unit, grossCents: totalCents, miles, complaint: flag?.complaint ?? false, junior: flag?.junior ?? false },
        policy.policy,
      );
      // The sheet's rule (owner, 2026-10-27): a week that misses Plan Adj pays nothing - "No payment ·
      // missed Plan Adj" - whatever the gross tier would have paid.
      const planAdjCents = planAdjustedCents(totalCents, goalCents, worked);
      const missedPlan = totalCents > 0 && planAdjCents < 0;
      const calc = missedPlan
        ? {
            ...engine,
            status: 'no_payment' as const,
            amountCents: 0,
            pct: 0,
            basePct: 0,
            bonusPct: 0,
            tier: 'No payment · missed Plan Adj',
            bonusWithheld: false,
            formula: `Plan Adj ${planAdjCents < 0 ? '-' : ''}$${(Math.abs(planAdjCents) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} → no payment (missed Plan Adj)`,
          }
        : engine;
      const override = overrides.get(d.id) ?? null;
      // No gross, no commission: an adjustment waits for gross; only a typed approved amount pays
      // on a $0 week (owner, 2026-10-26). The rule is in `payableCommissionCents`, with its tests.
      const { payableCents, adjustmentHeld } = payableCommissionCents(
        calc.amountCents,
        // A week that pays nothing (missed Plan Adj, below floor) holds an adjustment too.
        calc.amountCents > 0 ? totalCents : 0,
        override ? { mode: override.mode as 'amount' | 'adjustment', amountCents: override.amountCents } : null,
      );
      const commission: CommissionView = {
        adjustmentHeld,
        status: calc.status,
        calculatedCents: calc.amountCents,
        payableCents,
        pct: calc.pct,
        basePct: calc.basePct,
        bonusPct: calc.bonusPct,
        tier: calc.tier,
        formula: calc.formula,
        bonusWithheld: calc.bonusWithheld,
        override: override
          ? { mode: override.mode as 'amount' | 'adjustment', amountCents: override.amountCents, reason: override.reason, byName: override.byName, at: override.at.toISOString(), version: override.version }
          : null,
        flags: { complaint: flag?.complaint ?? false, junior: flag?.junior ?? false, reason: flag?.reason ?? '' },
        policyVersion: policy.version,
      };
      priced.push({
        row: {
          driverId: d.id,
          driverName: d.name.toUpperCase(),
          coDriver: coDriver ? coDriver.toUpperCase() : null,
          payTag: pin ? (pin.payTag ?? d.payTag) : d.payTag,
          driverType: d.driverType,
          comment: d.comment,
          driverNumber: d.driverNumber,
          truckUnit,
          dispatcherId,
          dispatcherName,
          unit,
          pinned,
          days: dayRows,
          weekComment: weekComment ? this.toCell(weekComment) : null,
          total,
          miles,
          rpm: miles > 0 ? round2(total / miles) : null,
          goal,
          planReach: planReachCents(totalCents, goalCents) / 100,
          planAdj: planAdjustedCents(totalCents, goalCents, worked) / 100,
          daysWorked: worked,
          efficiencyPct: efficiencyPct(totalCents, goalCents),
          commission: null,
          unassignedAt: hiddenThisWeek ? d.unassignedAt : null,
          rosterVersion: d.version,
        },
        commission,
      });
    }
    /*
     * A dispatcher is on the boards once a truck is assigned to them (owner, 2026-10-26): a team
     * with no truck in the week is left out - unless the week holds money or a load of theirs, so
     * a past week's earnings never vanish. Unassigned drivers are not a team and always stay.
     * Here rather than in `weekly` so the Weekly board, the Salary Report and Payroll agree.
     */
    const shown = withoutTrucklessTeams(
      priced.map((p) => ({ dispatcherId: p.row.unassignedAt ? '' : p.row.dispatcherId, truckUnit: p.row.truckUnit, p })),
      ({ p }) => p.row.total !== 0 || p.commission.payableCents !== 0 || p.row.days.some((x) => x.loadNumbers.length > 0),
    ).map(({ p }) => p);
    return { priced: shown, policy, days };
  }

  async history(principal: Principal, driverId: string, limit = 30): Promise<BoardEdit[]> {
    const rows = await this.db
      .select()
      .from(dispatchBoardEdits)
      .where(and(eq(dispatchBoardEdits.companyId, principal.companyId), eq(dispatchBoardEdits.driverId, driverId)))
      .orderBy(desc(dispatchBoardEdits.at))
      .limit(limit);
    return rows.map((r) => ({
      id: r.id,
      driverId: r.driverId,
      day: String(r.day),
      column: r.column as BoardColumn,
      oldValue: r.oldValue,
      newValue: r.newValue,
      byName: r.byName,
      at: r.at.toISOString(),
      source: (r.source as BoardEdit['source']) ?? 'user',
    }));
  }

  // ------------------------------------------------------------------------------ writes

  /**
   * Typed cells, in one batch (a paste, a fill-down, an undo). Each one is logged. A cell with
   * an `expectedVersion` that no longer matches refuses the whole batch with 409: nothing is
   * half-saved, and the client reloads before trying again.
   */
  async writeCells(principal: Principal, input: WriteBoardCellsInput): Promise<BoardCell[]> {
    if (!hasPermission(principal, 'dispatch.edit')) throw forbidden('Writing the board takes dispatch.edit');
    const companyId = principal.companyId;
    const now = this.clock();
    const by = principal.userId;
    const byName = principal.userName ?? by;
    const rosterIds = new Set((await this.roster.rows(companyId)).map((r) => r.id));
    const out: BoardCell[] = [];
    // Status words written today or earlier, for the vacation sync after the write (owner, 2026-10-17).
    const statusWritten: { rowId: string; day: string; word: string }[] = [];
    await this.db.transaction(async (tx) => {
      for (const cell of input.cells) {
        if (!rosterIds.has(cell.driverId)) throw unprocessable('That row is not on this company\'s board');
        // LOAD # comes from the load on the driver, never from a person typing (owner, 2026-10-13).
        if (cell.column === 'load_number') throw unprocessable('LOAD # is the load assigned to the driver and cannot be typed or cleared. Assign or release the load instead.');
        if (cell.column === WEEK_COMMENT_COLUMN && weekStartMonday(cell.day) !== cell.day)
          throw unprocessable('The weekly comment is kept on the week\'s Monday');
        const [existing] = await tx
          .select()
          .from(dispatchBoardCells)
          .where(
            and(
              eq(dispatchBoardCells.companyId, companyId),
              eq(dispatchBoardCells.driverId, cell.driverId),
              eq(dispatchBoardCells.day, cell.day),
              eq(dispatchBoardCells.column, cell.column),
            ),
          )
          .limit(1);
        if (cell.expectedVersion !== undefined) {
          const current = existing?.version ?? null;
          if (current !== cell.expectedVersion)
            throw conflict(
              existing
                ? `${cell.column} on ${cell.day} was changed by ${existing.setByName} at ${existing.setAt.toISOString()}. Reload before writing again.`
                : `${cell.column} on ${cell.day} was cleared by someone else. Reload before writing again.`,
              { current: existing ? this.toCell(existing) : null, driverId: cell.driverId, day: cell.day, column: cell.column },
            );
        }
        let oldValue = existing ? (existing.formula ?? existing.value) : null;
        // A carry column with no row of its own on the day shows yesterday's value; that is what
        // the person replaced, so the history says it (owner, 2026-10-27: "SPRINGFIELD, MA" went
        // into the history as "empty").
        if (!existing && CARRY_COLUMNS.includes(cell.column as BoardColumn)) {
          const [carried] = await tx
            .select()
            .from(dispatchBoardCells)
            .where(
              and(
                eq(dispatchBoardCells.companyId, companyId),
                eq(dispatchBoardCells.driverId, cell.driverId),
                eq(dispatchBoardCells.column, cell.column),
                lte(dispatchBoardCells.day, cell.day),
              ),
            )
            .orderBy(desc(dispatchBoardCells.day))
            .limit(1);
          if (carried) oldValue = carried.formula ?? carried.value;
        }
        if (cell.restore) {
          if (existing) await tx.delete(dispatchBoardCells).where(eq(dispatchBoardCells.id, existing.id));
          await tx.insert(dispatchBoardEdits).values({
            id: newId('dbe'),
            companyId,
            driverId: cell.driverId,
            day: cell.day,
            column: cell.column,
            oldValue,
            newValue: null,
            by,
            byName,
            at: now,
            source: 'user',
          });
          continue;
        }
        const { value, formula } = this.normalise(cell.column, cell.value);
        // DISPATCHED, ENROUTE and UNLOADING describe a load in hand (owner, 2026-09-30).
        if (cell.column === 'status' && value && BOARD_WORDS_NEEDING_A_LOAD.has(value)) {
          await this.requireALoad(companyId, cell.driverId, value);
        }
        const unchanged = existing && existing.value === value && (existing.formula ?? null) === formula;
        if (unchanged) {
          out.push(this.toCell(existing));
          continue;
        }
        const row = {
          id: existing?.id ?? newId('dbc'),
          companyId,
          driverId: cell.driverId,
          day: cell.day,
          column: cell.column,
          value,
          formula,
          setBy: by,
          setByName: byName,
          setAt: now,
          version: (existing?.version ?? 0) + 1,
        };
        if (existing) await tx.update(dispatchBoardCells).set(row).where(eq(dispatchBoardCells.id, existing.id));
        else await tx.insert(dispatchBoardCells).values(row);
        await tx.insert(dispatchBoardEdits).values({
          id: newId('dbe'),
          companyId,
          driverId: cell.driverId,
          day: cell.day,
          column: cell.column,
          oldValue,
          newValue: formula ?? value,
          by,
          byName,
          at: now,
          source: 'user',
        });
        out.push(this.toCell({ ...row, day: cell.day } as CellRow));
        if (cell.column === 'status' && value) statusWritten.push({ rowId: cell.driverId, day: cell.day, word: value });
      }
    });
    // VACATION on the board puts the driver on vacation; an on-duty word later brings them back.
    if (statusWritten.length > 0) {
      const rows = await this.roster.rows(companyId);
      for (const w of statusWritten) {
        const driverId = rows.find((r) => r.id === w.rowId)?.driverId;
        const def = statusDef(w.word);
        if (!driverId || !def) continue;
        try {
          await this.vacations.syncFromBoard(principal, driverId, w.day, def.code, !def.off);
        } catch (error) {
          // The board write already succeeded; a failed sync must not undo it.
          console.warn('Vacation sync from the board failed', driverId, w.day, String(error));
        }
      }
    }
    return out;
  }

  /** Refuses a load word on a row whose driver has no load assigned. */
  private async requireALoad(companyId: string, rosterRowId: string, word: string): Promise<void> {
    const row = (await this.roster.rows(companyId)).find((r) => r.id === rosterRowId);
    const driverId = row?.driverId ?? null;
    const has = driverId
      ? (await this.loads(companyId)).some((l) => l.driverId === driverId && LIVE_LOAD_STATUSES.has(l.status))
      : false;
    if (!has) {
      throw unprocessable(
        `${row?.name ?? 'This driver'} has no load assigned, so the row cannot read ${word}. Assign a load on the Loads page; the row turns DISPATCHED by itself.`,
      );
    }
  }

  /** What a typed value becomes, per column. Refuses what the column cannot hold. */
  private normalise(column: BoardColumn, typed: string | null): { value: string | null; formula: string | null } {
    if (typed === null) return { value: null, formula: null };
    const text = typed.trim();
    // The weekly comment is free text, kept as typed: never a formula, never a number.
    if (column === WEEK_COMMENT_COLUMN) return { value: text === '' ? null : text, formula: null };
    if (column === 'status') {
      const def = statusDef(text);
      if (!def) throw unprocessable(`"${typed}" is not a status on the palette`);
      return { value: def.code, formula: null };
    }
    if (column === 'amount') {
      if (text === '') return { value: null, formula: null };
      const parsed = parseAmount(text);
      if (!parsed) throw unprocessable(`"${typed}" is not an amount, a formula or a status word`);
      if (parsed.kind === 'status') return { value: parsed.code, formula: null };
      return { value: String(parsed.value), formula: parsed.formula };
    }
    if (column === 'wk_miles' || column === 'miles') {
      if (text === '') return { value: null, formula: null };
      const parsed = parseMiles(text);
      if (!parsed) throw unprocessable(`"${typed}" is not a mileage (a number, "1,250 mi" or =600+650; never negative)`);
      return { value: String(parsed.value), formula: parsed.formula };
    }
    if (isFormula(text)) {
      const n = evaluateFormula(text);
      if (n === null) throw unprocessable(`"${typed}" is not a formula the board can work out`);
      return { value: String(n), formula: text };
    }
    return { value: text, formula: null };
  }

  async writeFills(principal: Principal, input: WriteBoardFillInput): Promise<{ written: number }> {
    if (!hasPermission(principal, 'dispatch.edit')) throw forbidden('Painting the board takes dispatch.edit');
    const companyId = principal.companyId;
    const now = this.clock();
    let written = 0;
    await this.db.transaction(async (tx) => {
      for (const f of input.fills) {
        if (f.column === 'status') continue; // its colour is meaning
        const where = and(
          eq(dispatchBoardFills.companyId, companyId),
          eq(dispatchBoardFills.driverId, f.driverId),
          eq(dispatchBoardFills.day, f.day),
          eq(dispatchBoardFills.column, f.column),
        );
        if (f.tint === 0) await tx.delete(dispatchBoardFills).where(where);
        else {
          const [existing] = await tx.select({ id: dispatchBoardFills.id }).from(dispatchBoardFills).where(where).limit(1);
          if (existing)
            await tx.update(dispatchBoardFills).set({ tint: f.tint, setBy: principal.userId, setAt: now }).where(eq(dispatchBoardFills.id, existing.id));
          else
            await tx.insert(dispatchBoardFills).values({
              id: newId('dbf'),
              companyId,
              driverId: f.driverId,
              day: f.day,
              column: f.column,
              tint: f.tint,
              setBy: principal.userId,
              setAt: now,
            });
        }
        written += 1;
      }
    });
    return { written };
  }

  /** The Commission cell's manual layer. Admin only; a reason always; the old value in the audit. */
  async writeOverride(principal: Principal, input: WriteWeekOverrideInput): Promise<CommissionView | null> {
    // A manual commission overrides what the KPI engine computed, so it is a compensation
    // decision and takes the compensation permission, not the one that runs the shift.
    if (!hasPermission(principal, 'dispatch_pay.edit')) {
      throw forbidden('A manual commission takes dispatch_pay.edit (company Administrator).');
    }
    const companyId = principal.companyId;
    const weekStart = weekStartMonday(input.weekStart);
    await this.roster.rowOrThrow(companyId, input.rosterId);
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(dispatchWeekOverrides)
        .where(and(eq(dispatchWeekOverrides.companyId, companyId), eq(dispatchWeekOverrides.rosterId, input.rosterId), eq(dispatchWeekOverrides.weekStart, weekStart)))
        .limit(1);
      if (input.expectedVersion !== undefined && (existing?.version ?? null) !== input.expectedVersion)
        throw conflict('The manual commission was changed by someone else. Reload and try again.');
      if (input.mode === null) {
        if (existing) {
          await tx.delete(dispatchWeekOverrides).where(eq(dispatchWeekOverrides.id, existing.id));
          await audit(tx, principal, now, 'override', existing.id, 'reset', existing, { reason: input.reason });
        }
        return;
      }
      if (input.amountCents === undefined) throw unprocessable('An amount is needed');
      const row = {
        id: existing?.id ?? newId('dwo'),
        companyId,
        rosterId: input.rosterId,
        weekStart,
        mode: input.mode,
        amountCents: input.amountCents,
        reason: input.reason,
        by: principal.userId,
        byName: principal.userName ?? principal.userId,
        at: now,
        version: (existing?.version ?? 0) + 1,
      };
      if (existing) await tx.update(dispatchWeekOverrides).set(row).where(eq(dispatchWeekOverrides.id, existing.id));
      else await tx.insert(dispatchWeekOverrides).values(row);
      await audit(tx, principal, now, 'override', row.id, existing ? 'update' : 'create', existing ?? null, row);
    });
    const { priced } = await this.priceWeek(companyId, weekStart);
    return priced.find((p) => p.row.driverId === input.rosterId)?.commission ?? null;
  }

  async writeFlags(principal: Principal, input: WriteWeekFlagsInput): Promise<CommissionView | null> {
    // A verified complaint withholds an RPM bonus and the junior flag replaces the tiers: both
    // decide money, so both take the compensation permission.
    if (!hasPermission(principal, 'dispatch_pay.edit')) {
      throw forbidden('Week eligibility flags take dispatch_pay.edit (company Administrator).');
    }
    const companyId = principal.companyId;
    const weekStart = weekStartMonday(input.weekStart);
    await this.roster.rowOrThrow(companyId, input.rosterId);
    if ((input.complaint || input.junior) && input.reason.trim().length < 3)
      throw unprocessable('A complaint or a junior rate needs a reason');
    const now = this.clock();
    await this.db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(dispatchWeekFlags)
        .where(and(eq(dispatchWeekFlags.companyId, companyId), eq(dispatchWeekFlags.rosterId, input.rosterId), eq(dispatchWeekFlags.weekStart, weekStart)))
        .limit(1);
      const row = {
        id: existing?.id ?? newId('dwf'),
        companyId,
        rosterId: input.rosterId,
        weekStart,
        complaint: input.complaint,
        junior: input.junior,
        reason: input.reason,
        by: principal.userId,
        byName: principal.userName ?? principal.userId,
        at: now,
      };
      if (existing) await tx.update(dispatchWeekFlags).set(row).where(eq(dispatchWeekFlags.id, existing.id));
      else await tx.insert(dispatchWeekFlags).values(row);
      await audit(tx, principal, now, 'week_flags', row.id, existing ? 'update' : 'create', existing ?? null, row);
    });
    const { priced } = await this.priceWeek(companyId, weekStart);
    return priced.find((p) => p.row.driverId === input.rosterId)?.commission ?? null;
  }

  // ------------------------------------------------------------------------------ pieces

  /** The company's loads, from the table (migration 0033). Demo rows never reach a board. */
  private async loads(companyId: string): Promise<StoredLoad[]> {
    const rows = await this.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, companyId), eq(loadsTable.isDemo, false)));
    return rows.map((r) => r.record as StoredLoad);
  }

  /**
   * The trailer a driver is on, as today's Daily board shows it (owner, 2026-10-29): the typed or
   * carried TRAILER cell, else the trailer of the load the row reads, else the trailer of the
   * driver's latest load that had one. Add load fills it in when the driver is picked; the unit
   * number is matched to a trailer on file, or comes back alone when none matches.
   */
  async driverTrailer(principal: Principal, driverId: string): Promise<{ trailerId: string | null; trailerUnit: string | null }> {
    const board = await this.daily(principal, companyToday(principal, new Date()));
    const row = board.rows.find((r) => r.driverId === driverId);
    let unit: string | null = null;
    if (row) {
      const typed = row.cells['trailer'];
      unit = (typed ? typed.value : row.auto['trailer'] ?? null)?.trim() || null;
    }
    if (!unit) {
      const recent = await this.db
        .select({ record: loadsTable.record })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, principal.companyId), eq(loadsTable.driverId, driverId), eq(loadsTable.isDemo, false)))
        .orderBy(desc(loadsTable.updatedAt))
        .limit(20);
      const withTrailer = recent.map((r) => r.record as StoredLoad).find((l) => l.trailerId);
      if (withTrailer?.trailerId) {
        const n = await this.trailerNumbers(principal.companyId, [withTrailer.trailerId]);
        return { trailerId: withTrailer.trailerId, trailerUnit: n.get(withTrailer.trailerId) ?? null };
      }
      return { trailerId: null, trailerUnit: null };
    }
    const [match] = await this.db
      .select({ id: trailers.id })
      .from(trailers)
      .where(and(eq(trailers.companyId, principal.companyId), eq(trailers.unitNumber, unit)))
      .limit(1);
    return { trailerId: match?.id ?? null, trailerUnit: unit };
  }

  /**
   * Drivers at home (owner, 2026-10-30): the rows today's Daily board reads HOME, each with the
   * first day of its unbroken HOME run - the typed status cells walked back from today until a
   * different word.
   */
  async atHome(principal: Principal): Promise<AtHomeList> {
    const day = companyToday(principal, this.clock());
    const board = await this.daily(principal, day);
    const home = board.rows.filter((r) => r.status === 'HOME');
    if (home.length === 0) return { day, rows: [] };
    const [roster, typed] = await Promise.all([
      this.roster.rows(principal.companyId),
      this.db
        .select({ driverId: dispatchBoardCells.driverId, day: dispatchBoardCells.day, value: dispatchBoardCells.value })
        .from(dispatchBoardCells)
        .where(
          and(
            eq(dispatchBoardCells.companyId, principal.companyId),
            eq(dispatchBoardCells.column, 'status'),
            lte(dispatchBoardCells.day, day),
            inArray(dispatchBoardCells.driverId, home.map((r) => r.driverId)),
          ),
        )
        .orderBy(desc(dispatchBoardCells.day)),
    ]);
    const rows = home.map((r) => {
      let since = String(r.cells['status']?.day ?? day).slice(0, 10);
      for (const c of typed) {
        if (c.driverId !== r.driverId) continue;
        if (statusDef(c.value)?.code !== 'HOME') break;
        since = String(c.day).slice(0, 10);
      }
      return {
        rowId: r.driverId,
        driverId: roster.find((x) => x.id === r.driverId)?.driverId ?? null,
        driverName: r.driverName,
        coDriver: r.coDriver,
        unitNumber: r.truckUnit,
        dispatcherName: r.dispatcherName,
        teamNumber: (r as { teamNumber?: number | null }).teamNumber ?? null,
        phone: r.phone,
        homeSince: since,
        daysHome: vacationDaysBetween(since, day),
      };
    });
    rows.sort((a, b) => b.daysHome - a.daysHome || a.driverName.localeCompare(b.driverName));
    return { day, rows };
  }

  private async trailerNumbers(companyId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await this.db
      .select({ id: trailers.id, unitNumber: trailers.unitNumber })
      .from(trailers)
      .where(and(eq(trailers.companyId, companyId), inArray(trailers.id, [...new Set(ids)])));
    return new Map(rows.map((r) => [r.id, r.unitNumber]));
  }

  /** The typed cells in force on a day: the latest row on or before it for carry columns, the day's own for the rest. */
  private async cellsInForce(companyId: string, day: string): Promise<Map<string, Map<string, CellRow>>> {
    const rows = await this.db
      .select()
      .from(dispatchBoardCells)
      .where(and(eq(dispatchBoardCells.companyId, companyId), lte(dispatchBoardCells.day, day)))
      .orderBy(desc(dispatchBoardCells.day));
    const out = new Map<string, Map<string, CellRow>>();
    for (const r of rows) {
      if (!(BOARD_COLUMNS as readonly string[]).includes(r.column)) continue;
      const sameDay = String(r.day) === day;
      if (!sameDay && !CARRY_COLUMNS.includes(r.column as BoardColumn)) continue;
      const mine = out.get(r.driverId) ?? new Map<string, CellRow>();
      if (!mine.has(r.column)) mine.set(r.column, r);
      out.set(r.driverId, mine);
    }
    return out;
  }

  private async weekCells(companyId: string, from: string, to: string): Promise<Map<string, CellRow>> {
    const rows = await this.db
      .select()
      .from(dispatchBoardCells)
      .where(
        and(
          eq(dispatchBoardCells.companyId, companyId),
          gte(dispatchBoardCells.day, from),
          lte(dispatchBoardCells.day, to),
          inArray(dispatchBoardCells.column, [...WEEKLY_COLUMNS]),
        ),
      );
    return new Map(rows.map((r) => [`${r.driverId}|${String(r.day)}|${r.column}`, r]));
  }

  private async fillsFor(companyId: string, from: string, to: string): Promise<Map<string, Record<string, number>>> {
    const rows = await this.db
      .select()
      .from(dispatchBoardFills)
      .where(and(eq(dispatchBoardFills.companyId, companyId), gte(dispatchBoardFills.day, from), lte(dispatchBoardFills.day, to)));
    const out = new Map<string, Record<string, number>>();
    for (const r of rows) {
      const key = `${r.driverId}|${String(r.day)}`;
      const m = out.get(key) ?? {};
      m[r.column] = r.tint;
      out.set(key, m);
    }
    return out;
  }

  private async overridesFor(companyId: string, weekStart: string): Promise<Map<string, OverrideRow>> {
    const rows = await this.db
      .select()
      .from(dispatchWeekOverrides)
      .where(and(eq(dispatchWeekOverrides.companyId, companyId), eq(dispatchWeekOverrides.weekStart, weekStart)));
    return new Map(rows.map((r) => [r.rosterId, r]));
  }

  private async flagsFor(companyId: string, weekStart: string): Promise<Map<string, FlagRow>> {
    const rows = await this.db
      .select()
      .from(dispatchWeekFlags)
      .where(and(eq(dispatchWeekFlags.companyId, companyId), eq(dispatchWeekFlags.weekStart, weekStart)));
    return new Map(rows.map((r) => [r.rosterId, r]));
  }

  private toCell(row: CellRow): BoardCell {
    return {
      driverId: row.driverId,
      day: String(row.day),
      column: row.column as BoardColumn,
      value: row.value,
      formula: row.formula,
      setBy: row.setBy,
      setByName: row.setByName,
      setAt: iso(row.setAt) ?? '',
      version: row.version,
    };
  }

  /** Open flags per load (rule 1.10), for the board to show beside the load number. */
  private async openFlags(companyId: string): Promise<Map<string, number>> {
    const rows = await this.database.db
      .select({ loadId: loadProblems.loadId })
      .from(loadProblems)
      .where(and(eq(loadProblems.companyId, companyId), isNull(loadProblems.closedAt)));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.loadId, (counts.get(r.loadId) ?? 0) + 1);
    return counts;
  }

  private boardLoad(
    l: StoredLoad,
    trailerNumbers: Map<string, string>,
    live?: { nowIso: string; openFlags: Map<string, number> },
  ): BoardLoad {
    const first = l.stops[0];
    const lastStop = l.stops[l.stops.length - 1];
    /*
     * A load with two receivers (owner, 2026-10-28): the board follows the truck - the first
     * pickup and the first delivery not yet done - so ROUTE and ETA name the receiver it is
     * driving to now, and move on to the next once that stop is completed.
     */
    const open = (kind: string) => l.stops.filter((s) => s.kind === kind && s.status !== 'completed');
    const pickupStop = open('pickup')[0] ?? first;
    const deliveriesLeft = open('delivery');
    const deliveryStop = deliveriesLeft[0] ?? lastStop;
    const place = (s: { city: string; state: string } | undefined) => (s ? `${s.city}, ${s.state}` : '');
    /*
     * "Update due" (rule 1.4): the load's next appointment sets the cadence, and the last thing
     * on its timeline is the last time anybody heard from it. Only a rolling load is judged.
     */
    const rolling = live && ['dispatched', 'at_pickup', 'loaded', 'in_transit', 'at_delivery', 'unloading'].includes(l.status);
    const next = l.stops.find((s) => s.status !== 'completed') ?? null;
    const due = rolling
      ? updateDue({ nowIso: live.nowIso, appointmentAt: next?.appointmentStartAt ?? null, lastUpdateAt: l.timeline.at(-1)?.at ?? null }).due
      : false;
    return {
      ...(live ? { updateDue: due, openFlags: live.openFlags.get(l.id) ?? 0 } : {}),
      id: l.id,
      loadNumber: l.loadNumber,
      brokerReference: typeof l['brokerReference'] === 'string' && l['brokerReference'].trim() ? l['brokerReference'].trim() : null,
      status: l.status,
      origin: place(pickupStop),
      destination: place(deliveryStop),
      finalDestination: place(lastStop),
      deliveriesLeft: deliveriesLeft.length,
      pickupAt: pickupStop?.appointmentStartAt ?? (l['pickupAt'] as string) ?? '',
      pickupZone: pickupStop?.timezone ?? null,
      deliveryAt: deliveryStop?.appointmentStartAt ?? (l['deliveryAt'] as string) ?? '',
      deliveryZone: deliveryStop?.timezone ?? null,
      rate: Number(l['rate']) || 0,
      loadedMiles: Number(l['loadedMiles']) || 0,
      emptyMiles: Number(l['emptyMiles']) || 0,
      trailer: l.trailerId ? (trailerNumbers.get(l.trailerId) ?? null) : null,
    };
  }

  private pickupOf(l: StoredLoad): string {
    return l.stops[0]?.appointmentStartAt ?? (l['pickupAt'] as string) ?? '';
  }

  /** What each column shows before anybody types: the sheet's own rules by status. */
  private autoValues(
    d: ResolvedRow,
    primary: BoardLoad | null,
    status: string | null,
    day: string,
    lastTrailer: string | null,
  ): Record<string, string | null> {
    const s = statusDef(status)?.code ?? null;
    const pickupTime = primary ? etaText(primary.pickupAt, primary.pickupZone, day) : '';
    const deliveryTime = primary ? etaText(primary.deliveryAt, primary.deliveryZone, day) : '';
    let eta: string | null = null;
    let route: string | null = null;
    if (primary) {
      if (s === 'DISPATCHED') {
        /*
         * DISPATCHED carries two situations. Running to the shipper, the ETA column answers
         * "when does it get there" with the appointment time; standing on the shipper, that
         * question is answered and the column says so instead.
         */
        eta = primary.status === 'at_pickup' || primary.status === 'loading' ? 'AT PU' : pickupTime;
        route = primary.origin;
      } else if (s === 'AT PU') {
        eta = 'AT PU';
        route = primary.origin;
      } else if (s === 'ENROUTE') {
        eta = deliveryTime;
        route = primary.destination;
      } else if (s === 'UNLOADING') {
        eta = 'UNLOADING';
        route = primary.destination;
      } else if (s === 'COVERED' || s === 'RESERVED' || s === 'HOLD FOR LOAD') {
        eta = pickupTime;
        route = `${primary.origin} → ${primary.finalDestination || primary.destination}`;
      } else if (s === null) route = `${primary.origin} → ${primary.finalDestination || primary.destination}`;
    }
    return {
      status: null,
      // What a copy of LOAD # carries: the broker reference alone, as the cell shows it (owner, 2026-10-26).
      load_number: primary ? primary.brokerReference?.trim() || primary.loadNumber : null,
      truck: d.truckUnit,
      trailer: primary?.trailer ?? lastTrailer,
      phone: d.phone,
      eta,
      route,
      // Loaded + deadhead, as the Weekly board counts them (owner, 2026-10-29).
      miles: primary ? String(primary.loadedMiles + (primary.emptyMiles ?? 0)) : null,
      notes: null,
    };
  }

  private cdlHold(d: ResolvedRow, day: string): string[] {
    const reasons: string[] = [];
    if (d.cdlExpiresOn && d.cdlExpiresOn < day) reasons.push('CDL expired');
    if (d.medicalCardExpiresOn && d.medicalCardExpiresOn < day) reasons.push('Medical card expired');
    return reasons;
  }
}

/**
 * The ETA cell (owner, 2026-10-26): the time alone when the appointment falls on the board's day,
 * with its date in front when it does not - "Oct 27 8:40 AM" - and no zone word; the time and date
 * are the stop's own. A stop with no zone still says so.
 */
export function etaText(iso: string, zone: string | null, day: string): string {
  const full = timeInZone(iso, zone) || '';
  const time = zone && /^\d{1,2}:\d{2} [AP]M \S+$/.test(full) ? full.replace(/ \S+$/, '') : full;
  const date = iso ? localParts(iso, zone ?? MONEY_ZONE)?.date : null;
  if (!time || !date || date === day) return time;
  const [, m, dd] = date.split('-').map(Number);
  const month = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][(m ?? 1) - 1];
  return `${month} ${dd} ${time}`;
}

/** A load's miles on the Weekly board: loaded plus deadhead (owner, 2026-10-29). */
function boardMilesOf(l: Record<string, unknown>): number {
  return (Number(l['loadedMiles']) || 0) + (Number(l['emptyMiles']) || 0);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export { addDays };
