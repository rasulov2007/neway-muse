import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, inArray, sql } from 'drizzle-orm';
import { buildDepartmentTree, type Department, type DepartmentNode } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { departments } from '../../database/schema/admin';
import { employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';

/**
 * Departments.
 *
 * The seven the workforce already uses were imported at boot and are marked `isSystem`. Their
 * `code` is written into `employees.department` on 82 rows and read by the workforce, reporting and
 * analytics queries — so the code is immovable, while the display name is not. Renaming
 * "Operations & Dispatch" is safe; renaming `dispatch` is a data migration.
 *
 * Headcount is counted from `employees.department`, the column the rest of the product reads,
 * rather than from `department_id`. Two columns that could disagree would eventually disagree.
 */
@Injectable()
export class DepartmentsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal, includeInactive = true): Promise<Department[]> {
    const parts = [eq(departments.companyId, principal.companyId)];
    if (!includeInactive) parts.push(eq(departments.status, 'active'));

    const rows = await this.db
      .select({
        department: departments,
        managerName: sql<
          string | null
        >`(select e.first_name || ' ' || e.last_name from employees e where e.id = ${departments.managerEmployeeId})`,
        parentName: sql<
          string | null
        >`(select p.name from departments p where p.id = ${departments.parentDepartmentId})`,
      })
      .from(departments)
      .where(and(...parts))
      .orderBy(asc(departments.name));
    if (rows.length === 0) return [];

    // Counted with a group-by rather than a correlated subquery inside an aggregate: the latter
    // silently returns zero here, which has already cost this project three separate bugs.
    const counts = await this.db
      .select({ code: employees.department, value: count() })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          inArray(
            employees.department,
            rows.map((r) => r.department.code),
          ),
          sql`${employees.status} not in ('terminated','archived')`,
        ),
      )
      .groupBy(employees.department);

    return rows.map((row) => ({
      id: row.department.id,
      code: row.department.code,
      name: row.department.name,
      description: row.department.description,
      parentDepartmentId: row.department.parentDepartmentId,
      parentName: row.parentName,
      managerEmployeeId: row.department.managerEmployeeId,
      managerName: row.managerName,
      status: row.department.status as Department['status'],
      isSystem: row.department.isSystem,
      employeeCount: counts.find((c) => c.code === row.department.code)?.value ?? 0,
      createdAt: row.department.createdAt.toISOString(),
    }));
  }

  async tree(principal: Principal): Promise<DepartmentNode[]> {
    return buildDepartmentTree(await this.list(principal));
  }

  async get(principal: Principal, id: string): Promise<Department> {
    const found = (await this.list(principal)).find((d) => d.id === id);
    if (!found) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No department ${id}` });
    }
    return found;
  }

  async create(
    principal: Principal,
    input: {
      code: string;
      name: string;
      description: string | null;
      parentDepartmentId: string | null;
      managerEmployeeId: string | null;
    },
  ): Promise<Department> {
    const existing = await this.list(principal);
    if (existing.some((d) => d.code === input.code)) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A department with the code "${input.code}" already exists`,
      });
    }
    if (existing.some((d) => d.name.toLowerCase() === input.name.toLowerCase())) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A department named "${input.name}" already exists`,
      });
    }
    await this.assertParentExists(existing, input.parentDepartmentId);
    await this.assertManagerEmployed(principal, input.managerEmployeeId);

    const id = `dep_${input.code}`;
    await this.db.insert(departments).values({
      id,
      companyId: principal.companyId,
      code: input.code,
      name: input.name,
      description: input.description,
      parentDepartmentId: input.parentDepartmentId,
      managerEmployeeId: input.managerEmployeeId,
      isSystem: false,
      status: 'active',
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'department',
      entityId: id,
      entityLabel: input.name,
      summary: `Department created (${input.code})`,
    });
    return this.get(principal, id);
  }

  async update(
    principal: Principal,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      parentDepartmentId?: string | null;
      managerEmployeeId?: string | null;
      status?: string;
    },
  ): Promise<Department> {
    const all = await this.list(principal);
    const before = all.find((d) => d.id === id);
    if (!before) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No department ${id}` });
    }

    if (patch.name && all.some((d) => d.id !== id && d.name.toLowerCase() === patch.name!.toLowerCase())) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A department named "${patch.name}" already exists`,
      });
    }
    if (patch.parentDepartmentId !== undefined) {
      if (patch.parentDepartmentId === id) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'A department cannot report to itself',
        });
      }
      await this.assertParentExists(all, patch.parentDepartmentId);
      this.assertNoCycle(all, id, patch.parentDepartmentId);
    }
    if (patch.managerEmployeeId !== undefined) {
      await this.assertManagerEmployed(principal, patch.managerEmployeeId);
    }

    // Deactivating a department nobody has left is fine; deactivating one with staff in it hides
    // those people from every list filtered by active departments.
    if (patch.status === 'inactive' && before.employeeCount > 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${before.employeeCount} employee${before.employeeCount === 1 ? ' is' : 's are'} still in ${before.name}. Move them first.`,
      });
    }

    await this.db
      .update(departments)
      .set({
        name: patch.name ?? undefined,
        description: patch.description === undefined ? undefined : patch.description,
        parentDepartmentId:
          patch.parentDepartmentId === undefined ? undefined : patch.parentDepartmentId,
        managerEmployeeId:
          patch.managerEmployeeId === undefined ? undefined : patch.managerEmployeeId,
        status: patch.status ?? undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(departments.id, id), eq(departments.companyId, principal.companyId)));

    const after = await this.get(principal, id);
    const changes = [
      { field: 'name', old: before.name, new: after.name },
      { field: 'manager', old: before.managerName, new: after.managerName },
      { field: 'parent', old: before.parentName, new: after.parentName },
      { field: 'status', old: before.status, new: after.status },
    ].filter((c) => String(c.old ?? '') !== String(c.new ?? ''));

    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: patch.status && patch.status !== before.status ? 'status_change' : 'update',
        entityType: 'department',
        entityId: id,
        entityLabel: after.name,
        summary: `${changes.map((c) => c.field).join(', ')} changed`,
        changes,
      });
    }
    return after;
  }

  private async assertParentExists(all: Department[], parentId: string | null): Promise<void> {
    if (!parentId) return;
    if (!all.some((d) => d.id === parentId)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That parent department does not exist in this company',
      });
    }
  }

  private assertNoCycle(all: Department[], id: string, parentId: string | null): void {
    let current = parentId;
    const seen = new Set<string>([id]);
    while (current) {
      if (seen.has(current)) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'That would make the department report to itself through its own chain',
        });
      }
      seen.add(current);
      current = all.find((d) => d.id === current)?.parentDepartmentId ?? null;
    }
  }

  private async assertManagerEmployed(
    principal: Principal,
    employeeId: string | null,
  ): Promise<void> {
    if (!employeeId) return;
    const [row] = await this.db
      .select({ id: employees.id })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, employeeId)))
      .limit(1);
    if (!row) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'That manager is not on this workforce',
      });
    }
  }
}
