import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type DriverRecord, type RosterPage, type WeeklyBoard } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAudit, dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';
import { loads } from '../src/database/schema/loads';
import { auditLogs } from '../src/database/schema/people';
import { drivers } from '../src/database/schema/roster';
import {
  applyUnassignedArchive,
  planUnassignedArchive,
  type ArchivePlan,
} from '../src/modules/roster/driver-archive.data';

/**
 * Archiving the UNASSIGNED drivers (owner, 2026-10-02), end to end on the local database:
 *   - the plan finds board rows with no team, and skips a driver on an active load or in a truck;
 *   - archiving takes the row off both boards from this week on (last week keeps it), hides the
 *     driver from GET /drivers (still there with includeArchived), audits both, and is idempotent;
 *   - Restore (POST /drivers/:id/restore) checks the version and brings file and board row back.
 * The drivers this spec makes are archived at the end (never deleted); its load is cancelled.
 */
describe('Driver archive (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let thisWeek = '';
  let lastWeek = '';
  const tag = Date.now().toString(36).toLowerCase();
  const id = (k: string) => `drv_e2e_ar_${k}_${tag}`;
  const plain = id('a');
  const onLoad = id('b');
  const inTruck = id('c');
  const loadId = `load_e2e_ar_${tag}`;
  const actor = { userId: 'e2e', userName: 'E2E', actorType: 'system' as const };

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
  const weekly = async (week: string) => {
    const res = await call('GET', `/api/v1/dispatch/board/weekly?week=${week}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as WeeklyBoard;
  };
  const daily = async (day: string) => {
    const res = await call('GET', `/api/v1/dispatch/board/daily?day=${day}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DailyBoard;
  };
  const mine = (plan: ArchivePlan): ArchivePlan => ({
    ...plan,
    candidates: plan.candidates.filter((c) => [plain, onLoad, inTruck].includes(c.driverId ?? '')),
  });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily('2026-01-01')).today;
    thisWeek = weekStartMonday(today);
    lastWeek = addDays(thisWeek, -7);
    const any = (await call('GET', '/api/v1/drivers?pageSize=1')).json() as RosterPage<DriverRecord>;
    const db = app.get(DatabaseService).db;
    const [row] = await db.select({ companyId: drivers.companyId }).from(drivers).where(eq(drivers.id, any.data[0]!.id));
    companyId = row!.companyId;

    const madeAt = new Date(`${lastWeek}T15:00:00Z`);
    for (const [k, driverId] of [['a', plain], ['b', onLoad], ['c', inTruck]] as const) {
      await db.insert(drivers).values({
        id: driverId,
        companyId,
        driverNumber: `E2E-AR-${k}-${tag}`,
        firstName: 'E2E',
        lastName: `ARCHIVE ${k.toUpperCase()} ${tag}`,
        phone: '5550000000',
        email: `e2e-ar-${k}-${tag}@example.test`,
        driverType: 'company',
        cdlState: 'IL',
        cdlClass: 'A',
        cdlExpiresOn: '2030-01-01',
        cdlStatus: 'missing',
        medicalCardStatus: 'missing',
        hireDate: lastWeek,
        status: 'onboarding',
        dispatcherId: '',
        dispatcherName: '',
        currentTruckId: driverId === inTruck ? `trk_e2e_ar_${tag}` : null,
        homeCity: 'Chicago',
        homeState: 'IL',
        payPlanKind: 'per_mile',
      });
      await db.insert(dispatchRoster).values({ id: driverId, companyId, driverId, name: `E2E ARCHIVE ${k.toUpperCase()} ${tag}`, createdAt: madeAt, updatedAt: madeAt });
      await db.insert(dispatchRosterAssignments).values({ id: `dra_e2e_ar_${k}_${tag}`, companyId, rosterId: driverId, effectiveFrom: lastWeek, dispatcherId: '', dispatcherName: '', by: 'e2e', at: madeAt });
    }
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-AR-${tag}`, status: 'dispatched', driverId: onLoad, record: { id: loadId, stops: [] } });
  });

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    // Test data is never deleted: the load is cancelled, the truck pointer dropped, every driver archived.
    await db.update(loads).set({ status: 'cancelled' }).where(eq(loads.id, loadId));
    await db.update(drivers).set({ currentTruckId: null }).where(eq(drivers.id, inTruck));
    const plan = mine(await planUnassignedArchive(db, companyId, new Date()));
    await db.transaction((tx) => applyUnassignedArchive(tx, plan, actor, new Date(), 'e2e test data'));
    await app.close();
  });

  it('plans the rows with no team, skipping an active load and a truck', async () => {
    expect((await weekly(thisWeek)).rows.some((r) => r.driverId === plain)).toBe(true);
    const plan = mine(await planUnassignedArchive(app.get(DatabaseService).db, companyId, new Date()));
    expect(plan.fromWeek).toBe(thisWeek);
    const by = new Map(plan.candidates.map((c) => [c.driverId, c]));
    expect(by.get(plain)?.skip).toBeNull();
    expect(by.get(onLoad)?.skip).toMatch(/active load E2E-AR-/);
    expect(by.get(inTruck)?.skip).toMatch(/assigned to truck/);
  });

  it('archives: off both boards from this week, last week kept, hidden from /drivers, audited, idempotent', async () => {
    const db = app.get(DatabaseService).db;
    const now = new Date();
    const plan = mine(await planUnassignedArchive(db, companyId, now));
    const first = await db.transaction((tx) => applyUnassignedArchive(tx, plan, actor, now));
    expect(first).toEqual({ rosterRows: 1, drivers: 1 });
    const again = await db.transaction(async (tx) => applyUnassignedArchive(tx, mine(await planUnassignedArchive(tx, companyId, now)), actor, now));
    expect(again).toEqual({ rosterRows: 0, drivers: 0 });

    const [last, current] = await Promise.all([weekly(lastWeek), weekly(thisWeek)]);
    expect(last.rows.some((r) => r.driverId === plain)).toBe(true);
    expect(current.rows.some((r) => r.driverId === plain)).toBe(false);
    expect((await daily(today)).rows.some((r) => r.driverId === plain)).toBe(false);
    expect((await daily(addDays(thisWeek, -1))).rows.some((r) => r.driverId === plain)).toBe(true);
    // The skipped ones stay exactly where they were.
    expect(current.rows.some((r) => r.driverId === onLoad)).toBe(true);

    const hidden = (await call('GET', `/api/v1/drivers?search=${tag}&includeInactive=true`)).json() as RosterPage<DriverRecord>;
    expect(hidden.data.map((d) => d.id).sort()).toEqual([onLoad, inTruck].sort());
    const all = (await call('GET', `/api/v1/drivers?search=${tag}&includeInactive=true&includeArchived=true`)).json() as RosterPage<DriverRecord>;
    const file = all.data.find((d) => d.id === plain)!;
    expect(file.archivedAt).toBeTruthy();
    expect(file.status).toBe('onboarding');

    const [driverAudit] = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, plain), eq(auditLogs.action, 'archive')));
    expect(driverAudit?.entityType).toBe('driver');
    const [rosterAudit] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, plain), eq(dispatchAudit.action, 'unassign')));
    expect(rosterAudit?.after).toContain(thisWeek);
  });

  it('restores through the API with a version check: file and board row come back', async () => {
    const stale = await call('POST', `/api/v1/drivers/${plain}/restore`, { expectedArchivedAt: '2020-01-01T00:00:00.000Z' });
    expect(stale.statusCode, stale.body).toBe(409);
    const all = (await call('GET', `/api/v1/drivers?search=${tag}&includeArchived=true`)).json() as RosterPage<DriverRecord>;
    const archivedAt = all.data.find((d) => d.id === plain)!.archivedAt!;
    const res = await call('POST', `/api/v1/drivers/${plain}/restore`, { expectedArchivedAt: archivedAt });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as DriverRecord).archivedAt).toBeNull();
    expect((await weekly(thisWeek)).rows.some((r) => r.driverId === plain)).toBe(true);
    const [row] = await app.get(DatabaseService).db.select().from(dispatchRoster).where(eq(dispatchRoster.id, plain));
    expect(row?.unassignedFrom).toBeNull();
  });

  it('restoring the board row on the dispatch board brings the driver file back too', async () => {
    const db = app.get(DatabaseService).db;
    const now = new Date();
    await db.transaction(async (tx) => applyUnassignedArchive(tx, mine(await planUnassignedArchive(tx, companyId, now)), actor, now));
    const [row] = await db.select().from(dispatchRoster).where(eq(dispatchRoster.id, plain));
    expect(row?.unassignedReason).toMatch(/^Archived: no dispatcher/);
    const res = await call('POST', `/api/v1/dispatch/roster/${plain}/restore`, { expectedVersion: row!.version });
    expect(res.statusCode, res.body).toBe(201);
    const [file] = await db.select({ archivedAt: drivers.archivedAt }).from(drivers).where(eq(drivers.id, plain));
    expect(file?.archivedAt).toBeNull();
  });
});
