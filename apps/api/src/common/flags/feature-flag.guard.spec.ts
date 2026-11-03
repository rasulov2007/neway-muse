import { Reflector } from '@nestjs/core';
import type { ExecutionContext } from '@nestjs/common';
import { afterEach, describe, expect, it } from 'vitest';
import { AppError } from '../errors/app-error';
import { FeatureFlagGuard } from './feature-flag.guard';
import { isFeatureEnabled, setFeatureFlagForTests } from './flags';
import { REQUIRED_FLAGS_KEY } from './require-flag.decorator';
import { WorkOrdersController } from '../../modules/fleet/work-orders.controller';

afterEach(() => setFeatureFlagForTests('fleet_v2', null));

/** A context that reports the flags a class declares, the way Nest's reflector reads them. */
function contextFor(target: object, handler: () => void = () => {}): ExecutionContext {
  return {
    getClass: () => target as never,
    getHandler: () => handler as never,
    switchToHttp: () => ({ getRequest: () => ({}) }),
  } as unknown as ExecutionContext;
}

describe('FeatureFlagGuard', () => {
  const guard = new FeatureFlagGuard(new Reflector());

  it('lets a route with no flag through', () => {
    class Plain {}
    expect(guard.canActivate(contextFor(Plain))).toBe(true);
  });

  it('refuses a flagged route when the flag is off, with a 404 that names the flag', () => {
    class Flagged {}
    Reflect.defineMetadata(REQUIRED_FLAGS_KEY, ['fleet_v2'], Flagged);
    setFeatureFlagForTests('fleet_v2', false);

    try {
      guard.canActivate(contextFor(Flagged));
      throw new Error('the guard let a disabled feature through');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect((error as AppError).status).toBe(404);
      expect((error as AppError).detail).toContain('fleet_v2');
    }
  });

  it('lets the same route through when the flag is on', () => {
    class Flagged {}
    Reflect.defineMetadata(REQUIRED_FLAGS_KEY, ['fleet_v2'], Flagged);
    setFeatureFlagForTests('fleet_v2', true);
    expect(guard.canActivate(contextFor(Flagged))).toBe(true);
  });
});

describe('the shop floor endpoints', () => {
  const guard = new FeatureFlagGuard(new Reflector());

  /*
   * The wiring, not a copy of it.
   *
   * This reads the metadata off the real controller class, so removing `@RequireFlag` from it —
   * or adding a second fleet controller and forgetting the decorator — fails here rather than in
   * production, where the first sign would be a mechanic's board appearing unannounced.
   */
  it('are declared behind fleet_v2', () => {
    const declared = Reflect.getMetadata(REQUIRED_FLAGS_KEY, WorkOrdersController) as
      | string[]
      | undefined;
    expect(declared).toEqual(['fleet_v2']);
  });

  it('are unreachable with the flag off: GET /fleet/today, /fleet/units and every work order', () => {
    setFeatureFlagForTests('fleet_v2', false);
    const routes = [
      WorkOrdersController.prototype.today,
      WorkOrdersController.prototype.units,
      WorkOrdersController.prototype.list,
      WorkOrdersController.prototype.detail,
      WorkOrdersController.prototype.create,
      WorkOrdersController.prototype.update,
      WorkOrdersController.prototype.changeStage,
      WorkOrdersController.prototype.complete,
      WorkOrdersController.prototype.reopen,
    ];
    for (const route of routes) {
      expect(() => guard.canActivate(contextFor(WorkOrdersController, route as unknown as () => void))).toThrow(
        AppError,
      );
    }
  });

  it('answer once the flag is on', () => {
    setFeatureFlagForTests('fleet_v2', true);
    expect(
      guard.canActivate(
        contextFor(WorkOrdersController, WorkOrdersController.prototype.today as unknown as () => void),
      ),
    ).toBe(true);
  });
});

describe('the flag itself', () => {
  it('is off in production unless somebody turns it on', () => {
    // The env loader's rule, stated where it can be read: unset means on outside production and
    // off in it, which is the same shape the demo seeds use.
    expect(isFeatureEnabled('fleet_v2')).toBe(process.env.NODE_ENV !== 'production');
  });
});
