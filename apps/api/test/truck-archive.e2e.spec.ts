import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { PmBoard, PtiBoard, RosterPage, TruckRecord } from '@neway/shared';
import { and, desc, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { auditLogs } from '../src/database/schema/people';
import { pmStatus } from '../src/database/schema/pm';
import { trucks } from '../src/database/schema/roster';
import { PmService } from '../src/modules/pm/pm.service';

/**
 * Archiving a truck (owner, 2026-10-05), end to end on the local database:
 *   - POST /trucks/:id/archive asks for a reason and the version the caller read; a stale version
 *     is a 409 and writes nothing; a good one sets `archived` and writes one audit line;
 *   - the archived truck is out of GET /trucks (in with includeArchived), the work-order unit
 *     picker, the PTI board and the PM board, and a PM recompute gives it no status row;
 *   - the plain status route cannot archive or un-archive it;
 *   - POST /trucks/:id/restore brings it back as `available`, audited.
 * The truck this spec makes is left archived at the end (never deleted).
 */
describe('Truck archive (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const tag = Date.now().toString(36).toUpperCase();
  const unitNumber = `E2E-TA-${tag}`.slice(0, 20);
  // A 17-character VIN from the tag, without I, O or Q.
  const vin = `1E2E${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17);
  let truck: TruckRecord;

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      ...(payload ? { payload } : {}),
    });
  const listed = async (query = '') => {
    const res = await call('GET', `/api/v1/trucks?pageSize=200&includeInactive=true${query}`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as RosterPage<TruckRecord>).data.map((t) => t.id);
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const res = await call('POST', '/api/v1/trucks', {
      unitNumber,
      vin,
      year: 2022,
      make: 'E2E',
      model: 'Archive',
      odometer: 100_000,
      status: 'available',
    });
    expect(res.statusCode, res.body).toBe(201);
    truck = res.json() as TruckRecord;
    expect(truck.updatedAt).toBeTruthy();
  });

  afterAll(async () => {
    // Test data is never deleted: the truck stays archived.
    const [row] = await db.select().from(trucks).where(eq(trucks.id, truck.id));
    if (row && row.status !== 'archived') {
      await call('POST', `/api/v1/trucks/${truck.id}/archive`, {
        reason: 'e2e test data',
        expectedUpdatedAt: row.updatedAt.toISOString(),
      });
    }
    await app.close();
  });

  it('refuses an archive without a reason, or with a stale version, and writes nothing', async () => {
    const noReason = await call('POST', `/api/v1/trucks/${truck.id}/archive`, {
      reason: '',
      expectedUpdatedAt: truck.updatedAt,
    });
    expect(noReason.statusCode).toBe(422);
    const stale = await call('POST', `/api/v1/trucks/${truck.id}/archive`, {
      reason: 'Left the fleet',
      expectedUpdatedAt: '2020-01-01T00:00:00.000Z',
    });
    expect(stale.statusCode, stale.body).toBe(409);
    const [row] = await db.select().from(trucks).where(eq(trucks.id, truck.id));
    expect(row?.status).toBe('available');
  });

  it('archives with the reason in the audit, and hides the truck from the lists', async () => {
    expect(await listed()).toContain(truck.id);
    const res = await call('POST', `/api/v1/trucks/${unitNumber}/archive`, {
      reason: 'Tow unit, not a fleet truck',
      expectedUpdatedAt: truck.updatedAt,
    });
    expect(res.statusCode, res.body).toBe(201);
    truck = res.json() as TruckRecord;
    expect(truck.status).toBe('archived');

    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'truck'), eq(auditLogs.entityId, truck.id)))
      .orderBy(desc(auditLogs.at))
      .limit(1);
    expect(entry?.action).toBe('archive');
    expect(entry?.reason).toBe('Tow unit, not a fleet truck');
    expect(entry?.changes).toEqual([{ field: 'status', old: 'available', new: 'archived' }]);

    expect(await listed()).not.toContain(truck.id);
    expect(await listed('&includeArchived=true')).toContain(truck.id);
    // Still answers by id: its page and old records resolve.
    const one = await call('GET', `/api/v1/trucks/${truck.id}`);
    expect((one.json() as TruckRecord).status).toBe('archived');
  });

  it('is not offered for new work, and is off the PTI and PM boards', async () => {
    const units = await call('GET', '/api/v1/fleet/units?assetType=truck');
    expect(units.statusCode, units.body).toBe(200);
    expect((units.json() as { data: { id: string }[] }).data.map((u) => u.id)).not.toContain(
      truck.id,
    );

    const pti = await call('GET', '/api/v1/fleet/pti/board');
    expect(pti.statusCode, pti.body).toBe(200);
    expect((pti.json() as PtiBoard).rows.map((r) => r.inspection.unitId)).not.toContain(truck.id);

    await app.get(PmService).recompute((await db.select().from(trucks).where(eq(trucks.id, truck.id)))[0]!.companyId, [truck.id]);
    const status = await db.select().from(pmStatus).where(eq(pmStatus.unitId, truck.id));
    expect(status).toEqual([]);
    const pm = await call('GET', '/api/v1/fleet/pm/board');
    expect(pm.statusCode, pm.body).toBe(200);
    expect((pm.json() as PmBoard).rows.map((r) => r.unitId)).not.toContain(truck.id);
  });

  it('cannot be archived or un-archived through the plain status route', async () => {
    const toArchived = await call('POST', `/api/v1/trucks/${truck.id}/status`, { status: 'archived' });
    expect(toArchived.statusCode).toBe(422);
    const out = await call('POST', `/api/v1/trucks/${truck.id}/status`, { status: 'available' });
    expect(out.statusCode, out.body).toBe(409);
  });

  it('restores to available, audited', async () => {
    const res = await call('POST', `/api/v1/trucks/${truck.id}/restore`, {
      expectedUpdatedAt: truck.updatedAt,
      reason: 'Back on the road',
    });
    expect(res.statusCode, res.body).toBe(201);
    truck = res.json() as TruckRecord;
    expect(truck.status).toBe('available');
    expect(await listed()).toContain(truck.id);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'truck'), eq(auditLogs.entityId, truck.id)))
      .orderBy(desc(auditLogs.at))
      .limit(1);
    expect(entry?.action).toBe('restore');
  });
});
