import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  lte,
  or,
  sql,
} from 'drizzle-orm';
import {
  computeHours,
  detectException,
  type AttendanceEntryRecord,
  type AttendanceException,
  type AttendanceQuery,
  type AttendanceStatus,
  type AttendanceSummary,
  type CreateAttendanceEntryRequest,
  type ResolveAttendanceExceptionRequest,
  type UpdateAttendanceEntryRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { attendanceEntries } from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';
import { hrReach, today } from './hr.util';

/**
 * Attendance.
 *
 * Hours are computed on read from the punches, never stored. A stored total is a number that stops
 * matching its own inputs the first time somebody corrects a clock-out, and payroll then has two
 * answers. The exception on a row is stored, because it is a workflow item somebody resolves — but
 * it is recalculated on every write so it can never describe a shape the row no longer has.
 */
@Injectable()
export class AttendanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private toRecord(row: {
    entry: typeof attendanceEntries.$inferSelect;
    first: string | null;
    last: string | null;
    employeeNumber: string | null;
    department: string | null;
    approverFirst: string | null;
    approverLast: string | null;
  }): AttendanceEntryRecord {
    const e = row.entry;
    const hours = computeHours({
      checkInAt: e.checkInAt?.toISOString() ?? null,
      checkOutAt: e.checkOutAt?.toISOString() ?? null,
      breakMinutes: e.breakMinutes,
    });
    return {
      id: e.id,
      employeeId: e.employeeId,
      employeeName: `${row.first ?? ''} ${row.last ?? ''}`.trim(),
      employeeNumber: row.employeeNumber ?? '',
      department: (row.department ?? 'dispatch') as AttendanceEntryRecord['department'],
      entryDate: e.entryDate,
      checkInAt: e.checkInAt?.toISOString() ?? null,
      checkOutAt: e.checkOutAt?.toISOString() ?? null,
      breakMinutes: e.breakMinutes,
      status: e.status as AttendanceStatus,
      exception: e.exception as AttendanceException | null,
      exceptionResolvedAt: e.exceptionResolvedAt?.toISOString() ?? null,
      exceptionNote: e.exceptionNote,
      source: e.source as AttendanceEntryRecord['source'],
      approvedByName: row.approverFirst
        ? `${row.approverFirst} ${row.approverLast ?? ''}`.trim()
        : null,
      approvedAt: e.approvedAt?.toISOString() ?? null,
      notes: e.notes,
      workedHours: hours.worked,
      regularHours: hours.regular,
      overtimeHours: hours.overtime,
    };
  }

  /** HR (attendance.manage) reaches everybody; an approver reaches their direct reports (hr.util hrReach). */
  private reach(principal: Principal) {
    return hrReach(principal, 'attendance.manage', attendanceEntries.employeeId);
  }

  private select() {
    const approver = sql`approver`;
    return {
      entry: attendanceEntries,
      first: employees.firstName,
      last: employees.lastName,
      employeeNumber: employees.employeeNumber,
      department: employees.department,
      approverFirst: sql<string | null>`${approver}.first_name`,
      approverLast: sql<string | null>`${approver}.last_name`,
    };
  }

  async list(
    principal: Principal,
    query: AttendanceQuery,
  ): Promise<{ data: AttendanceEntryRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(attendanceEntries.companyId, principal.companyId), this.reach(principal)];
    if (query.employeeId) parts.push(eq(attendanceEntries.employeeId, query.employeeId));
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.status) parts.push(eq(attendanceEntries.status, query.status));
    if (query.exception) parts.push(eq(attendanceEntries.exception, query.exception));
    if (query.from) parts.push(gte(attendanceEntries.entryDate, query.from));
    if (query.to) parts.push(lte(attendanceEntries.entryDate, query.to));
    if (query.unresolvedOnly) {
      parts.push(isNotNull(attendanceEntries.exception));
      parts.push(isNull(attendanceEntries.exceptionResolvedAt));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(employees.firstName, term),
        ilike(employees.lastName, term),
        ilike(employees.employeeNumber, term),
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(attendanceEntries)
      .innerJoin(employees, and(eq(attendanceEntries.employeeId, employees.id), eq(employees.companyId, attendanceEntries.companyId)))
      .where(where);

    const column = {
      entryDate: attendanceEntries.entryDate,
      employeeName: employees.lastName,
      status: attendanceEntries.status,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select(this.select())
      .from(attendanceEntries)
      .innerJoin(employees, and(eq(attendanceEntries.employeeId, employees.id), eq(employees.companyId, attendanceEntries.companyId)))
      .leftJoin(
        sql`${employees} as approver`,
        sql`approver.id = ${attendanceEntries.approvedByEmployeeId} and approver.company_id = ${attendanceEntries.companyId}`,
      )
      .where(where)
      .orderBy(direction(column), asc(employees.lastName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toRecord(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(principal: Principal, id: string): Promise<AttendanceEntryRecord> {
    const [row] = await this.db
      .select(this.select())
      .from(attendanceEntries)
      .innerJoin(employees, and(eq(attendanceEntries.employeeId, employees.id), eq(employees.companyId, attendanceEntries.companyId)))
      .leftJoin(
        sql`${employees} as approver`,
        sql`approver.id = ${attendanceEntries.approvedByEmployeeId} and approver.company_id = ${attendanceEntries.companyId}`,
      )
      .where(
        and(eq(attendanceEntries.companyId, principal.companyId), eq(attendanceEntries.id, id), this.reach(principal)),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No attendance entry ${id}` });
    }
    return this.toRecord(row);
  }

  async create(
    principal: Principal,
    input: CreateAttendanceEntryRequest,
  ): Promise<AttendanceEntryRecord> {
    const [employee] = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, input.employeeId)))
      .limit(1);
    if (!employee) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That employee is not on the workforce',
      });
    }

    const [clash] = await this.db
      .select({ id: attendanceEntries.id })
      .from(attendanceEntries)
      .where(
        and(
          eq(attendanceEntries.employeeId, input.employeeId),
          eq(attendanceEntries.entryDate, input.entryDate),
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${employee.first} ${employee.last} already has an entry for ${input.entryDate}. Edit it rather than adding a second one.`,
      });
    }

    const exception = detectException({
      status: input.status,
      checkInAt: input.checkInAt,
      checkOutAt: input.checkOutAt,
      breakMinutes: input.breakMinutes,
    });

    const id = `att_${crypto.randomUUID()}`;
    await this.db.insert(attendanceEntries).values({
      id,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      entryDate: input.entryDate,
      checkInAt: input.checkInAt ? new Date(input.checkInAt) : null,
      checkOutAt: input.checkOutAt ? new Date(input.checkOutAt) : null,
      breakMinutes: input.breakMinutes,
      status: input.status,
      exception,
      source: 'manual',
      notes: input.notes,
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'attendance',
      entityId: id,
      entityLabel: `${employee.first} ${employee.last} ${input.entryDate}`,
      summary: `Attendance recorded for ${input.entryDate} (${input.status})`,
    });

    return this.get(principal, id);
  }

  /** Every manual correction is audited with the old and new punch, because payroll depends on it. */
  async update(
    principal: Principal,
    id: string,
    patch: UpdateAttendanceEntryRequest,
  ): Promise<AttendanceEntryRecord> {
    const before = await this.get(principal, id);

    const checkInAt = patch.checkInAt !== undefined ? patch.checkInAt : before.checkInAt;
    const checkOutAt = patch.checkOutAt !== undefined ? patch.checkOutAt : before.checkOutAt;
    const breakMinutes = patch.breakMinutes ?? before.breakMinutes;
    const status = patch.status ?? before.status;

    if (checkInAt && checkOutAt && new Date(checkOutAt) <= new Date(checkInAt)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Clock out must be after clock in',
      });
    }

    const exception = detectException({ status, checkInAt, checkOutAt, breakMinutes });

    await this.db
      .update(attendanceEntries)
      .set({
        checkInAt: checkInAt ? new Date(checkInAt) : null,
        checkOutAt: checkOutAt ? new Date(checkOutAt) : null,
        breakMinutes,
        status,
        exception,
        // A corrected row is no longer approved: whoever approved it approved different numbers.
        approvedByEmployeeId: null,
        approvedAt: null,
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(exception === null ? { exceptionResolvedAt: null, exceptionNote: null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(attendanceEntries.id, id));

    const changes = [
      { field: 'checkInAt', old: before.checkInAt, new: checkInAt },
      { field: 'checkOutAt', old: before.checkOutAt, new: checkOutAt },
      { field: 'breakMinutes', old: String(before.breakMinutes), new: String(breakMinutes) },
      { field: 'status', old: before.status, new: status },
    ].filter((c) => String(c.old ?? '') !== String(c.new ?? ''));

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'attendance',
      entityId: id,
      entityLabel: `${before.employeeName} ${before.entryDate}`,
      summary: `Attendance corrected for ${before.entryDate}`,
      changes,
      reason: patch.reason,
    });

    return this.get(principal, id);
  }

  async approve(principal: Principal, id: string): Promise<AttendanceEntryRecord> {
    const before = await this.get(principal, id);
    if (before.exception && !before.exceptionResolvedAt) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Resolve the exception on this day before approving it.',
      });
    }
    await this.db
      .update(attendanceEntries)
      .set({ approvedAt: new Date(), updatedAt: new Date() })
      .where(eq(attendanceEntries.id, id));

    await this.audit.write(principal, {
      action: 'approve',
      entityType: 'attendance',
      entityId: id,
      entityLabel: `${before.employeeName} ${before.entryDate}`,
      summary: `Attendance approved for ${before.entryDate}`,
    });
    return this.get(principal, id);
  }

  async resolveException(
    principal: Principal,
    id: string,
    input: ResolveAttendanceExceptionRequest,
  ): Promise<AttendanceEntryRecord> {
    const before = await this.get(principal, id);
    if (!before.exception) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'There is nothing outstanding on this day',
      });
    }
    await this.db
      .update(attendanceEntries)
      .set({ exceptionResolvedAt: new Date(), exceptionNote: input.note, updatedAt: new Date() })
      .where(eq(attendanceEntries.id, id));

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'attendance',
      entityId: id,
      entityLabel: `${before.employeeName} ${before.entryDate}`,
      summary: `Exception resolved: ${before.exception}`,
      reason: input.note,
    });
    return this.get(principal, id);
  }

  /** The strip. Everything counted for one day, named in the result so it cannot be misread. */
  async summary(principal: Principal, onDate?: string): Promise<AttendanceSummary> {
    const date = onDate ?? today();
    const scope = and(
      eq(attendanceEntries.companyId, principal.companyId),
      eq(attendanceEntries.entryDate, date),
      this.reach(principal),
    );

    const [byStatus, [exceptions], [overtime]] = await Promise.all([
      this.db
        .select({ status: attendanceEntries.status, value: count() })
        .from(attendanceEntries)
        .where(scope)
        .groupBy(attendanceEntries.status),
      this.db
        .select({ value: count() })
        .from(attendanceEntries)
        .where(
          and(
            eq(attendanceEntries.companyId, principal.companyId),
            this.reach(principal),
            isNotNull(attendanceEntries.exception),
            isNull(attendanceEntries.exceptionResolvedAt),
          ),
        ),
      this.db
        .select({
          value: sql<number | null>`sum(
            greatest(
              extract(epoch from (${attendanceEntries.checkOutAt} - ${attendanceEntries.checkInAt})) / 3600
                - ${attendanceEntries.breakMinutes} / 60.0
                - 8,
              0
            )
          )`,
        })
        .from(attendanceEntries)
        .where(and(scope, isNotNull(attendanceEntries.checkOutAt))),
    ]);

    const at = (status: string) => byStatus.find((s) => s.status === status)?.value ?? 0;
    const missing =
      byStatus.length === 0
        ? 0
        : ((
            await this.db
              .select({ value: count() })
              .from(attendanceEntries)
              .where(
                and(
                  scope,
                  or(
                    eq(attendanceEntries.exception, 'missing_in'),
                    eq(attendanceEntries.exception, 'missing_out'),
                  ),
                ),
              )
          )[0]?.value ?? 0);

    return {
      onDate: date,
      present: at('present'),
      absent: at('absent'),
      late: at('late'),
      onLeave: at('on_leave'),
      missingPunch: missing,
      // Null when nobody has a finished shift that day: no data is not zero overtime.
      overtimeHours:
        overtime?.value === null || overtime?.value === undefined
          ? null
          : Math.round(Number(overtime.value) * 100) / 100,
      openExceptions: exceptions?.value ?? 0,
    };
  }
}
