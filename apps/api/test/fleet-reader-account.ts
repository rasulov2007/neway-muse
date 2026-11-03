import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';

/**
 * A real account holding only the given permissions, for asserting what a non-Safety role may read.
 * Returns the membership id to send as `x-account`.
 */
export async function accountWithPermissions(
  app: NestFastifyApplication,
  permissions: string[],
  tag: string,
): Promise<string> {
  const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
  const json = { 'content-type': 'application/json' };
  const role = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/roles',
    headers: json,
    payload: { name: `${tag} ${stamp}`, permissions },
  });
  if (role.statusCode !== 201) throw new Error(role.body);
  const email = `${tag.replace(/\W+/g, '.').toLowerCase()}.${stamp}@test.local`;
  const created = await app.inject({
    method: 'POST',
    url: '/api/v1/admin/users',
    headers: json,
    payload: {
      firstName: 'Fleet',
      lastName: 'Reader',
      email,
      phone: null,
      employeeId: null,
      roleIds: [(role.json() as { id: string }).id],
      invite: false,
    },
  });
  if (created.statusCode !== 201) throw new Error(created.body);
  const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
  const activated = await app.inject({
    method: 'PATCH',
    url: `/api/v1/admin/users/${membershipId}/status`,
    headers: json,
    payload: { status: 'active', reason: 'fleet reader e2e' },
  });
  if (activated.statusCode !== 200) throw new Error(activated.body);
  await app.get(DatabaseService).db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
  // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
  await app.get(DatabaseService).db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
  return membershipId;
}
