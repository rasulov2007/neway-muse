import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  HireDriverResult,
  RecruitCalendarEvent,
  RecruitCandidate,
  RecruitList,
  RecruitMetrics,
  RecruitNote,
  RotationSettings,
} from '@neway/shared';
import { RECRUIT_PROGRESS } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { env } from '../src/config/env';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { memberships, users } from '../src/database/schema/admin';
import {
  hiringApplyLinks,
  hiringDotLinkFiles,
  hiringLeads,
  hiringRotationMembers,
  hiringRotationState,
} from '../src/database/schema/hiring';
import { auditLogs, employees, positionHistory } from '../src/database/schema/people';
import { companies, drivers } from '../src/database/schema/roster';
import { HiringService } from '../src/modules/hiring/hiring.service';
import { LeadRotationService } from '../src/modules/hiring/lead-rotation.service';

const HIRING = '/api/v1/hiring';
const R = '/api/v1/hiring/recruiting';
const PUBLIC = '/api/v1/public/apply';
const EXTERNAL = '/api/v1/public/external-application';
const CONSENT = 'By submitting, you agree to be contacted about employment opportunities by phone, email, or SMS.';
// A 1×1 PNG.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

/**
 * The recruiting redesign's server rules (owner, 2026-10-08): My leads / All leads scope enforced
 * on the server, notes with follow-up dates, the real application link (never "sent"), the
 * external intake adapter, Send to Safety, an idempotent hire, and the persisted HR rotation.
 */
describe('Recruiting home and candidate (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let seq = 0;
  const base = String(Math.floor(200 + Math.random() * 700));
  const phone = () => `+1312${base}${String((seq += 1) % 10000).padStart(4, "0")}`;
  const as = (email: string) => ({ 'x-account': email });

  const call = (
    method: 'GET' | 'POST' | 'PATCH' | 'PUT',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
    remoteAddress?: string,
  ) =>
    app.inject({
      method,
      url,
      remoteAddress,
      headers: payload === undefined ? headers : { 'content-type': 'application/json', ...headers },
      payload: payload as object | undefined,
    });

  const prequal = {
    age23Plus: true,
    cdlHeldYears: 6,
    otrExperienceYears: 5,
    accidents36mo: 0,
    movingViolations36mo: 0,
    duiEver: false,
    endorsements: [],
    payTypePreference: 'company',
    homeState: 'TX',
    earliestStartDate: null,
  };

  let empA: string;
  let empB: string;
  const viewerEmail = `hr.view.${stamp}@test.local`;
  const managerEmail = `hr.manage.${stamp}@test.local`;
  const memberIds: string[] = [];

  async function employee(first: string): Promise<string> {
    const res = await call('POST', '/api/v1/employees', {
      firstName: first,
      lastName: `Home${stamp}`,
      workEmail: `${first.toLowerCase()}.${stamp}@test.local`,
      phone: '3125550199',
      department: 'hr',
      position: 'Recruiter',
      hireDate: '2026-10-01',
      employmentType: 'full_time',
      shiftTime: 'Day',
    });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { id: string }).id;
  }

  async function account(email: string, permissions: string[], employeeId: string) {
    const role = await call('POST', '/api/v1/admin/roles', { name: `Recruit ${email}`, permissions });
    expect(role.statusCode, role.body).toBe(201);
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: 'Hr',
      lastName: `Home${stamp}`,
      email,
      phone: null,
      employeeId: null,
      roleIds: [(role.json() as { id: string }).id],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    expect((await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'recruiting e2e' })).statusCode).toBe(200);
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    const linked = await call('PATCH', `/api/v1/admin/users/${membershipId}/employee`, { employeeId });
    expect(linked.statusCode, linked.body).toBe(200);
    memberIds.push(membershipId);
  }

  const addLead = async (name: string, recruiter: string | null, headers: Record<string, string> = {}) => {
    const res = await call(
      'POST',
      `${R}/leads`,
      { fullName: name, phone: phone(), source: 'instagram', assignment: recruiter ? 'recruiter' : 'auto', recruiterEmployeeId: recruiter },
      headers,
    );
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as { key: string }).key;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(ComplianceSeedService).backfillDotApplicationItems();
    await app.get(HiringService).backfillFromVerification('co_northwind');
    await app.get(HiringSeedService).seed();
    await app.get(HiringSeedService).seedDotApplications();
    await app.get(HiringSeedService).seedPipeline([
      { first: 'Home', last: `Ready${stamp}`, state: 'TX', daysAgo: 30, stop: 'orientation', driverType: 'company' },
    ]);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    // These specs cover the earlier order (application first); the journey's consent-first order is
    // a company setting, switched off here and restored after (recruiting-journey covers it).
    await app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: { 'content-type': 'application/json' }, payload: { values: { 'hiring.consent_first': false } } });
    db = app.get(DatabaseService).db;
    empA = await employee('Ava');
    empB = await employee('Bo');
    await account(viewerEmail, ['recruiting.view'], empA);
    await account(managerEmail, ['recruiting.view', 'recruiting.manage'], empB);
  }, 180_000);

  afterAll(async () => {
    for (const m of memberIds) await call('PATCH', `/api/v1/admin/users/${m}/status`, { status: 'disabled', reason: 'recruiting e2e cleanup' });
    // The demo company keeps no test recruiters taking turns.
    for (const id of [empA, empB]) if (id) await db.update(employees).set({ status: 'terminated' }).where(eq(employees.id, id));
    await app.inject({ method: 'PATCH', url: '/api/v1/admin/settings', headers: { 'content-type': 'application/json' }, payload: { values: { 'hiring.consent_first': true } } });
    await app.close();
  });

  let leadA: string;
  let leadB: string;

  it('Add lead is validated on the server; a named recruiter is kept', async () => {
    const bad = await call('POST', `${R}/leads`, { fullName: 'X', phone: '12', source: 'instagram' });
    expect(bad.statusCode).toBe(422);
    const noRecruiter = await call('POST', `${R}/leads`, { fullName: 'No Pick', phone: phone(), source: 'instagram', assignment: 'recruiter' });
    expect(noRecruiter.statusCode).toBe(422);
    leadA = await addLead(`Ann Alpha${stamp}`, empA);
    leadB = await addLead(`Ben Beta${stamp}`, empB);
    const [row] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadA));
    expect(row?.recruiterEmployeeId).toBe(empA);
    // A recruiting viewer cannot add leads.
    expect((await call('POST', `${R}/leads`, { fullName: 'Nope Viewer', phone: phone(), source: 'instagram' }, as(viewerEmail))).statusCode).toBe(403);
  });

  it('My leads is the signed-in recruiter’s own list; All leads and other recruiters’ candidates need recruiting.manage', async () => {
    const mine = await call('GET', `${R}/candidates?scope=mine&q=${stamp}`, undefined, as(viewerEmail));
    expect(mine.statusCode, mine.body).toBe(200);
    const list = mine.json() as RecruitList;
    expect(list.rows.map((r) => r.key)).toEqual([leadA]);
    expect(list.scope.label).toContain('Ava');
    expect(list.rows[0]?.progress).toBe('new');
    expect(list.rows[0]?.nextStep).toBe('Contact driver');

    expect((await call('GET', `${R}/candidates?scope=all`, undefined, as(viewerEmail))).statusCode).toBe(403);
    expect((await call('GET', `${R}/candidates/${leadB}`, undefined, as(viewerEmail))).statusCode).toBe(403);
    expect((await call('GET', `${R}/candidates/${leadA}`, undefined, as(viewerEmail))).statusCode).toBe(200);

    const filtered = (await call('GET', `${R}/candidates?scope=all&recruiter=${empA}&q=${stamp}`, undefined, as(managerEmail))).json() as RecruitList;
    expect(filtered.rows.map((r) => r.key)).toEqual([leadA]);
    expect(filtered.rows[0]?.recruiter?.employeeId).toBe(empA);
    const everyone = (await call('GET', `${R}/candidates?scope=all&q=${stamp}`, undefined, as(managerEmail))).json() as RecruitList;
    expect(everyone.rows.map((r) => r.key).filter((k) => k.startsWith('lead_')).sort()).toEqual([leadA, leadB].sort());
    // The filter is a filter: nobody was reassigned.
    expect((await db.select().from(hiringLeads).where(eq(hiringLeads.id, leadB)))[0]?.recruiterEmployeeId).toBe(empB);
  });

  it('search, status filter and pagination run together on the server', async () => {
    const res = (await call('GET', `${R}/candidates?scope=all&q=Alpha${stamp}&filter=new&page=1&pageSize=5`)).json() as RecruitList;
    expect(res.total).toBe(1);
    expect(res.counts.new).toBe(1);
    const none = (await call('GET', `${R}/candidates?scope=all&q=Alpha${stamp}&filter=hired`)).json() as RecruitList;
    expect(none.total).toBe(0);
    expect(none.counts.new).toBe(1);
  });

  it("another company's candidate cannot be read or written", async () => {
    const co = `co_home_${stamp}`;
    await db.insert(companies).values({ id: co, name: `Elsewhere ${stamp}` });
    const id = `lead_${crypto.randomUUID()}`;
    await db.insert(hiringLeads).values({ id, companyId: co, leadNumber: 'LEAD-1', firstName: 'Out', lastName: 'Side', phone: '+13125550000', source: 'website' });
    expect((await call('GET', `${R}/candidates/${id}`)).statusCode).toBe(404);
    expect((await call('GET', `${R}/candidates/${id}/notes`)).statusCode).toBe(404);
    expect((await call('POST', `${R}/candidates/${id}/notes`, { note: 'x' })).statusCode).toBe(404);
  });

  it('a note persists with its follow-up date, which drives the list, the metric and the calendar', async () => {
    // "Today" is the server's (Eastern) today, never the test machine's.
    const today = ((await call('GET', `${R}/candidates?scope=mine`, undefined, as(managerEmail))).json() as RecruitList).today;
    expect((await call('POST', `${R}/candidates/${leadB}/notes`, { note: '  ' }, as(managerEmail))).statusCode).toBe(422);
    expect((await call('POST', `${R}/candidates/${leadB}/notes`, { note: 'x', followUpOn: '2020-01-01' }, as(managerEmail))).statusCode).toBe(422);
    expect((await call('POST', `${R}/candidates/${leadA}/notes`, { note: 'viewer' }, as(viewerEmail))).statusCode).toBe(403);
    const saved = await call('POST', `${R}/candidates/${leadB}/notes`, { note: 'Called, sent the job details', followUpOn: today }, as(managerEmail));
    expect(saved.statusCode, saved.body).toBe(201);

    // A fresh read (a refresh) finds it, with who and when.
    const notes = (await call('GET', `${R}/candidates/${leadB}/notes`, undefined, as(managerEmail))).json() as RecruitNote[];
    expect(notes[0]?.text).toBe('Called, sent the job details');
    expect(notes[0]?.followUpOn).toBe(today);
    expect(notes[0]?.byName).toContain('Hr');

    const list = (await call('GET', `${R}/candidates?scope=mine&followUp=due`, undefined, as(managerEmail))).json() as RecruitList;
    expect(list.rows.map((r) => r.key)).toContain(leadB);
    expect(list.rows.find((r) => r.key === leadB)?.followUpState).toBe('today');
    // The list is grouped by step in funnel order: New, then Contacted, then Awaiting application ...
    const all = (await call('GET', `${R}/candidates?scope=all&pageSize=100`, undefined, as(managerEmail))).json() as RecruitList;
    const order: readonly string[] = RECRUIT_PROGRESS;
    const steps = all.rows.map((r) => order.indexOf(r.progress));
    expect(steps).toEqual([...steps].sort((x, y) => x - y));
    // The newest note rides on the list row, with who wrote it.
    expect(list.rows.find((r) => r.key === leadB)?.lastNote).toMatchObject({ text: 'Called, sent the job details' });
    expect(list.rows.find((r) => r.key === leadB)?.lastNote?.byName).toContain('Hr');
    const metrics = (await call('GET', `${R}/metrics?scope=mine`, undefined, as(managerEmail))).json() as RecruitMetrics;
    expect(metrics.followUpDue).toBeGreaterThanOrEqual(1);
    expect(metrics.active).toBeGreaterThanOrEqual(1);
    const calendar = (await call('GET', `${R}/calendar?from=${today}&to=${today}&scope=mine`, undefined, as(managerEmail))).json() as RecruitCalendarEvent[];
    expect(calendar.some((e) => e.kind === 'follow_up' && e.candidateKey === leadB)).toBe(true);

    expect((await call('POST', `${R}/candidates/${leadB}/follow-up/done`, {}, as(managerEmail))).statusCode).toBe(201);
    const after = (await call('GET', `${R}/candidates/${leadB}`, undefined, as(managerEmail))).json() as RecruitCandidate;
    expect(after.followUp).toBeNull();
    const audited = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, leadB), eq(auditLogs.action, 'note')));
    expect(audited).toHaveLength(1);
  });

  let caseKey: string;
  let token: string;

  it('Copy application link: a lead is prequalified first, then the real link; copying never counts as sent', async () => {
    const early = await call('POST', `${R}/candidates/${leadB}/application-link`, {}, as(managerEmail));
    expect(early.statusCode).toBe(409);
    expect(early.json().extensions?.code ?? early.json().code).toBe('prequalify_first');
    expect((await call('POST', `${HIRING}/leads/${leadB}/prequalify`, prequal)).statusCode).toBeLessThan(300);

    const made = await call('POST', `${R}/candidates/${leadB}/application-link`, {}, as(managerEmail));
    expect(made.statusCode, made.body).toBe(201);
    const body = made.json() as { url: string; key: string; externalUrl: string | null };
    expect(body.url).toMatch(/\/dot\/[A-Za-z0-9_-]{43}$/);
    expect(body.externalUrl).toBeNull();
    caseKey = body.key;
    token = body.url.split('/dot/')[1] ?? '';
    expect(caseKey).toMatch(/^apl_/);

    const c = (await call('GET', `${R}/candidates/${caseKey}`, undefined, as(managerEmail))).json() as RecruitCandidate;
    expect(c.progress).toBe('application_sent');
    expect(c.recruiter?.employeeId).toBe(empB);
    expect(c.application.link?.state).toBe('live');
    expect(c.application.markedSentAt).toBeNull();
    // The old lead key opens the same candidate.
    expect(((await call('GET', `${R}/candidates/${leadB}`, undefined, as(managerEmail))).json() as RecruitCandidate).key).toBe(caseKey);

    const sent = await call('POST', `${R}/candidates/${caseKey}/application-link/mark-sent`, { channel: 'text' }, as(managerEmail));
    expect(sent.statusCode).toBe(201);
    const after = (await call('GET', `${R}/candidates/${caseKey}`, undefined, as(managerEmail))).json() as RecruitCandidate;
    expect(after.application.markedSentAt).toBeTruthy();
    expect(after.progress).toBe('application_sent');
  });

  it('Send to Safety is refused with the actual missing items', async () => {
    const res = await call('POST', `${R}/candidates/${caseKey}/send-to-safety`, { note: null }, as(managerEmail));
    expect(res.statusCode).toBe(409);
    const missing = res.json().extensions?.missing ?? res.json().missing;
    expect(missing.join(' ')).toMatch(/Application received/);
  });

  it('the external intake: off unless switched on; one submission per link; retries answer the same; owner and files kept', async () => {
    const payload = (key: string) => ({
      submissionKey: key,
      firstName: 'Ben',
      lastName: `Beta${stamp}`,
      phone: '(312) 555-0101',
      email: 'ben@example.com',
      cdlClass: 'Class A',
      cdlState: 'IL',
      cdlExpiration: '2028-01-01',
      ssn: '123-45-6789',
      experience: '5 years',
      employer: 'Prior Freight',
      accidents: 'No',
      violations: 'No',
      suspended: 'No',
      consent: true,
      authorizations: { mvr: { authorized: true, name: 'Ben Beta', drawing: 'data:image/png;base64,xx', signedAt: new Date().toISOString() } },
      files: { cdlFront: { name: 'cdl.png', contentType: 'image/png', content: PNG } },
    });
    const before = { companies: env.EXTERNAL_APPLICATION_COMPANIES, origins: env.EXTERNAL_APPLICATION_ORIGINS };
    try {
      env.EXTERNAL_APPLICATION_COMPANIES = undefined;
      expect((await call('POST', `${EXTERNAL}/${token}`, payload(`k-off-0001-${stamp}`))).statusCode).toBe(404);

      env.EXTERNAL_APPLICATION_COMPANIES = 'co_northwind';
      env.EXTERNAL_APPLICATION_ORIGINS = 'https://apply.example.test';
      const evil = await call('POST', `${EXTERNAL}/${token}`, payload(`k-evil-001-${stamp}`), { origin: 'https://evil.example' });
      expect(evil.statusCode).toBe(403);
      const ok = await call('POST', `${EXTERNAL}/${token}`, payload(`k-first-01-${stamp}`), { origin: 'https://apply.example.test' });
      expect(ok.statusCode, ok.body).toBe(200);
      expect(ok.headers['access-control-allow-origin']).toBe('https://apply.example.test');
      const receipt = ok.json() as { reference: string; duplicate: boolean };
      expect(receipt.duplicate, ok.body).toBe(false);
      const retry = await call('POST', `${EXTERNAL}/${token}`, payload(`k-first-01-${stamp}`), { origin: 'https://apply.example.test' });
      expect(retry.json()).toMatchObject({ reference: receipt.reference, duplicate: true });
      const second = await call('POST', `${EXTERNAL}/${token}`, payload(`k-second-1-${stamp}`), { origin: 'https://apply.example.test' });
      expect(second.statusCode).toBe(409);

      const c = (await call('GET', `${R}/candidates/${caseKey}`, undefined, as(managerEmail))).json() as RecruitCandidate;
      expect(c.progress).toBe('application_received');
      expect(c.nextStep).toBe('Review application');
      expect(c.recruiter?.employeeId).toBe(empB);
      expect(c.application.external?.reference).toBe(receipt.reference);
      expect(c.application.external?.files.map((f) => f.code)).toEqual(['cdl']);
      const text = JSON.stringify(c);
      expect(text).not.toContain('123-45-6789');
      expect(text).not.toContain('123456789');
      expect(text).toContain('•••-••-6789');
      const files = await db.select().from(hiringDotLinkFiles).where(eq(hiringDotLinkFiles.hiringCaseId, c.caseId ?? ''));
      expect(files).toHaveLength(1);
    } finally {
      env.EXTERNAL_APPLICATION_COMPANIES = before.companies;
      env.EXTERNAL_APPLICATION_ORIGINS = before.origins;
    }
  });

  let readyKey: string;

  it('Send to Safety, once only, when the file is in', async () => {
    const list = (await call('GET', `${R}/candidates?scope=all&q=Ready${stamp}`)).json() as RecruitList;
    readyKey = list.rows[0]?.key ?? '';
    expect(readyKey).toBeTruthy();
    const c = (await call('GET', `${R}/candidates/${readyKey}`)).json() as RecruitCandidate;
    expect(['onboarding', 'ready_to_hire']).toContain(c.progress);
    expect(c.sendToSafety.checks.find((x) => x.code === 'application')?.ok).toBe(true);
    if (c.sendToSafety.ready) {
      const [a, b] = await Promise.all([
        call('POST', `${R}/candidates/${readyKey}/send-to-safety`, { note: 'please' }),
        call('POST', `${R}/candidates/${readyKey}/send-to-safety`, { note: 'please' }),
      ]);
      expect([a.statusCode, b.statusCode]).toEqual([201, 201]);
      const entries = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, c.caseId ?? ''), eq(auditLogs.action, 'safety_review_requested')));
      expect(entries).toHaveLength(1);
    }
  });

  it('Hire: prerequisites are read from the records; two Confirms make one driver with the reserved id', async () => {
    const c = (await call('GET', `${R}/candidates/${readyKey}`)).json() as RecruitCandidate;
    expect(c.hire.ready, JSON.stringify(c.hire.missing)).toBe(true);
    const reserved = c.driverId;
    expect(reserved).toMatch(/^drv_/);
    const body = { hireDate: new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' }), dispatcherId: 'usr_002' };
    const [a, b] = await Promise.all([
      call('POST', `${HIRING}/cases/${c.caseId}/hire`, body),
      call('POST', `${HIRING}/cases/${c.caseId}/hire`, body),
    ]);
    expect(a.statusCode, a.body).toBeLessThan(300);
    expect(b.statusCode, b.body).toBeLessThan(300);
    expect((a.json() as HireDriverResult).driverId).toBe(reserved);
    expect((b.json() as HireDriverResult).driverId).toBe(reserved);
    expect(await db.select().from(drivers).where(eq(drivers.id, reserved ?? ''))).toHaveLength(1);
    const after = (await call('GET', `${R}/candidates/${readyKey}`)).json() as RecruitCandidate;
    expect(after.progress).toBe('hired');
    const hired = (await call('GET', `${R}/candidates?scope=all&filter=hired&q=Ready${stamp}`)).json() as RecruitList;
    expect(hired.rows.map((r) => r.key)).toEqual([readyKey]);
    const metrics = (await call('GET', `${R}/metrics?scope=all`)).json() as RecruitMetrics;
    const hiredMonth = new Date(after.hire.hiredAt ?? 0).toLocaleDateString('en-CA', { timeZone: 'America/New_York' }).slice(0, 7);
    // Counted on the server's month; the hire is stamped with the wall clock.
    if (hiredMonth === metrics.month) expect(metrics.hiredThisMonth).toBeGreaterThanOrEqual(1);
  });

  it('a candidate not ready to hire says exactly what is missing', async () => {
    const c = (await call('GET', `${R}/candidates/${caseKey}`, undefined, as(managerEmail))).json() as RecruitCandidate;
    expect(c.hire.ready).toBe(false);
    expect(c.hire.missing).toContain('Safety approval');
  });

  // ============================================================================ the rotation

  describe('HR rotation (persisted roster and cursor)', () => {
    const co = `co_rr_${stamp}`;
    const slug = `rr-${stamp}`;
    const emp = { grace: `emp_rg_${stamp}`, marina: `emp_rm_${stamp}`, third: `emp_rt_${stamp}` };
    const user = (e: string) => `usr_${e}`;
    let address = 10;

    const submit = (name: string, key: string = crypto.randomUUID(), number = phone()) =>
      call(
        'POST',
        `${PUBLIC}/${slug}`,
        { submissionId: key, fullName: name, phone: number, experience: '2 years', position: 'Company driver', consent: true, website: '' },
        {},
        `10.8.${Math.floor(address / 250)}.${(address += 1) % 250}`,
      );
    const recruiterOf = async (name: string) => {
      const [first, ...rest] = name.split(' ');
      const [row] = await db
        .select()
        .from(hiringLeads)
        .where(and(eq(hiringLeads.companyId, co), eq(hiringLeads.firstName, first ?? ''), eq(hiringLeads.lastName, rest.join(' '))));
      return row?.recruiterEmployeeId ?? null;
    };
    const person = async (id: string, first: string, minutes: number) => {
      const at = new Date(Date.parse('2026-10-07T16:00:00Z') + minutes * 60_000);
      await db.insert(employees).values({
        id,
        companyId: co,
        employeeNumber: id,
        firstName: first,
        lastName: `R${stamp}`,
        workEmail: `${id}@test.local`,
        phone: '3125550100',
        department: 'hr',
        position: 'Recruiter',
        hireDate: '2026-01-01',
        status: 'active',
        employmentType: 'full_time',
        createdAt: at,
        updatedAt: at,
      });
      await db.insert(positionHistory).values({ id: `poh_${id}`, companyId: co, employeeId: id, position: 'Recruiter', department: 'hr', effectiveFrom: '2026-10-07', createdAt: at });
      await db.insert(users).values({ id: user(id), email: `${user(id)}@test.local`, firstName: first, lastName: `R${stamp}`, isActive: true });
      await db.insert(memberships).values({ id: `mem_${id}`, companyId: co, userId: user(id), employeeId: id, status: 'active' });
    };

    beforeAll(async () => {
      await db.insert(companies).values({ id: co, name: `Rotation Home ${stamp}` });
      await db.insert(hiringApplyLinks).values({
        id: `alink_rr_${stamp}`,
        companyId: co,
        slug,
        name: `Instagram ${slug}`,
        source: 'instagram',
        consentText: CONSENT,
        privacyPolicyUrl: 'https://example.com/privacy',
        createdBy: 'e2e',
      });
      await person(emp.grace, 'Greta', 0);
      await person(emp.marina, 'Marina', 3);
      // The live state before 0048: Greta then Marina took turns, so the next is Greta.
      for (const [n, e] of [[1, emp.grace], [2, emp.marina]] as const) {
        await db.insert(auditLogs).values({
          id: `aud_rr_${stamp}_${n}`,
          companyId: co,
          actorType: 'system',
          actorName: 'Online application',
          action: 'auto_assign',
          entityType: 'lead',
          entityId: `lead_legacy_${stamp}_${n}`,
          entityLabel: 'Legacy',
          summary: 'Recruiter assigned automatically',
          changes: [{ field: 'recruiterEmployeeId', old: null, new: e }],
          at: new Date(Date.now() - (3 - n) * 60_000),
        });
      }
    });

    it('the first read stores the roster from the live rotation and keeps the next turn (Greta)', async () => {
      // Read as an administrator of this company through the service.
      const svc = app.get(LeadRotationService);
      const s = await svc.settings({
        userId: 'e2e',
        userName: 'E2E admin',
        companyId: co,
        companyTimezone: 'America/New_York',
        weekStart: 1,
        roles: [],
        permissions: new Set(['recruiting.view', 'users.edit']),
      });
      expect(s.members.map((m) => m.userId)).toEqual([user(emp.grace), user(emp.marina)]);
      expect(s.next?.employeeId).toBe(emp.grace);
      expect(s.last.employeeId).toBe(emp.marina);
      const [state] = await db.select().from(hiringRotationState).where(eq(hiringRotationState.companyId, co));
      expect(state?.seededFrom).toContain(emp.marina);
    });

    it('two recruiters alternate; a duplicate retry takes no turn', async () => {
      const key = crypto.randomUUID();
      const number = phone();
      expect((await submit(`Ona One${stamp}`, key, number)).statusCode).toBe(201);
      expect((await submit(`Ona One${stamp}`, key, number)).statusCode).toBe(201); // the same submission again
      expect((await submit(`Tia Two${stamp}`)).statusCode).toBe(201);
      expect((await submit(`Ula Three${stamp}`)).statusCode).toBe(201);
      expect(await recruiterOf(`Ona One${stamp}`)).toBe(emp.grace);
      expect(await recruiterOf(`Tia Two${stamp}`)).toBe(emp.marina);
      expect(await recruiterOf(`Ula Three${stamp}`)).toBe(emp.grace);
    });

    it('a third recruiter joins at the end without resetting the cursor or touching older leads', async () => {
      await person(emp.third, 'Tess', 60);
      expect((await submit(`Vic Four${stamp}`)).statusCode).toBe(201); // after Greta: Marina
      expect((await submit(`Wes Five${stamp}`)).statusCode).toBe(201); // then the newcomer
      expect((await submit(`Xan Six${stamp}`)).statusCode).toBe(201); // then Greta again
      expect(await recruiterOf(`Vic Four${stamp}`)).toBe(emp.marina);
      expect(await recruiterOf(`Wes Five${stamp}`)).toBe(emp.third);
      expect(await recruiterOf(`Xan Six${stamp}`)).toBe(emp.grace);
      expect(await recruiterOf(`Ona One${stamp}`)).toBe(emp.grace);
      const members = await db.select().from(hiringRotationMembers).where(eq(hiringRotationMembers.companyId, co));
      expect(members.find((m) => m.userId === user(emp.third))?.joinedVia).toBe('auto_join');
    });

    it('a disabled account is skipped and keeps its place', async () => {
      await db.update(memberships).set({ status: 'disabled' }).where(eq(memberships.id, `mem_${emp.marina}`));
      expect((await submit(`Yul Seven${stamp}`)).statusCode).toBe(201);
      expect(await recruiterOf(`Yul Seven${stamp}`)).toBe(emp.third);
      await db.update(memberships).set({ status: 'active' }).where(eq(memberships.id, `mem_${emp.marina}`));
    });

    it('simultaneous applications take consecutive turns', async () => {
      const names = Array.from({ length: 6 }, (_, i) => `Sim${'abcdef'[i]} Burst${stamp}`);
      const results = await Promise.all(names.map((n) => submit(n)));
      for (const r of results) expect(r.statusCode, r.body).toBe(201);
      const assigned = await Promise.all(names.map((n) => recruiterOf(n)));
      for (const e of [emp.grace, emp.marina, emp.third]) expect(assigned.filter((a) => a === e)).toHaveLength(2);
    });

    it('settings: only an administrator reorders or excludes, and both are audited', async () => {
      const svc = app.get(LeadRotationService);
      const admin = {
        userId: 'e2e',
        userName: 'E2E admin',
        companyId: co,
        companyTimezone: 'America/New_York',
        weekStart: 1,
        roles: [],
        permissions: new Set(['recruiting.view', 'users.edit']),
      };
      const hr = { ...admin, permissions: new Set(['recruiting.view', 'recruiting.manage']) };
      await expect(svc.reorder(hr, [user(emp.third), user(emp.grace), user(emp.marina)])).rejects.toMatchObject({ status: 403 });
      const reordered: RotationSettings = await svc.reorder(admin, [user(emp.third), user(emp.grace), user(emp.marina)]);
      expect(reordered.members.map((m) => m.userId)).toEqual([user(emp.third), user(emp.grace), user(emp.marina)]);
      const excluded = await svc.setExcluded(admin, user(emp.grace), { excluded: true, reason: 'On leave' });
      expect(excluded.members.find((m) => m.userId === user(emp.grace))?.excluded).toBe(true);
      const audits = await db.select({ action: auditLogs.action }).from(auditLogs).where(and(eq(auditLogs.companyId, co), eq(auditLogs.entityType, 'hiring_rotation')));
      expect(audits.map((a) => a.action)).toEqual(expect.arrayContaining(['rotation_seeded', 'rotation_joined', 'rotation_reordered', 'rotation_excluded']));
    });

    it('with nobody eligible a new lead arrives unassigned and settings say so', async () => {
      for (const e of [emp.grace, emp.marina, emp.third]) await db.update(employees).set({ status: 'terminated' }).where(eq(employees.id, e));
      expect((await submit(`Zed Nobody${stamp}`)).statusCode).toBe(201);
      expect(await recruiterOf(`Zed Nobody${stamp}`)).toBeNull();
      const svc = app.get(LeadRotationService);
      const s = await svc.settings({
        userId: 'e2e',
        userName: 'E2E admin',
        companyId: co,
        companyTimezone: 'America/New_York',
        weekStart: 1,
        roles: [],
        permissions: new Set(['users.edit']),
      });
      expect(s.unassignedWarning).toBe(true);
      expect(s.next).toBeNull();
      expect(s.unassignedLeads).toBeGreaterThanOrEqual(1);
    });
  });
});
