import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SIGNED_DOWNLOAD_KEY } from './signed-download';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { getPrincipal } from './request-context';
import { policyAdmits, resolveRoutePolicy } from './route-policy';

/**
 * Deny by default (owner brief, 2026-10-25).
 *
 * Registered globally, after `AuthenticatedGuard`. Every route must declare who may call it:
 * `@Public()`, `@RequirePermission` / `@RequireAnyPermission`, or a reviewed `@SignedInOnly(reason)`.
 * A route that declares nothing is refused with 403 - never open - and `RoutePolicyCheck` refuses
 * to start the API while one exists, so the 403 is a second line rather than the plan.
 *
 * Before this guard the permission decorators only ran on controllers that remembered
 * `@UseGuards(PermissionGuard)`; `/state`, `/employees` and `/hr` did not, so their decorators
 * (where there were any) did nothing.
 */
@Injectable()
export class AuthorizationGuard implements CanActivate {
  constructor(private readonly reflector: Reflector = new Reflector()) {}

  canActivate(context: ExecutionContext): boolean {
    if (context.getType() !== 'http') return true;
    const policy = resolveRoutePolicy(context.getHandler(), context.getClass());
    if (policy.kind === 'public') return true;
    if (policy.kind === 'none') {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'This route has no access policy, so it is closed.',
      });
    }
    const principal = getPrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal === undefined || principal.signedIn !== true) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Sign in to continue.' });
    }
    // Driver and candidate documents open only through a signed link, and a signed link opens
    // nothing else (owner, 2026-10-25).
    const signedOnly = this.reflector.getAllAndOverride<boolean>(SIGNED_DOWNLOAD_KEY, [context.getHandler(), context.getClass()]) === true;
    if (principal.viaSignedLink === true && !signedOnly) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'A document link opens that document only.' });
    }
    if (signedOnly && principal.viaSignedLink !== true) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        type: '/problems/signed-link-required',
        detail: 'This document opens through a signed link: ask GET /files/sign?path=… for one.',
      });
    }
    if (policyAdmits(policy, principal.permissions)) return true;
    const missing = policy.all.filter((code) => !principal.permissions.has(code));
    throw new AppError({
      status: 403,
      title: 'Forbidden',
      detail:
        missing.length > 0
          ? `Missing permission: ${missing.join(', ')}`
          : `Needs one of: ${policy.any.join(', ')}`,
    });
  }
}
