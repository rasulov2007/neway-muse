import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import type { PmBoard, PmShop, PmStatus, PmUnitDetail, WorkOrder } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import {
  unitMaintenanceSettings,
  vendors,
  workOrderLines,
  workOrders,
} from '../src/database/schema/fleet';
import { auditLogs } from '../src/database/schema/people';
import { odometerReadings, pmPlans, pmStatus } from '../src/database/schema/pm';
import { trucks } from '../src/database/schema/roster';
import { PmService } from '../src/modules/pm/pm.service';

const BASE = '/api/v1/fleet/pm';
/** The acceptance tests' clock: 2026-09-17 07:45 America/Chicago. */
const NOW = new Date('2026-09-17T07:45:00-05:00');

/**
 * Truck 0074's morning on the board (mockups A–C, walkthrough E): overdue with an appointment,
 * then the completion from the invoice, which is the one transaction that resets the clock
 * (§6.2). Then a correction and a void, both audited, both recomputing. Runs as the owner; the
 * PM tables it touches are cleared for the unit first, so a re-run starts clean.
 */
describe('Oil change / PM board (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let pm: PmService;
  let companyId = '';
  let unitId = '';
  let unitNumber = '';
  let vendorId = '';
  let responsibleId = '';
  let appointment: WorkOrder;
  let completion: WorkOrder;

  const call = (
    method: 'GET' | 'POST',
    url: string,
    payload?: unknown,
    headers?: Record<string, string>,
  ) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json', ...(headers ?? {}) },
      ...(payload ? { payload } : {}),
    });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    pm = app.get(PmService);
    pm.clock = () => NOW;

    const roster = (await call('GET', '/api/v1/trucks?pageSize=200')).json() as {
      data: { id: string; unitNumber: string; status: string }[];
    };
    const active = roster.data.filter((t) => !['inactive', 'sold'].includes(t.status));
    // The third active truck: the engine spec uses the first two.
    unitId = active[2]?.id ?? '';
    unitNumber = active[2]?.unitNumber ?? '';
    if (!unitId) throw new Error('need three active trucks');
    const [truck] = await db
      .select({ companyId: trucks.companyId })
      .from(trucks)
      .where(eq(trucks.id, unitId));
    companyId = truck?.companyId ?? '';

    await db
      .delete(pmPlans)
      .where(and(eq(pmPlans.companyId, companyId), eq(pmPlans.unitId, unitId)));
    await db
      .delete(odometerReadings)
      .where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.unitId, unitId)));
    await db
      .delete(pmStatus)
      .where(and(eq(pmStatus.companyId, companyId), eq(pmStatus.unitId, unitId)));
    await db
      .delete(unitMaintenanceSettings)
      .where(
        and(
          eq(unitMaintenanceSettings.companyId, companyId),
          eq(unitMaintenanceSettings.unitId, unitId),
        ),
      );
    const old = await db
      .select({ id: workOrders.id })
      .from(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.unitId, unitId),
          eq(workOrders.workType, 'oil_change'),
        ),
      );
    for (const wo of old)
      await db.delete(workOrderLines).where(eq(workOrderLines.workOrderId, wo.id));
    await db
      .delete(workOrders)
      .where(
        and(
          eq(workOrders.companyId, companyId),
          eq(workOrders.unitId, unitId),
          eq(workOrders.workType, 'oil_change'),
        ),
      );
    await db
      .update(trucks)
      .set({ groupName: 'NWF', pmResponsibility: 'us', lessorName: null })
      .where(eq(trucks.id, unitId));

    // A shop of our own for the test, kept if an earlier run made it.
    const [shop] = await db
      .select({ id: vendors.id })
      .from(vendors)
      .where(and(eq(vendors.companyId, companyId), eq(vendors.name, 'TA Grand Prairie (test)')));
    if (shop) vendorId = shop.id;
    else {
      vendorId = `ven_test_${Date.now()}`;
      await db
        .insert(vendors)
        .values({
          id: vendorId,
          companyId,
          name: 'TA Grand Prairie (test)',
          kind: 'shop',
          city: 'Grand Prairie',
          state: 'TX',
          status: 'active',
          source: 'test',
        } as typeof vendors.$inferInsert);
    }
    const assignees = (await call('GET', '/api/v1/fleet/pti/assignees')).json() as {
      id: string;
      name: string;
    }[];
    responsibleId = assignees[0]?.id ?? '';
    if (!responsibleId) throw new Error('need an assignee');

    // Truck 0074's story: 35,000 mi override, service Jun 22 at 105,368, the ELD at 142,020.
    await call('POST', `${BASE}/plans`, {
      serviceCode: 'OIL_CHANGE',
      scope: 'unit',
      unitId,
      intervalMiles: 35_000,
      reason: 'OEM spec for this engine, oil analysis clean',
    });
    await db.insert(workOrders).values({
      id: `wo_pmb_${unitId}`,
      companyId,
      number: 'RO-IMPORT-BOARD',
      assetType: 'truck',
      unitId,
      unitNumber,
      status: 'completed',
      shopStage: null,
      workType: 'oil_change',
      workDone: 'Oil & filter change (PM A)',
      shopInAt: new Date('2026-06-22T14:00:00-05:00'),
      completedAt: new Date('2026-06-22T15:00:00-05:00'),
      downtimeMinutes: 60,
      odometer: 105_368,
      vendorId,
      vendorName: 'TA Grand Prairie (test)',
      total: '550',
      invoiceTotal: '550',
      createdBy: 'import',
      pmServiceCode: 'OIL_CHANGE',
      serviceAt: new Date('2026-06-22T14:00:00-05:00'),
      serviceOdometer: 105_368,
      enteredVia: 'import',
    });
    await pm.ingestEldReadings(companyId, [
      { unitId, odometerMiles: 138_900, engineHours: null, readingAt: '2026-09-14T06:12:00-05:00' },
      { unitId, odometerMiles: 140_290, engineHours: null, readingAt: '2026-09-15T06:08:00-05:00' },
      { unitId, odometerMiles: 141_655, engineHours: null, readingAt: '2026-09-16T06:10:00-05:00' },
      { unitId, odometerMiles: 142_020, engineHours: null, readingAt: '2026-09-17T07:25:00-05:00' },
    ]);
    await pm.recompute(companyId, [unitId]);
  });

  afterAll(async () => {
    await app.close();
  });

  it('A · the board carries the verdict, the size of the problem and one next step per row', async () => {
    const response = await call('GET', `${BASE}/board`);
    expect(response.statusCode).toBe(200);
    const board = response.json() as PmBoard;
    const row = board.rows.find((r) => r.unitId === unitId);
    expect(row, `a row for ${unitNumber}`).toBeDefined();
    if (!row) return;
    expect(row.dueStatus).toBe('overdue');
    expect(row.milesRemaining).toBe(-1_652);
    expect(row.pctOver).toBeCloseTo(4.7, 1);
    expect(row.appointment).toBeNull();
    expect(row.nextStep).toBe('schedule');
    expect(row.lastService?.odometer).toBe(105_368);
    expect(row.lastService?.cost).toBe(550);
    // The strip's counts are counts of rows, and money is there for the owner.
    expect(board.summary.overdue).toBe(
      board.rows.filter((r) => r.dueStatus === 'overdue' || r.dueStatus === 'overdue_at_least')
        .length,
    );
    expect(board.summary.booked).toBe(board.rows.filter((r) => r.appointment).length);
    expect(board.summary.computedAt).toBe(NOW.toISOString());
    // Overdue rows come first, most miles over first.
    const overdue = board.rows.filter((r) => r.dueStatus === 'overdue');
    for (let i = 1; i < overdue.length; i += 1)
      expect((overdue[i - 1]?.milesRemaining ?? 0) <= (overdue[i]?.milesRemaining ?? 0)).toBe(true);
  });

  it('shops list the prices this company paid', async () => {
    const shops = (await call('GET', `${BASE}/shops`)).json() as PmShop[];
    const shop = shops.find((s) => s.id === vendorId);
    expect(shop?.visits).toBe(1);
    expect(shop?.lastPrice).toBe(550);
  });

  it('B · booking writes a work order in "Scheduled into a shop" and changes nothing about the due status', async () => {
    const response = await call('POST', `${BASE}/appointments`, {
      unitId,
      vendorId,
      scheduledFor: '2026-09-17T08:00:00-05:00',
      responsibleUserId: responsibleId,
      estimatedCost: 520,
      noteForShop: 'Please quote the annual DOT inspection on the same visit.',
      bundle: ['annual_inspection'],
    });
    expect(response.statusCode, response.body).toBe(201);
    appointment = response.json() as WorkOrder;
    expect(appointment.status).toBe('scheduled');
    expect(appointment.pmServiceCode).toBe('OIL_CHANGE');
    expect(appointment.scheduledFor).toBe('2026-09-17T13:00:00.000Z');

    const status = (await call('GET', `${BASE}/status/${unitId}`)).json() as PmStatus;
    expect(status.dueStatus).toBe('overdue');
    expect(status.milesRemaining).toBe(-1_652);

    const board = (await call('GET', `${BASE}/board`)).json() as PmBoard;
    const row = board.rows.find((r) => r.unitId === unitId);
    expect(row?.appointment?.workOrderId).toBe(appointment.id);
    expect(row?.appointment?.estimatedCost).toBe(520);
    // At 07:45 the 08:00 slot is still ahead: the row says Open, not Record completion.
    expect(row?.nextStep).toBe('open');
    expect(board.summary.bookedOverdue).toBeGreaterThanOrEqual(1);
  });

  it('a second booking on the same unit is refused unless it says it is moving the first', async () => {
    const again = await call('POST', `${BASE}/appointments`, {
      unitId,
      vendorId,
      scheduledFor: '2026-09-18T08:00:00-05:00',
      responsibleUserId: responsibleId,
    });
    expect(again.statusCode).toBe(400);
    expect(again.json().detail).toContain('already booked');
    const moved = await call('POST', `${BASE}/appointments`, {
      unitId,
      vendorId,
      scheduledFor: '2026-09-17T08:30:00-05:00',
      responsibleUserId: responsibleId,
      moveExisting: true,
    });
    expect(moved.statusCode).toBe(201);
    expect((moved.json() as WorkOrder).id).toBe(appointment.id);
    expect((moved.json() as WorkOrder).scheduledFor).toBe('2026-09-17T13:30:00.000Z');
  });

  it('C · the completion refuses a $0 invoice without a reason and an odometer far from the ELD without one', async () => {
    // The service is at 09:40; the clock moves on to mid-morning (walkthrough E, stage 3).
    pm.clock = () => new Date('2026-09-17T10:00:00-05:00');
    const base = {
      unitId,
      workOrderId: appointment.id,
      serviceAt: '2026-09-17T09:40:00-05:00',
      vendorId,
      work: ['oil_filter', 'fuel_filters', 'grease'],
    };
    const zero = await call('POST', `${BASE}/completions`, {
      ...base,
      serviceOdometer: 142_020,
      invoiceTotal: 0,
    });
    expect(zero.statusCode).toBe(422);
    const far = await call('POST', `${BASE}/completions`, {
      ...base,
      serviceOdometer: 143_500,
      invoiceTotal: 550,
    });
    expect(far.statusCode).toBe(400);
    expect(far.json().detail).toContain('ELD');
    const noOil = await call('POST', `${BASE}/completions`, {
      ...base,
      work: ['grease'],
      serviceOdometer: 142_020,
      invoiceTotal: 550,
    });
    expect(noOil.statusCode).toBe(422);
  });

  it('C · the completion resets the clock from the service odometer, closes the appointment and keeps other work apart (§6.2)', async () => {
    const response = await call('POST', `${BASE}/completions`, {
      unitId,
      workOrderId: appointment.id,
      serviceAt: '2026-09-17T09:40:00-05:00',
      serviceOdometer: 142_020,
      work: ['oil_filter', 'fuel_filters', 'grease'],
      otherLines: [{ systemCode: 'body_doors', description: 'Wiper blades replaced', amount: 18 }],
      vendorId,
      invoiceTotal: 568,
      invoiceNumber: 'TA-90233',
    });
    expect(response.statusCode, response.body).toBe(201);
    const { workOrder, status } = response.json() as { workOrder: WorkOrder; status: PmStatus };
    completion = workOrder;
    expect(workOrder.id).toBe(appointment.id);
    expect(workOrder.status).toBe('completed');

    // The verdict follows the new baseline.
    expect(status.lastServiceOdometer).toBe(142_020);
    expect(status.lastServiceSource).toBe('completion');
    expect(status.nextServiceOdometer).toBe(177_020);
    expect(status.dueStatus).toBe('ok');
    expect(status.milesRemaining).toBe(35_000);

    // The lines: one PM line for $550, the wipers on their own, and an invoice reading.
    const lines = await db
      .select()
      .from(workOrderLines)
      .where(eq(workOrderLines.workOrderId, workOrder.id));
    expect(lines.map((l) => [l.lineKind, Number(l.totalAmount)]).sort()).toEqual([
      ['pm', 550],
      ['repair', 18],
    ]);
    const [reading] = await db
      .select()
      .from(odometerReadings)
      .where(eq(odometerReadings.id, `odo_wo_${workOrder.id}`));
    expect(reading?.source).toBe('invoice');
    expect(reading?.odometerMiles).toBe(142_020);

    // The board and the row agree with it; the appointment is gone.
    const board = (await call('GET', `${BASE}/board`)).json() as PmBoard;
    const row = board.rows.find((r) => r.unitId === unitId);
    expect(row?.dueStatus).toBe('ok');
    expect(row?.appointment).toBeNull();
    expect(row?.lastService?.invoiceNumber).toBe('TA-90233');
    const detail = (await call('GET', `${BASE}/units/${unitId}`)).json() as PmUnitDetail;
    expect(detail.services[0]?.odometer).toBe(142_020);
    expect(detail.services[0]?.milesRun).toBe(36_652);
    expect(detail.plan?.intervalMiles).toBe(35_000);
    expect(detail.readings[0]?.source).toBe('invoice');

    // Audited, with the before and after.
    const [audit] = await db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.entityType, 'pm_completion'),
          eq(auditLogs.entityId, workOrder.id),
          eq(auditLogs.action, 'complete'),
        ),
      );
    expect(audit?.summary).toContain('142,020');
  });

  it('a duplicate invoice number from the same shop is refused', async () => {
    const dup = await call('POST', `${BASE}/completions`, {
      unitId,
      serviceAt: '2026-09-17T10:00:00-05:00',
      serviceOdometer: 142_030,
      work: ['oil_filter'],
      vendorId,
      invoiceTotal: 100,
      invoiceNumber: 'TA-90233',
    });
    expect(dup.statusCode).toBe(400);
    expect(dup.json().detail).toContain('already on');
  });

  it('a correction moves the baseline with a reason and shows in the correction log', async () => {
    const response = await call('POST', `${BASE}/completions/${completion.id}/correct`, {
      serviceOdometer: 142_000,
      reason: 'typo from invoice',
    });
    expect(response.statusCode, response.body).toBe(201);
    const status = response.json() as PmStatus;
    expect(status.lastServiceOdometer).toBe(142_000);
    expect(status.nextServiceOdometer).toBe(177_000);
    const detail = (await call('GET', `${BASE}/units/${unitId}`)).json() as PmUnitDetail;
    expect(detail.corrections[0]?.reason).toBe('typo from invoice');
    expect(detail.corrections[0]?.summary).toContain('142,020');
    const nothing = await call('POST', `${BASE}/completions/${completion.id}/correct`, {
      serviceOdometer: 142_000,
      reason: 'same again',
    });
    expect(nothing.statusCode).toBe(400);
  });

  it('a void keeps the record, voids its reading and puts the previous baseline back', async () => {
    const response = await call('POST', `${BASE}/completions/${completion.id}/void`, {
      reason: 'wrong truck on the invoice',
    });
    expect(response.statusCode, response.body).toBe(201);
    const status = response.json() as PmStatus;
    expect(status.lastServiceOdometer).toBe(105_368);
    expect(status.dueStatus).toBe('overdue');
    const [row] = await db.select().from(workOrders).where(eq(workOrders.id, completion.id));
    expect(row?.voidedAt).not.toBeNull();
    expect(row?.voidReason).toBe('wrong truck on the invoice');
    const [reading] = await db
      .select()
      .from(odometerReadings)
      .where(eq(odometerReadings.id, `odo_wo_${completion.id}`));
    expect(reading?.status).toBe('void');
  });

  it('writes take maintenance.edit; money is dropped without maintenance_costs.view', async () => {
    const stranger = await call(
      'POST',
      `${BASE}/appointments`,
      {
        unitId,
        vendorId,
        scheduledFor: '2026-09-18T08:00:00-05:00',
        responsibleUserId: responsibleId,
      },
      { 'x-demo-role': 'operations' },
    );
    expect(stranger.statusCode).toBe(403);
  });
});
