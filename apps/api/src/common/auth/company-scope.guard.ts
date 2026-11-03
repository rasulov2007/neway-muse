import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { AppError } from '../errors/app-error';

/** Query keys a client might use to pick a company; none is ever honoured (docs/DASHBOARD.md §11). */
export const FORBIDDEN_TENANT_QUERY_KEYS = ['companyid', 'company_id', 'tenant'] as const;

/** Rejects (400) any request that tries to choose its company through the query string. */
@Injectable()
export class CompanyScopeGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const query = request.query;
    if (typeof query === 'object' && query !== null) {
      const forbidden: readonly string[] = FORBIDDEN_TENANT_QUERY_KEYS;
      const offending = Object.keys(query).some((key) => forbidden.includes(key.toLowerCase()));
      if (offending) {
        throw new AppError({
          status: 400,
          title: 'Bad Request',
          detail: 'Company is determined by the authenticated session',
        });
      }
    }
    return true;
  }
}
