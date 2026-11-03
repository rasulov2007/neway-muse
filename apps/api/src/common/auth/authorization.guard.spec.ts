import { Controller, Get, type ExecutionContext } from '@nestjs/common';
import type { DiscoveryService } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AuthorizationGuard } from './authorization.guard';
import type { Principal } from './principal';
import { Public } from './public.decorator';
import { RequireAnyPermission, RequirePermission } from './require-permission.decorator';
import { setPrincipal, type RequestLike } from './request-context';
import { RoutePolicyCheck } from './route-policy.check';
import { listRoutes, resolveRoutePolicy } from './route-policy';
import { SignedInOnly } from './signed-in-only.decorator';

/** Deny by default (owner brief, 2026-10-25): the guard and the boot check, without a database. */

@Controller('probe')
class ProbeController {
  @Get('open')
  @Public()
  open() {}

  @Get('nothing')
  nothing() {}

  @Get('mine')
  @SignedInOnly('own rows only')
  mine() {}

  @Get('all')
  @RequirePermission('a.view', 'b.view')
  all() {}

  @Get('any')
  @RequireAnyPermission('a.view', 'b.view')
  any() {}
}

@Controller('closed')
@RequirePermission('c.view')
class ClassLevelController {
  @Get()
  list() {}

  @Get('also')
  @RequireAnyPermission('d.view', 'e.view')
  also() {}
}

function principal(permissions: string[], signedIn = true): Principal {
  return { userId: 'u', companyId: 'c', companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(permissions), signedIn };
}

function contextFor(handler: (...a: unknown[]) => unknown, cls: object, who?: Principal): ExecutionContext {
  const request = { raw: {} } as unknown as RequestLike;
  if (who) setPrincipal(request, who);
  return {
    getType: () => 'http',
    getHandler: () => handler,
    getClass: () => cls,
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

const guard = new AuthorizationGuard();
const proto = ProbeController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;

describe('AuthorizationGuard', () => {
  it('lets a public route through with nobody behind it', () => {
    expect(guard.canActivate(contextFor(proto.open!, ProbeController))).toBe(true);
  });

  it('closes a route that declares no policy, even for a principal holding everything', () => {
    expect(() => guard.canActivate(contextFor(proto.nothing!, ProbeController, principal(['a.view', 'b.view'])))).toThrowError(/no access policy/);
  });

  it('admits any signed-in member to a reviewed signed-in-only route, and nobody else', () => {
    expect(guard.canActivate(contextFor(proto.mine!, ProbeController, principal([])))).toBe(true);
    expect(() => guard.canActivate(contextFor(proto.mine!, ProbeController, principal([], false)))).toThrowError(/Sign in/);
    expect(() => guard.canActivate(contextFor(proto.mine!, ProbeController))).toThrowError(/Sign in/);
  });

  it('needs every code of RequirePermission and one of RequireAnyPermission', () => {
    expect(() => guard.canActivate(contextFor(proto.all!, ProbeController, principal(['a.view'])))).toThrowError(/Missing permission: b.view/);
    expect(guard.canActivate(contextFor(proto.all!, ProbeController, principal(['a.view', 'b.view'])))).toBe(true);
    expect(guard.canActivate(contextFor(proto.any!, ProbeController, principal(['b.view'])))).toBe(true);
    expect(() => guard.canActivate(contextFor(proto.any!, ProbeController, principal(['z.view'])))).toThrowError(/Needs one of/);
  });

  it('merges a class-level requirement with the method\'s', () => {
    const cls = ClassLevelController.prototype as unknown as Record<string, (...a: unknown[]) => unknown>;
    expect(resolveRoutePolicy(cls.also!, ClassLevelController)).toEqual({ kind: 'permission', all: ['c.view'], any: ['d.view', 'e.view'] });
    expect(() => guard.canActivate(contextFor(cls.also!, ClassLevelController, principal(['d.view'])))).toThrowError(/c.view/);
    expect(guard.canActivate(contextFor(cls.also!, ClassLevelController, principal(['c.view', 'e.view'])))).toBe(true);
  });
});

describe('RoutePolicyCheck (boot)', () => {
  const discovery = (controllers: unknown[]) => ({ getControllers: () => controllers.map((metatype) => ({ metatype })) }) as unknown as DiscoveryService;

  it('refuses to start while a route has no policy, naming it', () => {
    expect(() => new RoutePolicyCheck(discovery([ProbeController])).onApplicationBootstrap()).toThrowError(/GET \/probe\/nothing .*has no access policy/);
  });

  it('starts when every route declares one', () => {
    expect(() => new RoutePolicyCheck(discovery([ClassLevelController])).onApplicationBootstrap()).not.toThrow();
    expect(listRoutes([ClassLevelController]).map((r) => `${r.method} ${r.path}`)).toEqual(['GET /closed', 'GET /closed/also']);
  });
});
