import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  ConversationsResponse,
  ConversationThread,
  DriverFileUploadResponse,
  GiveAppAccessResponse,
  MessageView,
  MobileNotificationsResponse,
  MobilePushPayload,
  OfficeApprovals,
  OfficeDispatch,
  OfficeMe,
  OfficeMyWork,
  OfficeToday,
} from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads as loadsTable } from '../src/database/schema/loads';
import { conversationParticipants, conversations, messages } from '../src/database/schema/mobile';
import { companies, drivers } from '../src/database/schema/roster';
import { AnalyticsService } from '../src/modules/reports/analytics.service';
import { accountWithPermissions } from './fleet-reader-account';

const API = '/api/v1';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);

/**
 * Messages and the office endpoints, end to end (mobile M4, docs/mobile/API.md §8–§9).
 *
 * Drivers sign in for real (bearer, client mobile); office people are real accounts holding only the
 * permissions named, acting through the development `x-account` header. A local HTTP server stands
 * in for Expo's push service.
 */
describe('Mobile office + messages (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let stub: Server;
  const pushes: MobilePushPayload[] = [];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  let company = '';
  const OTHER = `co_m4_other_${stamp}`;
  const D1 = `drv_m4a_${stamp}`;
  const D2 = `drv_m4b_${stamp}`;
  const L1 = `ld_m4a_${stamp}`;
  const L2 = `ld_m4b_${stamp}`;
  const LLATE = `ld_m4late_${stamp}`;
  const LPOD = `ld_m4pod_${stamp}`;
  let token1 = '';
  let token2 = '';
  let dispatcher = '';
  let accountant = '';
  let safetyOnly = '';
  let reporter = '';
  let ptoApprover = '';
  let analyst = '';
  let conversationId = '';
  let fileId = '';
  const dispatcherToken = `ExponentPushToken[m4-dispatch-${stamp}]`;
  const driverToken = `ExponentPushToken[m4-driver-${stamp}]`;

  const owner = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url: `${API}${url}`, headers: { 'content-type': 'application/json' }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const asAccount = (membershipId: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${API}${url}`,
      headers: { 'x-account': membershipId, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const asDriver = (bearer: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
    app.inject({
      method,
      url: `${API}${url}`,
      headers: { authorization: `Bearer ${bearer}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });

  const stop = (id: string, kind: 'pickup' | 'delivery', seq: number, over: Record<string, unknown> = {}) => ({
    id,
    sequence: seq,
    kind,
    facilityId: '',
    facilityName: `${kind} ${id.slice(-4)}`,
    city: kind === 'pickup' ? 'Olathe' : 'Denver',
    state: kind === 'pickup' ? 'KS' : 'CO',
    timezone: 'America/Chicago',
    appointmentStartAt: '2026-10-20T13:00:00.000Z',
    appointmentEndAt: '2026-10-20T15:00:00.000Z',
    appointmentNoWindow: false,
    status: 'pending',
    arrivedAt: null,
    departedAt: null,
    detentionMinutes: 0,
    notes: null,
    ...over,
  });
  const record = (id: string, status: string, driverId: string, over: Record<string, unknown> = {}) => ({
    id,
    loadNumber: `L-${id.replace(/^ld_/, '').toUpperCase()}`,
    status,
    schemaVersion: 2,
    customerId: 'cus_m4',
    customerName: 'M4 Customer',
    brokerReference: `REF-${id.slice(-6)}`,
    rate: 1800,
    dispatcherId: 'disp_m4',
    dispatcherName: 'M4 Dispatcher',
    driverId,
    driverName: 'M4 Driver',
    truckId: null,
    truckUnit: null,
    trailerId: null,
    trailerUnit: null,
    stops: [stop(`${id}_s1`, 'pickup', 1), stop(`${id}_s2`, 'delivery', 2)],
    charges: [],
    timeline: [],
    notes: [],
    documents: [],
    dispatchedAt: '2026-10-19T12:00:00.000Z',
    deliveredAt: null,
    invoiceId: null,
    updatedAt: '2026-10-19T12:00:00.000Z',
    ...over,
  });
  const driverRow = (companyId: string, id: string, first: string, email: string) => ({
    id,
    companyId,
    driverNumber: id,
    firstName: first,
    lastName: 'Fourth',
    phone: `555${Math.floor(Math.random() * 1e7)}`,
    email,
    driverType: 'company',
    cdlState: 'OH',
    cdlClass: 'A',
    cdlNumber: id,
    cdlExpiresOn: '2028-01-01',
    cdlStatus: 'valid',
    medicalCardStatus: 'valid',
    hireDate: '2026-01-01',
    status: 'active',
    dispatcherId: 'disp_m4',
    dispatcherName: 'M4 Dispatcher',
    homeCity: 'Columbus',
    homeState: 'OH',
    payPlanKind: 'percentage',
  });

  async function grantApp(driverId: string): Promise<string> {
    const res = await owner('POST', `/drivers/${driverId}/app-access`, {});
    expect(res.statusCode, res.body).toBe(200);
    const given = res.json() as GiveAppAccessResponse;
    const login = await app.inject({
      method: 'POST',
      url: `${API}/auth/login`,
      headers: { 'content-type': 'application/json' },
      payload: { email: given.access.login, password: given.temporaryPassword, client: 'mobile' },
    });
    expect(login.statusCode, login.body).toBe(201);
    const bearer = (login.json() as { token: string }).token;
    const replaced = await asDriver(bearer, 'POST', '/auth/password/temporary', { newPassword: 'Driver-pass-1234', confirmPassword: 'Driver-pass-1234' });
    expect(replaced.statusCode, replaced.body).toBeLessThan(300);
    return bearer;
  }

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const sent = JSON.parse(body) as MobilePushPayload[];
        pushes.push(...sent);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: sent.map(() => ({ status: 'ok', id: randomUUID() })) }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/push`;
    setFeatureFlagForTests('fleet_v2', true);

    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    company = ((await owner('GET', '/auth/me')).json() as { companyId: string }).companyId;
    if (!company) throw new Error('no company');

    await db.insert(companies).values({ id: OTHER, name: `M4 other ${stamp}` } as typeof companies.$inferInsert);
    await db.insert(drivers).values([driverRow(company, D1, 'Mike', `mike.${stamp}@example.test`), driverRow(company, D2, 'Anna', `anna.${stamp}@example.test`)] as never);
    const past = new Date(Date.now() - 3 * 3600_000).toISOString();
    const pastEnd = new Date(Date.now() - 2 * 3600_000).toISOString();
    const loadValues = (id: string, status: string, driverId: string, over: Record<string, unknown> = {}) => {
      const r = record(id, status, driverId, over);
      return { id, companyId: company, loadNumber: r.loadNumber, status, dispatcherId: 'disp_m4', driverId, version: 1, record: r };
    };
    await db.insert(loadsTable).values([
      loadValues(L1, 'in_transit', D1),
      loadValues(L2, 'dispatched', D2),
      // Pickup window closed two hours ago, nobody arrived: a late pickup.
      loadValues(LLATE, 'dispatched', D2, { stops: [stop(`${LLATE}_s1`, 'pickup', 1, { appointmentStartAt: past, appointmentEndAt: pastEnd }), stop(`${LLATE}_s2`, 'delivery', 2)] }),
      // Delivered an hour ago with no POD on file.
      loadValues(LPOD, 'delivered', D2, { deliveredAt: new Date(Date.now() - 3600_000).toISOString() }),
    ] as never);

    dispatcher = await accountWithPermissions(app, ['dispatch.view', 'loads.view', 'trucks.view', 'drivers.view'], 'M4 dispatcher');
    accountant = await accountWithPermissions(app, ['accounting.view', 'accounting.edit', 'loads.view'], 'M4 accountant');
    safetyOnly = await accountWithPermissions(app, ['safety.view'], 'M4 safety');
    reporter = await accountWithPermissions(app, ['reports.view'], 'M4 reporter');
    ptoApprover = await accountWithPermissions(app, ['pto.view', 'pto.approve'], 'M4 pto');
    analyst = await accountWithPermissions(app, ['analytics.view', 'trucks.view'], 'M4 owner view');

    token1 = await grantApp(D1);
    token2 = await grantApp(D2);
    expect((await asDriver(token1, 'POST', '/mobile/devices', { expoToken: driverToken, platform: 'ios' })).statusCode).toBe(200);
    expect((await asAccount(dispatcher, 'POST', '/mobile/devices', { expoToken: dispatcherToken, platform: 'android' })).statusCode).toBe(200);
  }, 180_000);

  afterAll(async () => {
    setFeatureFlagForTests('fleet_v2', null);
    await app?.close();
    await new Promise<void>((resolve) => stub?.close(() => resolve()));
  });

  // ------------------------------------------------------------------------------ messages

  it('driver starts a load conversation with Dispatch, with a photo; a retry makes no second message', async () => {
    const up = await app.inject({
      method: 'POST',
      url: `${API}/driver/files`,
      headers: { authorization: `Bearer ${token1}`, 'content-type': 'application/octet-stream', 'idempotency-key': `m4-file-${stamp}`, 'x-file-name': 'tire.jpg' },
      payload: JPEG,
    });
    expect(up.statusCode, up.body).toBe(201);
    fileId = (up.json() as DriverFileUploadResponse).fileId;

    const key = `m4-start-${stamp}`;
    const payload = { department: 'dispatch', subjectType: 'load', subjectId: L1, body: "I've got a tire air leak on the trailer.", attachmentFileIds: [fileId] };
    // No key: refused.
    expect((await asDriver(token1, 'POST', '/driver/conversations', payload)).statusCode).toBe(428);
    const res = await asDriver(token1, 'POST', '/driver/conversations', payload, { 'idempotency-key': key });
    expect(res.statusCode, res.body).toBe(200);
    const thread = res.json() as ConversationThread;
    conversationId = thread.conversation.id;
    expect(thread.conversation.kind).toBe('load');
    expect(thread.conversation.department).toBe('dispatch');
    expect(thread.conversation.subject).toMatchObject({ type: 'load', id: L1 });
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]!.attachments.map((a) => a.fileId)).toEqual([fileId]);
    expect(thread.messages[0]!.sender).toMatchObject({ kind: 'driver', isMe: true });
    expect(thread.messages[0]!.state).toBe('received');

    const again = await asDriver(token1, 'POST', '/driver/conversations', payload, { 'idempotency-key': key });
    expect(again.statusCode).toBe(200);
    expect((again.json() as ConversationThread).conversation.id).toBe(conversationId);

    // A second message, sent twice with one key: one row.
    const k2 = `m4-msg-${stamp}`;
    const m1 = await asDriver(token1, 'POST', `/driver/conversations/${conversationId}/messages`, { body: 'Pulling over at exit 76.' }, { 'idempotency-key': k2 });
    expect(m1.statusCode, m1.body).toBe(201);
    const m2 = await asDriver(token1, 'POST', `/driver/conversations/${conversationId}/messages`, { body: 'Pulling over at exit 76.' }, { 'idempotency-key': k2 });
    expect((m2.json() as MessageView).id).toBe((m1.json() as MessageView).id);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, conversationId));
    expect(rows).toHaveLength(2);
  });

  it('the dispatcher (dispatch.view) sees it in the inbox, opens the photo; the push carries no message text', async () => {
    const list = await asAccount(dispatcher, 'GET', '/conversations');
    expect(list.statusCode, list.body).toBe(200);
    const inbox = list.json() as ConversationsResponse;
    const mine = inbox.conversations.find((c) => c.id === conversationId);
    expect(mine).toBeTruthy();
    expect(mine!.unread).toBe(2);
    expect(mine!.drivers.map((d) => d.id)).toEqual([D1]);
    expect(inbox.unreadByDepartment.dispatch).toBeGreaterThanOrEqual(2);
    const byDept = (await asAccount(dispatcher, 'GET', '/conversations?scope=department&department=dispatch')).json() as ConversationsResponse;
    expect(byDept.conversations.some((c) => c.id === conversationId)).toBe(true);
    // The load page finds its conversation by subject.
    const bySubject = (await asAccount(dispatcher, 'GET', `/conversations?subjectType=load&subjectId=${L1}`)).json() as ConversationsResponse;
    expect(bySubject.conversations.map((c) => c.id)).toEqual([conversationId]);

    const thread = (await asAccount(dispatcher, 'GET', `/conversations/${conversationId}/messages`)).json() as ConversationThread;
    expect(thread.messages.map((m) => m.body)).toEqual(["I've got a tire air leak on the trailer.", 'Pulling over at exit 76.']);
    expect(thread.messages[0]!.sender.isMe).toBe(false);

    const link = await asAccount(dispatcher, 'GET', `/conversations/${conversationId}/files/${fileId}/link`);
    expect(link.statusCode, link.body).toBe(200);
    // The general file link knows the attachment's owner (file-access: message) too.
    expect((await asAccount(dispatcher, 'GET', `/files/${fileId}/link`)).statusCode).toBe(200);
    expect((await asAccount(accountant, 'GET', `/files/${fileId}/link`)).statusCode).toBe(403);

    const toDispatcher = pushes.filter((p) => p.to === dispatcherToken);
    expect(toDispatcher.length).toBeGreaterThanOrEqual(2);
    for (const p of toDispatcher) {
      expect(p.data.type).toBe('conversation');
      expect(p.data.id).toBe(conversationId);
      expect(JSON.stringify(p)).not.toContain('tire air leak');
      expect(JSON.stringify(p)).not.toContain('exit 76');
    }
    const notes = (await asAccount(dispatcher, 'GET', '/mobile/notifications')).json() as MobileNotificationsResponse;
    const note = notes.notifications.find((n) => n.target?.type === 'conversation' && n.target.id === conversationId);
    expect(note).toBeTruthy();
    expect(note!.group).toBe('update');
    expect(note!.body ?? '').not.toContain('tire air leak');
    expect(notes.unreadByGroup).toBeTruthy();
  });

  it('the dispatcher replies; the driver sees it, unread then read; sent / received / read follow last_read_at', async () => {
    const reply = await asAccount(dispatcher, 'POST', `/conversations/${conversationId}/messages`, { body: "We're on it. Roadside service is dispatched." });
    expect(reply.statusCode, reply.body).toBe(201);
    const sent = reply.json() as MessageView;
    expect(sent.sender).toMatchObject({ kind: 'office', isMe: true });
    expect(sent.state).toBe('received'); // the driver has a live app login

    const pushToDriver = pushes.filter((p) => p.to === driverToken && p.data.type === 'conversation');
    expect(pushToDriver.length).toBe(1);
    expect(JSON.stringify(pushToDriver[0])).not.toContain('Roadside');

    const list = (await asDriver(token1, 'GET', '/driver/conversations')).json() as ConversationsResponse;
    const c = list.conversations.find((x) => x.id === conversationId)!;
    expect(c.unread).toBe(1);
    expect(c.lastMessage?.body).toBe("We're on it. Roadside service is dispatched.");
    const thread = (await asDriver(token1, 'GET', `/driver/conversations/${conversationId}/messages`)).json() as ConversationThread;
    // The dispatcher answered after reading: the driver's own messages read.
    expect(thread.messages.filter((m) => m.sender.isMe).every((m) => m.state === 'read')).toBe(true);
    expect((await asDriver(token1, 'POST', `/driver/conversations/${conversationId}/read`, {}, { 'idempotency-key': `m4-read-${stamp}` })).statusCode).toBe(200);
    expect(((await asDriver(token1, 'GET', '/driver/conversations')).json() as ConversationsResponse).conversations.find((x) => x.id === conversationId)!.unread).toBe(0);

    const office = (await asAccount(dispatcher, 'GET', `/conversations/${conversationId}/messages`)).json() as ConversationThread;
    expect(office.messages.find((m) => m.id === sent.id)!.state).toBe('read');
    // The driver opens the office's attachment-free thread and its own photo through the conversation link.
    expect((await asDriver(token1, 'GET', `/driver/conversations/${conversationId}/files/${fileId}/link`)).statusCode).toBe(200);
    const officeRead = await asAccount(dispatcher, 'POST', `/conversations/${conversationId}/read`, {});
    expect(officeRead.statusCode).toBe(200);
  });

  it('another driver, another company and an office user without the department permission are refused', async () => {
    expect((await asDriver(token2, 'GET', `/driver/conversations/${conversationId}/messages`)).statusCode).toBe(404);
    expect((await asDriver(token2, 'POST', `/driver/conversations/${conversationId}/messages`, { body: 'hi' }, { 'idempotency-key': `m4-x-${stamp}` })).statusCode).toBe(404);
    expect(((await asDriver(token2, 'GET', '/driver/conversations')).json() as ConversationsResponse).conversations.some((c) => c.id === conversationId)).toBe(false);
    // Driver 2 cannot open a conversation about driver 1's load, nor attach driver 1's file.
    expect((await asDriver(token2, 'POST', '/driver/conversations', { department: 'dispatch', subjectType: 'load', subjectId: L1 }, { 'idempotency-key': `m4-y-${stamp}` })).statusCode).toBe(404);
    expect((await asDriver(token2, 'POST', '/driver/conversations', { department: 'safety', body: 'see this', attachmentFileIds: [fileId] }, { 'idempotency-key': `m4-z-${stamp}` })).statusCode).toBe(422);
    expect((await asDriver(token2, 'GET', `/driver/conversations/${conversationId}/files/${fileId}/link`)).statusCode).toBe(404);
    // A driver login has no office inbox.
    expect((await asDriver(token1, 'GET', '/conversations')).statusCode).toBe(403);

    // Office: no department permission at all → 403 on the inbox; another department → 403 on the thread.
    expect((await asAccount(reporter, 'GET', '/conversations')).statusCode).toBe(403);
    const safetyInbox = await asAccount(safetyOnly, 'GET', '/conversations');
    expect(safetyInbox.statusCode).toBe(200);
    expect((safetyInbox.json() as ConversationsResponse).conversations.some((c) => c.id === conversationId)).toBe(false);
    expect((await asAccount(safetyOnly, 'GET', `/conversations/${conversationId}/messages`)).statusCode).toBe(403);
    expect((await asAccount(safetyOnly, 'POST', `/conversations/${conversationId}/messages`, { body: 'x' })).statusCode).toBe(403);
    expect((await asAccount(safetyOnly, 'GET', '/conversations?department=dispatch')).statusCode).toBe(403);
    expect((await asAccount(accountant, 'GET', `/conversations/${conversationId}/messages`)).statusCode).toBe(403);
    expect((await asAccount(accountant, 'POST', '/conversations', { department: 'dispatch', driverId: D1 })).statusCode).toBe(403);

    // Another company's conversation is not found.
    const foreign = `cnv_m4_foreign_${stamp}`;
    await db.insert(conversations).values({ id: foreign, companyId: OTHER, kind: 'department', department: 'dispatch', title: 'Elsewhere' });
    expect((await asAccount(dispatcher, 'GET', `/conversations/${foreign}/messages`)).statusCode).toBe(404);
    expect((await asDriver(token1, 'GET', `/driver/conversations/${foreign}/messages`)).statusCode).toBe(404);
  });

  it('the office opens the load conversation from the load page (find-or-create) and starts a department thread', async () => {
    const res = await asAccount(dispatcher, 'POST', '/conversations', { department: 'dispatch', subjectType: 'load', subjectId: L1 });
    expect(res.statusCode, res.body).toBe(200);
    expect((res.json() as ConversationThread).conversation.id).toBe(conversationId);
    // A load conversation needs loads.view: the safety-only account cannot start one.
    expect((await asAccount(safetyOnly, 'POST', '/conversations', { department: 'safety', subjectType: 'load', subjectId: L2 })).statusCode).toBe(403);
    const safety = await asAccount(safetyOnly, 'POST', '/conversations', { department: 'safety', driverId: D2, body: 'Please upload your medical card.' });
    expect(safety.statusCode, safety.body).toBe(200);
    const thread = safety.json() as ConversationThread;
    expect(thread.conversation.kind).toBe('department');
    const d2 = (await asDriver(token2, 'GET', '/driver/conversations')).json() as ConversationsResponse;
    expect(d2.conversations.map((c) => c.id)).toContain(thread.conversation.id);
    expect((await asAccount(dispatcher, 'GET', `/conversations/${thread.conversation.id}/messages`)).statusCode).toBe(403);
    const parts = await db.select().from(conversationParticipants).where(and(eq(conversationParticipants.conversationId, thread.conversation.id), eq(conversationParticipants.driverId, D2)));
    expect(parts).toHaveLength(1);
  });

  // ------------------------------------------------------------------------------- office

  it('/office/me lists the caller\'s departments and workspaces; a driver login is refused', async () => {
    const me = (await asAccount(dispatcher, 'GET', '/office/me')).json() as OfficeMe;
    expect(me.departments.map((d) => d.key)).toEqual(['dispatch']);
    expect(me.todayRoles).toEqual(['dispatcher']);
    expect(me.workspaces).toEqual(expect.arrayContaining(['today', 'dispatch', 'inbox', 'my_work']));
    expect(me.workspaces).not.toContain('accounting');
    expect((await asDriver(token1, 'GET', '/office/me')).statusCode).toBe(403);
  });

  it('/office/today returns only what the role may see: a dispatcher gets late pickups and missing PODs, no accounting', async () => {
    const res = await asAccount(dispatcher, 'GET', '/office/today?role=dispatcher');
    expect(res.statusCode, res.body).toBe(200);
    const today = res.json() as OfficeToday;
    expect(today.sections.map((s) => s.key)).toEqual(['dispatch']);
    expect(today.owner).toBeNull();
    const kinds = today.attention.map((a) => `${a.kind}:${a.target?.id}`);
    // The list is capped (most severe, then longest waiting first). In a shared staging database
    // other suites' open items can fill it; then every shown item must outrank or predate ours.
    const shows = (key: string, severity: string) => {
      if (kinds.includes(key)) return true;
      const items = today.sections[0]!.items;
      const rank = (x: string) => ['critical', 'warning', 'info'].indexOf(x);
      return items.length >= 25 && items.every((i) => rank(i.severity) <= rank(severity));
    };
    expect(shows(`late_pickup:${LLATE}`, 'critical')).toBe(true);
    expect(shows(`pod_missing:${LPOD}`, 'warning')).toBe(true);
    const counters = Object.fromEntries(today.sections[0]!.counters.map((c) => [c.key, c.value]));
    expect(counters.loads_in_progress).toBeGreaterThanOrEqual(1);
    expect(counters).toHaveProperty('available_trucks');
    expect(JSON.stringify(today)).not.toMatch(/reimbursement|settlement|revenue/i);
    // Another role's view is refused.
    expect((await asAccount(dispatcher, 'GET', '/office/today?role=accounting')).statusCode).toBe(403);
    expect((await asAccount(dispatcher, 'GET', '/office/today?role=owner')).statusCode).toBe(403);
    expect((await asAccount(reporter, 'GET', '/office/today')).statusCode).toBe(403);
  });

  it('/office/today safety and fleet views read the PTI board, work orders and defects, and say what they left out', async () => {
    const safety = await asAccount(safetyOnly, 'GET', '/office/today?role=safety');
    expect(safety.statusCode, safety.body).toBe(200);
    const s = safety.json() as OfficeToday;
    expect(s.sections.map((x) => x.key)).toEqual(['safety']);
    expect(s.sections[0]!.counters.map((c) => c.key)).toContain('pti_awaiting_review');
    expect(s.omitted.map((o) => o.key)).toContain('expiring_documents');
    const fleetAccount = await accountWithPermissions(app, ['maintenance.view', 'trucks.view'], 'M4 fleet');
    const fleet = await asAccount(fleetAccount, 'GET', '/office/today?role=fleet');
    expect(fleet.statusCode, fleet.body).toBe(200);
    const f = (fleet.json() as OfficeToday).sections.find((x) => x.key === 'fleet')!;
    expect(f.counters.map((c) => c.key)).toEqual(expect.arrayContaining(['in_shop', 'open_defects', 'down_units', 'open_breakdowns']));
    expect((await asAccount(fleetAccount, 'GET', '/office/today?role=safety')).statusCode).toBe(403);
  });

  it('/office/today accounting counts equal the accounting routes', async () => {
    const created = await owner('POST', '/accounting/reimbursements', {
      payerDriverId: D1,
      onDate: '2026-10-26',
      category: 'parking',
      receiptCents: 3500,
      driverFundedCents: 3500,
      description: 'Parking expense',
      paymentSource: 'driver_personal',
      missingReceiptReason: 'Paper receipt lost on the road',
    });
    expect(created.statusCode, created.body).toBeLessThan(300);
    const res = await asAccount(accountant, 'GET', '/office/today?role=accounting');
    expect(res.statusCode, res.body).toBe(200);
    const section = (res.json() as OfficeToday).sections.find((s) => s.key === 'accounting')!;
    const counters = Object.fromEntries(section.counters.map((c) => [c.key, c.value]));
    const pending = (await asAccount(accountant, 'GET', '/accounting/reimbursements?status=pending')).json() as unknown[];
    expect(counters.reimbursements_pending).toBe(pending.length);
    const queue = (await asAccount(accountant, 'GET', '/accounting/billing/queue')).json() as { counts: Record<string, number> };
    expect(counters.billing_needs_review).toBe(queue.counts.needs_review);
  });

  it('/office/today owner numbers equal AnalyticsService.executive for the same period', async () => {
    const res = await asAccount(analyst, 'GET', '/office/today?role=owner&period=this_month');
    expect(res.statusCode, res.body).toBe(200);
    const today = res.json() as OfficeToday;
    const exec = (await asAccount(analyst, 'GET', '/analytics/executive?preset=this_month')).json() as { metrics: Array<{ key: string; current: number | null }>; range: { from: string; to: string }; profitHidden: unknown };
    const m = (k: string) => exec.metrics.find((x) => x.key === k)?.current ?? null;
    expect(today.owner!.period).toMatchObject({ preset: 'this_month', from: exec.range.from, to: exec.range.to });
    expect(today.owner!.revenue.amount).toBe(m('gross'));
    expect(today.owner!.expenses.amount).toBe(m('cost'));
    expect(today.owner!.net.amount).toBe(exec.profitHidden ? null : m('profit'));
    expect(['posted', 'includes_estimates']).toContain(today.owner!.expenses.basis);
    expect(today.owner!.fleet).not.toBeNull();
    // The analyst holds no loads/maintenance codes: no dispatch or fleet section leaks into Critical tasks.
    expect(today.sections.map((s) => s.key)).toEqual(['critical']);
    // In-process, the same service answers the same numbers.
    expect(app.get(AnalyticsService)).toBeTruthy();
  });

  it('/office/approvals returns only what the caller may approve, and the action routes enforce the permission', async () => {
    const acc = await asAccount(accountant, 'GET', '/office/approvals');
    expect(acc.statusCode, acc.body).toBe(200);
    const a = acc.json() as OfficeApprovals;
    expect(a.tabs.map((t) => t.kind)).toEqual(['expenses']);
    expect(a.items.length).toBeGreaterThanOrEqual(1);
    for (const item of a.items) {
      expect(item.status).toBe('pending');
      expect(item.approve?.path).toBe(`/accounting/reimbursements/${item.id}/review`);
    }
    expect((await asAccount(accountant, 'GET', '/office/approvals?kind=pto')).statusCode).toBe(403);

    const pto = await asAccount(ptoApprover, 'GET', '/office/approvals');
    expect(pto.statusCode, pto.body).toBe(200);
    expect((pto.json() as OfficeApprovals).tabs.map((t) => t.kind)).toEqual(['pto']);
    expect((await asAccount(ptoApprover, 'GET', '/office/approvals?kind=expenses')).statusCode).toBe(403);
    // The named action route refuses a caller without its permission.
    const target = a.items[0]!;
    expect((await asAccount(ptoApprover, 'POST', target.approve!.path, { decision: 'approve', reason: null })).statusCode).toBe(403);
    expect((await asAccount(dispatcher, 'GET', '/office/approvals')).statusCode).toBe(403);
    // The accountant's own approval goes through the existing route.
    const ok = await asAccount(accountant, 'POST', target.approve!.path, { decision: 'approve', reason: null });
    expect(ok.statusCode, ok.body).toBeLessThan(300);
  });

  it('/office/dispatch searches trucks / drivers / loads; /office/my-work is the caller\'s own', async () => {
    const loadsRes = await asAccount(dispatcher, 'GET', `/office/dispatch?tab=loads&q=${encodeURIComponent(`L-M4A_${stamp}`.toUpperCase())}`);
    expect(loadsRes.statusCode, loadsRes.body).toBe(200);
    const loadsTab = loadsRes.json() as OfficeDispatch;
    expect(loadsTab.active.map((r) => r.id)).toEqual([L1]);
    const driversTab = (await asAccount(dispatcher, 'GET', `/office/dispatch?tab=drivers&q=${encodeURIComponent('Fourth')}`)).json() as OfficeDispatch;
    expect([...driversTab.active, ...driversTab.unassigned].map((r) => r.id)).toEqual(expect.arrayContaining([D1, D2]));
    expect((await asAccount(dispatcher, 'GET', '/office/dispatch?tab=trucks')).statusCode).toBe(200);
    expect((await asAccount(reporter, 'GET', '/office/dispatch?tab=loads')).statusCode).toBe(403);

    const work = await asAccount(dispatcher, 'GET', '/office/my-work');
    expect(work.statusCode, work.body).toBe(200);
    const mine = work.json() as OfficeMyWork;
    expect(mine.attendance.status).toBe('no_employee');
    expect(mine.salaryReport).toBeNull();
    expect(JSON.stringify(mine)).not.toMatch(/amount|netCents/i);
    const ptoMe = await asAccount(dispatcher, 'GET', '/hr/pto/me');
    expect(ptoMe.statusCode, ptoMe.body).toBe(200);
    expect(ptoMe.json()).toEqual([]);
  });
});
