import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { DRIVER_MEMBERSHIP_PERMISSIONS } from '@neway/shared';
import { weekStartIndex } from '../../common/auth/demo-principal.middleware';
import type { Principal } from '../../common/auth/principal';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, rolePermissions, roles, users } from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { AiBriefService } from './ai-brief.service';

/**
 * The Morning brief on a schedule (hackathon A2, 2026-11-03). OFF unless AI_BRIEF_CRON names the
 * US Eastern hours to run at (e.g. "6,10,14,18").
 *
 * At each hour it rebuilds the brief for every person who has one (they pressed Run now at least
 * once), reading with that person's permissions as they are now - their membership must still be
 * active and still hold `ai_assistant.use`. Nobody gets a brief they did not ask for, and nobody's
 * brief reads with someone else's access.
 */
const CHECK_MS = 60_000;
/** A slot still fires if the server was restarting at the top of the hour. */
const SLOT_WINDOW_MINUTES = 10;

/** The hours AI_BRIEF_CRON names, 0-23, or [] (off). */
export function briefHours(raw: string | undefined): number[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((s) => Number(s.trim())).filter((n) => Number.isInteger(n) && n >= 0 && n <= 23))].sort((a, b) => a - b);
}

/** "2026-11-03T06" when `now` is inside a slot's first minutes (US Eastern), else null. */
export function briefSlot(now: Date, hours: readonly number[]): string | null {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const g = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  const hour = Number(g('hour'));
  const minute = Number(g('minute'));
  if (!hours.includes(hour) || minute >= SLOT_WINDOW_MINUTES) return null;
  return `${g('year')}-${g('month')}-${g('day')}T${String(hour).padStart(2, '0')}`;
}

@Injectable()
export class AiBriefScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(AiBriefScheduler.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastSlot: string | null = null;
  private readonly hours = briefHours(env.AI_BRIEF_CRON);

  constructor(
    private readonly database: DatabaseService,
    private readonly briefs: AiBriefService,
  ) {}

  onModuleInit(): void {
    if (env.NODE_ENV === 'test' || this.hours.length === 0) return;
    this.timer = setInterval(() => void this.check(new Date()), CHECK_MS);
    this.timer.unref();
    this.logger.log(`Morning brief at ${this.hours.map((h) => `${h}:00`).join(', ')} Eastern`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  private async check(now: Date): Promise<void> {
    const slot = briefSlot(now, this.hours);
    if (!slot || slot === this.lastSlot) return;
    this.lastSlot = slot;
    await this.runAll();
  }

  /** One pass over every company and every person with a brief. */
  async runAll(): Promise<{ built: number; skipped: number }> {
    if (this.running) return { built: 0, skipped: 0 };
    this.running = true;
    let built = 0;
    let skipped = 0;
    try {
      const live = await this.database.db.select({ id: companies.id }).from(companies).where(isNull(companies.deactivatedAt));
      for (const company of live) {
        for (const holder of await this.briefs.holders(company.id)) {
          const principal = await this.principalFor(company.id, holder.membershipId);
          if (!principal || !principal.permissions.has('ai_assistant.use')) {
            skipped += 1;
            continue;
          }
          try {
            await this.briefs.run(principal, 'scheduled');
            built += 1;
          } catch (error) {
            skipped += 1;
            this.logger.warn({ companyId: company.id, userId: holder.userId, error: String(error) }, 'Scheduled brief failed');
          }
        }
      }
    } finally {
      this.running = false;
    }
    this.logger.log({ built, skipped }, 'Scheduled Morning briefs');
    return { built, skipped };
  }

  /** The person as they are now: an active membership of this company, its active roles' codes. */
  private async principalFor(companyId: string, membershipId: string): Promise<Principal | null> {
    const rows = await this.database.db
      .select({
        userId: memberships.userId,
        firstName: users.firstName,
        lastName: users.lastName,
        driverId: memberships.driverId,
        roleCode: roles.code,
        permission: rolePermissions.permissionCode,
        companyTimezone: companies.timezone,
        companyWeekStart: companies.weekStart,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .innerJoin(companies, eq(companies.id, memberships.companyId))
      .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .leftJoin(roles, and(eq(membershipRoles.roleId, roles.id), eq(roles.status, 'active')))
      .leftJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(and(eq(memberships.id, membershipId), eq(memberships.companyId, companyId), eq(memberships.status, 'active')));
    const first = rows[0];
    if (!first) return null;
    const granted = new Set(rows.map((r) => r.permission).filter((p): p is string => p !== null));
    return {
      userId: first.userId,
      userName: `${first.firstName} ${first.lastName}`.trim(),
      companyId,
      companyTimezone: first.companyTimezone,
      weekStart: weekStartIndex(first.companyWeekStart),
      membershipId,
      roles: [...new Set(rows.map((r) => r.roleCode).filter((c): c is string => c !== null))],
      permissions: first.driverId ? new Set([...granted].filter((p) => DRIVER_MEMBERSHIP_PERMISSIONS.includes(p))) : granted,
    };
  }
}
