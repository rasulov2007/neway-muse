import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { EmployeeQuerySchema, type EmployeeQuery } from '@neway/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { demoPrincipal } from '../src/common/auth/demo-principal.middleware';
import type { Principal } from '../src/common/auth/principal';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';
import { employees } from '../src/database/schema/people';
import { companies } from '../src/database/schema/roster';
import { EmployeesService } from '../src/modules/people/employees.service';

/**
 * The Employees page shows only people who filled in Complete your profile (owner, 2026-10-26).
 *
 * Runs on the local database inside two throw-away TEST companies created for the run, so every
 * count is exact. Needs migration 0077 (memberships.profile_completed_at); without the column every
 * case is skipped rather than failed. Nothing is deleted.
 */
describe('Employees page profile scope (e2e)', () => {
  let app: NestFastifyApplication;
  let service: EmployeesService;
  let ready = false;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const companyA = `co_test_prof_a_${stamp}`;
  const companyB = `co_test_prof_b_${stamp}`;
  const id = (name: string) => `emp_${name}_${stamp}`;
  const principalOf = (companyId: string): Principal => ({ ...demoPrincipal('admin'), companyId });
  const query = (over: Partial<Record<keyof EmployeeQuery, unknown>> = {}) =>
    EmployeeQuerySchema.parse({ pageSize: 200, ...over });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    const db = app.get(DatabaseService).db;
    const found = await db.execute(
      sql`select 1 as ok from information_schema.columns where table_name = 'memberships' and column_name = 'profile_completed_at'`,
    );
    ready = (found as unknown as unknown[]).length > 0;
    if (!ready) return;
    service = app.get(EmployeesService);

    await db.insert(companies).values([
      { id: companyA, name: `TEST profile scope A ${stamp}` },
      { id: companyB, name: `TEST profile scope B ${stamp}` },
    ]);
    let n = 0;
    const person = (companyId: string, key: string, position: string, status = 'active') => ({
      id: id(key),
      companyId,
      employeeNumber: `T${stamp}${n++}`,
      firstName: key,
      lastName: `Scope${stamp}`,
      workEmail: `${key}.${stamp}@example.com`,
      phone: '+1 312 555 0100',
      department: 'dispatch',
      position,
      hireDate: '2026-10-01',
      status,
      employmentType: 'full_time',
    });
    await db.insert(employees).values([
      person(companyA, 'complete', 'Dispatcher'),
      person(companyA, 'asked', 'Dispatcher'),
      person(companyA, 'noaccount', 'Dispatcher'),
      person(companyA, 'driverlower', 'driver (owner operator)'),
      person(companyA, 'driver', 'Driver'),
      person(companyA, 'gone', 'Safety manager', 'terminated'),
      person(companyB, 'other', 'Dispatcher'),
    ]);
    const account = async (
      key: string,
      companyId: string,
      employeeId: string,
      completed: boolean,
    ) => {
      const userId = `usr_${key}_${stamp}`;
      await db.insert(users).values({
        id: userId,
        email: `acct.${key}.${stamp}@example.com`,
        firstName: key,
        lastName: 'Account',
      });
      await db.insert(memberships).values({
        id: `mem_${key}_${stamp}`,
        companyId,
        userId,
        employeeId,
        status: 'active',
        profileCompletedAt: completed ? new Date() : null,
      });
    };
    await account('complete', companyA, id('complete'), true);
    await account('asked', companyA, id('asked'), false);
    await account('driverlower', companyA, id('driverlower'), true);
    await account('gone', companyA, id('gone'), true);
    // An account in company A pointing at company B's row must not make B's row "complete".
    await account('other', companyA, id('other'), true);
  });

  afterAll(async () => {
    await app?.close();
  });

  it('profile_complete lists only completed, non-driver staff of the company', async (ctx) => {
    if (!ready) ctx.skip();
    const page = await service.list(principalOf(companyA), query({ scope: 'profile_complete' }));
    expect(page.data.map((e) => e.id)).toEqual([id('complete')]);
    expect(page.total).toBe(1);
    expect(page.data[0]?.profileState).toBe('complete');

    const withLeft = await service.list(
      principalOf(companyA),
      query({ scope: 'profile_complete', includeInactive: 'true' }),
    );
    expect(withLeft.data.map((e) => e.id).sort()).toEqual([id('complete'), id('gone')].sort());
  });

  it('profile_incomplete lists the rest, says asked or no account, and still leaves drivers out', async (ctx) => {
    if (!ready) ctx.skip();
    const page = await service.list(principalOf(companyA), query({ scope: 'profile_incomplete' }));
    const states = Object.fromEntries(page.data.map((e) => [e.id, e.profileState]));
    expect(states).toEqual({ [id('asked')]: 'asked', [id('noaccount')]: 'no_account' });
  });

  it('is company-scoped: a membership in another company does not complete the row', async (ctx) => {
    if (!ready) ctx.skip();
    const complete = await service.list(principalOf(companyB), query({ scope: 'profile_complete' }));
    expect(complete.total).toBe(0);
    const incomplete = await service.list(principalOf(companyB), query({ scope: 'profile_incomplete' }));
    expect(incomplete.data.map((e) => e.id)).toEqual([id('other')]);
  });

  it('the summary counts the same set and reports both view sizes', async (ctx) => {
    if (!ready) ctx.skip();
    const summary = await service.summary(principalOf(companyA), query({ scope: 'profile_complete' }));
    expect(summary.total).toBe(1);
    // The status tiles count every status in the view, the terminated one included.
    expect([...summary.byStatus].sort((a, b) => a.status.localeCompare(b.status))).toEqual([
      { status: 'active', count: 1 },
      { status: 'terminated', count: 1 },
    ]);
    expect(summary.profileViews).toEqual({ complete: 1, incomplete: 2 });
  });

  it('without a scope the list is unchanged for every other consumer', async (ctx) => {
    if (!ready) ctx.skip();
    const page = await service.list(principalOf(companyA), query());
    const ids = page.data.map((e) => e.id).sort();
    // The placeholder rows stay (pickers, team names, commission splits); the exact "Driver"
    // title is left out as before, and no profile state is attached.
    expect(ids).toEqual([id('asked'), id('complete'), id('driverlower'), id('noaccount')].sort());
    expect(page.data.every((e) => e.profileState === undefined)).toBe(true);
    const summary = await service.summary(principalOf(companyA), query());
    expect(summary.profileViews).toBeUndefined();
    expect(summary.total).toBe(4);
  });
});
