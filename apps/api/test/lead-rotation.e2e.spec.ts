import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Lead, LeadNote, MyLeads } from '@neway/shared';
import { and, asc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';
import { hiringApplyLinks, hiringLeads } from '../src/database/schema/hiring';
import { auditLogs, employees, positionHistory } from '../src/database/schema/people';
import { companies } from '../src/database/schema/roster';
import { LeadRotationService } from '../src/modules/hiring/lead-rotation.service';
import { LeadsService } from '../src/modules/hiring/leads.service';

const HIRING = '/api/v1/hiring';
const PUBLIC = '/api/v1/public/apply';
const CONSENT =
  'By submitting, you agree to be contacted about employment opportunities by phone, email, or SMS.';

/**
 * Automatic lead rotation and "My leads" (owner, 2026-10-07).
 *
 * The rotation runs in companies of its own, written directly, so the order is exactly what the
 * test sets up: Greta became a recruiter when she was hired; Marina, an older employee, was moved
 * to Recruiter three minutes later (the production shape); a third recruiter was added an hour
 * after that. Leads must go Greta, Marina, third, Greta.
 */
describe('Lead rotation and My leads (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const companyId = `co_rot_${stamp}`;
  const emptyCompanyId = `co_rot_empty_${stamp}`;
  const slug = `rot-${stamp}`;
  const emptySlug = `rot-empty-${stamp}`;
  const ids = { grace: `emp_g_${stamp}`, marina: `emp_m_${stamp}`, third: `emp_t_${stamp}`, quality: `emp_q_${stamp}` };
  const t0 = new Date('2026-10-07T16:53:43Z');
  let address = 10;
  let phoneSeq = 0;
  const base = String(Math.floor(100 + Math.random() * 800));

  const call = (
    method: 'GET' | 'POST' | 'PATCH',
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

  const nextPhone = () => `(312) 55${base.slice(0, 1)}-${base.slice(1)}${String((phoneSeq += 1) % 100).padStart(2, '0')}`;
  const submit = (target: string, name: string, phone = nextPhone()) =>
    call(
      'POST',
      `${PUBLIC}/${target}`,
      {
        submissionId: crypto.randomUUID(),
        fullName: name,
        phone,
        experience: '2 years',
        position: 'Company driver',
        consent: true,
        website: '',
      },
      {},
      `10.9.${Math.floor(address / 250)}.${(address += 1) % 250}`,
    );

  const leadByName = async (company: string, name: string) => {
    const [first, ...rest] = name.split(' ');
    const [row] = await db
      .select()
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, company), eq(hiringLeads.firstName, first ?? ''), eq(hiringLeads.lastName, rest.join(' '))))
      .limit(1);
    return row;
  };

  const employee = (id: string, first: string, last: string, position: string, createdAt: Date) => ({
    id,
    companyId,
    employeeNumber: id,
    firstName: first,
    lastName: last,
    workEmail: `${id}@test.local`,
    phone: '3125550100',
    department: 'hr',
    position,
    hireDate: '2026-01-01',
    status: 'active',
    employmentType: 'full_time',
    createdAt,
    updatedAt: createdAt,
  });
  const history = (employeeId: string, position: string, createdAt: Date, n: number) => ({
    id: `poh_${employeeId}_${n}`,
    companyId,
    employeeId,
    position,
    department: 'hr',
    effectiveFrom: '2026-10-07',
    createdAt,
  });

  const principalFor = (company: string): Principal => ({
    userId: 'e2e',
    userName: 'E2E manager',
    companyId: company,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: [],
    permissions: new Set(['recruiting.view', 'recruiting.manage']),
  });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;

    await db.insert(companies).values([
      { id: companyId, name: `Rotation Carrier ${stamp}` },
      { id: emptyCompanyId, name: `No Recruiters ${stamp}` },
    ]);
    for (const [id, company, s] of [
      [`alink_rot_${stamp}`, companyId, slug],
      [`alink_rot_empty_${stamp}`, emptyCompanyId, emptySlug],
    ] as const) {
      await db.insert(hiringApplyLinks).values({
        id,
        companyId: company,
        slug: s,
        name: `Website ${s}`,
        source: 'website',
        consentText: CONSENT,
        privacyPolicyUrl: 'https://example.com/privacy',
        createdBy: 'e2e',
      });
    }
    const min = (m: number) => new Date(t0.getTime() + m * 60_000);
    await db.insert(employees).values([
      // Marina's record is the oldest; she became a recruiter after Greta did.
      employee(ids.marina, 'Marina', `Valentine${stamp}`, 'Recruiter', min(-100 * 24 * 60)),
      employee(ids.grace, 'Greta', `Harper${stamp}`, 'Recruiter', t0),
      employee(ids.third, 'Tess', `Third${stamp}`, 'Senior Recruiter', min(60)),
      employee(ids.quality, 'Quinn', `Quality${stamp}`, 'Quality Specialist', min(-10)),
    ]);
    await db.insert(positionHistory).values([
      history(ids.marina, 'Dispatcher', min(-100 * 24 * 60), 1),
      history(ids.grace, 'Recruiter', t0, 1),
      history(ids.marina, 'Recruiter', min(3), 2),
      history(ids.third, 'Senior Recruiter', min(60), 1),
      history(ids.quality, 'Quality Specialist', min(-10), 1),
    ]);
    // Since 0048 the rotation is of accounts: each recruiter signs in with a linked account.
    await linkAccounts(companyId, [ids.grace, ids.marina, ids.third, ids.quality]);
  }, 120_000);

  /** One active account per employee, linked through the membership (Administration › Users). */
  async function linkAccounts(company: string, employeeIds: string[]) {
    for (const employeeId of employeeIds) {
      const userId = `usr_${employeeId}`;
      await db.insert(users).values({ id: userId, email: `${userId}@test.local`, firstName: 'Rot', lastName: employeeId, isActive: true });
      await db.insert(memberships).values({ id: `mem_${employeeId}`, companyId: company, userId, employeeId, status: 'active' });
    }
  }

  afterAll(async () => {
    await app.close();
  });

  it('orders recruiters by when they became one: Greta, Marina, then the newer one', async () => {
    const rotation = await app.get(LeadRotationService).describe(principalFor(companyId));
    expect(rotation.recruiters.map((r) => r.employeeId)).toEqual([ids.grace, ids.marina, ids.third]);
    expect(rotation.next?.employeeId).toBe(ids.grace);
    expect(rotation.last).toBeNull();
  });

  it('new online leads go Greta, Marina, third, Greta — audited, and the lead carries the name', async () => {
    const names = ['Alan One', 'Bea Two', 'Cy Three', 'Dee Four'].map((n) => `${n}${stamp}`);
    for (const name of names) {
      const res = await submit(slug, name);
      expect(res.statusCode, res.body).toBe(201);
    }
    const got = [];
    for (const name of names) got.push((await leadByName(companyId, name))?.recruiterEmployeeId);
    expect(got).toEqual([ids.grace, ids.marina, ids.third, ids.grace]);

    const first = await leadByName(companyId, names[0] ?? '');
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.entityId, first?.id ?? ''), eq(auditLogs.action, 'auto_assign')));
    expect(entry?.actorType).toBe('system');
    expect(entry?.summary).toContain(`Greta Harper${stamp}`);
  });

  it('a lead applying again keeps its recruiter and takes no turn', async () => {
    const name = `Eve Again${stamp}`;
    const phone = nextPhone();
    expect((await submit(slug, name, phone)).statusCode).toBe(201); // Marina's turn
    const lead = await leadByName(companyId, name);
    expect(lead?.recruiterEmployeeId).toBe(ids.marina);
    expect((await submit(slug, name, phone)).statusCode).toBe(201);
    expect((await leadByName(companyId, name))?.recruiterEmployeeId).toBe(ids.marina);
    const rotation = await app.get(LeadRotationService).describe(principalFor(companyId));
    expect(rotation.next?.employeeId).toBe(ids.third);
  });

  it('a manual reassignment does not move the rotation', async () => {
    const lead = await leadByName(companyId, `Eve Again${stamp}`);
    await app.get(LeadsService).update(principalFor(companyId), lead?.id ?? '', { recruiterEmployeeId: ids.grace });
    expect((await leadByName(companyId, `Eve Again${stamp}`))?.recruiterEmployeeId).toBe(ids.grace);
    const rotation = await app.get(LeadRotationService).describe(principalFor(companyId));
    expect(rotation.last?.employeeId).toBe(ids.marina);
    expect(rotation.next?.employeeId).toBe(ids.third);
  });

  it('six applications at the same instant still take strict turns, no skips or doubles', async () => {
    const before = await app.get(LeadRotationService).describe(principalFor(companyId));
    expect(before.next?.employeeId).toBe(ids.third);
    const names = Array.from({ length: 6 }, (_, i) => `Con${'abcdef'[i]} Current${stamp}`);
    const results = await Promise.all(names.map((n) => submit(slug, n)));
    for (const r of results) expect(r.statusCode, r.body).toBe(201);
    const turns = await db
      .select({ changes: auditLogs.changes })
      .from(auditLogs)
      .where(and(eq(auditLogs.companyId, companyId), eq(auditLogs.action, 'auto_assign')))
      .orderBy(asc(auditLogs.at));
    const order = turns.slice(-6).map((t) => (t.changes as { field: string; new: string }[]).find((c) => c.field === 'recruiterEmployeeId')?.new);
    expect(order).toEqual([ids.third, ids.grace, ids.marina, ids.third, ids.grace, ids.marina]);
    const assigned = [];
    for (const n of names) assigned.push((await leadByName(companyId, n))?.recruiterEmployeeId);
    expect(assigned.filter((a) => a === ids.grace)).toHaveLength(2);
    expect(assigned.filter((a) => a === ids.marina)).toHaveLength(2);
    expect(assigned.filter((a) => a === ids.third)).toHaveLength(2);
  });

  it('a recruiter who left is stepped over, and the turn after them continues in order', async () => {
    // Last turn was Marina; Tess (next) leaves.
    await db.update(employees).set({ status: 'terminated' }).where(eq(employees.id, ids.third));
    expect((await submit(slug, `Fay Skip${stamp}`)).statusCode).toBe(201);
    expect((await leadByName(companyId, `Fay Skip${stamp}`))?.recruiterEmployeeId).toBe(ids.grace);
    // Greta stops recruiting: from Greta's place the next is Marina, then Marina again.
    await db.update(employees).set({ position: 'Quality Specialist' }).where(eq(employees.id, ids.grace));
    expect((await submit(slug, `Gus Skip${stamp}`)).statusCode).toBe(201);
    expect((await leadByName(companyId, `Gus Skip${stamp}`))?.recruiterEmployeeId).toBe(ids.marina);
    expect((await submit(slug, `Hal Skip${stamp}`)).statusCode).toBe(201);
    expect((await leadByName(companyId, `Hal Skip${stamp}`))?.recruiterEmployeeId).toBe(ids.marina);
  });

  it('with no recruiters the lead arrives unassigned, as before', async () => {
    expect((await submit(emptySlug, `Ivy Nobody${stamp}`)).statusCode).toBe(201);
    const lead = await leadByName(emptyCompanyId, `Ivy Nobody${stamp}`);
    expect(lead).toBeDefined();
    expect(lead?.recruiterEmployeeId).toBeNull();
    const rotation = await app.get(LeadRotationService).describe(principalFor(emptyCompanyId));
    expect(rotation.recruiters).toEqual([]);
    expect(rotation.next).toBeNull();
  });

  it('a position changed without a history row is ordered by its audit entry, else its last change', async () => {
    const co = `co_rot_audit_${stamp}`;
    await db.insert(companies).values({ id: co, name: `Audit Order ${stamp}` });
    const at = (m: number) => new Date(t0.getTime() + m * 60_000);
    const make = (id: string, first: string, created: Date, updated: Date) => ({
      ...employee(id, first, `Order${stamp}`, 'Recruiter', created),
      companyId: co,
      updatedAt: updated,
    });
    await db.insert(employees).values([
      make(`emp_olga_${stamp}`, 'Olga', at(-5000), at(10)),
      make(`emp_nina_${stamp}`, 'Nina', at(5), at(5)),
      make(`emp_ed_${stamp}`, 'Ed', at(-6000), at(20)),
    ]);
    await db.insert(positionHistory).values([
      { ...history(`emp_olga_${stamp}`, 'Dispatcher', at(-5000), 1), companyId: co },
      { ...history(`emp_nina_${stamp}`, 'Recruiter', at(5), 1), companyId: co },
      { ...history(`emp_ed_${stamp}`, 'Dispatcher', at(-6000), 1), companyId: co },
    ]);
    await linkAccounts(co, [`emp_olga_${stamp}`, `emp_nina_${stamp}`, `emp_ed_${stamp}`]);
    await db.insert(auditLogs).values({
      id: `aud_olga_${stamp}`,
      companyId: co,
      actorName: 'e2e',
      action: 'update',
      entityType: 'employee',
      entityId: `emp_olga_${stamp}`,
      entityLabel: 'Olga',
      summary: 'Position changed',
      changes: [{ field: 'position', old: 'Dispatcher', new: 'Recruiter' }],
      at: at(8),
    });
    const rotation = await app.get(LeadRotationService).describe(principalFor(co));
    expect(rotation.recruiters.map((r) => r.name.split(' ')[0])).toEqual(['Nina', 'Olga', 'Ed']);
  });

  it('the rotation route answers for the signed-in company', async () => {
    const res = await call('GET', `${HIRING}/lead-rotation`);
    expect(res.statusCode, res.body).toBe(200);
    expect(Array.isArray(res.json().recruiters)).toBe(true);
  });

  // ------------------------------------------------------------------ accounts, notes, my leads

  describe('My leads, notes and the account link (demo company)', () => {
    let recruiterId: string;
    let otherRecruiterId: string;
    let recruiterAccount: string;
    let viewerAccount: string;
    let leadId: string;
    const recruiterEmail = `rec.${stamp}@test.local`;
    const viewerEmail = `rec.viewer.${stamp}@test.local`;
    const as = (email: string) => ({ 'x-account': email });

    async function account(email: string, roleId: string): Promise<string> {
      const created = await call('POST', '/api/v1/admin/users', {
        firstName: 'Rae',
        lastName: `Recruit${stamp}`,
        email,
        phone: null,
        employeeId: null,
        roleIds: [roleId],
        invite: false,
      });
      expect(created.statusCode, created.body).toBe(201);
      const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
      const activated = await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'lead rotation e2e' });
      expect(activated.statusCode, activated.body).toBe(200);
      await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
      // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
      await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
      return membershipId;
    }

    async function recruiterEmployee(first: string): Promise<string> {
      const res = await call('POST', '/api/v1/employees', {
        firstName: first,
        lastName: `Rot${stamp}`,
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

    beforeAll(async () => {
      recruiterId = await recruiterEmployee('Rhea');
      otherRecruiterId = await recruiterEmployee('Otto');
      const workRole = await call('POST', '/api/v1/admin/roles', {
        name: `Recruiter e2e ${stamp}`,
        permissions: ['recruiting.view', 'recruiting.manage'],
      });
      expect(workRole.statusCode, workRole.body).toBe(201);
      recruiterAccount = await account(recruiterEmail, (workRole.json() as { id: string }).id);
      const viewRole = await call('POST', '/api/v1/admin/roles', {
        name: `Recruiting read only ${stamp}`,
        permissions: ['recruiting.view'],
      });
      expect(viewRole.statusCode, viewRole.body).toBe(201);
      viewerAccount = await account(viewerEmail, (viewRole.json() as { id: string }).id);
      const lead = await call('POST', `${HIRING}/leads`, {
        firstName: 'Nora',
        lastName: `Notes${stamp}`,
        phone: `+1415${String(Date.now()).slice(-6)}`,
        source: 'website',
        recruiterEmployeeId: recruiterId,
      });
      expect(lead.statusCode, lead.body).toBe(201);
      leadId = (lead.json() as Lead).id;
    });

    afterAll(async () => {
      for (const m of [recruiterAccount, viewerAccount]) {
        if (m) await call('PATCH', `/api/v1/admin/users/${m}/status`, { status: 'disabled', reason: 'lead rotation e2e cleanup' });
      }
      // The demo company keeps no test recruiters in its rotation.
      await db.update(employees).set({ status: 'terminated' }).where(and(eq(employees.id, recruiterId)));
      await db.update(employees).set({ status: 'terminated' }).where(and(eq(employees.id, otherRecruiterId)));
    });

    it('an account not linked to an employee gets no recruiter and no leads', async () => {
      const res = await call('GET', `${HIRING}/my-leads`, undefined, as(recruiterEmail));
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual({ recruiter: null, leads: [] });
    });

    it('an administrator links the account to its employee — audited, one account per employee, this company only', async () => {
      const linked = await call('PATCH', `/api/v1/admin/users/${recruiterAccount}/employee`, { employeeId: recruiterId });
      expect(linked.statusCode, linked.body).toBe(200);
      expect(linked.json().employeeId).toBe(recruiterId);
      const [entry] = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'user'), eq(auditLogs.entityId, recruiterAccount)))
        .orderBy(asc(auditLogs.at));
      expect(entry).toBeDefined();
      const audits = await db
        .select({ summary: auditLogs.summary })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityType, 'user'), eq(auditLogs.entityId, recruiterAccount)));
      expect(audits.map((a) => a.summary)).toContain(`Linked to employee Rhea Rot${stamp}`);

      const taken = await call('PATCH', `/api/v1/admin/users/${viewerAccount}/employee`, { employeeId: recruiterId });
      expect(taken.statusCode).toBe(409);
      const foreign = await call('PATCH', `/api/v1/admin/users/${viewerAccount}/employee`, { employeeId: ids.marina });
      expect(foreign.statusCode).toBe(422);
      const denied = await call('PATCH', `/api/v1/admin/users/${viewerAccount}/employee`, { employeeId: otherRecruiterId }, as(viewerEmail));
      expect(denied.statusCode).toBe(403);
    });

    it('notes: a recruiter writes them, history is newest first with who and when, audited', async () => {
      const empty = await call('POST', `${HIRING}/leads/${leadId}/notes`, { note: '   ' }, as(recruiterEmail));
      expect(empty.statusCode).toBe(422);
      const one = await call('POST', `${HIRING}/leads/${leadId}/notes`, { note: 'Called, will call back at 3' }, as(recruiterEmail));
      expect(one.statusCode, one.body).toBe(201);
      const two = await call('POST', `${HIRING}/leads/${leadId}/notes`, { note: 'Sent the job details by text' }, as(recruiterEmail));
      expect(two.statusCode, two.body).toBe(201);
      const readOnly = await call('POST', `${HIRING}/leads/${leadId}/notes`, { note: 'no' }, as(viewerEmail));
      expect(readOnly.statusCode).toBe(403);

      const list = await call('GET', `${HIRING}/leads/${leadId}/notes`, undefined, as(viewerEmail));
      expect(list.statusCode, list.body).toBe(200);
      const notes = list.json() as LeadNote[];
      expect(notes.map((n) => n.text)).toEqual(['Sent the job details by text', 'Called, will call back at 3']);
      expect(notes[0]?.byName).toBe(`Rae Recruit${stamp}`);
      expect(notes[0]?.kind).toBe('note');
      const audited = await db
        .select()
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, leadId), eq(auditLogs.action, 'note')));
      expect(audited).toHaveLength(2);
    });

    it("another company's lead cannot be read or noted", async () => {
      const foreign = await leadByName(companyId, `Alan One${stamp}`);
      expect((await call('GET', `${HIRING}/leads/${foreign?.id}/notes`)).statusCode).toBe(404);
      expect((await call('POST', `${HIRING}/leads/${foreign?.id}/notes`, { note: 'x' })).statusCode).toBe(404);
    });

    it('My leads lists the linked recruiter’s leads with the newest note', async () => {
      const res = await call('GET', `${HIRING}/my-leads`, undefined, as(recruiterEmail));
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json() as MyLeads;
      expect(body.recruiter?.employeeId).toBe(recruiterId);
      expect(body.recruiter?.isRecruiter).toBe(true);
      const row = body.leads.find((l) => l.id === leadId);
      expect(row?.lastNote?.text).toBe('Sent the job details by text');
      expect(body.leads.every((l) => l.id !== undefined)).toBe(true);
    });

    it("only a recruiting manager may open another recruiter's leads", async () => {
      const viewer = await call('GET', `${HIRING}/my-leads?recruiterEmployeeId=${recruiterId}`, undefined, as(viewerEmail));
      expect(viewer.statusCode).toBe(403);
      const manager = await call('GET', `${HIRING}/my-leads?recruiterEmployeeId=${recruiterId}`);
      expect(manager.statusCode, manager.body).toBe(200);
      expect((manager.json() as MyLeads).leads.some((l) => l.id === leadId)).toBe(true);
      const foreign = await call('GET', `${HIRING}/my-leads?recruiterEmployeeId=${ids.grace}`);
      expect(foreign.statusCode).toBe(404);
    });

    it('a lead added by hand with no recruiter named takes the next turn in the rotation (owner, 2026-10-08)', async () => {
      const res = await call(
        'POST',
        `${HIRING}/leads`,
        { firstName: 'Hand', lastName: `Made${stamp}`, phone: `+1646${String(Date.now()).slice(-6)}`, source: 'referral' },
        as(recruiterEmail),
      );
      expect(res.statusCode, res.body).toBe(201);
      const lead = res.json() as Lead;
      const [turn] = await db
        .select({ changes: auditLogs.changes })
        .from(auditLogs)
        .where(and(eq(auditLogs.entityId, lead.id), eq(auditLogs.action, 'auto_assign')));
      expect(turn).toBeDefined();
      const picked = (turn?.changes as { field: string; new: string }[]).find((c) => c.field === 'recruiterEmployeeId')?.new;
      expect(lead.recruiterEmployeeId).toBe(picked);
    });
  });
});
