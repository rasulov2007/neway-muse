import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { env, loadEnv } from '../../config/env';
import { CLOCK, demoClock, systemClock, type Clock } from '../dashboard/clock';
import { ClockModule, clockFor } from './clock.module';

/**
 * The global clock (2026-10-25). Production provided the pinned demo clock to every module that
 * did not override it, so Analytics, Reports and the hiring and compliance "now" all read
 * 6 Sep 2026. These pin the rule: the demo clock only with the demo seeds on.
 */
describe('ClockModule', () => {
  it('production configuration (no SEED_DEMO_DATA) resolves to the wall clock', () => {
    const production = loadEnv({
      ...process.env,
      NODE_ENV: 'production',
      SEED_DEMO_DATA: undefined,
      AUTH_DEV_HEADERS: 'false',
    });
    expect(production.SEED_DEMO_DATA).toBe(false);
    expect(clockFor(production.SEED_DEMO_DATA)).toBe(systemClock);
  });

  it('explicit SEED_DEMO_DATA=false in production also resolves to the wall clock', () => {
    const production = loadEnv({
      ...process.env,
      NODE_ENV: 'production',
      SEED_DEMO_DATA: 'false',
      AUTH_DEV_HEADERS: 'false',
    });
    expect(clockFor(production.SEED_DEMO_DATA)).toBe(systemClock);
  });

  it('the demo clock only when the demo seeds are on', () => {
    expect(clockFor(true)).toBe(demoClock);
    expect(clockFor(false)).toBe(systemClock);
  });

  it('the module provides the clock its environment selects (DI)', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [ClockModule] }).compile();
    const clock = moduleRef.get<Clock>(CLOCK);
    expect(clock).toBe(clockFor(env.SEED_DEMO_DATA));
    if (!env.SEED_DEMO_DATA) {
      // The wall clock: within a second of now.
      expect(Math.abs(clock().getTime() - Date.now())).toBeLessThan(1000);
    }
    await moduleRef.close();
  });
});
