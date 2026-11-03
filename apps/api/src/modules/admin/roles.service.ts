import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, or, sql } from 'drizzle-orm';
import {
  ADMIN_CRITICAL_PERMISSIONS,
  PERMISSION_CODES,
  permissionMatrix,
  withImpliedPermissions,
  type Role,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  membershipRoles,
  memberships,
  rolePermissions,
  roles,
} from '../../database/schema/admin';
import { AuditService } from '../people/audit.service';

/**
 * Roles.
 *
 * A role is either shipped with the product (`companyId` null, `isSystem`) or created by a company.
 * System roles are shared by every company, so they are never changed in place. Editing one makes
 * this company's own version of it (same code and name) and moves this company's accounts onto it;
 * from then on the list shows the company's version instead of the shipped one. The lockout guard
 * still applies: a change that would leave nobody able to administer the company is refused.
 *
 * Permissions are validated against the shared registry on every write, so a role can never grant a
 * code the backend does not enforce.
 */
@Injectable()
export class RolesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** System roles plus this company's own. Never another company's. */
  private scope(principal: Principal) {
    const visible = or(eq(roles.companyId, principal.companyId), isNull(roles.companyId));
    if (!visible) throw new AppError({ status: 500, title: 'Internal Server Error' });
    return visible;
  }

  async list(
    principal: Principal,
    query: { search?: string; includeArchived: boolean },
  ): Promise<Role[]> {
    const parts = [this.scope(principal)];
    if (!query.includeArchived) parts.push(eq(roles.status, 'active'));
    if (query.search) {
      const match = or(ilike(roles.name, `%${query.search}%`), ilike(roles.code, `%${query.search}%`));
      if (match) parts.push(match);
    }

    const rows = await this.db
      .select()
      .from(roles)
      .where(and(...parts))
      .orderBy(desc(roles.isSystem), asc(roles.name));

    // A built-in role this company has its own version of is shown once: as the company's version.
    const own = new Set(
      rows.filter((r) => r.companyId === principal.companyId && r.status === 'active').map((r) => r.code),
    );
    const overridden = await this.overriddenCodes(principal);
    return this.hydrate(
      principal,
      rows.filter((r) => !(r.isSystem && (own.has(r.code) || overridden.has(r.code)))),
    );
  }

  private async overriddenCodes(principal: Principal): Promise<Set<string>> {
    const rows = await this.db
      .select({ code: roles.code })
      .from(roles)
      .where(and(eq(roles.companyId, principal.companyId), eq(roles.status, 'active')));
    return new Set(rows.map((r) => r.code));
  }

  /**
   * This company's editable version of a built-in role: created (or restored, if it was archived)
   * with the built-in's name and permissions, and this company's accounts moved onto it in the
   * same transaction, so nobody gains or loses access by the switch itself.
   */
  private async customize(principal: Principal, system: Role): Promise<string> {
    const [existing] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.companyId, principal.companyId), eq(roles.code, system.code)))
      .limit(1);
    const id = existing?.id ?? `rol_${crypto.randomUUID()}`;
    await this.db.transaction(async (tx) => {
      if (existing) {
        await tx
          .update(roles)
          .set({ status: 'active', updatedAt: new Date() })
          .where(eq(roles.id, id));
        if (existing.status !== 'active') {
          await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
          if (system.permissions.length > 0) {
            await tx
              .insert(rolePermissions)
              .values(system.permissions.map((permissionCode) => ({ roleId: id, permissionCode })));
          }
        }
      } else {
        await tx.insert(roles).values({
          id,
          companyId: principal.companyId,
          code: system.code,
          name: system.name,
          description: system.description,
          isSystem: false,
          status: 'active',
        });
        if (system.permissions.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(system.permissions.map((permissionCode) => ({ roleId: id, permissionCode })));
        }
      }
      // Accounts of this company holding the built-in move to the company's version. One that
      // somehow holds both keeps the company's version only.
      const mine = tx
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.companyId, principal.companyId));
      await tx
        .delete(membershipRoles)
        .where(
          and(
            eq(membershipRoles.roleId, system.id),
            inArray(membershipRoles.membershipId, mine),
            sql`exists (select 1 from ${membershipRoles} other where other.membership_id = ${membershipRoles.membershipId} and other.role_id = ${id})`,
          ),
        );
      await tx
        .update(membershipRoles)
        .set({ roleId: id })
        .where(and(eq(membershipRoles.roleId, system.id), inArray(membershipRoles.membershipId, mine)));
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'role',
      entityId: id,
      entityLabel: system.name,
      summary: `Built-in role "${system.name}" made editable for this company; its ${system.accountCount} account${system.accountCount === 1 ? '' : 's'} moved onto this version with the same permissions`,
    });
    return id;
  }

  private async hydrate(
    principal: Principal,
    rows: (typeof roles.$inferSelect)[],
  ): Promise<Role[]> {
    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const grants = await this.db
      .select({ roleId: rolePermissions.roleId, code: rolePermissions.permissionCode })
      .from(rolePermissions)
      .where(inArray(rolePermissions.roleId, ids));

    // Counted per company, because a system role is shared across every carrier and "12 accounts"
    // must mean twelve of *this* company's accounts.
    const counts = await this.db
      .select({ roleId: membershipRoles.roleId, value: count() })
      .from(membershipRoles)
      .innerJoin(memberships, eq(membershipRoles.membershipId, memberships.id))
      .where(
        and(
          inArray(membershipRoles.roleId, ids),
          eq(memberships.companyId, principal.companyId),
        ),
      )
      .groupBy(membershipRoles.roleId);

    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      description: row.description,
      isSystem: row.isSystem,
      status: row.status as Role['status'],
      permissions: grants
        .filter((g) => g.roleId === row.id)
        .map((g) => g.code)
        .sort(),
      accountCount: counts.find((c) => c.roleId === row.id)?.value ?? 0,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    }));
  }

  async get(principal: Principal, id: string): Promise<Role> {
    const [row] = await this.db
      .select()
      .from(roles)
      .where(and(eq(roles.id, id), this.scope(principal)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No role ${id}` });
    const [hydrated] = await this.hydrate(principal, [row]);
    return hydrated as Role;
  }

  /** The full matrix, so the UI never has to invent a permission list of its own. */
  matrix() {
    return permissionMatrix();
  }

  private validate(codes: string[]): string[] {
    const unknown = codes.filter((code) => !PERMISSION_CODES.includes(code));
    if (unknown.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `Not a permission this system enforces: ${unknown.join(', ')}`,
      });
    }
    return withImpliedPermissions(codes);
  }

  async create(
    principal: Principal,
    input: {
      name: string;
      description: string | null;
      permissions: string[];
      copyFromRoleId: string | null;
    },
  ): Promise<Role> {
    let requested = input.permissions;
    if (input.copyFromRoleId) {
      const source = await this.get(principal, input.copyFromRoleId);
      requested = [...new Set([...requested, ...source.permissions])];
    }
    const granted = this.validate(requested);

    const code = input.name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_|_$/g, '')
      .slice(0, 40);
    if (code.length < 2) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Give the role a name with letters in it',
      });
    }

    const [clash] = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(and(eq(roles.code, code), this.scope(principal)))
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'A role with that name already exists',
      });
    }

    const id = `rol_${crypto.randomUUID()}`;
    await this.db.transaction(async (tx) => {
      await tx.insert(roles).values({
        id,
        companyId: principal.companyId,
        code,
        name: input.name.trim(),
        description: input.description,
        isSystem: false,
        status: 'active',
      });
      if (granted.length > 0) {
        await tx
          .insert(rolePermissions)
          .values(granted.map((permissionCode) => ({ roleId: id, permissionCode })));
      }
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'role',
      entityId: id,
      entityLabel: input.name.trim(),
      summary: `Role created with ${granted.length} permission${granted.length === 1 ? '' : 's'}`,
    });
    return this.get(principal, id);
  }

  async update(
    principal: Principal,
    id: string,
    patch: { name?: string; description?: string | null; permissions?: string[] },
  ): Promise<Role> {
    let before = await this.get(principal, id);
    const granted = patch.permissions ? this.validate(patch.permissions) : undefined;

    // Removing administration from a role that is somebody's only route to it is the same lockout
    // as disabling their account, and is refused the same way — before a built-in is customised,
    // so a refused edit leaves nothing behind.
    if (granted && ADMIN_CRITICAL_PERMISSIONS.some((p) => before.permissions.includes(p))) {
      const losing = ADMIN_CRITICAL_PERMISSIONS.filter(
        (p) => before.permissions.includes(p) && !granted.includes(p),
      );
      if (losing.length > 0) await this.assertAnotherAdminRoleExists(principal, id);
    }

    if (before.isSystem) {
      id = await this.customize(principal, before);
      before = await this.get(principal, id);
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(roles)
        .set({
          name: patch.name?.trim() ?? undefined,
          description: patch.description === undefined ? undefined : patch.description,
          updatedAt: new Date(),
        })
        .where(eq(roles.id, id));
      if (granted) {
        await tx.delete(rolePermissions).where(eq(rolePermissions.roleId, id));
        if (granted.length > 0) {
          await tx
            .insert(rolePermissions)
            .values(granted.map((permissionCode) => ({ roleId: id, permissionCode })));
        }
      }
    });

    const changes = [];
    if (patch.name && patch.name.trim() !== before.name) {
      changes.push({ field: 'name', old: before.name, new: patch.name.trim() });
    }
    if (granted) {
      const added = granted.filter((c) => !before.permissions.includes(c));
      const removed = before.permissions.filter((c) => !granted.includes(c));
      if (added.length > 0 || removed.length > 0) {
        changes.push({
          field: 'permissions',
          old: removed.length > 0 ? `removed: ${removed.join(', ')}` : null,
          new: added.length > 0 ? `added: ${added.join(', ')}` : null,
        });
      }
    }
    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'role',
        entityId: id,
        entityLabel: before.name,
        summary: changes.map((c) => c.field).join(', ') + ' changed',
        changes,
      });
    }
    return this.get(principal, id);
  }

  async archive(principal: Principal, id: string): Promise<Role> {
    const before = await this.get(principal, id);
    this.assertEditable(before, 'archived');
    if (before.accountCount > 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${before.accountCount} account${before.accountCount === 1 ? ' holds' : 's hold'} this role. Move them to another role first — archiving it would silently remove their access.`,
      });
    }
    await this.db
      .update(roles)
      .set({ status: 'archived', updatedAt: new Date() })
      .where(eq(roles.id, id));
    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'role',
      entityId: id,
      entityLabel: before.name,
      summary: 'Role archived',
      changes: [{ field: 'status', old: 'active', new: 'archived' }],
    });
    return this.get(principal, id);
  }

  private assertEditable(role: Role, verb: string): void {
    if (role.isSystem) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `"${role.name}" ships with the product and cannot be ${verb}. Duplicate it to make a version you can change.`,
      });
    }
  }

  /** Another active role in this company that still grants full administration. */
  private async assertAnotherAdminRoleExists(
    principal: Principal,
    excludingRoleId: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ value: count() })
      .from(memberships)
      .where(
        and(
          eq(memberships.companyId, principal.companyId),
          eq(memberships.status, 'active'),
          ...ADMIN_CRITICAL_PERMISSIONS.map(
            (permission) =>
              sql`exists (
                select 1 from ${membershipRoles} mr
                join ${rolePermissions} rp on rp.role_id = mr.role_id
                where mr.membership_id = ${memberships.id}
                  and mr.role_id <> ${excludingRoleId}
                  and rp.permission_code = ${permission}
              )`,
          ),
        ),
      );
    if ((row?.value ?? 0) === 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          'This is the only role granting account and role management to an active account. Removing those permissions would leave nobody able to administer the company.',
      });
    }
  }
}
