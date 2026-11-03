import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { companies } from '../src/database/schema/roster';
import { UsersService } from '../src/modules/admin/users.service';
import { AuthService } from '../src/modules/auth/auth.service';

/**
 * One login across companies (owner, 2026-10-13: Hyle could not be added to Harbor Line because her
 * email already signed in to the first company). The second company adds the same person; they
 * keep one email and password and switch company in the top bar.
 */
describe('One person in two companies (e2e)', () => {
  let app: NestFastifyApplication;
  const tag = Date.now().toString(36);
  const first = `co_e2e_mc_a_${tag}`;
  const second = `co_e2e_mc_b_${tag}`;
  const email = `mc.${tag}@example.test`;
  const admin = (companyId: string): Principal => ({ userId: `u_e2e_mc_${companyId}`, userName: 'E2E', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: ['administrator'], permissions: new Set(['users.manage', 'users.view']) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.get(DatabaseService).db.insert(companies).values([
      { id: first, name: `E2E Alpha ${tag}` },
      { id: second, name: `E2E Bravo ${tag}` },
    ] as Array<typeof companies.$inferInsert>);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('adds an existing login to a second company, signs in, and switches', async () => {
    const usersSvc = app.get(UsersService);
    const created = await usersSvc.create(admin(first), { firstName: 'Hyle', lastName: 'Test', email, phone: null, employeeId: null, roleIds: [], invite: false });
    expect(created.temporaryPassword).toBeTruthy();
    const added = await usersSvc.create(admin(second), { firstName: 'Hyle', lastName: 'Test', email: email.toUpperCase(), phone: null, employeeId: null, roleIds: [], invite: false });
    expect(added).toMatchObject({ temporaryPassword: null, addedExisting: true });
    expect(added.account.userId).toBe(created.account.userId);
    await expect(usersSvc.create(admin(second), { firstName: 'Hyle', lastName: 'Test', email, phone: null, employeeId: null, roleIds: [], invite: false })).rejects.toMatchObject({ status: 409 });

    const auth = app.get(AuthService);
    const login = await auth.login({ email, password: created.temporaryPassword as string }, {});
    expect(login.account.companies?.map((c) => c.companyId).sort()).toEqual([first, second].sort());
    const other = login.account.companyId === first ? second : first;
    const switched = await auth.switchCompany(login.token, login.account.userId, other, {});
    expect(switched.account.companyId).toBe(other);
    expect(switched.account.companyName).toMatch(/E2E (Alpha|Bravo)/);
    // The old session ends; the next sign-in starts where they were last.
    expect(await auth.resolveSession(login.token)).toBeNull();
    const again = await auth.login({ email, password: created.temporaryPassword as string }, {});
    expect(again.account.companyId).toBe(other);
    await expect(auth.switchCompany(again.token, again.account.userId, 'co_not_mine', {})).rejects.toMatchObject({ status: 404 });
  });
});
