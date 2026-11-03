import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateLoads } from '@/demo/loads-api';
import { loadFleetBundle } from './useFleet';

/**
 * A shop account (Maintenance) may not read loads. The Fleet pages must still show the trucks and
 * trailers; before 2026-09-30 the refused loads read blanked every Fleet table for Dalton Mattox.
 */
const original = globalThis.fetch;
let loadsStatus = 403;

beforeEach(() => {
  invalidateLoads();
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    if (path === '/loads') {
      return new Response(JSON.stringify({ type: 'about:blank', title: 'Forbidden', status: loadsStatus, detail: 'no' }), {
        status: loadsStatus,
        headers: { 'content-type': 'application/problem+json' },
      });
    }
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
  invalidateLoads();
  loadsStatus = 403;
});

describe('the fleet bundle for an account that cannot see loads', () => {
  it('still has the trucks when the loads read is refused', async () => {
    const bundle = await loadFleetBundle();
    expect(bundle.trucks.length).toBeGreaterThan(0);
  });

  it('still fails when the server is down, rather than showing an empty fleet', async () => {
    loadsStatus = 500;
    await expect(loadFleetBundle()).rejects.toBeTruthy();
  });
});
