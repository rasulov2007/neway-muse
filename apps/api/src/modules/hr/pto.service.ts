import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, gte, ilike, inArray, lte, ne, or, sql } from 'drizzle-orm';
import {
  computeBalance,
  detectPtoConflicts,
  ptoTransitions,
  type AdjustPtoBalanceRequest,
  type CreatePtoPolicyRequest,
  type CreatePtoRequestRequest,
  type DecidePtoRequestRequest,
  type PtoBalance,
  type PtoConflict,
  type PtoPolicyKind,
  type PtoPolicyRecord,
  type PtoQuery,
  type PtoRequestRecord,
  type PtoRequestStatus,
  type PtoSummary,
  type PtoTransactionKind,
  type PtoTransactionRecord,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  attendanceEntries,
  ptoPolicies,
  ptoRequests,
  ptoTransactions,
} from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';
import { hrReach, nextNumber, numOr, today, assertCompanyRefs, employeeRef } from './hr.util';

/**
 * PTO.
 *
 * A balance is never a column: it is the sum of the transaction ledger, computed on read. Approving
 * a request writes one `usage` row and the balance follows; cancelling an approved request writes a
 * compensating row rather than deleting the first, so the history stays readable.
 */
@Injectable()
export class PtoService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ---------------------------------------------------------------------------------- policies

  /** HR (pto.manage) reaches everybody; an approver reaches their direct reports (hr.util hrReach). */
  private reach(principal: Principal) {
    return hrReach(principal, 'pto.manage', ptoRequests.employeeId);
  }

  /** Refuses (404, as if absent) an employee outside the caller's reach. */
  private async assertReaches(principal: Principal, employeeId: string): Promise<void> {
    if (principal.permissions.has('pto.manage')) return;
    const [row] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, employeeId), hrReach(principal, 'pto.manage', employees.id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No employee ${employeeId} among your direct reports` });
  }

  async listPolicies(principal: Principal): Promise<PtoPolicyRecord[]> {
    const rows = await this.db
      .select()
      .from(ptoPolicies)
      .where(eq(ptoPolicies.companyId, principal.companyId))
      .orderBy(asc(ptoPolicies.name));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as PtoPolicyKind,
      accrualHoursPerPeriod: numOr(row.accrualHoursPerPeriod, 0),
      period: row.period as PtoPolicyRecord['period'],
      maxBalanceHours: row.maxBalanceHours === null ? null : numOr(row.maxBalanceHours, 0),
      carryoverHours: row.carryoverHours === null ? null : numOr(row.carryoverHours, 0),
      allowsNegativeBalance: row.allowsNegativeBalance,
      isActive: row.isActive,
    }));
  }

  async createPolicy(
    principal: Principal,
    input: CreatePtoPolicyRequest,
  ): Promise<PtoPolicyRecord[]> {
    const id = `pol_${crypto.randomUUID()}`;
    await this.db.insert(ptoPolicies).values({
      id,
      companyId: principal.companyId,
      name: input.name,
      kind: input.kind,
      accrualHoursPerPeriod: String(input.accrualHoursPerPeriod),
      period: input.period,
      maxBalanceHours: input.maxBalanceHours === null ? null : String(input.maxBalanceHours),
      carryoverHours: input.carryoverHours === null ? null : String(input.carryoverHours),
      allowsNegativeBalance: input.allowsNegativeBalance,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'pto_policy',
      entityId: id,
      entityLabel: input.name,
      summary: `PTO policy created: ${input.name}`,
    });
    return this.listPolicies(principal);
  }

  // ----------------------------------------------------------------------------------- balances

  async balances(principal: Principal, employeeId: string): Promise<PtoBalance[]> {
    const policies = await this.listPolicies(principal);
    const [transactions, pending] = await Promise.all([
      this.db
        .select({
          policyId: ptoTransactions.policyId,
          kind: ptoTransactions.kind,
          hours: ptoTransactions.hours,
        })
        .from(ptoTransactions)
        .where(
          and(
            eq(ptoTransactions.companyId, principal.companyId),
            eq(ptoTransactions.employeeId, employeeId),
            hrReach(principal, 'pto.manage', ptoTransactions.employeeId),
          ),
        ),
      this.db
        .select({ policyId: ptoRequests.policyId, hours: sql<string>`sum(${ptoRequests.hours})` })
        .from(ptoRequests)
        .where(
          and(
            eq(ptoRequests.companyId, principal.companyId),
            eq(ptoRequests.employeeId, employeeId),
            eq(ptoRequests.status, 'submitted'),
            this.reach(principal),
          ),
        )
        .groupBy(ptoRequests.policyId),
    ]);

    return policies
      .filter((p) => p.isActive)
      .map((policy) => {
        const rows = transactions
          .filter((t) => t.policyId === policy.id)
          .map((t) => ({ kind: t.kind as PtoTransactionKind, hours: numOr(t.hours, 0) }));
        const pendingHours = numOr(pending.find((p) => p.policyId === policy.id)?.hours ?? '0', 0);
        return {
          policyId: policy.id,
          policyName: policy.name,
          policyKind: policy.kind,
          ...computeBalance(rows, pendingHours),
        };
      });
  }

  /**
   * The caller's own balances (mobile M4, My work): the employee linked to this account
   * (memberships.employee_id, else employees.user_id), whatever their HR reach. Reach rules stop a
   * manager reading themself through `balances`; reading your own balance needs no HR seat.
   * An account with no employee gets an empty list.
   */
  async myBalances(principal: Principal): Promise<PtoBalance[]> {
    const [own] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          or(
            eq(employees.userId, principal.userId),
            sql`${employees.id} in (select m.employee_id from memberships m where m.user_id = ${principal.userId} and m.company_id = ${principal.companyId} and m.status = 'active' and m.employee_id is not null)`,
          ),
        ),
      )
      .limit(1);
    if (!own) return [];
    // Scoped to that one employee id, so company-wide reach here reads nobody else.
    const self: Principal = { ...principal, permissions: new Set([...principal.permissions, 'pto.manage']) };
    return this.balances(self, own.id);
  }

  async transactions(principal: Principal, employeeId: string): Promise<PtoTransactionRecord[]> {
    const rows = await this.db
      .select()
      .from(ptoTransactions)
      .where(
        and(
          eq(ptoTransactions.companyId, principal.companyId),
          eq(ptoTransactions.employeeId, employeeId),
          hrReach(principal, 'pto.manage', ptoTransactions.employeeId),
        ),
      )
      .orderBy(desc(ptoTransactions.effectiveOn), desc(ptoTransactions.createdAt));
    return rows.map((row) => ({
      id: row.id,
      kind: row.kind as PtoTransactionKind,
      hours: numOr(row.hours, 0),
      effectiveOn: row.effectiveOn,
      requestId: row.requestId,
      reason: row.reason,
      actorName: row.actorName,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async adjustBalance(principal: Principal, input: AdjustPtoBalanceRequest): Promise<PtoBalance[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), { table: ptoPolicies, idColumn: ptoPolicies.id, companyColumn: ptoPolicies.companyId, id: input.policyId, label: 'PTO type' }]);
    await this.db.insert(ptoTransactions).values({
      id: `ptt_${crypto.randomUUID()}`,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      policyId: input.policyId,
      kind: 'adjustment',
      hours: String(input.hours),
      effectiveOn: input.effectiveOn,
      reason: input.reason,
      actorName: principal.userName ?? principal.userId,
    });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'pto_balance',
      entityId: input.employeeId,
      entityLabel: input.employeeId,
      summary: `Balance adjusted by ${input.hours} hours`,
      reason: input.reason,
    });
    return this.balances(principal, input.employeeId);
  }

  // ----------------------------------------------------------------------------------- requests

  private select() {
    const approver = sql`approver`;
    return {
      request: ptoRequests,
      first: employees.firstName,
      last: employees.lastName,
      employeeNumber: employees.employeeNumber,
      department: employees.department,
      policyName: ptoPolicies.name,
      policyKind: ptoPolicies.kind,
      approverFirst: sql<string | null>`${approver}.first_name`,
      approverLast: sql<string | null>`${approver}.last_name`,
    };
  }

  private toRecord(row: {
    request: typeof ptoRequests.$inferSelect;
    first: string | null;
    last: string | null;
    employeeNumber: string | null;
    department: string | null;
    policyName: string | null;
    policyKind: string | null;
    approverFirst: string | null;
    approverLast: string | null;
  }): PtoRequestRecord {
    const r = row.request;
    return {
      id: r.id,
      requestNumber: r.requestNumber,
      employeeId: r.employeeId,
      employeeName: `${row.first ?? ''} ${row.last ?? ''}`.trim(),
      employeeNumber: row.employeeNumber ?? '',
      department: (row.department ?? 'dispatch') as PtoRequestRecord['department'],
      policyId: r.policyId,
      policyName: row.policyName ?? '',
      policyKind: (row.policyKind ?? 'other') as PtoPolicyKind,
      startsOn: r.startsOn,
      endsOn: r.endsOn,
      hours: numOr(r.hours, 0),
      status: r.status as PtoRequestStatus,
      reason: r.reason,
      notes: r.notes,
      approverEmployeeId: r.approverEmployeeId,
      approverName: row.approverFirst
        ? `${row.approverFirst} ${row.approverLast ?? ''}`.trim()
        : null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionNote: r.decisionNote,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async list(
    principal: Principal,
    query: PtoQuery,
  ): Promise<{ data: PtoRequestRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(ptoRequests.companyId, principal.companyId), this.reach(principal)];
    if (query.employeeId) parts.push(eq(ptoRequests.employeeId, query.employeeId));
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.status) parts.push(eq(ptoRequests.status, query.status));
    if (query.policyId) parts.push(eq(ptoRequests.policyId, query.policyId));
    if (query.from) parts.push(gte(ptoRequests.endsOn, query.from));
    if (query.to) parts.push(lte(ptoRequests.startsOn, query.to));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(employees.firstName, term),
        ilike(employees.lastName, term),
        ilike(ptoRequests.requestNumber, term),
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(ptoRequests)
      .innerJoin(employees, and(eq(ptoRequests.employeeId, employees.id), eq(employees.companyId, ptoRequests.companyId)))
      .where(where);

    const column = {
      startsOn: ptoRequests.startsOn,
      employeeName: employees.lastName,
      status: ptoRequests.status,
      hours: ptoRequests.hours,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select(this.select())
      .from(ptoRequests)
      .innerJoin(employees, and(eq(ptoRequests.employeeId, employees.id), eq(employees.companyId, ptoRequests.companyId)))
      .innerJoin(ptoPolicies, and(eq(ptoRequests.policyId, ptoPolicies.id), eq(ptoPolicies.companyId, ptoRequests.companyId)))
      .leftJoin(sql`${employees} as approver`, sql`approver.id = ${ptoRequests.approverEmployeeId} and approver.company_id = ${ptoRequests.companyId}`)
      .where(where)
      .orderBy(direction(column))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toRecord(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(principal: Principal, id: string): Promise<PtoRequestRecord> {
    const [row] = await this.db
      .select(this.select())
      .from(ptoRequests)
      .innerJoin(employees, and(eq(ptoRequests.employeeId, employees.id), eq(employees.companyId, ptoRequests.companyId)))
      .innerJoin(ptoPolicies, and(eq(ptoRequests.policyId, ptoPolicies.id), eq(ptoPolicies.companyId, ptoRequests.companyId)))
      .leftJoin(sql`${employees} as approver`, sql`approver.id = ${ptoRequests.approverEmployeeId} and approver.company_id = ${ptoRequests.companyId}`)
      .where(
        and(
          eq(ptoRequests.companyId, principal.companyId),
          or(eq(ptoRequests.id, id), eq(ptoRequests.requestNumber, id)),
          this.reach(principal),
        ),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No PTO request ${id}` });
    }
    return this.toRecord(row);
  }

  /**
   * What is wrong with a request, before it is made.
   *
   * Exposed on its own so the form can warn while somebody is still typing, and reused by the
   * create path so the check the user saw is the check that actually runs.
   */
  async conflicts(
    principal: Principal,
    input: {
      employeeId: string;
      policyId: string;
      startsOn: string;
      endsOn: string;
      hours: number;
    },
    excludeRequestId?: string,
  ): Promise<PtoConflict[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), { table: ptoPolicies, idColumn: ptoPolicies.id, companyColumn: ptoPolicies.companyId, id: input.policyId, label: 'PTO type' }]);
    const balances = await this.balances(principal, input.employeeId);
    const balance = balances.find((b) => b.policyId === input.policyId);
    const [policy] = await this.db
      .select({ allowsNegativeBalance: ptoPolicies.allowsNegativeBalance })
      .from(ptoPolicies)
      .where(and(eq(ptoPolicies.id, input.policyId), eq(ptoPolicies.companyId, principal.companyId)))
      .limit(1);

    const [employee] = await this.db
      .select({ department: employees.department })
      .from(employees)
      .where(and(eq(employees.id, input.employeeId), eq(employees.companyId, principal.companyId)))
      .limit(1);

    const overlappingRows = await this.db
      .select({
        requestNumber: ptoRequests.requestNumber,
        startsOn: ptoRequests.startsOn,
        endsOn: ptoRequests.endsOn,
        status: ptoRequests.status,
      })
      .from(ptoRequests)
      .where(
        and(
          eq(ptoRequests.companyId, principal.companyId),
          eq(ptoRequests.employeeId, input.employeeId),
          inArray(ptoRequests.status, ['submitted', 'approved']),
          lte(ptoRequests.startsOn, input.endsOn),
          gte(ptoRequests.endsOn, input.startsOn),
          ...(excludeRequestId ? [ne(ptoRequests.id, excludeRequestId)] : []),
        ),
      );

    const departmentAbsences = employee
      ? await this.db
          .select({
            employeeName: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
            startsOn: ptoRequests.startsOn,
            endsOn: ptoRequests.endsOn,
          })
          .from(ptoRequests)
          .innerJoin(employees, and(eq(ptoRequests.employeeId, employees.id), eq(employees.companyId, ptoRequests.companyId)))
          .where(
            and(
              eq(ptoRequests.companyId, principal.companyId),
              eq(employees.department, employee.department),
              ne(ptoRequests.employeeId, input.employeeId),
              eq(ptoRequests.status, 'approved'),
              lte(ptoRequests.startsOn, input.endsOn),
              gte(ptoRequests.endsOn, input.startsOn),
            ),
          )
      : [];

    const [recorded] = await this.db
      .select({ value: count() })
      .from(attendanceEntries)
      .where(
        and(
          eq(attendanceEntries.companyId, principal.companyId),
          eq(attendanceEntries.employeeId, input.employeeId),
          gte(attendanceEntries.entryDate, input.startsOn),
          lte(attendanceEntries.entryDate, input.endsOn),
        ),
      );

    return detectPtoConflicts({
      hours: input.hours,
      available: balance?.available ?? 0,
      allowsNegativeBalance: policy?.allowsNegativeBalance ?? false,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      overlapping: overlappingRows,
      departmentAbsences,
      recordedAttendanceDays: recorded?.value ?? 0,
    });
  }

  async create(
    principal: Principal,
    input: CreatePtoRequestRequest,
  ): Promise<{ request: PtoRequestRecord; conflicts: PtoConflict[] }> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), { table: ptoPolicies, idColumn: ptoPolicies.id, companyColumn: ptoPolicies.companyId, id: input.policyId, label: 'PTO type' }]);
    await this.assertReaches(principal, input.employeeId);
    const conflicts = await this.conflicts(principal, input);
    const blocking = conflicts.filter((c) => c.severity === 'blocking');
    if (blocking.length > 0 && !input.asDraft) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: blocking.map((c) => c.message).join(' '),
        extensions: { conflicts },
      });
    }

    const requestNumber = await nextNumber(
      this.db,
      ptoRequests,
      ptoRequests.requestNumber,
      ptoRequests.companyId,
      principal.companyId,
      'PTO',
      1000,
    );
    // Globally unique: the number is per company, and two companies' numbers must not share an id.
    const id = `pto_${crypto.randomUUID()}`;

    await this.db.insert(ptoRequests).values({
      id,
      companyId: principal.companyId,
      requestNumber,
      employeeId: input.employeeId,
      policyId: input.policyId,
      startsOn: input.startsOn,
      endsOn: input.endsOn,
      hours: String(input.hours),
      status: input.asDraft ? 'draft' : 'submitted',
      reason: input.reason,
      notes: input.notes,
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'pto_request',
      entityId: id,
      entityLabel: requestNumber,
      summary: `${input.hours} hours requested, ${input.startsOn} to ${input.endsOn}`,
    });

    return { request: await this.get(principal, id), conflicts };
  }

  /**
   * Approve, reject or cancel.
   *
   * Approving writes the usage row that spends the hours. Cancelling an approved request writes a
   * compensating adjustment rather than deleting the usage, so the ledger reads as what happened
   * rather than as what somebody wishes had happened.
   */
  async decide(
    principal: Principal,
    id: string,
    input: DecidePtoRequestRequest,
  ): Promise<PtoRequestRecord> {
    const before = await this.get(principal, id);
    const allowed = ptoTransitions(before.status);
    if (!allowed.includes(input.status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${before.status} request cannot become ${input.status}`,
      });
    }
    if (input.status === 'rejected' && !input.note) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'A rejection must say why — the employee is owed a reason.',
      });
    }

    if (input.status === 'approved') {
      const conflicts = await this.conflicts(
        principal,
        {
          employeeId: before.employeeId,
          policyId: before.policyId,
          startsOn: before.startsOn,
          endsOn: before.endsOn,
          hours: before.hours,
        },
        before.id,
      );
      const blocking = conflicts.filter((c) => c.severity === 'blocking');
      if (blocking.length > 0 && !input.overrideBalance) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `${blocking.map((c) => c.message).join(' ')} Approve anyway only if policy allows it.`,
          extensions: { conflicts },
        });
      }
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(ptoRequests)
        .set({
          status: input.status,
          decidedAt: new Date(),
          decisionNote: input.note,
          updatedAt: new Date(),
        })
        .where(eq(ptoRequests.id, before.id));

      if (input.status === 'approved') {
        await tx.insert(ptoTransactions).values({
          id: `ptt_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          employeeId: before.employeeId,
          policyId: before.policyId,
          kind: 'usage',
          hours: String(-Math.abs(before.hours)),
          effectiveOn: before.startsOn,
          requestId: before.id,
          reason: `Approved ${before.requestNumber}`,
          actorName: principal.userName ?? principal.userId,
        });
      }

      if (input.status === 'cancelled' && before.status === 'approved') {
        await tx.insert(ptoTransactions).values({
          id: `ptt_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          employeeId: before.employeeId,
          policyId: before.policyId,
          kind: 'adjustment',
          hours: String(Math.abs(before.hours)),
          effectiveOn: today(),
          requestId: null,
          reason: `${before.requestNumber} cancelled after approval`,
          actorName: principal.userName ?? principal.userId,
        });
      }
    });

    await this.audit.write(principal, {
      action: input.status === 'approved' ? 'approve' : 'status_change',
      entityType: 'pto_request',
      entityId: before.id,
      entityLabel: before.requestNumber,
      summary: `${before.requestNumber}: ${before.status} → ${input.status}`,
      changes: [{ field: 'status', old: before.status, new: input.status }],
      reason: input.note,
    });

    return this.get(principal, before.id);
  }

  async summary(principal: Principal): Promise<PtoSummary> {
    const scope = and(eq(ptoRequests.companyId, principal.companyId), this.reach(principal));
    const now = today();
    const monthStart = `${now.slice(0, 7)}-01`;

    const [[pending], [approvedThisMonth], [upcoming], [outToday]] = await Promise.all([
      this.db
        .select({ value: count(), hours: sql<string | null>`sum(${ptoRequests.hours})` })
        .from(ptoRequests)
        .where(and(scope, eq(ptoRequests.status, 'submitted'))),
      this.db
        .select({ value: count() })
        .from(ptoRequests)
        .where(
          and(
            scope,
            eq(ptoRequests.status, 'approved'),
            gte(ptoRequests.decidedAt, new Date(monthStart)),
          ),
        ),
      this.db
        .select({ value: count() })
        .from(ptoRequests)
        .where(and(scope, eq(ptoRequests.status, 'approved'), gte(ptoRequests.startsOn, now))),
      this.db
        .select({ value: count() })
        .from(ptoRequests)
        .where(
          and(
            scope,
            eq(ptoRequests.status, 'approved'),
            lte(ptoRequests.startsOn, now),
            gte(ptoRequests.endsOn, now),
          ),
        ),
    ]);

    return {
      pending: pending?.value ?? 0,
      approvedThisMonth: approvedThisMonth?.value ?? 0,
      upcoming: upcoming?.value ?? 0,
      outToday: outToday?.value ?? 0,
      pendingHours: numOr(pending?.hours ?? '0', 0),
    };
  }
}