import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, inArray } from 'drizzle-orm';
import type { PmStatus } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { vendors, workOrderLines, workOrders } from '../src/database/schema/fleet';
import { odometerReadings, pmPlans, pmStatus } from '../src/database/schema/pm';
import { trucks } from '../src/database/schema/roster';
import { PmImportService } from '../src/modules/pm/import/pm-import.service';
import { reportMarkdown } from '../src/modules/pm/import/report';
import { readSheet, type SheetRow } from '../src/modules/pm/import/sheet';
import { PmService } from '../src/modules/pm/pm.service';

const FIXTURE = join(__dirname, 'fixtures', 'pm-board-slice.csv');
const NOW = new Date('2026-09-17T07:45:00-05:00');
const EXPORTED_AT = new Date('2026-09-16T18:00:00-05:00');
const OWN_YARD = '1101 Frontenac Rd, Naperville, IL 60563';

/**
 * The 17-row fixture, imported for real into the local database (03-acceptance-tests.md §A).
 *
 * The fixture's units are created on the roster first - the importer never creates one - and
 * everything the import writes for them is cleared before the run, so a second run of this spec
 * starts where the first did. The owner runs it.
 */
describe('PM board import (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let importer: PmImportService;
  let pm: PmService;
  let companyId = '';
  let rows: SheetRow[] = [];
  const unitIds = new Map<string, string>();
  const principal = () => ({ companyId, userId: 'usr_test', userName: 'Import test', companyTimezone: 'America/Chicago', weekStart: 1, roles: ['administrator'], permissions: new Set(['maintenance.view', 'maintenance.edit', 'trucks.edit']) });
  const options = { exportedAt: EXPORTED_AT, ownYardAddresses: [OWN_YARD], fileName: 'pm-board-slice.csv' };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    importer = app.get(PmImportService);
    pm = app.get(PmService);
    pm.clock = () => NOW;

    const roster = await app.inject({ method: 'GET', url: '/api/v1/trucks?pageSize=200' });
    const first = (roster.json() as { data: { id: string }[] }).data[0];
    if (!first) throw new Error('no truck to learn the company from');
    const [known] = await db.select({ companyId: trucks.companyId }).from(trucks).where(eq(trucks.id, first.id));
    companyId = known?.companyId ?? '';

    rows = readSheet(readFileSync(FIXTURE), 'pm-board-slice.csv').rows;
    // The roster has these units, as production does; here they are made for the test.
    for (const row of rows) {
      const unit = row.unit as string;
      const [existing] = await db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, companyId), eq(trucks.unitNumber, unit))).limit(1);
      let id = existing?.id;
      if (!id) {
        id = `trk_pmtest_${unit}`;
        await db.insert(trucks).values({
          id,
          companyId,
          unitNumber: unit,
          vin: `PMTEST${unit.padStart(11, '0')}`,
          year: 2022,
          make: 'Freightliner',
          model: 'Cascadia',
          status: 'available',
          health: 'good',
          ownership: 'owned',
          odometer: row.currentMileage ?? 0,
          odometerAt: NOW,
          engineHours: '0',
          nextServiceOdometer: 0,
          nextServiceDate: '2026-12-31',
          nextServiceType: 'oil_change',
          telematicsProvider: 'none',
          telematicsStatus: 'disconnected',
        } as typeof trucks.$inferInsert);
      }
      unitIds.set(unit, id);
    }
    const ids = [...unitIds.values()];
    // A clean slate for the fixture's units and shops.
    const orders = await db.select({ id: workOrders.id }).from(workOrders).where(and(eq(workOrders.companyId, companyId), inArray(workOrders.unitId, ids), eq(workOrders.enteredVia, 'import')));
    if (orders.length > 0) await db.delete(workOrderLines).where(inArray(workOrderLines.workOrderId, orders.map((o) => o.id)));
    await db.delete(workOrders).where(and(eq(workOrders.companyId, companyId), inArray(workOrders.unitId, ids), eq(workOrders.enteredVia, 'import')));
    await db.delete(pmPlans).where(and(eq(pmPlans.companyId, companyId), inArray(pmPlans.unitId, ids)));
    await db.delete(odometerReadings).where(and(eq(odometerReadings.companyId, companyId), inArray(odometerReadings.unitId, ids)));
    await db.delete(pmStatus).where(and(eq(pmStatus.companyId, companyId), inArray(pmStatus.unitId, ids)));
    await db.delete(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.source, 'import')));
    await db.update(trucks).set({ groupName: null, pmResponsibility: 'us', lessorName: null }).where(inArray(trucks.id, ids));
  });

  afterAll(async () => {
    await app.close();
  });

  it('A1 · a dry run writes nothing and reports 17 rows', async () => {
    const plan = await importer.plan(principal(), rows, options);
    expect(plan.summary.rows).toBe(17);
    expect(plan.summary.imported).toBe(17);
    const report = reportMarkdown(plan, { fileName: 'pm-board-slice.csv', dryRun: true, importedAt: NOW.toISOString(), exportedAt: EXPORTED_AT.toISOString(), kind: 'csv' });
    expect(report).toContain('would import: 17');
    expect(report).toContain('17 of 17 overdue');
    expect(report).toContain('worst 5,221 on #0026');
    expect(report).toContain('30,000 ×8 · 35,000 ×5 · 25,000 ×2 · 50,000 ×1 · 20,000 ×1');
    expect(report).toContain('rows with no cost: 5');
    expect(report).toContain('rows with no shop: 1');
    expect(report).toContain('own arithmetic was stale: 2');
    expect(report).toContain('merges 3 spellings');
    const ids = [...unitIds.values()];
    expect(await db.select().from(workOrders).where(and(eq(workOrders.companyId, companyId), inArray(workOrders.unitId, ids), eq(workOrders.enteredVia, 'import')))).toHaveLength(0);
    expect(await db.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.source, 'import')))).toHaveLength(0);
  });

  it('A2 / A4 / A6 · the real run: 17 services, 17 plans, 34 readings, 11 draft vendors, no units created', async () => {
    const before = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId));
    const plan = await importer.plan(principal(), rows, options);
    const result = await importer.apply(principal(), plan, options);
    expect(result).toEqual({ vendorsCreated: 11, servicesCreated: 17, plansCreated: 17, readingsCreated: 34, unitsUpdated: 17 });
    const after = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId));
    expect(after.length).toBe(before.length);

    // A4: one own-yard vendor for the three Naperville spellings, the rest drafts.
    const shops = await db.select().from(vendors).where(and(eq(vendors.companyId, companyId), eq(vendors.source, 'import')));
    const yard = shops.filter((v) => v.zip === '60563');
    expect(yard).toHaveLength(1);
    expect(yard[0]).toMatchObject({ isOwnYard: true, status: 'draft', city: 'Naperville', state: 'IL' });
    expect(shops.filter((v) => !v.isOwnYard).every((v) => v.status === 'draft')).toBe(true);

    // The service record: a completed order with one PM line, dated and priced as the sheet says.
    const id0074 = unitIds.get('0074') as string;
    const [order] = await db.select().from(workOrders).where(and(eq(workOrders.unitId, id0074), eq(workOrders.enteredVia, 'import')));
    expect(order).toMatchObject({ status: 'completed', pmServiceCode: 'OIL_CHANGE', serviceOdometer: 105_368, historic: true, invoiceTotal: '550.00' });
    expect(order?.serviceAt?.toISOString().slice(0, 10)).toBe('2026-06-22');
    expect(order?.vendorName).toMatch(/Roy Orr/);
    const lines = await db.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, order?.id ?? ''));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ systemCode: 'pm.oil_change', lineKind: 'pm', pmServiceCode: 'OIL_CHANGE', totalAmount: '550.00' });

    // A6: the lease units.
    const [ryder] = await db.select().from(trucks).where(eq(trucks.id, unitIds.get('796570') as string));
    expect(ryder).toMatchObject({ groupName: 'Ryder', pmResponsibility: 'lessor', lessorName: 'Ryder' });
    const [mk] = await db.select().from(trucks).where(eq(trucks.id, unitIds.get('241061') as string));
    expect(mk).toMatchObject({ groupName: 'M&K', pmResponsibility: 'lessor', lessorName: 'M&K' });
    const [ryderOrder] = await db.select().from(workOrders).where(and(eq(workOrders.unitId, ryder?.id ?? ''), eq(workOrders.enteredVia, 'import')));
    expect(ryderOrder?.invoiceTotal).toBeNull();
    expect(ryderOrder?.flags).toEqual(['sheet_arithmetic_stale', 'cost_missing']);
  });

  it('A3 · the stored values are recomputed, and the board agrees: 17 of 17 overdue', async () => {
    const statuses = (await app.inject({ method: 'GET', url: '/api/v1/fleet/pm/status' })).json() as PmStatus[];
    const imported = statuses.filter((s) => unitIds.has(s.unitNumber));
    expect(imported).toHaveLength(17);
    expect(imported.every((s) => s.dueStatus === 'overdue')).toBe(true);
    const by = (unit: string) => imported.find((s) => s.unitNumber === unit) as PmStatus;
    expect(by('796570').milesSinceService).toBe(54_783);
    expect(by('0017').milesSinceService).toBe(29_643);
    expect(by('0026')).toMatchObject({ milesRemaining: -5_221, intervalMiles: 30_000, planOrigin: 'unit', lastServiceSource: 'import', readingSource: 'import' });
    expect(by('0074')).toMatchObject({ nextServiceOdometer: 140_368, milesRemaining: -1_652 });
    expect(by('796570')).toMatchObject({ pmResponsibility: 'lessor', lessorName: 'Ryder', intervalMiles: 50_000 });
  });

  it('A9 · the same file again: 17 unchanged, nothing duplicated', async () => {
    const plan = await importer.plan(principal(), rows, options);
    expect(plan.summary.unchanged).toBe(17);
    expect(plan.summary.imported).toBe(0);
    expect(plan.summary.vendorsMatched).toBe(11);
    const result = await importer.apply(principal(), plan, options);
    expect(result).toEqual({ vendorsCreated: 0, servicesCreated: 0, plansCreated: 0, readingsCreated: 0, unitsUpdated: 0 });
    const ids = [...unitIds.values()];
    expect(await db.select().from(workOrders).where(and(eq(workOrders.companyId, companyId), inArray(workOrders.unitId, ids), eq(workOrders.enteredVia, 'import')))).toHaveLength(17);
    expect(await db.select().from(odometerReadings).where(and(eq(odometerReadings.companyId, companyId), inArray(odometerReadings.unitId, ids)))).toHaveLength(34);
  });

  it('A7 · with no export time, a fresh unit imports its current mileage undated and shows No reading', async () => {
    // A unit the earlier run did not touch: the fixture's 0065 row, re-keyed to a spare truck.
    const spare = `trk_pmtest_A7`;
    await db.delete(pmStatus).where(eq(pmStatus.unitId, spare));
    await db.delete(odometerReadings).where(eq(odometerReadings.unitId, spare));
    await db.delete(pmPlans).where(eq(pmPlans.unitId, spare));
    await db.delete(workOrders).where(eq(workOrders.unitId, spare));
    await db
      .insert(trucks)
      .values({ id: spare, companyId, unitNumber: 'PMA7', vin: 'PMTESTA7000000000', year: 2022, make: 'Freightliner', model: 'Cascadia', status: 'available', health: 'good', ownership: 'owned', odometer: 0, odometerAt: NOW, engineHours: '0', nextServiceOdometer: 0, nextServiceDate: '2026-12-31', nextServiceType: 'oil_change', telematicsProvider: 'none', telematicsStatus: 'disconnected' } as typeof trucks.$inferInsert)
      .onConflictDoNothing();
    const row = { ...(rows.find((r) => r.unit === '0065') as SheetRow), unit: 'PMA7' };
    const undated = { ...options, exportedAt: null };
    const plan = await importer.plan(principal(), [row], undated);
    expect(plan.summary.readingsAgeUnknown).toBe(true);
    await importer.apply(principal(), plan, undated);
    const status = (await app.inject({ method: 'GET', url: `/api/v1/fleet/pm/status/${spare}` })).json() as PmStatus;
    expect(status.dueStatus).toBe('no_reading');
    expect(status.readingAgeUnknown).toBe(true);
    expect(status.readingOdometer).toBe(247_644);
    expect(status.readingAt).toBeNull();
  });

  it('A8 · a unit NeWay does not have is listed and skipped, never created', async () => {
    const row = { ...(rows[0] as SheetRow), unit: 'NOPE-9999' };
    const before = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId));
    const plan = await importer.plan(principal(), [row], options);
    expect(plan.rows[0]).toMatchObject({ outcome: 'skip', skipReason: 'unit not in NeWay' });
    await importer.apply(principal(), plan, options);
    const after = await db.select({ id: trucks.id }).from(trucks).where(eq(trucks.companyId, companyId));
    expect(after.length).toBe(before.length);
  });

  it('refuses a file that does not parse, whole', async () => {
    const bad = readSheet(Buffer.from('row,unit,group,last_pm_date,last_pm_mileage,current_mileage,total_running,pm_every,next_service,miles_left,amount,shop\n1,0026,NWF,soon,x,436158,,30000,,,,\n'), 'bad.csv');
    const plan = await importer.plan(principal(), bad.rows, options);
    expect(plan.parseErrors).toHaveLength(1);
    await expect(importer.apply(principal(), plan, options)).rejects.toThrow(/did not parse/);
  });
});
