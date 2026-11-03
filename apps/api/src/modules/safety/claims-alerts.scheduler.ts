import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull, lt, ne } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import { CLAIM_CHARGE_POLICY, businessDaysBetween } from '@neway/shared';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { safetyClaims, safetyDriverCharges } from '../../database/schema/safety';

/**
 * The claims reminders (Claims v2 §5.8), once a morning at 06:00 Eastern:
 *
 * - a charge on hold (driver not told): Safety managers after 3 business days, Management after 7;
 * - a charge waiting for Accounting: Accounting after 3 business days;
 * - a claim with no activity for 7 days: Safety.
 *
 * One notification per person, item and day (the dedupe key), so a restart never repeats one.
 * Test data is never reminded about. Off in tests, which call `tick()` themselves.
 */
const HOUR = 6;
const DAY_MS = 86_400_000;

@Injectable()
export class ClaimsAlertsScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(ClaimsAlertsScheduler.name);
  }

  onModuleInit(): void {
    if (!env.SAFETY_V2 || env.NODE_ENV === 'test') return;
    const delay = msUntilHour(new Date(), 'America/New_York', HOUR);
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), DAY_MS);
      this.timer.unref();
    }, delay);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  private get db() {
    return this.database.db;
  }

  private async holders(companyId: string, code: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
      .where(and(eq(memberships.companyId, companyId), eq(memberships.status, 'active'), eq(rolePermissions.permissionCode, code)));
    return rows.map((r) => r.userId);
  }

  private async send(companyId: string, users: string[], input: { key: string; title: string; body: string; severity: 'info' | 'warning' | 'urgent'; entityType: string; entityId: string }) {
    if (users.length === 0) return 0;
    const rows = await this.db
      .insert(notifications)
      .values(users.map((userId) => ({ id: `ntf_${crypto.randomUUID()}`, companyId, recipientUserId: userId, severity: input.severity, title: input.title, body: input.body, entityType: input.entityType, entityId: input.entityId, source: 'system', dedupeKey: `${input.key}:${userId}` })))
      .onConflictDoNothing()
      .returning({ id: notifications.id });
    return rows.length;
  }

  /** One pass over every company. Public so a test or an operator can call it. */
  async tick(now = new Date()): Promise<{ sent: number }> {
    if (this.running) return { sent: 0 };
    this.running = true;
    let sent = 0;
    try {
      const today = now.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
      for (const company of await this.db.select({ id: companies.id }).from(companies)) {
        try {
          sent += await this.company(company.id, today, now);
        } catch (error) {
          this.logger.error({ err: error, companyId: company.id }, 'Claims reminders failed');
        }
      }
    } finally {
      this.running = false;
    }
    return { sent };
  }

  private async company(companyId: string, today: string, now: Date): Promise<number> {
    let sent = 0;
    const charges = await this.db
      .select()
      .from(safetyDriverCharges)
      .where(and(eq(safetyDriverCharges.companyId, companyId), eq(safetyDriverCharges.isTest, false)));
    const safety = await this.holders(companyId, 'claims.apply_charges');
    const mgmt = await this.holders(companyId, 'claims.approve_exceptions');
    const accounting = await this.holders(companyId, 'accounting.edit');
    for (const c of charges) {
      const days = businessDaysBetween(c.stateChangedAt.toISOString(), now.toISOString());
      const where = `${c.number}${c.claimNumber ? ` · ${c.claimNumber}` : ''}`;
      const amount = `$${(c.amountCents / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
      if (c.state === 'on_hold' && days >= CLAIM_CHARGE_POLICY.holdDaysSafetyManager) {
        const toMgmt = days >= CLAIM_CHARGE_POLICY.holdDaysManagement;
        sent += await this.send(companyId, [...new Set([...safety, ...(toMgmt ? mgmt : [])])], {
          key: `claims:on_hold:${c.id}:${today}`,
          title: `Driver not informed of ${amount} charge`,
          body: `${where} · ${c.driverName} has not been told for ${days} business days. The charge is frozen until Safety records the notice.`,
          severity: toMgmt ? 'urgent' : 'warning',
          entityType: 'safety_claim',
          entityId: c.claimId ?? c.id,
        });
      }
      if (c.state === 'pending_accounting' && days >= CLAIM_CHARGE_POLICY.pendingAccountingDays) {
        sent += await this.send(companyId, accounting, {
          key: `claims:pending_accounting:${c.id}:${today}`,
          title: `Driver charge waiting for Accounting: ${amount}`,
          body: `${where} · ${c.driverName} has waited ${days} business days for approval.`,
          severity: 'warning',
          entityType: 'safety_claim',
          entityId: c.claimId ?? c.id,
        });
      }
    }
    const stale = await this.db
      .select({ id: safetyClaims.id, number: safetyClaims.number, last: safetyClaims.lastActivityAt, owner: safetyClaims.ownerName })
      .from(safetyClaims)
      .where(
        and(
          eq(safetyClaims.companyId, companyId),
          isNull(safetyClaims.voidedAt),
          eq(safetyClaims.isTest, false),
          ne(safetyClaims.stage, 'closed'),
          lt(safetyClaims.lastActivityAt, new Date(now.getTime() - CLAIM_CHARGE_POLICY.staleDays * DAY_MS)),
        ),
      );
    const managers = await this.holders(companyId, 'safety.manage');
    for (const c of stale) {
      const days = Math.floor((now.getTime() - c.last.getTime()) / DAY_MS);
      sent += await this.send(companyId, managers, {
        key: `claims:stale:${c.id}:${today}`,
        title: `No update on ${c.number} in ${days} days`,
        body: `${c.number}${c.owner ? ` (owner ${c.owner})` : ''} has had no activity for ${days} days. Log an update or set the next action.`,
        severity: 'info',
        entityType: 'safety_claim',
        entityId: c.id,
      });
    }
    return sent;
  }
}

/** Milliseconds until the next `hour`:00 in the zone. */
export function msUntilHour(now: Date, timeZone: string, hour: number): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutesNow = h * 60 + m;
  const target = hour * 60;
  const until = minutesNow < target ? target - minutesNow : 24 * 60 - minutesNow + target;
  return until * 60_000;
}
