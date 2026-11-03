import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  AppearanceSchema,
  DRIVER_MEMBERSHIP_PERMISSIONS,
  MOBILE_SESSION_TTL_DAYS,
  SESSION_TTL_HOURS,
  type LoginClient,
  type AuthAccount,
  type UpdatePreferencesRequest,
  type LoginRequest,
  type LoginResponse,
} from '@neway/shared';
import { DatabaseService } from '../../database/database.service';
import {
  authSessions,
  memberships,
  membershipRoles,
  rolePermissions,
  roles,
  users,
} from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { mobileDevices } from '../../database/schema/mobile';
import { AppError } from '../../common/errors/app-error';
import { RateLimiter } from '../../common/http/rate-limiter';
import { hashPassword, verifyPassword } from './password.util';
import { profileStatusFor } from '../../common/auth/profile-gate';

/** The token the browser holds; only its digest is ever stored. */
export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** How long a new session lasts: 12 h in the browser, 30 days on the phone (0081). */
export function sessionTtlMs(client: LoginClient | null | undefined): number {
  return client === 'mobile' ? MOBILE_SESSION_TTL_DAYS * 24 * 3600 * 1000 : SESSION_TTL_HOURS * 3600 * 1000;
}

/**
 * Signing in, staying signed in, and signing out.
 *
 * The session row is the authority: the browser holds a random token, the database holds its
 * digest, and revoking or expiring the row ends the session no matter what the browser kept. A
 * wrong email and a wrong password produce the same refusal, so this endpoint cannot be used to
 * find out who has an account.
 */
@Injectable()
export class AuthService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /**
   * Failed sign-ins per address + identifier (0081, the phone app made this a second door): ten
   * wrong passwords in fifteen minutes and that pair waits. Only failures count, so a person who
   * signs in correctly is never slowed down; in memory, like every first-line limiter here.
   */
  readonly loginFailures = new RateLimiter(10, 15 * 60_000);

  private static readonly REFUSED = new AppError({
    status: 401,
    title: 'Unauthorized',
    detail: 'That email address and password do not match an account.',
  });

  async login(
    input: LoginRequest,
    context: { userAgent?: string; ip?: string },
  ): Promise<LoginResponse> {
    const identifier = input.email.trim().toLowerCase();
    const limitKey = `${context.ip ?? 'unknown'}|${identifier}`;
    const TOO_MANY = 'Too many sign-in attempts. Wait a few minutes and try again.';
    this.loginFailures.check(limitKey, TOO_MANY);
    const row = await this.pickMembership(await this.accountsMatching(identifier));

    if (!row || !row.isActive || !(await verifyPassword(input.password, row.passwordHash))) {
      this.loginFailures.hit(limitKey, TOO_MANY);
      throw AuthService.REFUSED;
    }
    if (row.status === 'suspended' || row.status === 'disabled') {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'This account is not active. An administrator has to re-enable it.',
      });
    }
    if (row.companyDeactivatedAt) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'This company has been deactivated. Contact the platform administrator.',
      });
    }

    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    const client: LoginClient = input.client === 'mobile' ? 'mobile' : 'web';
    const expiresAt = new Date(now.getTime() + sessionTtlMs(client));

    await this.db.transaction(async (tx) => {
      await tx.insert(authSessions).values({
        id: `ses_${randomUUID()}`,
        userId: row.userId,
        membershipId: row.membershipId,
        companyId: row.companyId,
        tokenHash: tokenDigest(token),
        userAgent: context.userAgent ?? null,
        ip: context.ip ?? null,
        expiresAt,
        client,
      });
      await tx.update(users).set({ lastLoginAt: now }).where(eq(users.id, row.userId));
      // A first successful sign-in is what turns an invited account into an active one; nothing
      // else in the product can prove the person actually arrived.
      if (row.status === 'invited') {
        await tx
          .update(memberships)
          .set({ status: 'active', acceptedAt: now })
          .where(eq(memberships.id, row.membershipId));
      }
    });

    return {
      token,
      expiresAt: expiresAt.toISOString(),
      account: await this.account(row.membershipId),
    };
  }

  /**
   * Accounts a typed identifier could mean.
   *
   * Usually the email address itself. A person whose address is `admin@neway.local` may also type
   * just `admin`, which is how the built-in administrator signs in — but only when that name
   * resolves to exactly one account, so a short name can never quietly log somebody into the wrong
   * one. Two rows are fetched precisely to detect that ambiguity.
   */
  private async accountsMatching(identifier: string) {
    const columns = {
      userId: users.id,
      passwordHash: users.passwordHash,
      isActive: users.isActive,
      membershipId: memberships.id,
      companyId: memberships.companyId,
      status: memberships.status,
      companyDeactivatedAt: companies.deactivatedAt,
    };
    // One person may work in several companies (owner, 2026-10-13): every membership comes back
    // and `pickMembership` chooses where the session starts.
    const exact = await this.db
      .select(columns)
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(sql`lower(${users.email}) = ${identifier}`)
      .limit(50);
    if (exact.length > 0) return exact;

    if (identifier.includes('@')) return [];
    const byName = await this.db
      .select(columns)
      .from(users)
      .innerJoin(memberships, eq(memberships.userId, users.id))
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(sql`split_part(lower(${users.email}), '@', 1) = ${identifier}`)
      .limit(2);
    return byName.length === 1 ? byName : [];
  }

  /**
   * Where a sign-in lands when the person has more than one company: a membership that can work
   * (not suspended, company not deactivated), the one they used last first.
   */
  private async pickMembership<T extends { userId: string; membershipId: string; status: string; companyDeactivatedAt: Date | null }>(rows: T[]): Promise<T | undefined> {
    if (rows.length <= 1) return rows[0];
    const usable = rows.filter((r) => r.status !== 'suspended' && r.status !== 'disabled' && !r.companyDeactivatedAt);
    if (usable.length === 0) return rows[0];
    const [last] = await this.db
      .select({ membershipId: authSessions.membershipId })
      .from(authSessions)
      .where(eq(authSessions.userId, usable[0]!.userId))
      .orderBy(desc(authSessions.createdAt))
      .limit(1);
    return usable.find((r) => r.membershipId === last?.membershipId) ?? usable[0];
  }

  /**
   * Moves a signed-in person to another of their companies: a new session for that membership,
   * and the current one ends. Only a company they are a member of, active, not deactivated.
   */
  async switchCompany(currentToken: string, userId: string, companyId: string, context: { userAgent?: string; ip?: string }): Promise<LoginResponse> {
    const [row] = await this.db
      .select({ membershipId: memberships.id, status: memberships.status, companyId: memberships.companyId, companyDeactivatedAt: companies.deactivatedAt })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(and(eq(memberships.userId, userId), eq(memberships.companyId, companyId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'You are not a member of that company.' });
    if (row.status === 'suspended' || row.status === 'disabled') throw new AppError({ status: 403, title: 'Forbidden', detail: 'Your account in that company is not active.' });
    if (row.companyDeactivatedAt) throw new AppError({ status: 403, title: 'Forbidden', detail: 'That company has been deactivated.' });
    const now = new Date();
    const token = randomBytes(32).toString('base64url');
    // The phone stays a phone across a company switch: the new session keeps the old one's client.
    const [current] = await this.db.select({ client: authSessions.client }).from(authSessions).where(eq(authSessions.tokenHash, tokenDigest(currentToken))).limit(1);
    const client: LoginClient = current?.client === 'mobile' ? 'mobile' : 'web';
    const expiresAt = new Date(now.getTime() + sessionTtlMs(client));
    await this.db.transaction(async (tx) => {
      await tx.insert(authSessions).values({
        id: `ses_${randomUUID()}`,
        userId,
        membershipId: row.membershipId,
        companyId: row.companyId,
        tokenHash: tokenDigest(token),
        userAgent: context.userAgent ?? null,
        ip: context.ip ?? null,
        expiresAt,
        client,
      });
      if (row.status === 'invited') {
        await tx.update(memberships).set({ status: 'active', acceptedAt: now }).where(eq(memberships.id, row.membershipId));
      }
    });
    await this.logout(currentToken);
    return { token, expiresAt: expiresAt.toISOString(), account: await this.account(row.membershipId) };
  }

  /** The membership behind a live token, or null. Also refreshes `last_seen_at`. */
  async resolveSession(token: string): Promise<{ membershipId: string; companyId: string; sessionId: string } | null> {
    const digest = tokenDigest(token);
    const [row] = await this.db
      .select({
        id: authSessions.id,
        membershipId: authSessions.membershipId,
        companyId: authSessions.companyId,
        expiresAt: authSessions.expiresAt,
      })
      .from(authSessions)
      .innerJoin(memberships, eq(memberships.id, authSessions.membershipId))
      // A deactivated company's sessions stop answering at once; reactivating brings them back.
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(
        and(
          eq(authSessions.tokenHash, digest),
          isNull(authSessions.revokedAt),
          eq(memberships.status, 'active'),
          isNull(companies.deactivatedAt),
        ),
      )
      .limit(1);
    if (!row || row.expiresAt.getTime() <= Date.now()) return null;
    await this.db
      .update(authSessions)
      .set({ lastSeenAt: new Date() })
      .where(eq(authSessions.id, row.id));
    return { membershipId: row.membershipId, companyId: row.companyId, sessionId: row.id };
  }

  /**
   * Ends the session, and with it the push devices that session registered (0081): a phone that
   * signed out stops receiving that account's notifications at once.
   */
  async logout(token: string): Promise<void> {
    const now = new Date();
    const ended = await this.db
      .update(authSessions)
      .set({ revokedAt: now })
      .where(and(eq(authSessions.tokenHash, tokenDigest(token)), isNull(authSessions.revokedAt)))
      .returning({ id: authSessions.id });
    for (const { id } of ended) {
      await this.db
        .update(mobileDevices)
        .set({ revokedAt: now, revokedReason: 'logout' })
        .where(and(eq(mobileDevices.sessionId, id), isNull(mobileDevices.revokedAt)));
    }
  }

  /**
   * Sets a password and ends the other sessions for that user.
   *
   * `temporary` marks the credential as one that must be replaced at first sign-in. It is an
   * explicit argument rather than a default so that no caller can issue a permanent password by
   * forgetting to say so.
   *
   * `keepSessionToken` spares one session: the person changing their OWN password is holding a
   * session, and revoking it is how a forced password change locked people out of the product the
   * moment they complied with it - the change succeeded, their token died with it, and the next
   * request bounced them back to the login screen. An administrator setting somebody else's
   * password passes nothing, so every session that credential opened still ends.
   */
  async setPassword(
    userId: string,
    password: string,
    options: { temporary: boolean; keepSessionToken?: string },
  ): Promise<void> {
    const hash = await hashPassword(password);
    const keepDigest = options.keepSessionToken ? tokenDigest(options.keepSessionToken) : null;
    await this.db.transaction(async (tx) => {
      await tx
        .update(users)
        .set({
          passwordHash: hash,
          mustChangePassword: options.temporary,
          updatedAt: new Date(),
        })
        .where(eq(users.id, userId));
      await tx
        .update(authSessions)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(authSessions.userId, userId),
            isNull(authSessions.revokedAt),
            ...(keepDigest ? [ne(authSessions.tokenHash, keepDigest)] : []),
          ),
        );
    });
  }

  async changeOwnPassword(
    userId: string,
    currentPassword: string,
    newPassword: string,
    currentSessionToken?: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row || !(await verifyPassword(currentPassword, row.passwordHash))) {
      throw new AppError({
        status: 401,
        title: 'Unauthorized',
        detail: 'The current password is not correct.',
      });
    }
    await this.setPassword(userId, newPassword, {
      temporary: false,
      keepSessionToken: currentSessionToken,
    });
  }

  /**
   * Replaces a temporary password with a chosen one.
   *
   * No current password is asked for: the caller is holding a session, which they could only have
   * obtained by presenting the temporary password minutes ago. Reusing that same password is
   * refused, because a temporary credential that survives the change was pointless.
   */
  async replaceTemporaryPassword(
    userId: string,
    newPassword: string,
    currentSessionToken?: string,
  ): Promise<void> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash, mustChange: users.mustChangePassword })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such account' });
    }
    if (!row.mustChange) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This account does not have a temporary password to replace.',
      });
    }
    if (await verifyPassword(newPassword, row.passwordHash)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Choose a password different from the temporary one.',
      });
    }
    await this.setPassword(userId, newPassword, {
      temporary: false,
      keepSessionToken: currentSessionToken,
    });
  }

  /** Whether a user can sign in at all — used by the Users screen, never the hash itself. */
  async hasPassword(userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ passwordHash: users.passwordHash })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return Boolean(row?.passwordHash);
  }

  /** The worker's own Light / Dark / System choice. Only their own row; nothing else changes. */
  async updatePreferences(userId: string, input: UpdatePreferencesRequest): Promise<void> {
    await this.db
      .update(users)
      .set({ appearance: input.appearance })
      .where(eq(users.id, userId));
  }

  async account(membershipId: string): Promise<AuthAccount> {
    const rows = await this.db
      .select({
        userId: memberships.userId,
        companyId: memberships.companyId,
        isOwner: memberships.isOwner,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        mustChangePassword: users.mustChangePassword,
        appearance: users.appearance,
        isPlatformAdmin: users.isPlatformAdmin,
        employeeId: memberships.employeeId,
        driverId: memberships.driverId,
        profileCompletedAt: memberships.profileCompletedAt,
        roleCode: roles.code,
        permission: rolePermissions.permissionCode,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, eq(roles.id, membershipRoles.roleId))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(eq(memberships.id, membershipId));

    const first = rows[0];
    if (!first) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such account' });
    }
    const theirCompanies = await this.db
      .select({ companyId: companies.id, companyName: companies.name, status: memberships.status, deactivatedAt: companies.deactivatedAt })
      .from(memberships)
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .where(eq(memberships.userId, first.userId));
    const roleCodes = [...new Set(rows.flatMap((r) => (r.roleCode ? [r.roleCode] : [])))];
    const profileRequired =
      (await profileStatusFor(this.db, {
        companyId: first.companyId,
        userId: first.userId,
        roles: roleCodes,
        isOwner: first.isOwner,
        isPlatformAdmin: first.isPlatformAdmin,
        employeeId: first.employeeId,
        completedAt: first.profileCompletedAt,
        driverId: first.driverId,
      })) === 'pending';
    const granted = [...new Set(rows.flatMap((r) => (r.permission ? [r.permission] : [])))];
    const usable = theirCompanies.filter((c) => c.status !== 'suspended' && c.status !== 'disabled' && !c.deactivatedAt);
    return {
      companyName: theirCompanies.find((c) => c.companyId === first.companyId)?.companyName,
      companies: usable.map((c) => ({ companyId: c.companyId, companyName: c.companyName })).sort((a, b) => a.companyName.localeCompare(b.companyName)),
      membershipId,
      userId: first.userId,
      name: `${first.firstName} ${first.lastName}`.trim(),
      email: first.email,
      companyId: first.companyId,
      isOwner: first.isOwner,
      mustChangePassword: first.mustChangePassword,
      profileRequired,
      appearance: AppearanceSchema.catch('system').parse(first.appearance),
      isPlatformAdmin: first.isPlatformAdmin,
      roles: roleCodes,
      // The same cut the principal middleware makes: a driver login holds the driver-app codes only.
      permissions: first.driverId ? granted.filter((p) => DRIVER_MEMBERSHIP_PERMISSIONS.includes(p)) : granted,
      kind: first.driverId ? 'driver' : 'office',
      driverId: first.driverId ?? null,
    };
  }
}
