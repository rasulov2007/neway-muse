/**
 * Deterministic demo implementation of `ReportingDataSource` (docs/DASHBOARD.md §2).
 *
 * A pinned dataset for one company (Northwind Freight) covering May 1 – Sep 30, 2026 is generated
 * once from a seeded PRNG (mulberry32, seed 20260906) and cached; `facts()` filters it by date.
 * The dataset deliberately contains the situations the dashboard must handle honestly: a week
 * with no expense data, trucks with costs but no revenue, revenue lines missing a truck or a
 * driver, drivers whose pay tag cannot be classified, and driver-pay estimates.
 */
import { Injectable } from '@nestjs/common';
import type {
  DateRange,
  DispatchTeamWeek,
  DriverFact,
  DriverPayType,
  ExpenseCoverage,
  ExpenseLine,
  FuelTransactionFact,
  IsoDate,
  MileageRecord,
  ReportingDataSource,
  ReportingFacts,
  RevenueLine,
  TruckFact,
  TruckStatus,
} from '../facts';
import {
  DEMO_COMPANY,
  DEMO_DATASET_RANGE,
  DEMO_TODAY,
  DEMO_WEEK_WITHOUT_EXPENSES,
} from './demo-company';

/** Seed for the demo PRNG; changing it changes every generated number. */
export const DEMO_SEED = 20260906;

/** Everything the demo source holds for the company, before date filtering. */
export interface DemoDataset {
  revenue: RevenueLine[];
  expenses: ExpenseLine[];
  fuel: FuelTransactionFact[];
  mileage: MileageRecord[];
  trucks: TruckFact[];
  drivers: DriverFact[];
  dispatchWeeks: DispatchTeamWeek[];
  expenseCoverage: ExpenseCoverage[];
  /** Reporting week starts (Mondays) covering the dataset window. */
  weekStarts: IsoDate[];
}

interface DemoTruck extends TruckFact {
  teamId: string | null;
}

interface DemoTeam {
  teamId: string;
  teamName: string;
}

// ---------------------------------------------------------------------------------------------
// Small deterministic helpers
// ---------------------------------------------------------------------------------------------

/** mulberry32: tiny seeded PRNG returning floats in [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DAY_MS = 86_400_000;

function toDayNumber(date: IsoDate): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1) / DAY_MS);
}

function fromDayNumber(day: number): IsoDate {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** Adds `days` calendar days to an ISO date. */
export function addDays(date: IsoDate, days: number): IsoDate {
  return fromDayNumber(toDayNumber(date) + days);
}

/** Monday-based reporting week start for a date. */
export function weekStartOf(date: IsoDate): IsoDate {
  const day = toDayNumber(date);
  const dow = (day + 4) % 7; // 1970-01-01 was a Thursday; 0 = Sunday
  return fromDayNumber(day - ((dow + 6) % 7));
}

function cents(value: number): number {
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0 ? 0 : rounded;
}

function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`demo dataset: index ${index} out of range`);
  return item;
}

function inRange(date: IsoDate, range: DateRange): boolean {
  return date >= range.from && date <= range.to;
}

/** Maps a configured pay tag to a normalized pay type; unknown tags map to null. */
export function payTypeFromTag(tag: string | null): DriverPayType | null {
  switch ((tag ?? '').trim().toUpperCase()) {
    case 'C':
      return 'company';
    case 'OO':
      return 'owner_operator';
    case 'LO':
      return 'lease_owner';
    case 'PCT':
    case '%':
      return 'percentage';
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------------------------
// Static vocabularies
// ---------------------------------------------------------------------------------------------

const FIRST_NAMES = [
  'James',
  'Maria',
  'Robert',
  'Linda',
  'Michael',
  'Elena',
  'David',
  'Sofia',
  'Daniel',
  'Aisha',
  'Carlos',
  'Nadia',
  'Marcus',
  'Priya',
  'Andrei',
  'Tomasz',
  'Luis',
  'Fatima',
  'Kevin',
  'Yusuf',
  'Omar',
  'Grace',
  'Victor',
  'Hannah',
  'Sergei',
  'Amara',
  'Jorge',
  'Ivan',
  'Rustam',
  'Dilshod',
];
const LAST_NAMES = [
  'Walker',
  'Garcia',
  'Nguyen',
  'Petrov',
  'Okafor',
  'Kowalski',
  'Ramirez',
  'Hussain',
  'Brooks',
  'Ivanov',
  'Silva',
  'Martin',
  'Khan',
  'Reyes',
  'Novak',
  'Moreno',
  'Fischer',
  'Ali',
  'Turner',
  'Diaz',
  'Rashidov',
  'Karimov',
  'Lopez',
  'Murphy',
  'Sato',
  'Bauer',
  'Costa',
  'Popov',
  'Hill',
];

const PAY_TAG_CYCLE = ['C', 'C', 'OO', 'LO', 'PCT', 'C', 'OO', '%', 'C', 'LO'] as const;
/** Driver indices (0-based) whose tags cannot be classified; all are assigned to trucks. */
const UNKNOWN_TAG_DRIVERS: ReadonlyArray<[number, string]> = [
  [7, 'C-30'],
  [19, 'OO/C'],
  [33, ''],
  [48, 'TBD'],
];

const TRUCK_STATUS_CYCLE: readonly TruckStatus[] = [
  'driving',
  'assigned',
  'driving',
  'idle',
  'available',
];
const SOLD_UNITS = new Set(['2703', '2711', '2729']);
const IN_SHOP_UNIT = '3120';
/** Units that stop earning revenue from this week on but still incur costs (inactive-loss demo). */
const INACTIVE_UNITS = new Set(['3012', '3091']);
const INACTIVE_FROM_WEEK: IsoDate = '2026-08-10';
const IN_SHOP_FROM_WEEK: IsoDate = '2026-08-17';
const CURRENT_WEEK: IsoDate = weekStartOf(DEMO_TODAY);

const TEAMS: readonly DemoTeam[] = ['A', 'B', 'C', 'D', 'E', 'F'].map((letter) => ({
  teamId: `team_${letter.toLowerCase()}`,
  teamName: `Team ${letter}`,
}));

interface FuelState {
  state: string;
  weight: number;
  price: number;
  stations: readonly string[];
}
const FUEL_STATES: readonly FuelState[] = [
  { state: 'TX', weight: 22, price: 3.0, stations: ["Buc-ee's", "Love's", 'Pilot', 'TA'] },
  { state: 'IL', weight: 14, price: 3.45, stations: ['Pilot', 'Flying J', 'Road Ranger', 'TA'] },
  { state: 'IN', weight: 10, price: 3.35, stations: ['Petro', "Love's", 'Pilot'] },
  { state: 'OH', weight: 10, price: 3.3, stations: ['TA', 'Flying J', "Love's"] },
  { state: 'MO', weight: 10, price: 3.1, stations: ['QuikTrip', 'Petro', 'Pilot'] },
  { state: 'OK', weight: 10, price: 2.95, stations: ["Love's", 'QuikTrip', 'Flying J'] },
  { state: 'CA', weight: 7, price: 4.25, stations: ['Pilot', 'TA', 'Petro'] },
  { state: 'WA', weight: 6, price: 4.0, stations: ['Flying J', "Love's", 'Pilot'] },
  { state: 'GA', weight: 11, price: 3.2, stations: ['Pilot', 'TA', "Love's", 'Petro'] },
];

/**
 * Share of a driver's weekly gross paid out to them. Owner-operators and lease-owners keep more of
 * each load, but the carrier books only its own settlement side here, so the blended payout lands
 * near 26–27 % of gross (docs/DASHBOARD.md §4 cost model).
 */
const DRIVER_PAY_RATE: Record<DriverPayType | 'unknown', number> = {
  company: 0.26,
  owner_operator: 0.29,
  lease_owner: 0.28,
  percentage: 0.24,
  unknown: 0.27,
};

// ---------------------------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------------------------

/** Days of a reporting week elapsed as of the demo "today" (pinned future weeks count as full). */
function elapsedDaysAsOf(weekStart: IsoDate, today: IsoDate): number {
  if (weekStart > today) return 7;
  return Math.min(7, toDayNumber(today) - toDayNumber(weekStart) + 1);
}

/** Loads per week: about two per working truck, trending up (Aug ≈ +6 % over Jul) with two dips. */
function weeklyLoadTarget(
  workerCount: number,
  weekStart: IsoDate,
  index: number,
  rand: () => number,
): number {
  const month = Number(weekStart.slice(5, 7));
  const seasonal: Record<number, number> = { 4: 0.92, 5: 0.94, 6: 0.97, 7: 1.0, 8: 1.06, 9: 1.08 };
  const dip = index === 5 || index === 14 ? 0.9 : 1;
  const noise = Math.round(rand() * 4 - 2);
  const base = workerCount * 2.0;
  return Math.max(95, Math.min(115, Math.round(base * (seasonal[month] ?? 1) * dip + noise)));
}

/** The two or three trucks that sit out a given week, on a deterministic rotation. */
function restingTrucks(pool: readonly DemoTruck[], index: number): Set<string> {
  const resting = new Set<string>();
  if (pool.length < 8) return resting;
  const count = 1 + (index % 2);
  for (let k = 0; k < count; k += 1) {
    resting.add(at(pool, (index * 7 + k * 13) % pool.length).truckId);
  }
  return resting;
}

function buildTrucks(): DemoTruck[] {
  const units: string[] = [];
  for (let n = 2701; n <= 2750; n += 1) units.push(String(n));
  units.push(
    '2785',
    '2790',
    '2795',
    '3001',
    '3005',
    '3012',
    '3020',
    '3033',
    '3047',
    '3091',
    IN_SHOP_UNIT,
  );
  return units.map((unit, i) => ({
    truckId: `trk_${unit}`,
    unitNumber: unit,
    status: SOLD_UNITS.has(unit)
      ? 'sold'
      : unit === IN_SHOP_UNIT
        ? 'in_shop'
        : at(TRUCK_STATUS_CYCLE, i % TRUCK_STATUS_CYCLE.length),
    driverId: null,
    driverName: null,
    teamId: null,
  }));
}

function buildDrivers(rand: () => number): DriverFact[] {
  const unknown = new Map(UNKNOWN_TAG_DRIVERS);
  const used = new Set<string>();
  const drivers: DriverFact[] = [];
  for (let i = 0; i < 70; i += 1) {
    const randomName = (): string =>
      `${at(FIRST_NAMES, Math.floor(rand() * FIRST_NAMES.length))} ${at(LAST_NAMES, Math.floor(rand() * LAST_NAMES.length))}`;
    let name = randomName();
    while (used.has(name)) name = randomName();
    used.add(name);
    const rawPayTag = unknown.get(i) ?? at(PAY_TAG_CYCLE, i % PAY_TAG_CYCLE.length);
    drivers.push({
      driverId: `drv_${String(i + 1).padStart(3, '0')}`,
      name,
      payType: payTypeFromTag(rawPayTag),
      rawPayTag,
    });
  }
  return drivers;
}

function assignDriversAndTeams(
  trucks: DemoTruck[],
  drivers: DriverFact[],
  rand: () => number,
): void {
  const active = trucks.filter((t) => t.status !== 'sold');
  active.forEach((truck, i) => {
    const driver = at(drivers, i);
    truck.driverId = driver.driverId;
    truck.driverName = driver.name;
  });
  const shuffled = [...active];
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const a = at(shuffled, i);
    shuffled[i] = at(shuffled, j);
    shuffled[j] = a;
  }
  shuffled.forEach((truck, i) => {
    truck.teamId = at(TEAMS, i % TEAMS.length).teamId;
  });
}

/** Trucks that can haul loads and buy fuel in a given week. */
function eligibleTrucks(trucks: readonly DemoTruck[], weekStart: IsoDate): DemoTruck[] {
  return trucks.filter((t) => {
    if (t.status === 'sold') return false;
    if (INACTIVE_UNITS.has(t.unitNumber) && weekStart >= INACTIVE_FROM_WEEK) return false;
    if (t.unitNumber === IN_SHOP_UNIT && weekStart >= IN_SHOP_FROM_WEEK) return false;
    return true;
  });
}

function timeOfDay(rand: () => number): string {
  const hour = 13 + Math.floor(rand() * 10); // 08:00–17:59 Chicago (CDT) expressed in UTC
  const minute = Math.floor(rand() * 60);
  return `T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function generateRevenue(
  weekStarts: readonly IsoDate[],
  trucks: readonly DemoTruck[],
  rand: () => number,
): RevenueLine[] {
  const lines: RevenueLine[] = [];
  const dayWeights = [1.0, 1.1, 1.1, 1.1, 1.2, 0.5, 0.3]; // Mon..Sun
  const weightSum = dayWeights.reduce((s, w) => s + w, 0);
  let counter = 0;
  weekStarts.forEach((weekStart, index) => {
    const pool = eligibleTrucks(trucks, weekStart);
    const resting = restingTrucks(pool, index);
    const workers = pool.filter((t) => !resting.has(t.truckId));
    const target = weeklyLoadTarget(workers.length, weekStart, index, rand);
    // Every working truck hauls at least one load; the rest of the week's loads are spread at
    // random, then shuffled so load order does not follow truck order.
    const assignment: DemoTruck[] = [...workers];
    while (assignment.length < target) {
      assignment.push(at(workers, Math.floor(rand() * workers.length)));
    }
    for (let i = assignment.length - 1; i > 0; i -= 1) {
      const j = Math.floor(rand() * (i + 1));
      const swap = at(assignment, i);
      assignment[i] = at(assignment, j);
      assignment[j] = swap;
    }
    const loadsPerTruck = new Map<string, number>();
    for (const t of assignment)
      loadsPerTruck.set(t.truckId, (loadsPerTruck.get(t.truckId) ?? 0) + 1);
    const dropTruckAt = new Set<number>();
    if (weekStart === '2026-08-24') {
      for (let i = 0; i < assignment.length && dropTruckAt.size < 2; i += 1) {
        if ((loadsPerTruck.get(at(assignment, i).truckId) ?? 0) > 1) dropTruckAt.add(i);
      }
    }
    let seq = 0;
    for (let k = 0; k < assignment.length; k += 1) {
      let pickDay = rand() * weightSum;
      let offset = 0;
      for (let d = 0; d < dayWeights.length; d += 1) {
        pickDay -= at(dayWeights, d);
        if (pickDay <= 0) {
          offset = d;
          break;
        }
      }
      const deliveredOn = addDays(weekStart, offset);
      if (!inRange(deliveredOn, DEMO_DATASET_RANGE)) continue;
      const truck = at(assignment, k);
      const loadedMiles = Math.round(200 + rand() * 1200);
      const rpm = 2.46 + rand() * 0.85;
      const linehaul = cents(Math.max(900, Math.min(6800, loadedMiles * rpm)));
      const emptyMiles = Math.round(loadedMiles * (0.1 + rand() * 0.15));
      counter += 1;
      seq += 1;
      const dropTruck = dropTruckAt.has(k);
      const dropDriver =
        (weekStart === '2026-08-17' && (k === 4 || k === 11)) ||
        (weekStart === CURRENT_WEEK && k === 6);
      lines.push({
        loadId: `ld_${String(counter).padStart(5, '0')}`,
        loadNumber: `NW-${weekStart.slice(5, 7)}${weekStart.slice(8, 10)}-${String(seq).padStart(2, '0')}`,
        truckId: dropTruck ? null : truck.truckId,
        driverId: dropDriver ? null : truck.driverId,
        teamId: truck.teamId,
        deliveredAt: `${deliveredOn}${timeOfDay(rand)}`,
        deliveredOn,
        linehaul,
        loadedMiles,
        emptyMiles,
      });
    }
  });
  return lines;
}

/** Average fleet fuel economy used to size fuel purchases against the miles actually driven. */
const DEMO_MILES_PER_GALLON = 4.3;
/** Average gallons per fill-up (tank top-up, not a full tank). */
const DEMO_GALLONS_PER_FILL = 130;

function generateFuel(
  weekStarts: readonly IsoDate[],
  trucks: readonly DemoTruck[],
  revenue: readonly RevenueLine[],
  rand: () => number,
): FuelTransactionFact[] {
  const rows: FuelTransactionFact[] = [];
  const milesPerWeek = new Map<IsoDate, number>();
  for (const load of revenue) {
    const week = weekStartOf(load.deliveredOn);
    milesPerWeek.set(week, (milesPerWeek.get(week) ?? 0) + load.loadedMiles + load.emptyMiles);
  }
  const weightSum = FUEL_STATES.reduce((s, f) => s + f.weight, 0);
  let counter = 0;
  const push = (
    date: IsoDate,
    truck: DemoTruck,
    fuelState: FuelState,
    gallons: number,
    price: number,
    discountPerGallon: number,
  ): void => {
    counter += 1;
    const grossCost = cents(gallons * price);
    rows.push({
      id: `fuel_${String(counter).padStart(5, '0')}`,
      at: `${date}${timeOfDay(rand)}`,
      date,
      truckId: truck.truckId,
      driverId: truck.driverId,
      state: fuelState.state,
      gallons: cents(gallons),
      grossCost,
      discountedCost: cents(grossCost - gallons * discountPerGallon),
      stationName: `${at(fuelState.stations, Math.floor(rand() * fuelState.stations.length))} ${fuelState.state}`,
    });
  };

  for (const weekStart of weekStarts) {
    if (weekStart === DEMO_WEEK_WITHOUT_EXPENSES) continue; // fuel import missing that week
    const pool = eligibleTrucks(trucks, weekStart);
    const miles = milesPerWeek.get(weekStart) ?? 0;
    const count = Math.round(miles / DEMO_MILES_PER_GALLON / DEMO_GALLONS_PER_FILL);
    for (let k = 0; k < count; k += 1) {
      const date = addDays(weekStart, Math.floor(rand() * 7));
      if (!inRange(date, DEMO_DATASET_RANGE)) continue;
      let pickState = rand() * weightSum;
      let fuelState = at(FUEL_STATES, 0);
      for (const candidate of FUEL_STATES) {
        pickState -= candidate.weight;
        fuelState = candidate;
        if (pickState <= 0) break;
      }
      const gallons = DEMO_GALLONS_PER_FILL - 35 + rand() * 70;
      const price = fuelState.price + (rand() - 0.5) * 0.24;
      push(
        date,
        at(pool, Math.floor(rand() * pool.length)),
        fuelState,
        gallons,
        price,
        0.08 + rand() * 0.22,
      );
    }
  }

  // Unit 3012 buys fuel in the current week despite hauling nothing: exactly $500 discounted.
  const idle = trucks.find((t) => t.unitNumber === '3012');
  if (idle) push(addDays(CURRENT_WEEK, 1), idle, at(FUEL_STATES, 0), 160, 3.2, 0.075);
  return rows;
}

function generateExpenses(
  weekStarts: readonly IsoDate[],
  trucks: readonly DemoTruck[],
  drivers: readonly DriverFact[],
  revenue: readonly RevenueLine[],
  fuel: readonly FuelTransactionFact[],
  rand: () => number,
): ExpenseLine[] {
  const lines: ExpenseLine[] = [];
  let counter = 0;
  const add = (line: Omit<ExpenseLine, 'id' | 'isEstimate'> & { isEstimate?: boolean }): void => {
    if (!inRange(line.date, DEMO_DATASET_RANGE)) return;
    if (weekStartOf(line.date) === DEMO_WEEK_WITHOUT_EXPENSES) return; // honesty-rule week
    counter += 1;
    lines.push({
      id: `exp_${String(counter).padStart(6, '0')}`,
      isEstimate: false,
      ...line,
      amount: cents(line.amount),
    });
  };
  const truckByUnit = new Map(trucks.map((t) => [t.unitNumber, t]));
  const driverById = new Map(drivers.map((d) => [d.driverId, d]));
  const truckByDriver = new Map(
    trucks.filter((t) => t.driverId !== null).map((t) => [t.driverId as string, t]),
  );

  // Fuel expense lines: exactly one per fuel transaction, at the discounted cost.
  for (const tx of fuel) {
    add({
      date: tx.date,
      category: 'fuel',
      amount: tx.discountedCost,
      truckId: tx.truckId,
      driverId: tx.driverId,
      source: 'fuel',
      description: `Fuel ${tx.stationName}`,
    });
  }

  // Insurance: the monthly liability + cargo premium accrued weekly per truck, so no single week
  // absorbs the whole bill. Coverage on the parked units ends once they stop running.
  for (const weekStart of weekStarts) {
    trucks.forEach((truck, i) => {
      if (truck.status === 'sold') return;
      if (INACTIVE_UNITS.has(truck.unitNumber) && weekStart >= INACTIVE_FROM_WEEK) return;
      add({
        date: addDays(weekStart, 1),
        category: 'insurance',
        amount: (820 + ((i * 37) % 320)) / 4.345,
        truckId: truck.truckId,
        driverId: null,
        source: 'accounting',
        description: 'Liability + cargo premium (weekly accrual)',
      });
    });
  }

  // Random maintenance / repairs events on trucks that are actually running.
  for (const weekStart of weekStarts) {
    const pool = eligibleTrucks(trucks, weekStart);
    const events = 5 + Math.floor(rand() * 5);
    for (let k = 0; k < events; k += 1) {
      const truck = at(pool, Math.floor(rand() * pool.length));
      const repair = rand() < 0.4;
      add({
        date: addDays(weekStart, Math.floor(rand() * 7)),
        category: repair ? 'repairs' : 'maintenance',
        amount: 140 + rand() * 1900,
        truckId: truck.truckId,
        driverId: truck.driverId,
        source: 'accounting',
        description: repair ? 'Roadside repair' : 'Scheduled service',
      });
    }
  }

  // Pinned inactive-loss and in-shop costs in the last weeks.
  const pinned: ReadonlyArray<[string, IsoDate, ExpenseLine['category'], number, string]> = [
    ['3012', '2026-08-18', 'other', 150, 'Yard parking'],
    ['3012', '2026-08-26', 'maintenance', 400, 'Brake inspection'],
    ['3012', '2026-09-02', 'maintenance', 1200, 'Aftertreatment service'],
    ['3012', '2026-09-03', 'other', 300, 'Permit renewal'],
    ['3091', '2026-08-19', 'other', 175, 'Yard parking'],
    ['3091', '2026-08-27', 'other', 200, 'Tire disposal'],
    ['3091', '2026-09-01', 'repairs', 1250, 'Turbo actuator replacement'],
    [IN_SHOP_UNIT, '2026-08-25', 'repairs', 3400, 'Transmission rebuild (in shop)'],
    [IN_SHOP_UNIT, '2026-09-04', 'repairs', 2100, 'Clutch and flywheel (in shop)'],
  ];
  for (const [unit, date, category, amount, description] of pinned) {
    const truck = truckByUnit.get(unit);
    if (!truck) continue;
    add({
      date,
      category,
      amount,
      truckId: truck.truckId,
      driverId: truck.driverId,
      source: 'accounting',
      description,
    });
  }

  // Per-load computed lines: tolls (some loads), dispatch fee 5 %, factoring 2.5 %.
  const grossByDriverWeek = new Map<
    string,
    { driverId: string; weekStart: IsoDate; gross: number }
  >();
  for (const load of revenue) {
    const base = {
      date: load.deliveredOn,
      truckId: load.truckId,
      driverId: load.driverId,
      source: 'accounting' as const,
    };
    if (rand() < 0.45) {
      add({
        ...base,
        category: 'tolls',
        amount: load.loadedMiles * 0.045,
        description: `Tolls ${load.loadNumber}`,
      });
    }
    add({
      ...base,
      category: 'dispatch_fee',
      amount: load.linehaul * 0.05,
      description: `Dispatch fee ${load.loadNumber}`,
    });
    add({
      ...base,
      category: 'factoring',
      amount: load.linehaul * 0.025,
      description: `Factoring ${load.loadNumber}`,
    });
    if (load.driverId !== null) {
      const weekStart = weekStartOf(load.deliveredOn);
      const key = `${load.driverId}|${weekStart}`;
      const entry = grossByDriverWeek.get(key) ?? { driverId: load.driverId, weekStart, gross: 0 };
      entry.gross += load.linehaul;
      grossByDriverWeek.set(key, entry);
    }
  }

  // Driver pay: settlements for ~85 % of drivers, estimates for the rest.
  for (const { driverId, weekStart, gross } of grossByDriverWeek.values()) {
    const driver = driverById.get(driverId);
    if (!driver) continue;
    const index = Number(driverId.slice(4));
    const settled = index % 20 < 17;
    const rate = DRIVER_PAY_RATE[driver.payType ?? 'unknown'];
    const truck = truckByDriver.get(driverId) ?? null;
    add({
      date: addDays(weekStart, 4),
      category: 'driver_pay',
      amount: gross * rate,
      truckId: truck?.truckId ?? null,
      driverId,
      source: settled ? 'settlement' : 'estimate',
      isEstimate: !settled,
      description: settled ? 'Weekly settlement' : 'Driver pay estimate (settlement pending)',
    });
  }

  return lines;
}

function generateMileage(revenue: readonly RevenueLine[], rand: () => number): MileageRecord[] {
  const byKey = new Map<string, MileageRecord>();
  for (const load of revenue) {
    if (load.truckId === null) continue;
    const total = (load.loadedMiles + load.emptyMiles) * (0.9 + rand() * 0.2);
    const split: Array<[number, number]> =
      total >= 400
        ? [
            [-2, 0.3],
            [-1, 0.4],
            [0, 0.3],
          ]
        : total >= 250
          ? [
              [-1, 0.5],
              [0, 0.5],
            ]
          : [[0, 1]];
    for (const [offset, share] of split) {
      const date = addDays(load.deliveredOn, offset);
      if (!inRange(date, DEMO_DATASET_RANGE)) continue;
      const key = `${load.truckId}|${date}`;
      const record = byKey.get(key) ?? {
        truckId: load.truckId,
        driverId: load.driverId,
        date,
        miles: 0,
        source: 'odometer' as const,
      };
      record.miles = Math.round(record.miles + total * share);
      byKey.set(key, record);
    }
  }
  return [...byKey.values()].sort(
    (a, b) => a.date.localeCompare(b.date) || a.truckId.localeCompare(b.truckId),
  );
}

function generateDispatchWeeks(
  weekStarts: readonly IsoDate[],
  trucks: readonly DemoTruck[],
  revenue: readonly RevenueLine[],
  rand: () => number,
): DispatchTeamWeek[] {
  const rows: DispatchTeamWeek[] = [];
  const trucksPerTeam = new Map<string, number>();
  for (const truck of trucks) {
    if (truck.teamId !== null && truck.status !== 'sold') {
      trucksPerTeam.set(truck.teamId, (trucksPerTeam.get(truck.teamId) ?? 0) + 1);
    }
  }
  const loadsByTeamWeek = new Map<string, RevenueLine[]>();
  for (const load of revenue) {
    if (load.teamId === null) continue;
    const key = `${load.teamId}|${weekStartOf(load.deliveredOn)}`;
    const list = loadsByTeamWeek.get(key) ?? [];
    list.push(load);
    loadsByTeamWeek.set(key, list);
  }
  for (const weekStart of weekStarts) {
    const elapsed = elapsedDaysAsOf(weekStart, DEMO_TODAY);
    for (const team of TEAMS) {
      const loads = loadsByTeamWeek.get(`${team.teamId}|${weekStart}`) ?? [];
      const perTruck = new Map<string, { gross: number; miles: number }>();
      let gross = 0;
      let miles = 0;
      for (const load of loads) {
        gross += load.linehaul;
        miles += load.loadedMiles + load.emptyMiles;
        if (load.truckId === null) continue;
        const entry = perTruck.get(load.truckId) ?? { gross: 0, miles: 0 };
        entry.gross += load.linehaul;
        entry.miles += load.loadedMiles + load.emptyMiles;
        perTruck.set(load.truckId, entry);
      }
      const truckDays = (trucksPerTeam.get(team.teamId) ?? 0) * elapsed;
      rows.push({
        teamId: team.teamId,
        teamName: team.teamName,
        weekStart,
        gross: cents(gross),
        loads: loads.length,
        activeTrucks: perTruck.size,
        truckDays,
        activeTruckDays: Math.round(truckDays * (0.85 + rand() * 0.1)),
        miles,
        truckRpms: [...perTruck.values()]
          .filter((t) => t.miles > 0)
          .map((t) => Math.round((t.gross / t.miles) * 1000) / 1000),
      });
    }
  }
  return rows;
}

/** Builds the full pinned dataset. Deterministic for a given seed. */
export function generateDemoDataset(seed: number = DEMO_SEED): DemoDataset {
  const rand = mulberry32(seed);
  const weekStarts: IsoDate[] = [];
  for (
    let week = weekStartOf(DEMO_DATASET_RANGE.from);
    week <= DEMO_DATASET_RANGE.to;
    week = addDays(week, 7)
  ) {
    weekStarts.push(week);
  }

  const trucks = buildTrucks();
  const drivers = buildDrivers(rand);
  assignDriversAndTeams(trucks, drivers, rand);

  const revenue = generateRevenue(weekStarts, trucks, rand);
  const fuel = generateFuel(weekStarts, trucks, revenue, rand);
  const expenses = generateExpenses(weekStarts, trucks, drivers, revenue, fuel, rand);
  const mileage = generateMileage(revenue, rand);
  const dispatchWeeks = generateDispatchWeeks(weekStarts, trucks, revenue, rand);
  const expenseCoverage: ExpenseCoverage[] = weekStarts.map((weekStart) => ({
    weekStart,
    hasExpenseData: weekStart !== DEMO_WEEK_WITHOUT_EXPENSES,
  }));

  return {
    revenue,
    expenses,
    fuel,
    mileage,
    trucks: trucks.map((truck) => ({
      truckId: truck.truckId,
      unitNumber: truck.unitNumber,
      status: truck.status,
      driverId: truck.driverId,
      driverName: truck.driverName,
    })),
    drivers,
    dispatchWeeks,
    expenseCoverage,
    weekStarts,
  };
}

function emptyFacts(companyId: string, range: DateRange): ReportingFacts {
  return {
    companyId,
    range: { from: range.from, to: range.to },
    revenue: [],
    expenses: [],
    fuel: [],
    mileage: [],
    trucks: [],
    drivers: [],
    dispatchWeeks: [],
    expenseCoverage: [],
    revenueLedgerTotal: 0,
  };
}

/**
 * Demo `ReportingDataSource`: deterministic facts for Northwind Freight only. Any other company id
 * yields empty facts — the demo never leaks data across tenants. Returned records are shared with
 * the cache and must be treated as read-only.
 */
@Injectable()
export class DemoReportingDataSource implements ReportingDataSource {
  readonly kind = 'demo' as const;

  /** When true, the revenue ledger total is deliberately off so reconciliation reports an error. */
  simulateReconciliationMismatch = false;

  private dataset: DemoDataset | null = null;

  /** The cached pinned dataset (generated on first use). */
  getDataset(): DemoDataset {
    this.dataset ??= generateDemoDataset(DEMO_SEED);
    return this.dataset;
  }

  async facts(companyId: string, range: DateRange): Promise<ReportingFacts> {
    if (companyId !== DEMO_COMPANY.id) return emptyFacts(companyId, range);
    const data = this.getDataset();
    const overlapsWeek = (weekStart: IsoDate): boolean =>
      weekStart <= range.to && addDays(weekStart, 6) >= range.from;

    const revenue = data.revenue.filter((r) => inRange(r.deliveredOn, range));
    const ledger = cents(revenue.reduce((sum, r) => sum + r.linehaul, 0));
    return {
      companyId,
      range: { from: range.from, to: range.to },
      revenue,
      expenses: data.expenses.filter((e) => inRange(e.date, range)),
      fuel: data.fuel.filter((f) => inRange(f.date, range)),
      mileage: data.mileage.filter((m) => inRange(m.date, range)),
      trucks: data.trucks,
      drivers: data.drivers,
      dispatchWeeks: data.dispatchWeeks.filter((w) => overlapsWeek(w.weekStart)),
      expenseCoverage: data.expenseCoverage.filter((c) => overlapsWeek(c.weekStart)),
      revenueLedgerTotal: this.simulateReconciliationMismatch ? cents(ledger + 137.5) : ledger,
    };
  }
}
