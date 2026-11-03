import { Injectable, Logger } from '@nestjs/common';
import { and, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm';
import {
  DEEP_LINK_TYPES,
  notificationGroupOf,
  type DeepLink,
  type DeepLinkType,
  type MobileDevice,
  type MobileNotification,
  type MobileNotificationsResponse,
  type MobilePlatform,
  type RegisterDeviceRequest,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions, roles, users } from '../../database/schema/admin';
import { mobileDevices } from '../../database/schema/mobile';
import { PushService } from './push.service';

export interface NotifyInput {
  /** The inbox line: may name the load and the reason. */
  title: string;
  body: string | null;
  /** The push line: generic, nothing sensitive. */
  pushTitle: string;
  pushBody: string;
  severity?: 'info' | 'warning' | 'critical';
  target: DeepLink;
  dedupeKey?: string;
}

/**
 * Notifications addressed to one person, and the phones they are pushed to.
 *
 * The row is written first (recipient_user_id = that person, never company-wide), then pushed.
 * The mobile inbox lists only rows addressed to the caller: company-wide office notifications
 * never reach a driver's phone.
 */
@Injectable()
export class MobileNotificationsService {
  private readonly logger = new Logger(MobileNotificationsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly push: PushService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** The active accounts linked to a roster driver in this company. */
  async driverUserIds(companyId: string, driverId: string): Promise<string[]> {
    const rows = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(and(eq(memberships.companyId, companyId), eq(memberships.driverId, driverId), ne(memberships.status, 'disabled'), ne(memberships.status, 'suspended')));
    return rows.map((r) => r.userId);
  }

  async notify(companyId: string, recipientUserId: string, input: NotifyInput): Promise<string> {
    const id = `ntf_${crypto.randomUUID()}`;
    const inserted = await this.db
      .insert(notifications)
      .values({
        id,
        companyId,
        recipientUserId,
        severity: input.severity ?? 'info',
        title: input.title,
        body: input.body,
        entityType: input.target.type,
        entityId: input.target.parentId ? `${input.target.parentId}/${input.target.id}` : input.target.id,
        source: 'system',
        dedupeKey: input.dedupeKey ?? null,
      })
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    if (inserted.length === 0) return id; // Already told (same dedupe key).
    try {
      await this.push.sendToUser(companyId, recipientUserId, id, { title: input.pushTitle, body: input.pushBody, target: input.target });
    } catch (error) {
      this.logger.warn(`Push for ${id} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    return id;
  }

  /**
   * The office people who hold one of these codes through a role in this company: the team a
   * driver's request is routed to (Fleet: maintenance.edit, Accounting: accounting.edit …). Driver
   * logins never count. When nobody holds it, the owners are told, so a request is never unseen.
   */
  async teamUserIds(companyId: string, codes: readonly string[], options: { exclude?: readonly string[] } = {}): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      // The administrator role holds every code; it is not a team, so it does not get every team's alerts.
      .innerJoin(roles, and(eq(roles.id, membershipRoles.roleId), eq(roles.status, 'active'), ne(roles.code, 'administrator')))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active'), isNull(memberships.driverId), eq(users.isActive, true), inArray(rolePermissions.permissionCode, [...codes])));
    let ids = rows.map((r) => r.userId);
    if (ids.length === 0) {
      const owners = await this.db
        .select({ userId: memberships.userId })
        .from(memberships)
        .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active'), eq(memberships.isOwner, true), isNull(memberships.driverId)));
      ids = owners.map((o) => o.userId);
    }
    const skip = new Set(options.exclude ?? []);
    return [...new Set(ids)].filter((id) => !skip.has(id));
  }

  /** One notification each to these people (the row first, then their phones). */
  async notifyUsers(companyId: string, userIds: readonly string[], input: NotifyInput): Promise<number> {
    const unique = [...new Set(userIds)];
    for (const userId of unique) await this.notify(companyId, userId, { ...input, dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : undefined });
    return unique.length;
  }

  async notifyDriver(companyId: string, driverId: string, input: NotifyInput): Promise<number> {
    const users = await this.driverUserIds(companyId, driverId);
    for (const userId of users) await this.notify(companyId, userId, { ...input, dedupeKey: input.dedupeKey ? `${input.dedupeKey}:${userId}` : undefined });
    return users.length;
  }

  // -------------------------------------------------------------------------- the caller's inbox

  private mine(principal: Principal) {
    return and(eq(notifications.companyId, principal.companyId), eq(notifications.recipientUserId, principal.userId));
  }

  async list(principal: Principal, limit = 50): Promise<MobileNotificationsResponse> {
    const rows = await this.db.select().from(notifications).where(this.mine(principal)).orderBy(desc(notifications.createdAt)).limit(Math.min(200, Math.max(1, limit)));
    const [unread] = await this.db.select({ value: count() }).from(notifications).where(and(this.mine(principal), isNull(notifications.readAt)));
    // Action required vs Updates (M4, office sheet 24): by severity, over all unread rows.
    const [action] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(and(this.mine(principal), isNull(notifications.readAt), inArray(notifications.severity, ['warning', 'critical'])));
    const total = unread?.value ?? 0;
    const actionCount = action?.value ?? 0;
    return { notifications: rows.map((r) => this.toView(r)), unread: total, unreadByGroup: { action: actionCount, update: total - actionCount } };
  }

  async markRead(principal: Principal, id: string): Promise<{ ok: true }> {
    await this.db.update(notifications).set({ readAt: new Date() }).where(and(this.mine(principal), eq(notifications.id, id), isNull(notifications.readAt)));
    return { ok: true };
  }

  async markAllRead(principal: Principal): Promise<{ updated: number }> {
    const rows = await this.db.update(notifications).set({ readAt: new Date() }).where(and(this.mine(principal), isNull(notifications.readAt))).returning({ id: notifications.id });
    return { updated: rows.length };
  }

  private toView(row: typeof notifications.$inferSelect): MobileNotification {
    let target: DeepLink | null = null;
    if (row.entityType && row.entityId && (DEEP_LINK_TYPES as readonly string[]).includes(row.entityType)) {
      const [first, second] = row.entityId.split('/');
      target = second ? { type: row.entityType as DeepLinkType, id: second, parentId: first ?? null } : { type: row.entityType as DeepLinkType, id: row.entityId };
    }
    return { id: row.id, severity: row.severity, title: row.title, body: row.body, target, readAt: row.readAt?.toISOString() ?? null, createdAt: row.createdAt.toISOString(), group: notificationGroupOf(row.severity) };
  }

  // -------------------------------------------------------------------------------- devices

  /**
   * Registers this phone's Expo token for the caller's membership and session. The same token
   * under another account (a shared phone, a company switch) is revoked there: one phone, one
   * account's notifications at a time.
   */
  async registerDevice(principal: Principal, input: RegisterDeviceRequest): Promise<MobileDevice> {
    if (!principal.membershipId) throw new AppError({ status: 403, title: 'Forbidden', detail: 'Sign in before registering a device.' });
    const now = new Date();
    const token = input.expoToken.trim();
    await this.db
      .update(mobileDevices)
      .set({ revokedAt: now, revokedReason: 'registered_by_another_account' })
      .where(and(eq(mobileDevices.expoToken, token), ne(mobileDevices.membershipId, principal.membershipId), isNull(mobileDevices.revokedAt)));
    const [live] = await this.db
      .select()
      .from(mobileDevices)
      .where(and(eq(mobileDevices.membershipId, principal.membershipId), eq(mobileDevices.expoToken, token), isNull(mobileDevices.revokedAt)))
      .limit(1);
    if (live) {
      const [row] = await this.db
        .update(mobileDevices)
        .set({ lastSeenAt: now, sessionId: principal.sessionId ?? live.sessionId, appVersion: input.appVersion ?? live.appVersion, platform: input.platform })
        .where(eq(mobileDevices.id, live.id))
        .returning();
      return this.deviceView(row!);
    }
    const [row] = await this.db
      .insert(mobileDevices)
      .values({
        id: `dev_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        membershipId: principal.membershipId,
        userId: principal.userId,
        sessionId: principal.sessionId ?? null,
        expoToken: token,
        platform: input.platform,
        appVersion: input.appVersion ?? null,
        createdAt: now,
        lastSeenAt: now,
      })
      .returning();
    return this.deviceView(row!);
  }

  async revokeDevice(principal: Principal, id: string): Promise<MobileDevice> {
    const [row] = await this.db
      .select()
      .from(mobileDevices)
      .where(and(eq(mobileDevices.id, id), eq(mobileDevices.companyId, principal.companyId), eq(mobileDevices.userId, principal.userId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such device.' });
    if (row.revokedAt) return this.deviceView(row);
    const [updated] = await this.db.update(mobileDevices).set({ revokedAt: new Date(), revokedReason: 'revoked_by_user' }).where(eq(mobileDevices.id, id)).returning();
    return this.deviceView(updated!);
  }

  async myDevices(principal: Principal): Promise<MobileDevice[]> {
    const rows = await this.db
      .select()
      .from(mobileDevices)
      .where(and(eq(mobileDevices.companyId, principal.companyId), eq(mobileDevices.userId, principal.userId)))
      .orderBy(desc(mobileDevices.lastSeenAt));
    return rows.map((r) => this.deviceView(r));
  }

  private deviceView(row: typeof mobileDevices.$inferSelect): MobileDevice {
    return {
      id: row.id,
      platform: row.platform as MobilePlatform,
      appVersion: row.appVersion,
      createdAt: row.createdAt.toISOString(),
      lastSeenAt: row.lastSeenAt.toISOString(),
      revokedAt: row.revokedAt?.toISOString() ?? null,
    };
  }
}
