import 'reflect-metadata';
import { Logger } from 'nestjs-pino';
import { API_PREFIX } from '@neway/shared';
import { createApp } from './app.factory';
import { AdminSeedService } from './database/admin-seed.service';
import { ComplianceSeedService } from './database/compliance-seed.service';
import { HiringService } from './modules/hiring/hiring.service';
import { HiringSeedService } from './database/hiring-seed.service';
import { CostLedgerService } from './modules/hiring/cost-ledger.service';
import { ROSTER_SEED } from './database/seed/roster.seed';
import { PeopleSeedService } from './database/people-seed.service';
import { RosterSeedService } from './database/roster-seed.service';
import { env } from './config/env';
import { APP_VERSION } from './config/version';

async function bootstrap(): Promise<void> {
  const app = await createApp();

  // Schema first. The migrations are additive and safe to run on every boot.
  const roster = app.get(RosterSeedService);
  await roster.migrate();
  await roster.ensureCompany();

  /*
   * The demo data, only where it is wanted.
   *
   * Each seed fills its tables when they are empty, which is the right rule for a developer's
   * database and the wrong one for a live workspace that has been emptied on purpose: there, an
   * empty table means "nothing has been entered yet", not "put the demo fleet back". So the seeds
   * run behind one switch (off in production unless set), and the rest of the boot — the schema,
   * the company row, the permission registry, the onboarding templates, the idempotent backfills —
   * runs regardless, because none of it invents records.
   */
  if (env.SEED_DEMO_DATA) {
    await roster.seed();
    // Employees are built from the people the roster already holds, so this runs after it.
    await app.get(PeopleSeedService).seed();
  }
  // The control plane: permissions and system roles are synced from the code registry on every
  // boot; departments and accounts are derived from the workforce, when there is one.
  await app.get(AdminSeedService).seed();
  if (env.SEED_DEMO_DATA) {
    // The qualification file, from the fleet the roster import established; then a hiring case for
    // every verification case it opened. Both are once-only.
    await app.get(ComplianceSeedService).seed();
  }
  // The DOT application requirement arrived after the file: hired drivers get a backfilled item
  // saying their application is on the paper file. Idempotent, every boot.
  await app.get(ComplianceSeedService).backfillDotApplicationItems();
  await app.get(HiringService).backfillFromVerification(ROSTER_SEED.company.id);
  const hiring = app.get(HiringSeedService);
  if (env.SEED_DEMO_DATA) {
    await hiring.seed();
    await hiring.seedDotApplications();
    await hiring.seedPipeline();
    await hiring.seedCampaigns();
  }
  // The onboarding templates are configuration, not demo data: adding a driver opens a plan from
  // one, so a workspace with nothing else in it still needs them.
  await hiring.seedOnboardingTemplates();
  // Prices what happened before the ledger existed; idempotent by source record.
  await app.get(CostLedgerService).backfill(ROSTER_SEED.company.id);

  // 0.0.0.0 so the API is reachable from outside its container in production;
  // Fastify's default of 127.0.0.1 would make a Docker deploy silently dead.
  await app.listen(env.PORT, '0.0.0.0');

  const logger = app.get(Logger);
  logger.log(
    `NEWAY TMS API v${APP_VERSION} listening on ${await app.getUrl()}/${API_PREFIX} (${env.NODE_ENV}, demo seeds ${env.SEED_DEMO_DATA ? 'on' : 'off'})`,
  );
}

bootstrap().catch((error: unknown) => {
  console.error('Failed to start the API', error);
  process.exit(1);
});
