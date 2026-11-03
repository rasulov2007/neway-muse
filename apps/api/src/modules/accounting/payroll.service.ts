import { Injectable } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import {
  AccountingSettingsSchema,
  StaffPayPlanSchema,
  computePayrollLines,
  fourWeekPeriodFor,
  payBlockOf,
  postPayrollFinalized,
  postPayrollPaid,
  type DispatcherCommissionBreakdown,
  type PayrollLineResult,
  type StaffPayPlanInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { hasPermission } from '../../common/auth/principal';
import { employees } from '../../database/schema';
import { SalaryService } from '../dispatch-board/salary.service';
import { AuditService } from '../people/audit.service';
import { forbidden, newId, unprocessable } from '../dispatch-board/ops.helpers';
import { LedgerService } from './ledger.service';
import { AccountingStore } from './store.service';

/**
 * Staff payroll (§11): staff, not drivers. Dispatchers on four-week commission periods, other
 * departments on a fixed salary. No tax or statutory deduction is computed.
 *
 * A dispatcher's commission is **the DISP-KPI-01 commission**, taken from the same engine and the
 * same versioned policy the Weekly Board and the Salary Report use. It is not recomputed here and
 * there is no second formula: payroll asks the Salary Report what the period earned and records
 * it. The KPI is a truck-week figure - a gross tier, an RPM rule and an RPM bonus per truck per
 * week - so a four-week period is the sum of its truck-weeks, never one tier applied to four
 * weeks of combined gross, and never a flat percentage of each load.
 *
 * A finalized period never changes underneath anybody. When a load moves after payroll was
 * finalized, `recheck` reports the difference and `carryAdjustment` moves it into the next open
 * period as an adjustment naming the period it came from.
 */

export interface StaffPlanRecord extends StaffPayPlanInput {
  id: string;
  employeeId: string;
  byName: string;
  at: string;
}

export interface PayrollPeriodRecord {
  id: string;
  periodNumber: string;
  kind: 'dispatcher' | 'salary';
  periodStart: string;
  periodEnd: string;
  payDate: string;
  status: 'draft' | 'review' | 'finalized' | 'paid' | 'closed';
  lines: PayrollLineResult[];
  grossCents: number;
  netCents: number;
  blocked: number;
  finalizedAt: string | null;
  finalizedBy: string | null;
  paidAt: string | null;
  paymentId: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class PayrollService {
  constructor(
    private readonly store: AccountingStore,
    private readonly ledger: LedgerService,
    private readonly audit: AuditService,
    private readonly salary: SalaryService,
  ) {}

  clock: () => Date = () => new Date();

  private requireEdit(principal: Principal): void {
    if (!hasPermission(principal, 'accounting.edit')) throw forbidden('Only Accounting can change payroll.');
  }

  async staff(principal: Principal) {
    const rows = await this.store.db.select({ id: employees.id, first: employees.firstName, last: employees.lastName, position: employees.position, department: employees.department, status: employees.status }).from(employees).where(eq(employees.companyId, principal.companyId));
    const plans = (await this.store.list<StaffPlanRecord>('acct_staff_pay_plans', principal.companyId)).map((p) => p.record);
    return rows
      .filter((e) => !/driver/i.test(e.position) && !/driver/i.test(e.department))
      .map((e) => ({ id: e.id, name: `${e.first} ${e.last}`.trim(), position: e.position, department: e.department, status: e.status, plans: plans.filter((p) => p.employeeId === e.id).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom)) }));
  }

  /**
   * Writes a new version of a staff member's pay plan.
   *
   * Plans are never edited in place: each save is a new row with its own effective date, so what
   * a finalized period was computed under stays readable afterwards. `confirmRate` is what turns
   * recorded terms into terms that pay, and it records who did it; every save needs a reason.
   */
  async savePlan(principal: Principal, employeeId: string, raw: unknown, options?: { confirmRate?: boolean; reason?: string }): Promise<StaffPlanRecord> {
    this.requireEdit(principal);
    const input = StaffPayPlanSchema.parse(raw);
    const reason = (options?.reason ?? input.reason ?? '').trim();
    if (!reason) throw unprocessable('Say why this pay plan is being set; it is kept with the version.');
    const now = this.clock().toISOString();
    const by = principal.userName ?? principal.userId;
    const confirmed = options?.confirmRate === true;
    const rec: StaffPlanRecord = {
      ...input,
      reason,
      rateConfirmedAt: confirmed ? now : input.rateConfirmedAt,
      rateConfirmedBy: confirmed ? by : input.rateConfirmedBy,
      id: newId('spp'),
      employeeId,
      byName: by,
      at: now,
    };
    await this.store.insert('acct_staff_pay_plans', principal.companyId, rec);
    await this.audit.write(principal, { action: 'staff_pay_plan', entityType: 'employee', entityId: employeeId, entityLabel: employeeId, summary: `${input.kind} plan from ${input.effectiveFrom}${input.salaryCents !== null ? ` · $${(input.salaryCents / 100).toFixed(2)} ${input.frequency}` : ''}${confirmed ? ' · terms confirmed' : ''} · ${reason}`, changes: [] });
    return rec;
  }

  /**
   * What each dispatcher earned in this period, from the commission KPI.
   *
   * The Salary Report is asked for the range and its answer is recorded. It prices every truck-week
   * through `dispatcherCommission` under the policy version in force for that week, applies any
   * admin override, and adds the approved monthly bonuses and penalties - so Commission, Salary
   * Report and Payroll cannot disagree, because there is only one calculation.
   *
   * Attribution: a board team is either one person (`dispatcher_id` is an employee id) or several
   * behind one name, in which case the configured allocation splits it. A team with no allocation,
   * or shares that do not total 100 %, is NOT paid to anybody - it is reported as a blocker,
   * because paying each dispatcher the whole commission would be worse than paying nobody yet.
   */
  private async commissionForPeriod(principal: Principal, start: string, end: string) {
    const report = await this.salary.earningsForRange(principal.companyId, { start, end, label: `${start} – ${end}` });
    const byEmployee = new Map<string, DispatcherCommissionBreakdown>();
    const unattributed: Array<{ dispatcherName: string; payableCents: number; reason: string }> = [];

    const breakdown = (employeeId: string, team: (typeof report.teams)[number], payableCents: number, share: number | null): DispatcherCommissionBreakdown => ({
      employeeId,
      dispatcherId: team.dispatcherId,
      dispatcherName: team.dispatcherName,
      periodStart: start,
      periodEnd: end,
      payableCents,
      commissionCents: team.commissionCents,
      bonusesCents: team.bonusesCents,
      penaltiesCents: team.penaltiesCents,
      sharePct: share,
      policyVersions: report.policyVersions,
      needsMiles: team.needsMiles,
      weeks: team.weeks.map((w) => ({ weekStart: w.weekStart, grossCents: w.grossCents, commissionCents: w.commissionCents, trucks: w.trucks })),
      trucks: team.trucks.map((t) => ({
        weekStart: t.weekStart,
        truckUnit: t.truckUnit,
        driverName: t.driverName,
        unit: t.unit,
        grossCents: t.grossCents,
        miles: t.miles,
        rpm: t.rpm,
        basePct: t.basePct,
        bonusPct: t.bonusPct,
        status: t.status,
        tier: t.tier,
        calculatedCents: t.calculatedCents,
        payableCents: t.payableCents,
        overrideCents: t.overrideCents,
        overrideReason: t.overrideReason,
        formula: t.formula,
        policyVersion: t.policyVersion,
      })),
      adjustments: team.adjustments.map((a) => ({ kind: a.kind, amountCents: a.amountCents, month: a.month, reason: a.reason })),
      exceptions: [],
    });

    for (const team of report.teams) {
      if (!team.dispatcherId) {
        if (team.payableCents !== 0) unattributed.push({ dispatcherName: team.dispatcherName, payableCents: team.payableCents, reason: 'The truck-weeks behind this commission name no dispatcher on the roster.' });
        continue;
      }
      if (team.allocation && team.allocation.length > 0) {
        for (const share of team.allocation) {
          if (!share.employeeId) {
            unattributed.push({ dispatcherName: `${team.dispatcherName} · ${share.name}`, payableCents: share.payableCents, reason: 'This share of the team names no staff record, so it cannot be paid.' });
            continue;
          }
          byEmployee.set(share.employeeId, breakdown(share.employeeId, team, share.payableCents, share.sharePct));
        }
        continue;
      }
      // One name that is not a single employee and has no split configured.
      if (!team.dispatcherId.startsWith('emp_')) {
        unattributed.push({
          dispatcherName: team.dispatcherName,
          payableCents: team.payableCents,
          reason: `"${team.dispatcherName}" is shared and has no allocation, or its shares do not total 100 %. Set the split in Dispatch › Salary report before this period can be finalized.`,
        });
        continue;
      }
      byEmployee.set(team.dispatcherId, breakdown(team.dispatcherId, team, team.payableCents, null));
    }

    // The KPI is a weekly figure, so the payroll period has to be whole weeks on the same grid.
    const gridNote = this.periodGridNote(start, end);
    for (const value of byEmployee.values()) {
      if (value.needsMiles > 0) value.exceptions.push(`${value.needsMiles} truck-week(s) have gross above the floor but no miles, so they are not priced yet. Enter the miles on the weekly board.`);
      for (const u of unattributed) value.exceptions.push(`Not attributed: ${u.dispatcherName} (${(u.payableCents / 100).toFixed(2)}) — ${u.reason}`);
      if (gridNote) value.exceptions.push(gridNote);
    }
    return {
      byEmployee,
      unattributed,
      empty: (employeeId: string): DispatcherCommissionBreakdown => ({
        employeeId,
        dispatcherId: null,
        dispatcherName: '',
        periodStart: start,
        periodEnd: end,
        payableCents: 0,
        commissionCents: 0,
        bonusesCents: 0,
        penaltiesCents: 0,
        sharePct: null,
        policyVersions: report.policyVersions,
        needsMiles: 0,
        weeks: [],
        trucks: [],
        adjustments: [],
        exceptions: ['No truck-week on the dispatch board is credited to this person for this period.'],
      }),
    };
  }

  /**
   * Whether the accounting payroll period sits on the same four-week grid the dispatch board uses.
   *
   * Accounting counts its four weeks from `dispatcherPeriodAnchor`; the board counts from its own
   * epoch. When the two disagree the commission weeks and the payroll period are not the same four
   * weeks, and nobody should discover that from a total. This says so rather than choosing one.
   */
  private periodGridNote(start: string, end: string): string | null {
    const block = payBlockOf(start);
    if (block.start === start && block.end === end) return null;
    return `This payroll period (${start} – ${end}) is not the four-week block the dispatch board uses (${block.start} – ${block.end}). The commission weeks and the payroll period do not line up; an administrator should align the anchor in Settings › Accounting.`;
  }

  private planOn(plans: StaffPlanRecord[], employeeId: string, date: string): StaffPlanRecord | null {
    return plans.filter((p) => p.employeeId === employeeId && p.effectiveFrom <= date && (!p.effectiveTo || p.effectiveTo >= date)).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0] ?? null;
  }

  async periods(principal: Principal): Promise<PayrollPeriodRecord[]> {
    return (await this.store.list<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, undefined, 'period_start desc')).map((r) => r.record);
  }

  /** Generates or refreshes a period: dispatchers on the four-week grid, salaried staff on their own. */
  async generate(principal: Principal, input: { kind: 'dispatcher' | 'salary'; date: string; anchorMonday?: string; periodStart?: string; periodEnd?: string; payDate?: string }): Promise<PayrollPeriodRecord> {
    this.requireEdit(principal);
    const settings = AccountingSettingsSchema.parse((await this.store.settings(principal.companyId)).record);
    let start: string;
    let end: string;
    if (input.kind === 'dispatcher') {
      const anchor = input.anchorMonday ?? ((await this.store.settings(principal.companyId)).record['dispatcherPeriodAnchor'] as string | undefined);
      if (!anchor) throw unprocessable('The four-week period anchor (a Monday) is not configured (Settings › Accounting).');
      const p = fourWeekPeriodFor(input.date, anchor);
      start = p.start;
      end = p.end;
    } else {
      if (!input.periodStart || !input.periodEnd) throw unprocessable('A salary period needs its start and end.');
      start = input.periodStart;
      end = input.periodEnd;
    }
    const payDate = input.payDate ?? new Date(Date.parse(`${end}T00:00:00Z`) + 4 * 86_400_000).toISOString().slice(0, 10);
    // The id carries the company: every acct_* id is a global key, and two companies run the same weeks.
    const id = `pr_${principal.companyId}_${input.kind}_${start}`;
    const existing = await this.store.find<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, id);
    if (existing && existing.record.status !== 'draft' && existing.record.status !== 'review') throw unprocessable(`${existing.record.periodNumber} is ${existing.record.status}.`);
    const staff = await this.staff(principal);
    const plans = (await this.store.list<StaffPlanRecord>('acct_staff_pay_plans', principal.companyId)).map((p) => p.record);
    const people = staff.filter((s) => s.status === 'active' && (input.kind === 'dispatcher' ? /dispatch/i.test(s.position) || /dispatch/i.test(s.department) : !(/dispatch/i.test(s.position) || /dispatch/i.test(s.department))));
    const previous = existing?.record.lines ?? [];
    // Dispatcher periods are priced by the commission KPI, per truck per week, from the policy
    // version in force for each week. Salary periods have no commission at all.
    const kpi = input.kind === 'dispatcher' ? await this.commissionForPeriod(principal, start, end) : null;
    const computed = computePayrollLines(
      people.map((p) => {
        const plan = this.planOn(plans, p.id, end);
        const prev = previous.find((l) => l.employeeId === p.id);
        let commissionCents = prev?.commissionCents ?? null;
        let commissionSource = prev?.commissionSource ?? null;
        let commissionDetail: DispatcherCommissionBreakdown | null = prev?.commissionDetail ?? null;
        if (kpi) {
          const earned = kpi.byEmployee.get(p.id) ?? null;
          commissionDetail = earned ?? kpi.empty(p.id);
          // A figure somebody entered on purpose, with a reason, is not overwritten by a
          // recomputation; the computed figure stays beside it so the difference is visible.
          if (commissionSource !== 'manual') {
            commissionCents = earned ? earned.payableCents : null;
            commissionSource = earned ? 'computed' : null;
          }
        }
        return { employeeId: p.id, employeeName: p.name, role: p.position, plan: plan ? { ...plan } : null, commissionCents, commissionSource, commissionDetail, commissionReason: prev?.commissionReason ?? null, bonusCents: prev?.bonusCents ?? 0, advanceCents: prev?.advanceCents ?? 0, adjustments: prev?.adjustments ?? [] };
      }),
    );
    const now = this.clock().toISOString();
    const rec: PayrollPeriodRecord = {
      id,
      periodNumber: `${input.kind === 'dispatcher' ? 'DP' : 'SP'}-${start.replace(/-/g, '')}`,
      kind: input.kind,
      periodStart: start,
      periodEnd: end,
      payDate,
      status: computed.blocked > 0 ? 'review' : 'draft',
      lines: computed.lines,
      grossCents: computed.grossCents,
      netCents: computed.netCents,
      blocked: computed.blocked,
      finalizedAt: null,
      finalizedBy: null,
      paidAt: null,
      paymentId: null,
      closedAt: null,
      createdAt: existing?.record.createdAt ?? now,
      updatedAt: now,
    };
    void settings;
    if (existing) await this.store.update('acct_payroll_periods', principal.companyId, id, existing.version, rec);
    else await this.store.insert('acct_payroll_periods', principal.companyId, rec);
    return rec;
  }

  /** An approved figure on a line: a commission amount, bonus, advance or adjustment, with its reason. */
  async setLine(principal: Principal, periodId: string, employeeId: string, input: { commissionCents?: number | null; bonusCents?: number; advanceCents?: number; reason?: string; adjustment?: { description: string; cents: number; reason: string } }) {
    this.requireEdit(principal);
    const stored = await this.store.get<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, periodId);
    const p = stored.record;
    if (p.status !== 'draft' && p.status !== 'review') throw unprocessable(`${p.periodNumber} is ${p.status}.`);
    // Overriding a computed commission is allowed, but never silently: the reason is kept on the
    // line and the computed figure stays beside it.
    const overriding = input.commissionCents !== undefined;
    if (overriding && !(input.reason ?? '').trim()) throw unprocessable('Say why this commission is being set by hand rather than computed.');
    const lines = p.lines.map((l) => (l.employeeId === employeeId ? { ...l, commissionCents: input.commissionCents === undefined ? l.commissionCents : input.commissionCents, commissionSource: overriding ? ('manual' as const) : l.commissionSource, commissionReason: overriding ? `${input.reason!.trim()} (${principal.userName ?? principal.userId})` : l.commissionReason, bonusCents: input.bonusCents ?? l.bonusCents, advanceCents: input.advanceCents ?? l.advanceCents, adjustments: input.adjustment ? [...l.adjustments, { ...input.adjustment, approvedBy: principal.userName ?? principal.userId }] : l.adjustments } : l));
    const computed = computePayrollLines(lines);
    const after: PayrollPeriodRecord = { ...p, lines: computed.lines, grossCents: computed.grossCents, netCents: computed.netCents, blocked: computed.blocked, status: computed.blocked > 0 ? 'review' : 'draft', updatedAt: this.clock().toISOString() };
    await this.store.update('acct_payroll_periods', principal.companyId, periodId, stored.version, after);
    await this.audit.write(principal, { action: 'payroll_line', entityType: 'payroll_period', entityId: periodId, entityLabel: p.periodNumber, summary: `${employeeId}: ${JSON.stringify(input)}`, changes: [] });
    return after;
  }

  /** Staff in a period who have no pay plan: they would be left out of the finalized total, so the person approving has to see and acknowledge each one. */
  excluded(p: PayrollPeriodRecord): Array<{ employeeId: string; employeeName: string; reason: string }> {
    return p.lines.filter((l) => l.exceptions.length > 0 && l.plan === null).map((l) => ({ employeeId: l.employeeId, employeeName: l.employeeName, reason: l.exceptions[0] ?? 'No pay plan' }));
  }

  async setStatus(principal: Principal, periodId: string, status: 'review' | 'finalized' | 'paid' | 'closed', input?: { paidOn?: string; reference?: string; acknowledgeExcluded?: string[] }) {
    this.requireEdit(principal);
    const stored = await this.store.get<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, periodId);
    const p = structuredClone(stored.record);
    const now = this.clock().toISOString();
    const onDate = now.slice(0, 10);
    const label = `${p.periodStart} – ${p.periodEnd}`;
    if (status === 'review') {
      // Hands a calculated draft to whoever approves it; recalculating takes it back to draft.
      if (p.status !== 'draft') return { ok: false as const, blocked: `${p.periodNumber} is ${p.status}; only a draft goes to review.`, period: p };
      p.status = 'review';
    } else if (status === 'finalized') {
      // A staff member with no plan at all is excluded from this period, not a reason to hold
      // everyone else's approved pay. A line that has a plan but still lacks its figure blocks.
      const unresolved = p.lines.filter((l) => l.exceptions.length > 0 && l.plan !== null);
      if (p.status !== 'draft' && p.status !== 'review') return { ok: false as const, blocked: `${p.periodNumber} is ${p.status}.`, period: p };
      if (unresolved.length > 0) return { ok: false as const, blocked: `${unresolved.length} line(s) still need their figure: ${unresolved.map((l) => l.employeeName).join(', ')}.`, period: p };
      const excluded = this.excluded(p);
      const acknowledged = new Set(input?.acknowledgeExcluded ?? []);
      const unacknowledged = excluded.filter((e) => !acknowledged.has(e.employeeId));
      if (unacknowledged.length > 0) return { ok: false as const, blocked: `${unacknowledged.length} staff member(s) have no pay plan and would be left out of this period: ${unacknowledged.map((e) => e.employeeName).join(', ')}. Acknowledge each exclusion, or set their plan first.`, period: p, excluded };
      p.lines = p.lines.map((l) => (l.exceptions.length > 0 && l.plan === null ? { ...l, exceptions: [...l.exceptions, 'Excluded from this period: no pay plan'] } : l));
      const posted = await this.ledger.commit(principal, postPayrollFinalized({ periodId: p.id, periodLabel: label, onDate, gross: p.grossCents / 100, taxWithheld: 0, deductions: (p.grossCents - p.netCents) / 100, net: p.netCents / 100 }));
      if (!posted.ok) return { ok: false as const, blocked: posted.blocked, period: p };
      p.status = 'finalized';
      p.finalizedAt = now;
      p.finalizedBy = principal.userName ?? principal.userId;
    } else if (status === 'paid') {
      if (p.status !== 'finalized') return { ok: false as const, blocked: `${p.periodNumber} is ${p.status}; finalize it first.`, period: p };
      const posted = await this.ledger.commit(principal, postPayrollPaid({ periodId: p.id, periodLabel: label, onDate: input?.paidOn ?? onDate, net: p.netCents / 100 }));
      if (!posted.ok) return { ok: false as const, blocked: posted.blocked, period: p };
      const paymentId = newId('pay');
      await this.store.insert('acct_payments', principal.companyId, { id: paymentId, sourceKey: `payroll_payment:${p.id}`, direction: 'out', partyType: 'employee', partyId: p.id, partyName: `Payroll ${p.periodNumber}`, amount: p.netCents / 100, method: 'ach', receivedOn: input?.paidOn ?? onDate, reference: input?.reference ?? p.periodNumber, unappliedAmount: 0, applications: [], notes: null, createdAt: now, createdBy: principal.userName ?? principal.userId });
      p.status = 'paid';
      p.paidAt = now;
      p.paymentId = paymentId;
    } else {
      if (p.status !== 'paid') return { ok: false as const, blocked: `${p.periodNumber} is ${p.status}; only a paid period closes.`, period: p };
      p.status = 'closed';
      p.closedAt = now;
    }
    p.updatedAt = now;
    await this.store.update('acct_payroll_periods', principal.companyId, periodId, stored.version, p);
    await this.audit.write(principal, { action: `payroll_${status}`, entityType: 'payroll_period', entityId: periodId, entityLabel: p.periodNumber, summary: `${p.periodNumber} → ${status}`, changes: [{ field: 'status', old: stored.record.status, new: status }] });
    return { ok: true as const, period: p };
  }

  /**
   * What a period would compute to now, against what it was finalized at.
   *
   * Reads only. A finalized period is a statement of what was approved and, once paid, of money
   * that has left; recomputing it in place would rewrite history and quietly disagree with the
   * ledger entry and the payment already posted. When a load moves after the fact, this is what
   * shows the difference, and `carryAdjustment` is what does something about it.
   */
  async recheck(principal: Principal, periodId: string): Promise<{
    period: PayrollPeriodRecord;
    recomputable: boolean;
    drift: Array<{ employeeId: string; employeeName: string; finalizedCents: number; recomputedCents: number | null; differenceCents: number | null; truckWeeks: number; reasons: string[] }>;
  }> {
    const stored = await this.store.get<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, periodId);
    const p = stored.record;
    if (p.kind !== 'dispatcher') return { period: p, recomputable: false, drift: [] };

    const kpi = await this.commissionForPeriod(principal, p.periodStart, p.periodEnd);
    const drift = p.lines.map((line) => {
      const finalizedCents = line.commissionCents ?? 0;
      const now = kpi.byEmployee.get(line.employeeId) ?? null;
      if (!now) {
        return { employeeId: line.employeeId, employeeName: line.employeeName, finalizedCents, recomputedCents: null, differenceCents: null, truckWeeks: 0, reasons: ['No truck-week on the dispatch board is credited to this person for this period.'] };
      }
      return {
        employeeId: line.employeeId,
        employeeName: line.employeeName,
        finalizedCents,
        recomputedCents: now.payableCents,
        differenceCents: now.payableCents - finalizedCents,
        truckWeeks: now.trucks.length,
        reasons: now.exceptions,
      };
    });
    return { period: p, recomputable: true, drift };
  }

  /**
   * Moves a difference found by `recheck` into the next open period, as an adjustment.
   *
   * This is how payroll corrects itself without rewriting a finalized period: the money is paid
   * in the next period, the adjustment says which period and which employee it came from, and
   * both the reason and the person are kept. The source period is left exactly as approved.
   */
  async carryAdjustment(principal: Principal, periodId: string, input: { employeeId: string; cents: number; reason: string }): Promise<{ ok: true; into: PayrollPeriodRecord } | { ok: false; blocked: string }> {
    this.requireEdit(principal);
    const reason = input.reason?.trim();
    if (!reason) return { ok: false as const, blocked: 'Say why this adjustment is being carried forward.' };
    if (!Number.isInteger(input.cents) || input.cents === 0) return { ok: false as const, blocked: 'A carried adjustment needs a whole number of cents, and cannot be zero.' };

    const stored = await this.store.get<PayrollPeriodRecord>('acct_payroll_periods', principal.companyId, periodId);
    const from = stored.record;
    if (from.status !== 'finalized' && from.status !== 'paid' && from.status !== 'closed') {
      return { ok: false as const, blocked: `${from.periodNumber} is ${from.status}; change the line on the period itself rather than carrying it forward.` };
    }

    // The next period on the same grid: the one after the source period's end.
    const anchor = (await this.store.settings(principal.companyId)).record['dispatcherPeriodAnchor'] as string | undefined;
    if (from.kind === 'dispatcher' && !anchor) return { ok: false as const, blocked: 'The four-week period anchor is not configured (Settings › Accounting).' };
    const nextDay = new Date(Date.parse(`${from.periodEnd}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
    const next = await this.generate(principal, from.kind === 'dispatcher'
      ? { kind: 'dispatcher', date: nextDay }
      : { kind: 'salary', date: nextDay, periodStart: nextDay, periodEnd: new Date(Date.parse(`${nextDay}T00:00:00Z`) + 27 * 86_400_000).toISOString().slice(0, 10) });

    const line = next.lines.find((l) => l.employeeId === input.employeeId);
    if (!line) return { ok: false as const, blocked: `${input.employeeId} has no line in ${next.periodNumber}; they may no longer be on staff.` };

    const after = await this.setLine(principal, next.id, input.employeeId, {
      adjustment: {
        description: `Carried from ${from.periodNumber}`,
        cents: input.cents,
        reason: `${reason} (from ${from.periodNumber}, ${from.status})`,
      },
    });
    await this.audit.write(principal, {
      action: 'payroll_carry_adjustment',
      entityType: 'payroll_period',
      entityId: next.id,
      entityLabel: next.periodNumber,
      summary: `${input.employeeId}: $${(input.cents / 100).toFixed(2)} carried from ${from.periodNumber} — ${reason}`,
      changes: [],
    });
    return { ok: true as const, into: after };
  }

  /** Whether any driver on the roster is also counted as staff: never, by construction. */
  async driversInStaff(principal: Principal): Promise<number> {
    const rows = (await this.store.db.execute(sql`select count(*)::int as n from employees e join drivers d on d.employee_id = e.id where e.company_id = ${principal.companyId} and (e.position ilike '%dispatch%' or e.department ilike '%dispatch%') and d.status = 'active'`)) as unknown as Array<{ n: number }>;
    return Number(rows[0]?.n ?? 0);
  }
}
