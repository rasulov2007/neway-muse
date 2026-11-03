import { Injectable } from '@nestjs/common';
import { and, count, desc, eq, isNull, or, sql } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { notifications } from '../../database/schema/admin';

/**
 * In-app notifications.
 *
 * Written only by the workflow engine today. Scoped to the company *and* to the recipient: a
 * notification addressed to somebody else is not this principal's to read, and a company-wide one
 * (null recipient) is everybody's.
 */
@Injectable()
export class NotificationsService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  private mine(principal: Principal) {
    // A driver login (0081) reads only what is addressed to them: company-wide notifications are
    // the office's.
    const addressed = principal.driverId
      ? eq(notifications.recipientUserId, principal.userId)
      : or(
          eq(notifications.recipientUserId, principal.userId),
          isNull(notifications.recipientUserId),
        );
    return and(eq(notifications.companyId, principal.companyId), addressed);
  }

  async list(principal: Principal, limit = 50) {
    const rows = await this.db
      .select()
      .from(notifications)
      .where(this.mine(principal))
      .orderBy(desc(notifications.createdAt))
      .limit(limit);

    return rows.map((row) => ({
      id: row.id,
      severity: row.severity,
      title: row.title,
      body: row.body,
      entityType: row.entityType,
      entityId: row.entityId,
      source: row.source,
      readAt: row.readAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async unreadCount(principal: Principal): Promise<number> {
    const [row] = await this.db
      .select({ value: count() })
      .from(notifications)
      .where(and(this.mine(principal), isNull(notifications.readAt)));
    return row?.value ?? 0;
  }

  async markRead(principal: Principal, id: string): Promise<void> {
    await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(this.mine(principal), eq(notifications.id, id), isNull(notifications.readAt)));
  }

  async markAllRead(principal: Principal): Promise<number> {
    const updated = await this.db
      .update(notifications)
      .set({ readAt: new Date() })
      .where(and(this.mine(principal), isNull(notifications.readAt)))
      .returning({ id: notifications.id });
    return updated.length;
  }

  /** Deliberately not exposed as an endpoint: nothing but the engine creates notifications. */
  async countBySource(principal: Principal) {
    return this.db
      .select({ source: notifications.source, value: count() })
      .from(notifications)
      .where(eq(notifications.companyId, principal.companyId))
      .groupBy(notifications.source)
      .orderBy(sql`2 desc`);
  }
}
