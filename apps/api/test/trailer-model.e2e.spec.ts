import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { RosterPage, TrailerRecord } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * Trailer model (owner, 2026-10-22), end to end on the local database:
 *   - POST /trailers stores a model beside the make, and takes a model without a make;
 *   - GET /trailers finds a trailer by its model and returns it on every record (null when unset);
 *   - PATCH /trailers sets the model alone, without touching the VIN, type or ownership.
 * The trailers this spec makes are left inactive at the end (never deleted).
 */
describe('Trailer model (e2e)', () => {
  let app: NestFastifyApplication;
  const tag = Date.now().toString(36).toUpperCase();
  const vinFor = (prefix: string) =>
    `${prefix}${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17);
  const made: string[] = [];

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  afterAll(async () => {
    // Test data is never deleted: each trailer is taken off the fleet.
    for (const id of made) {
      await call('POST', `/api/v1/trailers/${id}/status`, { status: 'inactive' });
    }
    await app.close();
  });

  it('creates a trailer with a make and a model', async () => {
    const res = await call('POST', '/api/v1/trailers', {
      unitNumber: `E2E-TM1-${tag}`.slice(0, 20),
      vin: vinFor('1TM1'),
      year: 2026,
      make: ' Utility ',
      model: ' 4000D-X ',
      type: 'reefer',
    });
    expect(res.statusCode, res.body).toBe(201);
    const trailer = res.json() as TrailerRecord;
    made.push(trailer.id);
    expect(trailer.make).toBe('Utility');
    expect(trailer.model).toBe('4000D-X');
    expect(trailer.year).toBe(2026);

    const one = await call('GET', `/api/v1/trailers/${trailer.id}`);
    expect((one.json() as TrailerRecord).model).toBe('4000D-X');

    const found = await call('GET', `/api/v1/trailers?search=4000D-X&includeInactive=true`);
    expect(found.statusCode, found.body).toBe(200);
    expect((found.json() as RosterPage<TrailerRecord>).data.map((t) => t.id)).toContain(trailer.id);
  });

  it('creates a trailer with a model and no make', async () => {
    const res = await call('POST', '/api/v1/trailers', {
      unitNumber: `E2E-TM2-${tag}`.slice(0, 20),
      vin: vinFor('1TM2'),
      year: 2024,
      model: 'Everest',
    });
    expect(res.statusCode, res.body).toBe(201);
    const trailer = res.json() as TrailerRecord;
    made.push(trailer.id);
    expect(trailer.make).toBeNull();
    expect(trailer.model).toBe('Everest');
  });

  it('creates a trailer with neither, and reads it with a null model', async () => {
    const res = await call('POST', '/api/v1/trailers', {
      unitNumber: `E2E-TM3-${tag}`.slice(0, 20),
    });
    expect(res.statusCode, res.body).toBe(201);
    const trailer = res.json() as TrailerRecord;
    made.push(trailer.id);
    expect(trailer.make).toBeNull();
    expect(trailer.model).toBeNull();
  });

  it('refuses a model longer than 40 characters', async () => {
    const res = await call('POST', '/api/v1/trailers', {
      unitNumber: `E2E-TM4-${tag}`.slice(0, 20),
      model: 'X'.repeat(41),
    });
    expect(res.statusCode).toBe(422);
    expect(res.body).toContain('Model is too long');
  });

  it('edits the model alone, leaving the VIN, type and ownership as they were', async () => {
    const id = made[0]!;
    const res = await call('PATCH', `/api/v1/trailers/${id}`, { model: '3000R' });
    expect(res.statusCode, res.body).toBe(200);
    const trailer = res.json() as TrailerRecord;
    expect(trailer.model).toBe('3000R');
    expect(trailer.make).toBe('Utility');
    expect(trailer.vin).toBe(vinFor('1TM1').toUpperCase());
    expect(trailer.type).toBe('reefer');
    expect(trailer.ownership).toBe('owned');

    const cleared = await call('PATCH', `/api/v1/trailers/${id}`, { model: '' });
    expect((cleared.json() as TrailerRecord).model).toBeNull();
  });
});
