import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AuthenticatedGuard } from './authenticated.guard';
import type { Principal } from './principal';
import { BEFORE_PROFILE_ROUTE_KEY, PUBLIC_ROUTE_KEY, TEMPORARY_PASSWORD_ROUTE_KEY } from './public.decorator';
import { setPrincipal, type RequestLike } from './request-context';

/**
 * The API fails closed.
 *
 * Asserted here rather than end to end because the e2e suite deliberately runs with
 * `AUTH_DEV_HEADERS=true` to prove RBAC by impersonation — with that flag on, a request carrying
 * no credential is *given* the owner, so closed-ness cannot be observed through HTTP there. The
 * guard is the thing that actually decides, so the guard is what is tested.
 */

/** A context whose metadata lookups answer from `meta`, over a bare request object. */
function contextFor(
  request: RequestLike,
  meta: { public?: boolean; temporaryAllowed?: boolean; beforeProfile?: boolean } = {},
): { guard: AuthenticatedGuard; context: ExecutionContext } {
  const reflector = new Reflector();
  reflector.getAllAndOverride = ((key: string) => {
    if (key === PUBLIC_ROUTE_KEY) return meta.public ?? false;
    if (key === TEMPORARY_PASSWORD_ROUTE_KEY) return meta.temporaryAllowed ?? false;
    if (key === BEFORE_PROFILE_ROUTE_KEY) return meta.beforeProfile ?? false;
    return false;
  }) as unknown as Reflector['getAllAndOverride'];

  const context = {
    getHandler: () => () => undefined,
    getClass: () => class {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;

  return { guard: new AuthenticatedGuard(reflector), context };
}

/** A stand-in for the raw Node request the principal store keys on. */
function request(): RequestLike {
  return { raw: {} } as unknown as RequestLike;
}

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    userId: 'usr_1',
    companyId: 'co_1',
    companyTimezone: 'America/Chicago',
    weekStart: 1,
    roles: [],
    permissions: new Set<string>(),
    ...overrides,
  };
}

describe('AuthenticatedGuard', () => {
  it('refuses a request that carries no principal at all', () => {
    const { guard, context } = contextFor(request());
    expect(() => guard.canActivate(context)).toThrowError(/Sign in to continue/);
  });

  it('refuses a principal that was not proven by a session', () => {
    const req = request();
    setPrincipal(req, principal({ signedIn: false }));
    const { guard, context } = contextFor(req);
    expect(() => guard.canActivate(context)).toThrowError(/Sign in to continue/);
  });

  it('admits a signed-in principal', () => {
    const req = request();
    setPrincipal(req, principal({ signedIn: true }));
    const { guard, context } = contextFor(req);
    expect(guard.canActivate(context)).toBe(true);
  });

  it('lets a public route through with nobody behind it', () => {
    const { guard, context } = contextFor(request(), { public: true });
    expect(guard.canActivate(context)).toBe(true);
  });

  it('holds a temporary credential to the route that replaces it', () => {
    const req = request();
    setPrincipal(req, principal({ signedIn: true, mustChangePassword: true }));

    const blocked = contextFor(req);
    expect(() => blocked.guard.canActivate(blocked.context)).toThrowError(/temporary password/);

    const allowed = contextFor(req, { temporaryAllowed: true });
    expect(allowed.guard.canActivate(allowed.context)).toBe(true);
  });

  it('holds a person with no profile yet to the routes marked before-profile (owner, 2026-10-26)', () => {
    const req = request();
    setPrincipal(req, principal({ signedIn: true, profileRequired: true }));

    const blocked = contextFor(req);
    expect(() => blocked.guard.canActivate(blocked.context)).toThrowError(/Complete your profile/);

    expect(contextFor(req, { beforeProfile: true }).guard.canActivate(contextFor(req, { beforeProfile: true }).context)).toBe(true);
    // Changing a temporary password is open too.
    const temp = contextFor(req, { temporaryAllowed: true });
    expect(temp.guard.canActivate(temp.context)).toBe(true);
  });
});
