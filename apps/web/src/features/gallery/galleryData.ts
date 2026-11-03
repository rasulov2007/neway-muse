/**
 * Demo-derived data for the gallery. Everything is deterministic (demoData is seeded) and sized
 * for a fast page: <= 50 table rows, <= 90 chart points.
 */
import { format } from 'date-fns';
import { DEMO_NOW, demoData, type Driver, type Load, type Truck } from '@/demo';
import type { StatusCode } from '@/design-system';

export const GALLERY_NOW = DEMO_NOW;

export const galleryTrucks: Truck[] = demoData.trucks.slice(0, 25);
export const galleryDrivers: Driver[] = demoData.drivers.slice(0, 12);
export const galleryLoads: Load[] = demoData.loads.slice(0, 8);

export const heroTruck: Truck =
  demoData.trucks.find((t) => t.unitNumber === '2785') ?? must(demoData.trucks[0]);
export const heroLoad: Load =
  demoData.loads.find((l) => l.loadNumber === 'L-100245') ?? must(demoData.loads[0]);
export const heroDriver: Driver = must(demoData.drivers[0]);

export const driverOptions = galleryDrivers.map((d) => ({
  value: d.id,
  label: d.name,
  description: `${d.driverNumber} · ${d.currentTruckUnit ? `Unit ${d.currentTruckUnit}` : 'No unit'}`,
}));

export const truckOptions = galleryTrucks.map((t) => ({
  value: t.id,
  label: `Unit ${t.unitNumber}`,
  description: `${t.year} ${t.make} ${t.model}`,
}));

export const brokerOptions = demoData.brokers.slice(0, 8).map((b) => ({
  value: b.id,
  label: b.name,
}));

/** Last 30 days of daily revenue/profit (<= 90 points across two series). */
export const revenueProfitSeries = demoData.series.dailyRevenueProfit.slice(-30).map((p) => ({
  date: p.date,
  revenue: Math.round(p.revenue),
  profit: Math.round(p.profit),
}));

export const fuelCostSeries = demoData.series.weeklyFuelCost.slice(-12).map((p) => ({
  week: p.date,
  cost: Math.round(p.value),
}));

export const loadStatusCounts = demoData.series.loadStatus;
export const fleetHealthCounts = demoData.series.fleetHealth;

/** Weekly revenue for a sparkline (12 points). */
export const revenueSparkline: number[] = (() => {
  const daily = demoData.series.dailyRevenueProfit.slice(-84);
  const weeks: number[] = [];
  for (let i = 0; i < daily.length; i += 7) {
    weeks.push(daily.slice(i, i + 7).reduce((sum, p) => sum + p.revenue, 0));
  }
  return weeks;
})();

/** Loads per day by lane, for the stacked bar example. */
export const lanesByDay = Array.from({ length: 7 }, (_, i) => {
  const date = new Date(GALLERY_NOW);
  date.setDate(date.getDate() - (6 - i));
  const seed = (i + 1) * 7;
  return {
    day: format(date, 'EEE'),
    midwest: 4 + (seed % 5),
    southeast: 2 + (seed % 4),
    west: 1 + (seed % 3),
  };
});

/** Miles by driver, for the horizontal bar example. */
export const milesByDriver = galleryDrivers.slice(0, 6).map((d, i) => ({
  driver: d.name,
  miles: 2400 + ((i * 613) % 1900),
}));

export const galleryActivity = demoData.activity.slice(0, 6);
export const galleryTimeline = heroLoad.timeline.slice(0, 6);

export const TRUCK_STATUSES: StatusCode[] = [
  'active',
  'driving',
  'available',
  'idle',
  'in_shop',
  'out_of_service',
  'maintenance',
];

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('Demo data is empty');
  return value;
}
