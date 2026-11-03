import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  CareLink,
  DriverRelationCounts,
  DriverRelationDetail,
  DriverRelationPage,
  DriverRelationTopic,
} from '@neway/shared';
import { and, count, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';
import {
  acctDriverTransactions,
  acctExpenses,
  acctJournalEntries,
  acctSettlements,
} from '../src/database/schema/accounting';
import {
  driverCareLinks,
  driverRelationActivities,
  driverRelationAttachments,
  driverRelationOutbox,
  driverRelationRequests,
} from '../src/database/schema/driver-relations';
import { hiringLeads } from '../src/database/schema/hiring';
import { companies } from '../src/database/schema/roster';
import { DriverRelationsService } from '../src/modules/driver-relations/driver-relations.service';
import { DriverRelationsOutboxWorker } from '../src/modules/driver-relations/outbox.worker';
import { TelegramAdapter } from '../src/modules/driver-relations/telegram.adapter';
import { DEMO_COMPANY } from '../src/modules/reporting/demo/demo-company';

const DR = '/api/v1/driver-relations';
const PUBLIC = '/api/v1/public/driver-care';

/**
 * Driver Relations end to end against the real database (owner brief 2026-10-06, acceptance
 * tests): the six Driver Care forms persist in their topics and survive a restart; a retry is one
 * request; the badge moves by one on a new request and only on a recorded contact; viewing,
 * assigning and attempts leave it alone; contact needs a note; two staff racing on one version
 * decrement it once; resolve needs a note and a contact; a new driver message brings the alert
 * back; another company's requests are invisible even by id; a disconnected Telegram sends
 * nothing; and no money table is touched.
 */
describe('Driver Relations (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const slug = `care-${stamp}`;
  const otherSlug = `care-other-${stamp}`;
  const otherCompanyId = `co_e2e_dr_${stamp}`;
  const companyId = DEMO_COMPANY.id;
  const tail = () => String(Math.floor(1000 + Math.random() * 8999));
  const phoneA = `(312) 555-${tail()}`;
  const phoneB = `(312) 556-${tail()}`;
  const referralPhone = `(312) 557-${tail()}`;
  let address = 10;
  const nextAddress = () => `10.9.${Math.floor(address / 250)}.${(address += 1) % 250}`;
  let agent = '';
  let readOnly = '';
  let contactOnly = '';
  const call_ = (method: 'GET' | 'POST' | 'PATCH', url: string, account: string, payload?: unknown) =>
    call(method, url, payload, { 'x-account': account });

  const call = (
    method: 'GET' | 'POST' | 'PATCH',
    url: string,
    payload?: unknown,
    headers: Record<string, string> = {},
  ) =>
    app.inject({
      method,
      url,
      remoteAddress: nextAddress(),
      headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const counts = async (): Promise<DriverRelationCounts> => (await call('GET', `${DR}/counts`)).json();
  const detail = async (id: string): Promise<DriverRelationDetail> => {
    const res = await call('GET', `${DR}/requests/${id}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json();
  };
  const byNumber = async (reference: string) => {
    const page = (await call('GET', `${DR}/requests?q=${reference}&pageSize=10`)).json() as DriverRelationPage;
    const found = page.data.find((r) => r.requestNumber === reference);
    if (!found) throw new Error(`no request ${reference}`);
    return found;
  };

  const forms: Record<DriverRelationTopic, () => Record<string, unknown>> = {
    referral: () => ({
      topic: 'referral',
      name: `Rafael Ref${stamp}`,
      truckNumber: '9006',
      referralName: `Jamie West${stamp}`,
      referralPhone,
    }),
    complaint_feedback: () => ({
      topic: 'complaint_feedback',
      name: `Casey Brooks${stamp}`,
      truckNumber: '0075',
      phone: phoneB,
      details: 'I want a clearer update about the next load.',
    }),
    reimbursement: () => ({
      topic: 'reimbursement',
      name: `Sam Taylor${stamp}`,
      truckNumber: '303',
      phone: phoneB,
      amount: 85,
      loadNumber: 'L-1001',
      details: 'Paid the lumper in cash, receipt kept.',
    }),
    pay_statement: () => ({
      topic: 'pay_statement',
      name: `Jordan Lee${stamp}`,
      truckNumber: '2309',
      phone: phoneB,
      details: 'Load L-1008 is missing from my last statement.',
      weekStart: '2026-09-28',
      loadNumber: 'L-1008',
    }),
    compliance: () => ({
      topic: 'compliance',
      name: `Chris Parker${stamp}`,
      truckNumber: '0040',
      phone: phoneB,
      subject: 'medical_card',
      details: 'I need help updating my medical card.',
    }),
    management_call: () => ({
      topic: 'management_call',
      name: `Alex Morgan${stamp}`,
      truckNumber: '1189',
      phone: phoneA,
      callTopic: 'dispatch_work',
      preferredTime: 'After 3 PM Central',
      details: 'I would like to speak with management about my schedule.',
    }),
  };

  const submit = (body: Record<string, unknown>, target = slug) =>
    call('POST', `${PUBLIC}/${target}`, { submissionId: crypto.randomUUID(), website: '', ...body });

  const references: Partial<Record<DriverRelationTopic, string>> = {};

  async function accountWithRole(roleId: string, email: string): Promise<string> {
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: 'Dee',
      lastName: 'Relations',
      email,
      phone: null,
      employeeId: null,
      roleIds: [roleId],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    const activated = await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'driver relations e2e' });
    expect(activated.statusCode, activated.body).toBe(200);
    await db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    return membershipId;
  }

  const ledgerCounts = async () => {
    const one = async (table: typeof acctExpenses | typeof acctDriverTransactions | typeof acctSettlements | typeof acctJournalEntries) =>
      (await db.select({ value: count() }).from(table).where(eq(table.companyId, companyId)))[0]?.value ?? 0;
    return {
      expenses: await one(acctExpenses),
      driverTransactions: await one(acctDriverTransactions),
      settlements: await one(acctSettlements),
      journal: await one(acctJournalEntries),
    };
  };
  let ledgerBefore: Awaited<ReturnType<typeof ledgerCounts>>;

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    ledgerBefore = await ledgerCounts();

    const roles = (await call('GET', '/api/v1/admin/roles')).json() as { id: string; code: string }[];
    const agentRole = roles.find((r) => r.code === 'driver_relations');
    if (!agentRole) throw new Error('the Driver Relations role is not seeded');
    agent = await accountWithRole(agentRole.id, `dr.agent.${stamp}@test.local`);
    const viewRole = await call('POST', '/api/v1/admin/roles', {
      name: `DR read only ${stamp}`,
      permissions: ['driver_relations.view'],
    });
    expect(viewRole.statusCode, viewRole.body).toBe(201);
    readOnly = await accountWithRole((viewRole.json() as { id: string }).id, `dr.readonly.${stamp}@test.local`);
    const contactRole = await call('POST', '/api/v1/admin/roles', {
      name: `DR contact no confidential ${stamp}`,
      permissions: ['driver_relations.view', 'driver_relations.contact'],
    });
    expect(contactRole.statusCode, contactRole.body).toBe(201);
    contactOnly = await accountWithRole((contactRole.json() as { id: string }).id, `dr.contact.${stamp}@test.local`);

    await db.insert(companies).values({ id: otherCompanyId, name: `Other Carrier DR ${stamp}` });
    await db.insert(driverCareLinks).values({
      id: `dcl_other_${stamp}`,
      companyId: otherCompanyId,
      slug: otherSlug,
      name: 'Other carrier care',
      createdBy: 'e2e',
    });
  });

  afterAll(async () => {
    for (const membershipId of [agent, readOnly, contactOnly]) {
      if (membershipId) {
        await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'disabled', reason: 'driver relations e2e cleanup' });
      }
    }
    await app.close();
  });

  it('a manager creates the Driver Care link; the agent role cannot', async () => {
    const denied = await call('POST', `${DR}/care-links`, { name: 'Nope', slug: `${slug}-x` }, { 'x-account': agent });
    expect(denied.statusCode).toBe(403);
    const res = await call('POST', `${DR}/care-links`, { name: 'NWF Driver Care', slug });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json() as CareLink).toMatchObject({ slug, active: true, requestCount: 0 });
    const taken = await call('POST', `${DR}/care-links`, { name: 'Again', slug });
    expect(taken.statusCode).toBe(409);
  });

  it('the public page learns the company name from the slug and nothing else', async () => {
    const res = await call('GET', `${PUBLIC}/${slug}`);
    expect(res.statusCode).toBe(200);
    expect(res.headers['access-control-allow-origin']).toBe('*');
    expect(Object.keys(res.json()).sort()).toEqual(['companyName', 'displayName']);
    expect((await call('GET', `${PUBLIC}/no-such-${stamp}`)).statusCode).toBe(404);
    expect((await call('GET', `${PUBLIC}/${slug}?companyId=${otherCompanyId}`)).statusCode).toBe(400);
  });

  it('all six topics persist in their topic, survive a restart, and each adds one to the badge', async () => {
    const before = await counts();
    for (const topic of Object.keys(forms) as DriverRelationTopic[]) {
      const res = await submit(forms[topic]());
      expect(res.statusCode, res.body).toBe(201);
      const receipt = res.json() as { status: string; reference: string };
      expect(receipt.status).toBe('received');
      expect(receipt.reference).toMatch(/^DR-\d+$/);
      references[topic] = receipt.reference;
    }
    const after = await counts();
    expect(after.needsContact).toBe(before.needsContact + 6);
    for (const topic of Object.keys(forms) as DriverRelationTopic[]) {
      expect(after.byTopic[topic].needsContact).toBe(before.byTopic[topic].needsContact + 1);
    }

    // A restart: a fresh application over the same database reads every one back.
    await app.close();
    app = await createApp();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    for (const topic of Object.keys(forms) as DriverRelationTopic[]) {
      const request = await byNumber(references[topic]!);
      expect(request.topic).toBe(topic);
      expect(request.needsContact).toBe(true);
      expect(request.status).toBe('new');
      expect(request.driverId).toBeNull();
    }
    const call_ = await byNumber(references.management_call!);
    expect(call_.payload).toMatchObject({ preferredTime: 'After 3 PM Central', callTopic: 'dispatch_work' });
    expect(call_.confidential).toBe(false);
    expect((await byNumber(references.complaint_feedback!)).confidential).toBe(true);
    expect(call_.contactPhone).toMatch(/^\+1312555\d{4}$/);
    const pay = await byNumber(references.pay_statement!);
    expect(pay.payload).toMatchObject({ weekStart: '2026-09-28', loadNumber: 'L-1008' });
    expect(pay.payload).not.toHaveProperty('topic');
  });

  it('a referral also lands in HR → Recruiting as one lead (source referral), linked to the request', async () => {
    const request = await byNumber(references.referral!);
    expect(request.contactPhone).toBeNull();
    expect(request.hrLeadId).toBeTruthy();
    expect(request.hrLeadNumber).toMatch(/^LEAD-/);
    const [lead] = await db.select().from(hiringLeads).where(eq(hiringLeads.id, request.hrLeadId!));
    expect(lead).toMatchObject({ companyId, source: 'referral', status: 'new', firstName: 'Jamie' });

    // The same referred driver sent again: a second request (another driver's referral claim), the
    // same HR lead, never a duplicate lead.
    const again = await submit({ ...forms.referral(), name: `Other Referrer${stamp}`, truckNumber: '777' });
    expect(again.statusCode, again.body).toBe(201);
    const second = await byNumber((again.json() as { reference: string }).reference);
    expect(second.id).not.toBe(request.id);
    expect(second.hrLeadId).toBe(request.hrLeadId);
    const leads = await db
      .select({ value: count() })
      .from(hiringLeads)
      .where(and(eq(hiringLeads.companyId, companyId), sql`${hiringLeads.phone} = ${lead!.phone}`));
    expect(leads[0]?.value).toBe(1);
  });

  it('a retried submission is the same request, and the badge does not move', async () => {
    const body = { ...forms.compliance(), submissionId: crypto.randomUUID(), name: `Retry Driver${stamp}`, phone: `(312) 558-${tail()}` };
    const first = await call('POST', `${PUBLIC}/${slug}`, body);
    expect(first.statusCode, first.body).toBe(201);
    const mid = await counts();
    const second = await call('POST', `${PUBLIC}/${slug}`, body);
    expect(second.statusCode).toBe(201);
    expect(second.json()).toEqual(first.json());
    expect((await counts()).needsContact).toBe(mid.needsContact);
  });

  it('validates on the server: phone, required fields, size, and the honeypot saves nothing', async () => {
    const badPhone = await submit({ ...forms.management_call(), phone: '123' });
    expect(badPhone.statusCode).toBe(422);
    expect(badPhone.json().errors.map((e: { path: string }) => e.path)).toContain('phone');
    const missing = await submit({ topic: 'pay_statement', name: 'X Y', truckNumber: '1', phone: phoneB });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().errors.map((e: { path: string }) => e.path)).toContain('details');
    const unknownTopic = await submit({ topic: 'pay_raise', name: 'X Y', truckNumber: '1', phone: phoneB, details: 'x' });
    expect(unknownTopic.statusCode).toBe(422);
    const huge = await submit({ ...forms.pay_statement(), details: 'x'.repeat(20_000) });
    expect([413, 422]).toContain(huge.statusCode);

    const before = await counts();
    const bot = await submit({ ...forms.complaint_feedback(), website: 'http://spam.example' });
    expect(bot.statusCode).toBe(201);
    expect(bot.json()).toEqual({ status: 'received', reference: null });
    expect((await counts()).needsContact).toBe(before.needsContact);
  });

  it('opening, assigning and recording an attempt leave the alert and the count alone', async () => {
    const request = await byNumber(references.management_call!);
    const before = await counts();
    await detail(request.id);
    const assignees = (await call('GET', `${DR}/assignees`)).json() as { userId: string; name: string }[];
    expect(assignees.length).toBeGreaterThan(0);
    const assigned = await call('PATCH', `${DR}/requests/${request.id}/assignment`, {
      assigneeUserId: assignees[0]!.userId,
      expectedVersion: request.version,
    });
    expect(assigned.statusCode, assigned.body).toBe(200);
    const attempt = await call('POST', `${DR}/requests/${request.id}/attempts`, { method: 'phone', note: 'Tried calling, no answer' });
    expect(attempt.statusCode, attempt.body).toBe(201);
    const after = await detail(request.id);
    expect(after.request.needsContact).toBe(true);
    expect(after.request.status).toBe('new');
    expect(after.activities.map((a) => a.type)).toEqual(expect.arrayContaining(['received', 'assigned', 'attempt']));
    expect((await counts()).needsContact).toBe(before.needsContact);

    const noNote = await call('POST', `${DR}/requests/${request.id}/attempts`, { method: 'phone', note: '   ' });
    expect(noNote.statusCode).toBe(422);
  });

  it('contact needs a real note, and clears only that request', async () => {
    const request = await byNumber(references.management_call!);
    const other = await byNumber(references.compliance!);
    for (const note of ['', '   \n ']) {
      const res = await call('POST', `${DR}/requests/${request.id}/contact`, { method: 'phone', note, expectedVersion: request.version });
      expect(res.statusCode).toBe(422);
    }
    const before = await counts();
    const res = await call('POST', `${DR}/requests/${request.id}/contact`, {
      method: 'phone',
      note: 'Spoke with Alex; management will call Thursday.',
      expectedVersion: request.version,
    });
    expect(res.statusCode, res.body).toBe(201);
    const after = res.json() as DriverRelationDetail;
    expect(after.request).toMatchObject({ needsContact: false, status: 'contacted' });
    expect(after.request.contactedAt).toBeTruthy();
    const contacted = after.activities.find((a) => a.type === 'contacted');
    expect(contacted).toMatchObject({ method: 'phone', note: 'Spoke with Alex; management will call Thursday.' });
    const now = await counts();
    expect(now.needsContact).toBe(before.needsContact - 1);
    expect(now.byTopic.management_call.needsContact).toBe(before.byTopic.management_call.needsContact - 1);
    expect(now.byTopic.compliance.needsContact).toBe(before.byTopic.compliance.needsContact);
    expect((await detail(other.id)).request.needsContact).toBe(true);
  });

  it('two staff contacting on the same version: one saves, one gets 409, the badge moves once', async () => {
    const request = await byNumber(references.pay_statement!);
    const before = await counts();
    const [a, b] = await Promise.all([
      call('POST', `${DR}/requests/${request.id}/contact`, { method: 'phone', note: 'Agent A spoke with Jordan.', expectedVersion: request.version }),
      call(
        'POST',
        `${DR}/requests/${request.id}/contact`,
        { method: 'sms', note: 'Agent B texted Jordan.', expectedVersion: request.version },
        { 'x-account': agent },
      ),
    ]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const loser = a.statusCode === 409 ? a : b;
    expect(loser.json().detail).toMatch(/Nothing was saved/);
    expect((await counts()).needsContact).toBe(before.needsContact - 1);
    const after = await detail(request.id);
    expect(after.activities.filter((x) => x.type === 'contacted')).toHaveLength(1);
  });

  it('contacted can stay unresolved; resolving needs a note, and is refused before contact', async () => {
    const uncontacted = await byNumber(references.compliance!);
    const blocked = await call('POST', `${DR}/requests/${uncontacted.id}/resolve`, {
      note: 'Closing it',
      expectedVersion: uncontacted.version,
    });
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json().detail).toMatch(/Record contact/);
    expect((await detail(uncontacted.id)).request.needsContact).toBe(true);

    const contacted = await byNumber(references.management_call!);
    expect(contacted.status).toBe('contacted');
    const noNote = await call('POST', `${DR}/requests/${contacted.id}/resolve`, { note: ' ', expectedVersion: contacted.version });
    expect(noNote.statusCode).toBe(422);
    const resolved = await call('POST', `${DR}/requests/${contacted.id}/resolve`, {
      note: 'Call held; schedule changed.',
      expectedVersion: contacted.version,
    });
    expect(resolved.statusCode, resolved.body).toBe(201);
    expect((resolved.json() as DriverRelationDetail).request.status).toBe('resolved');
  });

  it('a new driver message brings the alert back, without a second request', async () => {
    // Through Driver Care: the same driver, phone and topic on an open request joins its thread.
    const pay = await byNumber(references.pay_statement!);
    expect(pay.needsContact).toBe(false);
    const before = await counts();
    const res = await submit({ ...forms.pay_statement(), details: 'Still missing, please check.' });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as { reference: string }).reference).toBe(references.pay_statement);
    const after = await detail(pay.id);
    expect(after.request.needsContact).toBe(true);
    expect(after.request.status).toBe('contacted');
    expect(after.activities.filter((a) => a.type === 'driver_message')).toHaveLength(1);
    expect((await counts()).needsContact).toBe(before.needsContact + 1);
    expect((await counts()).byStatus.all).toBe(before.byStatus.all);

    // Logged by staff on a resolved request: it reopens and needs contact again.
    const resolved = await byNumber(references.management_call!);
    expect(resolved.status).toBe('resolved');
    const msg = await call('POST', `${DR}/requests/${resolved.id}/driver-messages`, {
      message: 'Alex called back: the schedule is wrong again.',
      method: 'phone',
      expectedVersion: resolved.version,
    });
    expect(msg.statusCode, msg.body).toBe(201);
    expect((msg.json() as DriverRelationDetail).request).toMatchObject({ needsContact: true, status: 'contacted', resolvedAt: null });
  });

  it('activity is append-only: the database refuses a rewrite; corrections are new entries', async () => {
    const request = await byNumber(references.management_call!);
    const original = (await detail(request.id)).activities.find((a) => a.type === 'contacted')!;
    await expect(
      db.update(driverRelationActivities).set({ note: 'rewritten' }).where(eq(driverRelationActivities.id, original.id)),
    ).rejects.toThrow();
    const res = await call('POST', `${DR}/requests/${request.id}/notes`, {
      note: 'Correction: the call is Friday, not Thursday.',
      correctsActivityId: original.id,
    });
    expect(res.statusCode, res.body).toBe(201);
    const after = res.json() as DriverRelationDetail;
    expect(after.activities.find((a) => a.id === original.id)?.note).toBe('Spoke with Alex; management will call Thursday.');
    expect(after.activities.find((a) => a.type === 'correction')?.correctsActivityId).toBe(original.id);
  });

  it('roles: read-only sees but cannot act; a role without the permission sees nothing', async () => {
    const request = await byNumber(references.compliance!);
    expect((await call('GET', `${DR}/counts`, undefined, { 'x-account': readOnly })).statusCode).toBe(200);
    expect((await call('GET', `${DR}/requests/${request.id}`, undefined, { 'x-account': readOnly })).statusCode).toBe(200);
    const act = await call(
      'POST',
      `${DR}/requests/${request.id}/contact`,
      { method: 'phone', note: 'x', expectedVersion: request.version },
      { 'x-account': readOnly },
    );
    expect(act.statusCode).toBe(403);
    expect((await call('GET', `${DR}/counts`, undefined, { 'x-demo-role': 'operations' })).statusCode).toBe(403);
    expect((await call('GET', `${DR}/requests`, undefined, { 'x-demo-role': 'operations' })).statusCode).toBe(403);
  });

  it('another company: its requests are not counted, listed or reachable by a guessed id', async () => {
    const before = await counts();
    const res = await submit(forms.compliance(), otherSlug);
    expect(res.statusCode, res.body).toBe(201);
    const [foreign] = await db
      .select()
      .from(driverRelationRequests)
      .where(eq(driverRelationRequests.companyId, otherCompanyId))
      .limit(1);
    expect(foreign).toBeTruthy();
    expect((await counts()).needsContact).toBe(before.needsContact);
    const list = (await call('GET', `${DR}/requests?pageSize=100&q=${foreign!.requestNumber}`)).json() as DriverRelationPage;
    expect(list.data.some((r) => r.id === foreign!.id)).toBe(false);
    expect((await call('GET', `${DR}/requests/${foreign!.id}`)).statusCode).toBe(404);
    const write = await call('POST', `${DR}/requests/${foreign!.id}/contact`, { method: 'phone', note: 'x', expectedVersion: 1 });
    expect(write.statusCode).toBe(404);
    const [still] = await db.select().from(driverRelationRequests).where(eq(driverRelationRequests.id, foreign!.id));
    expect(still!.needsContact).toBe(true);
    // The public side has no read at all.
    expect((await call('GET', `${PUBLIC}/${slug}/requests/${foreign!.id}`)).statusCode).toBe(404);
  });

  it('Telegram is not connected: every notification stays pending and nothing is sent', async () => {
    const status = (await call('GET', `${DR}/integration`)).json();
    expect(status).toEqual({ telegram: { enabled: false, configured: false, label: 'Not connected' } });
    const adapter = app.get(TelegramAdapter);
    const transport = vi.fn();
    adapter.transport = transport as unknown as typeof fetch;
    const result = await app.get(DriverRelationsOutboxWorker).tick();
    expect(result).toEqual({ sent: 0, failed: 0, skipped: 0 });
    expect(transport).not.toHaveBeenCalled();
    await expect(adapter.send('x')).rejects.toThrow(/not connected/);

    const request = await byNumber(references.reimbursement!);
    const rows = await db
      .select()
      .from(driverRelationOutbox)
      .where(and(eq(driverRelationOutbox.companyId, companyId), eq(driverRelationOutbox.requestId, request.id)));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ adapter: 'telegram', status: 'pending', attempts: 0, eventType: 'received' });
    const d = await detail(request.id);
    expect(d.deliveries).toHaveLength(1);
    expect(d.request.needsContact).toBe(true);
  });

  it('once connected: a failed send is retried with backoff, a sent one is never sent twice, the alert stays', async () => {
    const adapter = app.get(TelegramAdapter);
    const worker = app.get(DriverRelationsOutboxWorker);
    const request = await byNumber(references.complaint_feedback!);
    const texts: string[] = [];
    let fail = true;
    // A stand-in transport: the real adapter code runs, nothing leaves the machine.
    adapter.enabled = () => true;
    adapter.transport = (async (_url: string, init?: RequestInit) => {
      texts.push(String(JSON.parse(String(init?.body)).text));
      return fail
        ? new Response(JSON.stringify({ ok: false, description: 'Bad Request: chat not found' }), { status: 400 })
        : new Response(JSON.stringify({ ok: true, result: { message_id: 42 } }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const now = new Date();
      // Other pending rows in the shared test database are in the same queue: work it until ours is reached.
      const ours = async () => (await db.select().from(driverRelationOutbox).where(eq(driverRelationOutbox.requestId, request.id)))[0]!;
      for (let i = 0; i < 50 && (await ours()).attempts === 0; i += 1) await worker.tick(now);
      let [row] = await db.select().from(driverRelationOutbox).where(eq(driverRelationOutbox.requestId, request.id));
      expect(row).toMatchObject({ status: 'pending', attempts: 1 });
      expect(row!.lastError).toMatch(/chat not found/);
      expect(row!.retryAt.getTime()).toBeGreaterThan(now.getTime());
      const mine = texts.find((t) => t.includes(request.requestNumber))!;
      expect(mine).toContain('Complaint &amp; Feedback'); // HTML message; Telegram shows the ampersand
      expect(mine).toContain('<a href="https://neway.example.com/driver-relations">Open in TMS</a>');
      expect(mine).not.toContain('clearer update'); // never the driver's own words
      expect(mine).not.toContain('Casey'); // a confidential request is announced without a name
      expect(mine).toContain('Confidential');
      expect(mine).not.toMatch(/\+1312/); // never a phone number

      fail = false;
      const later = new Date(row!.retryAt.getTime() + 1000);
      for (let i = 0; i < 50 && (await ours()).status === 'pending'; i += 1) await worker.tick(later);
      [row] = await db.select().from(driverRelationOutbox).where(eq(driverRelationOutbox.requestId, request.id));
      expect(row).toMatchObject({ status: 'sent', attempts: 2, externalId: '42' });
      const sentCount = texts.filter((t) => t.includes(request.requestNumber)).length;
      await worker.tick(new Date(row!.retryAt.getTime() + 60 * 60_000));
      expect(texts.filter((t) => t.includes(request.requestNumber)).length).toBe(sentCount);
      expect((await detail(request.id)).request.needsContact).toBe(true);
    } finally {
      adapter.enabled = TelegramAdapter.prototype.enabled;
      adapter.transport = (input, init) => fetch(input, init);
    }
  });

  it('a reimbursement links only to an Accounting reimbursement that exists; no money table moves', async () => {
    const request = await byNumber(references.reimbursement!);
    const res = await call('PATCH', `${DR}/requests/${request.id}/links`, {
      accountingExpenseId: `exp_not_there_${stamp}`,
      expectedVersion: request.version,
    });
    expect(res.statusCode).toBe(422);
    expect(await ledgerCounts()).toEqual(ledgerBefore);
  });

  // ------------------------------------------------------------------------- confidentiality

  it('confidential requests are invisible without driver_relations.confidential: list, counts, detail, writes', async () => {
    const secretCall = await submit({ ...forms.management_call(), callTopic: 'confidential', phone: `(312) 562-${tail()}`, name: `Quiet Caller${stamp}` });
    expect(secretCall.statusCode, secretCall.body).toBe(201);
    const secretRef = (secretCall.json() as { reference: string }).reference;
    const complaint = await byNumber(references.complaint_feedback!);
    const secret = await byNumber(secretRef);
    expect(complaint.confidential).toBe(true);
    expect(secret.confidential).toBe(true);

    const owner = await counts();
    const [hidden] = await db
      .select({
        waiting: sql<number>`count(*) filter (where ${driverRelationRequests.needsContact})::int`,
        all: count(),
      })
      .from(driverRelationRequests)
      .where(and(eq(driverRelationRequests.companyId, companyId), eq(driverRelationRequests.confidential, true)));
    for (const who of [readOnly, contactOnly]) {
      const theirs = (await call_('GET', `${DR}/counts`, who)).json() as DriverRelationCounts;
      expect(theirs.confidentialHidden).toBe(true);
      expect(theirs.needsContact).toBe(owner.needsContact - hidden!.waiting);
      expect(theirs.byStatus.all).toBe(owner.byStatus.all - hidden!.all);
      expect(theirs.byTopic.complaint_feedback).toEqual({ needsContact: 0, total: 0 });
      const list = (await call_('GET', `${DR}/requests?pageSize=100&topic=complaint_feedback`, who)).json() as DriverRelationPage;
      expect(list.total).toBe(0);
      const search = (await call_('GET', `${DR}/requests?pageSize=100&q=${secretRef}`, who)).json() as DriverRelationPage;
      expect(search.data).toHaveLength(0);
      expect((await call_('GET', `${DR}/requests/${complaint.id}`, who)).statusCode).toBe(404);
      expect((await call_('GET', `${DR}/requests/${secret.id}`, who)).statusCode).toBe(404);
    }
    expect(owner.confidentialHidden).toBe(false);
    // Contact permission without the confidential one cannot act on it either: it does not exist.
    const write = await call_('POST', `${DR}/requests/${complaint.id}/contact`, contactOnly, {
      method: 'phone',
      note: 'x',
      expectedVersion: complaint.version,
    });
    expect(write.statusCode).toBe(404);
    // The Driver Relations role sees and works it.
    expect((await call_('GET', `${DR}/requests/${complaint.id}`, agent)).statusCode).toBe(200);
    const agentCounts = (await call_('GET', `${DR}/counts`, agent)).json() as DriverRelationCounts;
    expect(agentCounts.needsContact).toBe(owner.needsContact);
    // And a confidential request cannot be handed to someone who may not see it.
    const people = (await call('GET', `${DR}/assignees`)).json() as { userId: string; name: string }[];
    const [contactOnlyUser] = await db.select({ userId: users.id }).from(users).where(eq(users.email, `dr.contact.${stamp}@test.local`));
    expect(people.some((p) => p.userId === contactOnlyUser!.userId)).toBe(true);
    const handOff = await call('PATCH', `${DR}/requests/${complaint.id}/assignment`, {
      assigneeUserId: contactOnlyUser!.userId,
      expectedVersion: complaint.version,
    });
    expect(handOff.statusCode).toBe(422);
  });

  // ------------------------------------------------------------------------------- receipts

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('fake-png-body')]);
  const PDF = Buffer.from('%PDF-1.4\n% test receipt\n');
  const asFile = (fileName: string, bytes: Buffer, type = 'application/octet-stream') => ({
    fileName,
    content: `data:${type};base64,${bytes.toString('base64')}`,
  });

  it('a reimbursement carries receipts: checked by their bytes, stored privately, read only through the staff route', async () => {
    const body = {
      ...forms.reimbursement(),
      submissionId: crypto.randomUUID(),
      website: '',
      phone: `(312) 563-${tail()}`,
      name: `Receipt Driver${stamp}`,
      // The browser's claimed type is ignored; the bytes decide.
      attachments: [asFile('../../etc/lumper receipt.png', PNG, 'image/gif'), asFile('scale.pdf', PDF)],
    };
    const res = await call('POST', `${PUBLIC}/${slug}`, body);
    expect(res.statusCode, res.body).toBe(201);
    const reference = (res.json() as { reference: string }).reference;
    const request = await byNumber(reference);
    expect(request.attachmentCount).toBe(2);
    const d = await detail(request.id);
    expect(d.attachments.map((a) => [a.fileName, a.contentType])).toEqual([
      ['lumper receipt.png', 'image/png'],
      ['scale.pdf', 'application/pdf'],
    ]);
    expect(d.attachments[0]!.url).toMatch(/^\/api\/v1\/driver-relations\/requests\//);

    const download = await call('GET', d.attachments[1]!.url);
    expect(download.statusCode).toBe(200);
    expect(download.headers['content-type']).toBe('application/pdf');
    expect(download.headers['x-content-type-options']).toBe('nosniff');
    expect(download.headers['cache-control']).toBe('private, no-store');
    expect(Buffer.from(download.rawPayload).equals(PDF)).toBe(true);

    // The same submission again (a retry with the same files) is the same request and stores nothing new.
    const again = await call('POST', `${PUBLIC}/${slug}`, body);
    expect(again.statusCode).toBe(201);
    expect((again.json() as { reference: string }).reference).toBe(reference);
    const [stored] = await db
      .select({ value: count() })
      .from(driverRelationAttachments)
      .where(and(eq(driverRelationAttachments.companyId, companyId), eq(driverRelationAttachments.requestId, request.id)));
    expect(stored!.value).toBe(2);

    // Permission, guessed ids, and the read-only path (not confidential, so readable).
    expect((await call_('GET', d.attachments[0]!.url, readOnly)).statusCode).toBe(200);
    expect((await call('GET', d.attachments[0]!.url, undefined, { 'x-demo-role': 'operations' })).statusCode).toBe(403);
    expect((await call('GET', `${DR}/requests/${request.id}/attachments/dra_file_guess`)).statusCode).toBe(404);
    const other = await byNumber(references.pay_statement!);
    expect((await call('GET', `${DR}/requests/${other.id}/attachments/${d.attachments[0]!.id}`)).statusCode).toBe(404);
    // Not reachable through the general file store either.
    expect((await call('GET', `/api/v1/files/${d.attachments[0]!.id}`)).statusCode).toBe(404);
  });

  it('refuses a receipt that is not a photo or PDF, one over 10 MB, and a fourth file, and saves nothing', async () => {
    const before = await counts();
    const base = () => ({ ...forms.reimbursement(), phone: `(312) 564-${tail()}`, name: `Bad Files${stamp}` });
    const wrong = await submit({ ...base(), attachments: [asFile('receipt.jpg', Buffer.from('MZ this is an exe'), 'image/jpeg')] });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().errors[0].path).toBe('attachments.0');
    const big = Buffer.concat([PNG, Buffer.alloc(10 * 1024 * 1024)]);
    const oversize = await submit({ ...base(), attachments: [asFile('big.png', big)] });
    expect(oversize.statusCode).toBe(413);
    const four = await submit({ ...base(), attachments: [1, 2, 3, 4].map((i) => asFile(`r${i}.pdf`, PDF)) });
    expect(four.statusCode).toBe(422);
    expect((await counts()).byStatus.all).toBe(before.byStatus.all);
  });

  it('a request marked as test data is kept but leaves the list, counts, detail and threads', async () => {
    const phone = `(312) 566-${tail()}`;
    const res = await submit({ ...forms.compliance(), phone });
    expect(res.statusCode, res.body).toBe(201);
    const reference = (res.json() as { reference: string }).reference;
    const row = await byNumber(reference);
    const before = await counts();
    await app.get(DriverRelationsService).markTest(
      { userId: 'e2e', userName: 'e2e', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set() },
      reference,
      'e2e test data',
    );
    await expect(byNumber(reference)).rejects.toThrow();
    expect((await call('GET', `${DR}/requests/${row.id}`)).statusCode).toBe(404);
    const after = await counts();
    expect(after.byStatus.all).toBe(before.byStatus.all - 1);
    expect(after.needsContact).toBe(before.needsContact - 1);
    const [kept] = await db.select().from(driverRelationRequests).where(eq(driverRelationRequests.id, row.id));
    expect(kept).toMatchObject({ isTest: true, testReason: 'e2e test data', testMarkedBy: 'e2e' });
    const pending = await db
      .select()
      .from(driverRelationOutbox)
      .where(and(eq(driverRelationOutbox.requestId, row.id), eq(driverRelationOutbox.status, 'pending')));
    expect(pending).toHaveLength(0);
    // The same driver writing again starts a new, visible request instead of joining the hidden one.
    const again = await submit({ ...forms.compliance(), phone });
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as { reference: string }).reference).not.toBe(reference);
  });

  it('another company’s receipt is a 404 from here, even with its real ids', async () => {
    const res = await submit({ ...forms.reimbursement(), phone: `(312) 565-${tail()}`, attachments: [asFile('r.pdf', PDF)] }, otherSlug);
    expect(res.statusCode, res.body).toBe(201);
    const [file] = await db
      .select()
      .from(driverRelationAttachments)
      .where(eq(driverRelationAttachments.companyId, otherCompanyId))
      .limit(1);
    expect(file).toBeTruthy();
    expect((await call('GET', `${DR}/requests/${file!.requestId}/attachments/${file!.id}`)).statusCode).toBe(404);
  });
});
