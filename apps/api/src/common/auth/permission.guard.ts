import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import { hasPermission } from './principal';
import { getPrincipal } from './request-context';
import { REQUIRED_ANY_PERMISSION_KEY, REQUIRED_PERMISSIONS_KEY } from './require-permission.decorator';

/** Rejects with 403 (problem+json) unless the principal holds every `@RequirePermission`. */
@Injectable()
export class PermissionGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<string[]>(REQUIRED_PERMISSIONS_KEY, [
      context.getClass(),
      context.getHandler(),
    ]);
    const anyOf = this.reflector.getAllAndMerge<string[]>(REQUIRED_ANY_PERMISSION_KEY, [
      context.getClass(),
      context.getHandler(),
    ]);
    if (required.length === 0 && anyOf.length === 0) return true;
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = getPrincipal(request);
    if (principal === undefined) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'No principal.' });
    }
    const missing = required.filter((permission) => !hasPermission(principal, permission));
    if (missing.length > 0) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: `Missing permission: ${missing.join(', ')}`,
      });
    }
    if (anyOf.length > 0 && !anyOf.some((permission) => hasPermission(principal, permission))) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: `Needs one of: ${anyOf.join(', ')}`,
      });
    }
    return true;
  }
}
