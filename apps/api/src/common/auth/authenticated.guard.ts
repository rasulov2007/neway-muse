import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { getPrincipal } from './request-context';
import {
  BEFORE_PROFILE_ROUTE_KEY,
  PUBLIC_ROUTE_KEY,
  TEMPORARY_PASSWORD_ROUTE_KEY,
} from './public.decorator';

/**
 * You are signed in, or you are nowhere.
 *
 * Registered globally, so a route is protected by existing rather than by remembering to decorate
 * it. That matters: before this guard, two controllers (`hr`, `people/employees`) carried no
 * permission decorator at all and were readable by anyone who could reach the port, and the
 * request principal was fabricated for callers who presented no credential.
 *
 * The guard checks two things, in order:
 *
 *   1. a live session proved who this is (`signedIn`), and
 *   2. the credential behind it is not a temporary one that still has to be replaced.
 *
 * The second check is what makes a temporary password temporary. Without it, "must change
 * password" is a screen the client could skip.
 */
@Injectable()
export class AuthenticatedGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(PUBLIC_ROUTE_KEY, targets)) return true;

    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = getPrincipal(request);
    if (principal === undefined || principal.signedIn !== true) {
      throw new AppError({
        status: 401,
        title: 'Unauthorized',
        detail: 'Sign in to continue.',
      });
    }

    if (principal.mustChangePassword === true) {
      const allowed = this.reflector.getAllAndOverride<boolean>(
        TEMPORARY_PASSWORD_ROUTE_KEY,
        targets,
      );
      if (!allowed) {
        throw new AppError({
          status: 403,
          title: 'Forbidden',
          detail: 'Your temporary password must be changed before continuing.',
        });
      }
    }

    // Complete your profile (owner, 2026-10-26): a server-side gate, not just a redirect.
    if (principal.profileRequired === true) {
      const allowed =
        this.reflector.getAllAndOverride<boolean>(BEFORE_PROFILE_ROUTE_KEY, targets) ||
        this.reflector.getAllAndOverride<boolean>(TEMPORARY_PASSWORD_ROUTE_KEY, targets);
      if (!allowed) {
        throw new AppError({
          status: 403,
          title: 'Forbidden',
          detail: 'Complete your profile before continuing.',
          extensions: { code: 'profile_required' },
        });
      }
    }
    return true;
  }
}
