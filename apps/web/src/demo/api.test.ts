import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
// The scheduler is mocked so the suite can assert *when* a save is asked for, and never waits on
// a real timer or touches the workspace snapshot.
const saveSoon = vi.hoisted(() => vi.fn());
vi.mock('./state-persist', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./state-persist')>()),
  saveSoon,
}));

import { demoData } from './data';
import type { Load } from './types';
import {
  demoCompany,
  demoMemberships,
  demoUsers,
  getDashboard,
  getLoad,
  getTruck,
  globalSearch,
  listDrivers,
  listFuelTransactions,
  listInvoices,
  listLoads,
  listMaintenance,
  listNotifications,
  listSafetyEvents,
  listServiceRecords,
  listTrucks,
  markNotificationRead,
  setDemoLatency,
  updateLoad,
} from './api';

beforeAll(() => setDemoLatency(false));
afterAll(() => setDemoLatency(true));

describe('demo api', () => {
  it('paginates and reports totals', async () => {
    const page1 = await listTrucks({ page: 1, pageSize: 10 });
    const page2 = await listTrucks({ page: 2, pageSize: 10 });
    expect(page1.total).toBe(60);
    expect(page1.data).toHaveLength(10);
    expect(page2.data).toHaveLength(10);
    expect(page1.data[0]?.id).not.toBe(page2.data[0]?.id);
    const last = await listTrucks({ page: 6, pageSize: 10 });
    expect(last.data).toHaveLength(10);
    const beyond = await listTrucks({ page: 7, pageSize: 10 });
    expect(beyond.data).toHaveLength(0);
    expect(beyond.total).toBe(60);
  });

  it('searches, filters and sorts', async () => {
    const byUnit = await listTrucks({ search: '2785' });
    expect(byUnit.total).toBe(1);
    expect(byUnit.data[0]?.unitNumber).toBe('2785');
    const inShop = await listTrucks({ status: 'in_shop' });
    expect(inShop.total).toBe(4);
    expect(inShop.data.every((t) => t.status === 'in_shop')).toBe(true);
    const sorted = await listTrucks({ sort: 'odometer', sortDir: 'desc', pageSize: 60 });
    const odometers = sorted.data.map((t) => t.odometer);
    expect(odometers).toEqual([...odometers].sort((a, b) => b - a));
    const drivers = await listDrivers({ search: 'whitaker' });
    expect(drivers.data[0]?.name).toBe('Darnell Whitaker');
  });

  it('gets single entities by id or business key', async () => {
    const byUnit = await getTruck('2785');
    const byId = await getTruck('trk_2785');
    expect(byUnit?.id).toBe('trk_2785');
    expect(byId?.unitNumber).toBe('2785');
    expect(await getTruck('nope')).toBeNull();
    const load = await getLoad('L-100245');
    expect(load?.id).toBe('ld_100245');
    expect((await getLoad('ld_100245'))?.loadNumber).toBe('L-100245');
  });

  it('returns copies so callers cannot mutate the dataset', async () => {
    const first = await getTruck('2785');
    if (first) first.odometer = 1;
    const second = await getTruck('2785');
    expect(second?.odometer).toBe(421_500);
  });

  it('filters loads, maintenance, service and safety by entity', async () => {
    const active = await listLoads({ activeOnly: true, pageSize: 50 });
    expect(active.total).toBe(15);
    const exceptions = await listLoads({ exceptionsOnly: true });
    expect(exceptions.total).toBe(4);
    const overdue = await listMaintenance({ status: 'overdue', pageSize: 50 });
    expect(overdue.total).toBe(9);
    const service = await listServiceRecords({ truckId: 'trk_2785' });
    expect(service.data.every((r) => r.truckId === 'trk_2785')).toBe(true);
    expect(service.total).toBeGreaterThanOrEqual(3);
    const events = await listSafetyEvents({ driverId: 'drv_2091', pageSize: 50 });
    expect(events.total).toBeGreaterThanOrEqual(12);
    const anomalies = await listFuelTransactions({ anomaliesOnly: true });
    expect(anomalies.total).toBeGreaterThanOrEqual(4);
    const overdueInvoices = await listInvoices({ status: 'overdue' });
    expect(overdueInvoices.data.every((i) => i.agingDays > 0)).toBe(true);
  });

  it('supports simulate options', async () => {
    await expect(listTrucks({ simulate: 'error' })).rejects.toThrow('Simulated failure');
    await expect(getDashboard({ simulate: 'error' })).rejects.toThrow('Simulated failure');
    const empty = await listTrucks({ simulate: 'empty' });
    expect(empty.data).toHaveLength(0);
    expect(empty.total).toBe(0);
    expect(await getTruck('2785', { simulate: 'empty' })).toBeNull();
    const search = await globalSearch('2785', { simulate: 'empty' });
    expect(search.total).toBe(0);
    const slow = await listTrucks({ simulate: 'slow', pageSize: 1 });
    expect(slow.total).toBe(60);
  });

  it('builds the dashboard payload', async () => {
    const dashboard = await getDashboard();
    expect(dashboard.kpis.totalTrucks.value).toBe(60);
    expect(dashboard.series.dailyRevenueProfit).toHaveLength(90);
    expect(dashboard.atRiskLoads.length).toBe(4);
    expect(dashboard.upcomingMaintenance.length).toBeGreaterThan(0);
    expect(dashboard.upcomingMaintenance[0]?.status).toBe('overdue');
    expect(dashboard.pendingTasks.length).toBeLessThanOrEqual(8);
    expect(dashboard.recentLoads).toHaveLength(8);
    expect(dashboard.criticalAlerts.every((n) => n.severity === 'critical')).toBe(true);
  });

  it('groups global search results with at most five per group', async () => {
    const result = await globalSearch('27');
    expect(result.trucks.length).toBeLessThanOrEqual(5);
    expect(result.trucks.length).toBeGreaterThan(0);
    const load = await globalSearch('L-100245');
    expect(load.loads[0]?.label).toBe('L-100245');
    const invoice = await globalSearch('INV-2026-10412');
    expect(invoice.invoices).toHaveLength(1);
    const people = await globalSearch('Sarah Chen');
    expect(people.employees[0]?.label).toBe('Sarah Chen');
    const broker = await globalSearch('Blue Ridge');
    expect(broker.brokers[0]?.label).toBe('Blue Ridge Freight Brokers');
  });

  it('marks notifications read', async () => {
    const before = await listNotifications({ unreadOnly: true });
    const target = before.data[0];
    expect(target).toBeDefined();
    if (!target) return;
    const updated = await markNotificationRead(target.id);
    expect(updated?.readAt).not.toBeNull();
    const after = await listNotifications({ unreadOnly: true });
    expect(after.total).toBe(before.total - 1);
  });

  it('exposes company, users and memberships', () => {
    expect(demoCompany.name).toBe('Northwind Freight');
    expect(demoUsers[0]?.name).toBe('Sarah Chen');
    expect(demoUsers[0]?.title).toBe('Operations Manager');
    expect(demoMemberships.map((m) => m.companyName)).toEqual([
      'Northwind Freight',
      'Lakeside Carriers',
      'Summit Express',
    ]);
    expect(demoMemberships.filter((m) => m.isCurrent)).toHaveLength(1);
  });

  /*
   * The status rules moved to the server (P1) and are tested in `@neway/shared` loads/progress.
   * What this layer owes is a closed door, which `load-paperwork.test.ts` asserts.
   */
});
