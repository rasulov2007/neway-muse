import { describe, expect, it } from 'vitest';
import { STATUS } from '@/design-system/status';
import {
  DEMO_SEED,
  HERO_LOAD_NUMBER,
  TRENDING_DRIVER_ID,
  demoData,
  generateDemoData,
} from './data';

const round2 = (n: number) => Math.round(n * 100) / 100;

describe('demo data generator', () => {
  it('is deterministic for the same seed', () => {
    const a = generateDemoData(DEMO_SEED);
    const b = generateDemoData(DEMO_SEED);
    expect(a.loads[0]).toEqual(b.loads[0]);
    expect(a.trucks.map((t) => t.vin)).toEqual(b.trucks.map((t) => t.vin));
    expect(JSON.stringify(a.fuelTransactions)).toBe(JSON.stringify(b.fuelTransactions));
    const c = generateDemoData(DEMO_SEED + 1);
    expect(c.trucks.map((t) => t.vin)).not.toEqual(a.trucks.map((t) => t.vin));
  });

  it('generates quickly', () => {
    const start = performance.now();
    generateDemoData();
    expect(performance.now() - start).toBeLessThan(250);
  });

  it('produces the expected entity counts', () => {
    expect(demoData.trucks).toHaveLength(60);
    expect(demoData.trailers).toHaveLength(45);
    expect(demoData.drivers).toHaveLength(70);
    expect(demoData.customers).toHaveLength(12);
    expect(demoData.brokers).toHaveLength(15);
    expect(demoData.facilities).toHaveLength(20);
    expect(demoData.loads).toHaveLength(120);
    expect(demoData.repairOrders).toHaveLength(25);
    expect(demoData.serviceRecords).toHaveLength(200);
    expect(demoData.fuelTransactions).toHaveLength(400);
    expect(demoData.safetyEvents).toHaveLength(150);
    expect(demoData.invoices).toHaveLength(60);
    expect(demoData.notifications).toHaveLength(25);
    expect(demoData.tasks).toHaveLength(18);
    expect(demoData.activity).toHaveLength(40);
    expect(demoData.aiInsights).toHaveLength(10);
    expect(demoData.series.dailyRevenueProfit).toHaveLength(90);
    expect(demoData.series.weeklyFuelCost).toHaveLength(13);
  });

  it('has the hero load with exact financials', () => {
    const hero = demoData.loads.find((l) => l.loadNumber === HERO_LOAD_NUMBER);
    expect(hero).toBeDefined();
    if (!hero) return;
    expect(hero.status).toBe('in_transit');
    expect(hero.truckUnit).toBe('2785');
    expect(hero.origin).toEqual({ city: 'Chicago', state: 'IL' });
    expect(hero.destination).toEqual({ city: 'Dallas', state: 'TX' });
    expect(hero.stops).toHaveLength(2);
    expect(hero.brokerName).toBe('Prime Logistics Group');
    expect(hero.loadedMiles).toBe(1000);
    const f = hero.financials;
    expect(f).toEqual({
      revenue: 2500,
      fuel: 480,
      driverPay: 650,
      tolls: 100,
      maintenanceAllocation: 150,
      other: 70,
      grossProfit: 1050,
      rpm: 2.5,
      costPerMile: 1.45,
      profitPerMile: 1.05,
    });
    expect(f).not.toBeNull();
    if (!f) throw new Error('hero load must have booked financials');
    expect(
      round2(f.revenue - f.fuel - f.driverPay - f.tolls - f.maintenanceAllocation - f.other),
    ).toBe(f.grossProfit);
    expect(hero.charges.reduce((sum, c) => sum + c.amount, 0)).toBe(2500);
    expect(hero.timeline.map((e) => e.kind)).toEqual(
      expect.arrayContaining([
        'booked',
        'assigned',
        'dispatched',
        'arrived',
        'loaded',
        'departed',
        'eta_changed',
      ]),
    );
    expect(hero.notes.length).toBeGreaterThanOrEqual(1);
    expect(hero.documents.map((d) => d.type)).toEqual(
      expect.arrayContaining(['rate_confirmation', 'bol', 'pod']),
    );
  });

  it('keeps every load financial breakdown consistent', () => {
    for (const load of demoData.loads) {
      const f = load.financials;
      // Every seeded load has costs booked; a load created through the app does not, and is not
      // part of this dataset.
      expect(f).not.toBeNull();
      if (!f) continue;
      expect(
        round2(f.revenue - f.fuel - f.driverPay - f.tolls - f.maintenanceAllocation - f.other),
      ).toBe(f.grossProfit);
      expect(round2(load.expenses.reduce((sum, e) => sum + e.amount, 0))).toBe(
        round2(f.fuel + f.driverPay + f.tolls + f.maintenanceAllocation + f.other),
      );
      expect(load.stops.length).toBeGreaterThanOrEqual(2);
      expect(load.stops.length).toBeLessThanOrEqual(4);
      if (load.status !== 'cancelled' && load.status !== 'tonu') {
        expect(load.rate).toBeGreaterThanOrEqual(900);
        expect(load.rate).toBeLessThanOrEqual(6800);
      }
    }
  });

  it('uses only status codes from the design-system STATUS map', () => {
    const codes = new Set(Object.keys(STATUS));
    const check = (code: string) => expect(codes.has(code), `unknown status ${code}`).toBe(true);
    demoData.trucks.forEach((t) => {
      check(t.status);
      check(t.health);
      check(t.telematicsStatus);
    });
    demoData.trailers.forEach((t) => check(t.status));
    demoData.drivers.forEach((d) => {
      check(d.status);
      check(d.cdlStatus);
      check(d.medicalCardStatus);
    });
    demoData.loads.forEach((l) => {
      check(l.status);
      if (l.exception) check(l.exception.code);
      l.stops.forEach((s) => check(s.status));
      l.documents.forEach((d) => check(d.status));
    });
    demoData.maintenance.forEach((m) => check(m.status));
    demoData.repairOrders.forEach((r) => check(r.status));
    demoData.fuelTransactions.forEach((f) => check(f.status));
    demoData.safetyEvents.forEach((e) => check(e.status));
    demoData.invoices.forEach((i) => check(i.status));
    demoData.tasks.forEach((t) => check(t.status));
    demoData.aiInsights.forEach((i) => check(i.status));
    // Severities are semantic tones (critical/warning/info/success), not status codes.
    const severities = new Set(['critical', 'warning', 'info', 'success']);
    demoData.notifications.forEach((n) => expect(severities.has(n.severity)).toBe(true));
    demoData.aiInsights.forEach((i) => expect(severities.has(i.severity)).toBe(true));
    demoData.series.fleetHealth.forEach((s) => check(s.status));
    demoData.series.loadStatus.forEach((s) => check(s.status));
  });

  it('includes the story units', () => {
    const byUnit = new Map(demoData.trucks.map((t) => [t.unitNumber, t]));
    const u2785 = byUnit.get('2785');
    expect(u2785?.status).toBe('active');
    expect(u2785?.odometer).toBe(421_500);
    expect(u2785?.nextServiceOdometer).toBe(424_000);
    expect(u2785?.location?.city).toBe('Dallas');
    expect(u2785?.currentDriverName).toBe('Darnell Whitaker');
    expect(
      demoData.repairOrders.filter((r) => r.unitNumber === '2785' && r.type === 'brake_repair'),
    ).toHaveLength(3);

    const u3012 = byUnit.get('3012');
    expect(u3012?.mpg90d).toBe(6.9);
    expect(u3012?.mpg30d).toBe(5.93);
    expect(u3012?.idlePercent30d).toBeGreaterThan(u3012?.idlePercent90d ?? 0);
    expect(
      demoData.serviceRecords.filter((r) => r.unitNumber === '3012' && r.type === 'engine').length,
    ).toBeGreaterThanOrEqual(2);

    expect(
      demoData.maintenance.some((m) => m.unitNumber === '3091' && m.status === 'overdue'),
    ).toBe(true);
    expect(byUnit.get('3120')?.status).toBe('in_shop');
    expect(demoData.trucks.every((t) => t.vin.length === 17 && !/[IOQ]/.test(t.vin))).toBe(true);
    expect(demoData.trucks.every((t) => t.unitNumber >= '2701')).toBe(true);
  });

  it('distributes statuses and stories as specified', () => {
    const count = (status: string) => demoData.trucks.filter((t) => t.status === status).length;
    expect(count('active') + count('driving')).toBe(38);
    expect(count('available')).toBe(6);
    expect(count('idle')).toBe(5);
    expect(count('in_shop')).toBe(4);
    expect(count('out_of_service')).toBe(3);
    expect(count('maintenance')).toBe(2);
    expect(count('accident')).toBe(1);
    expect(count('sold')).toBe(1);

    const active = demoData.loads.filter(
      (l) => !['delivered', 'closed', 'cancelled', 'tonu'].includes(l.status),
    );
    expect(active).toHaveLength(15);
    expect(active.filter((l) => l.exception !== null)).toHaveLength(4);

    expect(demoData.maintenance.filter((m) => m.status === 'overdue')).toHaveLength(9);
    expect(demoData.maintenance.filter((m) => m.status === 'due_soon')).toHaveLength(14);
    expect(
      demoData.trucks
        .filter((t) => t.status !== 'sold')
        .every((t) => demoData.maintenance.some((m) => m.truckId === t.id)),
    ).toBe(true);

    expect(
      demoData.fuelTransactions.filter((f) => f.anomalyFlags.length > 0).length,
    ).toBeGreaterThanOrEqual(4);
    const trending = demoData.safetyEvents.filter((e) => e.driverId === TRENDING_DRIVER_ID);
    expect(trending.length).toBeGreaterThanOrEqual(12);
    expect(
      demoData.drivers.filter((d) => d.medicalCardStatus === 'expiring').length,
    ).toBeGreaterThanOrEqual(3);
    expect(new Set(demoData.invoices.map((i) => i.status))).toEqual(
      new Set(['draft', 'issued', 'sent', 'paid', 'partially_paid', 'overdue', 'disputed']),
    );
  });

  it('builds series that back the AI insight numbers', () => {
    const sum = (prefix: string) =>
      demoData.series.dailyRevenueProfit
        .filter((p) => p.date.startsWith(prefix))
        .reduce((a, p) => a + p.revenue, 0);
    expect(round2((sum('2026-08') / sum('2026-07') - 1) * 100)).toBeCloseTo(6.4, 1);
    const weeks = demoData.series.weeklyFuelCost;
    const recent = weeks.slice(9).reduce((a, p) => a + p.value, 0);
    const prior = weeks.slice(5, 9).reduce((a, p) => a + p.value, 0);
    expect(round2((recent / prior - 1) * 100)).toBeCloseTo(8.2, 1);
    expect(demoData.kpis.totalTrucks.value).toBe(60);
    expect(demoData.kpis.activeLoads.value).toBe(15);
    expect(demoData.series.fleetHealth.reduce((a, s) => a + s.count, 0)).toBe(59);
  });
});
