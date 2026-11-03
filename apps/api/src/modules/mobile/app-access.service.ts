import { Injectable } from '@nestjs/common';
import { and, count, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  DRIVER_ROLE_CODE,
  PHONE_LOGIN_DOMAIN,
  phoneLogin,
  type DriverAppAccess,
  type GiveAppAccessRequest,
  type GiveAppAccessResponse,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { authSessions, membershipRoles, memberships, users } from '../../database/schema/admin';
import { mobileDevices } from '../../database/schema/mobile';
import { drivers } from '../../database/schema/roster';
import { AuthService } from '../auth/auth.service';
import { generateTemporaryPassword, hashPassword } from '../auth/password.util';
import { AuditService } from '../people/audit.service';

const DRIVER_ROLE_ID = `rol_${DRIVER_ROLE_CODE}`;

/**
 * Driver app access, from the driver's profile (drivers.edit).
 *
 * Give access: a login (the driver's email, or their phone as `<digits>@phone.neway`, which the
 * existing short-name sign-in accepts as the digits alone), a membership in this company linked
 * to the roster driver (memberships.driver_id) and the system role `driver`. A new login gets a
 * temporary password, returned once. Revoke: the membership is disabled (kept, reversible), every
 * session of it ends and its phones stop receiving pushes. Both are audited.
 */
@Injectable()
export class AppAccessService {
  constructor(
    private readonly database: DatabaseService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async driver(principal: Principal, idOrNumber: string) {
    const [row] = await this.db
      .select()
      .from(drivers)
      .where(and(eq(drivers.companyId, principal.companyId), sql`(${drivers.id} = ${idOrNumber} or ${drivers.driverNumber} = ${idOrNumber})`))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No driver ${idOrNumber} on this roster` });
    return row;
  }

  private async membershipOf(companyId: string, driverId: string) {
    const [row] = await this.db
      .select({ id: memberships.id, status: memberships.status, userId: memberships.userId, email: users.email, lastLoginAt: users.lastLoginAt, mustChangePassword: users.mustChangePassword, updatedAt: memberships.updatedAt })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, companyId), eq(memberships.driverId, driverId)))
      .limit(1);
    return row ?? null;
  }

  async status(principal: Principal, idOrNumber: string): Promise<DriverAppAccess> {
    const driver = await this.driver(principal, idOrNumber);
    return this.view(principal.companyId, driver.id);
  }

  private async view(companyId: string, driverId: string): Promise<DriverAppAccess> {
    const m = await this.membershipOf(companyId, driverId);
    if (!m) return { driverId, state: 'none', membershipId: null, login: null, loginHint: null, lastSignInAt: null, mustChangePassword: false, revokedAt: null, devices: 0 };
    const [devices] = await this.db.select({ n: count() }).from(mobileDevices).where(and(eq(mobileDevices.membershipId, m.id), isNull(mobileDevices.revokedAt)));
    const revoked = m.status === 'disabled' || m.status === 'suspended';
    return {
      driverId,
      state: revoked ? 'revoked' : m.status === 'active' ? 'active' : 'invited',
      membershipId: m.id,
      login: m.email,
      loginHint: m.email.toLowerCase().endsWith(`@${PHONE_LOGIN_DOMAIN}`) ? m.email.split('@')[0]! : null,
      lastSignInAt: m.lastLoginAt?.toISOString() ?? null,
      mustChangePassword: m.mustChangePassword,
      revokedAt: revoked ? m.updatedAt.toISOString() : null,
      devices: devices?.n ?? 0,
    };
  }

  async give(principal: Principal, idOrNumber: string, input: GiveAppAccessRequest): Promise<GiveAppAccessResponse> {
    // The driver app is on trial in named companies only (owner, 2026-10-28).
    const allowed = env.DRIVER_APP_COMPANIES?.split(',').map((s) => s.trim()).filter(Boolean) ?? null;
    if (allowed && !allowed.includes(principal.companyId)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'The driver app is on trial and not open to this company yet.' });
    }
    const driver = await this.driver(principal, idOrNumber);
    if (driver.archivedAt) throw new AppError({ status: 409, title: 'Conflict', detail: 'This driver is archived. Restore the driver before giving app access.' });
    const name = `${driver.firstName} ${driver.lastName}`.trim();
    const existing = await this.membershipOf(principal.companyId, driver.id);

    if (existing && existing.status !== 'disabled' && existing.status !== 'suspended') {
      throw new AppError({ status: 409, title: 'Conflict', detail: `${name} already has driver app access (${existing.email}). Revoke it first to start again.` });
    }

    if (existing) {
      // Re-granting: the same membership comes back. A login used only for this app gets a fresh
      // temporary password; a person who signs in elsewhere keeps their own.
      const [others] = await this.db.select({ n: count() }).from(memberships).where(and(eq(memberships.userId, existing.userId), ne(memberships.id, existing.id)));
      const temporaryPassword = (others?.n ?? 0) === 0 ? generateTemporaryPassword() : null;
      await this.db.update(memberships).set({ status: 'invited', updatedAt: new Date() }).where(eq(memberships.id, existing.id));
      await this.ensureDriverRole(principal, existing.id);
      if (temporaryPassword) await this.auth.setPassword(existing.userId, temporaryPassword, { temporary: true });
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'driver',
        entityId: driver.id,
        entityLabel: name,
        summary: `Driver app access given again (${existing.email})${temporaryPassword ? ' with a new temporary password' : ''}`,
        changes: [{ field: 'appAccess', old: 'revoked', new: 'invited' }],
      });
      return { access: await this.view(principal.companyId, driver.id), temporaryPassword };
    }

    const login = this.loginFor(input.login, driver.email, driver.phone);
    const [user] = await this.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${login}`).limit(1);
    let temporaryPassword: string | null = null;
    const membershipId = `mbr_${crypto.randomUUID()}`;
    const now = new Date();

    if (user) {
      const [here] = await this.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, user.id), eq(memberships.companyId, principal.companyId))).limit(1);
      if (here) {
        throw new AppError({ status: 409, title: 'Conflict', detail: `${login} already has an account in this company. A driver login is separate: use another login (for example the phone number).` });
      }
    }

    await this.db.transaction(async (tx) => {
      let userId = user?.id;
      if (!userId) {
        userId = `usr_${crypto.randomUUID()}`;
        temporaryPassword = generateTemporaryPassword();
        await tx.insert(users).values({
          id: userId,
          email: login,
          firstName: driver.firstName,
          lastName: driver.lastName,
          phone: driver.phone || null,
          passwordHash: await hashPassword(temporaryPassword),
          mustChangePassword: true,
          isActive: true,
        });
      }
      await tx.insert(memberships).values({
        id: membershipId,
        companyId: principal.companyId,
        userId,
        driverId: driver.id,
        status: user ? 'active' : 'invited',
        invitedByUserId: principal.userId,
        invitedAt: now,
        ...(user ? { acceptedAt: now } : {}),
      });
      await tx.insert(membershipRoles).values({ membershipId, roleId: DRIVER_ROLE_ID, assignedByName: principal.userName ?? principal.userId });
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver',
      entityId: driver.id,
      entityLabel: name,
      summary: user ? `Driver app access given to ${name} with their existing login ${login}` : `Driver app access given to ${name}: login ${login}, temporary password issued`,
      changes: [{ field: 'appAccess', old: 'none', new: user ? 'active' : 'invited' }],
    });
    return { access: await this.view(principal.companyId, driver.id), temporaryPassword };
  }

  async revoke(principal: Principal, idOrNumber: string, reason: string): Promise<DriverAppAccess> {
    const driver = await this.driver(principal, idOrNumber);
    const m = await this.membershipOf(principal.companyId, driver.id);
    if (!m || m.status === 'disabled') throw new AppError({ status: 409, title: 'Conflict', detail: 'This driver has no app access to revoke.' });
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.update(memberships).set({ status: 'disabled', updatedAt: now }).where(eq(memberships.id, m.id));
      await tx.update(authSessions).set({ revokedAt: now }).where(and(eq(authSessions.membershipId, m.id), isNull(authSessions.revokedAt)));
      await tx.update(mobileDevices).set({ revokedAt: now, revokedReason: 'access_revoked' }).where(and(eq(mobileDevices.membershipId, m.id), isNull(mobileDevices.revokedAt)));
    });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'driver',
      entityId: driver.id,
      entityLabel: `${driver.firstName} ${driver.lastName}`.trim(),
      summary: `Driver app access revoked (${m.email})`,
      reason,
      changes: [{ field: 'appAccess', old: m.status, new: 'revoked' }],
    });
    return this.view(principal.companyId, driver.id);
  }

  private async ensureDriverRole(principal: Principal, membershipId: string): Promise<void> {
    await this.db
      .insert(membershipRoles)
      .values({ membershipId, roleId: DRIVER_ROLE_ID, assignedByName: principal.userName ?? principal.userId })
      .onConflictDoNothing();
  }

  /** The login a driver types: an email as given, or the phone as `<digits>@phone.neway`. */
  private loginFor(requested: string | undefined, email: string | null, phone: string | null): string {
    const candidates = [requested?.trim(), email?.trim(), phone?.trim()].filter((v): v is string => Boolean(v));
    const first = candidates[0];
    if (!first) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'This driver has no email or phone on file. Type the login to use.' });
    if (first.includes('@')) {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(first)) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That email address does not look right.' });
      return first.toLowerCase();
    }
    const login = phoneLogin(first);
    if (!login) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Use an email address or a phone number with at least 7 digits.' });
    return login;
  }
}
