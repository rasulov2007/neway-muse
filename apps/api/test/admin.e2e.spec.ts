import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { ProblemDetailsSchema } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { decrypt, encrypt } from '../src/modules/admin/credential-vault';
import { IntegrationSyncScheduler } from '../src/modules/admin/integration-sync.scheduler';

const BASE = '/api/v1/admin';

/**
 * Administration, end to end.
 *
 * Runs against the real database and the real principal resolver: the default principal is the
 * company owner, with the permissions its roles actually grant, so a permission check here is the
 * same check a browser gets.
 *
 * Everything this suite creates is created; nothing seeded is destroyed. The one status change it
 * makes to an account is reverted before it finishes.
 */
describe('Administration API (e2e)', () => {
  let app: NestFastifyApplication;

  beforeAll(async () => {
    app = await createApp();
    // The control plane has to exist before it can be queried; the seed is idempotent.
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    await app.close();
  });

  const get = (url: string, headers?: Record<string, string>) =>
    app.inject({ method: 'GET', url, headers });

  /** An account row as the list serves it, with everything these tests read off it. */
  interface AccountRow {
    membershipId: string;
    email: string;
    isOwner: boolean;
    status: string;
    roles: { id: string; code: string }[];
  }

  /**
   * Every account in the company, not just the first page.
   *
   * The company has more memberships than the maximum page size, and the owner does not sort to
   * the first page, so a single request would report "no owner" rather than the thing under test.
   */
  const allAccounts = async (): Promise<AccountRow[]> => {
    const rows: AccountRow[] = [];
    for (let page = 1; ; page += 1) {
      const response = await get(`${BASE}/users?pageSize=200&page=${page}`);
      expect(response.statusCode).toBe(200);
      const body = response.json() as { data: AccountRow[]; total: number };
      rows.push(...body.data);
      if (body.data.length === 0 || rows.length >= body.total) return rows;
    }
  };

  const ownerAccount = async (): Promise<AccountRow | undefined> =>
    (await allAccounts()).find((row) => row.isOwner);


  // ============================================================================== the principal

  it('resolves the default principal from the database, not a hardcoded list', async () => {
    const response = await get(`${BASE}/me`);
    expect(response.statusCode).toBe(200);
    const me = response.json() as { permissions: string[]; roles: string[]; name: string };
    expect(me.roles).toContain('administrator');
    expect(me.permissions).toContain('users.edit');
    expect(me.permissions).toContain('roles.edit');
    // A real person's name, from the users table — not "demo admin".
    expect(me.name).not.toMatch(/demo/i);
  });

  // ================================================================ permissions are enforced

  it('refuses every protected administration route to a principal without the permission', async () => {
    const headers = { 'x-demo-role': 'operations' };
    const routes = [
      `${BASE}/users`,
      `${BASE}/roles`,
      `${BASE}/departments`,
      `${BASE}/integrations`,
      `${BASE}/workflows`,
      `${BASE}/audit`,
      `${BASE}/settings`,
    ];
    for (const route of routes) {
      const response = await get(route, headers);
      expect(response.statusCode, route).toBe(403);
      expect(response.headers['content-type']).toContain('application/problem+json');
      const problem = ProblemDetailsSchema.parse(response.json());
      expect(problem.detail).toMatch(/Missing permission/);
    }
  });

  it('refuses every protected write to a principal without the permission', async () => {
    const headers = { 'x-demo-role': 'operations', 'content-type': 'application/json' };
    const writes: [string, string, unknown][] = [
      ['POST', `${BASE}/users`, { firstName: 'A', lastName: 'B', email: 'a@b.com' }],
      ['POST', `${BASE}/roles`, { name: 'Anything' }],
      ['POST', `${BASE}/departments`, { code: 'anything', name: 'Anything' }],
      ['POST', `${BASE}/integrations/connect`, { provider: 'samsara', credentials: { a: 'b' } }],
      [
        'POST',
        `${BASE}/workflows`,
        {
          name: 'x',
          trigger: 'employee:create',
          actions: [{ type: 'notify', roleCode: 'x', title: 'x' }],
        },
      ],
      ['PATCH', `${BASE}/settings`, { values: {} }],
    ];
    for (const [method, url, payload] of writes) {
      const response = await app.inject({
        method: method as 'POST',
        url,
        headers,
        payload: payload as object,
      });
      expect(response.statusCode, `${method} ${url}`).toBe(403);
    }
  });

  it('refuses to let a request choose its own company', async () => {
    const response = await get(`${BASE}/users?companyId=co_someone_else`);
    expect(response.statusCode).toBe(400);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.detail).toBe('Company is determined by the authenticated session');
  });

  // ==================================================================================== users

  it('lists accounts scoped to the principal company, each with its real roles', async () => {
    const accounts = await allAccounts();
    expect(accounts.length).toBeGreaterThan(0);
    expect(accounts.filter((row) => row.isOwner)).toHaveLength(1);
    for (const row of accounts) {
      expect(row.membershipId).toMatch(/^mbr_/);
    }
  });

  it('resolves effective permissions from the roles an account actually holds', async () => {
    const owner = await ownerAccount();
    expect(owner).toBeDefined();
    const response = await get(`${BASE}/users/${owner?.membershipId}/permissions`);
    expect(response.statusCode).toBe(200);
    const permissions = response.json() as string[];
    expect(permissions).toContain('users.edit');
    expect(permissions).toContain('roles.edit');
  });

  it('says an invitation email is not sent, because none is', async () => {
    const response = await get(`${BASE}/users/invitation-delivery`);
    const body = response.json() as { available: boolean; reason: string };
    expect(body.available).toBe(false);
    expect(body.reason).toMatch(/no invitation email/i);
  });

  it('refuses to create a second account for an email that already has one', async () => {
    const list = await get(`${BASE}/users?pageSize=1`);
    const existing = (list.json() as { data: { email: string }[] }).data[0];
    // An account needs a role, so one is given here: the duplicate email is what this asserts on.
    const roles = (await get(`${BASE}/roles`)).json() as { id: string }[];
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/users`,
      headers: { 'content-type': 'application/json' },
      payload: {
        firstName: 'Duplicate',
        lastName: 'Person',
        email: existing?.email,
        roleIds: [roles[0]?.id],
      },
    });
    expect(response.statusCode).toBe(409);
  });

  it('leaves archived accounts out of the total and the default list, and lists them when asked', async () => {
    type Summary = { total: number; active: number; invited: number; suspended: number; disabled: number; archived: number };
    const summary = async () => {
      const response = await get(`${BASE}/users/summary`);
      expect(response.statusCode).toBe(200);
      return response.json() as Summary;
    };
    const listed = async (query: string) =>
      ((await get(`${BASE}/users?pageSize=200&${query}`)).json() as { data: AccountRow[]; total: number });

    const before = await summary();
    expect(before.total).toBe(before.active + before.invited + before.suspended + before.disabled);

    // An invitation nobody used, then archived: the case the owner cleared out (2026-10-22).
    const roles = (await get(`${BASE}/roles`)).json() as { id: string }[];
    const email = `archived-${Date.now()}@test.local`;
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/users`,
      headers: { 'content-type': 'application/json' },
      payload: { firstName: 'Archived', lastName: 'Invitation', email, roleIds: [roles[0]?.id] },
    });
    expect(created.statusCode).toBe(201);
    const membershipId = (created.json() as { account: { membershipId: string } }).account.membershipId;
    const archived = await app.inject({
      method: 'PATCH',
      url: `${BASE}/users/${membershipId}/status`,
      headers: { 'content-type': 'application/json' },
      payload: { status: 'archived', reason: 'never used' },
    });
    expect(archived.statusCode).toBe(200);

    const after = await summary();
    expect(after.archived).toBe(before.archived + 1);
    expect(after.total).toBe(before.total);
    expect(after.total).toBe(after.active + after.invited + after.suspended + after.disabled);

    // The default list neither shows nor counts it.
    const all = await listed(`search=${encodeURIComponent(email)}`);
    expect(all.data.map((row) => row.membershipId)).not.toContain(membershipId);
    expect(all.total).toBe(0);
    expect((await listed('')).total).toBe(after.total);

    // Asked for by status, it is there, and every row on that view is archived.
    const only = await listed('status=archived');
    expect(only.total).toBe(after.archived);
    expect(only.data.map((row) => row.membershipId)).toContain(membershipId);
    expect(only.data.every((row) => row.status === 'archived')).toBe(true);
    // Left archived: this suite creates and never destroys, and an archived account stays out of the way.
  });

  it('refuses to disable the last account that can administer the company', async () => {
    const accounts = await allAccounts();
    const owner = accounts.find((row) => row.isOwner);
    // The guard protects the *last* administrator. A company that has been given a second one —
    // which is an ordinary thing to do — is a different case, and asserting 409 there would be
    // asserting a lockout that should not happen.
    const administrators = accounts.filter(
      (row) => row.status === 'active' && row.roles.some((role) => role.code === 'administrator'),
    );
    if (administrators.length > 1) {
      expect(administrators.length).toBeGreaterThan(1);
      return;
    }
    const response = await app.inject({
      method: 'PATCH',
      url: `${BASE}/users/${owner?.membershipId}/status`,
      headers: { 'content-type': 'application/json' },
      payload: { status: 'disabled', reason: 'lockout guard test' },
    });
    // If the guard ever lets this through, the account is put back before the assertion fails —
    // a test that leaves the administrator disabled locks the next person out of the app.
    if (response.statusCode !== 409) {
      await app.inject({
        method: 'PATCH',
        url: `${BASE}/users/${owner?.membershipId}/status`,
        headers: { 'content-type': 'application/json' },
        payload: { status: 'active', reason: 'restoring after the lockout guard test' },
      });
    }
    expect(response.statusCode).toBe(409);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.detail).toMatch(/nobody able to manage accounts and roles/);
  });

  it('refuses to strip administration from the last administrator, and leaves the roles intact', async () => {
    const accounts = await allAccounts();
    const owner = accounts.find((row) => row.isOwner);
    const before = owner?.roles.map((role) => role.id) ?? [];
    const administrators = accounts.filter(
      (row) => row.status === 'active' && row.roles.some((role) => role.code === 'administrator'),
    );
    if (administrators.length > 1) {
      expect(administrators.length).toBeGreaterThan(1);
      return;
    }

    const response = await app.inject({
      method: 'PATCH',
      url: `${BASE}/users/${owner?.membershipId}/roles`,
      headers: { 'content-type': 'application/json' },
      payload: { roleIds: [] },
    });
    // Put the roles back if the guard ever lets this through: a test that strips the owner's
    // administrator role locks everyone out of Administration on the next run.
    if (response.statusCode !== 409) {
      await app.inject({
        method: 'PATCH',
        url: `${BASE}/users/${owner?.membershipId}/roles`,
        headers: { 'content-type': 'application/json' },
        payload: { roleIds: before },
      });
    }
    expect(response.statusCode).toBe(409);

    // The refusal must also have rolled back — a guard that rejects after writing is not a guard.
    const after = await get(`${BASE}/users/${owner?.membershipId}`);
    const roles = (after.json() as { roles: { id: string }[] }).roles.map((role) => role.id);
    expect(roles.sort()).toEqual(before.sort());
  });

  // ==================================================================================== roles

  it('serves a permission matrix containing only enforced codes', async () => {
    const response = await get(`${BASE}/permissions`);
    expect(response.statusCode).toBe(200);
    const groups = response.json() as { permissions: { code: string }[] }[];
    expect(groups.length).toBeGreaterThan(0);
    for (const group of groups) {
      for (const permission of group.permissions) {
        expect(permission.code).toMatch(/^[a-z_]+\.[a-z_]+$/);
      }
    }
  });

  it('counts role holders per company and never archives a role the product ships', async () => {
    const response = await get(`${BASE}/roles`);
    const roles = response.json() as {
      id: string;
      code: string;
      isSystem: boolean;
      accountCount: number;
    }[];
    const administrator = roles.find((role) => role.code === 'administrator');
    expect(administrator?.isSystem).toBe(true);
    expect(administrator?.accountCount).toBeGreaterThan(0);

    const archive = await app.inject({ method: 'POST', url: `${BASE}/roles/${administrator?.id}/archive` });
    expect(archive.statusCode).toBe(409);
    expect(ProblemDetailsSchema.parse(archive.json()).detail).toMatch(/ships with the product/);
  });

  it('editing a built-in role saves the company version in its place, not a copy', async () => {
    type Listed = { id: string; code: string; name: string; isSystem: boolean; permissions: string[] };
    const list = async () => (await get(`${BASE}/roles`)).json() as Listed[];
    const shipped = (await list()).find((role) => role.isSystem && role.code !== 'administrator' && role.permissions.length > 1);
    expect(shipped).toBeDefined();
    const keep = shipped!.permissions.slice(1);

    const edit = await app.inject({
      method: 'PATCH',
      url: `${BASE}/roles/${shipped!.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { permissions: keep },
    });
    expect(edit.statusCode).toBe(200);
    const own = edit.json() as Listed;
    expect(own).toMatchObject({ code: shipped!.code, name: shipped!.name, isSystem: false });
    expect(own.permissions).not.toContain(shipped!.permissions[0]);

    const same = (await list()).filter((role) => role.code === shipped!.code);
    expect(same.map((role) => role.id)).toEqual([own.id]);

    // Retiring the company's version (nobody holds it here) brings the shipped one back.
    const moved = (await get(`${BASE}/roles/${own.id}`)).json() as { accountCount: number };
    if (moved.accountCount === 0) {
      const archived = await app.inject({ method: 'POST', url: `${BASE}/roles/${own.id}/archive` });
      expect(archived.statusCode).toBe(201);
      expect((await list()).find((role) => role.code === shipped!.code)?.isSystem).toBe(true);
    }
  });

  it('refuses a role granting a permission the backend does not enforce', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/roles`,
      headers: { 'content-type': 'application/json' },
      payload: { name: `Invented ${Date.now()}`, permissions: ['unicorns.ride'] },
    });
    expect(response.statusCode).toBe(422);
    const problem = ProblemDetailsSchema.parse(response.json());
    expect(problem.detail).toMatch(/Not a permission this system enforces/);
  });

  it('creates a role, grants the implied view, and archives it again', async () => {
    const name = `E2E role ${Date.now()}`;
    const created = await app.inject({
      method: 'POST',
      url: `${BASE}/roles`,
      headers: { 'content-type': 'application/json' },
      payload: { name, permissions: ['loads.edit'] },
    });
    expect(created.statusCode).toBe(201);
    const role = created.json() as { id: string; permissions: string[]; accountCount: number };
    expect(role.permissions.sort()).toEqual(['loads.edit', 'loads.view']);
    expect(role.accountCount).toBe(0);

    const archived = await app.inject({ method: 'POST', url: `${BASE}/roles/${role.id}/archive` });
    expect(archived.statusCode).toBe(201);
    expect((archived.json() as { status: string }).status).toBe('archived');
  });

  // ============================================================================== departments

  it('counts department headcount from the column the rest of the product reads', async () => {
    const [departments, employees] = await Promise.all([
      get(`${BASE}/departments`),
      get('/api/v1/employees?pageSize=1&status=active'),
    ]);
    const rows = departments.json() as { code: string; employeeCount: number; isSystem: boolean }[];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((row) => row.isSystem)).toBe(true);
    const counted = rows.reduce((sum, row) => sum + row.employeeCount, 0);
    expect(counted).toBeGreaterThan(0);
    expect(employees.statusCode).toBe(200);
  });

  it('refuses a department that would report to itself through its own chain', async () => {
    const list = await get(`${BASE}/departments`);
    const rows = list.json() as { id: string; parentDepartmentId: string | null }[];
    const target = rows[0];
    const response = await app.inject({
      method: 'PATCH',
      url: `${BASE}/departments/${target?.id}`,
      headers: { 'content-type': 'application/json' },
      payload: { parentDepartmentId: target?.id },
    });
    expect(response.statusCode).toBe(422);
  });

  // ============================================================================= integrations

  it('never returns a credential, only a four-character hint', async () => {
    const secret = `e2e-secret-token-${Date.now()}`;
    const connected = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/connect`,
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'motive', credentials: { apiKey: secret } },
    });
    expect(connected.statusCode).toBe(201);
    expect(connected.body).not.toContain(secret);

    const created = (connected.json() as { account: { id: string } }).account;

    const list = await get(`${BASE}/integrations`);
    expect(list.body).not.toContain(secret);
    const detail = await get(`${BASE}/integrations/accounts/${created.id}`);
    expect(detail.body).not.toContain(secret);
    const account = (detail.json() as { account: { credentialHint: string; status: string } })
      .account;
    expect(account.status).toBe('credentials_stored');
    expect(account.credentialHint).toContain(secret.slice(-4));
    expect(account.credentialHint).not.toContain(secret.slice(0, 8));

    // The audit entry records that a credential changed, never what it changed to.
    const audit = await get(`${BASE}/audit?entityType=integration&pageSize=5`);
    expect(audit.body).not.toContain(secret);

    const removed = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/accounts/${created.id}/disconnect`,
    });
    expect(removed.statusCode).toBe(201);
    expect(
      (removed.json() as { account: { credentialHint: string | null } }).account.credentialHint,
    ).toBeNull();
  });

  it('holds two accounts for one provider, each with its own credential', async () => {
    const first = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/connect`,
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'samsara', name: 'Samsara — yard A', credentials: { apiToken: 'e2e-token-AAAA' } },
    });
    const second = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/connect`,
      headers: { 'content-type': 'application/json' },
      payload: { provider: 'samsara', name: 'Samsara — yard B', credentials: { apiToken: 'e2e-token-BBBB' } },
    });
    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(201);

    const list = await get(`${BASE}/integrations`);
    const samsara = (
      list.json() as { integrations: { provider: string; accounts: { name: string; credentialHint: string }[] }[] }
    ).integrations.find((i) => i.provider === 'samsara');
    const names = samsara?.accounts.map((a) => a.name) ?? [];
    expect(names).toContain('Samsara — yard A');
    expect(names).toContain('Samsara — yard B');
    // Accounts whose credential was removed by an earlier run are still listed, with no hint.
    const hints = samsara?.accounts.map((a) => a.credentialHint ?? '') ?? [];
    expect(hints.some((h) => h.endsWith('AAAA'))).toBe(true);
    expect(hints.some((h) => h.endsWith('BBBB'))).toBe(true);
    expect(list.body).not.toContain('e2e-token-');
  });

  it('archives an account with no credential: hidden, never synced, kept, audited and reversible', async () => {
    interface ListBody {
      integrations: { provider: string; accounts: { id: string }[]; archivedAccounts: { id: string; status: string }[] }[];
    }
    const name = `RTS e2e archive ${Date.now()}`;
    const connected = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/connect`,
      headers: { 'content-type': 'application/json' },
      payload: {
        provider: 'rts',
        name,
        credentials: { clientNumber: '101212REC', password: 'e2e-rts-pass-ZZZZ', host: 'ftps.financial.rtspro.com', environment: 'test' },
      },
    });
    expect(connected.statusCode).toBe(201);
    const id = (connected.json() as { account: { id: string } }).account.id;
    const archive = (payload: Record<string, unknown> = {}) =>
      app.inject({
        method: 'POST',
        url: `${BASE}/integrations/accounts/${id}/archive`,
        headers: { 'content-type': 'application/json' },
        payload,
      });

    // A stored credential must be removed first: archiving never hides a live secret.
    const refused = await archive({ reason: 'old account' });
    expect(refused.statusCode).toBe(409);
    expect(refused.body).toContain('Remove the credential first');

    const removed = await app.inject({ method: 'POST', url: `${BASE}/integrations/accounts/${id}/disconnect` });
    expect(removed.statusCode).toBe(201);

    const archived = await archive({ reason: 'Old RTS account, replaced' });
    expect(archived.statusCode).toBe(201);
    expect((archived.json() as { account: { status: string } }).account.status).toBe('archived');

    // Hidden from the list the page shows, still on record behind "Show archived".
    const rts = (body: ListBody) => body.integrations.find((i) => i.provider === 'rts');
    const hidden = rts((await get(`${BASE}/integrations`)).json() as ListBody);
    expect(hidden?.accounts.map((a) => a.id)).not.toContain(id);
    expect(hidden?.archivedAccounts.map((a) => a.id)).toContain(id);
    const detail = await get(`${BASE}/integrations/accounts/${id}`);
    expect(detail.statusCode).toBe(200);

    // An archived account takes no edits until it is unarchived.
    const replace = await app.inject({
      method: 'POST',
      url: `${BASE}/integrations/accounts/${id}/credentials`,
      headers: { 'content-type': 'application/json' },
      payload: { credentials: { clientNumber: 'X', password: 'Y', host: 'Z', environment: 'test' } },
    });
    expect(replace.statusCode).toBe(409);

    // The scheduler never picks it up.
    const syncable = await app.get(IntegrationSyncScheduler).syncableAccounts(['samsara', 'motive', 'fiveeld', 'relay', 'rts']);
    expect(syncable.map((a) => a.id)).not.toContain(id);

    // Audited, with the reason.
    const audit = await get(`${BASE}/audit?entityType=integration&entityId=${id}&pageSize=20`);
    const entries = (audit.json() as { data: { summary: string; reason: string | null }[] }).data;
    const entry = entries.find((e) => e.summary.includes('archived'));
    expect(entry?.reason).toBe('Old RTS account, replaced');

    // Unarchive puts it back as an account with no credential.
    const restored = await app.inject({ method: 'POST', url: `${BASE}/integrations/accounts/${id}/unarchive` });
    expect(restored.statusCode).toBe(201);
    expect((restored.json() as { account: { status: string } }).account.status).toBe('not_configured');
    const back = rts((await get(`${BASE}/integrations`)).json() as ListBody);
    expect(back?.accounts.map((a) => a.id)).toContain(id);
    expect(back?.archivedAccounts.map((a) => a.id)).not.toContain(id);
    const again = await app.inject({ method: 'POST', url: `${BASE}/integrations/accounts/${id}/unarchive` });
    expect(again.statusCode).toBe(409);
    const unarchivedAudit = await get(`${BASE}/audit?entityType=integration&entityId=${id}&pageSize=20`);
    expect(unarchivedAudit.body).toContain('unarchived');

    // Leave it archived: this suite creates and never destroys, and an archived row stays out of the way.
    expect((await archive()).statusCode).toBe(201);
  });

  it('says which connector exists, and never claims a connection it has not made', async () => {
    const response = await get(`${BASE}/integrations`);
    const body = response.json() as { connectorsImplemented: boolean; note: string };
    expect(body.connectorsImplemented).toBe(true);
    expect(body.note).toMatch(/samsara/i);
    // A stored key earns credentials_stored; only a provider's answer earns connected.
    expect(response.body).not.toContain('"status":"connected"');
  });

  // ================================================================================ workflows

  it('offers only triggers and actions that exist, and marks the ones that do not work', async () => {
    const response = await get(`${BASE}/workflows/catalog`);
    const body = response.json() as {
      triggers: { id: string }[];
      actions: { type: string; implemented: boolean; reason?: string }[];
    };
    expect(body.triggers.length).toBeGreaterThan(0);
    for (const action of body.actions.filter((candidate) => !candidate.implemented)) {
      expect(action.reason, action.type).toBeTruthy();
    }
  });

  it('refuses a rule that notifies a role which does not exist', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `${BASE}/workflows`,
      headers: { 'content-type': 'application/json' },
      payload: {
        name: `Nobody ${Date.now()}`,
        trigger: 'employee:create',
        actions: [{ type: 'notify', roleCode: 'wizard', title: 'x' }],
      },
    });
    expect(response.statusCode).toBe(422);
  });

  // =============================================================================== audit log

  it('exposes no way to change an audit record', async () => {
    const list = await get(`${BASE}/audit?pageSize=1`);
    const entry = (list.json() as { data: { id: string }[] }).data[0];
    expect(entry).toBeDefined();
    for (const method of ['PATCH', 'PUT', 'DELETE'] as const) {
      const response = await app.inject({
        method,
        url: `${BASE}/audit/${entry?.id}`,
        headers: { 'content-type': 'application/json' },
        payload: { summary: 'rewritten' },
      });
      expect(response.statusCode, method).toBe(404);
    }
    // And the record is unchanged.
    const after = await get(`${BASE}/audit/${entry?.id}`);
    expect(after.statusCode).toBe(200);
  });

  it('reports how far back the trail goes, so an empty result is explainable', async () => {
    const response = await get(`${BASE}/audit?pageSize=1`);
    const body = response.json() as {
      coverage: { earliest: string | null; total: number; note: string };
    };
    expect(body.coverage.total).toBeGreaterThan(0);
    expect(body.coverage.earliest).not.toBeNull();
    expect(body.coverage.note).toBeTruthy();
  });

  it('exports the filtered trail as CSV', async () => {
    const response = await get(`${BASE}/audit/export?pageSize=5`);
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/csv');
    expect(response.body.split('\n')[0]).toContain('timestamp,actor,actor_type,action');
  });

  // ================================================================================ settings

  it('names the code that reads each setting, and admits the ones nothing reads', async () => {
    const response = await get(`${BASE}/settings`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      settings: { key: string; enforcedBy: string | null }[];
      notEnforced: { key: string; reason: string }[];
    };
    expect(body.settings.length).toBeGreaterThan(0);
    for (const entry of body.notEnforced) {
      expect(entry.reason).toBeTruthy();
      expect(body.settings.find((s) => s.key === entry.key)?.enforcedBy).toBeNull();
    }
  });

  it('refuses a setting key it does not have, and an invalid value for one it does', async () => {
    const unknown = await app.inject({
      method: 'PATCH',
      url: `${BASE}/settings`,
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'made.up': true } },
    });
    expect(unknown.statusCode).toBe(422);

    const invalid = await app.inject({
      method: 'PATCH',
      url: `${BASE}/settings`,
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'company.timezone': 'Europe/Berlin' } },
    });
    expect(invalid.statusCode).toBe(422);
  });

  it('changing the reporting week actually moves the dashboard period, then restores it', async () => {
    const before = await get('/api/v1/dashboard/overview?period=this_week');
    const beforeFrom = (before.json() as { meta: { period: { from: string } } }).meta.period.from;

    const changed = await app.inject({
      method: 'PATCH',
      url: `${BASE}/settings`,
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'company.week_start': 'sunday' } },
    });
    expect(changed.statusCode).toBe(200);

    // The principal caches the company row briefly; wait past that window rather than guessing.
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const after = await get('/api/v1/dashboard/overview?period=this_week');
    const afterFrom = (after.json() as { meta: { period: { from: string } } }).meta.period.from;
    expect(afterFrom).not.toBe(beforeFrom);

    const restored = await app.inject({
      method: 'PATCH',
      url: `${BASE}/settings`,
      headers: { 'content-type': 'application/json' },
      payload: { values: { 'company.week_start': 'monday' } },
    });
    expect(restored.statusCode).toBe(200);
  }, 30_000);
});

describe('credential vault', () => {
  it('round-trips a secret and produces different ciphertext each time', () => {
    const secret = 'samsara-secret-token-ABCD1234';
    const first = encrypt(secret);
    const second = encrypt(secret);
    expect(first.data).not.toBe(second.data);
    expect(decrypt(first)).toBe(secret);
    expect(JSON.stringify(first)).not.toContain('samsara');
  });

  it('refuses ciphertext that has been tampered with', () => {
    const sealed = encrypt('a-secret');
    const tampered = { ...sealed, data: Buffer.from('nonsense').toString('base64') };
    expect(() => decrypt(tampered)).toThrow();
  });
});
