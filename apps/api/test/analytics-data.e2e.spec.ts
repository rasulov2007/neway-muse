import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { createApp } from '../src/app.factory';
import { DatabaseService } from '../src/database/database.service';
import { fleetExpenses, workOrders } from '../src/database/schema/fleet';
import { hiringLeads } from '../src/database/schema/hiring';
import { loads } from '../src/database/schema/loads';
import { employees } from '../src/database/schema/people';
import { companies, drivers, trucks } from '../src/database/schema/roster';
import { AnalyticsService } from '../src/modules/reports/analytics.service';

/**
 * Analytics over real database rows (owner decisions, 2026-10-25): the loader reads only the
 * company's own rows, revenue follows the Eastern delivery day, demo loads stay out, trailer
 * repairs stay off trucks, manual Fleet expenses count, and Workforce counts the working driver
 * roster and open, non-test leads.
 */
describe('Analytics data (e2e, database)', () => {
  let app: NestFastifyApplication;
  let analytics: AnalyticsService;
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const A = `co_e2e_anl_a_${tag}`;
  const B = `co_e2e_anl_b_${tag}`;
  const principal = (companyId: string): Principal => ({
    userId: 'e2e',
    companyId,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: [],
    permissions: new Set(['analytics.view']),
  });

  const truck = (companyId: string, id: string, unit: string) => ({
    id,
    companyId,
    unitNumber: unit,
    vin: `VIN${id}`.padEnd(17, '0').slice(0, 17),
    year: 2022,
    make: 'Freightliner',
    model: 'Cascadia',
    status: 'available',
    health: 'good',
    ownership: 'owned',
    odometer: 1000,
    odometerAt: new Date('2026-10-01T00:00:00Z'),
    engineHours: '10',
    nextServiceOdometer: 20000,
    nextServiceDate: '2027-01-01',
    nextServiceType: 'pm_a',
    telematicsProvider: 'none',
    telematicsStatus: 'not_connected',
  });
  const driver = (companyId: string, id: string, status: string, employeeId: string | null = null) => ({
    id,
    companyId,
    driverNumber: id,
    firstName: 'E2E',
    lastName: id,
    phone: '5550000000',
    email: `${id}@example.test`,
    driverType: 'company',
    cdlState: 'OH',
    cdlClass: 'A',
    cdlNumber: id,
    cdlExpiresOn: '2028-01-01',
    cdlStatus: 'valid',
    medicalCardStatus: 'valid',
    hireDate: '2026-01-01',
    status,
    dispatcherId: 'x',
    dispatcherName: 'x',
    homeCity: 'Columbus',
    homeState: 'OH',
    payPlanKind: 'percentage',
    employeeId,
  });
  const loadRow = (companyId: string, id: string, record: Record<string, unknown>, isDemo = false) => ({
    id,
    companyId,
    loadNumber: id,
    status: String(record.status),
    isDemo,
    record: { id, loadNumber: id, truckId: null, driverId: null, loadedMiles: 0, emptyMiles: 0, rate: 0, charges: [], stops: [], ...record },
  });
  const lead = (companyId: string, id: string, status: string, isTest = false) => ({
    id,
    companyId,
    leadNumber: id,
    firstName: 'E2E',
    lastName: id,
    phone: '5550000000',
    source: 'website',
    status,
    isTest,
  });
  const employee = (companyId: string, id: string, status: string) => ({
    id,
    companyId,
    employeeNumber: id,
    firstName: 'E2E',
    lastName: id,
    workEmail: `${id}@example.test`,
    phone: '5550000000',
    department: 'operations',
    position: 'Dispatcher',
    hireDate: '2026-01-01',
    status,
    employmentType: 'full_time',
  });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    const db = app.get(DatabaseService).db;
    await db.insert(companies).values([
      { id: A, name: 'E2E analytics A' },
      { id: B, name: 'E2E analytics B' },
    ] as (typeof companies.$inferInsert)[]);
    await db.insert(trucks).values([truck(A, `trk_a_${tag}`, 'A1'), truck(B, `trk_b_${tag}`, 'B1')] as never);
    await db.insert(employees).values([
      employee(A, `emp_a1_${tag}`, 'active'),
      employee(A, `emp_a2_${tag}`, 'active'),
      employee(A, `emp_a3_${tag}`, 'terminated'),
    ] as never);
    await db.insert(drivers).values([
      driver(A, `drv_a1_${tag}`, 'available', `emp_a2_${tag}`),
      driver(A, `drv_a2_${tag}`, 'vacation'),
      driver(A, `drv_a3_${tag}`, 'onboarding'),
      driver(A, `drv_a4_${tag}`, 'terminated'),
      driver(B, `drv_b1_${tag}`, 'available'),
    ] as never);
    await db.insert(loads).values([
      // 23:30 ET on Sunday Oct 18 → in Oct 12-18.
      loadRow(A, `ld_a1_${tag}`, { status: 'delivered', truckId: `trk_a_${tag}`, rate: 2000, loadedMiles: 800, emptyMiles: 200, deliveredAt: '2026-10-19T03:30:00Z', charges: [{ type: 'linehaul', amount: 2000, billable: true }, { type: 'detention', amount: 100, billable: true, status: 'accepted' }] }),
      loadRow(A, `ld_a2_${tag}`, { status: 'tonu', rate: 1500, cancellation: { outcome: 'tonu', fee: 200, at: '2026-10-14T15:00:00Z' } }),
      // A demo load never counts.
      loadRow(A, `ld_a3_${tag}`, { status: 'delivered', rate: 9000, deliveredAt: '2026-10-14T15:00:00Z' }, true),
      loadRow(B, `ld_b1_${tag}`, { status: 'delivered', truckId: `trk_b_${tag}`, rate: 7777, loadedMiles: 1000, deliveredAt: '2026-10-14T15:00:00Z' }),
    ] as never);
    await db.insert(workOrders).values([
      { id: `wo_a1_${tag}`, companyId: A, number: `WO-A1-${tag}`, assetType: 'truck', unitId: `trk_a_${tag}`, unitNumber: 'A1', status: 'completed', workType: 'repair', shopInAt: new Date('2026-10-13T12:00:00Z'), completedAt: new Date('2026-10-13T18:00:00Z'), total: '300', invoiceTotal: '300' },
      { id: `wo_a2_${tag}`, companyId: A, number: `WO-A2-${tag}`, assetType: 'trailer', unitId: `trl_a_${tag}`, unitNumber: 'TA1', status: 'completed', workType: 'repair', shopInAt: new Date('2026-10-15T12:00:00Z'), completedAt: new Date('2026-10-15T18:00:00Z'), total: '450', invoiceTotal: '450' },
      { id: `wo_b1_${tag}`, companyId: B, number: `WO-B1-${tag}`, assetType: 'truck', unitId: `trk_b_${tag}`, unitNumber: 'B1', status: 'completed', workType: 'repair', shopInAt: new Date('2026-10-13T12:00:00Z'), completedAt: new Date('2026-10-13T18:00:00Z'), total: '5555', invoiceTotal: '5555' },
    ] as never);
    await db.insert(fleetExpenses).values([
      { id: `fx_a1_${tag}`, companyId: A, reference: `EXP-${tag}`, status: 'recorded', truckId: `trk_a_${tag}`, unitNumber: 'A1', category: 'parking', expenseDate: '2026-10-16', amountCents: 2500, paidBy: 'company', chargeTo: 'company', createdBy: 'e2e', updatedBy: 'e2e' },
      // Driver paid and bore it: not a company cost.
      { id: `fx_a2_${tag}`, companyId: A, reference: `EXP2-${tag}`, status: 'recorded', truckId: `trk_a_${tag}`, unitNumber: 'A1', category: 'truck_wash', expenseDate: '2026-10-16', amountCents: 9900, paidBy: 'driver', chargeTo: 'driver', createdBy: 'e2e', updatedBy: 'e2e' },
      // Test data: never counted.
      { id: `fx_a3_${tag}`, companyId: A, reference: `EXP3-${tag}`, status: 'recorded', truckId: `trk_a_${tag}`, unitNumber: 'A1', category: 'parking', expenseDate: '2026-10-16', amountCents: 8800, paidBy: 'company', chargeTo: 'company', isTest: true, createdBy: 'e2e', updatedBy: 'e2e' },
    ] as never);
    await db.insert(hiringLeads).values([
      lead(A, `lead_a1_${tag}`, 'new'),
      lead(A, `lead_a2_${tag}`, 'contacted'),
      lead(A, `lead_a3_${tag}`, 'converted'),
      lead(A, `lead_a4_${tag}`, 'dead'),
      lead(A, `lead_a5_${tag}`, 'new', true),
      lead(B, `lead_b1_${tag}`, 'new'),
    ] as never);
    analytics = app.get(AnalyticsService);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const value = (metrics: { key: string; current: number | null }[], key: string) =>
    metrics.find((m) => m.key === key)?.current;

  it('company A: revenue by Eastern delivery day, TONU apart, demo excluded, costs from its own rows', async () => {
    const res = await analytics.executive(principal(A), 'custom', '2026-10-12', '2026-10-18');
    expect(value(res.metrics, 'linehaul')).toBe(2000);
    expect(value(res.metrics, 'accessorials')).toBe(100);
    expect(value(res.metrics, 'tonu')).toBe(200);
    expect(value(res.metrics, 'gross')).toBe(2300);
    expect(value(res.metrics, 'miles')).toBe(1000);
    expect(value(res.metrics, 'linehaulRpm')).toBe(2);
    // 300 truck repair + 450 trailer repair + 25 parking; never B's $5,555.
    expect(value(res.metrics, 'cost')).toBe(775);
    expect(value(res.metrics, 'profit')).toBe(2300 - 775);
    expect(res.dataStatus.revenue.loadsOnFile).toBe(2);
  });

  it('trailer repairs stay off the truck; manual Fleet expenses reach it', async () => {
    const res = await analytics.truckRanking(principal(A), 'custom', '2026-10-12', '2026-10-18');
    expect(res.rows.map((r) => r.id)).toEqual([`trk_a_${tag}`]);
    expect(res.rows[0]!.cost).toBe(325);
    const costs = await analytics.costDrivers(principal(A), 'custom', '2026-10-12', '2026-10-18');
    expect(costs.byTrailer).toEqual([{ trailerId: `trl_a_${tag}`, unitNumber: 'TA1', amount: 450, orders: 1 }]);
  });

  it('company B never sees A, and A never sees B', async () => {
    const res = await analytics.executive(principal(B), 'custom', '2026-10-12', '2026-10-18');
    expect(value(res.metrics, 'gross')).toBe(7777);
    expect(value(res.metrics, 'cost')).toBe(5555);
    const trucksB = await analytics.truckRanking(principal(B), 'custom', '2026-10-12', '2026-10-18');
    expect(trucksB.rows.map((r) => r.id)).toEqual([`trk_b_${tag}`]);
  });

  it('a 23:30 ET delivery is not in the following week', async () => {
    const res = await analytics.executive(principal(A), 'custom', '2026-10-19', '2026-10-25');
    expect(value(res.metrics, 'linehaul')).toBe(0);
  });

  it('workforce: drivers = working roster, staff = employees with no driver, candidates = open non-test leads', async () => {
    const wf = await analytics.workforce(principal(A));
    expect(wf.drivers).toBe(2); // available + vacation; not onboarding, not terminated
    expect(wf.driversOnboarding).toBe(1);
    expect(wf.staff).toBe(1); // emp_a1 (emp_a2 is a driver, emp_a3 terminated)
    expect(wf.headcount).toBe(3);
    expect(wf.candidatesInPipeline).toBe(2);
    const wfB = await analytics.workforce(principal(B));
    expect(wfB.drivers).toBe(1);
    expect(wfB.candidatesInPipeline).toBe(1);
  });
});
