import { Injectable } from '@nestjs/common';
import { eq, notInArray, sql } from 'drizzle-orm';
import { PERMISSIONS, SYSTEM_ROLES } from '@neway/shared';
import { PinoLogger } from 'nestjs-pino';
import { DatabaseService } from './database.service';
import {
  departments,
  memberships,
  membershipRoles,
  permissions,
  rolePermissions,
  roles,
  users,
} from './schema/admin';
import { employees } from './schema/people';
import { ROSTER_SEED } from './seed/roster.seed';

/**
 * Brings the control plane into existence.
 *
 * Three parts, each idempotent and each safe on a database that has been running for a week:
 *
 *   permissions — upserted from the code registry on every boot, because the registry is the truth
 *                 and a permission removed from code must stop being grantable.
 *   system roles — upserted, because the product ships them and an administrator cannot edit them.
 *   departments and accounts — imported **once**, from the people already on file, and never as an
 *                 upsert: a company that has renamed a department or disabled an account has made a
 *                 decision this must not silently undo.
 */
@Injectable()
export class AdminSeedService {
  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(AdminSeedService.name);
  }

  private get db() {
    return this.database.db;
  }

  async seed(): Promise<void> {
    await this.syncPermissions();
    await this.syncSystemRoles();
    await this.importDepartments();
    await this.importAccounts();
  }

  /** The registry is authoritative. Codes it no longer contains are removed from every role. */
  private async syncPermissions(): Promise<void> {
    await this.db
      .insert(permissions)
      .values(
        PERMISSIONS.map((p) => ({
          code: p.code,
          module: p.module,
          groupName: p.group,
          action: p.action,
          description: p.description,
        })),
      )
      .onConflictDoUpdate({
        target: permissions.code,
        set: {
          module: sql`excluded.module`,
          groupName: sql`excluded.group_name`,
          action: sql`excluded.action`,
          description: sql`excluded.description`,
        },
      });

    const codes = PERMISSIONS.map((p) => p.code);
    const removed = await this.db
      .delete(permissions)
      .where(notInArray(permissions.code, codes))
      .returning({ code: permissions.code });
    if (removed.length > 0) {
      this.logger.info(
        { removed: removed.map((r) => r.code) },
        'Permissions no longer in the registry were withdrawn',
      );
    }
  }

  private async syncSystemRoles(): Promise<void> {
    for (const definition of SYSTEM_ROLES) {
      const id = `rol_${definition.code}`;
      await this.db
        .insert(roles)
        .values({
          id,
          companyId: null,
          code: definition.code,
          name: definition.name,
          description: definition.description,
          isSystem: true,
          status: 'active',
        })
        .onConflictDoNothing({ target: roles.id });

      // A system role's grants follow the code: replace them rather than merging, so a permission
      // removed from the definition is actually removed.
      await this.db.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
      const granted = definition.permissions.filter((code) =>
        PERMISSIONS.some((p) => p.code === code),
      );
      if (granted.length > 0) {
        await this.db
          .insert(rolePermissions)
          .values(granted.map((code) => ({ roleId: id, permissionCode: code })));
      }
    }
    this.logger.info({ roles: SYSTEM_ROLES.length }, 'System roles are up to date');
  }

  /**
   * Departments, from the values the workforce already uses.
   *
   * Marked `isSystem` because employees reference them by the same code in a text column that other
   * modules still read. Renaming one is allowed; changing its code is not.
   */
  private async importDepartments(): Promise<void> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(departments)
      .where(eq(departments.companyId, companyId));
    if ((existing?.value ?? 0) > 0) return;

    const used = await this.db
      .selectDistinct({ department: employees.department })
      .from(employees)
      .where(eq(employees.companyId, companyId));
    if (used.length === 0) return;

    const NAMES: Record<string, string> = {
      dispatch: 'Dispatch',
      safety: 'Safety',
      maintenance: 'Maintenance',
      accounting: 'Accounting',
      hr: 'Human Resources',
      fleet: 'Fleet',
      management: 'Administration',
    };

    await this.db.insert(departments).values(
      used.map((row) => ({
        id: `dep_${row.department}`,
        companyId,
        code: row.department,
        name: NAMES[row.department] ?? row.department,
        isSystem: true,
        status: 'active',
      })),
    );
    // Link the workforce to the records without touching the text column other modules read.
    await this.db.execute(
      sql`update ${employees} set department_id = 'dep_' || ${employees.department} where ${employees.companyId} = ${companyId}`,
    );
    this.logger.info({ departments: used.length }, 'Departments built from the workforce');
  }

  /**
   * Accounts, for the staff who already carry one.
   *
   * Twelve employees hold a `user_id` from the day the workforce was imported. Those ids are the
   * accounts; this creates the `users` and `memberships` rows behind them and assigns the system
   * role matching the job they already do. Drivers get nothing — they have no login, which is the
   * whole point of keeping user, employee and driver apart.
   */
  private async importAccounts(): Promise<void> {
    const companyId = ROSTER_SEED.company.id;
    const [existing] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(memberships)
      .where(eq(memberships.companyId, companyId));
    if ((existing?.value ?? 0) > 0) {
      this.logger.info({ memberships: existing?.value ?? 0 }, 'Accounts already present');
      return;
    }

    const staff = await this.db
      .select({
        employeeId: employees.id,
        userId: employees.userId,
        firstName: employees.firstName,
        lastName: employees.lastName,
        email: employees.workEmail,
        phone: employees.phone,
        position: employees.position,
      })
      .from(employees)
      .where(sql`${employees.companyId} = ${companyId} and ${employees.userId} is not null`);
    if (staff.length === 0) return;

    const roleFor = (position: string): string => {
      const p = position.toLowerCase();
      if (p.includes('president')) return 'administrator';
      if (p.includes('operations manager')) return 'operations_manager';
      if (p.includes('dispatch')) return 'dispatcher';
      if (p.includes('safety')) return 'safety_manager';
      if (p.includes('fleet')) return 'fleet_manager';
      if (p.includes('maintenance')) return 'fleet_manager';
      if (p.includes('account') || p.includes('billing')) return 'accounting';
      if (p.includes('hr') || p.includes('human')) return 'hr_manager';
      return 'read_only';
    };

    // The President owns the company: the account that can never be locked out.
    const ownerEmployeeId = staff.find((s) =>
      s.position.toLowerCase().includes('president'),
    )?.employeeId;

    await this.db.transaction(async (tx) => {
      for (const person of staff) {
        const userId = person.userId as string;
        await tx.insert(users).values({
          id: userId,
          email: person.email,
          firstName: person.firstName,
          lastName: person.lastName,
          phone: person.phone,
          isActive: true,
        });

        const membershipId = `mbr_${userId.replace(/^usr_/, '')}`;
        await tx.insert(memberships).values({
          id: membershipId,
          companyId,
          userId,
          employeeId: person.employeeId,
          status: 'active',
          isOwner: person.employeeId === ownerEmployeeId,
          acceptedAt: new Date(),
        });
        await tx.insert(membershipRoles).values({
          membershipId,
          roleId: `rol_${roleFor(person.position)}`,
          assignedByName: 'System import',
        });
      }
    });

    this.logger.info({ accounts: staff.length }, 'Accounts built for staff who hold one');
  }

  /** Employees with a `user_id` but no membership — how an account link would go missing. */
  async unlinkedAccounts(): Promise<number> {
    const [row] = await this.db
      .select({ value: sql<number>`count(*)::int` })
      .from(employees)
      .where(
        sql`${employees.userId} is not null and not exists (
          select 1 from ${memberships} m where m.user_id = ${employees.userId}
        )`,
      );
    return row?.value ?? 0;
  }
}
