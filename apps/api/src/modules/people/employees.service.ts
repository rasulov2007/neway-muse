import { Injectable } from '@nestjs/common';
import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lte,
  not,
  or,
  sql,
} from 'drizzle-orm';
import {
  DEPARTMENT_LABELS,
  INACTIVE_EMPLOYEE_STATUSES,
  PAY_TYPE_LABELS,
  resolvePayType,
  type EmployeeDepartment,
  type PayType,
  employeeTransitions,
  statusChangeNeedsReason,
  type ChangeEmployeeStatusRequest,
  type CompensationHistoryEntry,
  isDispatcherPosition,
  type CreateEmployeeRequest,
  type Dispatcher,
  type EmployeePage,
  type EmployeeQuery,
  type EmployeeRecord,
  type EmployeeStatus,
  type PositionHistoryEntry,
  type ReassignEmployeeRequest,
  type SetCompensationRequest,
  type UpdateEmployeeRequest,
  type WorkforceSummary,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  compensationHistory,
  employees,
  positionHistory,
  type EmployeeRow,
} from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { memberships } from '../../database/schema/admin';
import { AuditService, diff } from './audit.service';
import { seesPersonal } from './employee-masking';

const manager = sql`manager`;

/**
 * Employees.
 *
 * The three writes that change someone's standing — reassignment, status and compensation — each
 * close and open a history row rather than overwriting a field, and each writes an audit entry
 * naming the old and new value. That is the difference between an employment record and a
 * spreadsheet of current facts: the spreadsheet cannot answer what someone was paid last March, and
 * that is the question that gets asked.
 */
@Injectable()
export class EmployeesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // -------------------------------------------------------------------------------------- reads

  async list(principal: Principal, query: EmployeeQuery): Promise<EmployeePage> {
    const where = this.filters(principal, query);

    const [counted] = await this.db.select({ value: count() }).from(employees).where(where);
    const total = counted?.value ?? 0;

    const column = {
      name: employees.lastName,
      employeeNumber: employees.employeeNumber,
      department: employees.department,
      position: employees.position,
      status: employees.status,
      hireDate: employees.hireDate,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select({
        employee: employees,
        managerFirst: sql<string | null>`${manager}.first_name`,
        managerLast: sql<string | null>`${manager}.last_name`,
        driverId: drivers.id,
        profileState: EmployeesService.profileStateColumn(),
      })
      .from(employees)
      .leftJoin(sql`${employees} as manager`, sql`manager.id = ${employees.managerEmployeeId} and manager.company_id = ${employees.companyId}`)
      .leftJoin(drivers, eq(drivers.employeeId, employees.id))
      .where(where)
      .orderBy(direction(column), asc(employees.firstName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((row) => {
        const record = toEmployeeRecord(
          row.employee,
          joinName(row.managerFirst, row.managerLast),
          row.driverId,
        );
        return query.scope ? { ...record, profileState: row.profileState } : record;
      }),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * The summary strip.
   *
   * Every figure is a `group by` the database actually ran over the same filtered set the list
   * uses, so a tile and the list it opens cannot disagree. A department with nobody in it is absent
   * from the result rather than reported as zero.
   */
  async summary(principal: Principal, query: EmployeeQuery): Promise<WorkforceSummary> {
    // Staff only, before anything is counted: a driver is not an employee on this page.
    const staff = and(eq(employees.companyId, principal.companyId), EmployeesService.staffOnly());
    const notLeft = not(inArray(employees.status, [...INACTIVE_EMPLOYEE_STATUSES]));
    // The Employees page counts only the view it shows (owner, 2026-10-26).
    const scope = query.scope ? and(staff, EmployeesService.profileScope(query.scope)) : staff;
    const visible = query.includeInactive ? scope : and(scope, notLeft);
    const viewBase = query.includeInactive ? staff : and(staff, notLeft);
    const profileViews = query.scope
      ? this.db
          .select({
            complete: sql<number>`(count(*) filter (where ${EmployeesService.profileScope('profile_complete')}))::int`,
            incomplete: sql<number>`(count(*) filter (where ${EmployeesService.profileScope('profile_incomplete')}))::int`,
          })
          .from(employees)
          .where(viewBase)
      : Promise.resolve([] as { complete: number; incomplete: number }[]);

    const [byStatus, byDepartment, [totals], [driverTotal], [views]] = await Promise.all([
      this.db
        .select({ status: employees.status, value: count() })
        .from(employees)
        .where(scope)
        .groupBy(employees.status),
      this.db
        .select({ department: employees.department, value: count() })
        .from(employees)
        .where(visible)
        .groupBy(employees.department),
      this.db.select({ total: count() }).from(employees).where(visible),
      // An inner join rather than a correlated subquery: it says exactly what it counts, and the
      // subquery version silently returned zero because of how the table reference interpolated.
      this.db
        .select({ value: count() })
        .from(employees)
        .innerJoin(drivers, eq(drivers.employeeId, employees.id))
        .where(visible),
      profileViews,
    ]);

    const total = totals?.total ?? 0;
    const driverCount = driverTotal?.value ?? 0;
    return {
      total,
      byStatus: byStatus.map((r) => ({ status: r.status as EmployeeStatus, count: r.value })),
      byDepartment: byDepartment.map((r) => ({
        department: r.department as WorkforceSummary['byDepartment'][number]['department'],
        count: r.value,
      })),
      drivers: driverCount,
      staff: total - driverCount,
      ...(views
        ? { profileViews: { complete: Number(views.complete), incomplete: Number(views.incomplete) } }
        : {}),
    };
  }

  async find(principal: Principal, idOrNumber: string): Promise<EmployeeRecord | null> {
    const [row] = await this.db
      .select({
        employee: employees,
        managerFirst: sql<string | null>`${manager}.first_name`,
        managerLast: sql<string | null>`${manager}.last_name`,
        driverId: drivers.id,
      })
      .from(employees)
      .leftJoin(sql`${employees} as manager`, sql`manager.id = ${employees.managerEmployeeId} and manager.company_id = ${employees.companyId}`)
      .leftJoin(drivers, eq(drivers.employeeId, employees.id))
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          or(eq(employees.id, idOrNumber), eq(employees.employeeNumber, idOrNumber)),
        ),
      )
      .limit(1);
    return row
      ? toEmployeeRecord(row.employee, joinName(row.managerFirst, row.managerLast), row.driverId)
      : null;
  }

  async get(principal: Principal, idOrNumber: string): Promise<EmployeeRecord> {
    const employee = await this.find(principal, idOrNumber);
    if (!employee) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `No employee ${idOrNumber} on this workforce`,
      });
    }
    return employee;
  }

  async positionHistory(principal: Principal, id: string): Promise<PositionHistoryEntry[]> {
    const employee = await this.get(principal, id);
    const rows = await this.db
      .select({
        row: positionHistory,
        managerFirst: sql<string | null>`${manager}.first_name`,
        managerLast: sql<string | null>`${manager}.last_name`,
      })
      .from(positionHistory)
      .leftJoin(
        sql`${employees} as manager`,
        sql`manager.id = ${positionHistory.managerEmployeeId}`,
      )
      .where(
        and(
          eq(positionHistory.companyId, principal.companyId),
          eq(positionHistory.employeeId, employee.id),
        ),
      )
      .orderBy(desc(positionHistory.effectiveFrom), desc(positionHistory.createdAt));

    return rows.map(({ row, managerFirst, managerLast }) => ({
      id: row.id,
      employeeId: row.employeeId,
      position: row.position,
      department: row.department as PositionHistoryEntry['department'],
      managerEmployeeId: row.managerEmployeeId,
      managerName: joinName(managerFirst, managerLast),
      location: row.location,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
      reason: row.reason,
    }));
  }

  async compensationHistory(principal: Principal, id: string): Promise<CompensationHistoryEntry[]> {
    const employee = await this.get(principal, id);
    const rows = await this.db
      .select()
      .from(compensationHistory)
      .where(
        and(
          eq(compensationHistory.companyId, principal.companyId),
          eq(compensationHistory.employeeId, employee.id),
        ),
      )
      .orderBy(desc(compensationHistory.effectiveFrom));
    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      payType: row.payType as CompensationHistoryEntry['payType'],
      payRate: Number(row.payRate),
      effectiveFrom: row.effectiveFrom,
      reason: row.reason,
    }));
  }

  /** How many people report to this employee. Used before letting them leave. */
  async directReports(principal: Principal, id: string): Promise<EmployeeRecord[]> {
    const rows = await this.db
      .select({ employee: employees, driverId: drivers.id })
      .from(employees)
      .leftJoin(drivers, eq(drivers.employeeId, employees.id))
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          EmployeesService.staffOnly(),
          eq(employees.managerEmployeeId, id),
          not(inArray(employees.status, [...INACTIVE_EMPLOYEE_STATUSES])),
        ),
      )
      .orderBy(asc(employees.lastName));
    return rows.map((row) => toEmployeeRecord(row.employee, null, row.driverId));
  }

  // ------------------------------------------------------------------------------------- writes

  async create(principal: Principal, input: CreateEmployeeRequest): Promise<EmployeeRecord> {
    const workEmail = input.workEmail.trim().toLowerCase();
    const [clash] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          sql`lower(${employees.workEmail}) = ${workEmail}`,
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${workEmail} is already the work email of another employee`,
      });
    }

    if (input.managerEmployeeId) {
      await this.get(principal, input.managerEmployeeId);
    }

    // The pay type follows the department (owner, 2026-10-26): derived when absent, refused when
    // it disagrees. Drivers carry none - their pay plan lives on the driver profile.
    const pay = requirePayType(input.department, input.position ?? '', input.payType ?? null);

    const { id, employeeNumber } = await this.nextEmployeeId(principal);

    const record = await this.db.transaction(async (tx) => {
      const [inserted] = await tx
        .insert(employees)
        .values({
          id,
          companyId: principal.companyId,
          employeeNumber,
          firstName: input.firstName,
          middleName: input.middleName,
          lastName: input.lastName,
          preferredName: input.preferredName,
          workEmail,
          personalEmail: input.personalEmail || null,
          phone: input.phone,
          secondaryPhone: input.secondaryPhone,
          department: input.department,
          position: input.position ?? '',
          managerEmployeeId: input.managerEmployeeId,
          location: input.location,
          hireDate: input.hireDate,
          terminationDate: null,
          status: 'active',
          employmentType: input.employmentType,
          payType: pay,
          payRate: input.payRate === null ? null : String(input.payRate),
          dateOfBirth: input.dateOfBirth ?? null,
          idNumber: input.idNumber ?? null,
          homeAddress: input.homeAddress ?? null,
          shiftTime: input.shiftTime ?? null,
          timezone: input.timezone,
          // A new employee has no login until somebody invites one, and no driving profile until
          // one is created against them. Neither is invented here.
          userId: null,
          emergencyContact:
            input.emergencyContactName || input.emergencyContactPhone
              ? {
                  name: input.emergencyContactName,
                  phone: input.emergencyContactPhone,
                  relationship: input.emergencyContactRelationship,
                }
              : null,
          notes: input.notes,
        })
        .returning();
      if (!inserted) {
        throw new AppError({
          status: 500,
          title: 'Internal Server Error',
          detail: 'Insert failed',
        });
      }

      // The employment record starts the day they are hired, not the day somebody typed it in.
      await tx.insert(positionHistory).values({
        id: `poh_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        employeeId: inserted.id,
        position: inserted.position,
        department: inserted.department,
        managerEmployeeId: inserted.managerEmployeeId,
        location: inserted.location,
        effectiveFrom: inserted.hireDate,
        effectiveTo: null,
        reason: 'Hired',
      });

      if (pay && input.payRate !== null) {
        await tx.insert(compensationHistory).values({
          id: `coh_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          employeeId: inserted.id,
          payType: pay,
          payRate: String(input.payRate),
          effectiveFrom: inserted.hireDate,
          reason: 'Starting compensation',
        });
      }

      return inserted;
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'employee',
      entityId: record.id,
      entityLabel: `${record.firstName} ${record.lastName}`,
      summary: `${record.firstName} ${record.lastName} added${record.position ? ` as ${record.position}` : ''}, ${DEPARTMENT_LABELS[record.department as keyof typeof DEPARTMENT_LABELS] ?? record.department}`,
    });

    return this.get(principal, record.id);
  }

  /** A correction to the record. Anything that changes standing goes through its own operation. */
  /**
   * Everybody who dispatches, active or not, for the pickers and for the names on old records.
   * Position is text and the match is on the word, so "Senior Dispatcher" counts.
   */
  async dispatchers(principal: Principal): Promise<Dispatcher[]> {
    const rows = await this.db
      .select()
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), EmployeesService.staffOnly()))
      .orderBy(asc(employees.firstName), asc(employees.lastName));
    return rows
      .filter((row) => isDispatcherPosition(row.position))
      .map((row) => {
        const record = toEmployeeRecord(row, null, null);
        return {
          id: record.id,
          employeeNumber: record.employeeNumber,
          name: record.name,
          status: record.status,
          active: record.status === 'active',
          position: record.position,
          nickname: row.preferredName?.trim() || null,
          fullName: `${row.firstName} ${row.lastName}`.trim(),
        };
      });
  }

  async update(
    principal: Principal,
    id: string,
    input: UpdateEmployeeRequest,
  ): Promise<EmployeeRecord> {
    const before = await this.get(principal, id);
    // A form filled from a masked copy must not overwrite the real date of birth / ID number.
    const patch: UpdateEmployeeRequest = seesPersonal(principal)
      ? input
      : { ...input, dateOfBirth: undefined, idNumber: undefined };
    // The department is not changed here (that is a reassignment), but a pay type sent with the
    // edit must still agree with it.
    if (input.payType != null) requirePayType(before.department, before.position, input.payType);

    if (patch.workEmail && patch.workEmail.toLowerCase() !== before.workEmail.toLowerCase()) {
      const workEmail = patch.workEmail.trim().toLowerCase();
      const [clash] = await this.db
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(
            eq(employees.companyId, principal.companyId),
            sql`lower(${employees.workEmail}) = ${workEmail}`,
            not(eq(employees.id, before.id)),
          ),
        )
        .limit(1);
      if (clash) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `${workEmail} is already the work email of another employee`,
        });
      }
    }

    const changes = diff(
      before as unknown as Record<string, unknown>,
      patch as Record<string, unknown>,
      [
        'firstName',
        'middleName',
        'lastName',
        'preferredName',
        'workEmail',
        'personalEmail',
        'phone',
        'secondaryPhone',
        'employmentType',
        'hireDate',
        'timezone',
        'notes',
        'dateOfBirth',
        'idNumber',
        'homeAddress',
        'shiftTime',
      ],
    );

    await this.db
      .update(employees)
      .set({
        ...(patch.firstName !== undefined ? { firstName: patch.firstName } : {}),
        ...(patch.middleName !== undefined ? { middleName: patch.middleName } : {}),
        ...(patch.lastName !== undefined ? { lastName: patch.lastName } : {}),
        ...(patch.preferredName !== undefined ? { preferredName: patch.preferredName } : {}),
        ...(patch.workEmail !== undefined
          ? { workEmail: patch.workEmail.trim().toLowerCase() }
          : {}),
        ...(patch.personalEmail !== undefined
          ? { personalEmail: patch.personalEmail || null }
          : {}),
        ...(patch.phone !== undefined ? { phone: patch.phone } : {}),
        ...(patch.secondaryPhone !== undefined ? { secondaryPhone: patch.secondaryPhone } : {}),
        ...(patch.employmentType !== undefined ? { employmentType: patch.employmentType } : {}),
        ...(patch.hireDate !== undefined ? { hireDate: patch.hireDate } : {}),
        ...(patch.timezone !== undefined ? { timezone: patch.timezone } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        ...(patch.dateOfBirth !== undefined ? { dateOfBirth: patch.dateOfBirth } : {}),
        ...(patch.idNumber !== undefined ? { idNumber: patch.idNumber || null } : {}),
        ...(patch.homeAddress !== undefined ? { homeAddress: patch.homeAddress || null } : {}),
        ...(patch.shiftTime !== undefined ? { shiftTime: patch.shiftTime || null } : {}),
        ...(patch.emergencyContactName !== undefined ||
        patch.emergencyContactPhone !== undefined ||
        patch.emergencyContactRelationship !== undefined
          ? {
              emergencyContact: {
                name: patch.emergencyContactName ?? before.emergencyContactName,
                phone: patch.emergencyContactPhone ?? before.emergencyContactPhone,
                relationship:
                  patch.emergencyContactRelationship ?? before.emergencyContactRelationship,
              },
            }
          : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, before.id)));

    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'employee',
        entityId: before.id,
        entityLabel: before.name,
        summary: `${changes.length} field${changes.length === 1 ? '' : 's'} corrected on ${before.name}`,
        changes,
      });
    }

    // A renamed dispatcher is renamed on every driver they run: the id is the link, the name a
    // copy kept for display, and a stale copy would show two names for one person.
    const after = await this.get(principal, id);
    if (after.name !== before.name && isDispatcherPosition(after.position)) {
      await this.db
        .update(drivers)
        .set({ dispatcherName: after.name, updatedAt: new Date() })
        .where(and(eq(drivers.companyId, principal.companyId), eq(drivers.dispatcherId, after.id)));
    }

    return this.get(principal, before.id);
  }

  /**
   * A move: position, department, manager or location.
   *
   * Closes the open history row the day before the new one starts and opens a new one, so the
   * record reads as a sequence of appointments rather than a single mutable row.
   */
  async reassign(
    principal: Principal,
    id: string,
    input: ReassignEmployeeRequest,
  ): Promise<EmployeeRecord> {
    const before = await this.get(principal, id);

    if (input.managerEmployeeId) {
      if (input.managerEmployeeId === before.id) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'Somebody cannot manage themselves',
        });
      }
      const candidate = await this.get(principal, input.managerEmployeeId);
      if (candidate.managerEmployeeId === before.id) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: `${candidate.name} already reports to ${before.name}; that would make a loop`,
        });
      }
    }

    const effectiveFrom = input.effectiveFrom ?? today();
    const changes = diff(
      before as unknown as Record<string, unknown>,
      input as Record<string, unknown>,
      ['position', 'department', 'managerEmployeeId', 'location'],
    );
    if (changes.length === 0) return before;

    const next = {
      position: input.position ?? before.position,
      department: input.department ?? before.department,
      managerEmployeeId:
        input.managerEmployeeId !== undefined ? input.managerEmployeeId : before.managerEmployeeId,
      location: input.location !== undefined ? input.location : before.location,
    };
    // A move into or out of Dispatch moves the pay type with it (owner, 2026-10-26). The amount
    // stays as recorded; HR changes it through Set compensation.
    const nextPayType = requirePayType(next.department, next.position, null);
    if (nextPayType !== before.payType && !(nextPayType === null && before.payType === null)) {
      changes.push({ field: 'payType', old: before.payType, new: nextPayType });
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(positionHistory)
        .set({ effectiveTo: effectiveFrom })
        .where(
          and(
            eq(positionHistory.companyId, principal.companyId),
            eq(positionHistory.employeeId, before.id),
            isNull(positionHistory.effectiveTo),
          ),
        );

      await tx.insert(positionHistory).values({
        id: `poh_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        employeeId: before.id,
        position: next.position,
        department: next.department,
        managerEmployeeId: next.managerEmployeeId,
        location: next.location,
        effectiveFrom,
        effectiveTo: null,
        reason: input.reason,
      });

      await tx
        .update(employees)
        .set({ ...next, payType: nextPayType, updatedAt: new Date() })
        .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, before.id)));
    });

    await this.audit.write(principal, {
      action: 'assign',
      entityType: 'employee',
      entityId: before.id,
      entityLabel: before.name,
      summary: changes
        .map((c) => `${labelFor(c.field)}: ${c.old ?? '—'} → ${c.new ?? '—'}`)
        .join('; '),
      changes,
      reason: input.reason,
    });

    return this.get(principal, before.id);
  }

  async changeStatus(
    principal: Principal,
    id: string,
    input: ChangeEmployeeStatusRequest,
  ): Promise<EmployeeRecord> {
    const before = await this.get(principal, id);
    const allowed = employeeTransitions(before.status);
    if (!allowed.includes(input.status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `An employee who is ${before.status.replace(/_/g, ' ')} cannot become ${input.status.replace(/_/g, ' ')}`,
      });
    }
    if (statusChangeNeedsReason(input.status) && !input.reason) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A reason is required to record someone as ${input.status.replace(/_/g, ' ')}`,
      });
    }

    // Dependencies are named, never silently broken.
    if (input.status === 'terminated' || input.status === 'archived') {
      const reports = await this.directReports(principal, before.id);
      if (reports.length > 0) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `${reports.length} ${reports.length === 1 ? 'person reports' : 'people report'} to ${before.name}. Reassign them to another manager first.`,
          extensions: { reports: reports.map((r) => ({ id: r.id, name: r.name })) },
        });
      }
    }
    if (input.status === 'archived' && before.status !== 'terminated') {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Only a terminated employee can be archived',
      });
    }

    await this.db
      .update(employees)
      .set({
        status: input.status,
        terminationDate:
          input.status === 'terminated'
            ? (input.effectiveOn ?? today())
            : input.status === 'active'
              ? null
              : before.terminationDate,
        updatedAt: new Date(),
      })
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, before.id)));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'employee',
      entityId: before.id,
      entityLabel: before.name,
      summary: `Employment status: ${before.status.replace(/_/g, ' ')} → ${input.status.replace(/_/g, ' ')}`,
      changes: [{ field: 'status', old: before.status, new: input.status }],
      reason: input.reason,
    });

    return this.get(principal, before.id);
  }

  async setCompensation(
    principal: Principal,
    id: string,
    input: SetCompensationRequest,
  ): Promise<EmployeeRecord> {
    const before = await this.get(principal, id);
    if (before.driverId) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          'This person is paid from the pay plan on their driver profile. Change it there, so there is only one rate.',
      });
    }
    requirePayType(before.department, before.position, input.payType);

    await this.db.transaction(async (tx) => {
      await tx.insert(compensationHistory).values({
        id: `coh_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        employeeId: before.id,
        payType: input.payType,
        payRate: String(input.payRate),
        effectiveFrom: input.effectiveFrom,
        reason: input.reason,
      });
      await tx
        .update(employees)
        .set({ payType: input.payType, payRate: String(input.payRate), updatedAt: new Date() })
        .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, before.id)));
    });

    await this.audit.write(principal, {
      action: 'update',
      entityType: 'employee',
      entityId: before.id,
      entityLabel: before.name,
      summary: `Compensation set to ${input.payType} ${input.payRate}, effective ${input.effectiveFrom}`,
      changes: [
        { field: 'payType', old: before.payType, new: input.payType },
        {
          field: 'payRate',
          old: before.payRate === null ? null : String(before.payRate),
          new: String(input.payRate),
        },
      ],
      reason: input.reason,
    });

    return this.get(principal, before.id);
  }

  // -------------------------------------------------------------------------------------- parts

  /**
   * The employee rows that belong to drivers (owner's rule, 2026-09-21).
   *
   * Drivers are on the Drivers page and nowhere else. The relationship is `drivers.employee_id`;
   * a driver row written before that link existed still says "Driver" as its position, so the
   * title is the fallback, never the only test.
   */
  private static driverRows() {
    return sql`(exists (select 1 from ${drivers} d where d.employee_id = ${employees.id}) or ${employees.position} = 'Driver')`;
  }

  /**
   * "Real" employees for the Employees page (owner, 2026-10-26): someone whose account in this
   * company has submitted Complete your profile. Display only — nothing about the row changes, and
   * every other reader of the employees list (pickers, team names, commission splits) still sees
   * the placeholder rows.
   */
  private static profileComplete() {
    return sql`exists (select 1 from ${memberships} m where m.employee_id = ${employees.id} and m.company_id = ${employees.companyId} and m.profile_completed_at is not null)`;
  }

  /** Both Employees page views leave drivers out, whatever the case or wording of the title. */
  private static notDriverTitle() {
    return sql`coalesce(${employees.position}, '') not ilike 'driver%'`;
  }

  private static profileScope(scope: NonNullable<EmployeeQuery['scope']>) {
    return scope === 'profile_complete'
      ? sql`(${EmployeesService.notDriverTitle()} and ${EmployeesService.profileComplete()})`
      : sql`(${EmployeesService.notDriverTitle()} and not ${EmployeesService.profileComplete()})`;
  }

  /** complete · asked (has an account here, not submitted) · no_account. */
  private static profileStateColumn() {
    return sql<'complete' | 'asked' | 'no_account'>`case
      when ${EmployeesService.profileComplete()} then 'complete'
      when exists (select 1 from ${memberships} m where m.employee_id = ${employees.id} and m.company_id = ${employees.companyId}) then 'asked'
      else 'no_account' end`;
  }

  /** Staff only: everybody on the Employees page, its counts, its pickers and its exports. */
  private static staffOnly() {
    return sql`not ${EmployeesService.driverRows()}`;
  }

  private filters(principal: Principal, query: EmployeeQuery) {
    const parts = [eq(employees.companyId, principal.companyId)];
    if (query.status) {
      parts.push(eq(employees.status, query.status));
    } else if (!query.includeInactive) {
      parts.push(not(inArray(employees.status, [...INACTIVE_EMPLOYEE_STATUSES])));
    }
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.position) parts.push(eq(employees.position, query.position));
    if (query.employmentType) parts.push(eq(employees.employmentType, query.employmentType));
    if (query.location) parts.push(eq(employees.location, query.location));
    if (query.managerEmployeeId) {
      parts.push(eq(employees.managerEmployeeId, query.managerEmployeeId));
    }
    if (query.hiredFrom) parts.push(gte(employees.hireDate, query.hiredFrom));
    if (query.hiredTo) parts.push(lte(employees.hireDate, query.hiredTo));
    // The Employees page is staff. Asking for the drivers' rows is still possible for the
    // people module's own use, but it has to be asked for.
    parts.push(query.workforce === 'driver' ? EmployeesService.driverRows() : EmployeesService.staffOnly());
    if (query.scope) parts.push(EmployeesService.profileScope(query.scope));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(employees.firstName, term),
        // "DAVID MCKAY": the whole name, spaces collapsed (owner, 2026-10-26).
        sql`(${employees.firstName} || ' ' || ${employees.lastName}) ilike ${`%${query.search.trim().replace(/\s+/g, ' ')}%`}`,
        ilike(employees.lastName, term),
        ilike(employees.preferredName, term),
        ilike(employees.employeeNumber, term),
        ilike(employees.workEmail, term),
        ilike(employees.phone, term),
        ilike(employees.position, term),
      );
      if (match) parts.push(match);
    }
    return and(...parts);
  }

  /**
   * Employee numbers continue one sequence per company. The id is derived from the number so that
   * a person's two identifiers never drift apart.
   */
  private async nextEmployeeId(
    principal: Principal,
  ): Promise<{ id: string; employeeNumber: string }> {
    const [highest] = await this.db
      .select({
        value: sql<number>`coalesce(max(nullif(regexp_replace(${employees.employeeNumber}, '\\D', '', 'g'), '')::bigint), 1000)::int`,
      })
      .from(employees)
      .where(eq(employees.companyId, principal.companyId));
    const next = (highest?.value ?? 1000) + 1;
    // Ids are global; numbers are per company. A second company's EMP-1001 cannot reuse the first
    // company's emp_1001 (owner, 2026-10-12: Harbor Line could not add anyone), so it takes a company prefix.
    const plain = `emp_${next}`;
    const [taken] = await this.db.select({ id: employees.id }).from(employees).where(eq(employees.id, plain)).limit(1);
    const id = taken ? `emp_${principal.companyId.replace(/^co_/, '')}_${next}` : plain;
    return { id, employeeNumber: `EMP-${next}` };
  }
}

/** The pay type the department allows, or a 422 naming the rule (owner, 2026-10-26). */
function requirePayType(
  department: EmployeeDepartment,
  position: string,
  requested: PayType | null,
): PayType | null {
  const result = resolvePayType({ department, position, requested });
  if (!result.ok) {
    throw new AppError({
      status: 422,
      title: 'Unprocessable Entity',
      detail: result.message,
      extensions: { field: 'payType', allowed: PAY_TYPE_LABELS[department === 'dispatch' ? 'commission' : 'salary'] },
    });
  }
  return result.payType;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function joinName(first: string | null, last: string | null): string | null {
  if (!first && !last) return null;
  return `${first ?? ''} ${last ?? ''}`.trim();
}

const FIELD_LABELS: Record<string, string> = {
  position: 'Position',
  department: 'Department',
  managerEmployeeId: 'Manager',
  location: 'Location',
  status: 'Status',
  payType: 'Pay type',
  payRate: 'Pay rate',
};

function labelFor(field: string): string {
  return FIELD_LABELS[field] ?? field;
}

export function toEmployeeRecord(
  row: EmployeeRow,
  managerName: string | null,
  driverId: string | null,
): EmployeeRecord {
  const contact = (row.emergencyContact ?? null) as {
    name?: string | null;
    phone?: string | null;
    relationship?: string | null;
  } | null;
  const preferred = row.preferredName?.trim();
  return {
    id: row.id,
    employeeNumber: row.employeeNumber,
    firstName: row.firstName,
    middleName: row.middleName,
    lastName: row.lastName,
    preferredName: row.preferredName,
    name: `${preferred || row.firstName} ${row.lastName}`.trim(),
    workEmail: row.workEmail,
    personalEmail: row.personalEmail,
    phone: row.phone,
    secondaryPhone: row.secondaryPhone,
    department: row.department as EmployeeRecord['department'],
    position: row.position,
    managerEmployeeId: row.managerEmployeeId,
    managerName,
    location: row.location,
    hireDate: row.hireDate,
    terminationDate: row.terminationDate,
    status: row.status as EmployeeStatus,
    employmentType: row.employmentType as EmployeeRecord['employmentType'],
    payType: (row.payType as EmployeeRecord['payType']) ?? null,
    // Null, not zero: nobody is paid nothing, so zero here would be a lie about a real rate.
    payRate: row.payRate === null ? null : Number(row.payRate),
    timezone: row.timezone,
    userId: row.userId,
    driverId,
    emergencyContactName: contact?.name ?? null,
    emergencyContactPhone: contact?.phone ?? null,
    emergencyContactRelationship: contact?.relationship ?? null,
    notes: row.notes,
    dateOfBirth: row.dateOfBirth ?? null,
    idNumber: row.idNumber ?? null,
    homeAddress: row.homeAddress ?? null,
    shiftTime: row.shiftTime ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Exported for the seed, which needs the same "does this employee drive" predicate. */
export const employeeHasDriver = isNotNull(drivers.id);
