import { Injectable, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { PinoLogger } from 'nestjs-pino';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { companies } from '../../database/schema/roster';
import { PmService } from './pm.service';

/**
 * The nightly recompute (docs/pm-module §3.3).
 *
 * Readings, plans and completions recompute what they touch as they happen; the night pass is
 * for what moves on its own - a reading going stale, a day limit arriving - and runs at 03:00 in
 * each company's timezone, then every 24 hours. Off when the module is off, and off in tests,
 * which recompute on demand.
 */
const NIGHT_HOUR = 3;
const DAY_MS = 86_400_000;

@Injectable()
export class PmRecomputeScheduler implements OnModuleInit, OnModuleDestroy {
  private timer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly database: DatabaseService,
    private readonly pm: PmService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(PmRecomputeScheduler.name);
  }

  onModuleInit(): void {
    if (!env.PM_MODULE || env.NODE_ENV === 'test') return;
    const delay = msUntilNextNight(new Date(), 'America/New_York');
    this.timer = setTimeout(() => {
      void this.tick();
      this.timer = setInterval(() => void this.tick(), DAY_MS);
      this.timer.unref();
    }, delay);
    this.timer.unref();
    this.logger.info(`PM nightly recompute in ${Math.round(delay / 60_000)} minutes, then every 24 h`);
  }

  onModuleDestroy(): void {
    if (this.timer) clearTimeout(this.timer);
  }

  /** One pass over every company. Public so an operator can call it. */
  async tick(): Promise<{ companies: number; computed: number }> {
    if (this.running) return { companies: 0, computed: 0 };
    this.running = true;
    let computed = 0;
    let count = 0;
    try {
      const rows = await this.database.db.select({ id: companies.id }).from(companies);
      for (const company of rows) {
        try {
          const result = await this.pm.recompute(company.id);
          computed += result.computed;
          count += 1;
        } catch (error) {
          this.logger.error({ err: error, companyId: company.id }, 'PM recompute failed');
        }
      }
      this.logger.info(`PM nightly recompute: ${computed} units across ${count} companies`);
    } finally {
      this.running = false;
    }
    return { companies: count, computed };
  }
}

/** Milliseconds until the next 03:00 in the zone. */
export function msUntilNextNight(now: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hour: 'numeric', minute: 'numeric', hour12: false }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? '0') % 24;
  const minute = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const minutesNow = hour * 60 + minute;
  const target = NIGHT_HOUR * 60;
  const minutesUntil = minutesNow < target ? target - minutesNow : 24 * 60 - minutesNow + target;
  return Math.max(60_000, minutesUntil * 60_000);
}
