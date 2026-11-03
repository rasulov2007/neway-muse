import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type {
  AssignmentPhotoUpload,
  DriverRecord,
  RosterPage,
  TruckAssignmentView,
  TruckRecord,
} from '@neway/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAudit, dispatchRoster } from '../src/database/schema/dispatch-ops';
import { truckAssignmentPhotos, truckDriverAssignments } from '../src/database/schema/fleet';
import { auditLogs } from '../src/database/schema/people';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import {
  applyAssignmentBackfill,
  planAssignmentBackfill,
} from '../src/modules/roster/assignment-backfill.data';
import { easternToday } from '../src/modules/roster/driver-archive.data';

/**
 * Truck ↔ driver assignments as the single source of truth (0047), end to end on the local DB:
 *   - assigning a driver who is in unit A to unit B closes A's row (ended on the new date,
 *     "Moved to unit B"), clears A's pointer and shows the driver on B, all in one transaction;
 *   - the database refuses a second open row for one truck or one driver;
 *   - two assigns to the same unit at the same moment: one wins, the other is a 409;
 *   - pickup and drop photos are images only (checked by bytes) and are linked to the row;
 *   - Unassign records the chosen drop date, returned items and note; a date before the start or
 *     in the future is a 422;
 *   - Edit changes any field with a version check (409 when stale) and an audit entry;
 *   - the driver page and truck creation write assignment rows too; the dispatch board row
 *     follows; the backfill plans, writes once and then finds nothing.
 * Every truck and driver here is made for the run and left in place (never deleted).
 */
describe('Truck assignments (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId: string;
  const tag = Date.now().toString(36).toUpperCase();
  const today = easternToday(new Date());
  const daysAgo = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  const tomorrow = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + 1);
    return d.toISOString().slice(0, 10);
  })();
  // A 1×1 PNG.
  const PNG =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
    app.inject({
      method,
      url: `/api/v1${url}`,
      headers: { 'content-type': 'application/json' },
      ...(payload ? { payload } : {}),
    });

  const truckIds: Record<string, string> = {};
  const units: Record<string, string> = {};
  const driverIds: Record<string, string> = {};

  async function makeTruck(key: string): Promise<TruckRecord> {
    const unitNumber = `E2E-AS-${key}-${tag}`.slice(0, 20);
    const vin = `1AS${key}${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '3').slice(0, 17);
    const res = await call('POST', '/trucks', {
      unitNumber,
      vin,
      year: 2022,
      make: 'E2E',
      model: 'Assign',
      odometer: 100_000,
      status: 'available',
    });
    expect(res.statusCode, res.body).toBe(201);
    const t = res.json() as TruckRecord;
    truckIds[key] = t.id;
    units[key] = t.unitNumber;
    return t;
  }

  async function makeDriver(key: string): Promise<string> {
    const id = `drv_e2e_as_${key}_${tag}`.toLowerCase();
    await db.insert(drivers).values({
      id,
      companyId,
      driverNumber: `E2E-AS-${key}-${tag}`,
      firstName: 'E2E',
      lastName: `ASSIGN ${key} ${tag}`,
      phone: '5550000000',
      email: `e2e-as-${key}-${tag}@example.test`.toLowerCase(),
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlExpiresOn: '2030-01-01',
      cdlStatus: 'missing',
      medicalCardStatus: 'missing',
      hireDate: daysAgo(60),
      status: 'active',
      dispatcherId: '',
      dispatcherName: '',
      currentTruckId: null,
      homeCity: 'Chicago',
      homeState: 'IL',
      payPlanKind: 'per_mile',
    });
    driverIds[key] = id;
    return id;
  }

  const view = async (truckKey: string) => {
    const res = await call('GET', `/trucks/${truckIds[truckKey]}/assignment`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TruckAssignmentView;
  };
  const pointers = async (truckKey: string, driverKey: string) => {
    const [t] = await db.select().from(trucks).where(eq(trucks.id, truckIds[truckKey]!));
    const [d] = await db.select().from(drivers).where(eq(drivers.id, driverIds[driverKey]!));
    return { truckDriver: t!.currentDriverId, driverTruck: d!.currentTruckId };
  };
  const upload = async (truckKey: string, content = PNG, fileName = 'unit.png') =>
    call('POST', `/trucks/${truckIds[truckKey]}/assignment/photos`, { fileName, content });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const any = (await call('GET', '/drivers?pageSize=1')).json() as RosterPage<DriverRecord>;
    const [row] = await db.select({ companyId: drivers.companyId }).from(drivers).where(eq(drivers.id, any.data[0]!.id));
    companyId = row!.companyId;
    for (const k of ['A', 'B', 'C']) await makeTruck(k);
    for (const k of ['D1', 'D2', 'D3', 'D4']) await makeDriver(k);
    // D1's board row carries a typed truck (unit A) - it must follow the truck page.
    await db.insert(dispatchRoster).values({
      id: `dbr_e2e_as_${tag}`,
      companyId,
      driverId: driverIds.D1!,
      name: `E2E ASSIGN D1 ${tag}`,
      truckUnit: units.A!,
    });
  });

  afterAll(async () => {
    await app.close();
  });

  it('stores photos only when the bytes are an image', async () => {
    const ok = await upload('A');
    expect(ok.statusCode, ok.body).toBe(201);
    const photo = ok.json() as AssignmentPhotoUpload;
    expect(photo.contentType).toBe('image/png');
    const text = await upload('A', `data:image/png;base64,${Buffer.from('not an image at all').toString('base64')}`, 'fake.png');
    expect(text.statusCode).toBe(415);
    const pdf = await upload('A', `data:application/pdf;base64,${Buffer.from('%PDF-1.4 ...').toString('base64')}`, 'doc.pdf');
    expect(pdf.statusCode).toBe(415);
  });

  it('assigns D1 to unit A with pickup photos and a future date is refused', async () => {
    const future = await call('POST', `/trucks/${truckIds.A}/assignment`, {
      driverId: driverIds.D1,
      assignedOn: tomorrow,
    });
    expect(future.statusCode).toBe(422);
    const p1 = (await upload('A')).json() as AssignmentPhotoUpload;
    const p2 = (await upload('A')).json() as AssignmentPhotoUpload;
    const res = await call('POST', `/trucks/${truckIds.A}/assignment`, {
      driverId: driverIds.D1,
      assignedOn: daysAgo(20),
      equipment: [{ item: 'tablet', label: 'Tablet', detail: 'SN-TAB-1', handedOver: true }],
      pickupPhotoIds: [p1.fileId, p2.fileId],
      expectedCurrentId: null,
    });
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json() as TruckAssignmentView;
    expect(v.current?.driverId).toBe(driverIds.D1);
    expect(v.current?.pickupPhotos.map((p) => p.fileId).sort()).toEqual([p1.fileId, p2.fileId].sort());
    expect(await pointers('A', 'D1')).toEqual({ truckDriver: driverIds.D1, driverTruck: truckIds.A });
  });

  it('moving D1 from A to B closes A (ended on the new date), clears A and the board row follows', async () => {
    const before = await view('B');
    const res = await call('POST', `/trucks/${truckIds.B}/assignment`, {
      driverId: driverIds.D1,
      assignedOn: daysAgo(5),
      expectedCurrentId: before.current?.id ?? null,
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as TruckAssignmentView).current?.driverId).toBe(driverIds.D1);

    const a = await view('A');
    expect(a.current).toBeNull();
    expect(a.history).toHaveLength(1);
    expect(a.history[0]!.endedOn).toBe(daysAgo(5));
    expect(a.history[0]!.endReason).toBe(`Moved to unit ${units.B}`);
    const [tA] = await db.select().from(trucks).where(eq(trucks.id, truckIds.A!));
    expect(tA!.currentDriverId).toBeNull();
    expect(await pointers('B', 'D1')).toEqual({ truckDriver: driverIds.D1, driverTruck: truckIds.B });
    const open = await db
      .select()
      .from(truckDriverAssignments)
      .where(and(eq(truckDriverAssignments.driverId, driverIds.D1!), isNull(truckDriverAssignments.endedOn)));
    expect(open).toHaveLength(1);
    // Audit for both units.
    const truckAudits = await db.select().from(auditLogs).where(and(eq(auditLogs.entityType, 'truck'), eq(auditLogs.entityId, truckIds.A!)));
    expect(truckAudits.some((e) => e.summary.includes('out of the unit'))).toBe(true);
    // The board row's typed truck (unit A) no longer contradicts the pairing.
    const [boardRow] = await db.select().from(dispatchRoster).where(eq(dispatchRoster.id, `dbr_e2e_as_${tag}`));
    expect(boardRow!.truckUnit).toBeNull();
    expect(boardRow!.version).toBe(2);
    const boardAudit = await db.select().from(dispatchAudit).where(eq(dispatchAudit.entityId, `dbr_e2e_as_${tag}`));
    expect(boardAudit.some((e) => e.action === 'truck-follows-assignment')).toBe(true);
  });

  it('the database refuses a second open row for one truck or one driver', async () => {
    const base = {
      companyId,
      assignedOn: today,
      equipment: [],
      createdBy: 'e2e',
      createdByName: 'e2e',
    };
    await expect(
      db.insert(truckDriverAssignments).values({ ...base, id: `tda_e2e_dup1_${tag}`, truckId: truckIds.B!, driverId: driverIds.D4! }),
    ).rejects.toThrow();
    await expect(
      db.insert(truckDriverAssignments).values({ ...base, id: `tda_e2e_dup2_${tag}`, truckId: truckIds.C!, driverId: driverIds.D1! }),
    ).rejects.toThrow();
  });

  it('two assigns to the same unit at the same moment: one wins, the other is a 409', async () => {
    const [r1, r2] = await Promise.all([
      call('POST', `/trucks/${truckIds.C}/assignment`, { driverId: driverIds.D2, assignedOn: today, expectedCurrentId: null }),
      call('POST', `/trucks/${truckIds.C}/assignment`, { driverId: driverIds.D3, assignedOn: today, expectedCurrentId: null }),
    ]);
    const codes = [r1.statusCode, r2.statusCode].sort();
    expect(codes).toEqual([201, 409]);
    const open = await db
      .select()
      .from(truckDriverAssignments)
      .where(and(eq(truckDriverAssignments.truckId, truckIds.C!), isNull(truckDriverAssignments.endedOn)));
    expect(open).toHaveLength(1);
  });

  it('Unassign: before the start or in the future is a 422; the chosen date and returned items are saved', async () => {
    const v = await view('B');
    const cur = v.current!;
    const early = await call('POST', `/trucks/${truckIds.B}/assignment/${cur.id}/end`, { version: cur.version, endedOn: daysAgo(30) });
    expect(early.statusCode).toBe(422);
    const future = await call('POST', `/trucks/${truckIds.B}/assignment/${cur.id}/end`, { version: cur.version, endedOn: tomorrow });
    expect(future.statusCode).toBe(422);
    const drop = (await upload('B')).json() as AssignmentPhotoUpload;
    const res = await call('POST', `/trucks/${truckIds.B}/assignment/${cur.id}/end`, {
      version: cur.version,
      endedOn: daysAgo(2),
      returnedEquipment: [
        { item: 'tablet', label: 'Tablet', detail: 'SN-TAB-1', handedOver: true },
        { item: 'keys', label: 'Keys', detail: null, handedOver: false },
      ],
      dropNote: 'Dent on the left door',
      dropPhotoIds: [drop.fileId],
    });
    expect(res.statusCode, res.body).toBe(201);
    const after = res.json() as TruckAssignmentView;
    expect(after.current).toBeNull();
    const closed = after.history.find((h) => h.id === cur.id)!;
    expect(closed.endedOn).toBe(daysAgo(2));
    expect(closed.returnedEquipment).toHaveLength(2);
    expect(closed.returnedEquipment![1]!.handedOver).toBe(false);
    expect(closed.dropNote).toBe('Dent on the left door');
    expect(closed.dropPhotos.map((p) => p.fileId)).toEqual([drop.fileId]);
    expect(closed.endedByName).toBeTruthy();
    expect(await pointers('B', 'D1')).toEqual({ truckDriver: null, driverTruck: null });
    const linked = await db.select().from(truckAssignmentPhotos).where(eq(truckAssignmentPhotos.assignmentId, cur.id));
    expect(linked.map((p) => p.stage).sort()).toEqual(['drop']);
  });

  it('Edit: any field of a closed row, version-checked and audited with before and after', async () => {
    const v = await view('B');
    const row = v.history[0]!;
    const res = await call('PATCH', `/trucks/${truckIds.B}/assignment/${row.id}`, {
      version: row.version,
      assignedOn: daysAgo(6),
      endedOn: daysAgo(1),
      dropNote: 'Dent on the left door, photographed',
      note: 'Edited in e2e',
    });
    expect(res.statusCode, res.body).toBe(200);
    const edited = (res.json() as TruckAssignmentView).history.find((h) => h.id === row.id)!;
    expect(edited.assignedOn).toBe(daysAgo(6));
    expect(edited.endedOn).toBe(daysAgo(1));
    expect(edited.editedByName).toBeTruthy();
    expect(edited.version).toBe(row.version + 1);
    const stale = await call('PATCH', `/trucks/${truckIds.B}/assignment/${row.id}`, { version: row.version, note: 'stale' });
    expect(stale.statusCode).toBe(409);
    const badOrder = await call('PATCH', `/trucks/${truckIds.B}/assignment/${row.id}`, { version: edited.version, endedOn: daysAgo(10) });
    expect(badOrder.statusCode).toBe(422);
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityType, 'truck_driver_assignment'), eq(auditLogs.entityId, row.id)))
      .orderBy(desc(auditLogs.at))
      .limit(1);
    const changes = entry!.changes as { field: string; old: string | null; new: string | null }[];
    expect(changes.find((c) => c.field === 'assignedOn')).toMatchObject({ old: daysAgo(5), new: daysAgo(6) });
    expect(changes.find((c) => c.field === 'endedOn')).toMatchObject({ old: daysAgo(2), new: daysAgo(1) });
  });

  it('Change: replacing the driver records the previous driver drop in the same save', async () => {
    const v = await view('C');
    const cur = v.current!;
    const res = await call('POST', `/trucks/${truckIds.C}/assignment`, {
      driverId: driverIds.D4,
      assignedOn: today,
      expectedCurrentId: cur.id,
      previousDrop: {
        endedOn: today,
        returnedEquipment: [{ item: 'gps', label: 'GPS', detail: 'G-1', handedOver: true }],
        dropNote: 'Swap at the yard',
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const next = res.json() as TruckAssignmentView;
    expect(next.current?.driverId).toBe(driverIds.D4);
    const old = next.history.find((h) => h.id === cur.id)!;
    expect(old.endedOn).toBe(today);
    expect(old.dropNote).toBe('Swap at the yard');
    expect(old.endReason).toMatch(/^Replaced by /);
    // A stale expectation is a 409, not a silent replace.
    const stale = await call('POST', `/trucks/${truckIds.C}/assignment`, { driverId: driverIds.D3, assignedOn: today, expectedCurrentId: cur.id });
    expect(stale.statusCode).toBe(409);
  });

  it('the driver page and truck creation write assignment rows too', async () => {
    const moved = await call('POST', `/drivers/${driverIds.D1}/truck`, { truckId: truckIds.A });
    expect(moved.statusCode, moved.body).toBeLessThan(300);
    const a = await view('A');
    expect(a.current?.driverId).toBe(driverIds.D1);
    expect(a.current?.source).toBe('driver_page');
    const out = await call('POST', `/drivers/${driverIds.D1}/truck`, { truckId: null });
    expect(out.statusCode, out.body).toBeLessThan(300);
    expect((await view('A')).current).toBeNull();

    const d5 = await makeDriver('D5');
    const unitNumber = `E2E-AS-N-${tag}`.slice(0, 20);
    const created = await call('POST', '/trucks', {
      unitNumber,
      vin: `1ASN${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '5').slice(0, 17),
      year: 2023,
      make: 'E2E',
      model: 'Created',
      odometer: 1000,
      status: 'available',
      driverId: d5,
    });
    expect(created.statusCode, created.body).toBe(201);
    const t = created.json() as TruckRecord;
    expect(t.currentDriverId).toBe(d5);
    const res = await call('GET', `/trucks/${t.id}/assignment`);
    const v = res.json() as TruckAssignmentView;
    expect(v.current?.driverId).toBe(d5);
    expect(v.current?.source).toBe('truck_create');
  });

  it('Void: a closed test entry leaves the history but stays in the table, audited; an open row cannot be voided', async () => {
    const v = await view('B');
    if (v.current) {
      const open = await call('POST', `/trucks/${truckIds.B}/assignment/${v.current.id}/void`, {
        version: v.current.version,
        reason: 'test entry',
      });
      expect(open.statusCode, open.body).toBe(422);
    }
    const row = v.history[0]!;
    expect(
      (await call('POST', `/trucks/${truckIds.B}/assignment/${row.id}/void`, { version: row.version, reason: 'x' })).statusCode,
    ).toBe(422);
    const stale = await call('POST', `/trucks/${truckIds.B}/assignment/${row.id}/void`, {
      version: row.version - 1,
      reason: 'test entry',
    });
    expect(stale.statusCode).toBe(409);
    const res = await call('POST', `/trucks/${truckIds.B}/assignment/${row.id}/void`, {
      version: row.version,
      reason: 'Entered while testing the assign dialog',
    });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as TruckAssignmentView).history.some((h) => h.id === row.id)).toBe(false);
    const [kept] = await db.select().from(truckDriverAssignments).where(eq(truckDriverAssignments.id, row.id));
    expect(kept).toMatchObject({ source: 'voided' });
    const [entry] = await db
      .select()
      .from(auditLogs)
      .where(and(eq(auditLogs.entityId, row.id), eq(auditLogs.action, 'void')));
    expect(entry?.reason).toBe('Entered while testing the assign dialog');
  });

  it('backfill: plans pointer-only pairs, writes approximate rows once, then finds nothing', async () => {
    const co = `co_e2e_bf_${tag}`.toLowerCase();
    await db.insert(companies).values({ id: co, name: `E2E backfill ${tag}` });
    const now = new Date();
    const truck = (id: string, unit: string, driverId: string | null) => ({
      id,
      companyId: co,
      unitNumber: unit,
      vin: `BF${unit}${tag}`.padEnd(17, '0').slice(0, 17),
      year: 2022,
      make: 'Test',
      model: 'Backfill',
      plate: '',
      plateState: '',
      color: '',
      status: 'available',
      health: 'healthy',
      ownership: 'owned',
      odometer: 1,
      odometerAt: now,
      engineHours: '0',
      inServiceDate: '2026-01-01',
      currentDriverId: driverId,
      currentTrailerId: null,
      currentLoadId: null,
      location: null,
      nextServiceOdometer: 10,
      nextServiceDate: '2026-12-01',
      nextServiceType: 'oil_change',
      telematicsProvider: 'none',
      telematicsStatus: 'not_connected',
      mpg30d: '0',
      mpg90d: '0',
      idlePercent30d: '0',
      idlePercent90d: '0',
      homeTerminal: '',
    });
    const driver = (id: string, truckId: string | null, createdAt: Date) => ({
      id,
      companyId: co,
      driverNumber: id,
      firstName: 'BF',
      lastName: id,
      phone: '5550000000',
      email: `${id}@example.test`,
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlExpiresOn: '2030-01-01',
      cdlStatus: 'missing',
      medicalCardStatus: 'missing',
      hireDate: '2026-01-01',
      status: 'active',
      dispatcherId: '',
      dispatcherName: '',
      currentTruckId: truckId,
      homeCity: 'X',
      homeState: 'IL',
      payPlanKind: 'per_mile',
      createdAt,
    });
    await db.insert(trucks).values([
      truck(`trk_bf1_${tag}`, 'BF1', `drv_bf1_${tag}`),
      truck(`trk_bf2_${tag}`, 'BF2', `drv_bf2_${tag}`),
      truck(`trk_bf3_${tag}`, 'BF3', `drv_bf3_${tag}`), // pointers disagree
    ]);
    await db.insert(drivers).values([
      driver(`drv_bf1_${tag}`, `trk_bf1_${tag}`, new Date('2026-02-01T15:00:00Z')),
      driver(`drv_bf2_${tag}`, `trk_bf2_${tag}`, new Date('2026-03-01T15:00:00Z')),
      driver(`drv_bf3_${tag}`, null, new Date('2026-03-01T15:00:00Z')),
    ]);
    // BF1's driver has an "Assigned to unit BF1" entry: that day is the approximate start.
    await db.insert(auditLogs).values({
      id: `aud_e2e_bf_${tag}`,
      companyId: co,
      actorId: 'e2e',
      actorName: 'e2e',
      action: 'update',
      entityType: 'driver',
      entityId: `drv_bf1_${tag}`,
      entityLabel: 'BF1 driver',
      summary: 'Assigned to unit BF1 (was unit X)',
      changes: [],
      at: new Date('2026-04-10T16:00:00Z'),
    });

    const plan = await planAssignmentBackfill(db, co, now);
    expect(plan.pointed).toBe(3);
    const byUnit = new Map(plan.candidates.map((c) => [c.unitNumber, c]));
    expect(byUnit.get('BF1')).toMatchObject({ assignedOn: '2026-04-10', basis: 'audit', skip: null });
    // The later of the driver's (2026-03-01) and the truck's (now) created date.
    expect(byUnit.get('BF2')).toMatchObject({ assignedOn: today, basis: 'created', skip: null });
    expect(byUnit.get('BF3')!.skip).toMatch(/pointers disagree/);

    const written = await db.transaction((tx) => applyAssignmentBackfill(tx, plan, now));
    expect(written).toBe(2);
    const rows = await db.select().from(truckDriverAssignments).where(eq(truckDriverAssignments.companyId, co));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.assignedOnApproximate && r.source === 'backfill' && r.endedOn === null)).toBe(true);

    const again = await planAssignmentBackfill(db, co, now);
    expect(again.alreadyBacked).toBe(2);
    expect(again.candidates.filter((c) => !c.skip)).toHaveLength(0);
    expect(await db.transaction((tx) => applyAssignmentBackfill(tx, again, now))).toBe(0);
  });
});
