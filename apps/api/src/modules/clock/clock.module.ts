import { Global, Module } from '@nestjs/common';
import { env } from '../../config/env';
import { CLOCK, demoClock, systemClock, type Clock } from '../dashboard/clock';

/**
 * The clock for an environment: the pinned demo clock only while the demo seeds are on, the wall
 * clock everywhere else. Production runs with `SEED_DEMO_DATA=false`, so "today", "this week" and
 * "last month" are the real ones there (2026-10-25: the global clock was the demo clock in
 * production, which froze Analytics, Reports and the hiring/compliance "now" on 6 Sep 2026).
 */
export function clockFor(seedDemoData: boolean): Clock {
  return seedDemoData ? demoClock : systemClock;
}

/**
 * One clock for the whole application.
 *
 * The dashboard, reports and analytics must resolve "this month" to the same range or their totals
 * will differ for a reason nobody can see. They diverged exactly once — the dashboard read the
 * pinned demo clock while reports read the wall clock, and the same preset produced a five-day
 * difference in gross revenue. Global, so a module cannot quietly acquire its own.
 */
@Global()
@Module({
  providers: [{ provide: CLOCK, useFactory: () => clockFor(env.SEED_DEMO_DATA) }],
  exports: [CLOCK],
})
export class ClockModule {}
