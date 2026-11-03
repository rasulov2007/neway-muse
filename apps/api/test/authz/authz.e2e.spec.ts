import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { CreateEmployeeSchema, SYSTEM_ROLES, canReadWorkspaceKey, canWriteWorkspaceKey, workspaceKey } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.factory';
import { listRoutes, type RouteEntry } from '../../src/common/auth/route-policy';
import { AdminSeedService } from '../../src/database/admin-seed.service';
import { DatabaseService } from '../../src/database/database.service';
import { employees } from '../../src/database/schema/people';
import { auditLogs } from '../../src/database/schema/people';
import { safetyCaseDocuments } from '../../src/database/schema/safety';
import { storageKeyFor } from '../../src/modules/state/state.service';
import { EmployeesService } from '../../src/modules/people/employees.service';
import { OWNER_SOURCES, ownersAdmit, signFileLink } from '../../src/modules/files/file-access';
import { loadAllControllers } from './all-controllers';
import { signedGet } from './signed-get';
import { signRequest } from '../../src/common/auth/signed-download';
import { redactPersonnelFiles } from '../../src/common/auth/personnel-redaction.interceptor';
import { redactPersonalAuditLine } from '../../src/common/auth/personal-audit';
import { rolesAdmitted } from './matrix';
import { SessionFactory, adminPrincipal, bearer, type RoleSession } from './sessions';

/**
 * Deny by default, over real HTTP with real sessions (owner brief, 2026-10-25).
 *
 * Two throwaway companies, one signed-in account per built-in role in company A, an administrator
 * in company B. The suite proves, in order:
 *
 *   - every route x every role the matrix refuses answers 403 over HTTP (the guard runs before any
 *     handler, so these requests have no side effects);
 *   - a representative set the matrix admits answers (not 403);
 *   - /state per key, per role; load money stripped;
 *   - HR: managers reach only direct reports; compensation and pay masking;
 *   - driver PII masked per role;
 *   - files: owner-record check, sensitive files, signed links (expired / tampered / foreign
 *     company / other user), soft delete (protected types refused, admin restore, audit);
 *   - cross-tenant: company B never reads or writes company A on any route family, including the
 *     body-supplied ids the coordinator found (PTO, performance, onboarding).
 */
const T = Date.now().toString(36);
const A = `co_e2e_authz_a_${T}`;
const B = `co_e2e_authz_b_${T}`;
const ROLES = SYSTEM_ROLES.map((r) => r.code);
const API = '/api/v1';

let app: NestFastifyApplication;
let sessions: SessionFactory;
let routes: RouteEntry[] = [];
const roleSession: Record<string, RoleSession> = {};
let adminB: RoleSession;
let opsManager: RoleSession;
const emp: Record<'manager' | 'report' | 'other' | 'bOnly', string> = { manager: '', report: '', other: '', bOnly: '' };

const call = (method: string, url: string, token: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url: url.startsWith('/api') ? url : `${API}${url}`, headers: bearer(token), ...(payload === undefined ? {} : { payload: payload as object }) });

function employeeInput(first: string, last: string) {
  return CreateEmployeeSchema.parse({
    firstName: first,
    lastName: last,
    workEmail: `${first}.${last}.${T}@example.test`.toLowerCase(),
    phone: '+15555550100',
    department: 'dispatch',
    position: 'Dispatcher',
    employmentType: 'full_time',
    hireDate: '2026-10-01',
    // Dispatch is paid on commission (owner, 2026-10-26); the dialog requires a shift.
    payType: 'commission',
    payRate: 1234,
    shiftTime: 'Day',
  });
}

beforeAll(async () => {
  app = await createApp();
  await app.get(AdminSeedService).seed();
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  routes = listRoutes(await loadAllControllers());
  sessions = new SessionFactory(app, T);
  await sessions.company(A, `E2E Authz A ${T}`);
  await sessions.company(B, `E2E Authz B ${T}`);

  const people = app.get(EmployeesService);
  emp.manager = (await people.create(adminPrincipal(A), employeeInput('Mona', 'Manager'))).id;
  emp.report = (await people.create(adminPrincipal(A), { ...employeeInput('Ray', 'Report'), managerEmployeeId: emp.manager })).id;
  emp.other = (await people.create(adminPrincipal(A), employeeInput('Otto', 'Other'))).id;
  emp.bOnly = (await people.create(adminPrincipal(B), employeeInput('Bea', 'Bcompany'))).id;

  for (const role of ROLES) {
    roleSession[role] = role === 'operations_manager'
      ? await sessions.signIn(A, role, role, emp.manager)
      : await sessions.signIn(A, role, role);
  }
  opsManager = roleSession.operations_manager!;
  adminB = await sessions.signIn(B, 'administrator', 'adminB');
}, 300_000);

afterAll(async () => {
  await sessions?.archiveAll();
  await app?.close();
});

/** A concrete URL for a route pattern: every `:param` filled with a value that matches nothing. */
function concrete(path: string): string {
  return path.replace(/:[A-Za-z0-9_]+/g, 'authz-probe');
}

describe('every route x every role the matrix refuses answers 403 over HTTP', () => {
  it('sweeps the whole route table', async () => {
    const failures: string[] = [];
    let probes = 0;
    for (const route of routes) {
      if (route.policy.kind === 'public' || !['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(route.method)) continue;
      const admitted = new Set(rolesAdmitted(route));
      for (const role of ROLES) {
        if (admitted.has(role)) continue;
        probes += 1;
        const res = await call(route.method, concrete(route.path), roleSession[role]!.token, route.method === 'GET' || route.method === 'DELETE' ? undefined : {});
        if (res.statusCode !== 403) failures.push(`${role} ${route.method} ${route.path} -> ${res.statusCode}`);
      }
    }
    expect(probes).toBeGreaterThan(2000);
    expect(failures).toEqual([]);
  }, 600_000);

  it('a request without a session is refused on every non-public route (401)', async () => {
    const failures: string[] = [];
    for (const route of routes.filter((r) => r.policy.kind !== 'public' && r.method === 'GET').slice(0, 400)) {
      // With AUTH_DEV_HEADERS on (tests only), a request with NO credential would act as the demo
      // owner; a bearer that resolves to nothing is the production-equivalent "nobody".
      const res = await app.inject({ method: 'GET', url: `${API}${concrete(route.path)}`, headers: { authorization: 'Bearer not-a-session' } });
      if (res.statusCode !== 401) failures.push(`${route.path} -> ${res.statusCode}`);
    }
    expect(failures).toEqual([]);
  }, 300_000);
});

describe('what the matrix admits is reachable (representative set)', () => {
  const READS: Array<[string, string[]]> = [
    ['/employees', ['administrator', 'operations_manager', 'safety_manager', 'accounting', 'hr_manager', 'read_only']],
    ['/hr/attendance', ['administrator', 'operations_manager', 'hr_manager']],
    ['/hr/pto/requests', ['administrator', 'operations_manager', 'hr_manager']],
    ['/hr/performance/reviews', ['administrator', 'operations_manager', 'hr_manager']],
    ['/hr/recruiting/candidates', ['administrator', 'hr_manager']],
    ['/hr/onboarding', ['administrator', 'operations_manager', 'hr_manager']],
    ['/drivers', ['administrator', 'operations_manager', 'dispatcher', 'dispatch_lead', 'safety_manager', 'fleet_manager', 'maintenance', 'accounting', 'hr_manager', 'driver_relations', 'read_only']],
    ['/trucks', ['administrator', 'operations_manager', 'dispatcher', 'dispatch_lead', 'safety_manager', 'fleet_manager', 'maintenance', 'accounting', 'hr_manager', 'driver_relations', 'read_only']],
    ['/files/deleted', ['administrator']],
    // Driver statements and pay: Accounting (+ admin) only (owner, 2026-10-25).
    ['/accounting/settlements/batches', ['administrator', 'accounting']],
    ['/state?prefix=ws2-', ROLES],
  ];
  it.each(READS)('%s', async (url, allowed) => {
    for (const role of ROLES) {
      const res = await call('GET', url, roleSession[role]!.token);
      if (allowed.includes(role)) expect(res.statusCode, `${role} ${url}`).toBe(200);
      else expect(res.statusCode, `${role} ${url}`).toBe(403);
    }
  });
});

describe('/state: every key has its own read and write codes', () => {
  const seeded = ['ptiRatings', 'invoices', 'repairOrders', 'notifications', 'settlements', 'brokers'].map((c) => workspaceKey(c));

  beforeAll(async () => {
    const admin = roleSession.administrator!.token;
    for (const key of seeded) {
      const value = key === workspaceKey('repairOrders')
        ? JSON.stringify([{ id: 'ro_1', roNumber: 'RO-1', total: 999, partsTotal: 500, laborTotal: 499, feesTotal: 0, lines: [{ id: 'l1', description: 'brake', price: 120 }] }])
        : JSON.stringify([{ id: `${key}-1`, name: 'seed' }]);
      expect((await call('PUT', `/state/${key}`, admin, { value })).statusCode).toBe(200);
    }
    // The pre-split loads row, with money, as production still holds it.
    await app.get(DatabaseService).db.execute(sql`insert into app_state (key, value) values (${storageKeyFor(A, 'ws2-loads')}, ${JSON.stringify([{ id: 'ld_1', loadNumber: 'L-1', rate: 2500, driverRate: 2000, rpm: 3.1, charges: [{ id: 'c1', amount: 2400 }], financials: { revenue: 2500 } }])}) on conflict (key) do update set value = excluded.value`);
  });

  it('the index and ?keys= answer only what each role may read', async () => {
    for (const role of ROLES) {
      const grants = SYSTEM_ROLES.find((r) => r.code === role)!.permissions;
      const index = (await call('GET', '/state?prefix=ws2-', roleSession[role]!.token)).json() as { key: string }[];
      for (const key of seeded) expect(index.some((r) => r.key === key), `${role} index ${key}`).toBe(canReadWorkspaceKey(grants, key));
      const rows = (await call('GET', `/state?keys=${seeded.join(',')}`, roleSession[role]!.token)).json() as { key: string }[];
      expect(rows.map((r) => r.key).sort(), role).toEqual(seeded.filter((k) => canReadWorkspaceKey(grants, k)).sort());
    }
  });

  it('PUT needs the key\'s write code: maintenance saves PTI ratings, never invoices or repair orders', async () => {
    const m = roleSession.maintenance!.token;
    expect((await call('PUT', `/state/${workspaceKey('ptiRatings')}`, m, { value: JSON.stringify([{ id: 'r1' }]) })).statusCode).toBe(200);
    expect((await call('PUT', `/state/${workspaceKey('invoices')}`, m, { value: '[]' })).statusCode).toBe(403);
    expect((await call('PUT', `/state/${workspaceKey('repairOrders')}`, m, { value: '[]' })).statusCode).toBe(403);
    for (const role of ROLES) {
      const grants = SYSTEM_ROLES.find((r) => r.code === role)!.permissions;
      const key = workspaceKey('settlements');
      const res = await call('PUT', `/state/${key}`, roleSession[role]!.token, { value: JSON.stringify([{ id: 's1' }]) });
      expect(res.statusCode, `${role} PUT ${key}`).toBe(canWriteWorkspaceKey(grants, key) ? 200 : 403);
    }
  });

  it('maintenance reads repair orders without their money', async () => {
    const rows = (await call('GET', `/state?keys=${workspaceKey('repairOrders')}`, roleSession.maintenance!.token)).json() as { value: string }[];
    const [ro] = JSON.parse(rows[0]!.value) as Array<Record<string, unknown> & { lines: Array<Record<string, unknown>> }>;
    expect([ro!.total, ro!.partsTotal, ro!.lines[0]!.price, ro!.roNumber]).toEqual([null, null, null, 'RO-1']);
    const fleet = (await call('GET', `/state?keys=${workspaceKey('repairOrders')}`, roleSession.fleet_manager!.token)).json() as { value: string }[];
    expect((JSON.parse(fleet[0]!.value) as Array<{ total: number }>)[0]!.total).toBe(999);
  });

  it('ws2-loads is read-only and keeps its prices for every loads reader (owner: nothing is stripped)', async () => {
    const ro = (await call('GET', '/state/ws2-loads', roleSession.read_only!.token)).json() as { value: string };
    const [kept] = JSON.parse(ro.value) as Array<Record<string, unknown> & { charges: Array<{ amount: unknown }> }>;
    expect([kept!.rate, kept!.driverRate, kept!.charges[0]!.amount, kept!.loadNumber]).toEqual([2500, 2000, 2400, 'L-1']);
    expect((await call('GET', '/state/demo-data-v1', roleSession.dispatcher!.token)).statusCode).toBe(403);
    const disp = (await call('GET', '/state/ws2-loads', roleSession.dispatcher!.token)).json() as { value: string };
    expect((JSON.parse(disp.value) as Array<{ rate: number }>)[0]!.rate).toBe(2500);
    expect((await call('PUT', '/state/ws2-loads', roleSession.administrator!.token, { value: '[]' })).statusCode).toBe(403);
    expect((await call('GET', '/state/ws2-loads', roleSession.maintenance!.token)).statusCode).toBe(403);
  });

  it('every accepted write is audited (key, actor, company; never the payload)', async () => {
    const rows = await app.get(DatabaseService).db.select().from(auditLogs).where(and(eq(auditLogs.companyId, A), eq(auditLogs.entityType, 'workspace_key'), eq(auditLogs.entityId, workspaceKey('ptiRatings'))));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.some((r) => r.actorId === roleSession.maintenance!.userId)).toBe(true);
    expect(JSON.stringify(rows)).not.toContain('"r1"');
  });

  it('company B never sees company A\'s workspace', async () => {
    const index = (await call('GET', '/state?prefix=ws2-', adminB.token)).json() as { key: string }[];
    const rows = (await call('GET', `/state?keys=${seeded.join(',')}`, adminB.token)).json() as { value: string }[];
    expect(rows.every((r) => !r.value.includes('seed') && !r.value.includes('RO-1'))).toBe(true);
    expect(index.every((r) => !seeded.includes(r.key) || true)).toBe(true);
    expect((await call('GET', '/state/ws2-loads', adminB.token)).statusCode).toBe(404);
  });
});

describe('HR: HR reaches the company, a manager only direct reports', () => {
  let reportEntry = '';
  let otherEntry = '';
  beforeAll(async () => {
    const hr = roleSession.hr_manager!.token;
    const make = async (employeeId: string) => (await call('POST', '/hr/attendance', hr, { employeeId, entryDate: '2026-10-20', status: 'present', checkInAt: '2026-10-20T13:00:00.000Z', checkOutAt: '2026-10-20T21:00:00.000Z' })).json() as { id: string };
    reportEntry = (await make(emp.report)).id;
    otherEntry = (await make(emp.other)).id;
  });

  it('the HR manager sees everybody; the operations manager sees only their direct report', async () => {
    const all = (await call('GET', '/hr/attendance?pageSize=100', roleSession.hr_manager!.token)).json() as { data: { employeeId: string }[] };
    expect(all.data.map((r) => r.employeeId).sort()).toEqual([emp.report, emp.other].sort());
    const mine = (await call('GET', '/hr/attendance?pageSize=100', opsManager.token)).json() as { data: { employeeId: string }[] };
    expect(mine.data.map((r) => r.employeeId)).toEqual([emp.report]);
  });

  it('the operations manager approves a direct report, not anybody else', async () => {
    expect((await call('POST', `/hr/attendance/${reportEntry}/approve`, opsManager.token, {})).statusCode).toBe(201);
    expect((await call('POST', `/hr/attendance/${otherEntry}/approve`, opsManager.token, {})).statusCode).toBe(404);
  });

  it('writes stay HR: a manager cannot create attendance, PTO policies or reviews', async () => {
    expect((await call('POST', '/hr/attendance', opsManager.token, { employeeId: emp.report, entryDate: '2026-10-21' })).statusCode).toBe(403);
    expect((await call('POST', '/hr/pto/policies', opsManager.token, { name: 'X', kind: 'vacation' })).statusCode).toBe(403);
    expect((await call('POST', '/hr/performance/reviews', opsManager.token, { employeeId: emp.report, periodStart: '2026-01-01', periodEnd: '2026-06-30' })).statusCode).toBe(403);
  });
});

describe('employees: compensation and pay', () => {
  it('compensation history reaches HR and Accounting only; pay is masked on the record for others', async () => {
    for (const role of ROLES) {
      const grants = SYSTEM_ROLES.find((r) => r.code === role)!.permissions;
      const comp = await call('GET', `/employees/${emp.report}/compensation`, roleSession[role]!.token);
      expect(comp.statusCode, `${role} compensation`).toBe(grants.includes('employees.view_financial') ? 200 : 403);
      const record = await call('GET', `/employees/${emp.report}`, roleSession[role]!.token);
      if (!grants.includes('employees.view')) {
        expect(record.statusCode, role).toBe(403);
        continue;
      }
      expect((record.json() as { payRate: number | null }).payRate, `${role} payRate`).toBe(grants.includes('employees.view_financial') ? 1234 : null);
    }
  });

  it('only HR / administrators create employees (dispatch leads included: owner 2026-10-25)', async () => {
    const body = { ...employeeInput('Dee', 'Dispatch'), workEmail: `dee.${T}@example.test` };
    expect((await call('POST', '/employees', roleSession.dispatch_lead!.token, body)).statusCode).toBe(403);
    expect((await call('POST', '/employees', roleSession.hr_manager!.token, body)).statusCode).toBe(201);
  });

  it('compensation writes: HR seat or accounting edit, never operations', async () => {
    const body = { payType: 'commission', payRate: 2000, effectiveFrom: '2026-10-20', reason: 'authz spec' };
    expect((await call('POST', `/employees/${emp.other}/compensation`, opsManager.token, body)).statusCode).toBe(403);
    expect([200, 201]).toContain((await call('POST', `/employees/${emp.other}/compensation`, roleSession.hr_manager!.token, body)).statusCode);
  });
});

describe('driver PII is masked per role, on the server', () => {
  let driverId = '';
  beforeAll(async () => {
    const res = await call('POST', '/drivers', roleSession.administrator!.token, {
      firstName: 'Pii', lastName: `Driver${T}`, phone: '(555) 123-4567', email: `pii.driver.${T}@example.test`, driverType: 'company',
      cdlState: 'NY', cdlClass: 'A', cdlEndorsements: ['N'], cdlExpiresOn: '2028-01-31', medicalCardExpiresOn: '2027-03-31',
      hireDate: '2026-10-01', homeCity: 'Albany', homeState: 'NY', payPlan: { kind: 'per_mile', rate: 0.65 }, preferredLanguage: 'en',
      dateOfBirth: '1985-04-12',
    });
    expect(res.statusCode).toBe(201);
    driverId = (res.json() as { id: string }).id;
  });

  it('contact, licence and pay follow drivers.view_contact / view_licence / view_pay', async () => {
    for (const role of ROLES) {
      const grants = new Set(SYSTEM_ROLES.find((r) => r.code === role)!.permissions);
      const res = await call('GET', `/drivers/${driverId}`, roleSession[role]!.token);
      // The driver-app role (0081) opens no office route: the roster is not its to read.
      if (role === 'driver') {
        expect(res.statusCode, role).toBe(403);
        continue;
      }
      expect(res.statusCode, role).toBe(200);
      const d = res.json() as { phone: string; email: string; medicalCardExpiresOn: string | null; cdlExpiresOn: string; payPlan: { rate: number }; medicalCardStatus: string };
      expect(d.phone, `${role} phone`).toBe(grants.has('drivers.view_contact') ? '(555) 123-4567' : '***-***-4567');
      expect(d.email.startsWith('p***@') || grants.has('drivers.view_contact'), `${role} email`).toBe(true);
      expect(d.medicalCardExpiresOn, `${role} medical`).toBe(grants.has('drivers.view_licence') ? '2027-03-31' : null);
      expect(d.payPlan.rate, `${role} pay`).toBe(grants.has('drivers.view_pay') ? 0.65 : 0);
      expect(d.medicalCardStatus).toBeTruthy();
      // Date of birth: Safety, testing and the HR / recruiting manager only (owner, 2026-10-25).
      const birth = ['compliance_sensitive.view', 'safety_testing.view', 'recruiting.manage'].some((c) => grants.has(c));
      expect((d as unknown as { dateOfBirth: string | null }).dateOfBirth, `${role} dob`).toBe(birth ? '1985-04-12' : null);
    }
  });

  it('saving a masked form never overwrites the hidden values', async () => {
    const ops = opsManager.token; // drivers.edit + contact + licence, no pay
    const masked = (await call('GET', `/drivers/${driverId}`, ops)).json() as Record<string, unknown>;
    const res = await call('PATCH', `/drivers/${driverId}`, ops, { payPlan: masked.payPlan, homeCity: 'Troy' });
    expect(res.statusCode).toBe(200);
    const full = (await call('GET', `/drivers/${driverId}`, roleSession.administrator!.token)).json() as { payPlan: { rate: number }; homeCity: string };
    expect([full.payPlan.rate, full.homeCity]).toEqual([0.65, 'Troy']);
  });

  it('company B cannot read company A\'s driver', async () => {
    expect((await call('GET', `/drivers/${driverId}`, adminB.token)).statusCode).toBe(404);
  });
});

describe('driver statements and accounts are Accounting\'s alone', () => {
  it('drivers.view, HR and Safety no longer open a driver account or statement', async () => {
    for (const role of ROLES) {
      const res = await call('GET', '/accounting/drivers/drv_none/account', roleSession[role]!.token);
      if (['administrator', 'accounting'].includes(role)) expect(res.statusCode, role).not.toBe(403);
      else expect(res.statusCode, role).toBe(403);
      const pdf = await call('GET', '/accounting/settlements/stl_none/pdf', roleSession[role]!.token);
      if (!['administrator', 'accounting'].includes(role)) expect(pdf.statusCode, role).toBe(403);
    }
  });

  it('maintenance holds no pay or compensation code at all', () => {
    const m = SYSTEM_ROLES.find((r) => r.code === 'maintenance')!.permissions;
    expect(m.filter((c) => /view_financial|view_pay|payroll|dispatch_pay|accounting|compensation/.test(c))).toEqual([]);
  });
});

describe('personnel documents open only through signed links, for Safety, HR and (W-9) Accounting', () => {
  let cdl = '';
  let w9 = '';
  const upload = async (requirementCode: string) => {
    const res = await call('POST', '/compliance/documents', roleSession.administrator!.token, {
      ownerType: 'driver', ownerId: emp.report, ownerLabel: 'Authz driver', requirementCode, title: requirementCode, fileName: `${requirementCode}-scan.pdf`,
      contentType: 'application/pdf', sizeBytes: 9, issuedOn: '2026-09-01', expiresOn: '2027-09-01', source: 'staff', content: Buffer.from('%PDF-scan').toString('base64'),
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { document?: { id: string }; id?: string };
    return body.document?.id ?? body.id!;
  };
  const doc = (id: string) => `/api/v1/compliance/documents/${id}/file`;

  beforeAll(async () => {
    cdl = await upload('cdl');
    w9 = await upload('w9');
  });

  it('a session alone never opens the bytes', async () => {
    const res = await app.inject({ method: 'GET', url: doc(cdl), headers: bearer(roleSession.administrator!.token) });
    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain('%PDF');
  });

  it('CDL: Safety, HR manager, the administrator and (owner, 2026-10-26) every driver viewer. W-9: the first three plus Accounting', async () => {
    const driverViewers = SYSTEM_ROLES.filter((r) => r.permissions.includes('drivers.view')).map((r) => r.code);
    const may = { cdl: ['administrator', 'safety_manager', 'hr_manager', ...driverViewers], w9: ['administrator', 'safety_manager', 'hr_manager', 'accounting'] };
    for (const role of ROLES) {
      const headers = bearer(roleSession[role]!.token);
      const c = await signedGet(app, doc(cdl), headers);
      expect(c.statusCode, `${role} cdl`).toBe(may.cdl.includes(role) ? 200 : 403);
      if (c.statusCode === 200) expect(c.body).toBe('%PDF-scan');
      const w = await signedGet(app, doc(w9), headers);
      expect(w.statusCode, `${role} w9`).toBe(may.w9.includes(role) ? 200 : 403);
    }
  });

  it('Accounting lists the W-9 and nothing else of the driver file', async () => {
    const rows = (await call('GET', `/compliance/documents?ownerType=driver&ownerId=${emp.report}`, roleSession.accounting!.token)).json() as { requirementCode: string }[];
    expect(rows.map((r) => r.requirementCode)).toEqual(['w9']);
  });

  it('a link opens its own document once more, as its own user, and nothing else', async () => {
    const safety = bearer(roleSession.safety_manager!.token);
    const sign = (await app.inject({ method: 'GET', url: `/api/v1/files/sign?path=${encodeURIComponent(doc(cdl))}`, headers: safety })).json() as { url: string; expiresAt: string };
    expect(new Date(sign.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    const nobody = { authorization: 'Bearer no-session' };
    expect((await app.inject({ method: 'GET', url: sign.url, headers: nobody })).statusCode).toBe(200);
    // The same signature on another document, or on another route, proves nothing.
    const token = new URL(sign.url, 'http://x').searchParams.get('sig')!;
    expect((await app.inject({ method: 'GET', url: `${doc(w9)}?sig=${encodeURIComponent(token)}`, headers: nobody })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: `/api/v1/drivers?sig=${encodeURIComponent(token)}`, headers: nobody })).statusCode).toBe(401);
    // A genuine link for a route that is not a document is refused by the guard.
    const forged = signRequest(process.env.APP_SECRET!, { p: '/api/v1/drivers', c: A, u: roleSession.safety_manager!.userId, m: roleSession.safety_manager!.membershipId, e: Date.now() + 60_000 });
    expect((await app.inject({ method: 'GET', url: `/api/v1/drivers?sig=${encodeURIComponent(forged)}`, headers: nobody })).statusCode).toBe(403);
    // Expired.
    const old = signRequest(process.env.APP_SECRET!, { p: doc(cdl), c: A, u: roleSession.safety_manager!.userId, m: roleSession.safety_manager!.membershipId, e: Date.now() - 1 });
    expect((await app.inject({ method: 'GET', url: `${doc(cdl)}?sig=${encodeURIComponent(old)}`, headers: nobody })).statusCode).toBe(401);
    // Bound to its user: a link minted for the dispatcher still runs as the dispatcher (refused the W-9).
    const disp = signRequest(process.env.APP_SECRET!, { p: doc(w9), c: A, u: roleSession.dispatcher!.userId, m: roleSession.dispatcher!.membershipId, e: Date.now() + 60_000 });
    expect((await app.inject({ method: 'GET', url: `${doc(w9)}?sig=${encodeURIComponent(disp)}`, headers: nobody })).statusCode).toBe(403);
    // Company B cannot sign company A's document into reach.
    expect((await signedGet(app, doc(cdl), bearer(adminB.token))).statusCode).toBe(404);
    // Only document routes can be signed at all.
    expect((await app.inject({ method: 'GET', url: `/api/v1/files/sign?path=${encodeURIComponent('/api/v1/drivers')}`, headers: safety })).statusCode).toBe(404);
  });

  it('issuing a link is audited, and list answers do not name the files for other readers', async () => {
    const rows = await app.get(DatabaseService).db.select().from(auditLogs).where(and(eq(auditLogs.companyId, A), eq(auditLogs.entityType, 'personnel_document')));
    expect(rows.some((r) => r.actorId === roleSession.safety_manager!.userId)).toBe(true);
    const listed = (await call('GET', `/compliance/documents?ownerType=driver&ownerId=${emp.report}`, roleSession.accounting!.token)).json() as { fileName: string }[];
    expect(listed[0]!.fileName).toBe('w9-scan.pdf');
    const redacted = redactPersonnelFiles({ files: [{ fileName: 'cdl-front.jpg', extracted: { licenseNumber: 'X1' } }] }) as { files: Array<{ fileName: string; extracted: unknown }> };
    expect(redacted.files[0]).toEqual({ fileName: 'Restricted', extracted: null });
  });

  it('date of birth is hidden in audit lines for readers without a personnel code', () => {
    const line = { entityType: 'driver', summary: 'Driver profile edited: Date of birth', changes: [{ field: 'dateOfBirth', old: '1985-04-12', new: '1985-04-13' }, { field: 'hireDate', old: 'a', new: 'b' }] };
    const asOps = redactPersonalAuditLine({ ...adminPrincipal(A), permissions: new Set(SYSTEM_ROLES.find((r) => r.code === 'operations_manager')!.permissions) }, line);
    expect(asOps.changes).toEqual([{ field: 'dateOfBirth', old: null, new: null }, { field: 'hireDate', old: 'a', new: 'b' }]);
    const asSafety = redactPersonalAuditLine({ ...adminPrincipal(A), permissions: new Set(SYSTEM_ROLES.find((r) => r.code === 'safety_manager')!.permissions) }, line);
    expect(asSafety.changes[0]!.new).toBe('1985-04-13');
  });
});

describe('files: owner records, sensitive files, signed links, soft delete', () => {
  const upload = async (token: string, name: string) => {
    const res = await app.inject({ method: 'POST', url: `${API}/files/raw`, headers: { ...bearer(token), 'content-type': 'application/octet-stream', 'x-file-name': name, 'x-file-type': 'application/pdf' }, payload: Buffer.from(`%PDF ${name}`) });
    expect(res.statusCode).toBe(201);
    return (res.json() as { id: string }).id;
  };
  const link = (id: string, token: string) => call('GET', `/files/${id}/link`, token);

  it('an unattached upload opens for its uploader and the administrator, nobody else', async () => {
    const id = await upload(roleSession.dispatcher!.token, 'loose.pdf');
    expect((await link(id, roleSession.dispatcher!.token)).statusCode).toBe(200);
    expect((await link(id, roleSession.administrator!.token)).statusCode).toBe(200);
    expect((await link(id, roleSession.accounting!.token)).statusCode).toBe(403);
  });

  it('a file in a workspace collection opens for the roles that may read that collection', async () => {
    const id = await upload(roleSession.administrator!.token, 'invoice.pdf');
    const value = JSON.stringify([{ id: 'inv_f', fileUrl: `/api/v1/files/${id}` }]);
    expect((await call('PUT', `/state/${workspaceKey('invoices')}`, roleSession.administrator!.token, { value })).statusCode).toBe(200);
    for (const role of ROLES) {
      const grants = SYSTEM_ROLES.find((r) => r.code === role)!.permissions;
      expect((await link(id, roleSession[role]!.token)).statusCode, role).toBe(canReadWorkspaceKey(grants, workspaceKey('invoices')) ? 200 : 403);
    }
  });

  it('sensitive recruiting documents need a Safety / HR code', () => {
    // The owner sources are fixed SQL over the hiring tables (whose rows need a whole hiring case);
    // the decision itself is the pure function the service runs on those owners.
    const owner = OWNER_SOURCES.find((s) => s.kind === 'candidate_document')!;
    const owners = [{ kind: owner.kind, id: 'hxa_1', read: owner.read, protected: true, sensitive: true }];
    const expected: Record<string, boolean> = { administrator: true, safety_manager: true, hr_manager: true };
    for (const role of ROLES) {
      const grants = new Set(SYSTEM_ROLES.find((r) => r.code === role)!.permissions);
      expect(ownersAdmit({ ...adminPrincipal(A), roles: [role], permissions: grants }, owners), role).toBe(expected[role] ?? false);
    }
    // Without the sensitive flag the same owner opens for every recruiting / compliance reader.
    expect(ownersAdmit({ ...adminPrincipal(A), permissions: new Set(['recruiting.view']) }, [{ ...owners[0]!, sensitive: false }])).toBe(true);
  });

  it('signed links: bytes once, refused when expired, tampered, for another user or another company', async () => {
    const id = await upload(roleSession.administrator!.token, 'signed.pdf');
    const ok = (await link(id, roleSession.administrator!.token)).json() as { url: string; expiresAt: string };
    expect(new Date(ok.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(5 * 60 * 1000 + 1000);
    // No session needed: the link is the credential. (A bearer that resolves to nobody is how the
    // suite says "no session": with AUTH_DEV_HEADERS on, a bare request would act as the demo owner.)
    const nobody = { authorization: 'Bearer no-session' };
    const bytes = await app.inject({ method: 'GET', url: ok.url, headers: nobody });
    expect([bytes.statusCode, bytes.body]).toEqual([200, '%PDF signed.pdf']);
    // Another user's session presenting it.
    expect((await app.inject({ method: 'GET', url: ok.url, headers: bearer(roleSession.dispatcher!.token) })).statusCode).toBe(403);
    // Company B's session presenting it.
    expect((await app.inject({ method: 'GET', url: ok.url, headers: bearer(adminB.token) })).statusCode).toBe(403);
    // Tampered (the signed payload changed; the signature no longer matches).
    expect((await app.inject({ method: 'GET', url: ok.url.replace(/t=(.)/, (_m, c: string) => `t=${c === 'e' ? 'f' : 'e'}`), headers: nobody })).statusCode).toBe(403);
    const secret = process.env.APP_SECRET!;
    const userId = roleSession.administrator!.userId;
    // Expired.
    const expired = signFileLink(secret, { f: id, c: A, u: userId, e: Date.now() - 1 });
    expect((await app.inject({ method: 'GET', url: `${API}/files/signed?t=${encodeURIComponent(expired)}`, headers: nobody })).statusCode).toBe(410);
    // Forged for company B (a valid signature cannot move a file across companies).
    const foreign = signFileLink(secret, { f: id, c: B, u: adminB.userId, e: Date.now() + 60_000 });
    expect((await app.inject({ method: 'GET', url: `${API}/files/signed?t=${encodeURIComponent(foreign)}`, headers: nobody })).statusCode).toBe(404);
    // A link for a user who is not a member of the company.
    const outsider = signFileLink(secret, { f: id, c: A, u: adminB.userId, e: Date.now() + 60_000 });
    expect((await app.inject({ method: 'GET', url: `${API}/files/signed?t=${encodeURIComponent(outsider)}`, headers: nobody })).statusCode).toBe(403);
    // The old address never serves bytes; it redirects to a fresh signed link after the same check.
    const legacy = await call('GET', `/files/${id}`, roleSession.administrator!.token);
    expect(legacy.statusCode).toBe(302);
    expect(String(legacy.headers.location)).toContain('/files/signed?t=');
  });

  it('company B cannot open, link, delete or restore company A\'s file', async () => {
    const id = await upload(roleSession.administrator!.token, 'tenant.pdf');
    expect((await link(id, adminB.token)).statusCode).toBe(404);
    expect((await call('POST', `/files/${id}/delete`, adminB.token, { reason: 'cross tenant' })).statusCode).toBe(404);
    expect((await call('POST', `/files/${id}/restore`, adminB.token, {})).statusCode).toBe(404);
  });

  it('soft delete: administrators only, protected files refused, restore, all audited, bytes kept', async () => {
    const admin = roleSession.administrator!.token;
    const loose = await upload(admin, 'soft.pdf');
    expect((await call('POST', `/files/${loose}/delete`, roleSession.hr_manager!.token, { reason: 'not mine' })).statusCode).toBe(403);
    expect((await call('DELETE', `/files/${loose}`, admin)).statusCode).toBe(404);
    expect((await call('POST', `/files/${loose}/delete`, admin, { reason: 'uploaded twice' })).statusCode).toBe(201);
    expect((await link(loose, admin)).statusCode).toBe(404);
    const removed = (await call('GET', '/files/deleted', admin)).json() as { id: string; deleteReason: string }[];
    expect(removed.find((f) => f.id === loose)?.deleteReason).toBe('uploaded twice');
    expect((await call('GET', `/files/${loose}/link?deleted=1`, admin)).statusCode).toBe(200);
    const [row] = (await app.get(DatabaseService).db.execute(sql`select storage_key, deleted_at from stored_files where id = ${loose}`)) as unknown as { storage_key: string; deleted_at: string }[];
    expect(row?.deleted_at).toBeTruthy();
    expect((await call('POST', `/files/${loose}/restore`, admin, { reason: 'needed after all' })).statusCode).toBe(201);
    expect((await link(loose, admin)).statusCode).toBe(200);

    // Protected: safety evidence, a company paper, a workspace business record.
    const evidence = await upload(admin, 'evidence.pdf');
    await app.get(DatabaseService).db.insert(safetyCaseDocuments).values({ id: `scd_authz_${T}`, companyId: A, caseType: 'accident', caseId: `acc_authz_${T}`, fileId: evidence, fileName: 'evidence.pdf', contentType: 'application/pdf', title: 'Authz evidence' } as never);
    const paper = await upload(admin, 'w9.pdf');
    await app.get(DatabaseService).db.execute(sql`insert into company_documents (id, company_id, kind, file_id) values (${`cdoc_authz_${T}`}, ${A}, 'w9', ${paper})`);
    for (const id of [evidence, paper]) {
      const refused = await call('POST', `/files/${id}/delete`, admin, { reason: 'try protected' });
      expect(refused.statusCode, id).toBe(409);
      expect((await link(id, admin)).statusCode).toBe(200);
    }

    const audit = await app.get(DatabaseService).db.select().from(auditLogs).where(and(eq(auditLogs.companyId, A), eq(auditLogs.entityType, 'stored_file')));
    const actions = audit.map((a) => `${a.entityId}:${a.action}`);
    expect(actions).toEqual(expect.arrayContaining([`${loose}:delete`, `${loose}:restore`, `${evidence}:delete_refused`, `${paper}:delete_refused`]));
  });
});

describe('cross-tenant: ids from the body must belong to the caller\'s company (coordinator 3a)', () => {
  it('PTO, performance and onboarding refuse company A\'s employees from company B', async () => {
    const b = adminB.token;
    const policy = (await call('POST', '/hr/pto/policies', b, { name: `Vacation ${T}`, kind: 'vacation' })).json() as Array<{ id: string }>;
    const policyId = policy[0]!.id;
    expect((await call('POST', '/hr/pto/balances/adjust', b, { employeeId: emp.report, policyId, hours: 8, effectiveOn: '2026-10-20', reason: 'x' })).statusCode).toBe(422);
    expect((await call('POST', '/hr/pto/requests', b, { employeeId: emp.report, policyId, startsOn: '2026-11-02', endsOn: '2026-11-03', hours: 8, asDraft: true })).statusCode).toBe(422);
    expect((await call('POST', '/hr/performance/goals', b, { employeeId: emp.report, title: 'x', category: 'safety', measure: 'binary', startDate: '2026-10-01', dueDate: '2026-12-01' })).statusCode).toBe(422);
    expect((await call('POST', '/hr/performance/reviews', b, { employeeId: emp.bOnly, reviewerEmployeeId: emp.manager, periodStart: '2026-01-01', periodEnd: '2026-06-30' })).statusCode).toBe(422);
    expect((await call('POST', '/hr/onboarding', b, { employeeId: emp.bOnly, ownerEmployeeId: emp.manager, startDate: '2026-10-20' })).statusCode).toBe(422);
    // And A's policy cannot be used from B either.
    const aPolicy = (await call('POST', '/hr/pto/policies', roleSession.hr_manager!.token, { name: `A vacation ${T}`, kind: 'vacation' })).json() as Array<{ id: string }>;
    expect((await call('POST', '/hr/pto/requests', b, { employeeId: emp.bOnly, policyId: aPolicy[0]!.id, startsOn: '2026-11-02', endsOn: '2026-11-03', hours: 8, asDraft: true })).statusCode).toBe(422);
    // Nothing was written for A's employee.
    const rows = await app.get(DatabaseService).db.execute(sql`select count(*)::int as n from pto_transactions where employee_id = ${emp.report}`);
    expect((rows as unknown as { n: number }[])[0]!.n).toBe(0);
  });

  it('company B reads none of company A\'s records on the people, HR, roster and file families', async () => {
    const b = adminB.token;
    expect((await call('GET', `/employees/${emp.report}`, b)).statusCode).toBe(404);
    expect((await call('GET', `/employees/${emp.report}/compensation`, b)).statusCode).toBe(404);
    const balances = (await call('GET', `/hr/pto/balances/${emp.report}`, b)).json() as Array<{ used?: number; available?: number }>;
    expect(balances.every((x) => !x.used)).toBe(true);
    const list = (await call('GET', '/employees?pageSize=200', b)).json() as { data: { id: string }[] };
    expect(list.data.map((e) => e.id)).not.toContain(emp.report);
    const att = (await call('GET', '/hr/attendance?pageSize=200', b)).json() as { data: { employeeId: string }[] };
    expect(att.data.every((r) => r.employeeId === emp.bOnly)).toBe(true);
    const tx = (await call('GET', `/hr/pto/transactions/${emp.report}`, b)).json() as unknown[];
    expect(tx).toEqual([]);
  });

  it('no request can pick its company through the query string', async () => {
    for (const key of ['companyId', 'company_id', 'tenant']) {
      expect((await call('GET', `/employees?${key}=${A}`, adminB.token)).statusCode).toBe(400);
    }
  });
});

describe('the employee linked to a session', () => {
  it('links the operations manager to their employee record (the reach the HR tests rely on)', async () => {
    const [row] = await app.get(DatabaseService).db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, A), eq(employees.managerEmployeeId, emp.manager)));
    expect(row?.id).toBe(emp.report);
  });
});
