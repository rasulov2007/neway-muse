import { type DispatchTeamMembers, type SeparateDispatchersInput, weekStartMonday } from '@neway/shared';
import { Injectable } from '@nestjs/common';
import { compareTeams, loadTeamNames, withTeamName } from './team-names';
import { and, desc, eq, inArray, isNull, lte } from 'drizzle-orm';
import {
  SalaryReportSchema,
  addDays,
  centsToDollars as cents,
  monthOf,
  payBlockOf,
  periodOf,
  weeksBetween,
  type PeriodKind,
  type SalaryAdjustment,
  type SalaryReport,
  type SalaryRunActionInput,
  type SalaryTeam,
  type SalaryTruckWeek,
  type WriteAllocationInput,
  type WriteSalaryAdjustmentInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { dispatchAllocations, dispatchRoster, dispatchSalaryAdjustments, dispatchSalaryRuns } from '../../database/schema/dispatch-ops';
import { DispatchBoardService } from './dispatch-board.service';
import { audit, companyToday, conflict, forbidden, iso, newId, notFound, unprocessable } from './ops.helpers';
import { XS, buildXlsx, toCsv, type XlsxCell } from './xlsx';

type RunRecord = typeof dispatchSalaryRuns.$inferSelect;
type AdjustmentRecord = typeof dispatchSalaryAdjustments.$inferSelect;

type AllocationShare = { employeeId: string | null; name: string; sharePct: number };
type SalaryAllocationLine = AllocationShare & { payableCents: number };
export type AllocationRow = { dispatcherId: string; effectiveFrom: string; shares: AllocationShare[] };

/** The split each team had on `date`: the newest row effective on or before it. Rows come newest first. */
function allocationsAt(rows: AllocationRow[], date: string): Map<string, { effectiveFrom: string; shares: AllocationShare[] }> {
  const out = new Map<string, { effectiveFrom: string; shares: AllocationShare[] }>();
  for (const r of rows) if (r.effectiveFrom <= date && !out.has(r.dispatcherId)) out.set(r.dispatcherId, { effectiveFrom: r.effectiveFrom, shares: r.shares });
  return out;
}

const personKey = (s: { employeeId: string | null; name: string }) => s.employeeId ?? `name:${s.name.trim().toUpperCase()}`;
const sharesKey = (shares: AllocationShare[]) => shares.map((x) => `${personKey(x)}=${x.sharePct}`).sort().join('|');

/** Splits `cents` by percentages so the parts sum to it exactly (largest remainder; negatives too). */
function largestRemainder(cents: number, pcts: number[]): number[] {
  const sign = cents < 0 ? -1 : 1;
  const abs = Math.abs(cents);
  const raw = pcts.map((p) => (abs * p) / 100);
  const floors = raw.map((r) => Math.floor(r));
  let left = abs - floors.reduce((t, x) => t + x, 0);
  const order = raw.map((r, i) => ({ i, frac: r - Math.floor(r) })).sort((a, b) => b.frac - a.frac);
  for (const o of order) {
    if (left <= 0) break;
    floors[o.i]! += 1;
    left -= 1;
  }
  return floors.map((x) => x * sign);
}

/**
 * How one team's pay divides between its dispatchers.
 *
 * Each week is split by the shares in force THAT week, so a dispatcher who ran a pair board alone
 * for a week is paid that week in full (owner, 2026-10-12): a 100 % row dated to the week, then the
 * pair's row again from the week after. Monthly bonuses and penalties, and any week before the
 * team's first split, use the split in force at the period's end - as every week did before.
 *
 * Null when the team has no split at the end of the period. `allocation` is null when any split
 * used does not total 100 %, which the report shows as "Allocation required".
 */
export function splitTeamPay(
  rows: AllocationRow[],
  dispatcherId: string,
  periodEnd: string,
  weeks: { weekStart: string; commissionCents: number }[],
  adjustmentsCents: number,
): { effectiveFrom: string; allocation: SalaryAllocationLine[] | null } | null {
  const atEnd = allocationsAt(rows, periodEnd).get(dispatcherId);
  if (!atEnd) return null;
  const parts = weeks.map((wk) => ({ shares: (allocationsAt(rows, wk.weekStart).get(dispatcherId) ?? atEnd).shares, cents: wk.commissionCents }));
  parts.push({ shares: atEnd.shares, cents: adjustmentsCents });
  if (!parts.every((x) => Math.abs(x.shares.reduce((t, a) => t + a.sharePct, 0) - 100) < 0.005)) {
    return { effectiveFrom: atEnd.effectiveFrom, allocation: null };
  }
  const people = new Map<string, SalaryAllocationLine>();
  for (const a of atEnd.shares) people.set(personKey(a), { name: a.name, employeeId: a.employeeId, sharePct: a.sharePct, payableCents: 0 });
  for (const part of parts) {
    const cents = largestRemainder(part.cents, part.shares.map((x) => x.sharePct));
    part.shares.forEach((x, i) => {
      const person = people.get(personKey(x)) ?? { name: x.name, employeeId: x.employeeId, sharePct: 0, payableCents: 0 };
      person.payableCents += cents[i]!;
      people.set(personKey(x), person);
    });
  }
  const total = parts.reduce((t, x) => t + x.cents, 0);
  const sameAllWeeks = parts.every((x) => sharesKey(x.shares) === sharesKey(atEnd.shares));
  const allocation = [...people.values()]
    .filter((x) => x.payableCents !== 0 || atEnd.shares.some((a) => personKey(a) === personKey(x)))
    // A week-by-week split has no single percentage; show what each person's lines came to.
    .map((x) => ({ ...x, sharePct: sameAllWeeks || total === 0 ? x.sharePct : Math.round((x.payableCents / total) * 10000) / 100 }));
  return { effectiveFrom: atEnd.effectiveFrom, allocation };
}

/**
 * The Salary Report (owner's brief §11): dispatcher compensation for a week, a 28-day pay
 * period or a calendar month, from the same priced weeks the Weekly Board shows. Team totals
 * split by configured shares; approved monthly bonuses and penalties join in; a run moves from
 * draft to review to final, and a final run is a frozen snapshot that later edits cannot touch.
 */
@Injectable()
export class SalaryService {
  constructor(
    private readonly database: DatabaseService,
    private readonly board: DispatchBoardService,
  ) {}

  clock: () => Date = () => new Date();

  private get db() {
    return this.database.db;
  }

  /**
   * Reading one person's earnings beside another's: `dispatch_pay.view` - Accounting and
   * Administrator (owner, 2026-10-26), not whoever runs the board.
   */
  private payViewOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch_pay.view')) throw forbidden('The salary report takes dispatch_pay.view');
  }

  /** Writes still also take dispatch.manage, as before. */
  private manageOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch.manage')) throw forbidden('Changing the salary report takes dispatch.manage');
  }

  /**
   * Changing what somebody is paid.
   *
   * Monthly bonuses and penalties, the split between dispatchers who shared a truck, and
   * finalizing a salary run are all compensation decisions. They take `dispatch_pay.edit`, which
   * among the seeded roles only Administrator holds - Accounting can run payroll with its own
   * permissions without being able to rewrite the rules the payroll is computed from. The
   * decorator on the route says the same thing; this is the check that survives a route being
   * moved or a new caller being added.
   */
  private payEditOrThrow(principal: Principal): void {
    if (!hasPermission(principal, 'dispatch_pay.edit')) {
      throw forbidden('Changing dispatcher compensation takes dispatch_pay.edit (company Administrator).');
    }
  }

  // ------------------------------------------------------------------------------ the report

  async report(principal: Principal, kind: PeriodKind, date: string): Promise<SalaryReport> {
    this.payViewOrThrow(principal);
    const period = periodOf(kind, date);
    const run = await this.findRun(principal.companyId, kind, period.start);
    if (run?.status === 'final' && run.snapshot) {
      const frozen = SalaryReportSchema.parse(JSON.parse(run.snapshot));
      return { ...frozen, run: this.runView(run), frozen: true, canManage: true };
    }
    const live = await this.compute(principal, kind, period);
    return { ...live, run: run ? this.runView(run) : null, frozen: false, canManage: true };
  }

  /**
   * The same commission figures the Salary Report shows, for an explicit range.
   *
   * Staff Payroll calls this so a dispatcher's pay is the DISP-KPI-01 truck-week calculation and
   * not a second formula that could drift from it. There is no permission check here on purpose:
   * this is a service-to-service call, and the caller has already established that the person may
   * run payroll. Everything reachable from a route still goes through `report`, which does check.
   */
  async earningsForRange(companyId: string, period: { start: string; end: string; label: string }) {
    return this.computeFor(companyId, 'pay_period', period);
  }

  private async compute(
    principal: Principal,
    kind: PeriodKind,
    period: { start: string; end: string; label: string },
  ): Promise<Omit<SalaryReport, 'run' | 'frozen' | 'canManage'>> {
    return this.computeFor(principal.companyId, kind, period);
  }

  private async computeFor(
    companyId: string,
    kind: PeriodKind,
    period: { start: string; end: string; label: string },
  ): Promise<Omit<SalaryReport, 'run' | 'frozen' | 'canManage'>> {
    const weeks = weeksBetween(period.start, period.end);
    const months = kind === 'month' ? [monthOf(period.start)] : monthsInside(period.start, period.end);
    const [priced, adjustments, allocationRows] = await Promise.all([
      Promise.all(weeks.map((w) => this.board.priceWeek(companyId, w))),
      this.adjustmentsFor(companyId, months),
      this.allocationHistory(companyId, period.end),
    ]);
    const policyVersions = [...new Set(priced.map((p) => p.policy.version))];
    const teams = new Map<string, SalaryTeam>();
    priced.forEach((week, i) => {
      const weekStart = weeks[i]!;
      for (const p of week.priced) {
        if (p.row.unassignedAt) continue;
        const key = p.row.dispatcherId || '__none';
        const team =
          teams.get(key) ??
          ({
            dispatcherId: p.row.dispatcherId,
            dispatcherName: p.row.dispatcherName || 'Unassigned',
            weeks: weeks.map((w) => ({ weekStart: w, grossCents: 0, commissionCents: 0, trucks: 0 })),
            grossCents: 0,
            miles: 0,
            rpm: null,
            commissionCents: 0,
            bonusesCents: 0,
            penaltiesCents: 0,
            payableCents: 0,
            allocation: null,
            allocationEffectiveFrom: null,
            needsMiles: 0,
            trucks: [],
            adjustments: [],
          } satisfies SalaryTeam);
        const grossCents = Math.round(p.row.total * 100);
        const c = p.commission;
        const truck: SalaryTruckWeek = {
          weekStart,
          rosterId: p.row.driverId,
          driverName: p.row.coDriver ? `${p.row.driverName} // ${p.row.coDriver}` : p.row.driverName,
          truckUnit: p.row.truckUnit,
          unit: p.row.unit,
          grossCents,
          miles: p.row.miles,
          rpm: p.row.rpm,
          basePct: c.basePct,
          bonusPct: c.bonusPct,
          status: c.status,
          tier: c.tier,
          calculatedCents: c.calculatedCents,
          overrideCents: c.override?.amountCents ?? null,
          overrideMode: c.override?.mode ?? null,
          overrideReason: c.override?.reason ?? null,
          payableCents: c.payableCents,
          formula: c.formula,
          policyVersion: c.policyVersion,
        };
        team.trucks.push(truck);
        team.grossCents += grossCents;
        team.miles += p.row.miles;
        team.commissionCents += c.payableCents;
        if (c.status === 'needs_miles') team.needsMiles += 1;
        const wk = team.weeks[i]!;
        wk.grossCents += grossCents;
        wk.commissionCents += c.payableCents;
        wk.trucks += 1;
        teams.set(key, team);
      }
    });
    for (const team of teams.values()) {
      team.rpm = team.miles > 0 ? Math.round((team.grossCents / team.miles) / 100 * 100) / 100 : null;
      team.adjustments = adjustments.filter((a) => a.dispatcherId === team.dispatcherId).map((a) => this.toAdjustment(a));
      team.bonusesCents = team.adjustments.filter((a) => a.amountCents > 0).reduce((s, a) => s + a.amountCents, 0);
      team.penaltiesCents = team.adjustments.filter((a) => a.amountCents < 0).reduce((s, a) => s + a.amountCents, 0);
      team.payableCents = team.commissionCents + team.bonusesCents + team.penaltiesCents;
      const split = splitTeamPay(allocationRows, team.dispatcherId, period.end, team.weeks, team.bonusesCents + team.penaltiesCents);
      if (split) {
        team.allocationEffectiveFrom = split.effectiveFrom;
        team.allocation = split.allocation;
      }
    }
    // Nicknames for teams linked to employees (owner, 2026-10-26); exports keep the stored name.
    const names = await loadTeamNames(this.db, companyId);
    const list = [...teams.values()]
      .sort(compareTeams(names))
      .map((t) => withTeamName(t, names));
    const totals = list.reduce(
      (t, x) => ({
        grossCents: t.grossCents + x.grossCents,
        commissionCents: t.commissionCents + x.commissionCents,
        bonusesCents: t.bonusesCents + x.bonusesCents,
        penaltiesCents: t.penaltiesCents + x.penaltiesCents,
        payableCents: t.payableCents + x.payableCents,
      }),
      { grossCents: 0, commissionCents: 0, bonusesCents: 0, penaltiesCents: 0, payableCents: 0 },
    );
    return { kind, start: period.start, end: period.end, label: period.label, weeks, months, policyVersions, teams: list, totals };
  }

  // ------------------------------------------------------------------------------ runs

  private runView(r: RunRecord): NonNullable<SalaryReport['run']> {
    return {
      id: r.id,
      status: r.status as 'draft' | 'review' | 'final',
      version: r.version,
      createdByName: r.createdByName,
      createdAt: r.createdAt.toISOString(),
      finalizedByName: r.finalizedByName ?? null,
      finalizedAt: iso(r.finalizedAt),
      reopenedByName: r.reopenedByName ?? null,
      reopenedAt: iso(r.reopenedAt),
      reopenReason: r.reopenReason ?? null,
    };
  }

  private async findRun(companyId: string, kind: PeriodKind, start: string): Promise<RunRecord | null> {
    const [row] = await this.db
      .select()
      .from(dispatchSalaryRuns)
      .where(and(eq(dispatchSalaryRuns.companyId, companyId), eq(dispatchSalaryRuns.periodKind, kind), eq(dispatchSalaryRuns.periodStart, start)))
      .limit(1);
    return row ?? null;
  }

  /** Draft → review → final; final → reopened (audited) → review. Finalizing freezes the snapshot. */
  async act(principal: Principal, kind: PeriodKind, date: string, input: SalaryRunActionInput): Promise<SalaryReport> {
    this.payEditOrThrow(principal);
    this.manageOrThrow(principal);
    const period = periodOf(kind, date);
    const now = this.clock();
    const existing = await this.findRun(principal.companyId, kind, period.start);
    if (input.expectedVersion !== undefined && (existing?.version ?? null) !== input.expectedVersion)
      throw conflict('The salary run was changed by someone else. Reload and try again.');
    const byName = principal.userName ?? principal.userId;
    if (input.action === 'create') {
      if (existing) throw conflict('A run for this period already exists');
      const row = {
        id: newId('dsr'),
        companyId: principal.companyId,
        periodKind: kind,
        periodStart: period.start,
        periodEnd: period.end,
        status: 'draft',
        createdBy: principal.userId,
        createdByName: byName,
        createdAt: now,
      };
      await this.db.transaction(async (tx) => {
        await tx.insert(dispatchSalaryRuns).values(row);
        await audit(tx, principal, now, 'salary_run', row.id, 'create', null, { kind, start: period.start });
      });
      return this.report(principal, kind, date);
    }
    if (!existing) throw notFound('No run for this period yet');
    const patch: Partial<typeof dispatchSalaryRuns.$inferInsert> = { version: existing.version + 1 };
    if (input.action === 'review') {
      if (existing.status !== 'draft') throw unprocessable('Only a draft can go to review');
      patch.status = 'review';
    } else if (input.action === 'back_to_draft') {
      if (existing.status !== 'review') throw unprocessable('Only a run in review can go back to draft');
      patch.status = 'draft';
    } else if (input.action === 'finalize') {
      if (existing.status !== 'review') throw unprocessable('A run is finalized from review');
      const live = await this.compute(principal, kind, period);
      const unallocated = live.teams.filter((t) => t.allocationEffectiveFrom !== null && t.allocation === null);
      if (unallocated.length > 0)
        throw unprocessable(`Shares do not total 100 % for ${unallocated.map((t) => t.dispatcherName).join(', ')}`);
      patch.status = 'final';
      patch.snapshot = JSON.stringify({ ...live, run: null, frozen: true, canManage: true });
      patch.finalizedBy = principal.userId;
      patch.finalizedByName = byName;
      patch.finalizedAt = now;
    } else if (input.action === 'reopen') {
      if (existing.status !== 'final') throw unprocessable('Only a final run can be reopened');
      if (input.reason.trim().length < 3) throw unprocessable('Reopening a final run needs a reason');
      patch.status = 'review';
      patch.reopenedBy = principal.userId;
      patch.reopenedByName = byName;
      patch.reopenedAt = now;
      patch.reopenReason = input.reason;
    }
    await this.db.transaction(async (tx) => {
      await tx.update(dispatchSalaryRuns).set(patch).where(eq(dispatchSalaryRuns.id, existing.id));
      await audit(tx, principal, now, 'salary_run', existing.id, input.action, { status: existing.status }, { status: patch.status, reason: input.reason });
    });
    return this.report(principal, kind, date);
  }

  // ------------------------------------------------------------------------------ adjustments

  private toAdjustment(a: AdjustmentRecord): SalaryAdjustment {
    return {
      id: a.id,
      dispatcherId: a.dispatcherId,
      employeeName: a.employeeName,
      month: a.month,
      kind: a.kind as SalaryAdjustment['kind'],
      amountCents: a.amountCents,
      reason: a.reason,
      approvedByName: a.approvedByName,
      byName: a.byName,
      at: a.at.toISOString(),
      voidedAt: iso(a.voidedAt),
      voidReason: a.voidReason ?? null,
    };
  }

  private async adjustmentsFor(companyId: string, months: string[]): Promise<AdjustmentRecord[]> {
    if (months.length === 0) return [];
    return this.db
      .select()
      .from(dispatchSalaryAdjustments)
      .where(and(eq(dispatchSalaryAdjustments.companyId, companyId), inArray(dispatchSalaryAdjustments.month, months), isNull(dispatchSalaryAdjustments.voidedAt)))
      .orderBy(desc(dispatchSalaryAdjustments.at));
  }

  async addAdjustment(principal: Principal, input: WriteSalaryAdjustmentInput): Promise<SalaryAdjustment> {
    this.payEditOrThrow(principal);
    this.manageOrThrow(principal);
    const now = this.clock();
    const isBonus = input.kind === 'lane_bonus' || input.kind === 'other_bonus';
    if (isBonus && input.amountCents <= 0) throw unprocessable('A bonus is a positive amount');
    if (!isBonus && input.amountCents >= 0) throw unprocessable('A penalty or forfeiture is a negative amount');
    const finalRun = await this.finalRunCovering(principal.companyId, input.month);
    if (finalRun) throw conflict(`The ${input.month} month is inside a finalized salary run (${finalRun.periodStart} – ${finalRun.periodEnd}). Reopen it first.`);
    if (input.kind === 'lane_bonus') {
      const dup = await this.db
        .select({ id: dispatchSalaryAdjustments.id })
        .from(dispatchSalaryAdjustments)
        .where(
          and(
            eq(dispatchSalaryAdjustments.companyId, principal.companyId),
            eq(dispatchSalaryAdjustments.dispatcherId, input.dispatcherId),
            eq(dispatchSalaryAdjustments.month, input.month),
            eq(dispatchSalaryAdjustments.kind, 'lane_bonus'),
            isNull(dispatchSalaryAdjustments.voidedAt),
          ),
        )
        .limit(1);
      if (dup.length > 0) throw conflict('A dedicated lane bonus is already recorded for that team and month');
    }
    const row = {
      id: newId('dsa'),
      companyId: principal.companyId,
      dispatcherId: input.dispatcherId,
      employeeName: input.employeeName,
      month: input.month,
      kind: input.kind,
      amountCents: input.amountCents,
      reason: input.reason,
      approvedByName: input.approvedByName,
      by: principal.userId,
      byName: principal.userName ?? principal.userId,
      at: now,
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(dispatchSalaryAdjustments).values(row);
      await audit(tx, principal, now, 'salary_adjustment', row.id, 'create', null, row);
    });
    return this.toAdjustment({ ...row, voidedAt: null, voidReason: null } as AdjustmentRecord);
  }

  async voidAdjustment(principal: Principal, id: string, reason: string): Promise<SalaryAdjustment> {
    this.payEditOrThrow(principal);
    this.manageOrThrow(principal);
    if (reason.trim().length < 3) throw unprocessable('Voiding needs a reason');
    const now = this.clock();
    const [existing] = await this.db
      .select()
      .from(dispatchSalaryAdjustments)
      .where(and(eq(dispatchSalaryAdjustments.companyId, principal.companyId), eq(dispatchSalaryAdjustments.id, id)))
      .limit(1);
    if (!existing) throw notFound('No such adjustment');
    if (existing.voidedAt) throw unprocessable('Already voided');
    const finalRun = await this.finalRunCovering(principal.companyId, existing.month);
    if (finalRun) throw conflict('That month is inside a finalized salary run. Reopen it first.');
    await this.db.transaction(async (tx) => {
      await tx.update(dispatchSalaryAdjustments).set({ voidedAt: now, voidReason: reason }).where(eq(dispatchSalaryAdjustments.id, id));
      await audit(tx, principal, now, 'salary_adjustment', id, 'void', existing, { reason });
    });
    return this.toAdjustment({ ...existing, voidedAt: now, voidReason: reason });
  }

  private async finalRunCovering(companyId: string, month: string): Promise<RunRecord | null> {
    const rows = await this.db
      .select()
      .from(dispatchSalaryRuns)
      .where(and(eq(dispatchSalaryRuns.companyId, companyId), eq(dispatchSalaryRuns.status, 'final')));
    return rows.find((r) => monthsInside(String(r.periodStart), String(r.periodEnd)).includes(month) || (r.periodKind === 'month' && String(r.periodStart).startsWith(month))) ?? null;
  }

  // ------------------------------------------------------------------------------ allocations

  /** Every split row in force on or before `date`, newest first; `allocationsAt` picks per day. */
  private async allocationHistory(companyId: string, date: string): Promise<AllocationRow[]> {
    const rows = await this.db
      .select()
      .from(dispatchAllocations)
      .where(and(eq(dispatchAllocations.companyId, companyId), lte(dispatchAllocations.effectiveFrom, date)))
      .orderBy(desc(dispatchAllocations.effectiveFrom), desc(dispatchAllocations.at));
    return rows.map((r) => ({ dispatcherId: r.dispatcherId, effectiveFrom: String(r.effectiveFrom), shares: JSON.parse(r.shares) as AllocationShare[] }));
  }

  async writeAllocation(principal: Principal, input: WriteAllocationInput): Promise<{ ok: true }> {
    this.payEditOrThrow(principal);
    this.manageOrThrow(principal);
    const total = input.shares.reduce((s, x) => s + x.sharePct, 0);
    if (Math.abs(total - 100) > 0.005) throw unprocessable(`Shares total ${total.toFixed(2)} %; they must total 100 %`);
    const now = this.clock();
    const row = {
      id: newId('dal'),
      companyId: principal.companyId,
      dispatcherId: input.dispatcherId,
      effectiveFrom: input.effectiveFrom,
      shares: JSON.stringify(input.shares),
      by: principal.userId,
      byName: principal.userName ?? principal.userId,
      at: now,
    };
    await this.db.transaction(async (tx) => {
      await tx.insert(dispatchAllocations).values(row);
      await audit(tx, principal, now, 'allocation', row.id, 'create', null, row);
    });
    return { ok: true };
  }

  /**
   * The dispatchers behind a team (owner, 2026-10-28): the newest split that names two or more
   * people, else the team's name read as "A / B". Each gets a key Separate dispatchers quotes back.
   */
  async teamMembers(principal: Principal, dispatcherId: string): Promise<DispatchTeamMembers> {
    this.manageOrThrow(principal);
    const today = companyToday(principal, this.clock());
    const rows = (
      await this.db
        .select()
        .from(dispatchAllocations)
        .where(and(eq(dispatchAllocations.companyId, principal.companyId), eq(dispatchAllocations.dispatcherId, dispatcherId)))
        .orderBy(desc(dispatchAllocations.effectiveFrom), desc(dispatchAllocations.at))
    ).map((r) => ({ dispatcherId: r.dispatcherId, effectiveFrom: String(r.effectiveFrom), shares: JSON.parse(r.shares) as AllocationShare[] }));
    const pair = rows.find((r) => r.shares.length >= 2);
    let members: AllocationShare[] = pair?.shares ?? [];
    if (members.length < 2) {
      const [named] = await this.db
        .select({ name: dispatchRoster.dispatcherName })
        .from(dispatchRoster)
        .where(and(eq(dispatchRoster.companyId, principal.companyId), eq(dispatchRoster.dispatcherId, dispatcherId)))
        .limit(1);
      const parts = (named?.name ?? '').split('/').map((x) => x.trim()).filter(Boolean);
      members = parts.map((name) => ({ employeeId: null, name, sharePct: Math.round((100 / Math.max(parts.length, 1)) * 100) / 100 }));
    }
    const inForce = allocationsAt(rows, today).get(dispatcherId)?.shares ?? members;
    return {
      dispatcherId,
      members: members.map((m) => ({ key: personKey(m), name: m.name, employeeId: m.employeeId, sharePct: m.sharePct })),
      inForce: inForce.map((m) => ({ name: m.name, sharePct: m.sharePct })),
    };
  }

  /**
   * Separate dispatchers (owner, 2026-10-28). Team commission is 50/50; from the Monday of
   * `fromWeek` the one who stays is paid 100 % and the one who left nothing, and from `returnsOn`
   * it is shared equally again. Written as dated split versions - the pay maths already splits each
   * week by the version in force that week - and audited with the reason.
   */
  async separateDispatchers(principal: Principal, dispatcherId: string, input: SeparateDispatchersInput): Promise<DispatchTeamMembers> {
    this.payEditOrThrow(principal);
    this.manageOrThrow(principal);
    const today = companyToday(principal, this.clock());
    const from = weekStartMonday(input.fromWeek);
    if (from > weekStartMonday(today)) throw unprocessable('A team splits from this week or an earlier one');
    const returnsOn = input.returnsOn ?? null;
    if (returnsOn && returnsOn <= from) throw unprocessable('The return day has to come after the split');
    const team = await this.teamMembers(principal, dispatcherId);
    if (team.members.length < 2) throw unprocessable('This team has one dispatcher: there is nobody to separate');
    const stays = team.members.find((m) => m.key === input.staysKey);
    if (!stays) throw unprocessable('Choose the dispatcher who stays on the board');
    const now = this.clock();
    const equal = team.members.map((m, i) => {
      const base = Math.floor((10_000 / team.members.length)) / 100;
      const rest = Math.round((100 - base * team.members.length) * 100) / 100;
      return { employeeId: m.employeeId, name: m.name, sharePct: i === team.members.length - 1 ? Math.round((base + rest) * 100) / 100 : base };
    });
    const rows = [
      { effectiveFrom: from, shares: [{ employeeId: stays.employeeId, name: stays.name, sharePct: 100 }] },
      ...(returnsOn ? [{ effectiveFrom: returnsOn, shares: equal }] : []),
    ];
    await this.db.transaction(async (tx) => {
      for (const r of rows) {
        const row = {
          id: newId('dal'),
          companyId: principal.companyId,
          dispatcherId,
          effectiveFrom: r.effectiveFrom,
          shares: JSON.stringify(r.shares),
          by: principal.userId,
          byName: principal.userName ?? principal.userId,
          at: now,
        };
        await tx.insert(dispatchAllocations).values(row);
      }
      await audit(tx, principal, now, 'allocation', dispatcherId, 'separate-dispatchers', { members: team.members.map((m) => `${m.name} ${m.sharePct}%`) }, {
        stays: stays.name,
        leaves: team.members.filter((m) => m.key !== stays.key).map((m) => m.name),
        aloneFrom: from,
        returnsOn,
        reason: input.reason.trim(),
      });
    });
    return this.teamMembers(principal, dispatcherId);
  }

  async allocations(principal: Principal) {
    this.payViewOrThrow(principal);
    const rows = await this.db
      .select()
      .from(dispatchAllocations)
      .where(eq(dispatchAllocations.companyId, principal.companyId))
      .orderBy(desc(dispatchAllocations.effectiveFrom), desc(dispatchAllocations.at));
    return rows.map((r) => ({
      id: r.id,
      dispatcherId: r.dispatcherId,
      effectiveFrom: String(r.effectiveFrom),
      shares: JSON.parse(r.shares) as { employeeId: string | null; name: string; sharePct: number }[],
      byName: r.byName,
      at: r.at.toISOString(),
    }));
  }

  // ------------------------------------------------------------------------------ exports

  /**
   * The workbook the company kept by hand: one tab per week ("WEEK 3 (09.21-09.27)") with a
   * grey band per team - Gross, Miles, RPM, %, Payment and the written proof - a TOTAL line under
   * each, then "SUMMARY (salaries)" on a green tab with team totals, shares and adjustments.
   */
  private sheets(report: SalaryReport) {
    const $ = (c: number) => Math.round(c) / 100;
    const mmdd = (d: string) => `${d.slice(5, 7)}.${d.slice(8, 10)}`;
    const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const long = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${Number(d.slice(8, 10))}`;
    const TABS = ['1F4E9E', '2E8B57', 'C9A400', 'E53935'];
    const c = (v: string | number | null, s: number) => ({ v, s });

    const weekSheets = report.weeks.map((w, wi) => {
      const end = addDays(w, 6);
      const rows: XlsxCell[][] = [[c(`Week: ${long(w)} – ${long(end)}, ${w.slice(0, 4)}`, XS.title)], []];
      let weekGross = 0;
      let weekPay = 0;
      for (const t of report.teams) {
        const trucks = t.trucks.filter((x) => x.weekStart === w).sort((a, b) => b.grossCents - a.grossCents);
        if (trucks.length === 0) continue;
        rows.push([c(t.dispatcherName, XS.teamHead), c('Gross', XS.teamHead), c('Miles', XS.teamHead), c('RPM', XS.teamHead), c('%', XS.teamHead), c('Payment', XS.teamHead), c('How it was calculated (proof)', XS.teamHead)]);
        let gross = 0;
        let miles = 0;
        let pay = 0;
        for (const x of trucks) {
          gross += x.grossCents;
          miles += x.miles;
          pay += x.payableCents;
          const manual = x.overrideCents === null ? '' : ` | manual ${x.overrideMode === 'amount' ? '=' : '+'} ${cents(x.overrideCents)}: ${x.overrideReason ?? ''}`;
          rows.push([
            c(x.driverName, XS.name),
            c($(x.grossCents), XS.money),
            c(x.miles, XS.int),
            c(x.rpm === null ? null : Math.round(x.rpm * 100) / 100, XS.rpm),
            c((x.basePct + x.bonusPct) / 100, XS.pct),
            c($(x.payableCents), XS.money),
            c(`${x.unit.toUpperCase()} · ${x.formula}${manual}`, XS.proof),
          ]);
        }
        weekGross += gross;
        weekPay += pay;
        rows.push([c('TOTAL', XS.totalLabel), c($(gross), XS.totalMoney), c(miles, XS.totalInt), c(miles > 0 ? Math.round((gross / 100 / miles) * 100) / 100 : null, XS.totalRpm), c(null, XS.totalLabel), c($(pay), XS.totalMoney), c(null, XS.totalLabel)]);
        rows.push([]);
      }
      rows.push([c('WEEK TOTAL', XS.totalLabel), c($(weekGross), XS.totalMoney), c(null, XS.totalLabel), c(null, XS.totalLabel), c(null, XS.totalLabel), c($(weekPay), XS.totalMoney), c(null, XS.totalLabel)]);
      return { name: `WEEK ${payBlockOf(w).week} (${mmdd(w)}-${mmdd(end)})`, rows, widths: [40, 14, 10, 10, 9, 13, 110], tab: TABS[wi % TABS.length] };
    });

    const summary: XlsxCell[][] = [
      [c(`Salary report · ${report.label}`, XS.title)],
      [c('Period', XS.bold), report.start, report.end],
      [c('Policy versions', XS.bold), report.policyVersions.join(', ')],
      [c('Run', XS.bold), report.run ? `${report.run.status} · v${report.run.version}` : 'no run'],
      [],
      [c('Team', XS.greenHead), c('Gross', XS.greenHead), c('Miles', XS.greenHead), c('RPM', XS.greenHead), c('Commission', XS.greenHead), c('Bonuses', XS.greenHead), c('Penalties', XS.greenHead), c('Payable', XS.greenHead), c('Needs miles', XS.greenHead), c('Employee', XS.greenHead), c('Share %', XS.greenHead), c('Employee payable', XS.greenHead)],
    ];
    for (const t of report.teams) {
      const base: XlsxCell[] = [c(t.dispatcherName, XS.name), c($(t.grossCents), XS.money), c(t.miles, XS.int), c(t.rpm, XS.rpm), c($(t.commissionCents), XS.money), c($(t.bonusesCents), XS.money), c($(t.penaltiesCents), XS.money), c($(t.payableCents), XS.moneyBold), c(t.needsMiles, XS.int)];
      if (t.allocation && t.allocation.length > 0) {
        t.allocation.forEach((a, i) => summary.push(i === 0 ? [...base, c(a.name, XS.name), c(a.sharePct / 100, XS.pct), c($(a.payableCents), XS.money)] : [null, null, null, null, null, null, null, null, null, c(a.name, XS.name), c(a.sharePct / 100, XS.pct), c($(a.payableCents), XS.money)]));
      } else summary.push([...base, c('Allocation required', XS.name), c(null, XS.pct), c(null, XS.money)]);
    }
    summary.push([c('TOTAL', XS.totalLabel), c($(report.totals.grossCents), XS.totalMoney), c(null, XS.totalLabel), c(null, XS.totalLabel), c($(report.totals.commissionCents), XS.totalMoney), c($(report.totals.bonusesCents), XS.totalMoney), c($(report.totals.penaltiesCents), XS.totalMoney), c($(report.totals.payableCents), XS.totalMoney), c(null, XS.totalLabel), c(null, XS.totalLabel), c(null, XS.totalLabel), c(null, XS.totalLabel)]);
    summary.push([]);
    summary.push([c('Approved bonuses and penalties', XS.greenBand)]);
    summary.push([c('Team', XS.greenHead), c('Employee', XS.greenHead), c('Month', XS.greenHead), c('Kind', XS.greenHead), c('Amount', XS.greenHead), c('Reason', XS.greenHead), c('Approved by', XS.greenHead), c('Recorded by', XS.greenHead), c('Recorded at', XS.greenHead)]);
    for (const t of report.teams) for (const a of t.adjustments) summary.push([c(t.dispatcherName, XS.name), c(a.employeeName, XS.name), a.month, a.kind, c($(a.amountCents), XS.money), c(a.reason, XS.name), a.approvedByName, a.byName, a.at.slice(0, 16).replace('T', ' ')]);

    return [...weekSheets, { name: 'SUMMARY (salaries)', rows: summary, widths: [28, 14, 10, 10, 14, 12, 12, 14, 12, 22, 10, 16], tab: '2E8B57' }];
  }

  async exportXlsx(principal: Principal, kind: PeriodKind, date: string): Promise<{ file: Buffer; name: string }> {
    const report = await this.report(principal, kind, date);
    return { file: buildXlsx(this.sheets(report)), name: `salary-${kind}-${report.start}.xlsx` };
  }

  async exportCsv(principal: Principal, kind: PeriodKind, date: string): Promise<{ file: string; name: string }> {
    const report = await this.report(principal, kind, date);
    const sheets = this.sheets(report);
    const lines = sheets.flatMap((s) => [[`# ${s.name}`], ...s.rows, []]);
    return { file: toCsv(lines), name: `salary-${kind}-${report.start}.csv` };
  }
}

function monthsInside(start: string, end: string): string[] {
  const out: string[] = [];
  let m = monthOf(start);
  while (m <= monthOf(end)) {
    out.push(m);
    const [y, mm] = m.split('-').map(Number) as [number, number];
    m = new Date(Date.UTC(y, mm, 1)).toISOString().slice(0, 7);
  }
  return out;
}
