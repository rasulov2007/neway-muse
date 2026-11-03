import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { driverMessageFromRc, type ChosenRoute, type RouteOptionsResult, type StoredLoad } from '@neway/shared';
import { and, eq, like } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { env } from '../src/config/env';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { auditLogs } from '../src/database/schema/people';
import { loads as loadsTable } from '../src/database/schema/loads';

/**
 * Route options from TollGuru (owner, 2026-10-27), against a local stand-in for TollGuru: the
 * real service code makes the real HTTP call, and nothing leaves the machine.
 */
class FakeTollGuru {
  server!: Server;
  url = '';
  mode: 'ok' | 'no_subscription' | 'broken' = 'ok';
  calls: { apiKey: string | undefined; body: Record<string, unknown> }[] = [];

  async start(): Promise<void> {
    this.server = createServer((req, res) => void this.handle(req, res));
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method !== 'POST' || req.url !== '/toll/v2/origin-destination-waypoints') return json(404, { message: 'Not found' });
    this.calls.push({ apiKey: req.headers['x-api-key'] as string | undefined, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> });
    // TollGuru's own words for a key without a plan (seen live, 2026-10-27).
    if (this.mode === 'no_subscription') return json(403, { status: 403, message: 'Request denied. No active subscription found', code: 'FORBIDDEN' });
    if (this.mode === 'broken') return json(500, { message: 'Internal error' });
    return json(200, {
      status: 'OK',
      routes: [
        { summary: { name: 'I-65 S', distance: { text: '718 mi', metric: '1,155 km', value: 1155500 }, duration: { text: '11 h 5 min', value: 39900 }, hasTolls: true, url: 'https://www.google.com/maps/dir/?api=1&a' }, costs: { tag: 24.5, cash: 31, fuel: 440 } },
        { summary: { name: 'I-57 S; I-24 E', distance: { text: '702 mi', value: 1129700 }, duration: { text: '11 h 30 min', value: 41400 }, hasTolls: false }, costs: { tag: null, cash: null, fuel: 430 } },
        { summary: { name: 'I-55 S', distance: { text: '760 mi', value: 1223000 }, duration: { text: '10 h 50 min', value: 39000 }, hasTolls: true }, costs: { tag: 80, cash: 95, fuel: 470 } },
        { summary: { name: 'US-41 S', distance: { text: '800 mi', value: 1287000 }, duration: { text: '13 h', value: 46800 }, hasTolls: false }, costs: { fuel: 600 } },
      ],
    });
  }
}

describe('Load route options from TollGuru (e2e)', () => {
  let app: NestFastifyApplication;
  const fake = new FakeTollGuru();
  const stamp = Date.now().toString(36);
  const ids = { a: `ld_rt_${stamp}_a`, b: `ld_rt_${stamp}_b`, c: `ld_rt_${stamp}_c` };
  const saved = { key: env.TOLLGURU_API_KEY, base: env.TOLLGURU_API_BASE };
  let companyId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url: `/api/v1${url}`, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  const stop = (id: string, kind: 'pickup' | 'delivery', city: string, state: string, sequence: number, address: string | null = null) => ({
    id, sequence, kind, facilityId: '', facilityName: `${city} dock`, address, city, state, zip: null,
    timezone: 'America/Chicago', appointmentStartAt: '2026-10-28T13:00:00.000Z', appointmentEndAt: '2026-10-28T15:00:00.000Z',
    status: 'pending', arrivedAt: null, departedAt: null,
  });

  const load = (id: string, stops: unknown[]) => ({
    id, loadNumber: `L-RT${id.slice(-8).toUpperCase().replace(/[^A-Z0-9]/g, '')}`, status: 'booked', schemaVersion: 2, exception: null,
    customerId: 'cus_test', customerName: 'Test Customer', brokerId: null, brokerName: 'Broker', brokerReference: 'REF-RT',
    commodity: 'Paper', weightLbs: 40000, pieces: 1, equipmentType: 'dry_van', temperatureF: null, hazmat: false,
    dispatcherId: '', dispatcherName: 'Test', driverId: null, driverName: null, truckId: null, truckUnit: null, trailerId: null, trailerUnit: null,
    origin: { city: 'Chicago', state: 'IL' }, destination: { city: 'Atlanta', state: 'GA' }, stops,
    rate: 2500, loadedMiles: 716, emptyMiles: 0, rpm: 3.49, charges: [], expenses: [], financials: null, timeline: [], notes: [], documents: [],
    pickupAt: '2026-10-28T13:00:00.000Z', deliveryAt: '2026-10-29T13:00:00.000Z', etaAt: null, milesRemaining: null,
    bookedAt: '2026-10-27T13:00:00.000Z', dispatchedAt: null, deliveredAt: null, invoiceId: null,
    createdAt: '2026-10-27T13:00:00.000Z', updatedAt: '2026-10-27T13:00:00.000Z',
  });

  beforeAll(async () => {
    await fake.start();
    Object.assign(env, { TOLLGURU_API_KEY: 'stub-key-for-tests', TOLLGURU_API_BASE: fake.url });
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    companyId = ((await call('GET', '/auth/me')).json() as { companyId: string }).companyId;
    const db = app.get(DatabaseService).db;
    const rows = [
      load(ids.a, [stop(`${ids.a}_1`, 'pickup', 'Chicago', 'IL', 1, '1 Main St'), stop(`${ids.a}_2`, 'delivery', 'Nashville', 'TN', 2), stop(`${ids.a}_3`, 'delivery', 'Atlanta', 'GA', 3)]),
      load(ids.b, [stop(`${ids.b}_1`, 'pickup', 'Dallas', 'TX', 1), stop(`${ids.b}_2`, 'delivery', 'Memphis', 'TN', 2)]),
      load(ids.c, [stop(`${ids.c}_1`, 'pickup', 'Denver', 'CO', 1), stop(`${ids.c}_2`, 'delivery', 'Omaha', 'NE', 2)]),
    ];
    for (const row of rows) {
      await db.insert(loadsTable).values({ id: row.id, companyId, loadNumber: row.loadNumber, status: row.status, dispatcherId: '', version: 1, record: row }).onConflictDoNothing();
    }
  });

  afterAll(async () => {
    Object.assign(env, { TOLLGURU_API_KEY: saved.key, TOLLGURU_API_BASE: saved.base });
    const db = app.get(DatabaseService).db;
    await db.delete(loadsTable).where(and(eq(loadsTable.companyId, companyId), like(loadsTable.id, `ld_rt_${stamp}%`)));
    await app.close();
    await new Promise<void>((resolve) => fake.server.close(() => resolve()));
  });

  it('prices up to three roads, sorted by tolls + fuel, with the key sent only to TollGuru', async () => {
    const res = await call('POST', `/loads/${ids.a}/route-options`, {});
    expect(res.statusCode, res.body).toBe(201);
    const out = res.json() as RouteOptionsResult;
    expect(out.cached).toBe(false);
    expect(out.options.map((o) => o.via)).toEqual(['I-57 S; I-24 E', 'I-65 S', 'I-55 S']);
    expect(out.options.map((o) => o.totalCost)).toEqual([430, 464.5, 550]);
    expect(out.options[0]).toMatchObject({ label: 'Cheapest', miles: 702, tollCost: 0 });
    expect(out.options[2]).toMatchObject({ label: 'Fastest' });
    expect(out.settings).toEqual({ fuelPricePerGallon: 3.75, mpg: 6.5, grossWeightLbs: 80000, axles: 5 });
    expect(res.body).not.toContain('stub-key-for-tests');
    // What TollGuru was asked: the stops in order, the middle one as a waypoint, a loaded 5-axle truck.
    const sent = fake.calls.at(-1)!;
    expect(sent.apiKey).toBe('stub-key-for-tests');
    expect(sent.body).toMatchObject({
      from: { address: '1 Main St, Chicago, IL' },
      to: { address: 'Atlanta, GA' },
      waypoints: [{ address: 'Nashville, TN' }],
      vehicle: { type: '5AxlesTruck', weight: { value: 80000, unit: 'pound' }, axles: 5 },
      fuelOptions: { fuelCost: { value: 3.75, units: 'USD/gallon' }, fuelEfficiency: { hwy: 6.5, units: 'mpg' } },
    });
  });

  it('asks TollGuru once a day for the same stops', async () => {
    const before = fake.calls.length;
    const again = (await call('POST', `/loads/${ids.a}/route-options`, {})).json() as RouteOptionsResult;
    expect(again.cached).toBe(true);
    expect(fake.calls.length).toBe(before);
  });

  it('stores the chosen road on the load, on the timeline and in the audit, and the driver message reads it', async () => {
    const options = ((await call('POST', `/loads/${ids.a}/route-options`, {})).json() as RouteOptionsResult).options;
    const current = (await call('GET', `/loads/${ids.a}`)).json() as StoredLoad;
    const chosen = options.find((o) => o.via === 'I-65 S')!;
    const res = await call('POST', `/loads/${ids.a}/route`, { optionId: chosen.id, expectedUpdatedAt: current.updatedAt });
    expect(res.statusCode, res.body).toBe(201);
    const after = (res.json() as { load: StoredLoad }).load;
    const route = after['route'] as ChosenRoute;
    expect(route).toMatchObject({ provider: 'tollguru', via: 'I-65 S', miles: 718, tollCost: 24.5, fuelCost: 440, totalCost: 464.5, mapUrl: 'https://www.google.com/maps/dir/?api=1&a', settings: { fuelPricePerGallon: 3.75, mpg: 6.5 } });
    expect(route.chosenByName).toBeTruthy();
    expect(after.timeline.at(-1)).toMatchObject({ kind: 'route_chosen', title: 'Route chosen: I-65 S' });

    const stored = (await call('GET', `/loads/${ids.a}`)).json() as StoredLoad;
    expect((stored['route'] as ChosenRoute).via).toBe('I-65 S');
    const text = driverMessageFromRc(
      { brokerName: null, brokerMc: null, brokerLoadNumber: 'REF-RT', totalRate: null, linehaulRate: null, commodity: null, weightLbs: null, equipment: null, hazmat: false, temperature: null, miles: 718, stops: [], notes: null, warnings: [] },
      { route: stored['route'] as ChosenRoute },
    );
    expect(text).toContain('Route: I-65 S · 718 mi · tolls $24.50');

    const audit = await app.get(DatabaseService).db.select().from(auditLogs).where(and(eq(auditLogs.entityId, ids.a), eq(auditLogs.action, 'load_route_chosen')));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.summary).toContain('I-65 S');

    // Clear takes it off again, also version-checked.
    const cleared = await call('POST', `/loads/${ids.a}/route/clear`, { expectedUpdatedAt: stored.updatedAt });
    expect(cleared.statusCode, cleared.body).toBe(201);
    expect((cleared.json() as { load: StoredLoad }).load['route']).toBeNull();
  });

  it('refuses a stale copy with 409 and writes nothing', async () => {
    const options = ((await call('POST', `/loads/${ids.a}/route-options`, {})).json() as RouteOptionsResult).options;
    const res = await call('POST', `/loads/${ids.a}/route`, { optionId: options[0]!.id, expectedUpdatedAt: '2026-10-27T13:00:00.000Z' });
    expect(res.statusCode, res.body).toBe(409);
    const stored = (await call('GET', `/loads/${ids.a}`)).json() as StoredLoad;
    expect(stored['route'] ?? null).toBeNull();
  });

  it('refuses an option id that is not on the list', async () => {
    const current = (await call('GET', `/loads/${ids.a}`)).json() as StoredLoad;
    const res = await call('POST', `/loads/${ids.a}/route`, { optionId: 'rt_forged', expectedUpdatedAt: current.updatedAt });
    expect(res.statusCode, res.body).toBe(422);
  });

  it('says plainly when the TollGuru account has no active plan', async () => {
    fake.mode = 'no_subscription';
    try {
      const res = await call('POST', `/loads/${ids.b}/route-options`, {});
      expect(res.statusCode).toBe(502);
      expect(res.json()).toMatchObject({ code: 'no_subscription', title: 'TollGuru: no active subscription — activate a plan in TollGuru.' });
      fake.mode = 'broken';
      const down = await call('POST', `/loads/${ids.b}/route-options`, { refresh: true });
      expect(down.statusCode).toBe(502);
      expect(down.json()).toMatchObject({ code: 'unavailable' });
      expect((down.json() as { title: string }).title).toMatch(/^TollGuru did not answer/);
    } finally {
      fake.mode = 'ok';
    }
  });

  it('says TollGuru is not set up when there is no key', async () => {
    Object.assign(env, { TOLLGURU_API_KEY: undefined });
    try {
      const res = await call('POST', `/loads/${ids.c}/route-options`, {});
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ code: 'not_configured' });
      expect((res.json() as { title: string }).title).toMatch(/^TollGuru is not set up/);
    } finally {
      Object.assign(env, { TOLLGURU_API_KEY: 'stub-key-for-tests' });
    }
  });

  it('needs loads.edit', async () => {
    const current = (await call('GET', `/loads/${ids.c}`)).json() as StoredLoad;
    const headers = { 'x-demo-role': 'operations' };
    expect((await call('POST', `/loads/${ids.c}/route-options`, {}, headers)).statusCode).toBe(403);
    expect((await call('POST', `/loads/${ids.c}/route`, { optionId: 'x', expectedUpdatedAt: current.updatedAt }, headers)).statusCode).toBe(403);
    expect((await call('POST', `/loads/${ids.c}/route/clear`, { expectedUpdatedAt: current.updatedAt }, headers)).statusCode).toBe(403);
  });
});
