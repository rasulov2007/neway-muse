import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { and, eq, inArray, isNotNull } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { integrationAccounts } from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { SamsaraSyncService } from './connectors/samsara-sync.service';
import { RelaySyncService } from './connectors/relay-sync.service';
import { MotiveSyncService } from './connectors/motive-sync.service';
import { FiveEldSyncService } from './connectors/fiveeld-sync.service';

/**
 * The clock behind "sync active".
 *
 * Every `INTEGRATION_SYNC_INTERVAL_MINUTES` (an hour by default; 0 turns it off), every Samsara,
 * Motive, Five ELD and Relay account that holds a credential and is not disabled is synced, one after another, as the
 * system. A run that fails records its failure on the account and moves on to the next account;
 * a tick that arrives while the previous one is still working is skipped rather than stacked.
 *
 * Never with `createMissing`: an unattended run updates the trucks the roster already has and
 * lists the rest. Inventing trucks is a decision a person makes, on the screen, per run.
 */
@Injectable()
export class IntegrationSyncScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private first: NodeJS.Timeout | null = null;
  private positionsTimer: NodeJS.Timeout | null = null;
  private running = false;
  private positioning = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly samsara: SamsaraSyncService,
    private readonly relay: RelaySyncService,
    private readonly motive: MotiveSyncService,
    private readonly fiveEld: FiveEldSyncService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(IntegrationSyncScheduler.name);
  }

  onModuleInit(): void {
    const minutes = env.INTEGRATION_SYNC_INTERVAL_MINUTES;
    if (minutes <= 0) {
      this.logger.info('Integration auto-sync is off (INTEGRATION_SYNC_INTERVAL_MINUTES=0)');
      return;
    }
    this.timer = setInterval(() => void this.tick(), minutes * 60_000);
    // Node keeps a process alive for a timer; the API is alive anyway, and a test should not be.
    this.timer.unref();
    // A restart (every deploy) must not push the next sync an interval away: one shortly after boot.
    if (env.NODE_ENV === 'production') {
      this.first = setTimeout(() => void this.tick(), 30_000);
      this.first.unref();
    }
    this.logger.info(`Integration auto-sync every ${minutes} minutes`);
    const positions = env.SAMSARA_POSITIONS_INTERVAL_MINUTES;
    if (positions > 0) {
      this.positionsTimer = setInterval(() => void this.refreshPositions(), positions * 60_000);
      this.positionsTimer.unref();
      this.logger.info(`Samsara live positions every ${positions} minutes`);
    }
  }

  /** Positions only, for every Samsara, Motive and Five ELD account: the live map between full syncs. Never audits. */
  async refreshPositions(): Promise<number> {
    if (this.positioning || this.running) return 0;
    this.positioning = true;
    let moved = 0;
    try {
      const accounts = await this.syncableAccounts(['samsara', 'motive', 'fiveeld']);
      for (const account of accounts) {
        const principal: Principal = {
          userId: 'system',
          userName: account.provider === 'motive' ? 'Motive positions' : account.provider === 'fiveeld' ? 'Five ELD positions' : 'Samsara positions',
          companyId: account.companyId,
          companyTimezone: account.timezone,
          weekStart: weekStartIndex(account.weekStart),
          roles: [],
          permissions: new Set<string>(),
        };
        try {
          moved +=
            account.provider === 'motive'
              ? await this.motive.refreshPositions(principal, account.id)
              : account.provider === 'fiveeld'
                ? await this.fiveEld.refreshPositions(principal, account.id)
                : await this.samsara.refreshPositions(principal, account.id);
        } catch (error) {
          this.logger.warn({ account: account.name, detail: error instanceof AppError ? error.detail : String(error) }, 'ELD positions refresh failed');
        }
      }
    } finally {
      this.positioning = false;
    }
    return moved;
  }

  /**
   * The accounts an unattended run may touch: a stored credential and a live status. Archived,
   * disabled and never-configured accounts are left alone. Public so a test can check it without
   * reaching a provider.
   */
  async syncableAccounts(providers: string[]) {
    return this.database.db
      .select({
        id: integrationAccounts.id,
        name: integrationAccounts.name,
        provider: integrationAccounts.provider,
        companyId: integrationAccounts.companyId,
        timezone: companies.timezone,
        weekStart: companies.weekStart,
      })
      .from(integrationAccounts)
      .innerJoin(companies, eq(companies.id, integrationAccounts.companyId))
      .where(
        and(
          inArray(integrationAccounts.provider, providers),
          isNotNull(integrationAccounts.credentials),
          inArray(integrationAccounts.status, ['credentials_stored', 'connected', 'error']),
        ),
      );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.first) clearTimeout(this.first);
    if (this.positionsTimer) clearInterval(this.positionsTimer);
  }

  /** One pass over every syncable account. Public so a test, or an operator, can call it directly. */
  async tick(): Promise<{ synced: number; failed: number }> {
    if (this.running) return { synced: 0, failed: 0 };
    this.running = true;
    let synced = 0;
    let failed = 0;
    try {
      const accounts = await this.syncableAccounts(['samsara', 'motive', 'fiveeld', 'relay']);

      for (const account of accounts) {
        const principal: Principal = {
          userId: 'system',
          userName: account.provider === 'relay' ? 'Relay sync' : account.provider === 'motive' ? 'Motive sync' : account.provider === 'fiveeld' ? 'Five ELD sync' : 'Samsara sync',
          companyId: account.companyId,
          companyTimezone: account.timezone,
          weekStart: weekStartIndex(account.weekStart),
          roles: [],
          permissions: new Set<string>(),
        };
        try {
          // Relay reads a window of fill-ups into the fuel ledger; it never creates anything else.
          const report =
            account.provider === 'relay'
              ? await this.relay.sync(principal, account.id, { dryRun: false, createMissing: false })
              : account.provider === 'motive'
                ? await this.motive.sync(principal, account.id, { dryRun: false, createMissing: false })
                : account.provider === 'fiveeld'
                  ? await this.fiveEld.sync(principal, account.id, { dryRun: false, createMissing: false })
                  : await this.samsara.sync(principal, account.id, { dryRun: false, createMissing: false });
          synced += 1;
          this.logger.info(
            { account: account.name, provider: account.provider, summary: report.summary },
            'Integration sync finished',
          );
        } catch (error) {
          failed += 1;
          this.logger.warn(
            { account: account.name, provider: account.provider, detail: error instanceof AppError ? error.detail : String(error) },
            'Integration sync failed',
          );
        }
      }
    } finally {
      this.running = false;
    }
    return { synced, failed };
  }
}

const WEEK_START: Record<string, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

function weekStartIndex(weekStart: string): number {
  return WEEK_START[weekStart] ?? 1;
}
