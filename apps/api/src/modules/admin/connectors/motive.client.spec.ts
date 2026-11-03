import { describe, expect, it } from 'vitest';
import { MotiveClient, MotiveError } from './motive.client';

/**
 * The client, against a Motive that answers what we tell it to. Every request is recorded so the
 * tests can say what was sent: the key in the X-Api-Key header and nowhere else.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function fakeMotive(
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
    if (!route) return new Response('not found', { status: 404 });
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

describe('MotiveClient', () => {
  it('sends the key as X-Api-Key and nowhere else, and names the company', async () => {
    const motive = fakeMotive({
      '/v1/companies': () => ({
        status: 200,
        body: { companies: [{ company: { id: 42, name: 'Northwind Freight' } }], pagination: { per_page: 25, page_no: 1, total: 1 } },
      }),
    });
    const client = new MotiveClient('motive_SECRET123', { fetchImpl: motive.fetchImpl, sleep });

    expect(await client.company()).toEqual({ id: '42', name: 'Northwind Freight' });
    expect(motive.calls[0]?.url).toBe('https://api.gomotive.com/v1/companies');
    expect(motive.calls[0]?.headers['X-Api-Key']).toBe('motive_SECRET123');
    expect(motive.calls[0]?.headers.Authorization).toBeUndefined();
    expect(motive.calls[0]?.url).not.toContain('SECRET');
  });

  it('walks every page of the vehicle list by page_no until the total is read', async () => {
    const motive = fakeMotive({
      '/v1/vehicles': (url) => {
        expect(url.searchParams.get('per_page')).toBe('100');
        const page = Number(url.searchParams.get('page_no'));
        const vehicles =
          page === 1
            ? Array.from({ length: 100 }, (_, i) => ({ vehicle: { id: i + 1, number: String(3000 + i), status: 'active' } }))
            : [{ vehicle: { id: 101, number: ' 3100 ', vin: '1fujgldr8clbp0101', make: 'Volvo', year: '2021', license_plate_number: 'P123', license_plate_state: 'IL', status: 'deactivated' } }];
        return { status: 200, body: { vehicles, pagination: { per_page: 100, page_no: page, total: 101 } } };
      },
    });
    const client = new MotiveClient('k', { fetchImpl: motive.fetchImpl, sleep });

    const vehicles = await client.vehicles();
    expect(vehicles).toHaveLength(101);
    expect(motive.calls).toHaveLength(2);
    expect(motive.calls[1]?.url).toContain('page_no=2');
    expect(vehicles[100]).toEqual({
      id: '101',
      name: '3100',
      vin: '1fujgldr8clbp0101',
      make: 'Volvo',
      model: null,
      year: 2021,
      licensePlate: 'P123',
      licensePlateState: 'IL',
      status: 'deactivated',
      updatedAt: null,
    });
  });

  it('stops on a short page when Motive sends no total, and on an empty page', async () => {
    const motive = fakeMotive({
      '/v1/vehicles': () => ({ status: 200, body: { vehicles: [{ id: 7, number: '7' }] } }),
    });
    const client = new MotiveClient('k', { fetchImpl: motive.fetchImpl, sleep });
    expect((await client.vehicles()).map((v) => v.id)).toEqual(['7']);
    expect(motive.calls).toHaveLength(1);
  });

  it('reads odometer, engine hours and position tolerantly; unknown stays null', async () => {
    const motive = fakeMotive({
      '/v2/vehicle_locations': () => ({
        status: 200,
        body: {
          vehicles: [
            {
              vehicle: {
                id: 23,
                number: '3001',
                current_location: {
                  lat: 41.7,
                  lon: '-88.1',
                  description: '3.2 mi NE of Naperville, IL',
                  located_at: '2026-10-20T10:00:00Z',
                  bearing: 90,
                  type: 'vehicle_moving',
                  speed: 61.4,
                  odometer: 456_222.4,
                  true_odometer: 456_300.6,
                  engine_hours: 12_345.67,
                },
              },
            },
            // A parked unit whose ECU sent zeros and no fix: nothing to report, not "0 miles".
            { vehicle: { id: 24, number: '3002', current_location: { lat: 0, lon: 0, odometer: 0, true_odometer: null, engine_hours: 'n/a', located_at: 'garbage' } } },
            { vehicle: { id: 25, number: '3003', current_location: null } },
            { vehicle: { number: 'no id' } },
          ],
          pagination: { per_page: 100, page_no: 1, total: 4 },
        },
      }),
    });
    const client = new MotiveClient('k', { fetchImpl: motive.fetchImpl, sleep });

    const locations = await client.vehicleLocations();
    expect(locations).toHaveLength(3);
    expect(locations[0]).toEqual({
      id: '23',
      name: '3001',
      odometerMiles: 456_301,
      engineHours: 12_345.7,
      at: '2026-10-20T10:00:00.000Z',
      latitude: 41.7,
      longitude: -88.1,
      place: '3.2 mi NE of Naperville, IL',
      speedMph: 61.4,
      headingDegrees: 90,
      engineState: 'on',
    });
    expect(locations[1]).toMatchObject({ id: '24', odometerMiles: null, engineHours: null, at: null, latitude: null, longitude: null });
    expect(locations[2]).toMatchObject({ id: '25', odometerMiles: null, at: null, latitude: null });
  });

  it('names a refused key without repeating it, and does not retry it', async () => {
    for (const status of [401, 403]) {
      const motive = fakeMotive({ '/v1/companies': () => ({ status, body: { error_message: 'Unauthorized' } }) });
      const client = new MotiveClient('motive_SECRET123', { fetchImpl: motive.fetchImpl, sleep });
      const error = await client.company().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(MotiveError);
      expect((error as MotiveError).status).toBe(status);
      expect((error as MotiveError).retryable).toBe(false);
      expect((error as MotiveError).message).toMatch(/Motive rejected the API key/);
      expect((error as MotiveError).message).not.toContain('SECRET');
      expect(motive.calls).toHaveLength(1);
    }
  });

  it('waits and retries when rate limited, honouring Retry-After, then backing off', async () => {
    waits.length = 0;
    const motive = fakeMotive({
      '/v1/companies': (_url, attempt) =>
        attempt === 1
          ? { status: 429, headers: { 'retry-after': '3' } }
          : attempt === 2
            ? { status: 429 }
            : { status: 200, body: { companies: [{ company: { id: 1, name: 'X' } }] } },
    });
    const client = new MotiveClient('k', { fetchImpl: motive.fetchImpl, sleep });

    expect(await client.company()).toEqual({ id: '1', name: 'X' });
    expect(motive.calls).toHaveLength(3);
    expect(waits).toEqual([3000, 4000]);
  });

  it('gives up after repeated 429s with a retryable error', async () => {
    const motive = fakeMotive({ '/v1/companies': () => ({ status: 429, headers: { 'retry-after': '0' } }) });
    const client = new MotiveClient('k', { fetchImpl: motive.fetchImpl, sleep });
    const error = await client.company().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MotiveError);
    expect((error as MotiveError).status).toBe(429);
    expect((error as MotiveError).retryable).toBe(true);
    expect(motive.calls).toHaveLength(5);
  });

  it('reports a server error as retryable and a network failure as unreachable', async () => {
    const down = fakeMotive({ '/v1/companies': () => ({ status: 503 }) });
    const e1 = await new MotiveClient('k', { fetchImpl: down.fetchImpl, sleep }).company().catch((e: unknown) => e);
    expect((e1 as MotiveError).retryable).toBe(true);
    expect((e1 as MotiveError).message).toMatch(/HTTP 503/);

    const broken = (async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;
    const e2 = await new MotiveClient('k', { fetchImpl: broken, sleep }).company().catch((e: unknown) => e);
    expect((e2 as MotiveError).message).toMatch(/could not be reached/);
  });
});
