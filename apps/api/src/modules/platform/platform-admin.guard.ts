import { type CanActivate, type ExecutionContext, Injectable } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { AppError } from '../../common/errors/app-error';
import { getPrincipal } from '../../common/auth/request-context';
import { DatabaseService } from '../../database/database.service';
import { users } from '../../database/schema/admin';

/**
 * Only a platform administrator ("grand admin") passes.
 *
 * Read from the user row on every request rather than carried in the session, so taking the mark
 * away takes effect on the next click. Being a company owner or holding every permission is not
 * enough: those are access to one company, and this is access across them.
 */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(private readonly database: DatabaseService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<FastifyRequest>();
    const principal = getPrincipal(request);
    if (principal === undefined || principal.signedIn !== true) {
      throw new AppError({ status: 401, title: 'Unauthorized', detail: 'Sign in to continue.' });
    }
    const [row] = await this.database.db
      .select({ isPlatformAdmin: users.isPlatformAdmin, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, principal.userId))
      .limit(1);
    if (!row?.isPlatformAdmin || !row.isActive) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Only a platform administrator can manage companies.',
      });
    }
    return true;
  }
}
