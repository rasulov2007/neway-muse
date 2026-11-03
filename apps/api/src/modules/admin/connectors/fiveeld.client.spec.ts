import { describe, expect, it } from 'vitest';
import { FiveEldClient, FiveEldError } from './fiveeld.client';

/**
 * The client, against a Five ELD that answers what we tell it to. Every request is recorded so
 * the tests can say what was sent: the key and the token in their two headers and nowhere else,
 * the USDOT in the path, the window in the query.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function fakeFiveEld(
  routes: Record<string, (url: URL, attempt: number) => { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Recorded[] = [];
  const attempts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = url.pathname;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    calls.push({ url: url.href, headers: { ...((init?.headers as Record<string, string>) ?? {}) } });
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: 'Not found' }), { status: 404 });
    const answer = route(url, n);
    return new Response(answer.body === undefined ? '' : JSON.stringify(answer.body), {
      status: answer.status,
      headers: { 'content-type': 'application/json', ...(answer.headers ?? {}) },
    });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

const waits: number[] = [];
const sleep = async (ms: number) => {
  waits.push(ms);
};

const CREDS = { apiKey: 'ak_live_SECRETKEY', providerToken: 'pt_SECRETTOKEN', usdot: ' 1234567 ' };
const FROM = new Date('2026-10-20T00:00:00Z');
const TO = new Date('2026-10-21T00:00:00Z');

describe('FiveEldClient', () => {
  it('sends the key and the token as headers and nowhere else, the USDOT in the path, the window in the query', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': () => ({
        status: 200,
        body: [
          { id: 'u-1', truck_number: ' 3001 ', vin: '1FUJGLDR8CLBP0101' },
          { id: 42, truck_number: '3002', vin: '' },
          { truck_number: 'no id' },
        ],
      }),
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });

    const units = await client.activeUnits(FROM, TO);
    expect(units).toEqual([
      { id: 'u-1', name: '3001', vin: '1FUJGLDR8CLBP0101' },
      { id: '42', name: '3002', vin: null },
    ]);
    const call = five.calls[0];
    expect(call?.url).toBe(
      'https://read.fiveeld.com/api/externalservice/active-units/1234567/?from=2026-10-20T00%3A00%3A00.000Z&to=2026-10-21T00%3A00%3A00.000Z',
    );
    expect(call?.headers['x-api-key']).toBe('ak_live_SECRETKEY');
    expect(call?.headers['provider-token']).toBe('pt_SECRETTOKEN');
    expect(call?.headers.Authorization).toBeUndefined();
    expect(call?.url).not.toContain('SECRET');
  });

  it('cuts a window over 72 hours into slices Five ELD accepts, newest first, listing each vehicle once', async () => {
    const seen: Array<[string, string]> = [];
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': (url) => {
        seen.push([url.searchParams.get('from') ?? '', url.searchParams.get('to') ?? '']);
        return { status: 200, body: [{ id: 'u-1', truck_number: '3001', vin: null }, { id: `u-${seen.length}`, truck_number: 'x', vin: null }] };
      },
      '/api/externalservice/trackings/1234567/u-1/': (url) => ({
        status: 200,
        body: url.searchParams.get('to') === '2026-10-21T00:00:00.000Z' ? [] : [{ date: url.searchParams.get('to'), odometer: 7 }],
      }),
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    const units = await client.activeUnits(new Date('2026-10-13T00:00:00Z'), TO);
    expect(seen.length).toBe(3);
    expect(seen[0]).toEqual(['2026-10-18T00:00:00.000Z', '2026-10-21T00:00:00.000Z']);
    expect(seen[2]).toEqual(['2026-10-13T00:00:00.000Z', '2026-10-15T00:00:00.000Z']);
    for (const [from, to] of seen) expect(Date.parse(to) - Date.parse(from)).toBeLessThanOrEqual(72 * 3_600_000);
    expect(units.map((u) => u.id)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(units.filter((u) => u.id === 'u-1')).toHaveLength(1);

    // The newest slice is empty, so the walk goes one slice back and stops there.
    const latest = await client.latestTracking('u-1', new Date('2026-10-13T00:00:00Z'), TO);
    expect(latest?.odometer).toBe(7);
    expect(five.calls.filter((c) => c.url.includes('/trackings/')).length).toBe(2);
  });

  it('honours a different base URL and a wrapped list', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': () => ({ status: 200, body: { data: [{ id: 'u-1', truck_number: '3001', vin: null }] } }),
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep, baseUrl: 'https://read.fiveeld.com/' });
    expect((await client.activeUnits(FROM, TO)).map((u) => u.id)).toEqual(['u-1']);
    expect(five.calls[0]?.url.startsWith('https://read.fiveeld.com/api/externalservice/')).toBe(true);
  });

  it('reads tracking points tolerantly, oldest first; unknown stays null, never 0', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/trackings/1234567/u-1/': (url) => {
        expect(url.searchParams.get('from')).toBe(FROM.toISOString());
        expect(url.searchParams.get('to')).toBe(TO.toISOString());
        return {
          status: 200,
          body: [
            {
              address: '1850 Diehl Rd, Naperville, IL 60563',
              coordinates: { lat: 41.7, lng: '-88.1' },
              rotation: 90,
              speed: 61.4,
              driverId: 'd-9',
              odometer: 456_300.6,
              date: '2026-10-20T10:00:00Z',
            },
            // Out of order, zeros and garbage: a point with a time but nothing else known.
            { coordinates: { lat: 0, lng: 0 }, rotation: 400, speed: 'n/a', odometer: 0, date: '2026-10-20T09:00:00Z' },
            // No time at all: not a point.
            { coordinates: { lat: 41.8, lng: -88.2 }, odometer: 456_400 },
            // Flat coordinates and an epoch-seconds time are read too.
            { lat: 41.9, lng: -88.3, odometer: '456401', timestamp: 1_792_490_400 },
          ],
        };
      },
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });

    const points = await client.trackings('u-1', FROM, TO);
    expect(points).toHaveLength(3);
    expect(points[0]).toEqual({
      at: '2026-10-20T09:00:00.000Z',
      latitude: null,
      longitude: null,
      address: null,
      odometer: null,
      speed: null,
      headingDegrees: null,
      driverId: null,
    });
    expect(points[1]).toEqual({
      at: '2026-10-20T10:00:00.000Z',
      latitude: 41.7,
      longitude: -88.1,
      address: '1850 Diehl Rd, Naperville, IL 60563',
      odometer: 456_301,
      speed: 61.4,
      headingDegrees: 90,
      driverId: 'd-9',
    });
    expect(points[2]).toMatchObject({ at: '2026-10-20T10:00:00.000Z', latitude: 41.9, longitude: -88.3, odometer: 456_401 });
    expect(await client.latestTracking('u-1', FROM, TO)).toEqual(points[2]);
  });

  it('a vehicle that sent nothing in the window has no latest point', async () => {
    const five = fakeFiveEld({ '/api/externalservice/trackings/1234567/u-2/': () => ({ status: 200, body: [] }) });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    expect(await client.latestTracking('u-2', FROM, TO)).toBeNull();
    expect(five.calls).toHaveLength(1);
  });

  it('walks pages when the answer carries meta.totalPages, and stops otherwise', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': (url) => {
        const page = Number(url.searchParams.get('page') ?? '1');
        return {
          status: 200,
          body: { data: [{ id: `u-${page}`, truck_number: String(page), vin: null }], meta: { page, perPage: 1, total: 3, totalPages: 3 } },
        };
      },
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    expect((await client.activeUnits(FROM, TO)).map((u) => u.id)).toEqual(['u-1', 'u-2', 'u-3']);
    expect(five.calls).toHaveLength(3);
    expect(five.calls[0]?.url).not.toContain('page=');
    expect(five.calls[2]?.url).toContain('page=3');
  });

  it('lists every vehicle from current-units, parked ones included, across all pages', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/current-units/1234567': (url) => {
        expect(url.searchParams.get('is_active')).toBe('true');
        expect(url.searchParams.get('perPage')).toBe('100');
        const page = Number(url.searchParams.get('page'));
        const data =
          page === 1
            ? [
                { id: 'a1b2c3d4-0000-0000-0000-000000000016', vin: '1FUJHHDR9PLUK0202', truck_number: '0016', driver: { id: 'd1', first_name: 'A', second_name: 'B' }, codriver: null },
                { id: 'a1b2c3d4-0000-0000-0000-000000700124', vin: '4V4NC9EH4RN700124', truck_number: '700124', driver: null, codriver: null },
              ]
            : [{ id: 'a1b2c3d4-0000-0000-0000-000000700123', vin: '4V4NC9EH2RN700123', truck_number: '700123', driver: { id: 'd2', first_name: 'Michelin', second_name: 'Georges' } }];
        return { status: 200, body: { data, meta: { page, perPage: 2, total: 3, totalPages: 2 } } };
      },
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    const listed = await client.listUnits(FROM, TO);
    expect(listed.source).toBe('current-units');
    expect(listed.units).toEqual([
      { id: 'a1b2c3d4-0000-0000-0000-000000000016', name: '0016', vin: '1FUJHHDR9PLUK0202' },
      { id: 'a1b2c3d4-0000-0000-0000-000000700124', name: '700124', vin: '4V4NC9EH4RN700124' },
      { id: 'a1b2c3d4-0000-0000-0000-000000700123', name: '700123', vin: '4V4NC9EH2RN700123' },
    ]);
    expect(five.calls).toHaveLength(2);
    expect(five.calls[0]?.url).toContain('page=1');
    expect(five.calls[1]?.url).toContain('page=2');
    expect(five.calls[0]?.url).not.toContain('SECRET');
  });

  it('falls back to active-units when current-units is unknown (404/400), never on refused credentials', async () => {
    for (const status of [404, 400]) {
      const five = fakeFiveEld({
        '/api/externalservice/current-units/1234567': () => ({ status, body: { message: 'Cannot GET' } }),
        '/api/externalservice/active-units/1234567/': () => ({ status: 200, body: [{ id: 'u-1', truck_number: '3001', vin: null }] }),
      });
      const listed = await new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep }).listUnits(FROM, TO);
      expect(listed.source).toBe('active-units');
      expect(listed.fallbackReason).toMatch(new RegExp(`HTTP ${status}`));
      expect(listed.units.map((u) => u.id)).toEqual(['u-1']);
    }

    const refused = fakeFiveEld({
      '/api/externalservice/current-units/1234567': () => ({ status: 404, body: { message: 'Provider token not found.' } }),
      '/api/externalservice/active-units/1234567/': () => ({ status: 200, body: [] }),
    });
    const error = (await new FiveEldClient(CREDS, { fetchImpl: refused.fetchImpl, sleep }).listUnits(FROM, TO).catch((e: unknown) => e)) as FiveEldError;
    expect(error.refusedCredential).toBe(true);
    expect(refused.calls.some((c) => c.url.includes('active-units'))).toBe(false);

    const down = fakeFiveEld({ '/api/externalservice/current-units/1234567': () => ({ status: 503 }) });
    const e2 = (await new FiveEldClient(CREDS, { fetchImpl: down.fetchImpl, sleep }).listUnits(FROM, TO).catch((e: unknown) => e)) as FiveEldError;
    expect(e2.status).toBe(503);
  });

  it('reads units-by-usdot (v2) last positions, a 0,0 fix as no fix', async () => {
    const five = fakeFiveEld({
      '/api/v2/units-by-usdot/1234567': () => ({
        status: 200,
        body: {
          units: [
            { truck_number: '0016', vin: '1FUJHHDR9PLUK0202', coordinates: { lat: 40.1, lng: -75.2 }, timestamp: '2026-10-20T08:32:11.000Z' },
            { truck_number: '700124', vin: '4V4NC9EH4RN700124', coordinates: { lat: 0, lng: 0 }, timestamp: null },
          ],
        },
      }),
    });
    expect(await new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep }).unitPositions()).toEqual([
      { truckNumber: '0016', vin: '1FUJHHDR9PLUK0202', latitude: 40.1, longitude: -75.2, at: '2026-10-20T08:32:11.000Z' },
      { truckNumber: '700124', vin: '4V4NC9EH4RN700124', latitude: null, longitude: null, at: null },
    ]);
  });

  it('names refused credentials without repeating them, and does not retry', async () => {
    for (const status of [401, 403]) {
      const five = fakeFiveEld({ '/api/externalservice/active-units/1234567/': () => ({ status, body: { message: 'Unauthorized' } }) });
      const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
      const error = await client.activeUnits(FROM, TO).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FiveEldError);
      expect((error as FiveEldError).status).toBe(status);
      expect((error as FiveEldError).retryable).toBe(false);
      expect((error as FiveEldError).message).toMatch(/Five ELD rejected the credentials \(HTTP 40[13]\)/);
      expect((error as FiveEldError).message).not.toContain('SECRET');
      expect(five.calls).toHaveLength(1);
    }
  });

  it('reads Five ELD’s own "Provider token not found." 404 as refused credentials, not a missing page', async () => {
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': () => ({ status: 404, body: { message: 'Provider token not found.' } }),
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    const error = (await client.activeUnits(FROM, TO).catch((e: unknown) => e)) as FiveEldError;
    expect(error.retryable).toBe(false);
    expect(error.message).toMatch(/rejected the credentials \(HTTP 404: Provider token not found\.\)/);
    expect(error.message).not.toContain('SECRET');

    // A 404 about something else is a plain failure, not a credential verdict.
    const gone = fakeFiveEld({ '/api/externalservice/trackings/1234567/u-9/': () => ({ status: 404, body: { message: 'Vehicle not found' } }) });
    const e2 = (await new FiveEldClient(CREDS, { fetchImpl: gone.fetchImpl, sleep }).trackings('u-9', FROM, TO).catch((e: unknown) => e)) as FiveEldError;
    expect(e2.retryable).toBe(false);
    expect(e2.message).toMatch(/HTTP 404 for \/api\/externalservice\/trackings\/1234567\/u-9\/ \(Vehicle not found\)/);
  });

  it('waits and retries when rate limited, honouring Retry-After, then backing off', async () => {
    waits.length = 0;
    const five = fakeFiveEld({
      '/api/externalservice/active-units/1234567/': (_url, attempt) =>
        attempt === 1
          ? { status: 429, headers: { 'retry-after': '3' } }
          : attempt === 2
            ? { status: 429 }
            : { status: 200, body: [{ id: 'u-1', truck_number: '1' }] },
    });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });

    expect((await client.activeUnits(FROM, TO)).map((u) => u.id)).toEqual(['u-1']);
    expect(five.calls).toHaveLength(3);
    expect(waits).toEqual([3000, 10000]);
  });

  it('gives up after repeated 429s with a retryable error', async () => {
    const five = fakeFiveEld({ '/api/externalservice/active-units/1234567/': () => ({ status: 429, headers: { 'retry-after': '0' } }) });
    const client = new FiveEldClient(CREDS, { fetchImpl: five.fetchImpl, sleep });
    const error = await client.activeUnits(FROM, TO).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FiveEldError);
    expect((error as FiveEldError).status).toBe(429);
    expect((error as FiveEldError).retryable).toBe(true);
    expect(five.calls).toHaveLength(5);
  });

  it('reports a server error as retryable and a network failure as unreachable', async () => {
    const down = fakeFiveEld({ '/api/externalservice/active-units/1234567/': () => ({ status: 503 }) });
    const e1 = await new FiveEldClient(CREDS, { fetchImpl: down.fetchImpl, sleep }).activeUnits(FROM, TO).catch((e: unknown) => e);
    expect((e1 as FiveEldError).retryable).toBe(true);
    expect((e1 as FiveEldError).message).toMatch(/HTTP 503/);

    const broken = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const e2 = await new FiveEldClient(CREDS, { fetchImpl: broken, sleep }).activeUnits(FROM, TO).catch((e: unknown) => e);
    expect((e2 as FiveEldError).message).toMatch(/could not be reached/);
  });
});
