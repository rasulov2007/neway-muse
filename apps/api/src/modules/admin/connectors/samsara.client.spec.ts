import { describe, expect, it } from 'vitest';
import { metersToMiles, SamsaraClient, SamsaraError } from './samsara.client';

/**
 * The client, against a Samsara that answers what we tell it to.
 *
 * Every request the client makes is recorded — its path, its query and its headers — so the
 * tests can say what was sent as well as what came back. The one thing they check most carefully
 * is what was *not* sent anywhere: the token appears in the Authorization header and nowhere
 * else, not in a URL and not in an error.
 */

interface Recorded {
  url: string;
  headers: Record<string, string>;
}

function fakeSamsara(
  routes: Record<string, (url: URL, attempt: number) => { status: number; body?: unknown; headers?: Record<string, string> }>,
) {
  const calls: Recorded[] = [];
  const attempts = new Map<string, number>();
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    const key = url.pathname;
    const n = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, n);
    calls.push({ url: url.href, headers: Object.fromEntries(Object.entries((init?.headers as Record<string, string>) ?? {})) });
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

describe('SamsaraClient', () => {
  it('sends the token as a bearer header and nowhere else', async () => {
    const samsara = fakeSamsara({ '/me': () => ({ status: 200, body: { data: { id: 'org1', name: 'Northwind' } } }) });
    const client = new SamsaraClient('samsara_api_SECRET123', samsara.fetchImpl);

    expect(await client.organisation()).toEqual({ id: 'org1', name: 'Northwind' });
    expect(samsara.calls[0]?.headers.Authorization).toBe('Bearer samsara_api_SECRET123');
    expect(samsara.calls[0]?.url).not.toContain('SECRET');
  });

  it('walks every page of the vehicle list', async () => {
    const samsara = fakeSamsara({
      '/fleet/vehicles': (url) => {
        const after = url.searchParams.get('after');
        expect(url.searchParams.get('limit')).toBe('512');
        if (!after) {
          return { status: 200, body: { data: [{ id: '1', name: '3001', vin: '1FUJGLDR8CLBP0101', year: '2021' }], pagination: { endCursor: 'c2', hasNextPage: true } } };
        }
        return { status: 200, body: { data: [{ id: '2', name: ' 3002 ', make: 'Volvo' }], pagination: { endCursor: '', hasNextPage: false } } };
      },
    });
    const client = new SamsaraClient('t', samsara.fetchImpl);

    const vehicles = await client.vehicles();
    expect(vehicles).toEqual([
      { id: '1', name: '3001', vin: '1FUJGLDR8CLBP0101', make: null, model: null, year: 2021, licensePlate: null, updatedAt: null },
      { id: '2', name: '3002', vin: null, make: 'Volvo', model: null, year: null, licensePlate: null, updatedAt: null },
    ]);
    expect(samsara.calls).toHaveLength(2);
    expect(samsara.calls[1]?.url).toContain('after=c2');
  });

  it('asks for stats three types at a time and merges them per vehicle', async () => {
    const seenTypes: string[] = [];
    const samsara = fakeSamsara({
      '/fleet/vehicles/stats': (url) => {
        const types = url.searchParams.get('types') ?? '';
        seenTypes.push(types);
        if (types.startsWith('obdOdometerMeters')) {
          return {
            status: 200,
            body: {
              data: [
                {
                  id: '1',
                  name: '3001',
                  obdOdometerMeters: { time: '2026-09-17T10:00:00Z', value: 160_934.4 },
                  gps: { time: '2026-09-17T10:05:00Z', latitude: 41.7, longitude: -88.1, speedMilesPerHour: 61, reverseGeo: { formattedLocation: '1 Main St, Naperville, IL 60563' } },
                },
              ],
              pagination: { hasNextPage: false },
            },
          };
        }
        return {
          status: 200,
          body: {
            data: [{ id: '1', name: '3001', obdEngineSeconds: { time: '2026-09-17T10:00:00Z', value: 7_200 }, engineStates: { time: '2026-09-17T10:05:00Z', value: 'On' } }],
            pagination: { hasNextPage: false },
          },
        };
      },
    });
    const client = new SamsaraClient('t', samsara.fetchImpl);

    const stats = await client.vehicleStats();
    expect(seenTypes.every((t) => t.split(',').length <= 3)).toBe(true);
    expect(stats).toHaveLength(1);
    expect(stats[0]).toMatchObject({
      id: '1',
      obdOdometerMiles: 100,
      obdOdometerAt: '2026-09-17T10:00:00Z',
      engineHours: 2,
      engineState: 'on',
      gps: { latitude: 41.7, longitude: -88.1, speedMph: 61, place: '1 Main St, Naperville, IL 60563' },
    });
  });

  it('names a refused token without repeating it', async () => {
    const samsara = fakeSamsara({ '/me': () => ({ status: 401, body: { message: 'invalid token' } }) });
    const client = new SamsaraClient('samsara_api_SECRET123', samsara.fetchImpl);

    await expect(client.organisation()).rejects.toThrow(SamsaraError);
    try {
      await client.organisation();
    } catch (error) {
      expect((error as SamsaraError).status).toBe(401);
      expect((error as SamsaraError).retryable).toBe(false);
      expect((error as SamsaraError).message).not.toContain('SECRET');
      expect((error as SamsaraError).message).toMatch(/Replace the credential/);
    }
  });

  it('waits and retries when rate limited', async () => {
    const samsara = fakeSamsara({
      '/me': (_url, attempt) =>
        attempt === 1
          ? { status: 429, headers: { 'retry-after': '0' } }
          : { status: 200, body: { data: { id: 'org1', name: 'Northwind' } } },
    });
    const client = new SamsaraClient('t', samsara.fetchImpl);

    expect(await client.organisation()).toEqual({ id: 'org1', name: 'Northwind' });
    expect(samsara.calls).toHaveLength(2);
  });

  it('converts meters to whole miles', () => {
    expect(metersToMiles(1609.344)).toBe(1);
    expect(metersToMiles(160_934_400)).toBe(100_000);
  });
});
