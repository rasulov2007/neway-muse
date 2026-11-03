import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { SYSTEM_ROLES } from '@neway/shared';
import { eq, inArray } from 'drizzle-orm';
import type { Principal } from '../../src/common/auth/principal';
import { DatabaseService } from '../../src/database/database.service';
import { memberships, users } from '../../src/database/schema/admin';
import { companies } from '../../src/database/schema/roster';
import { UsersService } from '../../src/modules/admin/users.service';
import { AuthService } from '../../src/modules/auth/auth.service';

/**
 * Real sessions for the authorization suites: a fresh company per suite and one active account per
 * built-in role, signed in through the real login so the principal is exactly what production
 * builds (roles and permissions from the tables the Roles screen writes). Nothing is deleted
 * afterwards: the accounts are archived, the throwaway companies stay as test records.
 */
export const ROLE_CODES = SYSTEM_ROLES.map((r) => r.code);

export function adminPrincipal(companyId: string): Principal {
  return {
    userId: `u_e2e_authz_${companyId}`,
    userName: 'E2E Authz',
    companyId,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: ['administrator'],
    permissions: new Set(SYSTEM_ROLES.find((r) => r.code === 'administrator')!.permissions),
    signedIn: true,
  };
}

export interface RoleSession {
  token: string;
  userId: string;
  membershipId: string;
  email: string;
  name: string;
  password: string;
}

export class SessionFactory {
  private readonly created: string[] = [];
  constructor(
    private readonly app: NestFastifyApplication,
    private readonly tag: string,
  ) {}

  async company(id: string, name: string): Promise<void> {
    await this.app.get(DatabaseService).db.insert(companies).values({ id, name } as typeof companies.$inferInsert).onConflictDoNothing();
  }

  /** An active account holding `roleCode` (a system role) in `companyId`, signed in. */
  async signIn(companyId: string, roleCode: string, label = roleCode, employeeId: string | null = null): Promise<RoleSession> {
    const slug = `${label}.${companyId}`.toLowerCase().replace(/[^a-z0-9.]+/g, '.');
    const email = `authz.${slug}.${this.tag}@example.test`;
    const name = `Authz ${label}`;
    const created = await this.app.get(UsersService).create(adminPrincipal(companyId), {
      firstName: 'Authz',
      lastName: label.slice(0, 40),
      email,
      phone: null,
      employeeId,
      roleIds: [`rol_${roleCode}`],
      invite: false,
    });
    const db = this.app.get(DatabaseService).db;
    this.created.push(created.account.userId);
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, created.account.membershipId));
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, created.account.userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, created.account.userId));
    const login = await this.app.get(AuthService).login({ email, password: created.temporaryPassword as string }, {});
    if (login.account.companyId !== companyId) throw new Error(`signed into ${login.account.companyId}, wanted ${companyId}`);
    return { token: login.token, userId: created.account.userId, membershipId: created.account.membershipId, email, name, password: created.temporaryPassword as string };
  }

  /** Archives every account this factory made (never deletes). */
  async archiveAll(): Promise<void> {
    if (this.created.length === 0) return;
    await this.app.get(DatabaseService).db.update(memberships).set({ status: 'archived' }).where(inArray(memberships.userId, this.created));
  }
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
