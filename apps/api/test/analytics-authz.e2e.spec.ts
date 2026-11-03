import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CreateEmployeeSchema } from '@neway/shared';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';
import { companies } from '../src/database/schema/roster';
import { UsersService } from '../src/modules/admin/users.service';
import { AuthService } from '../src/modules/auth/auth.service';
import { EmployeesService } from '../src/modules/people/employees.service';

/**
 * Analytics and Reports are enforced by the server, not only hidden in the navigation
 * (owner, 2026-10-25).
 *
 * Real sessions (bearer tokens) for accounts holding real system roles, in two fresh companies:
 *   - Read only   holds reports.view + analytics.view  → 200 everywhere
 *   - Dispatcher  holds reports.view, not analytics    → 403 on analytics, 200 on reports
 *   - Maintenance holds neither                        → 403 on both
 * and a company B account never sees company A's records through analytics.
 */
const ANALYTICS = [
  '/api/v1/analytics/executive',
  '/api/v1/analytics/cost-drivers',
  '/api/v1/analytics/accessorials',
  '/api/v1/analytics/trucks',
  '/api/v1/analytics/drivers',
  '/api/v1/analytics/operations',
  '/api/v1/analytics/fuel',
  '/api/v1/analytics/workforce',
];

const REPORT_READS = ['/api/v1/reports/catalog', '/api/v1/reports/saved'];

describe('Analytics and Reports permissions (e2e)', () => {
  let app: NestFastifyApplication;
  const tag = Date.now().toString(36);
  const companyA = `co_e2e_an_a_${tag}`;
  const companyB = `co_e2e_an_b_${tag}`;
  const createdUsers: string[] = [];
  const tokens: Record<'viewerA' | 'dispatcherA' | 'maintenanceA' | 'viewerB', string> = {
    viewerA: '',
    dispatcherA: '',
    maintenanceA: '',
    viewerB: '',
  };

  const admin = (companyId: string): Principal => ({
    userId: `u_e2e_an_${companyId}`,
    userName: 'E2E',
    companyId,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: ['administrator'],
    permissions: new Set(['users.manage', 'users.view', 'users.edit', 'employees.create', 'employees.view', 'employees.edit']),
  });

  /** An active account holding one system role, signed in through the real login. */
  async function signedIn(companyId: string, roleCode: string, name: string): Promise<string> {
    const email = `an.${name.toLowerCase()}.${tag}@example.test`;
    const created = await app.get(UsersService).create(admin(companyId), {
      firstName: name,
      lastName: 'Analytics',
      email,
      phone: null,
      employeeId: null,
      roleIds: [`rol_${roleCode}`],
      invite: false,
    });
    const db = app.get(DatabaseService).db;
    createdUsers.push(created.account.userId);
    await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, created.account.membershipId));
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, created.account.userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, created.account.userId));
    const login = await app.get(AuthService).login({ email, password: created.temporaryPassword as string }, {});
    expect(login.account.companyId).toBe(companyId);
    return login.token;
  }

  const get = (url: string, token: string) =>
    app.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    await app.get(DatabaseService).db.insert(companies).values([
      { id: companyA, name: `E2E Analytics A ${tag}` },
      { id: companyB, name: `E2E Analytics B ${tag}` },
    ] as Array<typeof companies.$inferInsert>);

    // Company A has people; company B has nobody.
    const input = CreateEmployeeSchema.parse({
      firstName: 'Alpha',
      lastName: 'Worker',
      workEmail: `alpha.worker.${tag}@example.test`,
      phone: '+998996967681',
      department: 'dispatch',
      position: 'Dispatcher',
      employmentType: 'full_time',
      hireDate: '2026-10-01',
    });
    await app.get(EmployeesService).create(admin(companyA), input);
    await app.get(EmployeesService).create(admin(companyA), { ...input, workEmail: `alpha.second.${tag}@example.test` });

    tokens.viewerA = await signedIn(companyA, 'read_only', 'ViewerA');
    tokens.dispatcherA = await signedIn(companyA, 'dispatcher', 'DispatcherA');
    tokens.maintenanceA = await signedIn(companyA, 'maintenance', 'MaintenanceA');
    tokens.viewerB = await signedIn(companyB, 'read_only', 'ViewerB');
  }, 180_000);

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    if (createdUsers.length > 0) {
      // Archived, not deleted: the throwaway test accounts stop signing in and stay on record.
      await db.update(memberships).set({ status: 'archived' }).where(inArray(memberships.userId, createdUsers));
    }
    await app?.close();
  });

  it('refuses every Analytics endpoint without analytics.view (403)', async () => {
    for (const token of [tokens.dispatcherA, tokens.maintenanceA]) {
      for (const url of ANALYTICS) {
        const res = await get(url, token);
        expect(res.statusCode, `${url}: ${res.body}`).toBe(403);
        expect(res.body).toContain('analytics.view');
      }
    }
  });

  it('answers every Analytics endpoint with analytics.view (200)', async () => {
    for (const url of ANALYTICS) {
      const res = await get(url, tokens.viewerA);
      expect(res.statusCode, `${url}: ${res.body}`).toBe(200);
    }
  });

  it('refuses Reports without reports.view and answers with it', async () => {
    for (const url of REPORT_READS) {
      expect((await get(url, tokens.maintenanceA)).statusCode, url).toBe(403);
      expect((await get(url, tokens.dispatcherA)).statusCode, url).toBe(200);
      expect((await get(url, tokens.viewerA)).statusCode, url).toBe(200);
    }
    const run = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/run',
      headers: { authorization: `Bearer ${tokens.maintenanceA}`, 'content-type': 'application/json' },
      payload: { reportKey: 'headcount' },
    });
    expect(run.statusCode).toBe(403);
    const save = await app.inject({
      method: 'POST',
      url: '/api/v1/reports/saved',
      headers: { authorization: `Bearer ${tokens.maintenanceA}`, 'content-type': 'application/json' },
      payload: { name: 'x', reportKey: 'headcount' },
    });
    expect(save.statusCode).toBe(403);
    const remove = await app.inject({
      method: 'DELETE',
      url: '/api/v1/reports/saved/srp_none',
      headers: { authorization: `Bearer ${tokens.maintenanceA}` },
    });
    expect(remove.statusCode).toBe(403);
  });

  it('never gives company B the records of company A', async () => {
    const a = (await get('/api/v1/analytics/workforce', tokens.viewerA)).json() as { headcount: number };
    const b = (await get('/api/v1/analytics/workforce', tokens.viewerB)).json() as { headcount: number; byDepartment: unknown[] };
    expect(a.headcount).toBe(2);
    expect(b.headcount).toBe(0);
    expect(b.byDepartment).toEqual([]);

    for (const url of ['/api/v1/analytics/trucks', '/api/v1/analytics/drivers']) {
      const rows = ((await get(url, tokens.viewerB)).json() as { rows: unknown[] }).rows;
      expect(rows, url).toEqual([]);
    }
    const exec = (await get('/api/v1/analytics/executive', tokens.viewerB)).json() as {
      metrics: Array<{ key: string; current: number | null }>;
    };
    const gross = exec.metrics.find((m) => m.key === 'gross');
    expect(gross?.current ?? 0).toBe(0);

    // Choosing a company through the query string is refused outright, never honoured.
    const forced = await get(`/api/v1/analytics/workforce?companyId=${companyA}`, tokens.viewerB);
    expect(forced.statusCode).toBe(400);
  });
});
