import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { FleetExpenseDetail, FleetExpenseList, FleetExpenseSummary, InvestigationList } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { workOrders } from '../src/database/schema/fleet';
import { drivers } from '../src/database/schema/roster';
import { FleetExpensesService } from '../src/modules/fleet-expenses/fleet-expenses.service';
import { WorkOrdersService } from '../src/modules/fleet/work-orders.service';

const FX = '/api/v1/fleet/expenses';

/**
 * Costs as one Fleet dashboard (owner, 2026-10-13), on fictional records: a cash advance and a
 * repair under investigation, a warranty claim, and the Company / Driver / Investigation /
 * Warranty split under the total. Fleet managers and Safety settle an investigation; Safety may
 * not change any other payer.
 */
describe('Costs: under investigation, warranty and the payer split (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const eastern = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = eastern(new Date());
  const daysAgo = (n: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - n);
    return d.toISOString().slice(0, 10);
  };
  let truckId = '';
  let unit = '';
  const driverId = `drv_e2e_inv_${tag}`.toLowerCase();
  const woInvestigation = `wo_e2e_inv_${tag}`.toLowerCase();
  const woWarranty = `wo_e2e_war_${tag}`.toLowerCase();
  let expenseId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    unit = `INV-${tag}`.slice(0, 20);
    const t = await call('POST', '/api/v1/trucks', { unitNumber: unit, vin: `1IV${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2022, make: 'E2E', model: 'Investigation', odometer: 100_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-INV-${tag}`, firstName: 'E2E', lastName: `Investigation ${tag}`, phone: '5550000001', email: `e2e-inv-${tag}@example.test`.toLowerCase(), driverType: 'company', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: daysAgo(90), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: null, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'flat_rate' });
    const wo = (id: string, number: string, total: string, party: string, extra: Partial<typeof workOrders.$inferInsert> = {}) =>
      ({ id, companyId, number, assetType: 'truck', unitId: truckId, unitNumber: unit, status: 'completed', workType: 'repair', title: 'Mirror and bumper', shopInAt: new Date(`${daysAgo(5)}T14:00:00Z`), completedAt: new Date(`${daysAgo(4)}T16:00:00Z`), total, invoiceTotal: total, vendorName: `E2E Body Shop ${tag}`, chargeParty: party, createdBy: 'e2e', ...extra }) as typeof workOrders.$inferInsert;
    await db.insert(workOrders).values([
      wo(woInvestigation, `RO-INV-${tag}`, '300.00', 'investigation', { chargeDriverId: driverId, chargeDriverName: `E2E Investigation ${tag}` }),
      wo(woWarranty, `RO-WAR-${tag}`, '100.00', 'warranty', { flags: ['warranty_claim'] }),
    ]);
  }, 120_000);

  afterAll(async () => {
    // Nothing is deleted: the repairs are voided, the expense stays as recorded.
    await db.update(workOrders).set({ voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'test data' }).where(eq(workOrders.companyId, companyId));
    await app.close();
  });

  it('records a cash advance under investigation, names the driver, and refuses to post it', async () => {
    const res = await call('POST', FX, {
      status: 'recorded',
      truckId,
      category: 'cash_advance',
      expenseDate: daysAgo(4),
      amountCents: 20000,
      paidBy: 'company',
      paymentMethod: 'cash',
      paid: true,
      chargeTo: 'investigation',
      charge: { driverId, amountCents: 20000, reason: 'Cash advance not accounted for', deductFromSettlement: true },
    });
    expect(res.statusCode, res.body).toBe(201);
    const d = res.json() as FleetExpenseDetail;
    expenseId = d.id;
    expect(d.outcome).toBe('investigation');
    expect(d.categoryLabel).toBe('Cash advance');
    expect(d.chargeDriverId).toBe(driverId);
    expect(d.deductFromSettlement).toBe(false);
    expect(d.figures).toMatchObject({ spendCents: 20000, companyCents: 0, driverChargeCents: 0, investigationCents: 20000 });
    const post = await call('POST', `${FX}/${expenseId}/post`, {});
    expect(post.statusCode).toBe(422);
    expect(post.body).toMatch(/under investigation/);
    // Driver-paid money cannot be "under investigation".
    const bad = await call('POST', FX, { status: 'recorded', truckId, category: 'parking', expenseDate: daysAgo(4), amountCents: 1000, paidBy: 'driver', payerDriverId: driverId, chargeTo: 'investigation', location: { placeName: 'Lot', address: 'Main St', city: null, state: null, postalCode: null } });
    expect(bad.statusCode).toBe(422);
  });

  it('lists what is under investigation for the driver and the unit', async () => {
    const byDriver = (await call('GET', `${FX}/investigations?driverId=${driverId}`)).json() as InvestigationList;
    expect(byDriver.items.map((i) => i.reference).sort()).toEqual([`RO-INV-${tag}`, (await call('GET', `${FX}/${expenseId}`)).json().reference].sort());
    expect(byDriver.totalCents).toBe(50000);
    expect(byDriver.canResolve).toBe(true);
    const byUnit = (await call('GET', `${FX}/investigations?unitId=${truckId}`)).json() as InvestigationList;
    expect(byUnit.items).toHaveLength(2);
    expect(byUnit.items.every((i) => i.days >= 0 && i.overdue === false)).toBe(true);
  });

  it('Costs: one total, split into maintenance and expenses, and into Company / Driver / Investigation / Warranty', async () => {
    const s = (await call('GET', `/api/v1/fleet/expense-summary?period=month&at=${daysAgo(4)}&units=${truckId}&scope=all`)).json() as FleetExpenseSummary;
    const total = s.categories.total;
    expect(total).toBe(600);
    expect(s.split).toMatchObject({ maintenance: 400, expenses: 200, investigation: 500, warranty: 100, driver: 0, company: 0 });
    expect(s.split.company + s.split.driver + s.split.investigation + s.split.warranty + s.split.owner).toBe(total);
    expect(s.events.find((e) => e.kind === 'fleet_expense')).toMatchObject({ type: 'cash_advance', payer: 'investigation' });
  });

  it('Repair log › Expenses lists only what is not maintenance', async () => {
    const l = (await call('GET', `${FX}?truckId=${truckId}&nonMaintenance=true&pageSize=50`)).json() as FleetExpenseList;
    expect(l.rows.map((r) => r.category)).toEqual(['cash_advance']);
    expect(l.totals.investigationCents).toBe(20000);
  });

  it('Safety settles an investigation, and may not change any other payer', async () => {
    const safety = { userId: 'u_e2e_safety', userName: 'E2E Safety', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: ['safety'], permissions: new Set(['compliance.manage']) };
    const expenses = app.get(FleetExpensesService);
    const settled = await expenses.resolveInvestigation(safety, expenseId, { to: 'driver', reason: 'Receipt never turned in' });
    expect(settled).toMatchObject({ chargeTo: 'driver', outcome: 'driver_charge', chargeDriverId: driverId, chargeCents: 20000, deductFromSettlement: true });
    await expect(expenses.resolveInvestigation(safety, expenseId, { to: 'company', reason: 'Again' })).rejects.toMatchObject({ status: 409 });

    const orders = app.get(WorkOrdersService);
    const wo = await orders.setCharge(safety, woInvestigation, { party: 'company', note: 'Investigation settled: another vehicle hit the parked truck' });
    expect(wo.charge.party).toBe('company');
    await expect(orders.setCharge(safety, woInvestigation, { party: 'driver', driverId, driverInformed: true })).rejects.toMatchObject({ status: 403 });

    const after = (await call('GET', `${FX}/investigations?driverId=${driverId}`)).json() as InvestigationList;
    expect(after.items).toHaveLength(0);
    const s = (await call('GET', `/api/v1/fleet/expense-summary?period=month&at=${daysAgo(4)}&units=${truckId}&scope=all`)).json() as FleetExpenseSummary;
    expect(s.split).toMatchObject({ investigation: 0, warranty: 100, driver: 200, company: 300 });
  });
});
