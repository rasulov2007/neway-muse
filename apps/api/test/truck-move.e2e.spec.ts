import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabaseClient } from '../src/database/client';
import { trailers, truckDriverAssignments } from '../src/database/schema/fleet';
import { auditLogs } from '../src/database/schema/people';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import { moveTruck } from '../src/modules/roster/truck-move.data';

/**
 * move-truck against the local database: two throwaway companies (left deactivated afterwards,
 * never deleted), a truck with a driver assignment and a hooked trailer in the first.
 */
describe('move-truck (e2e)', () => {
  const { db, sql } = createDatabaseClient(process.env.DATABASE_URL ?? 'postgres://neway:neway@localhost:5432/neway');
  const run = Date.now().toString(36);
  const FROM = `co_mvfrom_${run}`;
  const TO = `co_mvto_${run}`;
  const SRC = `trk_mv_${run}`;
  const NEW = `trk_mvnew_${run}`;
  const DRV = `drv_mv_${run}`;
  const TRL = `trl_mv_${run}`;
  const VIN = `1FUJHHDR0PL${run.toUpperCase().padStart(6, '0').slice(-6)}`;
  const actor = { userId: 'system:move-truck', userName: 'Move truck (test)' };
  const odometerAt = new Date('2026-10-20T15:00:00Z');

  beforeAll(async () => {
    await db.insert(companies).values([
      { id: FROM, name: 'Move From Test' },
      { id: TO, name: 'Move To Test' },
    ]);
    await db.insert(drivers).values({
      id: DRV,
      companyId: FROM,
      driverNumber: `MV${run}`,
      firstName: 'Michelin',
      lastName: 'Georges',
      phone: '5550000000',
      email: `mv${run}@example.test`,
      driverType: 'company',
      cdlState: 'PA',
      cdlClass: 'A',
      cdlExpiresOn: '2030-01-01',
      cdlStatus: 'valid',
      medicalCardStatus: 'valid',
      hireDate: '2026-01-01',
      status: 'active',
      dispatcherId: 'x',
      dispatcherName: 'x',
      currentTruckId: SRC,
      homeCity: 'Philadelphia',
      homeState: 'PA',
      payPlanKind: 'per_mile',
    });
    await db.insert(trucks).values({
      id: SRC,
      companyId: FROM,
      unitNumber: '0016',
      vin: VIN,
      year: 2023,
      make: 'Freightliner',
      model: 'Cascadia',
      plate: 'AB1234',
      plateState: 'PA',
      color: 'White',
      status: 'in_use',
      health: 'healthy',
      ownership: 'owned',
      odometer: 412_345,
      odometerAt,
      engineHours: '8120.5',
      inServiceDate: '2023-05-01',
      currentDriverId: DRV,
      currentTrailerId: TRL,
      currentLoadId: null,
      location: { lat: 40, lng: -75 },
      nextServiceOdometer: 425_000,
      nextServiceDate: '2026-12-01',
      nextServiceType: 'pm_service',
      telematicsProvider: 'samsara',
      telematicsStatus: 'connected',
      telematicsAccountId: 'int_samsara_x',
      telematicsExternalId: 's-0016',
      homeTerminal: 'Yard A',
    });
    await db.insert(trailers).values({ id: TRL, companyId: FROM, unitNumber: `T${run}`, currentTruckId: SRC });
    await db.insert(truckDriverAssignments).values({ id: `tda_mv_${run}`, companyId: FROM, truckId: SRC, driverId: DRV, assignedOn: '2026-09-01' });
  });

  afterAll(async () => {
    await db.update(companies).set({ deactivatedAt: new Date() }).where(eq(companies.id, FROM));
    await db.update(companies).set({ deactivatedAt: new Date() }).where(eq(companies.id, TO));
    await sql.end({ timeout: 5 });
  });

  const opts = (confirm: boolean) => ({ fromCompanyId: FROM, toCompanyId: TO, unit: '0016', confirm, now: new Date(), actor, newTruckId: () => NEW });

  it('dry run writes nothing; confirm moves; a second run is "already moved"', async () => {
    const dry = await moveTruck(db, opts(false));
    expect(dry.outcome, dry.lines.join('\n')).toBe('planned');
    expect(dry.endAssignments).toHaveLength(1);
    expect(await db.select().from(trucks).where(eq(trucks.id, NEW))).toHaveLength(0);
    const [still] = await db.select().from(trucks).where(eq(trucks.id, SRC));
    expect(still!.status).toBe('in_use');

    const applied = await moveTruck(db, opts(true));
    expect(applied.outcome, applied.lines.join('\n')).toBe('applied');

    const [created] = await db.select().from(trucks).where(eq(trucks.id, NEW));
    expect(created).toMatchObject({
      companyId: TO,
      unitNumber: '0016',
      vin: VIN,
      year: 2023,
      make: 'Freightliner',
      model: 'Cascadia',
      plate: 'AB1234',
      odometer: 412_345,
      engineHours: '8120.5',
      status: 'available',
      currentDriverId: null,
      currentTrailerId: null,
      location: null,
      telematicsProvider: 'Unassigned',
      telematicsAccountId: null,
      telematicsExternalId: null,
      homeTerminal: null,
    });
    expect(created!.odometerAt.getTime()).toBe(odometerAt.getTime());

    const [archived] = await db.select().from(trucks).where(eq(trucks.id, SRC));
    expect(archived).toMatchObject({ companyId: FROM, status: 'archived', currentDriverId: null, currentTrailerId: null, odometer: 412_345 });
    const [assignment] = await db.select().from(truckDriverAssignments).where(eq(truckDriverAssignments.truckId, SRC));
    expect(assignment!.endedOn).not.toBeNull();
    expect(assignment!.endReason).toBe('Moved to Move To Test (owner, 2026-10-21)');
    const [driver] = await db.select().from(drivers).where(eq(drivers.id, DRV));
    expect(driver!.currentTruckId).toBeNull();
    const [trailer] = await db.select().from(trailers).where(eq(trailers.id, TRL));
    expect(trailer!.currentTruckId).toBeNull();

    const fromAudit = await db.select().from(auditLogs).where(eq(auditLogs.companyId, FROM));
    expect(fromAudit.find((a) => a.action === 'archive' && a.entityId === SRC)?.reason).toBe('Moved to Move To Test (owner, 2026-10-21)');
    expect(fromAudit.some((a) => a.entityType === 'truck_driver_assignment')).toBe(true);
    const toAudit = await db.select().from(auditLogs).where(and(eq(auditLogs.companyId, TO), eq(auditLogs.entityId, NEW)));
    expect(toAudit).toHaveLength(1);
    expect(toAudit[0]!.action).toBe('create');

    const again = await moveTruck(db, opts(true));
    expect(again.outcome).toBe('already_moved');
    expect(again.newTruckId).toBe(NEW);
  });

  it('refuses, writing nothing, when the destination already has the unit number', async () => {
    const res = await moveTruck(db, { ...opts(true), fromCompanyId: TO, toCompanyId: FROM });
    // FROM still holds the archived 0016, so the reverse move is refused rather than duplicating it.
    expect(res.outcome).toBe('refused');
    expect(res.refusals.join(' ')).toMatch(/archived truck with unit number 0016 and VIN/);
  });
});
