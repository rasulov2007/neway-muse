import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { weekStartMonday, type DailyBoard, type DriverRecord, type RosterRow } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { dispatchAudit, dispatchRoster } from '../src/database/schema/dispatch-ops';
import { drivers } from '../src/database/schema/roster';

const BASE = '/api/v1';

/**
 * "Can't add a load to Xavier Sutton, but he is on the board" (owner, 2026-10-26). The board's
 * quick "Create new driver" makes a row with no driver file; creating the driver file links that
 * row - by the row id the form sends, or by the one active unlinked row with the same name - and
 * never a row already linked or one of two rows with one name. End to end on the local database.
 * Driver files this spec adds stay on the local roster (never hard-deleted); its board rows are
 * removed from the board at the end.
 */
describe('Driver file links its board-only row (e2e)', () => {
  let app: NestFastifyApplication;
  let thisWeek = '';
  const tag = Date.now().toString(36).toUpperCase();
  const low = tag.toLowerCase();
  const made: string[] = [];
  const TEAM = { dispatcherId: 'e2e_bl_team', dispatcherName: 'E2E BL TEAM' };

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload: payload as object } : {}) });
  const db = () => app.get(DatabaseService).db;
  const boardRow = async (name: string) => {
    const res = await call('POST', `${BASE}/dispatch/roster`, { name, phone: '`3125550188', truckUnit: '0777', ...TEAM });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as RosterRow;
    made.push(row.id);
    return row;
  };
  const stored = async (id: string) => (await db().select().from(dispatchRoster).where(eq(dispatchRoster.id, id)))[0]!;
  const driverBody = (label: string, first: string, last: string, over: Record<string, unknown> = {}) => ({
    firstName: first,
    lastName: last,
    phone: '3125550188',
    email: `bl.${label}.${low}@example.com`,
    driverType: 'company',
    cdlState: 'TN',
    cdlClass: 'A',
    cdlEndorsements: [],
    cdlExpiresOn: '2030-05-14',
    hireDate: '2026-10-26',
    homeCity: 'Memphis',
    homeState: 'TN',
    payPlan: { kind: 'per_mile', rate: 0.6 },
    preferredLanguage: 'en',
    ...over,
  });
  const linkAudits = async (rowId: string) =>
    db().select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, rowId), eq(dispatchAudit.action, 'link-on-create')));

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringSeedService).seedOnboardingTemplates();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    thisWeek = weekStartMonday(((await call('GET', `${BASE}/dispatch/board/daily?day=2026-01-01`)).json() as DailyBoard).today);
  });

  afterAll(async () => {
    const rows = (await call('GET', `${BASE}/dispatch/roster`)).json() as RosterRow[];
    for (const id of made) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.unassignedAt)
        await call('POST', `${BASE}/dispatch/roster/${id}/remove-from-board`, { reason: 'e2e test row', fromWeek: thisWeek, expectedVersion: row.version });
    }
    await app?.close();
  });

  it('links the board row the form names: same row id, driver set, version bumped, truck kept, audited', async () => {
    const row = await boardRow(`XAVIER SUTTON ${tag}`);
    expect(row.driverId).toBeNull();
    const res = await call('POST', `${BASE}/drivers`, driverBody('explicit', 'Xavier', `Different${tag}`, { boardRowId: row.id }));
    expect(res.statusCode, res.body).toBe(201);
    const driver = res.json() as DriverRecord;

    const after = await stored(row.id);
    expect(after.driverId).toBe(driver.id);
    expect(after.version).toBe(row.version + 1);
    expect(after.truckUnit).toBe('0777');
    // The truck is not paired by the link: that stays with Assign.
    expect((await db().select({ t: drivers.currentTruckId }).from(drivers).where(eq(drivers.id, driver.id)))[0]!.t).toBeNull();
    const audits = await linkAudits(row.id);
    expect(audits).toHaveLength(1);
    expect(JSON.parse(audits[0]!.after!)).toEqual({ driverId: driver.id });
    expect(audits[0]!.companyId).toBe(after.companyId);

    // The board makes no second row for the new file.
    const rows = (await call('GET', `${BASE}/dispatch/roster`)).json() as RosterRow[];
    expect(rows.filter((r) => r.driverId === driver.id).map((r) => r.id)).toEqual([row.id]);
  });

  it('links the one active unlinked row with the same name when no row id is sent', async () => {
    const row = await boardRow(`UNIQ${tag} SUTTON`);
    const res = await call('POST', `${BASE}/drivers`, driverBody('byname', `Uniq${tag}`, 'Sutton'));
    expect(res.statusCode, res.body).toBe(201);
    const driver = res.json() as DriverRecord;
    expect((await stored(row.id)).driverId).toBe(driver.id);
    expect(await linkAudits(row.id)).toHaveLength(1);
  });

  it('links nothing when two rows carry the name', async () => {
    const a = await boardRow(`TWIN${tag} SUTTON`);
    const b = await boardRow(`TWIN${tag} SUTTON`);
    const res = await call('POST', `${BASE}/drivers`, driverBody('twin', `Twin${tag}`, 'Sutton'));
    expect(res.statusCode, res.body).toBe(201);
    expect((await stored(a.id)).driverId).toBeNull();
    expect((await stored(b.id)).driverId).toBeNull();
    expect(await linkAudits(a.id)).toHaveLength(0);
    expect(await linkAudits(b.id)).toHaveLength(0);
  });

  it('refuses a row id that is already linked, and makes no driver file', async () => {
    const row = await boardRow(`TAKEN ${tag}`);
    const first = await call('POST', `${BASE}/drivers`, driverBody('taken1', 'Taken', `One${tag}`, { boardRowId: row.id }));
    expect(first.statusCode, first.body).toBe(201);
    const again = await call('POST', `${BASE}/drivers`, driverBody('taken2', 'Taken', `Two${tag}`, { boardRowId: row.id }));
    expect(again.statusCode, again.body).toBe(409);
    expect((await stored(row.id)).driverId).toBe((first.json() as DriverRecord).id);
    const second = await db().select({ n: sql<number>`count(*)::int` }).from(drivers).where(eq(drivers.email, `bl.taken2.${low}@example.com`));
    expect(second[0]!.n).toBe(0);
    expect(await linkAudits(row.id)).toHaveLength(1);
  });

  it('does not link an already linked row that shares the name', async () => {
    const row = await boardRow(`LINKED${tag} SUTTON`);
    const first = await call('POST', `${BASE}/drivers`, driverBody('linked1', `Linked${tag}`, 'Sutton'));
    expect(first.statusCode, first.body).toBe(201);
    const firstId = (first.json() as DriverRecord).id;
    expect((await stored(row.id)).driverId).toBe(firstId);
    const second = await call('POST', `${BASE}/drivers`, driverBody('linked2', `Linked${tag}`, 'Sutton'));
    expect(second.statusCode, second.body).toBe(201);
    expect((await stored(row.id)).driverId).toBe(firstId);
    expect(await linkAudits(row.id)).toHaveLength(1);
  });

  it('refuses a row id from no board row with 404', async () => {
    const res = await call('POST', `${BASE}/drivers`, driverBody('missing', 'Nobody', `Here${tag}`, { boardRowId: `dbr_missing_${low}` }));
    expect(res.statusCode, res.body).toBe(404);
  });
});
