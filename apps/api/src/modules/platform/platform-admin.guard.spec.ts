import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { PlatformAdminGuard } from './platform-admin.guard';
import type { DatabaseService } from '../../database/database.service';
import type { Principal } from '../../common/auth/principal';
import { setPrincipal } from '../../common/auth/request-context';

/** A database whose users lookup answers `row`. */
function database(row: { isPlatformAdmin: boolean; isActive: boolean } | undefined): DatabaseService {
  const chain = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: async () => (row ? [row] : []),
  };
  return { db: chain } as unknown as DatabaseService;
}

function context(principal: Partial<Principal> | undefined): ExecutionContext {
  const request = { raw: {} } as unknown as { raw: import('node:http').IncomingMessage };
  if (principal) setPrincipal(request, principal as Principal);
  return { switchToHttp: () => ({ getRequest: () => request }) } as unknown as ExecutionContext;
}

const owner: Partial<Principal> = { userId: 'usr_1', companyId: 'co_a', signedIn: true, permissions: new Set() };

describe('PlatformAdminGuard', () => {
  it('lets a platform administrator through', async () => {
    const guard = new PlatformAdminGuard(database({ isPlatformAdmin: true, isActive: true }));
    await expect(guard.canActivate(context(owner))).resolves.toBe(true);
  });

  it('refuses a company owner who is not a platform administrator (403)', async () => {
    const guard = new PlatformAdminGuard(database({ isPlatformAdmin: false, isActive: true }));
    await expect(guard.canActivate(context(owner))).rejects.toMatchObject({ status: 403 });
  });

  it('refuses a deactivated platform administrator', async () => {
    const guard = new PlatformAdminGuard(database({ isPlatformAdmin: true, isActive: false }));
    await expect(guard.canActivate(context(owner))).rejects.toMatchObject({ status: 403 });
  });

  it('refuses anyone not signed in (401)', async () => {
    const guard = new PlatformAdminGuard(database({ isPlatformAdmin: true, isActive: true }));
    await expect(guard.canActivate(context({ ...owner, signedIn: false }))).rejects.toMatchObject({ status: 401 });
  });
});
