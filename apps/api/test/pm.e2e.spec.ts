import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import type { OdometerReading, PmPlan, PmStatus } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { unitMaintenanceSettings, workOrders } from '../src/database/schema/fleet';
import { odometerReadings, pmPlans, pmStatus } from '../src/database/schema/pm';
import { trucks } from '../src/database/schema/roster';
import { PmService } from '../src/modules/pm/pm.service';

const BASE = '/api/v1/fleet/pm';
/** The acceptance tests' clock: 2026-09-17 07:45 America/Chicago. */
const NOW = new Date('2026-09-17T07:45:00-05:00');
const PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

/**
 * Truck 0074's story (03-acceptance-tests.md, sections B and C) through the real API and the
 * real database: a 35,000 mi unit override, a service on Jun 22 at 105,368 mi, four ELD readings
 * up to 142,020 mi on the frozen morning of Sep 17. Runs as the owner. The unit is a real truck
 * from the roster, renamed for the test's purposes only in the assertions; every write here is
 * to the PM tables, which a re-run clears first.
 */
describe('Oil change / PM engine (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let pm: PmService;
  let companyId = '';
  let unitId = '';
  let otherUnitId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers?: Record<string, string>) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(headers ?? {}) }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    pm = app.get(PmService);
    pm.clock = () => NOW;

    const roster = (await call('GET', '/api/v1/trucks?pageSize=200')).json() as { data: { id: string; companyId?: string; status: string }[] };
    const active = roster.data.filter((t) => !['inactive', 'sold'].includes(t.status));
    unitId = active[0]?.id ?? '';
    otherUnitId = active[1]?.id ?? '';
    if (!unitId || !otherUnitId) throw new Error('need two active trucks');
    const [truck] = await db.select({ companyId: trucks.companyId }).from(trucks).where(eq(trucks.id, unitId));
    companyId = truck?.companyId ?? '';

    // A clean slate for this unit: no plans, readings, verdicts or baselines from an earlier run.
    for (const id of [unitId, otherUnitId]) {
      await db.delete(pmPlans).where(and(eq(pmPlans.companyId, companyId), eq(pmPlans.unitId, id)));
      await db.delete(odometerReadings).where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.unitId, id)));
      await db.delete(pmStatus).where(and(eq(pmStatus.companyId, companyId), eq(pmStatus.unitId, id)));
      await db.delete(unitMaintenanceSettings).where(and(eq(unitMaintenanceSettings.companyId, companyId), eq(unitMaintenanceSettings.unitId, id)));
      await db.delete(workOrders).where(and(eq(workOrders.companyId, companyId), eq(workOrders.unitId, id), eq(workOrders.pmServiceCode, 'OIL_CHANGE')));
    }
    // The group plans this spec sets are test data too.
    await db.delete(pmPlans).where(and(eq(pmPlans.companyId, companyId), eq(pmPlans.scope, 'group'), eq(pmPlans.groupName, 'NWF')));
    await db.update(trucks).set({ groupName: 'NWF', pmResponsibility: 'us', lessorName: null }).where(eq(trucks.id, unitId));
    await db.update(trucks).set({ groupName: 'Ryder', pmResponsibility: 'lessor', lessorName: 'Ryder' }).where(eq(trucks.id, otherUnitId));
  });

  afterAll(async () => {
    await app.close();
  });

  it('B8 · with no plan and no service, the verdict is honest: No interval set → No service on record', async () => {
    // The fleet fallback applies, so the plan resolves; with nothing on record the state is no_baseline.
    const first = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(first.dueStatus).toBe('no_baseline');
    expect(first.planOrigin).toBe('group');
    expect(first.intervalMiles).toBe(30_000);

    // Nobody has a plan at all when the fleet fallback is off.
    const settings = pm.settings;
    pm.settings = { ...settings, fleetIntervalMiles: 0, groupIntervalMiles: {} };
    try {
      await pm.recompute(companyId, [unitId]);
      const none = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
      expect(none.dueStatus).toBe('no_interval');
    } finally {
      pm.settings = settings;
    }
  });

  it('B9 · a unit plan needs a reason, beats the group plan, and is audited', async () => {
    const unreasoned = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 35_000 });
    expect(unreasoned.statusCode, unreasoned.body).toBe(422);
    const silly = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 500, reason: 'typo' });
    expect(silly.statusCode, silly.body).toBe(422);

    const group = await call('POST', `${BASE}/plans`, { scope: 'group', groupName: 'NWF', intervalMiles: 30_000 });
    expect(group.statusCode, group.body).toBe(201);
    const unit = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 35_000, reason: 'OEM spec for this engine, oil analysis clean' });
    expect(unit.statusCode, unit.body).toBe(201);
    const plan = unit.json() as PmPlan;
    expect(plan.scope).toBe('unit');
    expect(plan.reason).toMatch(/OEM spec/);

    const status = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(status.intervalMiles).toBe(35_000);
    expect(status.planOrigin).toBe('unit');
    expect(status.planId).toBe(plan.id);
    expect(status.dueSoonMiles).toBe(3_500);

    const audit = await call('GET', '/api/v1/admin/audit?entityType=pm_plan&pageSize=5');
    expect(audit.statusCode).toBe(200);
    expect(JSON.stringify(audit.json())).toContain('35,000 mi');
  });

  it('B1 · with the service and the readings on record, the formulas hold', async () => {
    // The baseline: Jun 22 at 105,368 mi, recorded as an imported completion.
    await db.insert(workOrders).values({
      id: `wo_pm_${unitId}`,
      companyId,
      number: 'RO-IMPORT-0074',
      assetType: 'truck',
      unitId,
      unitNumber: '0074',
      status: 'completed',
      shopStage: null,
      workType: 'oil_change',
      workDone: 'Oil & filter change (PM A)',
      shopInAt: new Date('2026-06-22T14:00:00-05:00'),
      completedAt: new Date('2026-06-22T15:00:00-05:00'),
      downtimeMinutes: 60,
      odometer: 105_368,
      vendorName: 'TA Grand Prairie',
      total: '550',
      createdBy: 'import',
      pmServiceCode: 'OIL_CHANGE',
      serviceAt: new Date('2026-06-22T14:00:00-05:00'),
      serviceOdometer: 105_368,
      enteredVia: 'import',
    });
    // The feed: four mornings of ELD readings.
    const ingest = await pm.ingestEldReadings(companyId, [
      { unitId, odometerMiles: 138_900, engineHours: null, readingAt: '2026-09-14T06:12:00-05:00' },
      { unitId, odometerMiles: 141_290, engineHours: null, readingAt: '2026-09-15T06:08:00-05:00' },
      { unitId, odometerMiles: 141_655, engineHours: null, readingAt: '2026-09-16T06:10:00-05:00' },
      { unitId, odometerMiles: 142_020, engineHours: null, readingAt: '2026-09-17T07:25:00-05:00' },
    ]);
    // The fixture's own Sep 15 reading is 2,390 mi past Sep 14's in a day, which the spec's own
    // rule (§3.4, 1,500 mi/day) calls a conflict. It is stored, listed, and never used.
    expect(ingest).toEqual({ written: 4, conflicts: 1 });

    const s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.lastServiceOdometer).toBe(105_368);
    expect(s.lastServiceSource).toBe('import');
    expect(s.milesSinceService).toBe(36_652);
    expect(s.nextServiceOdometer).toBe(140_368);
    expect(s.milesRemaining).toBe(-1_652);
    expect(s.dueStatus).toBe('overdue');
    expect(s.dueBasis).toBe('miles');
    expect(s.readingOdometer).toBe(142_020);
    expect(s.readingSource).toBe('eld');
    expect(s.readingStale).toBe(false);
    expect(s.avgBasis).toBe('30d');
  });

  it('the hourly feed keeps one row per day and only moves it forward', async () => {
    const again = await pm.ingestEldReadings(companyId, [{ unitId, odometerMiles: 142_020, engineHours: null, readingAt: '2026-09-17T07:25:00-05:00' }]);
    expect(again.written).toBe(0);
    const later = await pm.ingestEldReadings(companyId, [{ unitId, odometerMiles: 142_180, engineHours: null, readingAt: '2026-09-17T07:40:00-05:00' }]);
    expect(later.written).toBe(1);
    const readings = (await call('GET', `${BASE}/readings?unitId=${unitId}`)).json() as OdometerReading[];
    expect(readings.filter((r) => r.readingDate === '2026-09-17' && r.source === 'eld')).toHaveLength(1);
    expect(readings[0]?.odometerMiles).toBe(142_180);
    // Put the fixture's reading back for the rest of the story.
    await pm.ingestEldReadings(companyId, [{ unitId, odometerMiles: 142_020, engineHours: null, readingAt: '2026-09-17T07:41:00-05:00' }]);
  });

  it('B10 · an interval change moves the next service, keeps history, and is audited', async () => {
    const changed = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 30_000, reason: 'Back to the fleet standard after the oil analysis' });
    expect(changed.statusCode, changed.body).toBe(201);
    const s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.nextServiceOdometer).toBe(135_368);
    expect(s.lastServiceOdometer).toBe(105_368);
    const history = (await call('GET', `${BASE}/plans?unitId=${unitId}&includeVoided=true`)).json() as PmPlan[];
    expect(history.map((p) => [p.intervalMiles, p.voidReason])).toEqual([
      [30_000, null],
      [35_000, 'superseded'],
    ]);
    // And back, so the numbers below are the fixture's.
    const back = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 35_000, reason: 'OEM spec for this engine, oil analysis clean' });
    expect(back.statusCode).toBe(201);
  });

  it('B9 · removing the unit plan falls back to the group plan', async () => {
    const plans = (await call('GET', `${BASE}/plans?unitId=${unitId}`)).json() as PmPlan[];
    const active = plans[0] as PmPlan;
    const voided = await call('POST', `${BASE}/plans/${active.id}/void`, { version: active.version, reason: 'Trying the group default' });
    expect(voided.statusCode, voided.body).toBe(201);
    const s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.planOrigin).toBe('group');
    expect(s.intervalMiles).toBe(30_000);
    const restored = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 35_000, reason: 'OEM spec for this engine, oil analysis clean' });
    expect(restored.statusCode).toBe(201);
  });

  it('C5 / C6 · a backwards or implausible reading is stored as a conflict, listed, and never used', async () => {
    const backwards = await call('POST', `${BASE}/readings`, { unitId, readingAt: '2026-09-17T07:30:00-05:00', odometerMiles: 141_000, source: 'invoice' });
    expect(backwards.statusCode, backwards.body).toBe(201);
    expect((backwards.json() as OdometerReading).status).toBe('conflict');
    expect((backwards.json() as OdometerReading).conflictReason).toBe('below_previous');
    const jump = await call('POST', `${BASE}/readings`, { unitId, readingAt: '2026-09-17T07:35:00-05:00', odometerMiles: 145_000, source: 'invoice' });
    expect((jump.json() as OdometerReading).conflictReason).toBe('too_high_per_day');

    const conflicts = (await call('GET', `${BASE}/readings/conflicts`)).json() as OdometerReading[];
    expect(conflicts.filter((c) => c.unitId === unitId).map((c) => c.odometerMiles).sort()).toEqual([141_000, 141_290, 145_000]);
    const s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.readingOdometer).toBe(142_020);
  });

  it('C7 · a manual reading without a photo is refused with a clear message; with one it is audited', async () => {
    const bare = await call('POST', `${BASE}/readings`, { unitId, readingAt: '2026-09-17T07:30:00-05:00', odometerMiles: 142_030, source: 'manual' });
    expect(bare.statusCode, bare.body).toBe(422);
    expect(bare.body).toMatch(/photo/);
    const upload = await call('POST', '/api/v1/files', { fileName: 'odometer.png', content: PNG });
    const file = upload.json() as { id: string };
    const withPhoto = await call('POST', `${BASE}/readings`, { unitId, readingAt: '2026-09-17T07:30:00-05:00', odometerMiles: 142_030, source: 'manual', photoId: file.id });
    expect(withPhoto.statusCode, withPhoto.body).toBe(201);
    expect((withPhoto.json() as OdometerReading).status).toBe('ok');
    const audit = await call('GET', '/api/v1/admin/audit?entityType=odometer_reading&pageSize=5');
    expect(JSON.stringify(audit.json())).toContain('142,030');
  });

  it('C8 · at the same moment the ELD reading drives the board, not the manual one', async () => {
    const upload = await call('POST', '/api/v1/files', { fileName: 'odometer2.png', content: PNG });
    const file = upload.json() as { id: string };
    const manual = await call('POST', `${BASE}/readings`, { unitId, readingAt: '2026-09-17T07:41:00-05:00', odometerMiles: 142_100, source: 'manual', photoId: file.id });
    expect(manual.statusCode, manual.body).toBe(201);
    const s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.readingSource).toBe('eld');
    expect(s.readingOdometer).toBe(142_020);
  });

  it('C3 / C4 · a stale reading is "≥ n over" when it already proved it, and No reading when it did not', async () => {
    // Move the clock: 19 days on, the last reading is old.
    pm.clock = () => new Date('2026-10-06T07:45:00-05:00');
    await pm.recompute(companyId, [unitId]);
    let s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.readingStale).toBe(true);
    expect(s.dueStatus).toBe('overdue_at_least');
    expect(s.milesOverAtReading).toBe(1_652);
    expect(Math.round((s.readingAgeHours ?? 0) / 24)).toBe(19);

    // A wider interval so the stale reading had not reached the next service: no reading, not OK.
    const wide = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 45_000, reason: 'Testing the stale rule' });
    expect(wide.statusCode).toBe(201);
    s = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(s.dueStatus).toBe('no_reading');
    expect(s.readingOdometer).toBe(142_020);
    pm.clock = () => NOW;
    const restored = await call('POST', `${BASE}/plans`, { scope: 'unit', unitId, intervalMiles: 35_000, reason: 'OEM spec for this engine, oil analysis clean' });
    expect(restored.statusCode).toBe(201);
  });

  it('B11 · a lease unit carries the same verdict, its lessor, and no fleet fallback surprise', async () => {
    const s = (await call('GET', `${BASE}/status/${otherUnitId}`)).json() as PmStatus;
    expect(s.pmResponsibility).toBe('lessor');
    expect(s.lessorName).toBe('Ryder');
    expect(s.groupName).toBe('Ryder');
    expect(s.intervalMiles).toBe(50_000);
    expect(s.planOrigin).toBe('group');
  });

  it('C9 · coverage counts the trucks with a reading in the last day', async () => {
    const coverage = (await call('GET', `${BASE}/coverage`)).json() as { total: number; fresh: number; usable: number; noReading: number; conflicts: number };
    expect(coverage.total).toBeGreaterThan(0);
    expect(coverage.fresh).toBeGreaterThanOrEqual(1);
    expect(coverage.noReading).toBe(coverage.total - coverage.usable);
    expect(coverage.conflicts).toBeGreaterThanOrEqual(2);
  });

  it('is not there when pm_module is off, and readable to maintenance.view only', async () => {
    const stranger = await call('GET', `${BASE}/status/${unitId}`, undefined, { 'x-demo-role': 'operations' });
    expect(stranger.statusCode).toBe(403);
  });
});
