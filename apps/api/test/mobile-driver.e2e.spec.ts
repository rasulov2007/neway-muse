import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  DriverDocumentUploadResponse,
  DriverFileUploadResponse,
  DriverLoadDetail,
  DriverLoadsResponse,
  DriverMe,
  DriverPtiCurrent,
  GiveAppAccessResponse,
  MobileDevice,
  MobileNotificationsResponse,
  PtiBoard,
  PtiDefect,
  PtiInspection,
} from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { authSessions } from '../src/database/schema/admin';
import { trailers } from '../src/database/schema/fleet';
import { loads as loadsTable } from '../src/database/schema/loads';
import { mobileDevices, mobileIdempotency } from '../src/database/schema/mobile';
import { companies, drivers, trucks } from '../src/database/schema/roster';

const API = '/api/v1';
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');
/** A 1×1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');

/**
 * The driver app's backend, end to end (mobile M1, docs/mobile/API.md).
 *
 * Office calls run as the company owner through the development headers; the driver signs in for
 * real (bearer session, client mobile). A local HTTP server stands in for Expo's push service.
 */
describe('Mobile driver app (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let stub: Server;
  const pushes: unknown[] = [];
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const digits = String(Date.now()).slice(-9);
  const phone = `7${digits}`;
  let company = '';
  const OTHER = `co_mob_other_${stamp}`;
  const D1 = `drv_mob1_${stamp}`;
  const D2 = `drv_mob2_${stamp}`;
  const T1 = `trk_mob_${stamp}`;
  const TR1 = `trl_mob_${stamp}`;
  const L1 = `ld_mob1_${stamp}`;
  const L2 = `ld_mob2_${stamp}`;
  const L3 = `ld_mob3_${stamp}`;
  const LB = `ld_mobB_${stamp}`;
  let token = '';
  let token2 = '';
  let deviceId = '';

  const office = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url: `${API}${url}`, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const as = (bearer: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({
      method,
      url: `${API}${url}`,
      headers: { authorization: `Bearer ${bearer}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const driver = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) => as(token, method, url, payload, headers);
  const upload = (url: string, bytes: Buffer, headers: Record<string, string>, bearer = token) =>
    app.inject({ method: 'POST', url: `${API}${url}`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/octet-stream', ...headers }, payload: bytes });

  const stop = (id: string, kind: 'pickup' | 'delivery', seq: number, over: Record<string, unknown> = {}) => ({
    id,
    sequence: seq,
    kind,
    facilityId: '',
    facilityName: `${kind === 'pickup' ? 'Shipper' : 'Receiver'} ${id.slice(-4)}`,
    city: kind === 'pickup' ? 'Chicago' : 'Atlanta',
    state: kind === 'pickup' ? 'IL' : 'GA',
    timezone: kind === 'pickup' ? 'America/Chicago' : 'America/New_York',
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
    loadNumber: `L-${id.replace(/^ld_/, "").toUpperCase()}`,
    status,
    schemaVersion: 2,
    customerId: 'cus_mob',
    customerName: 'Mobile Customer',
    brokerReference: `REF-${id.slice(-6)}`,
    rate: 2100,
    dispatcherId: 'disp_mob',
    dispatcherName: 'Mobile Dispatcher',
    driverId,
    driverName: 'E2E Driver',
    truckId: T1,
    truckUnit: `M${stamp.slice(-5)}`,
    trailerId: TR1,
    trailerUnit: `TM${stamp.slice(-5)}`,
    stops: [stop(`${id}_s1`, 'pickup', 1), stop(`${id}_s2`, 'delivery', 2)],
    charges: [{ id: `${id}_lh`, type: 'linehaul', description: 'Linehaul', amount: 2100, billable: true, payableToDriver: false }],
    timeline: [],
    notes: [{ id: `${id}_n1`, kind: 'driver', body: 'Check in at gate 3', authorName: 'Dispatch', at: '2026-10-19T12:00:00.000Z', pinned: false }, { id: `${id}_n2`, kind: 'internal', body: 'Broker pays slow', authorName: 'Dispatch', at: '2026-10-19T12:00:00.000Z', pinned: false }],
    documents: [],
    dispatchedAt: '2026-10-19T12:00:00.000Z',
    deliveredAt: null,
    invoiceId: null,
    updatedAt: '2026-10-19T12:00:00.000Z',
    ...over,
  });
  const driverRow = (companyId: string, id: string, first: string, ph: string, email: string, truckId: string | null) => ({
    id,
    companyId,
    driverNumber: id,
    firstName: first,
    lastName: 'Mobile',
    phone: ph,
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
    dispatcherId: 'disp_mob',
    dispatcherName: 'Mobile Dispatcher',
    homeCity: 'Columbus',
    homeState: 'OH',
    payPlanKind: 'percentage',
    currentTruckId: truckId,
    currentTrailerId: truckId ? TR1 : null,
  });

  async function signIn(login: string, temporary: string): Promise<string> {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: { email: login, password: temporary, client: 'mobile' } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { token: string; expiresAt: string; account: { kind: string; mustChangePassword: boolean } };
    expect(body.account.kind).toBe('driver');
    // A mobile session lasts 30 days, not the browser's 12 hours.
    expect(Date.parse(body.expiresAt) - Date.now()).toBeGreaterThan(29 * 24 * 3600 * 1000);
    const replaced = await as(body.token, 'POST', '/auth/password/temporary', { newPassword: 'Driver-pass-1234', confirmPassword: 'Driver-pass-1234' });
    expect(replaced.statusCode, replaced.body).toBeLessThan(300);
    return body.token;
  }

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const messages = JSON.parse(body) as unknown[];
        pushes.push(...messages);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: randomUUID() })) }));
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
    const meRes = await office('GET', '/auth/me');
    company = (meRes.json() as { companyId: string }).companyId;
    if (!company) throw new Error(`auth/me: ${meRes.statusCode} ${meRes.body}`);

    await db.insert(companies).values({ id: OTHER, name: `Mobile other ${stamp}` } as typeof companies.$inferInsert);
    await db.insert(trailers).values({ id: TR1, companyId: company, unitNumber: `TM${stamp.slice(-5)}`, currentTruckId: T1 } as typeof trailers.$inferInsert);
    await db.insert(trucks).values({
      id: T1,
      companyId: company,
      unitNumber: `M${stamp.slice(-5)}`,
      vin: `VINMOB${stamp}`.toUpperCase(),
      year: 2022,
      make: 'Freightliner',
      model: 'Cascadia',
      status: 'available',
      health: 'good',
      ownership: 'owned',
      odometer: 100000,
      odometerAt: new Date(),
      engineHours: '10',
      nextServiceOdometer: 120000,
      nextServiceDate: '2027-01-01',
      nextServiceType: 'pm_a',
      telematicsProvider: 'samsara',
      telematicsStatus: 'connected',
      telematicsSyncedAt: new Date(Date.now() - 10 * 60_000),
      location: { lat: 41.88, lng: -87.63, text: 'Chicago, IL' },
      currentDriverId: D1,
      currentTrailerId: TR1,
    } as typeof trucks.$inferInsert);
    await db.insert(drivers).values([
      driverRow(company, D1, 'Ali', phone, `ali.${stamp}@example.test`, T1),
      driverRow(company, D2, 'Bea', `8${digits}`, `bea.${stamp}@example.test`, null),
      driverRow(OTHER, `drv_mobB_${stamp}`, 'Other', '5550001111', `other.${stamp}@example.test`, null),
    ] as never);
    const loadValues = (companyId: string, id: string, status: string, driverId: string, over: Record<string, unknown> = {}) => {
      const r = record(id, status, driverId, over);
      return { id, companyId, loadNumber: r.loadNumber, status, dispatcherId: 'disp_mob', driverId, truckId: T1, trailerId: TR1, version: 1, record: r };
    };
    await db.insert(loadsTable).values([
      loadValues(company, L1, 'dispatched', D1),
      loadValues(company, L2, 'dispatched', D2),
      loadValues(company, L3, 'delivered', D1, {
        deliveredAt: '2026-10-20T20:00:00.000Z',
        stops: [stop(`${L3}_s1`, 'pickup', 1, { status: 'completed', arrivedAt: '2026-10-20T13:00:00.000Z', departedAt: '2026-10-20T14:00:00.000Z' }), stop(`${L3}_s2`, 'delivery', 2, { status: 'completed', arrivedAt: '2026-10-20T19:00:00.000Z', departedAt: '2026-10-20T20:00:00.000Z' })],
        documents: [{ id: `${L3}_rc`, type: 'rate_confirmation', title: 'Rate confirmation', fileName: 'rc.pdf', uploadedAt: '2026-10-19T12:00:00.000Z', uploadedBy: 'Dispatch', status: 'verified', review: 'verified', fileHash: `rc_${stamp}` }],
      }),
      // Another company's load naming the same driver id: still not this driver's.
      loadValues(OTHER, LB, 'dispatched', D1),
    ] as never);
  }, 120_000);

  afterAll(async () => {
    setFeatureFlagForTests('fleet_v2', null);
    await app?.close();
    await new Promise<void>((resolve) => stub?.close(() => resolve()));
  });

  // ------------------------------------------------------------------ access

  it('gives a driver app access from the profile: login by phone, temporary password once, audited', async () => {
    const before = await office('GET', `/drivers/${D1}/app-access`);
    expect(before.statusCode).toBe(200);
    expect(before.json().state).toBe('none');

    const res = await office('POST', `/drivers/${D1}/app-access`, { login: `+1 (${phone.slice(0, 3)}) ${phone.slice(3)}` });
    expect(res.statusCode, res.body).toBe(200);
    const given = res.json() as GiveAppAccessResponse;
    expect(given.temporaryPassword).toBeTruthy();
    expect(given.access.login).toBe(`${phone}@phone.neway`);
    expect(given.access.loginHint).toBe(phone);
    expect(given.access.state).toBe('invited');
    // Shown once: the status read never carries it.
    const after = await office('GET', `/drivers/${D1}/app-access`);
    expect(JSON.stringify(after.json())).not.toContain(given.temporaryPassword!);
    // Twice is refused.
    expect((await office('POST', `/drivers/${D1}/app-access`, {})).statusCode).toBe(409);

    // The phone digits alone sign in (the existing short-name login rule).
    token = await signIn(phone, given.temporaryPassword!);

    const second = (await office('POST', `/drivers/${D2}/app-access`, {})).json() as GiveAppAccessResponse;
    token2 = await signIn(`bea.${stamp}@example.test`, second.temporaryPassword!);
  });

  it('resolves the driver on the server: /driver/me is my driver, my truck, ELD freshness, no invented HOS', async () => {
    const res = await driver('GET', '/driver/me');
    expect(res.statusCode, res.body).toBe(200);
    const me = res.json() as DriverMe;
    expect(me.driver.id).toBe(D1);
    expect(me.company.id).toBe(company);
    expect(me.truck?.id).toBe(T1);
    expect(me.trailer?.id).toBe(TR1);
    expect(me.telematics?.freshness).toBe('fresh');
    expect(me.telematics?.hos.available).toBe(false);
    expect(me.dispatch?.name).toBe('Mobile Dispatcher');
  });

  it('lists only my own loads; another driver\'s load and another company\'s load are 404; a client driver id is ignored', async () => {
    // A company id from the client is refused outright (CompanyScopeGuard); a driver id is ignored.
    const picked = await driver('GET', `/driver/loads?scope=active&companyId=${OTHER}`);
    expect(picked.statusCode, picked.body).toBe(400);
    const activeRes = await driver('GET', `/driver/loads?scope=active&driverId=${D2}`);
    expect(activeRes.statusCode, activeRes.body).toBe(200);
    const active = activeRes.json() as DriverLoadsResponse;
    const ids = active.loads.map((l) => l.id);
    expect(ids).toContain(L1);
    expect(ids).not.toContain(L2);
    expect(ids).not.toContain(LB);
    const completedRes = await driver('GET', '/driver/loads?scope=completed');
    expect(completedRes.statusCode, completedRes.body).toBe(200);
    const completed = completedRes.json() as DriverLoadsResponse;
    expect(completed.loads.map((l) => l.id)).toContain(L3);

    expect((await driver('GET', `/driver/loads/${L2}`)).statusCode).toBe(404);
    expect((await driver('GET', `/driver/loads/${LB}`)).statusCode).toBe(404);
    expect((await as(token2, 'GET', `/driver/loads/${L1}`)).statusCode).toBe(404);

    const detail = (await driver('GET', `/driver/loads/${L1}`)).json() as DriverLoadDetail;
    expect(detail.stops[0]?.timezone).toBe('America/Chicago');
    expect(detail.stops[0]?.appointmentStartAt).toBe('2026-10-20T13:00:00.000Z');
    expect(detail.driverNotes.map((n) => n.body)).toEqual(['Check in at gate 3']);
    expect(JSON.stringify(detail)).not.toContain('2100');
    expect(JSON.stringify(detail)).not.toContain('Broker pays slow');
  });

  it('refuses /driver/* to an office account without a driver link, and office routes to a driver', async () => {
    // A role without driver_app.use: 403 at the guard.
    expect((await office('GET', '/driver/me', undefined, { 'x-demo-role': 'operations' })).statusCode).toBe(403);
    // The owner holds every code, but has no linked driver: 403 from the driver resolver.
    expect((await office('GET', '/driver/me')).statusCode).toBe(403);
    // A driver login opens no office route.
    expect((await driver('GET', `/loads/${L1}`)).statusCode).toBe(403);
    expect((await driver('GET', '/fleet/pti/board')).statusCode).toBe(403);
    expect((await driver('GET', '/accounting/billing/queue')).statusCode).toBe(403);
    expect((await driver('POST', `/drivers/${D1}/app-access`, {})).statusCode).toBe(403);
  });

  // ------------------------------------------------------------------ loads

  it('needs an Idempotency-Key on every driver write', async () => {
    expect((await driver('POST', `/driver/loads/${L1}/ack`, {})).statusCode).toBe(428);
  });

  it('acknowledges a load once, and a retry with the same key answers the same', async () => {
    const key = randomUUID();
    const first = await driver('POST', `/driver/loads/${L1}/ack`, {}, { 'idempotency-key': key });
    expect(first.statusCode, first.body).toBe(200);
    expect((first.json() as DriverLoadDetail).acknowledgedAt).toBeTruthy();
    const again = await driver('POST', `/driver/loads/${L1}/ack`, {}, { 'idempotency-key': key });
    expect(again.json()).toEqual(first.json());
    // The same key on another route is refused.
    expect((await driver('POST', `/driver/loads/${L1}/stop-event`, { stopId: `${L1}_s1`, kind: 'arrived' }, { 'idempotency-key': key })).statusCode).toBe(422);
  });

  it('records an arrival through the transition door: source driver app, actual vs recorded kept apart', async () => {
    const at = new Date(Date.now() - 20 * 60_000).toISOString();
    const res = await driver('POST', `/driver/loads/${L1}/stop-event`, { stopId: `${L1}_s1`, kind: 'arrived', at, delayReason: 'Traffic on I-90' }, { 'idempotency-key': randomUUID() });
    expect(res.statusCode, res.body).toBe(200);
    const detail = res.json() as DriverLoadDetail;
    expect(detail.status).toBe('at_pickup');
    const stop1 = detail.stops.find((s) => s.id === `${L1}_s1`)!;
    expect(stop1.arrivedAt).toBe(at);
    expect(stop1.appointmentStartAt).toBe('2026-10-20T13:00:00.000Z');
    const entry = stop1.eventLog.at(-1)!;
    expect(entry.source).toBe('driver_app');
    expect(entry.at).toBe(at);
    expect(entry.recordedAt).not.toBe(at);
    expect(entry.delayReason).toBe('Traffic on I-90');

    const load = (await office('GET', `/loads/${L1}`)).json() as { timeline: Array<{ actorName: string; actorType: string }>; lastChangedBy: { source: string } };
    expect(load.timeline.at(-1)?.actorName).toContain('Driver app');
    expect(load.timeline.at(-1)?.actorType).toBe('driver');
    expect(load.lastChangedBy.source).toBe('driver_app');
  });

  it('files a BOL from the phone on the load as received, without moving the load; a retry makes no second document', async () => {
    const key = randomUUID();
    const headers = { 'idempotency-key': key, 'x-file-name': 'bol-scan.jpg', 'x-doc-type': 'bol', 'x-stop-id': `${L1}_s1` };
    const res = await upload(`/driver/loads/${L1}/documents`, JPEG, headers);
    expect(res.statusCode, res.body).toBe(201);
    const filed = res.json() as DriverDocumentUploadResponse;
    expect(filed.document.state).toBe('received');
    expect(filed.document.stateLabel).toBe('Received by TMS · Needs review');
    expect(filed.document.source).toBe('driver_app');
    expect(filed.document.mine).toBe(true);

    const retry = await upload(`/driver/loads/${L1}/documents`, JPEG, headers);
    expect(retry.statusCode).toBe(201);
    expect((retry.json() as DriverDocumentUploadResponse).document.id).toBe(filed.document.id);

    const load = (await office('GET', `/loads/${L1}`)).json() as { status: string; documents: Array<{ id: string; type: string; review: string; source?: string; fileId?: string }> };
    expect(load.status).toBe('at_pickup');
    const bols = load.documents.filter((d) => d.type === 'bol');
    expect(bols).toHaveLength(1);
    expect(bols[0]).toMatchObject({ id: filed.document.id, review: 'received', source: 'driver_app', fileId: filed.document.fileId });
    const [rows] = await db.select().from(mobileIdempotency).where(eq(mobileIdempotency.key, key));
    expect(rows?.completedAt).toBeTruthy();

    // The driver opens their own file through a signed link; a type that is not a paper is refused.
    const link = await driver('GET', `/driver/files/${filed.document.fileId}/link`);
    expect(link.statusCode).toBe(200);
    const bytes = await app.inject({ method: 'GET', url: (link.json() as { url: string }).url, headers: { authorization: `Bearer ${token}` } });
    expect(bytes.statusCode).toBe(200);
    expect((await upload(`/driver/loads/${L1}/documents`, Buffer.from('GIF89a.....'), { ...headers, 'idempotency-key': randomUUID() })).statusCode).toBe(415);
    expect((await upload(`/driver/loads/${L2}/documents`, JPEG, { ...headers, 'idempotency-key': randomUUID() })).statusCode).toBe(404);
  });

  it('files TONU, layover and detention papers from the phone under those load document types; an unknown type is refused', async () => {
    for (const type of ['tonu', 'layover', 'detention'] as const) {
      const res = await upload(`/driver/loads/${L1}/documents`, JPEG, { 'idempotency-key': randomUUID(), 'x-file-name': `${type}.jpg`, 'x-doc-type': type });
      expect(res.statusCode, res.body).toBe(201);
      expect((res.json() as DriverDocumentUploadResponse).document.type).toBe(type);
    }
    const load = (await office('GET', `/loads/${L1}`)).json() as { status: string; documents: Array<{ type: string; source?: string; review: string }> };
    expect(load.status).toBe('at_pickup');
    for (const type of ['tonu', 'layover', 'detention']) {
      expect(load.documents.filter((d) => d.type === type)).toEqual([expect.objectContaining({ source: 'driver_app', review: 'received' })]);
    }
    const detail = (await driver('GET', `/driver/loads/${L1}`)).json() as DriverLoadDetail;
    expect(detail.documents.map((d) => d.type)).toEqual(expect.arrayContaining(['tonu', 'layover', 'detention']));
    const bad = await upload(`/driver/loads/${L1}/documents`, JPEG, { 'idempotency-key': randomUUID(), 'x-file-name': 'rc.jpg', 'x-doc-type': 'rate_confirmation' });
    expect(bad.statusCode).toBe(422);
  });

  it('registers the phone for push', async () => {
    const res = await driver('POST', '/mobile/devices', { expoToken: `ExponentPushToken[${stamp}]`, platform: 'android', appVersion: '1.0.0' });
    expect(res.statusCode, res.body).toBe(200);
    deviceId = (res.json() as MobileDevice).id;
    expect((res.json() as MobileDevice).revokedAt).toBeNull();
  });

  let podId = '';
  it('puts a delivered load with a driver-app POD in Billing "Needs review" without creating an invoice', async () => {
    const queue = async () => (await office('GET', '/accounting/billing/queue')).json() as { rows: Array<{ load: { id: string }; verdict: { queue: string; conditions: Array<{ code: string }> }; invoice: unknown }> };
    const before = (await queue()).rows.find((r) => r.load.id === L3);
    expect(before?.verdict.queue).toBe('needs_documents');

    const res = await upload(`/driver/loads/${L3}/documents`, PDF, { 'idempotency-key': randomUUID(), 'x-file-name': 'pod.pdf', 'x-doc-type': 'pod', 'x-stop-id': `${L3}_s2`, 'x-page-count': '2' });
    expect(res.statusCode, res.body).toBe(201);
    const doc = (res.json() as DriverDocumentUploadResponse).document;
    podId = doc.id;
    expect(doc.pageCount).toBe(2);

    const row = (await queue()).rows.find((r) => r.load.id === L3);
    expect(row?.verdict.queue).toBe('needs_review');
    expect(row?.verdict.conditions.map((c) => c.code)).toContain('driver_document_unreviewed');
    expect(row?.invoice).toBeNull();
    const load = (await office('GET', `/loads/${L3}`)).json() as { status: string; invoiceId: string | null };
    expect(load.status).toBe('delivered');
    expect(load.invoiceId).toBeNull();
  });

  it('Request correction (reject with a reason) reaches the driver: status, reason, notification row, generic push', async () => {
    const load = (await office('GET', `/loads/${L3}`)).json() as { updatedAt: string };
    const pushedBefore = pushes.length;
    const res = await office('POST', `/accounting/billing/loads/${L3}/documents/${podId}/review`, { review: 'rejected', reason: 'Receiver signature missing', expectedUpdatedAt: load.updatedAt });
    expect(res.statusCode, res.body).toBeLessThan(300);

    const detail = (await driver('GET', `/driver/loads/${L3}`)).json() as DriverLoadDetail;
    const doc = detail.documents.find((d) => d.id === podId)!;
    expect(doc.state).toBe('correction_requested');
    expect(doc.stateLabel).toBe('Correction requested');
    expect(doc.correctionReason).toBe('Receiver signature missing');

    const inbox = (await driver('GET', '/mobile/notifications')).json() as MobileNotificationsResponse;
    const note = inbox.notifications.find((n) => n.title.includes('Correction requested'));
    expect(note?.target).toEqual({ type: 'load', id: L3 });
    expect(note?.body).toContain('Receiver signature missing');
    expect(inbox.unread).toBeGreaterThan(0);
    // Another driver's inbox does not have it.
    const other = (await as(token2, 'GET', '/mobile/notifications')).json() as MobileNotificationsResponse;
    expect(other.notifications.some((n) => n.id === note?.id)).toBe(false);

    expect(pushes.length).toBeGreaterThan(pushedBefore);
    const sent = pushes.at(-1) as { to: string; title: string; body: string; data: Record<string, unknown> };
    expect(sent.to).toBe(`ExponentPushToken[${stamp}]`);
    expect(sent.data).toMatchObject({ type: 'load', id: L3, notificationId: note?.id });
    expect(Object.keys(sent.data).sort()).toEqual(['id', 'notificationId', 'type']);
    // Nothing sensitive in the push: no reason, no amount, no file content.
    expect(JSON.stringify(sent)).not.toContain('signature');
    expect(JSON.stringify(sent)).not.toContain('2100');

    const read = await driver('POST', `/mobile/notifications/${note!.id}/read`);
    expect(read.statusCode).toBe(200);
  });

  it('a resubmission keeps the previous version on the load', async () => {
    const res = await upload(`/driver/loads/${L3}/documents`, PDF, { 'idempotency-key': randomUUID(), 'x-file-name': 'pod-2.pdf', 'x-doc-type': 'pod', 'x-stop-id': `${L3}_s2`, 'x-replaces-id': podId });
    expect(res.statusCode, res.body).toBe(201);
    const fresh = (res.json() as DriverDocumentUploadResponse).document;
    expect(fresh.replacesId).toBe(podId);
    const detail = (await driver('GET', `/driver/loads/${L3}`)).json() as DriverLoadDetail;
    const old = detail.documents.find((d) => d.id === podId)!;
    expect(old.state).toBe('replaced');
    expect(old.supersededBy).toBe(fresh.id);
    expect(detail.documents.find((d) => d.id === fresh.id)?.state).toBe('received');
  });

  // ------------------------------------------------------------------ PTI

  let inspection: PtiInspection;
  it('sends a PTI from the app: Safety sees it received and unreviewed, the review count goes up by one, defects open', async () => {
    const before = (await office('GET', '/fleet/pti/board')).json() as PtiBoard;
    const current = (await driver('GET', '/driver/pti/current')).json() as DriverPtiCurrent;
    expect(current.truck?.id).toBe(T1);
    expect(current.state).toBe('not_submitted');
    expect(current.canSubmit).toBe(true);
    expect(current.checklist.length).toBeGreaterThan(3);

    const photo = await upload('/driver/files', PNG, { 'idempotency-key': randomUUID(), 'x-file-name': 'tire.png' });
    expect(photo.statusCode, photo.body).toBe(201);
    const photoId = (photo.json() as DriverFileUploadResponse).fileId;

    const [bad, ...rest] = current.checklist;
    const checklist = [
      { key: bad!.key, result: 'defect', note: 'Sidewall bulge on the left steer tire', photoFileIds: [photoId] },
      ...rest.map((i, n) => ({ key: i.key, result: n === 0 ? 'attention' : 'good', note: n === 0 ? 'Low a little' : null, photoFileIds: [] })),
    ];
    const key = randomUUID();
    const res = await driver('POST', '/driver/pti', { checklist, notes: 'All else fine', odometer: 100500 }, { 'idempotency-key': key });
    expect(res.statusCode, res.body).toBe(200);
    const sent = res.json() as DriverPtiCurrent;
    expect(sent.state).toBe('received');
    expect(sent.stateLabel).toBe('Received by TMS · Needs review');
    expect(sent.defects).toHaveLength(1);
    expect(sent.defects[0]?.state).toBe('open');
    // A retry is the first answer, not a second submission.
    const again = await driver('POST', '/driver/pti', { checklist, notes: 'All else fine', odometer: 100500 }, { 'idempotency-key': key });
    expect((again.json() as DriverPtiCurrent).submission?.submissionNumber).toBe(1);

    const board = (await office('GET', '/fleet/pti/board')).json() as PtiBoard;
    const row = board.rows.find((r) => r.inspection.unitId === T1)!;
    expect(['received', 'late']).toContain(row.inspection.receiptStatus);
    expect(row.inspection.reviewState).toBe('unreviewed');
    expect(row.inspection.driverSubmission?.driverId).toBe(D1);
    expect(board.queues.review).toBe(before.queues.review + 1);
    inspection = row.inspection;

    // Safety opens the photo through the inspection.
    expect((await office('GET', `/files/${photoId}/link`)).statusCode).toBe(200);
  });

  it('Safety requests a correction: the driver sees it with the reason and a notification; the resubmission keeps the history', async () => {
    const res = await office('POST', `/fleet/pti/inspections/${inspection.id}/request-correction`, { version: inspection.version, reason: 'Video too dark, redo the trailer side' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const seen = (await driver('GET', '/driver/pti/current')).json() as DriverPtiCurrent;
    expect(seen.state).toBe('correction_requested');
    expect(seen.correction?.reason).toBe('Video too dark, redo the trailer side');
    expect(seen.canSubmit).toBe(true);
    const inbox = (await driver('GET', '/mobile/notifications')).json() as MobileNotificationsResponse;
    expect(inbox.notifications.some((n) => n.target?.type === 'pti' && n.target.id === inspection.id)).toBe(true);

    const checklist = seen.checklist.map((i, n) => ({ key: i.key, result: n === 0 ? 'defect' : 'good', note: n === 0 ? 'Sidewall bulge on the left steer tire' : null, photoFileIds: [] }));
    const again = await driver('POST', '/driver/pti', { checklist, notes: 'Redone in daylight' }, { 'idempotency-key': randomUUID() });
    expect(again.statusCode, again.body).toBe(200);
    const after = again.json() as DriverPtiCurrent;
    expect(after.state).toBe('received');
    expect(after.submission?.submissionNumber).toBe(2);
    expect(after.history).toHaveLength(1);
    expect(after.history[0]?.notes).toBe('All else fine');
    // The same defect is not raised twice.
    expect(after.defects).toHaveLength(1);
  });

  it('linking the defect to a Fleet work order does not mark it repaired', async () => {
    const defect = (await office('GET', `/fleet/pti/defects?unitId=${T1}&open=true`)).json() as PtiDefect[];
    const d = defect[0]!;
    const res = await office('POST', `/fleet/pti/defects/${d.id}/transition`, { version: d.version, to: 'scheduled', workOrderId: `wo_mob_${stamp}`, workOrderNumber: 'WO-MOB-1' });
    expect(res.statusCode, res.body).toBeLessThan(300);
    const seen = (await driver('GET', '/driver/pti/current')).json() as DriverPtiCurrent;
    expect(seen.defects[0]?.state).toBe('scheduled');
    expect(['fixed_pending_verify', 'verified']).not.toContain(seen.defects[0]?.state);
    // The review is a separate answer from the Fleet status.
    expect(seen.state).toBe('received');
  });

  // ------------------------------------------------------------------ session

  it('logout ends the session and revokes the phone\'s push device', async () => {
    const res = await driver('POST', '/auth/logout');
    expect(res.statusCode).toBeLessThan(300);
    const [device] = await db.select().from(mobileDevices).where(eq(mobileDevices.id, deviceId));
    expect(device?.revokedAt).toBeTruthy();
    expect(device?.revokedReason).toBe('logout');
    expect((await driver('GET', '/driver/me')).statusCode).toBe(401);
  });

  it('revoking app access ends every session of the driver login', async () => {
    const res = await office('POST', `/drivers/${D2}/app-access/revoke`, { reason: 'Left the company' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json().state).toBe('revoked');
    expect((await as(token2, 'GET', '/driver/me')).statusCode).toBe(401);
    const live = await db.select().from(authSessions).where(and(eq(authSessions.companyId, company)));
    expect(live.filter((s) => s.userId && s.revokedAt === null && s.membershipId === res.json().membershipId)).toHaveLength(0);
  });
});
