import { createParamDecorator, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';
import type { Principal } from './principal';
import { getPrincipal } from './request-context';

/** Injects the request principal into a handler parameter; 401 when none was attached. */
export const CurrentPrincipal = createParamDecorator(
  (_data: unknown, context: ExecutionContext): Principal => {
    const principal = getPrincipal(context.switchToHttp().getRequest<FastifyRequest>());
    if (principal === undefined) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'No principal.' });
    }
    return principal;
  },
);
