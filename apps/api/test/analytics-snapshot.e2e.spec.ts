import { writeFileSync } from 'node:fs';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AnalyticsService } from '../src/modules/reports/analytics.service';

/**
 * Parity snapshot for the Analytics redesign (dev tool, skipped unless ANALYTICS_SNAPSHOT_OUT is
 * set). Writes every analytics endpoint's output, for every preset and several companies, in both
 * reporting sources, so a before/after pair can be diffed byte for byte.
 */
const OUT = process.env.ANALYTICS_SNAPSHOT_OUT;
const PRESETS = ['today', 'this_week', 'last_week', 'this_month', 'last_month'];
const COMPANIES = ['co_northwind', 'co_test_e2e', 'co_training'];

describe.skipIf(!OUT)('analytics snapshot', () => {
  let app: NestFastifyApplication;
  beforeAll(async () => {
    app = await createApp();
    await app.init();
  });
  afterAll(async () => {
    delete process.env.REPORTING_SOURCE;
    await app.close();
  });

  it('writes the snapshot', async () => {
    const service = app.get(AnalyticsService);
    const out: Record<string, unknown> = {};
    for (const source of ['workspace', 'generated']) {
      if (source === 'generated') process.env.REPORTING_SOURCE = 'generated';
      else delete process.env.REPORTING_SOURCE;
      for (const companyId of COMPANIES) {
        const principal = {
          companyId,
          companyTimezone: 'America/New_York',
          weekStart: 1,
        } as unknown as Principal;
        for (const preset of PRESETS) {
          const key = `${source}/${companyId}/${preset}`;
          out[`${key}/executive`] = await service.executive(principal, preset);
          out[`${key}/cost-drivers`] = await service.costDrivers(principal, preset);
          out[`${key}/trucks`] = await service.truckRanking(principal, preset);
          out[`${key}/drivers`] = await service.driverRanking(principal, preset);
          out[`${key}/operations`] = await service.operations(principal, preset);
          out[`${key}/fuel`] = await service.fuel(principal, preset);
        }
        out[`${source}/${companyId}/workforce`] = await service.workforce(principal);
      }
    }
    writeFileSync(OUT!, JSON.stringify(out, null, 1));
    expect(Object.keys(out).length).toBeGreaterThan(0);
  }, 120_000);
});
