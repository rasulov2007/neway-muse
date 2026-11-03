import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AppError } from '../errors/app-error';
import { isFeatureEnabled, type ServerFeatureFlag } from './flags';
import { REQUIRED_FLAGS_KEY } from './require-flag.decorator';

/**
 * Refuses a route whose feature flag is off.
 *
 * 404 rather than 403: a route behind a flag that is off does not exist on this server yet, and
 * answering "forbidden" would tell an unauthenticated scanner that it exists somewhere. The detail
 * names the flag, because the person most likely to meet this is an operator wondering why a
 * deploy has no Today board.
 */
@Injectable()
export class FeatureFlagGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const required = this.reflector.getAllAndMerge<ServerFeatureFlag[]>(REQUIRED_FLAGS_KEY, [
      context.getClass(),
      context.getHandler(),
    ]);
    if (required.length === 0) return true;
    const off = required.filter((flag) => !isFeatureEnabled(flag));
    if (off.length > 0) {
      throw new AppError({
        status: 404,
        title: 'Not found',
        detail: `This endpoint is behind a feature flag that is off on this server: ${off.join(', ')}.`,
      });
    }
    return true;
  }
}
