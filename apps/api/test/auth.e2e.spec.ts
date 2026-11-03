import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { RosterSeedService } from '../src/database/roster-seed.service';

/**
 * Signing in, end to end.
 *
 * The suite creates its own account and walks the whole handover: the temporary password the
 * administrator is shown once, the sign-in it allows, the lockout that keeps that credential from
 * being used for anything else, the replacement, and the normal access that follows. It also
 * proves the parts that matter more than the happy path — a wrong password is refused in the same
 * words as an unknown address, the bearer token decides what the request may do, and signing out
 * kills the token.
 *
 * Nothing seeded is touched, and the account it creates is left disabled rather than deleted.
 */
describe('Authentication API (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const email = `auth.test.${stamp}@example.com`;
  const chosenPassword = `Chosen-password-${stamp}`;
  let membershipId = '';
  let temporaryPassword = '';
  // A second account, so the session-survival test does not spend the shared credential.
  const email2 = `auth.test.keep.${stamp}@example.com`;
  let membership2 = '';
  let temporary2 = '';

  beforeAll(async () => {
    app = await createApp();
    // The sessions table arrives in a migration; the suite must not assume a migrated database.
    await app.get(RosterSeedService).migrate();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();

    // Every account needs a role: one with none can sign in and is refused by every screen.
    const rolesResponse = await app.inject({ method: 'GET', url: '/api/v1/admin/roles' });
    const roleId = (rolesResponse.json() as { id: string }[])[0]?.id ?? '';

    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: {
        firstName: 'Auth',
        lastName: `Test ${stamp}`,
        email,
        phone: null,
        employeeId: null,
        roleIds: [roleId],
        invite: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      account: { membershipId: string; hasPassword: boolean };
      temporaryPassword: string;
    };
    membershipId = body.account.membershipId;
    temporaryPassword = body.temporaryPassword;

    const second = await app.inject({
      method: 'POST',
      url: '/api/v1/admin/users',
      payload: {
        firstName: 'Auth',
        lastName: `Keep ${stamp}`,
        email: email2,
        phone: null,
        employeeId: null,
        roleIds: [roleId],
        invite: false,
      },
    });
    expect(second.statusCode).toBe(201);
    const secondBody = second.json() as {
      account: { membershipId: string };
      temporaryPassword: string;
    };
    membership2 = secondBody.account.membershipId;
    temporary2 = secondBody.temporaryPassword;
  });

  afterAll(async () => {
    if (membership2) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${membership2}/status`,
        payload: { status: 'disabled', reason: 'auth e2e cleanup' },
      });
    }
    if (membershipId) {
      await app.inject({
        method: 'PATCH',
        url: `/api/v1/admin/users/${membershipId}/status`,
        payload: { status: 'disabled', reason: 'auth e2e cleanup' },
      });
    }
    await app.close();
  });

  it('hands the administrator a temporary password exactly once', () => {
    // Long enough to be worth nothing to a guesser, and readable down a phone line.
    expect(temporaryPassword).toMatch(/^[A-Z2-9]{4}(-[A-Z2-9]{4}){3}$/);
  });

  it('never reveals the credential through the account record', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/api/v1/admin/users/${membershipId}`,
    });
    expect(response.statusCode).toBe(200);
    const account = response.json() as Record<string, unknown>;
    expect(account.hasPassword).toBe(true);
    expect(JSON.stringify(account)).not.toContain(temporaryPassword);
  });

  it('refuses the wrong password with the same answer as an unknown address', async () => {
    const wrong = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: 'not-the-password' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: `nobody.${stamp}@example.com`, password: temporaryPassword },
    });
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    // Identical wording, so the endpoint cannot be used to discover which addresses exist.
    const detail = (r: typeof wrong) => (r.json() as { detail: string }).detail;
    expect(detail(wrong)).toBe(detail(unknown));
  });

  it('opens nothing but the change-password route while the credential is temporary', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: temporaryPassword },
    });
    expect(login.statusCode).toBe(201);
    const body = login.json() as { token: string; account: { mustChangePassword: boolean } };
    expect(body.account.mustChangePassword).toBe(true);

    const headers = { authorization: `Bearer ${body.token}` };
    // Who am I still answers — the client has to be able to learn why it is being held.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(true);

    // Everything else is refused, so the change screen is a gate and not a suggestion.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers,
    });
    expect(dashboard.statusCode).toBe(403);
    expect((dashboard.json() as { detail: string }).detail).toContain('temporary password');
  });

  it('refuses to let the temporary password be kept as the new one', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: temporaryPassword },
    });
    const headers = {
      authorization: `Bearer ${(login.json() as { token: string }).token}`,
      'content-type': 'application/json',
    };
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/temporary',
      headers,
      payload: { newPassword: temporaryPassword, confirmPassword: temporaryPassword },
    });
    expect(response.statusCode).toBe(422);
  });

  it('keeps the caller signed in through the change they were forced to make', async () => {
    // The regression that mattered: setPassword revoked every session for the user, including the
    // one being used to comply with the gate. The change succeeded, the token died with it, and
    // the next request bounced the person back to the login screen - which looked, from the
    // outside, exactly like "the password is correct but the pages will not open".
    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email: email2, password: temporary2 },
    });
    const token = (login.json() as { token: string }).token;
    const headers = { authorization: `Bearer ${token}` };

    const replaced = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/temporary',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { newPassword: `Second-choice-${stamp}`, confirmPassword: `Second-choice-${stamp}` },
    });
    expect(replaced.statusCode).toBe(201);

    // Same token, still alive, and no longer held at the gate.
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { mustChangePassword: boolean }).mustChangePassword).toBe(false);

    // And the gate is no longer what stands in the way: what the account may do is now decided
    // by its role alone, not by the credential it was given.
    const dashboard = await app.inject({
      method: 'GET',
      url: '/api/v1/dashboard/overview',
      headers,
    });
    const detail = (dashboard.json() as { detail?: string }).detail ?? '';
    expect(detail).not.toContain('temporary password');
    // Something this role does not grant is refused for the permission, which is the refusal RBAC
    // is supposed to give.
    const audit = await app.inject({ method: 'GET', url: '/api/v1/admin/audit', headers });
    expect(audit.statusCode).toBe(403);
    expect((audit.json() as { detail?: string }).detail ?? '').toContain('Missing permission');
  });

  it('replaces the temporary password, then acts as that account, then signs out', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: temporaryPassword },
    });
    const replace = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/password/temporary',
      headers: {
        authorization: `Bearer ${(first.json() as { token: string }).token}`,
        'content-type': 'application/json',
      },
      payload: { newPassword: chosenPassword, confirmPassword: chosenPassword },
    });
    expect(replace.statusCode).toBe(201);

    // The temporary password is spent.
    const stale = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: temporaryPassword },
    });
    expect(stale.statusCode).toBe(401);

    const login = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/login',
      payload: { email, password: chosenPassword },
    });
    expect(login.statusCode).toBe(201);
    const body = login.json() as {
      token: string;
      account: {
        email: string;
        roles: string[];
        permissions: string[];
        mustChangePassword: boolean;
      };
    };
    expect(body.account.email).toBe(email);
    expect(body.account.mustChangePassword).toBe(false);
    // The account holds exactly what its one role grants, and nothing else.
    expect(body.account.roles).toHaveLength(1);
    expect(body.account.permissions.length).toBeGreaterThan(0);

    const headers = { authorization: `Bearer ${body.token}` };
    const me = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(me.statusCode).toBe(200);
    expect((me.json() as { email: string }).email).toBe(email);

    // The session drives permissions: this account cannot read the Users screen.
    const users = await app.inject({ method: 'GET', url: '/api/v1/admin/users', headers });
    expect(users.statusCode).toBe(403);

    const out = await app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers });
    expect(out.statusCode).toBe(201);

    // With the session revoked the token identifies nobody, and says so.
    const after = await app.inject({ method: 'GET', url: '/api/v1/auth/me', headers });
    expect(after.statusCode).toBe(401);
  });
});
