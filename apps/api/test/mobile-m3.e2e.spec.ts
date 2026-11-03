import { createServer, type Server } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  DriverBreakdown,
  DriverBreakdownList,
  DriverCareList,
  DriverCareRequest,
  DriverDocumentList,
  DriverFileUploadResponse,
  DriverReferral,
  DriverReferralList,
  DriverReimbursement,
  DriverReimbursementList,
  DriverSafetyReport,
  DriverSafetyReportList,
  DriverSettlementDetail,
  DriverSettlementList,
  DriverVacationRequestList,
  DriverVacationRequestView,
  FleetBreakdown,
  FleetBreakdownList,
  GiveAppAccessResponse,
  VacationRequestList,
} from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { notifications } from '../src/database/schema/admin';
import { trailers, vendors, workOrders } from '../src/database/schema/fleet';
import { hiringLeads } from '../src/database/schema/hiring';
import { loads as loadsTable } from '../src/database/schema/loads';
import { driverAppSubmissions, fleetBreakdowns } from '../src/database/schema/mobile';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import { AccountingStore } from '../src/modules/accounting/store.service';

const API = '/api/v1';
const JPEG = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(2048), Buffer.from([0xff, 0xd9])]);
const PDF = () => Buffer.from(`%PDF-1.4\n% ${randomUUID()}\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n`);

/**
 * The driver app, phase M3, end to end (docs/mobile/API.md §7-§14): breakdowns, receipts, pay
 * statements, Driver Care, referrals, vacations, qualification documents and safety reports.
 *
 * For each: the driver files it → the office sees the same record where it already works →
 * the office acts → the driver reads the new status and has a notification. Retries with the same
 * Idempotency-Key write one record; another driver and another company get 404; an office role
 * without the permission gets 403.
 */
describe('Mobile driver app M3 (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let store: AccountingStore;
  let stub: Server;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const digits = String(Date.now()).slice(-9);
  let company = '';
  const OTHER = `co_m3_other_${stamp}`;
  const D1 = `drv_m3a_${stamp}`;
  const D2 = `drv_m3b_${stamp}`;
  const T1 = `trk_m3_${stamp}`;
  const TR1 = `trl_m3_${stamp}`;
  const L1 = `ld_m3a_${stamp}`;
  const L2 = `ld_m3b_${stamp}`;
  const V1 = `ven_m3_${stamp}`;
  const L3 = `ld_m3c_${stamp}`;
  let token = '';
  let token2 = '';
  let userD1 = '';

  const office = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url: `${API}${url}`, headers: { ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) }, ...(payload !== undefined ? { payload: payload as object } : {}) });
  const NO_PERMS = { 'x-demo-role': 'operations' };
  const as = (bearer: string, method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({
      method,
      url: `${API}${url}`,
      headers: { authorization: `Bearer ${bearer}`, ...(payload !== undefined ? { 'content-type': 'application/json' } : {}), ...(headers ?? {}) },
      ...(payload !== undefined ? { payload: payload as object } : {}),
    });
  const driver = (method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) => as(token, method, url, payload, key ? { 'idempotency-key': key } : undefined);
  const key = () => randomUUID();
  async function upload(bytes: Buffer, name: string, bearer = token): Promise<string> {
    const res = await app.inject({ method: 'POST', url: `${API}/driver/files`, headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/octet-stream', 'idempotency-key': key(), 'x-file-name': name }, payload: bytes });
    expect(res.statusCode, res.body).toBe(201);
    return (res.json() as DriverFileUploadResponse).fileId;
  }
  /** Notification rows addressed to the driver's account for one record. */
  const driverNotes = async (entityType: string, entityId: string) =>
    db.select().from(notifications).where(and(eq(notifications.companyId, company), eq(notifications.recipientUserId, userD1), eq(notifications.entityType, entityType), eq(notifications.entityId, entityId)));
  /** Notification rows about a record addressed to anybody but the driver: the office team. */
  const officeNotes = async (entityType: string, entityId: string) =>
    (await db.select().from(notifications).where(and(eq(notifications.companyId, company), eq(notifications.entityType, entityType), eq(notifications.entityId, entityId)))).filter((n) => n.recipientUserId !== userD1);

  async function signIn(login: string, temporary: string): Promise<{ token: string; userId: string }> {
    const res = await app.inject({ method: 'POST', url: `${API}/auth/login`, headers: { 'content-type': 'application/json' }, payload: { email: login, password: temporary, client: 'mobile' } });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { token: string; account: { userId?: string; id?: string } };
    const replaced = await as(body.token, 'POST', '/auth/password/temporary', { newPassword: 'Driver-pass-1234', confirmPassword: 'Driver-pass-1234' });
    expect(replaced.statusCode, replaced.body).toBeLessThan(300);
    const me = (await as(body.token, 'GET', '/auth/me')).json() as { userId?: string; user?: { id: string } };
    return { token: body.token, userId: me.userId ?? me.user?.id ?? '' };
  }

  const driverRow = (companyId: string, id: string, first: string, ph: string, email: string, truckId: string | null) => ({
    id,
    companyId,
    driverNumber: id,
    firstName: first,
    lastName: 'Mthree',
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
    status: 'available',
    dispatcherId: 'disp_m3',
    dispatcherName: 'M3 Dispatcher',
    homeCity: 'Columbus',
    homeState: 'OH',
    payPlanKind: 'percent_of_linehaul',
    payPlanRate: '30',
    currentTruckId: truckId,
    currentTrailerId: truckId ? TR1 : null,
  });
  const loadRecord = (id: string, driverId: string) => ({
    id,
    loadNumber: `L-${id.replace(/^ld_/, '').toUpperCase()}`,
    status: 'dispatched',
    schemaVersion: 2,
    customerId: 'cus_m3',
    customerName: 'M3 Customer',
    rate: 1800,
    dispatcherId: 'disp_m3',
    dispatcherName: 'M3 Dispatcher',
    driverId,
    driverName: 'E2E Driver',
    truckId: T1,
    truckUnit: `M3${stamp.slice(-5)}`,
    trailerId: TR1,
    trailerUnit: `TM3${stamp.slice(-5)}`,
    stops: [
      { id: `${id}_s1`, sequence: 1, kind: 'pickup', facilityId: '', facilityName: 'Shipper', city: 'Chicago', state: 'IL', timezone: 'America/Chicago', appointmentStartAt: '2026-10-20T13:00:00.000Z', appointmentEndAt: null, appointmentNoWindow: false, status: 'pending', arrivedAt: null, departedAt: null, detentionMinutes: 0, notes: null },
      { id: `${id}_s2`, sequence: 2, kind: 'delivery', facilityId: '', facilityName: 'Receiver', city: 'Atlanta', state: 'GA', timezone: 'America/New_York', appointmentStartAt: '2026-10-21T13:00:00.000Z', appointmentEndAt: null, appointmentNoWindow: false, status: 'pending', arrivedAt: null, departedAt: null, detentionMinutes: 0, notes: null },
    ],
    charges: [],
    timeline: [],
    notes: [],
    documents: [],
    dispatchedAt: '2026-10-19T12:00:00.000Z',
    deliveredAt: null,
    invoiceId: null,
    updatedAt: '2026-10-19T12:00:00.000Z',
  });

  beforeAll(async () => {
    stub = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const messages = JSON.parse(body) as unknown[];
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ data: messages.map(() => ({ status: 'ok', id: randomUUID() })) }));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    process.env.EXPO_PUSH_URL = `http://127.0.0.1:${(stub.address() as AddressInfo).port}/push`;
    setFeatureFlagForTests('fleet_v2', true);
    setFeatureFlagForTests('accidents_v2', true);
    setFeatureFlagForTests('safety_v2', true);

    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    store = app.get(AccountingStore);
    const meRes = await office('GET', '/auth/me');
    company = (meRes.json() as { companyId: string }).companyId;
    if (!company) throw new Error(`auth/me: ${meRes.statusCode} ${meRes.body}`);

    await db.insert(companies).values({ id: OTHER, name: `M3 other ${stamp}` } as typeof companies.$inferInsert);
    await db.insert(trailers).values({ id: TR1, companyId: company, unitNumber: `TM3${stamp.slice(-5)}`, currentTruckId: T1 } as typeof trailers.$inferInsert);
    await db.insert(trucks).values({
      id: T1,
      companyId: company,
      unitNumber: `M3${stamp.slice(-5)}`,
      vin: `VINM3${stamp}`.toUpperCase(),
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
      currentDriverId: D1,
      currentTrailerId: TR1,
    } as typeof trucks.$inferInsert);
    await db.insert(drivers).values([
      driverRow(company, D1, 'Ali', `6${digits}`, `ali.m3.${stamp}@example.test`, T1),
      driverRow(company, D2, 'Bea', `5${digits}`, `bea.m3.${stamp}@example.test`, null),
    ] as never);
    await db.insert(loadsTable).values([
      { id: L1, companyId: company, loadNumber: loadRecord(L1, D1).loadNumber, status: 'dispatched', dispatcherId: 'disp_m3', driverId: D1, truckId: T1, trailerId: TR1, version: 1, record: loadRecord(L1, D1) },
      { id: L2, companyId: company, loadNumber: loadRecord(L2, D2).loadNumber, status: 'dispatched', dispatcherId: 'disp_m3', driverId: D2, truckId: T1, trailerId: TR1, version: 1, record: loadRecord(L2, D2) },
    ] as never);
    // A load delivered in the pay week, so the statement has earnings to post.
    await db.insert(loadsTable).values({ id: L3, companyId: company, loadNumber: `L-M3C-${stamp}`, status: 'delivered', dispatcherId: 'disp_m3', driverId: D1, truckId: T1, version: 1, record: { id: L3, loadNumber: `L-M3C-${stamp}`, status: 'delivered', driverId: D1, truckId: T1, deliveredAt: `${plus(WEEK_MON, 3)}T15:00:00.000Z`, updatedAt: `${plus(WEEK_MON, 3)}T15:00:00.000Z`, rate: 1000, loadedMiles: 500, emptyMiles: 0, documents: [], timeline: [], notes: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 1000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } } as never);
    await db.insert(vendors).values({ id: V1, companyId: company, name: `M3 Truck Repair ${stamp}`, kind: 'shop' } as typeof vendors.$inferInsert);

    const a = (await office('POST', `/drivers/${D1}/app-access`, {})).json() as GiveAppAccessResponse;
    const s1 = await signIn(`ali.m3.${stamp}@example.test`, a.temporaryPassword!);
    token = s1.token;
    userD1 = s1.userId;
    const b = (await office('POST', `/drivers/${D2}/app-access`, {})).json() as GiveAppAccessResponse;
    token2 = (await signIn(`bea.m3.${stamp}@example.test`, b.temporaryPassword!)).token;
    expect(userD1).toBeTruthy();
  }, 120_000);

  afterAll(async () => {
    setFeatureFlagForTests('fleet_v2', null);
    setFeatureFlagForTests('accidents_v2', null);
    setFeatureFlagForTests('safety_v2', null);
    await app?.close();
    await new Promise<void>((resolve) => stub?.close(() => resolve()));
  });

  // ================================================================== E1 · breakdowns

  let breakdownId = '';

  it('E1 · a driver reports a breakdown: case BD-…, received, on their truck, the load flagged for Dispatch, Fleet notified', async () => {
    const photo = await upload(JPEG(), 'tire.jpg');
    const k = key();
    const body = { category: 'tire', description: 'Right steer tire blew out on I-65', loadId: L1, location: { text: 'I-65 mile 112, Franklin, TN', lat: 35.9, lng: -86.8, source: 'gps', captured_at: new Date().toISOString() }, fileIds: [photo] };
    const res = await driver('POST', '/driver/breakdowns', body, k);
    expect(res.statusCode, res.body).toBe(201);
    const bd = res.json() as DriverBreakdown;
    breakdownId = bd.id;
    expect(bd.number).toMatch(/^BD-\d{4,}$/);
    expect(bd.status).toBe('received');
    expect(bd.truck?.id).toBe(T1);
    expect(bd.trailer?.id).toBe(TR1);
    expect(bd.load?.id).toBe(L1);
    expect(bd.steps.map((s) => s.status)).toEqual(['received', 'assigned', 'shop_arranged', 'in_repair', 'ready', 'closed']);

    // A retry with the same key: the same case, no second row.
    const again = await driver('POST', '/driver/breakdowns', body, k);
    expect(again.statusCode, again.body).toBe(201);
    expect((again.json() as DriverBreakdown).id).toBe(bd.id);
    const rows = await db.select().from(fleetBreakdowns).where(and(eq(fleetBreakdowns.companyId, company), eq(fleetBreakdowns.driverId, D1)));
    expect(rows.length).toBe(1);

    // Fleet sees the same case; Dispatch sees the Breakdown flag on the load; Fleet was told (targeted).
    const seen = (await office('GET', `/fleet/breakdowns/${bd.id}`)).json() as FleetBreakdown;
    expect(seen).toMatchObject({ id: bd.id, number: bd.number, status: 'received', source: 'driver_app', driver: { id: D1 } });
    const list = (await office('GET', '/fleet/breakdowns?open=true')).json() as FleetBreakdownList;
    expect(list.breakdowns.map((b) => b.id)).toContain(bd.id);
    const flags = (await office('GET', `/loads/${L1}/problems`)).json() as Array<{ id: string; kind: string; closedAt: string | null }>;
    expect(flags.find((f) => f.id === seen.loadProblemId)).toMatchObject({ kind: 'breakdown', closedAt: null });
    const told = await officeNotes('breakdown', bd.id);
    expect(told.length).toBeGreaterThan(0);
    expect(told.every((n) => n.recipientUserId !== null)).toBe(true);
    // Fleet Today carries the count.
    const today = (await office('GET', '/fleet/today')).json() as { counts: { breakdownsOpen?: number } };
    expect(today.counts.breakdownsOpen).toBeGreaterThan(0);
  });

  it('E1 · refuses a unit or a load that is not the driver\'s; another driver and another company get 404', async () => {
    expect((await driver('POST', '/driver/breakdowns', { category: 'engine', description: 'Engine light', loadId: L2, location: { text: 'x', source: 'manual' } }, key())).statusCode).toBe(404);
    expect((await driver('POST', '/driver/breakdowns', { category: 'engine', description: 'Engine light', truckId: 'trk_not_mine', location: { text: 'x', source: 'manual' } }, key())).statusCode).toBe(422);
    expect((await as(token2, 'GET', `/driver/breakdowns/${breakdownId}`)).statusCode).toBe(404);
    const otherId = `bd_other_${stamp}`;
    await db.insert(fleetBreakdowns).values({ id: otherId, companyId: OTHER, number: 'BD-9001', driverId: D1, category: 'tire', description: 'other company', status: 'received' });
    expect((await driver('GET', `/driver/breakdowns/${otherId}`)).statusCode).toBe(404);
    expect(((await driver('GET', '/driver/breakdowns')).json() as DriverBreakdownList).breakdowns.map((b) => b.id)).toEqual([breakdownId]);
    // Office roles without maintenance permissions.
    expect((await office('GET', '/fleet/breakdowns', undefined, NO_PERMS)).statusCode).toBe(403);
    expect((await office('POST', `/fleet/breakdowns/${breakdownId}/assign`, { version: 1, userId: 'x' }, NO_PERMS)).statusCode).toBe(403);
  });

  it('E1 · Fleet assigns, arranges the shop, opens a work order in the shop: the driver sees each step; nothing is marked repaired', async () => {
    const me = (await office('GET', '/auth/me')).json() as { userId?: string; user?: { id: string } };
    const officeUser = me.userId ?? me.user!.id;
    let bd = (await office('GET', `/fleet/breakdowns/${breakdownId}`)).json() as FleetBreakdown;
    const assigned = await office('POST', `/fleet/breakdowns/${breakdownId}/assign`, { version: bd.version, userId: officeUser });
    expect(assigned.statusCode, assigned.body).toBe(201);
    bd = assigned.json() as FleetBreakdown;
    expect(bd.status).toBe('assigned');
    // A stale version is a conflict, never an overwrite.
    expect((await office('POST', `/fleet/breakdowns/${breakdownId}/shop`, { version: bd.version - 1, vendorId: V1 })).statusCode).toBe(409);
    const shop = await office('POST', `/fleet/breakdowns/${breakdownId}/shop`, { version: bd.version, vendorId: V1, estimateCents: 45000 });
    expect(shop.statusCode, shop.body).toBe(201);
    bd = shop.json() as FleetBreakdown;
    expect(bd.status).toBe('shop_arranged');
    // In repair needs a work order with the unit in the shop.
    expect((await office('PATCH', `/fleet/breakdowns/${breakdownId}/status`, { version: bd.version, status: 'in_repair' })).statusCode).toBe(422);
    const wo = await office('POST', `/fleet/breakdowns/${breakdownId}/work-order`, { version: bd.version, create: { status: 'in_shop' } });
    expect(wo.statusCode, wo.body).toBe(201);
    bd = wo.json() as FleetBreakdown;
    expect(bd.workOrder?.status).toBe('in_shop');
    expect(bd.status).toBe('in_repair');
    // The work order is the truck's (a tire on the truck), open, never completed by the case.
    const [order] = await db.select().from(workOrders).where(and(eq(workOrders.companyId, company), eq(workOrders.id, bd.workOrder!.id)));
    expect(order).toMatchObject({ status: 'in_shop', unitId: T1, assetType: 'truck', completedAt: null });

    const mine = (await driver('GET', `/driver/breakdowns/${breakdownId}`)).json() as DriverBreakdown;
    expect(mine.status).toBe('in_repair');
    expect(mine.responsible?.name).toBeTruthy();
    expect(mine.shopName).toContain('M3 Truck Repair');
    expect(mine.steps.find((s) => s.status === 'shop_arranged')?.reachedAt).toBeTruthy();
    expect(JSON.stringify(mine)).not.toContain('45000');
    expect((await driverNotes('breakdown', breakdownId)).length).toBeGreaterThanOrEqual(3);

    // Ready and closed: the work order stays as the shop left it; the load's flag closes with the case.
    bd = (await office('PATCH', `/fleet/breakdowns/${breakdownId}/status`, { version: bd.version, status: 'ready', note: 'New tire mounted' })).json() as FleetBreakdown;
    expect(bd.status).toBe('ready');
    bd = (await office('PATCH', `/fleet/breakdowns/${breakdownId}/status`, { version: bd.version, status: 'closed' })).json() as FleetBreakdown;
    expect(bd.status).toBe('closed');
    const [after] = await db.select().from(workOrders).where(eq(workOrders.id, bd.workOrder!.id));
    expect(after?.status).toBe('in_shop');
    const flags = (await office('GET', `/loads/${L1}/problems`)).json() as Array<{ id: string; closedAt: string | null }>;
    expect(flags.find((f) => f.id === bd.loadProblemId)?.closedAt).toBeTruthy();
    expect(((await driver('GET', `/driver/breakdowns/${breakdownId}`)).json() as DriverBreakdown).latestUpdate?.text).toContain('Closed');
  });

  // ================================================================== E2 · receipts / E3 · money

  let receiptId = '';
  // A Monday in the past unique to this run, so the statement batch never meets a real week.
  const WEEK_MON = new Date(Date.UTC(2001, 0, 1) + (Date.now() % 1200) * 7 * 86_400_000).toISOString().slice(0, 10);
  const plus = (day: string, n: number) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
  const WEEK_SUN = plus(WEEK_MON, 6);
  const RECEIPT_DAY = plus(WEEK_MON, 2);

  it('E2 · a receipt the driver paid goes to Accounting as a pending reimbursement with the receipt; a retry files it once', async () => {
    const file = await upload(JPEG(), 'lumper.jpg');
    const k = key();
    const body = { receiptFileId: file, amountCents: 12500, currency: 'USD', category: 'lumper', date: RECEIPT_DAY, loadId: L1, paidBy: 'driver', location: { text: 'Atlanta, GA', source: 'manual' }, note: 'Lumper at the receiver' };
    const res = await driver('POST', '/driver/reimbursements', body, k);
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as DriverReimbursement;
    receiptId = r.id;
    expect(r).toMatchObject({ kind: 'reimbursement', state: 'under_review', amountCents: 12500, reimbursableCents: 12500, receiptFileId: file });
    const again = await driver('POST', '/driver/reimbursements', body, k);
    expect((again.json() as DriverReimbursement).id).toBe(r.id);
    const mine = (await driver('GET', '/driver/reimbursements')).json() as DriverReimbursementList;
    expect(mine.reimbursements.filter((x) => x.kind === 'reimbursement').length).toBe(1);

    // The same record in Accounting → Reimbursements: pending, from the driver app, with the receipt.
    const acct = (await office('GET', `/accounting/reimbursements?driverId=${D1}`)).json() as Array<{ id: string; receiptFileId: string | null; reimbursement: { status: string; source?: string; payerDriverId: string } }>;
    const row = acct.find((x) => x.id === r.id)!;
    expect(row).toBeTruthy();
    expect(row.reimbursement).toMatchObject({ status: 'pending', source: 'driver_app', payerDriverId: D1 });
    expect(row.receiptFileId).toBe(file);
    expect((await officeNotes('reimbursement', r.id)).length).toBeGreaterThan(0);
    // Accounting opens the receipt.
    expect((await office('GET', `/files/${file}/link`)).statusCode).toBe(200);
    // Others: 404 / 403.
    expect((await as(token2, 'GET', `/driver/reimbursements/${r.id}`)).statusCode).toBe(404);
    expect((await office('POST', `/accounting/reimbursements/${r.id}/review`, { decision: 'approve' }, NO_PERMS)).statusCode).toBe(403);
  });

  it('E2 · a company-card receipt is a draft company expense in Fleet, never owed to the driver', async () => {
    const file = await upload(PDF(), 'scale.pdf');
    const res = await driver('POST', '/driver/reimbursements', { receiptFileId: file, amountCents: 1500, category: 'scale', date: RECEIPT_DAY, paidBy: 'company_card' }, key());
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as DriverReimbursement;
    expect(r).toMatchObject({ kind: 'company_expense', state: 'company_expense', reimbursableCents: 0 });
    const fx = await office('GET', `/fleet/expenses/${r.id}`);
    expect(fx.statusCode, fx.body).toBe(200);
    expect(fx.json()).toMatchObject({ status: 'draft' });
    const acct = (await office('GET', `/accounting/reimbursements?driverId=${D1}`)).json() as Array<{ id: string }>;
    expect(acct.map((x) => x.id)).not.toContain(r.id);
  });

  it('E2/E3 · approved → added to one settlement → Paid only once the settlement is paid; the driver reads their own statement and PDF', async () => {
    const review = await office('POST', `/accounting/reimbursements/${receiptId}/review`, { decision: 'approve' });
    expect(review.statusCode, review.body).toBeLessThan(300);
    expect(((await driver('GET', `/driver/reimbursements/${receiptId}`)).json() as DriverReimbursement).state).toBe('approved');
    expect((await driverNotes('reimbursement', receiptId)).length).toBeGreaterThan(0);

    // A pay profile so the statement can be approved (as the settlement tests do).
    const acctRes = await office('GET', `/accounting/drivers/${D1}/account`);
    expect(acctRes.statusCode, acctRes.body).toBe(200);
    const acct = acctRes.json() as { profile: { version: number; current: Record<string, unknown> } };
    const cur = acct.profile.current as { contractType: string; switches: object; loadedPlan: unknown; emptyPlan: unknown; escrow: unknown; lease: unknown };
    const saved = await office('PUT', `/accounting/drivers/${D1}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: '2000-01-01', contractType: cur.contractType, switches: cur.switches, loadedPlan: cur.loadedPlan, emptyPlan: cur.emptyPlan, escrow: cur.escrow, lease: cur.lease, reason: 'e2e m3', openingDebtCents: 0, openingDebtReconciled: true, confirmRate: true });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    // Two draft statements for the driver's week: the reimbursement lands on exactly one.
    const now = new Date().toISOString();
    const batchId = `stb_m3_${stamp}`;
    const mk = (n: string) => ({
      id: `stm_m3_${n}_${stamp}`, sourceKey: `e2e-m3:${stamp}:${n}`, settlementNumber: `ST-M3-${n}-${stamp}`, batchId, kind: 'cd', partyType: 'driver', partyId: D1, partyName: 'Ali Mthree',
      truckId: T1, unitNumber: null, periodStart: WEEK_MON, periodEnd: WEEK_SUN, cutoffAt: `${WEEK_SUN}T17:00:00.000Z`, payDate: WEEK_SUN, status: 'draft',
      netCents: 0, payableCents: 0, carryCents: 0, computation: null, vendor: null, snapshot: null, loadIds: n === 'a' ? [L3] : [], exceptions: [],
      approvedAt: null, approvedBy: null, paidAt: null, paymentId: null, paidCents: null, reversedAt: null, notes: null, versions: [], createdAt: now, updatedAt: now,
    });
    await store.insert('acct_settlement_batches', company, { id: batchId, kind: 'cd', periodStart: WEEK_MON, periodEnd: WEEK_SUN, cutoffAt: `${WEEK_SUN}T17:00:00.000Z`, payDate: WEEK_SUN, timezone: 'America/New_York', cutoffBasis: 'delivered_at', status: 'open', generatedAt: now, generatedBy: 'e2e', statementIds: [mk('a').id, mk('b').id], lateLoads: [] });
    await store.insert('acct_settlements', company, mk('a'));
    await store.insert('acct_settlements', company, mk('b'));
    const first = (await office('GET', `/accounting/settlements/${mk('a').id}`)).json() as { computation: { reimbursementsCents: number } };
    const second = (await office('GET', `/accounting/settlements/${mk('b').id}`)).json() as { computation: { reimbursementsCents: number } };
    const firstAgain = (await office('GET', `/accounting/settlements/${mk('a').id}`)).json() as { computation: { reimbursementsCents: number }; exceptions: string[] };
    expect(first.computation.reimbursementsCents).toBe(12500);
    expect(firstAgain.computation.reimbursementsCents).toBe(12500);
    expect(second.computation.reimbursementsCents).toBe(0);
    let mine = (await driver('GET', `/driver/reimbursements/${receiptId}`)).json() as DriverReimbursement;
    expect(mine.state).toBe('added_to_settlement');
    expect(mine.settlement?.id).toBe(mk('a').id);
    // A draft statement is not shown to the driver yet.
    expect(((await driver('GET', '/driver/settlements')).json() as DriverSettlementList).settlements.map((s) => s.id)).not.toContain(mk('a').id);

    const approved = await office('POST', `/accounting/settlements/${mk('a').id}/approve`, {});
    expect(approved.statusCode, approved.body).toBeLessThan(300);
    expect((approved.json() as { ok: boolean; blocked?: string }).ok, approved.body).toBe(true);
    mine = (await driver('GET', `/driver/reimbursements/${receiptId}`)).json() as DriverReimbursement;
    expect(mine.state).toBe('added_to_settlement');

    // E3: finalized, the driver's own; the week filter; the PDF streams; another driver gets 404.
    const week = (await driver('GET', `/driver/settlements?week=${RECEIPT_DAY}`)).json() as DriverSettlementList;
    expect(week.settlements.map((s) => s.id)).toEqual([mk('a').id]);
    expect(week.settlements[0]).toMatchObject({ state: 'finalized', reimbursementsCents: 12500 });
    const detail = (await driver('GET', `/driver/settlements/${mk('a').id}`)).json() as DriverSettlementDetail;
    expect(detail.reimbursements.reduce((t, r) => t + r.amountCents, 0)).toBe(12500);
    const pdf = await driver('GET', `/driver/settlements/${mk('a').id}/pdf`);
    expect(pdf.statusCode, pdf.body.slice(0, 200)).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect((await as(token2, 'GET', `/driver/settlements/${mk('a').id}`)).statusCode).toBe(404);
    expect((await as(token2, 'GET', `/driver/settlements/${mk('a').id}/pdf`)).statusCode).toBe(404);

    const paid = await office('POST', `/accounting/settlements/${mk('a').id}/paid`, { paidOn: plus(WEEK_SUN, 2), reference: `ACH-M3-${stamp}`, method: 'ach' });
    expect((paid.json() as { ok: boolean }).ok, paid.body).toBe(true);
    mine = (await driver('GET', `/driver/reimbursements/${receiptId}`)).json() as DriverReimbursement;
    expect(mine.state).toBe('paid');
    expect(mine.steps.find((s) => s.state === 'paid')?.reachedAt).toBeTruthy();
    expect(((await driver('GET', `/driver/settlements/${mk('a').id}`)).json() as DriverSettlementDetail).state).toBe('paid');
    expect((await driverNotes('reimbursement', receiptId)).length).toBeGreaterThanOrEqual(2);
  });

  // ================================================================== E4 · Driver Care

  let careId = '';

  it('E4 · a pay question goes to Driver Relations routed to Accounting, with the server\'s driver; staff reply reaches the driver, internal notes do not', async () => {
    const k = key();
    const body = { topic: 'pay_statement', message: 'My statement for last week is missing a load', weekStart: WEEK_MON, loadNumber: 'L-123' };
    const res = await driver('POST', '/driver/care', body, k);
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as DriverCareRequest;
    careId = c.id;
    expect(c).toMatchObject({ topic: 'pay_statement', team: 'accounting', state: 'received', confidential: false });
    expect(c.number).toMatch(/^DR-\d+/);
    expect((await driver('POST', '/driver/care', body, k)).json()).toMatchObject({ id: c.id });

    const detail = await office('GET', `/driver-relations/requests/${c.id}`);
    expect(detail.statusCode, detail.body).toBe(200);
    const d = detail.json() as { request: { source: string; driverId: string; assignedTeam: string; version: number } };
    expect(d.request).toMatchObject({ source: 'driver_app', driverId: D1, assignedTeam: 'accounting' });
    expect((await officeNotes('care', c.id)).length).toBeGreaterThan(0);

    expect((await office('POST', `/driver-relations/requests/${c.id}/notes`, { note: 'Internal: check RTS batch' })).statusCode).toBeLessThan(300);
    expect((await office('POST', `/driver-relations/requests/${c.id}/notes`, { note: 'We found it; it is on this week’s statement.', shareWithDriver: true })).statusCode).toBeLessThan(300);
    const contacted = await office('POST', `/driver-relations/requests/${c.id}/contact`, { method: 'phone', note: 'Called the driver', expectedVersion: d.request.version });
    expect(contacted.statusCode, contacted.body).toBeLessThan(300);
    const mine = (await driver('GET', `/driver/care/${c.id}`)).json() as DriverCareRequest;
    expect(mine.state).toBe('in_progress');
    expect(mine.responses.map((r) => r.text)).toEqual(['We found it; it is on this week’s statement.']);
    expect(JSON.stringify(mine)).not.toContain('Internal: check RTS batch');
    expect(JSON.stringify(mine)).not.toContain('Called the driver');
    expect((await driverNotes('care', c.id)).length).toBeGreaterThanOrEqual(2);
    expect((await as(token2, 'GET', `/driver/care/${c.id}`)).statusCode).toBe(404);
    expect((await office('POST', `/driver-relations/requests/${c.id}/notes`, { note: 'x' }, NO_PERMS)).statusCode).toBe(403);
  });

  it('E4 · a complaint stays confidential: staff without driver_relations.confidential never see it', async () => {
    const res = await driver('POST', '/driver/care', { topic: 'complaint_feedback', message: 'Dispatcher was rude on the phone' }, key());
    expect(res.statusCode, res.body).toBe(201);
    const c = res.json() as DriverCareRequest;
    expect(c).toMatchObject({ confidential: true, team: 'driver_relations' });
    const [row] = await db.execute(sql`select confidential, source, driver_id from driver_relation_requests where id = ${c.id}`) as unknown as Array<{ confidential: boolean; source: string; driver_id: string }>;
    expect(row).toMatchObject({ confidential: true, source: 'driver_app', driver_id: D1 });
    // The owner (all codes) reads it; a role without the confidential code gets nothing.
    expect((await office('GET', `/driver-relations/requests/${c.id}`)).statusCode).toBe(200);
    expect((await office('GET', `/driver-relations/requests/${c.id}`, undefined, NO_PERMS)).statusCode).toBe(403);
    const notes = await officeNotes('care', c.id);
    expect(notes.every((n) => !n.title.includes('Ali'))).toBe(true);
    expect(((await driver('GET', '/driver/care')).json() as DriverCareList).requests.map((r) => r.id)).toEqual(expect.arrayContaining([careId, c.id]));
  });

  // ================================================================== E5 · referrals

  it('E5 · a referral creates the Recruiting lead (source referral, referring driver); the driver sees the stage only; bonus from the setting', async () => {
    const phone = `312${digits.slice(-7)}`;
    const k = key();
    const res = await driver('POST', '/driver/referrals', { name: 'Carl Referral', phone, note: 'Drove with him at Swift' }, k);
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as DriverReferral;
    expect(r).toMatchObject({ name: 'Carl Referral', stage: 'received' });
    expect((await driver('POST', '/driver/referrals', { name: 'Carl Referral', phone, note: 'Drove with him at Swift' }, k)).json()).toMatchObject({ id: r.id });
    const leads = await db.select().from(hiringLeads).where(and(eq(hiringLeads.companyId, company), eq(hiringLeads.referredByDriverId, D1)));
    expect(leads.length).toBe(1);
    expect(leads[0]).toMatchObject({ source: 'referral', firstName: 'Carl' });

    // Unset: no amount. Set: the amount, never a hard-coded one.
    const set = await office('PATCH', '/admin/settings', { values: { 'referral.bonus_amount': 750 } });
    expect(set.statusCode, set.body).toBeLessThan(300);
    let list = (await driver('GET', '/driver/referrals')).json() as DriverReferralList;
    expect(list.bonusAmountCents).toBe(75000);
    // Cleared (0): the app shows no amount.
    const cleared = await office('PATCH', '/admin/settings', { values: { 'referral.bonus_amount': 0 } });
    expect(cleared.statusCode, cleared.body).toBeLessThan(300);
    list = (await driver('GET', '/driver/referrals')).json() as DriverReferralList;
    expect(list.bonusAmountCents).toBeNull();

    // Recruiting contacts the lead: the driver sees "Contacted", nothing else about them.
    await db.update(hiringLeads).set({ status: 'contacted', notes: 'Private recruiter notes' }).where(eq(hiringLeads.id, leads[0]!.id));
    const after = (await driver('GET', '/driver/referrals')).json() as DriverReferralList;
    expect(after.referrals.find((x) => x.id === r.id)?.stage).toBe('contacted');
    expect(JSON.stringify(after)).not.toContain('Private recruiter notes');
    expect(((await as(token2, 'GET', '/driver/referrals')).json() as DriverReferralList).referrals.map((x) => x.id)).not.toContain(r.id);
  });

  // ================================================================== E6 · vacations


  it('E6 · a vacation request: Dispatch approves; approval parks nothing; the driver confirms the truck parked; Start vacation takes the request over', async () => {
    const from = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
    const to = new Date(Date.now() + 9 * 86_400_000).toISOString().slice(0, 10);
    const k = key();
    const res = await driver('POST', '/driver/vacations', { from, to, note: 'Family wedding' }, k);
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json() as DriverVacationRequestView;
    expect(v).toMatchObject({ status: 'requested', from, to, canCancel: true, canConfirmParked: false });
    expect((await driver('POST', '/driver/vacations', { from, to, note: 'Family wedding' }, k)).json()).toMatchObject({ id: v.id });
    // Not a vacation yet: the driver is not away, the board list does not show it.
    const [d] = await db.select({ status: drivers.status }).from(drivers).where(eq(drivers.id, D1));
    expect(d?.status).toBe('available');
    const away = (await office('GET', '/drivers/vacations')).json() as { away: Array<{ id: string }> };
    expect(away.away.map((x) => x.id)).not.toContain(v.id);

    const requests = (await office('GET', '/drivers/vacation-requests')).json() as VacationRequestList;
    const row = requests.requests.find((x) => x.id === v.id)!;
    expect(row).toMatchObject({ driverId: D1, status: 'requested', from, to });
    expect((await officeNotes('vacation', v.id)).length).toBeGreaterThan(0);
    expect((await office('POST', `/drivers/vacation-requests/${v.id}/decision`, { version: row.version, decision: 'approve' }, NO_PERMS)).statusCode).toBe(403);
    expect((await office('POST', `/drivers/vacation-requests/${v.id}/decision`, { version: row.version, decision: 'reject' })).statusCode).toBe(422);
    const approved = await office('POST', `/drivers/vacation-requests/${v.id}/decision`, { version: row.version, decision: 'approve' });
    expect(approved.statusCode, approved.body).toBe(201);

    let mine = ((await driver('GET', '/driver/vacations')).json() as DriverVacationRequestList).vacations.find((x) => x.id === v.id)!;
    expect(mine).toMatchObject({ status: 'approved', truckParked: null, canConfirmParked: true });
    expect((await driverNotes('vacation', v.id)).length).toBeGreaterThan(0);

    const photo = await upload(JPEG(), 'parked.jpg');
    const parked = await driver('POST', `/driver/vacations/${v.id}/parked`, { note: 'Yard row 4', photoFileId: photo, keysHandedOver: true }, key());
    expect(parked.statusCode, parked.body).toBe(200);
    mine = parked.json() as DriverVacationRequestView;
    expect(mine.truckParked).toMatchObject({ note: 'Yard row 4', photoFileId: photo });
    expect(mine.keysHandedAt).toBeTruthy();
    expect((await as(token2, 'POST', `/driver/vacations/${v.id}/parked`, {}, { 'idempotency-key': key() })).statusCode).toBe(404);

    // The existing Start vacation adopts the approved request: one vacation row, now started.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
    const started = await office('POST', `/drivers/${D1}/vacations`, { startedOn: today });
    expect(started.statusCode, started.body).toBeLessThan(300);
    expect((started.json() as { id: string }).id).toBe(v.id);
    mine = ((await driver('GET', '/driver/vacations')).json() as DriverVacationRequestList).vacations.find((x) => x.id === v.id)!;
    expect(mine.status).toBe('started');
    expect(mine.steps.find((s) => s.step === 'started')?.at).toBeTruthy();
    // The return stays the existing path.
    const ret = await office('POST', `/drivers/${D1}/vacations/${v.id}/return`, { returnedOn: today, version: (started.json() as { version: number }).version });
    expect(ret.statusCode, ret.body).toBeLessThan(300);
  });

  // ================================================================== E7 · documents

  it('E7 · the driver sends a renewed medical card: pending review for Safety, the previous version kept; Safety rejects → the driver reads why', async () => {
    const soon = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const first = await driver('POST', '/driver/documents', { type: 'medical_card', fileId: await upload(JPEG(), 'med1.jpg'), expiresOn: soon }, key());
    expect(first.statusCode, first.body).toBe(201);
    let list = first.json() as DriverDocumentList;
    let med = list.documents.find((d) => d.type === 'medical_card')!;
    expect(med).toMatchObject({ state: 'pending_review', version: 1, source: 'driver_portal' });
    expect(med.reminder?.kind).toBe('expiring');
    expect(list.reminders.map((r) => r.type)).toContain('medical_card');

    const later = new Date(Date.now() + 400 * 86_400_000).toISOString().slice(0, 10);
    const second = await driver('POST', '/driver/documents', { type: 'medical_card', fileId: await upload(PDF(), 'med2.pdf'), expiresOn: later }, key());
    list = second.json() as DriverDocumentList;
    med = list.documents.find((d) => d.type === 'medical_card')!;
    expect(med.version).toBe(2);
    expect(med.previous.map((p) => p.version)).toEqual([1]);
    expect(med.reminder).toBeNull();

    // Safety's existing qualification-file screen reads the same document.
    const docs = (await office('GET', `/compliance/documents?ownerType=driver&ownerId=${D1}&requirementCode=medical_card`)).json() as Array<{ id: string; status: string; source: string; version: number }>;
    expect(docs.find((x) => x.id === med.documentId)).toMatchObject({ status: 'pending_review', source: 'driver_portal', version: 2 });
    expect(docs.length).toBe(2);
    expect((await office('POST', `/compliance/documents/${med.documentId}/reject`, { reason: 'x' }, NO_PERMS)).statusCode).toBe(403);
    const rejected = await office('POST', `/compliance/documents/${med.documentId}/reject`, { reason: 'Photo is blurry' });
    expect(rejected.statusCode, rejected.body).toBeLessThan(300);
    med = ((await driver('GET', '/driver/documents')).json() as DriverDocumentList).documents.find((d) => d.type === 'medical_card')!;
    expect(med).toMatchObject({ state: 'rejected', rejectionReason: 'Photo is blurry' });
    expect((await driverNotes('driver_document', med.documentId!)).length).toBe(1);
    // Not a code the app takes.
    expect((await driver('POST', '/driver/documents', { type: 'mvr_review', fileId: await upload(JPEG(), 'x.jpg') }, key())).statusCode).toBe(422);
  });

  // ================================================================== E8 · safety reports

  it('E8 · an accident report opens a real Accidents v2 case (fault not determined); a violation becomes a compliance request to Safety', async () => {
    const photo = await upload(JPEG(), 'damage.jpg');
    const k = key();
    const body = {
      kind: 'accident',
      occurredAt: new Date(Date.now() - 30 * 60_000).toISOString(),
      location: { text: 'I-75 exit 250', city: 'Macon', state: 'GA', source: 'gps', lat: 32.8, lng: -83.6 },
      description: 'A car backed into the trailer at the fuel island. Minor damage to the rear door.',
      fileIds: [photo],
      loadId: L1,
      injuries: 'no',
      police: 'yes',
    };
    const res = await driver('POST', '/driver/safety-reports', body, k);
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as DriverSafetyReport;
    expect(r).toMatchObject({ kind: 'accident', target: 'accident' });
    expect((await driver('POST', '/driver/safety-reports', body, k)).json()).toMatchObject({ id: r.id });
    const [ptr] = await db.select().from(driverAppSubmissions).where(eq(driverAppSubmissions.id, r.id));
    const acc = await office('GET', `/safety/accidents-v2/${ptr!.targetId}`);
    expect(acc.statusCode, acc.body).toBe(200);
    const [row] = await db.execute(sql`select driver_id, fault, stage from safety_accidents where id = ${ptr!.targetId}`) as unknown as Array<{ driver_id: string; fault: string; stage: string }>;
    expect(row).toMatchObject({ driver_id: D1, fault: 'not_determined' });
    expect(row?.stage).not.toBe('closed');
    expect((await officeNotes('safety_report', ptr!.targetId)).length).toBeGreaterThan(0);

    const v = await driver('POST', '/driver/safety-reports', { kind: 'violation', occurredAt: new Date(Date.now() - 3600_000).toISOString(), location: { text: 'Weigh station, Tifton GA', state: 'GA', source: 'manual' }, description: 'Got a ticket for a logbook form and manner violation', reportNumber: 'GA-778812' }, key());
    expect(v.statusCode, v.body).toBe(201);
    const vr = v.json() as DriverSafetyReport;
    expect(vr).toMatchObject({ kind: 'violation', target: 'driver_relation_request' });
    const [vp] = await db.select().from(driverAppSubmissions).where(eq(driverAppSubmissions.id, vr.id));
    const dr = (await office('GET', `/driver-relations/requests/${vp!.targetId}`)).json() as { request: { topic: string; assignedTeam: string; driverId: string } };
    expect(dr.request).toMatchObject({ topic: 'compliance', assignedTeam: 'safety', driverId: D1 });

    const mine = (await driver('GET', '/driver/safety-reports')).json() as DriverSafetyReportList;
    expect(mine.reports.map((x) => x.id)).toEqual(expect.arrayContaining([r.id, vr.id]));
    expect((await as(token2, 'GET', `/driver/safety-reports/${r.id}`)).statusCode).toBe(404);
    expect((await office('GET', `/safety/accidents-v2/${ptr!.targetId}`, undefined, NO_PERMS)).statusCode).toBe(403);
  });

  it('E8 · a roadside inspection with level and agency opens Safety\'s roadside inspection', async () => {
    const res = await driver('POST', '/driver/safety-reports', { kind: 'roadside_inspection', occurredAt: new Date(Date.now() - 7200_000).toISOString(), location: { text: 'I-10 port of entry', state: 'TX', source: 'manual' }, description: 'Level 2 inspection, no violations', inspectionLevel: 2, agency: 'Texas DPS' }, key());
    expect(res.statusCode, res.body).toBe(201);
    const r = res.json() as DriverSafetyReport;
    expect(r.target).toBe('roadside_inspection');
    const [ptr] = await db.select().from(driverAppSubmissions).where(eq(driverAppSubmissions.id, r.id));
    const rsi = await office('GET', `/safety/roadside/${ptr!.targetId}`);
    expect(rsi.statusCode, rsi.body).toBe(200);
  });

  it('every driver POST needs an Idempotency-Key', async () => {
    const valid: Array<[string, unknown]> = [
      ['/driver/breakdowns', { category: 'other', description: 'Mirror broke', location: { text: 'x', source: 'manual' } }],
      ['/driver/care', { topic: 'compliance', message: 'Question about my CDL' }],
      ['/driver/referrals', { name: 'No Key', phone: '3125550100' }],
      ['/driver/vacations', { from: '2030-01-01', to: '2030-01-02' }],
    ];
    for (const [url, body] of valid) expect((await as(token, 'POST', url, body)).statusCode, url).toBe(428);
  });
});
