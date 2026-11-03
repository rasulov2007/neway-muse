import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { memberships, users } from '../src/database/schema/admin';
import { loads as loadsTable } from '../src/database/schema/loads';
import { LoadsService } from '../src/modules/loads/loads.service';

/**
 * The per-record load writes (dispatch Phase 0).
 *
 * The suite shares the development database: it inserts its own rows into the `loads` table,
 * keyed by a run stamp, and takes them out again at the end. Two accounts are made for the run -
 * a dispatcher and a dispatch lead - so the lead rule is proven against the roles the database
 * grants, not against a header.
 *
 * The fixtures used to be written to the `ws2-loads` workspace blob, which is where loads lived
 * before they were cut over to their own table. The service reads the table, so the seeded loads
 * were invisible to it and every request 404'd.
 */
describe('Loads per-record writes (e2e)', () => {
  let app: NestFastifyApplication;
  const stamp = Date.now().toString(36);
  const NOW = new Date('2026-09-19T14:00:00.000Z');
  let dispatcher = '';
  let lead = '';
  /** The load's owner: only its dispatcher, its updater or an administrator may cancel it. */
  let dispatcherUserId = '';
  /** A cancellation the broker has not agreed to is a dispute (rule 1.9), so every cancel says
   *  who approved it, how, and when. */
  const BROKER_APPROVAL = { by: 'Broker desk', method: 'email', reference: 'RC-1', at: '2026-09-19T13:00:00.000Z' };
  const ids = { booked: `ld_test_${stamp}_a`, dispatched: `ld_test_${stamp}_b`, transit: `ld_test_${stamp}_c` };

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  const stop = (id: string, kind: 'pickup' | 'delivery', over: Record<string, unknown> = {}) => ({
    id,
    sequence: kind === 'pickup' ? 1 : 2,
    kind,
    facilityId: '',
    facilityName: `${id} dock`,
    city: kind === 'pickup' ? 'Chicago' : 'Atlanta',
    state: kind === 'pickup' ? 'IL' : 'GA',
    timezone: kind === 'pickup' ? 'America/Chicago' : 'America/New_York',
    appointmentStartAt: '2026-09-18T13:00:00.000Z',
    appointmentEndAt: '2026-09-18T15:00:00.000Z',
    appointmentNoWindow: false,
    status: 'pending',
    arrivedAt: null,
    departedAt: null,
    detentionMinutes: 0,
    notes: null,
    ...over,
  });

  const load = (id: string, status: string, over: Record<string, unknown> = {}) => ({
    id,
    loadNumber: `L-${id.slice(-6).toUpperCase()}`,
    status,
    schemaVersion: 2,
    exception: null,
    customerId: 'cus_test',
    customerName: 'Test Customer',
    brokerId: null,
    brokerName: null,
    brokerReference: 'REF',
    commodity: 'Paper',
    weightLbs: 40000,
    pieces: 20,
    equipmentType: 'dry_van',
    temperatureF: null,
    hazmat: false,
    dispatcherId: dispatcherUserId,
    dispatcherName: 'Test Dispatcher',
    driverId: 'drv_test',
    driverName: 'Test Driver',
    truckId: 'trk_test',
    truckUnit: '9999',
    trailerId: 'trl_test',
    trailerUnit: 'T-9999',
    origin: { city: 'Chicago', state: 'IL' },
    destination: { city: 'Atlanta', state: 'GA' },
    stops: [stop(`${id}_s1`, 'pickup'), stop(`${id}_s2`, 'delivery')],
    rate: 1800,
    loadedMiles: 716,
    emptyMiles: 40,
    rpm: 2.51,
    charges: [{ id: `${id}_chg`, type: 'linehaul', description: 'Linehaul', amount: 1800, billable: true, payableToDriver: false }],
    expenses: [],
    financials: null,
    timeline: [],
    notes: [],
    documents: [],
    pickupAt: '2026-09-18T13:00:00.000Z',
    deliveryAt: '2026-09-19T13:00:00.000Z',
    etaAt: null,
    milesRemaining: null,
    bookedAt: '2026-09-17T13:00:00.000Z',
    dispatchedAt: null,
    deliveredAt: null,
    invoiceId: null,
    createdAt: '2026-09-17T13:00:00.000Z',
    updatedAt: '2026-09-17T13:00:00.000Z',
    keptByTheStore: { untouched: true },
    ...over,
  });

  /** The company the dev-header principal acts in; the fixtures have to belong to it. */
  async function companyId(): Promise<string> {
    const me = (await call('GET', '/api/v1/auth/me')).json() as { companyId: string };
    return me.companyId;
  }

  async function seedLoads(rows: Record<string, unknown>[]): Promise<void> {
    const db = app.get(DatabaseService).db;
    const company = await companyId();
    for (const row of rows) {
      await db
        .insert(loadsTable)
        .values({
          id: String(row.id),
          companyId: company,
          loadNumber: String(row.loadNumber),
          status: String(row.status),
          dispatcherId: String(row.dispatcherId ?? ''),
          driverId: (row.driverId as string | null) ?? null,
          truckId: (row.truckId as string | null) ?? null,
          trailerId: (row.trailerId as string | null) ?? null,
          version: 1,
          record: row,
        })
        .onConflictDoNothing();
    }
  }

  async function accountWithRole(code: string, email: string): Promise<string> {
    const roles = (await call('GET', '/api/v1/admin/roles')).json() as { id: string; code: string }[];
    const role = roles.find((r) => r.code === code);
    if (!role) throw new Error(`No role ${code}`);
    const created = await call('POST', '/api/v1/admin/users', {
      firstName: code === 'dispatch_lead' ? 'Lena' : 'Dan',
      lastName: code === 'dispatch_lead' ? 'Lead' : 'Dispatcher',
      email,
      phone: null,
      employeeId: null,
      roleIds: [role.id],
      invite: false,
    });
    expect(created.statusCode, created.body).toBe(201);
    const { membershipId, userId } = (created.json() as { account: { membershipId: string; userId: string } }).account;
    if (code === 'dispatcher') dispatcherUserId = userId;
    // A new account is `invited` with a temporary password; the dev header resolves active ones,
    // and a temporary credential is refused everywhere but the change-password route. The test
    // stands in for the person's first sign-in.
    const activated = await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'active', reason: 'loads e2e' });
    expect(activated.statusCode, activated.body).toBe(200);
    await app.get(DatabaseService).db.update(users).set({ mustChangePassword: false }).where(eq(users.id, userId));
    // Complete your profile (2026-10-26): these test accounts are past the first-sign-in form.
    await app.get(DatabaseService).db.update(memberships).set({ profileCompletedAt: new Date() }).where(eq(memberships.userId, userId));
    return membershipId;
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    app.get(LoadsService).clock = () => NOW;

    dispatcher = await accountWithRole('dispatcher', `dispatcher.${stamp}@test.local`);
    lead = await accountWithRole('dispatch_lead', `lead.${stamp}@test.local`);

    await seedLoads([
      load(ids.booked, 'assigned'),
      load(ids.dispatched, 'dispatched', { dispatchedAt: '2026-09-18T12:00:00.000Z' }),
      load(ids.transit, 'in_transit', {
        dispatchedAt: '2026-09-18T12:00:00.000Z',
        exception: { code: 'problem', reason: 'Running late', raisedAt: '2026-09-18T13:00:00.000Z' },
        stops: [
          stop(`${ids.transit}_s1`, 'pickup', { status: 'completed', arrivedAt: '2026-09-18T13:05:00.000Z', departedAt: '2026-09-18T13:50:00.000Z' }),
          stop(`${ids.transit}_s2`, 'delivery', { arrivedAt: '2026-09-19T12:40:00.000Z' }),
        ],
        documents: [
          { id: `${ids.transit}_bol`, type: 'bol', title: 'BOL', fileName: 'scan-001.pdf', sizeBytes: 100, uploadedAt: '2026-09-18T13:55:00.000Z', uploadedBy: 'Test Driver', status: 'pending', review: 'received', fileHash: 'hash-001' },
        ],
      }),
    ]);
  });

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    await db.delete(loadsTable).where(and(eq(loadsTable.companyId, await companyId()), like(loadsTable.id, `ld_test_${stamp}%`)));
    for (const membershipId of [dispatcher, lead]) {
      if (membershipId) {
        await call('PATCH', `/api/v1/admin/users/${membershipId}/status`, { status: 'disabled', reason: 'loads e2e cleanup' });
      }
    }
    await app.close();
  });

  it('reads one load by id or number, with the fields the store keeps and the rules ignore', async () => {
    const response = await call('GET', `/api/v1/loads/${ids.booked}`);
    expect(response.statusCode).toBe(200);
    const body = response.json() as { loadNumber: string; keptByTheStore: unknown };
    expect(body.keptByTheStore).toEqual({ untouched: true });
    const byNumber = await call('GET', `/api/v1/loads/${body.loadNumber}`);
    expect(byNumber.statusCode).toBe(200);
  });

  it("answers the driver's last drop from the table: latest load, cancelled and hidden ones left out", async () => {
    const driver = `drv_ld_${stamp}`;
    const delivery = (id: string, city: string, state: string, zip: string, at: string) =>
      stop(id, 'delivery', { city, state, zip, appointmentStartAt: at, appointmentEndAt: at });
    await seedLoads([
      load(`ld_test_${stamp}_d1`, 'delivered', { driverId: driver, deliveryAt: '2026-09-15T13:00:00.000Z', stops: [stop(`ld_test_${stamp}_d1_s1`, 'pickup'), delivery(`ld_test_${stamp}_d1_s2`, 'Memphis', 'TN', '38103', '2026-09-15T13:00:00.000Z')] }),
      load(`ld_test_${stamp}_d2`, 'in_transit', { driverId: driver, deliveryAt: '2026-09-17T13:00:00.000Z', stops: [stop(`ld_test_${stamp}_d2_s1`, 'pickup'), delivery(`ld_test_${stamp}_d2_s2`, 'Dallas', 'TX', '75201', '2026-09-17T13:00:00.000Z')] }),
      load(`ld_test_${stamp}_d3`, 'cancelled', { driverId: driver, deliveryAt: '2026-09-20T13:00:00.000Z', stops: [stop(`ld_test_${stamp}_d3_s1`, 'pickup'), delivery(`ld_test_${stamp}_d3_s2`, 'Denver', 'CO', '80202', '2026-09-20T13:00:00.000Z')] }),
    ]);
    // A hidden (seeded / test) load is nobody's last drop.
    const hidden = load(`ld_test_${stamp}_d4`, 'delivered', { driverId: driver, deliveryAt: '2026-09-21T13:00:00.000Z', stops: [stop(`ld_test_${stamp}_d4_s1`, 'pickup'), delivery(`ld_test_${stamp}_d4_s2`, 'Reno', 'NV', '89501', '2026-09-21T13:00:00.000Z')] });
    await app.get(DatabaseService).db.insert(loadsTable).values({ id: hidden.id, companyId: await companyId(), loadNumber: hidden.loadNumber, status: hidden.status, driverId: driver, isDemo: true, version: 1, record: hidden }).onConflictDoNothing();

    const response = await call('GET', `/api/v1/loads/driver-last-drop?driverId=${driver}`);
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({ drop: { loadId: `ld_test_${stamp}_d2`, loadNumber: `L-${`ld_test_${stamp}_d2`.slice(-6).toUpperCase()}`, city: 'Dallas', state: 'TX', zip: '75201' } });
    // Editing that load measures from the one before it.
    const editing = (await call('GET', `/api/v1/loads/driver-last-drop?driverId=${driver}&excludeLoadId=ld_test_${stamp}_d2`)).json() as { drop: { city: string } };
    expect(editing.drop.city).toBe('Memphis');
    expect((await call('GET', `/api/v1/loads/driver-last-drop?driverId=drv_nobody_${stamp}`)).json()).toEqual({ drop: null });
    expect((await call('GET', '/api/v1/loads/driver-last-drop')).statusCode).toBe(400);
  });

  it('keeps Live / Drop on each stop through booking and edit', async () => {
    const id = `ld_test_${stamp}_ld`;
    const booked = await call('POST', '/api/v1/loads', load(id, 'booked', {
      stops: [stop(`${id}_s1`, 'pickup', { handling: 'live' }), stop(`${id}_s2`, 'delivery', { handling: 'drop' })],
    }));
    expect(booked.statusCode, booked.body).toBe(201);
    const read = (await call('GET', `/api/v1/loads/${id}`)).json() as { updatedAt: string; stops: { handling?: string }[] };
    expect(read.stops.map((s) => s.handling)).toEqual(['live', 'drop']);
    const edited = await call('PATCH', `/api/v1/loads/${id}`, {
      expectedUpdatedAt: read.updatedAt,
      patch: { stops: read.stops.map((s, i) => ({ ...s, handling: i === 0 ? 'drop' : 'live' })) },
    });
    expect(edited.statusCode, edited.body).toBe(200);
    const after = (await call('GET', `/api/v1/loads/${id}`)).json() as { stops: { handling?: string }[] };
    expect(after.stops.map((s) => s.handling)).toEqual(['drop', 'live']);
  });

  it('says who is a lead from the roles the database grants', async () => {
    expect((await call('GET', '/api/v1/loads/me/lead', undefined, { 'x-account': dispatcher })).json()).toEqual({ isLead: false });
    expect((await call('GET', '/api/v1/loads/me/lead', undefined, { 'x-account': lead })).json()).toEqual({ isLead: true });
  });

  it('a note carries the signed-in author and the server clock, and is visible to the next reader', async () => {
    const before = (await call('GET', `/api/v1/loads/${ids.booked}`)).json() as { updatedAt: string };
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.booked}/notes`,
      { body: 'Shipper opens at 7', pinned: true, expectedUpdatedAt: before.updatedAt },
      { 'x-account': dispatcher },
    );
    expect(response.statusCode, response.body).toBe(201);
    const { load: after, collectionUpdatedAt } = response.json() as { load: { notes: Record<string, unknown>[]; timeline: Record<string, unknown>[]; updatedAt: string }; collectionUpdatedAt: string };
    expect(after.notes[0]).toMatchObject({ body: 'Shipper opens at 7', authorName: 'Dan Dispatcher', at: NOW.toISOString(), pinned: true });
    expect(after.timeline.at(-1)).toMatchObject({ kind: 'note_added', title: 'Note pinned', actorName: 'Dan Dispatcher' });
    expect(after.updatedAt).toBe(NOW.toISOString());
    expect(collectionUpdatedAt).toBeTruthy();

    // Another reader sees it: the write went to the store, not to a browser's copy.
    const again = (await call('GET', `/api/v1/loads/${ids.booked}`, undefined, { 'x-account': lead })).json() as { notes: unknown[] };
    expect(again.notes).toHaveLength(1);
  });

  it('a stale expectedUpdatedAt is refused with 409 and nothing is written', async () => {
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.booked}/notes`,
      { body: 'stale', expectedUpdatedAt: '2026-09-17T13:00:00.000Z' },
      { 'x-account': dispatcher },
    );
    expect(response.statusCode).toBe(409);
    const after = (await call('GET', `/api/v1/loads/${ids.booked}`)).json() as { notes: unknown[] };
    expect(after.notes).toHaveLength(1);
  });

  it('a dispatcher cancels a load that is not yet dispatched; the driver, truck and trailer are freed', async () => {
    const before = (await call('GET', `/api/v1/loads/${ids.booked}`)).json() as { updatedAt: string };
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.booked}/cancel`,
      { outcome: 'cancelled', reason: 'Broker pulled the load', requestedBy: 'TQL', approval: BROKER_APPROVAL, expectedUpdatedAt: before.updatedAt },
      { 'x-account': dispatcher },
    );
    expect(response.statusCode, response.body).toBe(201);
    const { load: after } = response.json() as { load: Record<string, unknown> & { timeline: Record<string, unknown>[]; cancellation: Record<string, unknown> } };
    expect(after.status).toBe('cancelled');
    expect(after.driverId).toBeNull();
    expect(after.truckId).toBeNull();
    expect(after.trailerId).toBeNull();
    expect(after.charges).toEqual([]);
    expect(after.cancellation).toMatchObject({ outcome: 'cancelled', reason: 'Broker pulled the load', requestedBy: 'TQL', byName: 'Dan Dispatcher' });
    expect(after.timeline.at(-1)).toMatchObject({ kind: 'cancelled', title: 'Cancelled' });
    expect(after.keptByTheStore).toEqual({ untouched: true });
  });

  it('after dispatch a dispatcher is refused (403) and the lead is not; a TONU keeps its fee as the only charge', async () => {
    const before = (await call('GET', `/api/v1/loads/${ids.dispatched}`)).json() as { updatedAt: string };
    const denied = await call(
      'POST',
      `/api/v1/loads/${ids.dispatched}/cancel`,
      { outcome: 'tonu', reason: 'Shipper not ready', requestedBy: 'Shipper', fee: 250, approval: BROKER_APPROVAL, expectedUpdatedAt: before.updatedAt },
      { 'x-account': dispatcher },
    );
    expect(denied.statusCode).toBe(403);
    expect(denied.body).toMatch(/dispatch lead/);
    const untouched = (await call('GET', `/api/v1/loads/${ids.dispatched}`)).json() as { status: string };
    expect(untouched.status).toBe('dispatched');

    const allowed = await call(
      'POST',
      `/api/v1/loads/${ids.dispatched}/cancel`,
      { outcome: 'tonu', reason: 'Shipper not ready', requestedBy: 'Shipper', fee: 250, approval: BROKER_APPROVAL, expectedUpdatedAt: before.updatedAt },
      { 'x-account': lead },
    );
    expect(allowed.statusCode, allowed.body).toBe(201);
    const { load: after } = allowed.json() as { load: { status: string; charges: Record<string, unknown>[]; timeline: Record<string, unknown>[] } };
    expect(after.status).toBe('tonu');
    expect(after.charges).toEqual([expect.objectContaining({ type: 'tonu', amount: 250 })]);
    expect(after.timeline.at(-1)).toMatchObject({ title: 'TONU - $250 fee', actorName: 'Lena Lead' });
  });

  it('a load past the pickup cannot be cancelled by anyone', async () => {
    const before = (await call('GET', `/api/v1/loads/${ids.transit}`)).json() as { updatedAt: string };
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.transit}/cancel`,
      { outcome: 'cancelled', reason: 'Trying anyway', requestedBy: 'x', approval: BROKER_APPROVAL, expectedUpdatedAt: before.updatedAt },
      { 'x-account': lead },
    );
    expect(response.statusCode).toBe(422);
  });

  it('a document is reviewed, then verified by a named person; verifying twice is refused', async () => {
    const docId = `${ids.transit}_bol`;
    let current = (await call('GET', `/api/v1/loads/${ids.transit}`)).json() as { updatedAt: string };
    const reviewed = await call('POST', `/api/v1/loads/${ids.transit}/documents/${docId}/review`, { review: 'reviewed', expectedUpdatedAt: current.updatedAt }, { 'x-account': dispatcher });
    expect(reviewed.statusCode, reviewed.body).toBe(201);
    current = (reviewed.json() as { load: { updatedAt: string } }).load;
    const verified = await call('POST', `/api/v1/loads/${ids.transit}/documents/${docId}/review`, { review: 'verified', expectedUpdatedAt: current.updatedAt }, { 'x-account': lead });
    expect(verified.statusCode, verified.body).toBe(201);
    const doc = (verified.json() as { load: { documents: Record<string, unknown>[]; updatedAt: string } }).load.documents[0];
    expect(doc).toMatchObject({ review: 'verified', status: 'verified', reviewedBy: 'Dan Dispatcher', verifiedBy: 'Lena Lead', verifiedAt: NOW.toISOString() });
    current = (verified.json() as { load: { updatedAt: string } }).load;
    const again = await call('POST', `/api/v1/loads/${ids.transit}/documents/${docId}/review`, { review: 'verified', expectedUpdatedAt: current.updatedAt }, { 'x-account': lead });
    expect(again.statusCode).toBe(422);
  });

  it('confirming a POD delivers the load at the stop arrival, completes that stop only, and clears nothing else', async () => {
    const current = (await call('GET', `/api/v1/loads/${ids.transit}`)).json() as { updatedAt: string };
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.transit}/confirm`,
      { kind: 'mark_delivered', stopId: `${ids.transit}_s2`, at: '2026-09-19T12:40:00.000Z', expectedUpdatedAt: current.updatedAt },
      { 'x-account': dispatcher },
    );
    expect(response.statusCode, response.body).toBe(201);
    const { load: after } = response.json() as { load: { status: string; deliveredAt: string; dispatchedAt: string; exception: unknown; stops: { status: string }[]; timeline: Record<string, unknown>[] } };
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt).toBe('2026-09-19T12:40:00.000Z');
    expect(after.dispatchedAt).toBe('2026-09-18T12:00:00.000Z');
    expect(after.exception).toEqual({ code: 'problem', reason: 'Running late', raisedAt: '2026-09-18T13:00:00.000Z' });
    expect(after.stops.map((s) => s.status)).toEqual(['completed', 'completed']);
    expect(after.timeline.at(-1)).toMatchObject({ kind: 'delivered', at: '2026-09-19T12:40:00.000Z', stopId: `${ids.transit}_s2` });
  });

  it('every write needs loads.edit; a stranger is stopped at the door', async () => {
    const current = (await call('GET', `/api/v1/loads/${ids.transit}`)).json() as { updatedAt: string };
    const response = await call(
      'POST',
      `/api/v1/loads/${ids.transit}/notes`,
      { body: 'no', expectedUpdatedAt: current.updatedAt },
      { 'x-demo-role': 'operations' },
    );
    expect(response.statusCode).toBe(403);
  });

  it('writes an audit entry for each change, with who and what', async () => {
    const response = await call('GET', `/api/v1/admin/audit?entityType=load&pageSize=50`);
    expect(response.statusCode, response.body).toBe(200);
    const { data } = response.json() as { data: { action: string; entityId: string; actorName: string; summary: string; reason: string | null }[] };
    const cancel = data.find((entry) => entry.entityId === ids.booked && entry.action === 'cancel');
    expect(cancel).toMatchObject({ actorName: 'Dan Dispatcher', reason: 'Broker pulled the load' });
    const tonu = data.find((entry) => entry.entityId === ids.dispatched && entry.action === 'cancel');
    expect(tonu?.actorName).toBe('Lena Lead');
  });
});
