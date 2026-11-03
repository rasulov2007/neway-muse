import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Principal } from '../src/common/auth/principal';
import { createApp } from '../src/app.factory';
import { DatabaseService } from '../src/database/database.service';
import { acctVendorArrangements } from '../src/database/schema/accounting';
import { fleetExpenses, vendors, workOrders } from '../src/database/schema/fleet';
import { loads } from '../src/database/schema/loads';
import { auditLogs } from '../src/database/schema/people';
import { companies, trucks } from '../src/database/schema/roster';
import { PayablesService } from '../src/modules/accounting/payables.service';
import { AnalyticsService } from '../src/modules/reports/analytics.service';
import { TrucksService } from '../src/modules/roster/trucks.service';

/**
 * Vendor trucks (owner, 2026-10-28), end to end over database rows.
 *
 * Unit V1 goes to a vendor on Oct 10 with the company keeping 20% of its gross. Its loads from then
 * count at 20% in company revenue; its repairs and expenses leave company costs; a repair the vendor
 * paid the shop for is no one's company money at all; the Vendor section shows the whole truck.
 * Unit C1 is an ordinary company truck beside it.
 */
describe('Vendor trucks (e2e, database)', () => {
  let app: NestFastifyApplication;
  let analytics: AnalyticsService;
  let trucksService: TrucksService;
  const tag = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const CO = `co_e2e_vend_${tag}`;
  const V = `trk_v_${tag}`;
  const C = `trk_c_${tag}`;
  const principal: Principal = {
    userId: 'e2e',
    userName: 'E2E Fleet',
    companyId: CO,
    companyTimezone: 'America/New_York',
    weekStart: 1,
    roles: [],
    permissions: new Set(['analytics.view', 'trucks.edit', 'accounting.view', 'accounting.edit']),
  } as Principal;

  const truck = (id: string, unit: string) => ({
    id,
    companyId: CO,
    unitNumber: unit,
    vin: `VIN${id}`.padEnd(17, '0').slice(0, 17),
    year: 2022,
    make: 'Freightliner',
    model: 'Cascadia',
    status: 'available',
    health: 'healthy',
    ownership: 'owned',
    odometer: 1000,
    odometerAt: new Date('2026-10-01T00:00:00Z'),
    engineHours: '10',
    nextServiceOdometer: 20000,
    nextServiceDate: '2027-01-01',
    nextServiceType: 'pm_service',
    telematicsProvider: 'none',
    telematicsStatus: 'disconnected',
  });
  const loadRow = (id: string, record: Record<string, unknown>) => ({
    id,
    companyId: CO,
    loadNumber: id,
    status: String(record.status),
    isDemo: false,
    record: { id, loadNumber: id, truckId: null, driverId: null, loadedMiles: 500, emptyMiles: 0, rate: 0, charges: [], stops: [], ...record },
  });
  const wo = (id: string, unitId: string, unit: string, day: string, amount: string, chargeParty: string) => ({
    id,
    companyId: CO,
    number: id,
    assetType: 'truck',
    unitId,
    unitNumber: unit,
    status: 'completed',
    workType: 'repair',
    shopInAt: new Date(`${day}T12:00:00Z`),
    completedAt: new Date(`${day}T18:00:00Z`),
    total: amount,
    invoiceTotal: amount,
    vendorId: `ven_shop_${tag}`,
    vendorName: 'E2E Shop',
    chargeParty,
  });

  beforeAll(async () => {
    app = await createApp();
    await app.init();
    const db = app.get(DatabaseService).db;
    await db.insert(companies).values([{ id: CO, name: 'E2E vendor trucks' }] as (typeof companies.$inferInsert)[]);
    await db.insert(trucks).values([truck(V, 'V1'), truck(C, 'C1')] as never);
    await db.insert(vendors).values([{ id: `ven_shop_${tag}`, companyId: CO, name: 'E2E Shop', kind: 'shop' }] as never);
    await db.insert(loads).values([
      // Before the vendor: the company's own load, counted whole.
      loadRow(`ld_before_${tag}`, { status: 'delivered', truckId: V, rate: 1000, deliveredAt: '2026-10-05T15:00:00Z', charges: [{ type: 'linehaul', amount: 1000, billable: true }] }),
      // A vendor load: 3,000 linehaul + 200 detention = 3,200 gross; the company keeps 640.
      loadRow(`ld_vendor_${tag}`, { status: 'delivered', truckId: V, rate: 3000, deliveredAt: '2026-10-14T15:00:00Z', charges: [{ type: 'linehaul', amount: 3000, billable: true }, { type: 'detention', amount: 200, billable: true, status: 'accepted' }] }),
      loadRow(`ld_company_${tag}`, { status: 'delivered', truckId: C, rate: 4000, deliveredAt: '2026-10-14T15:00:00Z', charges: [{ type: 'linehaul', amount: 4000, billable: true }] }),
      // After the truck came back to the company: whole again.
      loadRow(`ld_after_${tag}`, { status: 'delivered', truckId: V, rate: 2000, deliveredAt: '2026-10-25T15:00:00Z', charges: [{ type: 'linehaul', amount: 2000, billable: true }] }),
    ] as never);
    await db.insert(workOrders).values([
      // Vendor pays: the vendor paid the shop - in nobody's company numbers.
      wo(`wo_vpays_${tag}`, V, 'V1', '2026-10-13', '500.00', 'vendor'),
      // Company paid the shop for the vendor's truck: the vendor's cost, not the company's.
      wo(`wo_vtruck_${tag}`, V, 'V1', '2026-10-15', '300.00', 'company'),
      wo(`wo_ctruck_${tag}`, C, 'C1', '2026-10-15', '200.00', 'company'),
    ] as never);
    await db.insert(fleetExpenses).values([
      { id: `fx_v_${tag}`, companyId: CO, reference: `EXPV-${tag}`, status: 'recorded', truckId: V, unitNumber: 'V1', category: 'parking', expenseDate: '2026-10-16', amountCents: 2500, paidBy: 'company', chargeTo: 'company', createdBy: 'e2e', updatedBy: 'e2e' },
    ] as never);
    analytics = app.get(AnalyticsService);
    trucksService = app.get(TrucksService);
  }, 120_000);

  afterAll(async () => {
    await app?.close();
  });

  const value = (metrics: { key: string; current: number | null }[], key: string) => metrics.find((m) => m.key === key)?.current;

  it('Move to vendor adds the vendor, the arrangement and the audit line, and the truck says so', async () => {
    const before = await trucksService.get(principal, V);
    expect(before.vendor).toBeNull();
    const moved = await trucksService.moveToVendor(principal, V, { vendorName: 'E2E Vendor Ali', companyPercent: 20, effectiveFrom: '2026-10-10', expectedUpdatedAt: before.updatedAt });
    expect(moved.ownership).toBe('vendor');
    expect(moved.vendor).toMatchObject({ vendorName: 'E2E Vendor Ali', companyPercent: 20, since: '2026-10-10' });
    const db = app.get(DatabaseService).db;
    const [arr] = await db.select().from(acctVendorArrangements).where(eq(acctVendorArrangements.truckId, V));
    // The column keeps meaning the vendor's share, which VT statements pay from.
    expect(arr?.percentBps).toBe(8000);
    expect((arr?.record as { companyPercentBps: number }).companyPercentBps).toBe(2000);
    const [ven] = await db.select().from(vendors).where(eq(vendors.id, arr!.vendorId));
    expect(ven).toMatchObject({ name: 'E2E Vendor Ali', kind: 'truck_owner' });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, V));
    expect(audit.some((a) => a.action === 'move_to_vendor')).toBe(true);
    const list = await trucksService.list(principal, { page: 1, pageSize: 50 } as never);
    expect(list.data.find((t) => t.id === V)?.vendor?.vendorName).toBe('E2E Vendor Ali');
    expect(list.data.find((t) => t.id === C)?.vendor).toBeNull();
  });

  it('a stale truck and a second vendor from the same day are refused', async () => {
    await expect(trucksService.moveToVendor(principal, V, { vendorName: 'X', companyPercent: 10, effectiveFrom: '2026-10-11', expectedUpdatedAt: '2020-01-01T00:00:00.000Z' })).rejects.toMatchObject({ status: 409 });
    const now = await trucksService.get(principal, V);
    await expect(trucksService.moveToVendor(principal, V, { vendorName: 'Y', companyPercent: 10, effectiveFrom: '2026-10-10', expectedUpdatedAt: now.updatedAt })).rejects.toMatchObject({ status: 409 });
  });

  it('company numbers: the vendor truck counts at 20%, its costs are out, Vendor pays is nowhere', async () => {
    const res = await analytics.executive(principal, 'custom', '2026-10-01', '2026-10-20');
    // 1,000 (before) + 640 (20% of 3,200) + 4,000 (company truck).
    expect(value(res.metrics, 'gross')).toBe(5640);
    // Only the company truck's 200 repair: not V1's 300 + 25 (vendor's), not the 500 Vendor pays.
    expect(value(res.metrics, 'cost')).toBe(200);
    expect(value(res.metrics, 'profit')).toBe(5440);
  });

  it('the Vendor section shows the whole truck, adding up to its gross', async () => {
    const money = await analytics.vendors(principal, 'custom', '2026-10-01', '2026-10-20');
    expect(money.trucks).toHaveLength(1);
    const t = money.trucks[0]!;
    expect(t).toMatchObject({ unitNumber: 'V1', vendorName: 'E2E Vendor Ali', companyPercent: 20, loads: 1, gross: 3200, companyShare: 640, driverPay: 0, truckCosts: 325, vendorNet: 2235 });
    expect(t.companyShare + t.driverPay + t.truckCosts + t.vendorNet).toBe(t.gross);
  });

  it('a Vendor pays repair is never offered to Accounts Payable as a company bill', async () => {
    const candidates = await app.get(PayablesService).workOrderBillCandidates(principal);
    const vendorPays = candidates.find((c) => c.workOrderId === `wo_vpays_${tag}`);
    expect(vendorPays?.problems.join(' ')).toMatch(/Vendor pays/);
    const res = await app.get(PayablesService).createBillsFromWorkOrders(principal, [`wo_vpays_${tag}`]);
    expect(res.created).toHaveLength(0);
  });

  it('Edit percentage: from a day on the new share counts; the same day corrects it in place', async () => {
    const db = app.get(DatabaseService).db;
    let truck = await trucksService.get(principal, V);
    truck = await trucksService.changeVendorPercent(principal, V, { companyPercent: 30, effectiveFrom: '2026-10-14', expectedUpdatedAt: truck.updatedAt });
    expect(truck.vendor).toMatchObject({ companyPercent: 30, since: '2026-10-14' });
    let rows = await db.select().from(acctVendorArrangements).where(eq(acctVendorArrangements.truckId, V));
    expect(rows.map((r) => [String(r.effectiveFrom), r.effectiveTo ? String(r.effectiveTo) : null]).sort()).toEqual([['2026-10-10', '2026-10-13'], ['2026-10-14', null]]);
    expect((await analytics.vendors(principal, 'custom', '2026-10-01', '2026-10-20')).totals.companyShare).toBe(960);
    const exec = await analytics.executive(principal, 'custom', '2026-10-01', '2026-10-20');
    expect(value(exec.metrics, 'gross')).toBe(1000 + 960 + 4000);
    // Same day as the arrangement began: corrected in place, no third row.
    truck = await trucksService.changeVendorPercent(principal, V, { companyPercent: 20, effectiveFrom: '2026-10-14', expectedUpdatedAt: truck.updatedAt });
    rows = await db.select().from(acctVendorArrangements).where(eq(acctVendorArrangements.truckId, V));
    expect(rows).toHaveLength(2);
    expect((await analytics.vendors(principal, 'custom', '2026-10-01', '2026-10-20')).totals.companyShare).toBe(640);
    await expect(trucksService.changeVendorPercent(principal, V, { companyPercent: 10, effectiveFrom: '2026-10-01', expectedUpdatedAt: truck.updatedAt })).rejects.toMatchObject({ status: 422 });
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.entityId, V));
    expect(audit.filter((x) => x.action === 'vendor_percent')).toHaveLength(2);
  });

  it('Move back to the company: loads after the last vendor day count whole again', async () => {
    const now = await trucksService.get(principal, V);
    const back = await trucksService.endVendor(principal, V, { effectiveTo: '2026-10-20', reason: 'Vendor took the truck home', expectedUpdatedAt: now.updatedAt });
    expect(back.ownership).toBe('owned');
    expect(back.vendor).toBeNull();
    const after = await analytics.executive(principal, 'custom', '2026-10-21', '2026-10-31');
    expect(value(after.metrics, 'gross')).toBe(2000);
    // The vendor days keep their split.
    const vendorDays = await analytics.vendors(principal, 'custom', '2026-10-01', '2026-10-31');
    expect(vendorDays.totals.companyShare).toBe(640);
  });
});
