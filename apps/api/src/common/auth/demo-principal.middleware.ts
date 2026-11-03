import type { IncomingMessage, ServerResponse } from 'node:http';
import { Injectable, type NestMiddleware } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { DRIVER_MEMBERSHIP_PERMISSIONS, PERMISSION_CODES } from '@neway/shared';
import { DatabaseService } from '../../database/database.service';
import { AuthService } from '../../modules/auth/auth.service';
import {
  memberships,
  membershipRoles,
  rolePermissions,
  roles,
  users,
} from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { env } from '../../config/env';
import { DEMO_COMPANY } from '../../modules/reporting/demo/demo-company';
import { DASHBOARD_PERMISSIONS, type Principal } from './principal';
import { setPrincipal } from './request-context';
import { profileStatusFor } from './profile-gate';
import { unsignedTarget, verifyRequest } from './signed-download';

/**
 * Where the request principal comes from.
 *
 * A live session, and nothing else. The browser presents a bearer token, `AuthService` resolves it
 * against `auth_sessions`, and the principal is built from that membership's real roles and
 * permissions - which is what makes the Roles screen mean something: removing a permission from a
 * role changes what the API allows, not just what the UI draws.
 *
 * Requests that prove nothing get NO principal. They do not get a fallback identity, and they do
 * not get one when the database is unreachable either: `AuthenticatedGuard` turns the absence into
 * a 401. This used to work the other way round - no credential meant "act as the company owner",
 * and any error meant "act as an administrator holding every permission in the registry" - so the
 * product had no login because it never needed one, and RBAC could not be relied upon.
 *
 * `X-Account` / `X-Demo-Role` still select an account without a credential, which is exactly the
 * hole described above. They are honoured only when `AUTH_DEV_HEADERS=true`, which the environment
 * loader refuses to accept in production.
 */

export const DEMO_ROLE_HEADER = 'x-demo-role';
export const ACCOUNT_HEADER = 'x-account';

export const DEMO_ROLES = ['admin', 'executive', 'operations'] as const;
export type DemoRole = (typeof DEMO_ROLES)[number];

/**
 * The two synthetic personas.
 *
 * `admin` is absent: it resolves to the owner account in the database. These two are kept as
 * literal sets on purpose — they are test personas for permission masking, not people.
 */
const SYNTHETIC_PERMISSIONS: Record<Exclude<DemoRole, 'admin'>, readonly string[]> = {
  // An executive sees the numbers but not the workforce records behind them, and not the money on
  // the dashboard — which is what the masking tests assert.
  executive: [
    DASHBOARD_PERMISSIONS.view,
    'reports.view',
    'reports.view_financial',
    'analytics.view',
  ],
  // Operations sees activity, not money.
  operations: [DASHBOARD_PERMISSIONS.view, 'reports.view', 'analytics.view'],
};

const SYNTHETIC_NAMES: Record<Exclude<DemoRole, 'admin'>, string> = {
  executive: 'Executive (demo)',
  operations: 'Operations (demo)',
};

const WEEK_START_INDEX: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

export function weekStartIndex(weekStart: string): number {
  return WEEK_START_INDEX[weekStart] ?? 1;
}

/**
 * The synthetic principal for a demo role, with no database access.
 *
 * Kept for unit tests that construct a principal directly. `admin` returns the full permission
 * registry so a unit test is not silently narrower than the real owner account.
 */
export function demoPrincipal(role: DemoRole): Principal {
  if (role === 'admin') {
    return {
      userId: 'demo_admin',
      userName: 'Sarah Chen',
      companyId: DEMO_COMPANY.id,
      companyTimezone: DEMO_COMPANY.timezone,
      weekStart: weekStartIndex(DEMO_COMPANY.weekStart),
      roles: ['administrator'],
      // Everything the registry defines — what the Administrator role grants in the database.
      permissions: new Set(PERMISSION_CODES),
    };
  }
  return {
    userId: `demo_${role}`,
    userName: SYNTHETIC_NAMES[role],
    companyId: DEMO_COMPANY.id,
    companyTimezone: DEMO_COMPANY.timezone,
    weekStart: weekStartIndex(DEMO_COMPANY.weekStart),
    roles: [role],
    permissions: new Set(SYNTHETIC_PERMISSIONS[role]),
  };
}

function isDemoRole(value: string): value is DemoRole {
  return (DEMO_ROLES as readonly string[]).includes(value);
}

interface CompanyContext {
  id: string;
  timezone: string;
  weekStart: number;
}

@Injectable()
export class DemoPrincipalMiddleware implements NestMiddleware<IncomingMessage, ServerResponse> {
  /**
   * Company settings, cached for a few seconds.
   *
   * Read from the database rather than a constant so that changing the operating timezone in
   * Settings actually moves every reporting period — the alternative is a settings screen that
   * writes a value nothing reads. Short-lived because a settings change should take effect without
   * a restart, and per-request because a company's timezone is on the hot path of every query.
   */
  private company: { at: number; value: CompanyContext } | null = null;
  private static readonly COMPANY_TTL_MS = 5_000;

  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(DemoPrincipalMiddleware.name);
  }

  async use(req: IncomingMessage, _res: ServerResponse, next: () => void): Promise<void> {
    try {
      const company = await this.companyContext();

      // A signed document link (signed-download.ts): the request runs as the user it was issued to,
      // for this exact path and query only, for five minutes. A session on the same request is
      // ignored, so a link is never widened by whoever presents it.
      // originalUrl: under the global prefix, req.url arrives without /api/v1.
      const { target, sig } = unsignedTarget((req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? '');
      if (sig !== null) {
        const claims = verifyRequest(env.APP_SECRET, sig, Date.now());
        if (claims && claims.p === target) {
          const principal = await this.buildPrincipal(company, claims.m);
          const [member] = await this.database.db
            .select({ id: memberships.id })
            .from(memberships)
            .where(and(eq(memberships.id, claims.m), eq(memberships.userId, claims.u), eq(memberships.companyId, claims.c), eq(memberships.status, 'active')))
            .limit(1);
          if (principal && member && principal.companyId === claims.c && principal.userId === claims.u) {
            setPrincipal(req, { ...principal, signedIn: true, viaSignedLink: true });
          }
        } else {
          this.logger.warn('A signed document link did not verify');
        }
        next();
        return;
      }

      // A live session is the only way to become somebody.
      const token = this.bearer(req);
      if (token) {
        const session = await this.auth.resolveSession(token);
        if (session) {
          const principal = await this.buildPrincipal(company, session.membershipId);
          if (principal) {
            setPrincipal(req, { ...principal, signedIn: true, sessionId: session.sessionId });
            next();
            return;
          }
        }
        this.logger.warn('A bearer token did not resolve to a live session');
        next();
        return;
      }

      if (env.AUTH_DEV_HEADERS) {
        const account = this.header(req, ACCOUNT_HEADER);
        if (account) {
          const principal = await this.principalForAccount(company, account);
          if (principal) {
            // The development headers are a test harness for RBAC (never accepted in production);
            // the Complete your profile gate is proved with real bearer sessions instead.
            setPrincipal(req, { ...principal, signedIn: true, profileRequired: false });
            next();
            return;
          }
          this.logger.warn({ account }, 'X-Account did not match an account');
        }
        // With the flag on, an absent header means the owner — the pre-authentication default the
        // e2e suite is written against. This is the whole of the old behaviour, now confined to
        // development and test.
        const raw = this.header(req, DEMO_ROLE_HEADER)?.toLowerCase();
        const role: DemoRole = raw && isDemoRole(raw) ? raw : 'admin';
        const principal =
          role === 'admin'
            ? ((await this.ownerPrincipal(company)) ?? demoPrincipal('admin'))
            : {
                ...demoPrincipal(role),
                companyId: company.id,
                companyTimezone: company.timezone,
                weekStart: company.weekStart,
              };
        setPrincipal(req, { ...principal, signedIn: true, profileRequired: false });
        next();
        return;
      }
    } catch (error) {
      // Fail closed. An identity that cannot be verified is not an identity, and the alternative
      // here used to be an administrator holding every permission.
      this.logger.error({ err: error }, 'Could not resolve the principal; refusing the request');
    }
    next();
  }

  /** The bearer token on the request, if any. */
  private bearer(req: IncomingMessage): string | null {
    const value = this.header(req, 'authorization');
    if (!value) return null;
    const [scheme, token] = value.split(' ');
    return scheme?.toLowerCase() === 'bearer' && token ? token : null;
  }

  private header(req: IncomingMessage, name: string): string | undefined {
    const value = req.headers[name];
    const raw = (Array.isArray(value) ? value[0] : value)?.trim();
    return raw === '' ? undefined : raw;
  }

  private async companyContext(): Promise<CompanyContext> {
    const now = Date.now();
    if (this.company && now - this.company.at < DemoPrincipalMiddleware.COMPANY_TTL_MS) {
      return this.company.value;
    }
    const [row] = await this.database.db
      .select()
      .from(companies)
      .where(eq(companies.id, DEMO_COMPANY.id))
      .limit(1);
    const value: CompanyContext = row
      ? { id: row.id, timezone: row.timezone, weekStart: weekStartIndex(row.weekStart) }
      : {
          id: DEMO_COMPANY.id,
          timezone: DEMO_COMPANY.timezone,
          weekStart: weekStartIndex(DEMO_COMPANY.weekStart),
        };
    this.company = { at: now, value };
    return value;
  }

  private async ownerPrincipal(company: CompanyContext): Promise<Principal | null> {
    const [row] = await this.database.db
      .select({ id: memberships.id })
      .from(memberships)
      .where(
        and(
          eq(memberships.companyId, company.id),
          eq(memberships.isOwner, true),
          eq(memberships.status, 'active'),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.buildPrincipal(company, row.id);
  }

  private async principalForAccount(
    company: CompanyContext,
    identifier: string,
  ): Promise<Principal | null> {
    const [row] = await this.database.db
      .select({ id: memberships.id })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .where(
        and(
          eq(memberships.companyId, company.id),
          eq(memberships.status, 'active'),
          identifier.includes('@')
            ? eq(users.email, identifier.toLowerCase())
            : eq(memberships.id, identifier),
        ),
      )
      .limit(1);
    if (!row) return null;
    return this.buildPrincipal(company, row.id);
  }

  /** Roles and permissions, straight from the tables the Roles screen writes. */
  private async buildPrincipal(
    company: CompanyContext,
    membershipId: string,
  ): Promise<Principal | null> {
    // The membership's own company, never the demo default: a session belongs to one tenant and
    // every row it reads or writes carries that tenant's id.
    const rows = await this.database.db
      .select({
        userId: memberships.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        mustChangePassword: users.mustChangePassword,
        isPlatformAdmin: users.isPlatformAdmin,
        isOwner: memberships.isOwner,
        employeeId: memberships.employeeId,
        driverId: memberships.driverId,
        profileCompletedAt: memberships.profileCompletedAt,
        roleCode: roles.code,
        permission: rolePermissions.permissionCode,
        companyId: memberships.companyId,
        companyTimezone: companies.timezone,
        companyWeekStart: companies.weekStart,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, and(eq(membershipRoles.roleId, roles.id), eq(roles.status, 'active')))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(memberships.id, membershipId));

    const first = rows[0];
    if (!first) return null;

    void company;
    const roleCodes = [...new Set(rows.map((r) => r.roleCode).filter((c): c is string => c !== null))];
    const profileRequired =
      (await profileStatusFor(this.database.db, {
        companyId: first.companyId,
        userId: first.userId,
        roles: roleCodes,
        isOwner: first.isOwner,
        isPlatformAdmin: first.isPlatformAdmin,
        employeeId: first.employeeId,
        completedAt: first.profileCompletedAt,
        driverId: first.driverId,
      })) === 'pending';
    const granted = new Set(rows.map((r) => r.permission).filter((p): p is string => p !== null));
    return {
      userId: first.userId,
      userName: `${first.firstName} ${first.lastName}`.trim(),
      companyId: first.companyId,
      companyTimezone: first.companyTimezone,
      weekStart: weekStartIndex(first.companyWeekStart),
      membershipId,
      mustChangePassword: first.mustChangePassword,
      profileRequired,
      roles: roleCodes,
      // A driver login (0081) holds the driver-app codes and nothing else, whatever roles it carries:
      // an office role put on a driver membership by mistake opens no office route.
      permissions: first.driverId ? new Set([...granted].filter((p) => DRIVER_MEMBERSHIP_PERMISSIONS.includes(p))) : granted,
      ...(first.driverId ? { driverId: first.driverId } : {}),
    };
  }
}
