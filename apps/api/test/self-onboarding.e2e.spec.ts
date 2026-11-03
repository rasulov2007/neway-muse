import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, membershipRoles, roles } from '../src/database/schema/admin';
import { auditLogs, employees } from '../src/database/schema/people';
import { SessionFactory, bearer, type RoleSession } from './authz/sessions';

/**
 * Complete your profile + the Create employee rules (owner, 2026-10-26), over real HTTP with real
 * bearer sessions in a throwaway company:
 *
 *   - a new non-admin account is held on the profile page by the API itself (403 profile_required
 *     on every other route), administrators are not;
 *   - the self-service endpoints only ever touch the caller's own record, refuse role / department
 *     / title / pay / record ids in the body, are version-checked and audited;
 *   - the record lands on the Employees list with department, title and pay type from the role,
 *     no pay amount, and the role the administrator gave is unchanged;
 *   - DOB / ID are masked for readers without the sensitive personnel codes;
 *   - the company setting switches the gate off, and the Users list names who has not finished;
 *   - Create employee: shift required, title optional, pay type locked to the department.
 */
const T = Date.now().toString(36);
const A = `co_e2e_onb_a_${T}`;
const B = `co_e2e_onb_b_${T}`;
const API = '/api/v1';

let app: NestFastifyApplication;
let sessions: SessionFactory;
let admin: RoleSession;
let adminB: RoleSession;
let dispatcher: RoleSession;
let safety: RoleSession;
let reader: RoleSession;

const call = (method: string, url: string, token: string, payload?: unknown) =>
  app.inject({
    method: method as 'GET',
    url: `${API}${url}`,
    headers: bearer(token),
    ...(payload === undefined ? {} : { payload: payload as object }),
  });

const db = () => app.get(DatabaseService).db;

/** The factory marks its accounts past the form; these start as a brand-new account would. */
async function fresh(session: RoleSession) {
  await db().update(memberships).set({ profileCompletedAt: null, employeeId: null }).where(eq(memberships.id, session.membershipId));
}

const profile = {
  fullName: 'Dana Dispatch',
  nickname: 'DD',
  dateOfBirth: '1991-05-06',
  idNumber: 'AB1234567',
  homeAddress: '1 Main St, Columbus, OH',
  phone: '6145550101',
  secondaryPhone: '6145550102',
  shiftTime: '6 PM – 6 AM Eastern',
  location: 'USA',
};

beforeAll(async () => {
  app = await createApp();
  await app.get(AdminSeedService).seed();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  sessions = new SessionFactory(app, `onb${T}`);
  await sessions.company(A, `E2E Onboarding A ${T}`);
  await sessions.company(B, `E2E Onboarding B ${T}`);
  admin = await sessions.signIn(A, 'administrator');
  adminB = await sessions.signIn(B, 'administrator');
  dispatcher = await sessions.signIn(A, 'dispatcher');
  safety = await sessions.signIn(A, 'safety_manager');
  reader = await sessions.signIn(A, 'read_only');
  await fresh(dispatcher);
  await fresh(safety);
}, 120_000);

afterAll(async () => {
  await sessions?.archiveAll();
  await app?.close();
});

describe('the gate is on the server', () => {
  it('a new non-admin account is held; an administrator is not', async () => {
    const me = (await call('GET', '/auth/me', dispatcher.token)).json() as { profileRequired: boolean; roles: string[] };
    expect(me.profileRequired).toBe(true);
    expect(me.roles).toEqual(['dispatcher']);
    expect(((await call('GET', '/auth/me', admin.token)).json() as { profileRequired: boolean }).profileRequired).toBe(false);
  });

  it('refuses every other route until the profile is submitted', async () => {
    for (const url of ['/loads', '/employees/dispatchers', '/drivers', '/admin/users']) {
      const res = await call('GET', url, dispatcher.token);
      expect(res.statusCode, url).toBe(403);
      expect((res.json() as { code?: string }).code, url).toBe('profile_required');
    }
    expect((await call('PATCH', '/auth/me/preferences', dispatcher.token, { appearance: 'dark' })).statusCode).toBe(403);
  });

  it('leaves auth/me, the profile endpoints, sign-out and change-password open', async () => {
    expect((await call('GET', '/me/profile', dispatcher.token)).statusCode).toBe(200);
    const wrongPassword = await call('POST', '/auth/password', dispatcher.token, { currentPassword: 'not-it', newPassword: 'a-new-password-1' });
    expect((wrongPassword.json() as { code?: string }).code).not.toBe('profile_required');
  });

  it('the Users page lists who has not completed it', async () => {
    const res = await call('GET', '/admin/users?profile=pending&pageSize=200', admin.token);
    expect(res.statusCode).toBe(200);
    const rows = (res.json() as { data: { membershipId: string; profileStatus: string }[] }).data;
    expect(rows.map((r) => r.membershipId).sort()).toEqual([dispatcher.membershipId, safety.membershipId].sort());
    expect(rows.every((r) => r.profileStatus === 'pending')).toBe(true);
    const all = (await call('GET', '/admin/users?pageSize=200', admin.token)).json() as { data: { membershipId: string; profileStatus: string }[] };
    expect(all.data.find((r) => r.membershipId === admin.membershipId)?.profileStatus).toBe('exempt');
  });
});

describe('Complete your profile', () => {
  let employeeId = '';

  it('reads only the caller: email from the account, no record yet', async () => {
    const body = (await call('GET', '/me/profile', dispatcher.token)).json() as { required: boolean; email: string; employee: unknown };
    expect(body).toMatchObject({ required: true, email: dispatcher.email, employee: null });
  });

  it('refuses role, department, title, pay or another record id in the body', async () => {
    for (const extra of [
      { roleIds: ['rol_administrator'] },
      { department: 'management' },
      { position: 'Administrator' },
      { payType: 'salary' },
      { payRate: 5000 },
      { employeeId: 'emp_1001' },
      { status: 'active' },
    ]) {
      const res = await call('PUT', '/me/profile', dispatcher.token, { ...profile, ...extra });
      expect(res.statusCode, JSON.stringify(extra)).toBe(422);
    }
    expect((await call('PUT', '/me/profile', dispatcher.token, { ...profile, shiftTime: '' })).statusCode).toBe(422);
  });

  it('creates the employee record from the account: Dispatch, Dispatcher, Commission (KPI), no amount', async () => {
    const res = await call('PUT', '/me/profile', dispatcher.token, profile);
    expect(res.statusCode, res.body).toBe(200);
    const body = res.json() as { required: boolean; employee: { fullName: string; nickname: string; dateOfBirth: string; updatedAt: string } };
    expect(body.required).toBe(false);
    expect(body.employee).toMatchObject({ fullName: 'Dana Dispatch', nickname: 'DD', dateOfBirth: '1991-05-06' });
    expect(JSON.stringify(body)).not.toMatch(/payType|payRate|department|roles/);

    const [m] = await db().select().from(memberships).where(eq(memberships.id, dispatcher.membershipId));
    expect(m?.employeeId).toBeTruthy();
    expect(m?.profileCompletedAt).toBeTruthy();
    employeeId = m!.employeeId!;
    const [row] = await db().select().from(employees).where(eq(employees.id, employeeId));
    expect(row).toMatchObject({
      companyId: A,
      department: 'dispatch',
      position: 'Dispatcher',
      payType: 'commission',
      payRate: null,
      userId: dispatcher.userId,
      workEmail: dispatcher.email,
      shiftTime: profile.shiftTime,
      idNumber: profile.idNumber,
      status: 'active',
    });
  });

  it('keeps the role exactly as the administrator gave it', async () => {
    const assigned = await db()
      .select({ code: roles.code })
      .from(membershipRoles)
      .innerJoin(roles, eq(roles.id, membershipRoles.roleId))
      .where(eq(membershipRoles.membershipId, dispatcher.membershipId));
    expect(assigned.map((r) => r.code)).toEqual(['dispatcher']);
  });

  it('audits the write as the person, in their company', async () => {
    const rows = await db().select().from(auditLogs).where(and(eq(auditLogs.companyId, A), eq(auditLogs.entityId, employeeId)));
    expect(rows.some((r) => r.reason === 'Self-service: Complete your profile' && r.actorId === dispatcher.userId)).toBe(true);
    const user = await db().select().from(auditLogs).where(and(eq(auditLogs.companyId, A), eq(auditLogs.entityId, dispatcher.membershipId)));
    expect(user.some((r) => r.summary.includes('Completed their own profile'))).toBe(true);
  });

  it('opens the product afterwards, and the person is on the Employees list', async () => {
    expect(((await call('GET', '/auth/me', dispatcher.token)).json() as { profileRequired: boolean }).profileRequired).toBe(false);
    expect((await call('GET', '/loads', dispatcher.token)).statusCode).not.toBe(403);
    const list = (await call('GET', '/employees?search=Dispatch&pageSize=200', admin.token)).json() as { data: { id: string; preferredName: string | null }[] };
    expect(list.data.find((e) => e.id === employeeId)?.preferredName).toBe('DD');
  });

  it('is version-checked: a stale save is a conflict, never an overwrite', async () => {
    expect((await call('PUT', '/me/profile', dispatcher.token, { ...profile, nickname: 'Stale' })).statusCode).toBe(409);
    const current = (await call('GET', '/me/profile', dispatcher.token)).json() as { employee: { updatedAt: string } };
    const ok = await call('PUT', '/me/profile', dispatcher.token, { ...profile, nickname: 'Dee', expectedUpdatedAt: current.employee.updatedAt });
    expect(ok.statusCode, ok.body).toBe(200);
    expect((await call('PUT', '/me/profile', dispatcher.token, { ...profile, nickname: 'Again', expectedUpdatedAt: current.employee.updatedAt })).statusCode).toBe(409);
  });

  it('another person completing theirs never touches this record', async () => {
    const before = (await db().select().from(employees).where(eq(employees.id, employeeId)))[0]!;
    const res = await call('PUT', '/me/profile', safety.token, { ...profile, fullName: 'Sam Safety', nickname: null });
    expect(res.statusCode, res.body).toBe(200);
    const after = (await db().select().from(employees).where(eq(employees.id, employeeId)))[0]!;
    expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
    const [m] = await db().select().from(memberships).where(eq(memberships.id, safety.membershipId));
    expect(m?.employeeId).not.toBe(employeeId);
    const [row] = await db().select().from(employees).where(eq(employees.id, m!.employeeId!));
    expect(row).toMatchObject({ department: 'safety', position: 'Safety Manager', payType: 'salary', payRate: null });
  });

  it('masks the date of birth and ID number for readers without the sensitive codes', async () => {
    const full = (await call('GET', `/employees/${employeeId}`, admin.token)).json() as { dateOfBirth: string | null; idNumber: string | null };
    expect(full).toMatchObject({ dateOfBirth: '1991-05-06', idNumber: profile.idNumber });
    const masked = (await call('GET', `/employees/${employeeId}`, reader.token)).json() as { dateOfBirth: string | null; idNumber: string | null; personalMasked?: boolean; payType: unknown };
    expect(masked).toMatchObject({ dateOfBirth: null, idNumber: null, personalMasked: true, payType: null });
    const activity = (await call('GET', `/employees/${employeeId}/activity`, reader.token)).body;
    expect(activity).not.toContain('1991-05-06');
    expect(activity).not.toContain(profile.idNumber);
  });

  it('stays inside the company', async () => {
    expect((await call('GET', `/employees/${employeeId}`, adminB.token)).statusCode).toBe(404);
  });
});

describe('the company setting', () => {
  it('switched off, a new account is not held', async () => {
    const late = await sessions.signIn(A, 'accounting');
    await fresh(late);
    expect(((await call('GET', '/auth/me', late.token)).json() as { profileRequired: boolean }).profileRequired).toBe(true);
    const off = await call('PATCH', '/admin/settings', admin.token, { values: { 'people.self_profile_required': false } });
    expect(off.statusCode, off.body).toBe(200);
    expect(((await call('GET', '/auth/me', late.token)).json() as { profileRequired: boolean }).profileRequired).toBe(false);
    expect((await call('GET', '/loads', late.token)).json()).not.toMatchObject({ code: 'profile_required' });
    await call('PATCH', '/admin/settings', admin.token, { values: { 'people.self_profile_required': true } });
  });
});

describe('Create employee: shift required, title optional, pay type follows the department', () => {
  const base = (email: string) => ({
    firstName: 'Fay',
    lastName: `Form${T}`,
    workEmail: `${email}.${T}@example.test`,
    phone: '6145550199',
    hireDate: '2026-10-26',
    employmentType: 'full_time',
  });

  it('requires a shift time', async () => {
    expect((await call('POST', '/employees', admin.token, { ...base('noshift'), department: 'safety' })).statusCode).toBe(422);
  });

  it('accepts no title, and derives Fixed outside Dispatch', async () => {
    const res = await call('POST', '/employees', admin.token, { ...base('notitle'), department: 'safety', shiftTime: 'Day' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toMatchObject({ position: '', payType: 'salary', shiftTime: 'Day' });
  });

  it('derives Commission (KPI) for Dispatch and refuses anything else', async () => {
    const ok = await call('POST', '/employees', admin.token, { ...base('disp'), department: 'dispatch', position: 'Dispatcher', shiftTime: 'Night' });
    expect(ok.statusCode, ok.body).toBe(201);
    expect(ok.json()).toMatchObject({ payType: 'commission' });
    const bad = await call('POST', '/employees', admin.token, { ...base('disp2'), department: 'dispatch', shiftTime: 'Night', payType: 'salary' });
    expect(bad.statusCode).toBe(422);
    const bad2 = await call('POST', '/employees', admin.token, { ...base('saf2'), department: 'safety', shiftTime: 'Night', payType: 'commission' });
    expect(bad2.statusCode).toBe(422);
  });

  it('moving department moves the pay type, and compensation must agree', async () => {
    const created = (await call('POST', '/employees', admin.token, { ...base('mover'), department: 'dispatch', position: 'Dispatcher', shiftTime: 'Day' })).json() as { id: string };
    const moved = await call('POST', `/employees/${created.id}/reassign`, admin.token, { department: 'safety', position: 'Safety Coordinator' });
    expect(moved.statusCode, moved.body).toBe(201);
    expect(moved.json()).toMatchObject({ department: 'safety', payType: 'salary' });
    const wrong = await call('POST', `/employees/${created.id}/compensation`, admin.token, { payType: 'commission', payRate: 900, effectiveFrom: '2026-10-26' });
    expect(wrong.statusCode).toBe(422);
    const right = await call('POST', `/employees/${created.id}/compensation`, admin.token, { payType: 'salary', payRate: 900, effectiveFrom: '2026-10-26' });
    expect(right.statusCode).toBe(201);
  });
});
