/**
 * Deterministic demo dataset for "Northwind Freight".
 *
 * Everything is derived from a seeded PRNG (mulberry32) and one anchor instant, so the same seed
 * always yields the same shape of data and tests can assert exact numbers. The anchor is 2:30pm
 * today in the company's timezone (see `demoAnchor`), which holds still for a whole day; it is a
 * fixture's anchor and never an answer to "what time is it" — that comes from `@/lib/clock`.
 */
import { STATUS, type StatusCode } from '@/design-system/status';
import { COMPANY_TZ, companyDateOf } from '@/lib/clock';
import type { DownPeriod } from './down-periods';
import { buildAccounting } from './accounting-data';
import type {
  Bill,
  DeductionPlan,
  Expense,
  InvoiceLine,
  JournalEntry,
  LedgerPeriod,
  PayrollPeriod,
  Payment,
  Payslip,
  Settlement,
  Vendor,
} from './accounting-types';
import type { EscrowEntry, TerminationRecord } from './workforce-types';
import type { UnitExitRecord } from './unit-status-types';
import type { PtiRecord } from './pti-types';
import type { WorkOrderTypeDef } from './work-order-types';
import {
  DEFAULT_PTI_COMPONENTS,
  DEFAULT_PTI_CONDITION_CONFIG,
  type PtiComponentDef,
  type PtiComponentRating,
  type PtiConditionConfig,
} from './pti-condition';
import { buildPtiWeek } from './pti-seed';
import { buildSafety } from './safety-data';
import type {
  Accident,
  Claim,
  CorrectiveAction,
  Defect,
  Inspection,
  Violation,
} from './safety-types';
import type {
  ActivityItem,
  AiInsight,
  Broker,
  Company,
  ComplianceAuditEntry,
  Customer,
  DashboardSeries,
  Department,
  Driver,
  DriverStatus,
  EntityRef,
  Facility,
  FleetHealth,
  FuelTransaction,
  Invoice,
  InvoiceStatus,
  IsoDate,
  KpiSnapshot,
  KpiValue,
  Load,
  LoadDocument,
  LoadEvent,
  LoadEventKind,
  LoadFinancials,
  LoadNote,
  LoadStatus,
  MaintenanceItem,
  MaintenanceStatus,
  MaintenanceType,
  Membership,
  Notification,
  RepairOrder,
  RepairOrderStatus,
  RevenueProfitPoint,
  SafetyEvent,
  SafetyEventKind,
  SafetySeverity,
  ServiceRecord,
  StatusCount,
  Stop,
  Task,
  TimeSeriesPoint,
  Trailer,
  TrailerStatus,
  TrailerType,
  Truck,
  TruckStatus,
  User,
  TruckNote,
} from './types';

export const DEMO_SEED = 20260906;

/**
 * Which dataset the browser starts from.
 *
 * `demo` is the generated Northwind Freight workspace, for development and the tests. `empty` is
 * what a production build ships: no loads, no brokers, no work orders, nobody — every list starts
 * at zero and fills with what people enter, which the snapshot in `app_state` then keeps. The
 * roster is the same either way; trucks and drivers come from the API.
 */
export const DATASET: 'demo' | 'empty' =
  import.meta.env.VITE_DATASET === 'empty' ? 'empty' : 'demo';
/**
 * The instant the generated workspace is built around.
 *
 * It used to be the literal `2026-09-06T14:30:00-05:00`, and every screen that wanted "now" read it
 * instead of a clock. That is why the walk-around board opened on Aug 31 – Sep 6 no matter what day
 * it was, and why the demo aged a day further out of date every day. The anchor now follows the
 * real clock: 2:30pm in the company's timezone, today, or yesterday when today's 2:30pm has not
 * happened yet — so nothing is generated into the future and the anchor holds still for a whole
 * day, which is what keeps the seeded data reproducible within a test run.
 *
 * Screens must **not** read this. "Now" comes from `@/lib/clock`; this is a fixture's anchor.
 */
function demoAnchor(): Date {
  const AFTERNOON = '14:30:00';
  const at = (day: string) => new Date(`${day}T${AFTERNOON}${chicagoOffsetSuffix(day)}`);
  const todayAnchor = at(companyDateOf(Date.now()));
  if (todayAnchor.getTime() <= Date.now()) return todayAnchor;
  return at(companyDateOf(todayAnchor.getTime() - 24 * 60 * 60 * 1000));
}

/**
 * `-05:00` in summer, `-06:00` in winter, asked of `Intl` rather than assumed — the constant this
 * replaces was pinned to the summer offset all year round.
 */
function chicagoOffsetSuffix(day: IsoDate): string {
  const probe = new Date(`${day}T18:00:00Z`);
  const shown = new Intl.DateTimeFormat('en-US', {
    timeZone: COMPANY_TZ,
    hour: '2-digit',
    hour12: false,
  }).format(probe);
  const hours = 18 - Number(shown);
  return `-${String(hours).padStart(2, '0')}:00`;
}

export const DEMO_NOW = demoAnchor();
export const DEMO_NOW_ISO = DEMO_NOW.toISOString();
export const HERO_LOAD_NUMBER = 'L-100245';
export const HERO_UNIT = '2785';
export const TRENDING_DRIVER_ID = 'drv_2091';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = DEMO_NOW.getTime();
/** Chicago's offset at the anchor, asked of `Intl` so winter is not given the summer offset. */
const CHICAGO_OFFSET = -Number(chicagoOffsetSuffix(companyDateOf(NOW)).slice(0, 3)) * HOUR;
/** The company-timezone (America/Chicago) calendar date of `DEMO_NOW`. */
export const DEMO_TODAY: IsoDate = companyDateOf(DEMO_NOW);
const TZ_OFFSET: Record<string, number> = {
  'America/Chicago': CHICAGO_OFFSET,
  'America/New_York': 4 * HOUR,
  'America/Denver': 6 * HOUR,
};

// ---------------------------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------------------------

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function must<T>(value: T | null | undefined, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`demo data: missing ${what}`);
  return value;
}

export class Rng {
  private readonly next: () => number;

  constructor(seed: number) {
    this.next = mulberry32(seed);
  }

  float(min = 0, max = 1): number {
    return min + (max - min) * this.next();
  }

  /** Inclusive integer range. */
  int(min: number, max: number): number {
    return Math.floor(this.float(min, max + 1));
  }

  chance(probability: number): boolean {
    return this.next() < probability;
  }

  pick<T>(items: readonly T[]): T {
    return must(items[Math.floor(this.next() * items.length)], 'pick');
  }

  shuffle<T>(items: readonly T[]): T[] {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.next() * (i + 1));
      const tmp = must(out[i]);
      out[i] = must(out[j]);
      out[j] = tmp;
    }
    return out;
  }

  digits(count: number): string {
    let out = '';
    for (let i = 0; i < count; i += 1) out += String(this.int(0, 9));
    return out;
  }

  chars(count: number, alphabet: string): string {
    let out = '';
    for (let i = 0; i < count; i += 1) out += alphabet.charAt(this.int(0, alphabet.length - 1));
    return out;
  }
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

function iso(ms: number): string {
  return new Date(ms).toISOString();
}

function isoDate(ms: number, offset = CHICAGO_OFFSET): string {
  return new Date(ms - offset).toISOString().slice(0, 10);
}

/** Snap a timestamp to `hour:minute` local time (given offset) on the same local day. */
function atLocal(ms: number, hour: number, minute = 0, offset = CHICAGO_OFFSET): number {
  const local = new Date(ms - offset);
  return (
    Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate(), hour, minute) + offset
  );
}

function daysAgo(days: number, hour?: number, minute = 0): number {
  const base = NOW - days * DAY;
  return hour === undefined ? base : atLocal(base, hour, minute);
}

function label(code: StatusCode): string {
  return STATUS[code].label;
}

function ref(type: EntityRef['type'], id: string, refLabel: string): EntityRef {
  return { type, id, label: refLabel };
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

function roadMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  return Math.round((haversineMiles(a, b) * 1.18) / 5) * 5;
}

// ---------------------------------------------------------------------------------------------
// Reference pools
// ---------------------------------------------------------------------------------------------

const FIRST_NAMES = [
  'Darnell',
  'Marcus',
  'Luis',
  'Tomasz',
  'Andre',
  'Carlos',
  'Jamal',
  'Terrence',
  'Dmitri',
  'Oleksandr',
  'Sergio',
  'Hector',
  'Rafael',
  'Samuel',
  'Victor',
  'Wesley',
  'Brandon',
  'Curtis',
  'Dwayne',
  'Emmanuel',
  'Felix',
  'Gabriel',
  'Isaiah',
  'Jorge',
  'Kwame',
  'Lamar',
  'Mateo',
  'Nikolai',
  'Omar',
  'Pedro',
  'Quincy',
  'Ramon',
  'Stefan',
  'Tariq',
  'Vincent',
  'Walter',
  'Xavier',
  'Yusuf',
  'Zachary',
  'Angela',
  'Brenda',
  'Cynthia',
  'Denise',
  'Erica',
  'Felicia',
  'Gloria',
  'Hannah',
  'Irene',
  'Jasmine',
  'Keisha',
  'Latoya',
  'Melissa',
  'Nadia',
  'Olivia',
  'Patricia',
  'Rosa',
  'Shanice',
  'Tanya',
  'Valerie',
  'Travis',
  'Bogdan',
  'Ivan',
  'Anthony',
  'Derrick',
  'Ernesto',
  'Malik',
  'Reggie',
  'Colin',
  'Devon',
  'Marisol',
];

const LAST_NAMES = [
  'Whitaker',
  'Washington',
  'Rodriguez',
  'Nguyen',
  'Patel',
  'Kowalski',
  'Petrov',
  'Shevchenko',
  'Morales',
  'Jackson',
  'Thompson',
  'Ramirez',
  'Robinson',
  'Lewis',
  'Walker',
  'Hall',
  'Allen',
  'Young',
  'King',
  'Wright',
  'Scott',
  'Green',
  'Baker',
  'Adams',
  'Nelson',
  'Carter',
  'Mitchell',
  'Perez',
  'Roberts',
  'Turner',
  'Phillips',
  'Campbell',
  'Parker',
  'Evans',
  'Edwards',
  'Collins',
  'Stewart',
  'Sanchez',
  'Morris',
  'Rogers',
  'Reed',
  'Cook',
  'Morgan',
  'Bell',
  'Murphy',
  'Bailey',
  'Rivera',
  'Cooper',
  'Richardson',
  'Cox',
  'Howard',
  'Ward',
  'Torres',
  'Peterson',
  'Gray',
  'Ramos',
  'Watson',
  'Brooks',
  'Kelly',
  'Sanders',
  'Price',
  'Bennett',
  'Wood',
  'Barnes',
  'Ross',
  'Henderson',
  'Coleman',
  'Jenkins',
  'Perry',
  'Powell',
  'Mercer',
  'Hughes',
  'Flores',
  'Butler',
];

interface TruckModel {
  make: string;
  model: string;
  wmi: string;
}

const TRUCK_MODELS: TruckModel[] = [
  { make: 'Freightliner', model: 'Cascadia', wmi: '1FUJHHDR' },
  { make: 'Volvo', model: 'VNL 860', wmi: '4V4NC9EH' },
  { make: 'Kenworth', model: 'T680', wmi: '1XKYDP9X' },
  { make: 'Peterbilt', model: '579', wmi: '1XPBD49X' },
  { make: 'Mack', model: 'Anthem', wmi: '1M1AN4GY' },
];

const VIN_YEAR: Record<number, string> = {
  2019: 'K',
  2020: 'L',
  2021: 'M',
  2022: 'N',
  2023: 'P',
  2024: 'R',
  2025: 'S',
};

const TRUCK_COLORS = ['White', 'Silver', 'Navy', 'Red', 'Black', 'Forest green'];
const TELEMATICS = ['Samsara', 'Motive', 'Geotab'];
const PLATE_STATES = ['IL', 'IL', 'IL', 'IN', 'TX'];

interface City {
  city: string;
  state: string;
  lat: number;
  lng: number;
  tz: string;
}

const CITIES: City[] = [
  { city: 'Chicago', state: 'IL', lat: 41.8781, lng: -87.6298, tz: 'America/Chicago' },
  { city: 'Dallas', state: 'TX', lat: 32.7767, lng: -96.797, tz: 'America/Chicago' },
  { city: 'Atlanta', state: 'GA', lat: 33.749, lng: -84.388, tz: 'America/New_York' },
  { city: 'Indianapolis', state: 'IN', lat: 39.7684, lng: -86.1581, tz: 'America/New_York' },
  { city: 'Columbus', state: 'OH', lat: 39.9612, lng: -82.9988, tz: 'America/New_York' },
  { city: 'Nashville', state: 'TN', lat: 36.1627, lng: -86.7816, tz: 'America/Chicago' },
  { city: 'Kansas City', state: 'MO', lat: 39.0997, lng: -94.5786, tz: 'America/Chicago' },
  { city: 'St. Louis', state: 'MO', lat: 38.627, lng: -90.1994, tz: 'America/Chicago' },
  { city: 'Memphis', state: 'TN', lat: 35.1495, lng: -90.049, tz: 'America/Chicago' },
  { city: 'Louisville', state: 'KY', lat: 38.2527, lng: -85.7585, tz: 'America/New_York' },
  { city: 'Milwaukee', state: 'WI', lat: 43.0389, lng: -87.9065, tz: 'America/Chicago' },
  { city: 'Minneapolis', state: 'MN', lat: 44.9778, lng: -93.265, tz: 'America/Chicago' },
  { city: 'Detroit', state: 'MI', lat: 42.3314, lng: -83.0458, tz: 'America/New_York' },
  { city: 'Cleveland', state: 'OH', lat: 41.4993, lng: -81.6944, tz: 'America/New_York' },
  { city: 'Houston', state: 'TX', lat: 29.7604, lng: -95.3698, tz: 'America/Chicago' },
  { city: 'Denver', state: 'CO', lat: 39.7392, lng: -104.9903, tz: 'America/Denver' },
  { city: 'Oklahoma City', state: 'OK', lat: 35.4676, lng: -97.5164, tz: 'America/Chicago' },
  { city: 'Charlotte', state: 'NC', lat: 35.2271, lng: -80.8431, tz: 'America/New_York' },
  { city: 'Pittsburgh', state: 'PA', lat: 40.4406, lng: -79.9959, tz: 'America/New_York' },
  { city: 'Omaha', state: 'NE', lat: 41.2565, lng: -95.9345, tz: 'America/Chicago' },
];

const ROAD_CITIES: Array<{ city: string; state: string }> = [
  { city: 'Springfield', state: 'IL' },
  { city: 'Effingham', state: 'IL' },
  { city: 'Joliet', state: 'IL' },
  { city: 'Gary', state: 'IN' },
  { city: 'Little Rock', state: 'AR' },
  { city: 'Tulsa', state: 'OK' },
  { city: 'Birmingham', state: 'AL' },
  { city: 'Des Moines', state: 'IA' },
  { city: 'Cincinnati', state: 'OH' },
  { city: 'Toledo', state: 'OH' },
  { city: 'Joplin', state: 'MO' },
  { city: 'Texarkana', state: 'TX' },
  { city: 'Amarillo', state: 'TX' },
  { city: 'Knoxville', state: 'TN' },
];

const HOME_TERMINAL = { city: 'Naperville', state: 'IL', lat: 41.7508, lng: -88.1535 };

const FACILITY_DEFS: Array<{ name: string; cityIndex: number; street: string; zip: string }> = [
  {
    name: 'Midwest Steel Partners – Chicago Plant',
    cityIndex: 0,
    street: '11400 S Torrence Ave',
    zip: '60617',
  },
  {
    name: 'Sunbelt Building Supply – Dallas DC',
    cityIndex: 1,
    street: '4200 Irving Blvd',
    zip: '75247',
  },
  {
    name: 'Heartland Foods – Atlanta Cold Storage',
    cityIndex: 2,
    street: '5180 Fulton Industrial Blvd',
    zip: '30336',
  },
  {
    name: 'Ironclad Auto Parts – Indianapolis',
    cityIndex: 3,
    street: '7800 W Morris St',
    zip: '46231',
  },
  {
    name: 'Redwood Consumer Goods – Columbus FC',
    cityIndex: 4,
    street: '2900 Rohr Rd',
    zip: '43137',
  },
  {
    name: 'Prairie Beverage – Nashville Depot',
    cityIndex: 5,
    street: '1500 Antioch Pike',
    zip: '37211',
  },
  {
    name: 'Great Lakes Paper – Kansas City Mill',
    cityIndex: 6,
    street: '8801 NE Parvin Rd',
    zip: '64161',
  },
  { name: 'Northstar Packaging – St. Louis', cityIndex: 7, street: '3800 Hall St', zip: '63147' },
  {
    name: 'Evergreen Produce – Memphis Terminal',
    cityIndex: 8,
    street: '4400 Getwell Rd',
    zip: '38118',
  },
  {
    name: 'Summit Appliance – Louisville DC',
    cityIndex: 9,
    street: '6200 Outer Loop',
    zip: '40228',
  },
  {
    name: 'Carolina Furniture – Milwaukee Showroom DC',
    cityIndex: 10,
    street: '5800 W Florist Ave',
    zip: '53218',
  },
  {
    name: 'Bluewater Chemicals – Minneapolis',
    cityIndex: 11,
    street: '2200 Marshall St NE',
    zip: '55418',
  },
  {
    name: 'Ironclad Auto Parts – Detroit Assembly',
    cityIndex: 12,
    street: '12000 Lynch Rd',
    zip: '48234',
  },
  {
    name: 'Redwood Consumer Goods – Cleveland',
    cityIndex: 13,
    street: '4700 Broadway Ave',
    zip: '44127',
  },
  {
    name: 'Bluewater Chemicals – Houston Terminal',
    cityIndex: 14,
    street: '9800 Manchester St',
    zip: '77012',
  },
  {
    name: 'Summit Appliance – Denver DC',
    cityIndex: 15,
    street: '4800 Brighton Blvd',
    zip: '80216',
  },
  {
    name: 'Prairie Beverage – Oklahoma City',
    cityIndex: 16,
    street: '3400 S Eastern Ave',
    zip: '73129',
  },
  {
    name: 'Carolina Furniture Works – Charlotte',
    cityIndex: 17,
    street: '7500 Statesville Rd',
    zip: '28269',
  },
  {
    name: 'Midwest Steel Partners – Pittsburgh Yard',
    cityIndex: 18,
    street: '2600 Neville Rd',
    zip: '15225',
  },
  { name: 'Heartland Foods – Omaha Plant', cityIndex: 19, street: '4800 S 72nd St', zip: '68127' },
];

const CUSTOMER_NAMES = [
  'Midwest Steel Partners',
  'Great Lakes Paper Co.',
  'Heartland Foods Distribution',
  'Prairie Beverage Group',
  'Carolina Furniture Works',
  'Sunbelt Building Supply',
  'Northstar Packaging',
  'Redwood Consumer Goods',
  'Ironclad Auto Parts',
  'Evergreen Produce Cooperative',
  'Bluewater Chemicals',
  'Summit Appliance Outlet',
];

const BROKER_NAMES = [
  'Prime Logistics Group',
  'Blue Ridge Freight Brokers',
  'Atlas Freight Solutions',
  'Cornerstone Transport Brokerage',
  'Silverline Logistics',
  'Harbor Point Freight',
  'Keystone Cargo Partners',
  'Meridian Freight Exchange',
  'Ridgeway Logistics',
  'Pioneer Load Services',
  'Crossroads Freight Network',
  'Lakeshore Transport Brokers',
  'Frontier Freight Management',
  'Redline Logistics Partners',
  'Summit Freight Brokerage',
];

const COMMODITIES: Array<{ name: string; equipment: TrailerType; tempF: number | null }> = [
  { name: 'Steel coils (tarped)', equipment: 'flatbed', tempF: null },
  { name: 'Structural steel beams', equipment: 'flatbed', tempF: null },
  { name: 'Lumber bundles', equipment: 'flatbed', tempF: null },
  { name: 'Palletized paper rolls', equipment: 'dry_van', tempF: null },
  { name: 'Packaged beverages', equipment: 'dry_van', tempF: null },
  { name: 'Household appliances', equipment: 'dry_van', tempF: null },
  { name: 'Auto parts (racked)', equipment: 'dry_van', tempF: null },
  { name: 'Corrugated packaging', equipment: 'dry_van', tempF: null },
  { name: 'Consumer electronics', equipment: 'dry_van', tempF: null },
  { name: 'Furniture (blanket wrap)', equipment: 'dry_van', tempF: null },
  { name: 'Frozen poultry', equipment: 'reefer', tempF: -10 },
  { name: 'Fresh produce', equipment: 'reefer', tempF: 36 },
  { name: 'Dairy products', equipment: 'reefer', tempF: 38 },
  { name: 'Drummed chemicals (non-hazmat)', equipment: 'dry_van', tempF: null },
];

const MAINTENANCE_LABELS: Record<MaintenanceType, string> = {
  oil_change: 'Oil change',
  pm_service: 'PM service',
  brake_inspection: 'Brake inspection',
  brake_repair: 'Brake repair',
  tire_rotation: 'Tire rotation',
  tire_replacement: 'Tire replacement',
  dot_inspection: 'Annual DOT inspection',
  coolant: 'Coolant service',
  transmission: 'Transmission service',
  engine: 'Engine service',
  dpf: 'DPF cleaning',
  battery: 'Battery replacement',
  electrical: 'Electrical repair',
  lights: 'Lights & electrical',
  doors_seals: 'Doors & seals',
  floor_walls: 'Floor & walls',
  landing_gear: 'Landing gear',
  suspension: 'Suspension / airbags',
  reefer_unit: 'Reefer unit',
  other: 'Other',
};

export const maintenanceTypeLabel = (type: MaintenanceType): string => MAINTENANCE_LABELS[type];

const PM_TYPES: Array<{
  type: MaintenanceType;
  intervalMiles: number | null;
  intervalDays: number | null;
}> = [
  { type: 'oil_change', intervalMiles: 25_000, intervalDays: null },
  { type: 'pm_service', intervalMiles: 30_000, intervalDays: null },
  { type: 'brake_inspection', intervalMiles: 50_000, intervalDays: null },
  { type: 'tire_rotation', intervalMiles: 40_000, intervalDays: null },
  { type: 'dot_inspection', intervalMiles: null, intervalDays: 365 },
  { type: 'dpf', intervalMiles: 100_000, intervalDays: null },
  { type: 'coolant', intervalMiles: 150_000, intervalDays: null },
];

const VENDORS = [
  'Northwind Shop – Naperville',
  'TruckPro Service Center – Joliet',
  'Midwest Diesel Repair – Gary',
  'Lone Star Fleet Service – Dallas',
  'Ohio Valley Truck Care – Columbus',
  'Freightliner of Chicago',
  'Volvo Trucks – Indianapolis',
];

const TECHNICIANS = [
  'R. Alvarez',
  'D. Kowalczyk',
  'M. Osei',
  'J. Brandt',
  'S. Delgado',
  'K. Hoffman',
];

const FUEL_STATIONS: Array<{ brand: string; name: string; city: string; state: string }> = [
  { brand: 'Pilot', name: 'Pilot Travel Center #145', city: 'Effingham', state: 'IL' },
  { brand: "Love's", name: "Love's Travel Stop #302", city: 'Joplin', state: 'MO' },
  { brand: 'TA', name: 'TA Gary', city: 'Gary', state: 'IN' },
  { brand: 'Flying J', name: 'Flying J #667', city: 'Oklahoma City', state: 'OK' },
  { brand: 'Petro', name: 'Petro Rochelle', city: 'Rochelle', state: 'IL' },
  { brand: "Love's", name: "Love's Travel Stop #211", city: 'Amarillo', state: 'TX' },
  { brand: 'Pilot', name: 'Pilot Travel Center #439', city: 'Nashville', state: 'TN' },
  { brand: 'TA', name: 'TA Dallas South', city: 'Dallas', state: 'TX' },
  { brand: 'Flying J', name: 'Flying J #712', city: 'Kansas City', state: 'MO' },
  { brand: "Love's", name: "Love's Travel Stop #348", city: 'Little Rock', state: 'AR' },
  { brand: 'Pilot', name: 'Pilot Travel Center #128', city: 'Indianapolis', state: 'IN' },
  { brand: 'TA', name: 'TA Columbus', city: 'Columbus', state: 'OH' },
  { brand: 'Flying J', name: 'Flying J #598', city: 'Memphis', state: 'TN' },
  { brand: "Love's", name: "Love's Travel Stop #418", city: 'Springfield', state: 'MO' },
  { brand: 'Pilot', name: 'Pilot Travel Center #084', city: 'Atlanta', state: 'GA' },
  { brand: 'Petro', name: 'Petro Ottawa', city: 'Ottawa', state: 'IL' },
];

// ---------------------------------------------------------------------------------------------
// Static company, staff, memberships
// ---------------------------------------------------------------------------------------------

const NORTHWIND_COMPANY: Company = {
  id: 'co_northwind',
  slug: 'northwind-freight',
  name: 'Northwind Freight',
  legalName: 'Northwind Freight LLC',
  status: 'active',
  plan: 'Growth',
  timezone: 'America/Chicago',
  usdot: '2847193',
  mcNumber: 'MC-961204',
  scac: 'NWFR',
  phone: '+16305550140',
  address: { line1: '1850 Diehl Rd, Suite 200', city: 'Naperville', state: 'IL', zip: '60563' },
  demo: true,
};

/** The company as the client knows it. An empty workspace knows only its id; the name is in Settings. */
export const demoCompany: Company =
  DATASET === 'empty'
    ? {
        id: NORTHWIND_COMPANY.id,
        slug: '',
        name: '',
        legalName: '',
        status: 'active',
        plan: '',
        timezone: NORTHWIND_COMPANY.timezone,
        usdot: '',
        mcNumber: '',
        scac: '',
        phone: '',
        address: { line1: '', city: '', state: '', zip: '' },
        demo: false,
      }
    : NORTHWIND_COMPANY;

interface StaffDef {
  id: string;
  first: string;
  last: string;
  title: string;
  department: Department;
  role: string;
  phone: string;
  /** When this person joined. Part of the pinned dataset, like every driver's hire date. */
  hireDate: IsoDate;
  /** Who they report to, by user id. The President reports to nobody. */
  managerUserId: string | null;
}

export const STAFF_DEFS: StaffDef[] = [
  {
    id: 'usr_001',
    first: 'Sarah',
    last: 'Chen',
    title: 'Operations Manager',
    department: 'management',
    role: 'Admin',
    phone: '+16305550142',
    hireDate: '2019-02-04',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_002',
    first: 'Marcus',
    last: 'Reid',
    title: 'Senior Dispatcher',
    department: 'dispatch',
    role: 'Dispatcher',
    phone: '+16305550151',
    hireDate: '2020-06-15',
    managerUserId: 'usr_001',
  },
  {
    id: 'usr_003',
    first: 'Priya',
    last: 'Nair',
    title: 'Dispatcher',
    department: 'dispatch',
    role: 'Dispatcher',
    phone: '+16305550152',
    hireDate: '2022-03-07',
    managerUserId: 'usr_002',
  },
  {
    id: 'usr_004',
    first: 'Daniel',
    last: 'Okafor',
    title: 'Dispatcher',
    department: 'dispatch',
    role: 'Dispatcher',
    phone: '+16305550153',
    hireDate: '2023-01-09',
    managerUserId: 'usr_002',
  },
  {
    id: 'usr_005',
    first: 'Elena',
    last: 'Vasquez',
    title: 'Dispatcher',
    department: 'dispatch',
    role: 'Dispatcher',
    phone: '+16305550154',
    hireDate: '2024-08-19',
    managerUserId: 'usr_002',
  },
  {
    id: 'usr_006',
    first: 'Tom',
    last: 'Brennan',
    title: 'Safety Manager',
    department: 'safety',
    role: 'Safety',
    phone: '+16305550161',
    hireDate: '2020-09-28',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_007',
    first: 'Luis',
    last: 'Herrera',
    title: 'Maintenance Manager',
    department: 'maintenance',
    role: 'Maintenance',
    phone: '+16305550171',
    hireDate: '2021-04-12',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_008',
    first: 'Grace',
    last: 'Kim',
    title: 'Accounting Manager',
    department: 'accounting',
    role: 'Accounting',
    phone: '+16305550181',
    hireDate: '2019-11-04',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_009',
    first: 'Ahmed',
    last: 'Sultan',
    title: 'Billing Specialist',
    department: 'accounting',
    role: 'Accounting',
    phone: '+16305550182',
    hireDate: '2023-05-22',
    managerUserId: 'usr_008',
  },
  {
    id: 'usr_010',
    first: 'Monica',
    last: 'Alvarez',
    title: 'HR Manager',
    department: 'hr',
    role: 'HR',
    phone: '+16305550191',
    hireDate: '2021-08-16',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_011',
    first: 'Kevin',
    last: 'Walsh',
    title: 'Fleet Manager',
    department: 'fleet',
    role: 'Fleet',
    phone: '+16305550172',
    hireDate: '2022-01-10',
    managerUserId: 'usr_012',
  },
  {
    id: 'usr_012',
    first: 'Robert',
    last: 'Lindqvist',
    title: 'President',
    department: 'management',
    role: 'Owner',
    phone: '+16305550101',
    hireDate: '2016-01-04',
    managerUserId: null,
  },
];

const NORTHWIND_STAFF: User[] = STAFF_DEFS.map((s, index) => ({
  id: s.id,
  firstName: s.first,
  lastName: s.last,
  name: `${s.first} ${s.last}`,
  email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@northwindfreight.com`,
  phone: s.phone,
  title: s.title,
  department: s.department,
  role: s.role,
  status: 'active',
  lastLoginAt: iso(NOW - (index * 37 + 12) * MINUTE),
}));

/** The people the pickers offer. An empty workspace starts with nobody; see `identity.ts`. */
export const demoUsers: User[] = DATASET === 'empty' ? [] : NORTHWIND_STAFF;

export const demoCurrentUser: User =
  DATASET === 'empty'
    ? {
        id: 'usr_signed_in',
        firstName: '',
        lastName: '',
        name: 'Signed-in user',
        email: '',
        phone: '',
        title: '',
        department: 'management',
        role: '',
        status: 'active',
        lastLoginAt: DEMO_NOW_ISO,
      }
    : must(NORTHWIND_STAFF[0]);

const NORTHWIND_MEMBERSHIPS: Membership[] = [
  {
    companyId: 'co_northwind',
    companyName: 'Northwind Freight',
    companyCity: 'Naperville, IL',
    role: 'Operations Manager',
    status: 'active',
    isCurrent: true,
  },
  {
    companyId: 'co_lakeside',
    companyName: 'Lakeside Carriers',
    companyCity: 'Milwaukee, WI',
    role: 'Dispatcher',
    status: 'active',
    isCurrent: false,
  },
  {
    companyId: 'co_summit',
    companyName: 'Summit Express',
    companyCity: 'Denver, CO',
    role: 'Viewer',
    status: 'pending',
    isCurrent: false,
  },
];

/** The tenant switcher's list. An empty workspace has one company and no switching to offer. */
export const demoMemberships: Membership[] = DATASET === 'empty' ? [] : NORTHWIND_MEMBERSHIPS;

const DISPATCHERS = STAFF_DEFS.slice(1, 5);

// ---------------------------------------------------------------------------------------------
// Generated dataset
// ---------------------------------------------------------------------------------------------

export interface DemoData {
  company: Company;
  users: User[];
  memberships: Membership[];
  trucks: Truck[];
  trailers: Trailer[];
  drivers: Driver[];
  customers: Customer[];
  brokers: Broker[];
  facilities: Facility[];
  loads: Load[];
  maintenance: MaintenanceItem[];
  repairOrders: RepairOrder[];
  serviceRecords: ServiceRecord[];
  truckNotes: TruckNote[];
  fuelTransactions: FuelTransaction[];
  safetyEvents: SafetyEvent[];
  invoices: Invoice[];
  notifications: Notification[];
  tasks: Task[];
  activity: ActivityItem[];
  aiInsights: AiInsight[];
  kpis: KpiSnapshot;
  series: DashboardSeries;
  complianceAudit: ComplianceAuditEntry[];
  inspections: Inspection[];
  defects: Defect[];
  violations: Violation[];
  accidents: Accident[];
  claims: Claim[];
  correctiveActions: CorrectiveAction[];
  vendors: Vendor[];
  invoiceLines: InvoiceLine[];
  payments: Payment[];
  bills: Bill[];
  expenses: Expense[];
  settlements: Settlement[];
  deductionPlans: DeductionPlan[];
  payrollPeriods: PayrollPeriod[];
  payslips: Payslip[];
  journal: JournalEntry[];
  ledgerPeriods: LedgerPeriod[];
  /** Driver escrow movements, and the record of anybody who has left. */
  escrowEntries: EscrowEntry[];
  terminations: TerminationRecord[];
  /** Why a unit left the road: sold, stolen, burned, wrecked. */
  unitExits: UnitExitRecord[];
  /** The weekly walk-around inspection, one row per truck per week. */
  ptiRecords: PtiRecord[];
  /** The walk-around catalog (admin-editable), the append-only ratings, and the carry-over rule. */
  ptiComponents: PtiComponentDef[];
  ptiRatings: PtiComponentRating[];
  /** Stretches of time a unit is out of service. Availability is derived from these. */
  downPeriods: DownPeriod[];
  ptiConditionConfig: PtiConditionConfig;
  /** The kinds of work a work order can be about, and which units each applies to. */
  workOrderTypes: WorkOrderTypeDef[];
  /** Per document type: whether an expired one blocks dispatch or only warns. Empty = catalog defaults. */
  unitDocumentRules: Record<string, 'block' | 'warn'>;
}

/** The catalog defaults, with stable ids so a rating written today still resolves after a reload. */
export function defaultPtiComponents(): PtiComponentDef[] {
  return DEFAULT_PTI_COMPONENTS.map((c, index) => ({ ...c, id: `ptc_${index + 1}` }));
}

export function generateDemoData(seed: number = DEMO_SEED): DemoData {
  const rng = new Rng(seed);

  // ----- facilities -------------------------------------------------------------------------
  const facilities: Facility[] = FACILITY_DEFS.map((def, i) => {
    const city = must(CITIES[def.cityIndex]);
    return {
      id: `fac_${String(i + 1).padStart(2, '0')}`,
      name: def.name,
      address: { line1: def.street, city: city.city, state: city.state, zip: def.zip },
      lat: city.lat,
      lng: city.lng,
      timezone: city.tz,
      appointmentRequired: rng.chance(0.7),
      avgDwellMinutes: rng.int(45, 160),
      hours: rng.chance(0.3) ? '24/7' : 'Mon–Fri 6:00 AM – 6:00 PM',
    };
  });

  // ----- customers & brokers ----------------------------------------------------------------
  const customers: Customer[] = CUSTOMER_NAMES.map((name, i) => {
    const city = rng.pick(CITIES);
    return {
      id: `cus_${String(i + 1).padStart(2, '0')}`,
      name,
      mcNumber: rng.chance(0.4) ? `MC-${rng.digits(6)}` : null,
      usdot: rng.chance(0.5) ? rng.digits(7) : null,
      address: {
        line1: `${rng.int(100, 9900)} ${rng.pick(['Industrial', 'Commerce', 'Enterprise', 'Corporate'])} Dr`,
        city: city.city,
        state: city.state,
        zip: String(rng.int(10000, 99999)),
      },
      paymentTermsDays: rng.pick([30, 30, 45, 60]),
      creditLimit: rng.pick([50_000, 75_000, 100_000, 150_000, 250_000]),
      status: i === 10 ? 'on_hold' : 'active',
      primaryContact: contact(rng, name),
      loadsLast90d: 0,
      revenueLast90d: 0,
    };
  });

  const brokers: Broker[] = BROKER_NAMES.map((name, i) => {
    const city = rng.pick(CITIES);
    const doNotUse = i === 13;
    return {
      id: `brk_${String(i + 1).padStart(2, '0')}`,
      name,
      mcNumber: `MC-${rng.digits(6)}`,
      usdot: rng.digits(7),
      address: {
        line1: `${rng.int(100, 9900)} ${rng.pick(['Main', 'Market', 'Park', 'Lakeview'])} St`,
        city: city.city,
        state: city.state,
        zip: String(rng.int(10000, 99999)),
      },
      paymentTermsDays: rng.pick([30, 30, 45, 60]),
      rating: rng.pick([3, 4, 4, 4.5, 5]),
      doNotUse,
      doNotUseReason: doNotUse ? 'Two invoices past 90 days; collections referred' : null,
      status: doNotUse ? 'on_hold' : 'active',
      primaryContact: contact(rng, name),
      loadsLast90d: 0,
      revenueLast90d: 0,
      outstandingBalance: 0,
    };
  });

  // ----- trucks -----------------------------------------------------------------------------
  const unitNumbers: number[] = [];
  let unit = 2701;
  for (let i = 0; i < 44; i += 1) {
    unitNumbers.push(unit);
    unit += rng.chance(0.7) ? 1 : 2;
  }
  unitNumbers.push(2785);
  unit = 3001;
  for (let i = 0; i < 12; i += 1) {
    if (unit === 3012) unit += 1;
    unitNumbers.push(unit);
    unit += rng.int(1, 4);
  }
  unitNumbers.push(3012, 3091, 3120);
  unitNumbers.sort((a, b) => a - b);

  const statusPool: TruckStatus[] = [
    ...Array<TruckStatus>(35).fill('active'),
    ...Array<TruckStatus>(6).fill('available'),
    ...Array<TruckStatus>(5).fill('idle'),
    ...Array<TruckStatus>(3).fill('in_shop'),
    ...Array<TruckStatus>(3).fill('out_of_service'),
    ...Array<TruckStatus>(2).fill('maintenance'),
    'accident',
    'sold',
  ];
  const shuffledStatuses = rng.shuffle(statusPool);
  let statusCursor = 0;

  const trucks: Truck[] = unitNumbers.map((n) => {
    const unitNumber = String(n);
    const special =
      unitNumber === '2785' ||
      unitNumber === '3012' ||
      unitNumber === '3091' ||
      unitNumber === '3120';
    const year = special
      ? { '2785': 2020, '3012': 2023, '3091': 2024, '3120': 2025 }[
          unitNumber as '2785' | '3012' | '3091' | '3120'
        ]
      : n < 3000
        ? rng.int(2019, 2022)
        : rng.int(2023, 2025);
    const model = special
      ? must(
          TRUCK_MODELS[
            { '2785': 0, '3012': 1, '3091': 2, '3120': 3 }[
              unitNumber as '2785' | '3012' | '3091' | '3120'
            ]
          ],
        )
      : rng.pick(TRUCK_MODELS);
    const status: TruckStatus = special
      ? unitNumber === '3120'
        ? 'in_shop'
        : 'active'
      : must(shuffledStatuses[statusCursor++]);
    const odometer = special
      ? { '2785': 421_500, '3012': 188_400, '3091': 142_900, '3120': 96_300 }[
          unitNumber as '2785' | '3012' | '3091' | '3120'
        ]
      : odometerForYear(rng, year);
    const mpg90 = round2(rng.float(6.2, 7.4));
    const mpgDrop = unitNumber === '3012' ? 0.14 : rng.float(-0.03, 0.03);
    const idle90 = rng.int(8, 16);
    const plateState = unitNumber === '2785' ? 'IL' : rng.pick(PLATE_STATES);
    return {
      id: `trk_${unitNumber}`,
      unitNumber,
      vin: `${model.wmi}${rng.chars(1, '0123456789X')}${must(VIN_YEAR[year])}${rng.chars(1, 'ABCDEFGHJKLMNPRSTUVWXYZ')}${rng.digits(6)}`,
      year,
      make: model.make,
      model: model.model,
      plate: `${rng.chars(2, 'ABCDEFGHJKLMNPRSTUVWXYZ')}${rng.digits(5)}`,
      plateState,
      color: rng.pick(TRUCK_COLORS),
      status,
      health: 'healthy',
      ownership: rng.chance(0.7) ? 'owned' : rng.chance(0.7) ? 'leased' : 'owner_operator',
      odometer,
      odometerAt: iso(NOW - rng.int(2, 240) * MINUTE),
      engineHours: Math.round(odometer / rng.float(38, 46)),
      inServiceDate: isoDate(Date.UTC(year, rng.int(0, 11), rng.int(1, 28))),
      currentDriverId: null,
      currentDriverName: null,
      currentTrailerId: null,
      currentLoadId: null,
      location: null,
      nextServiceOdometer: odometer + 5000,
      nextServiceDate: isoDate(NOW + 12 * DAY),
      nextServiceType: 'oil_change',
      telematicsProvider: unitNumber === '2785' ? 'Samsara' : rng.pick(TELEMATICS),
      telematicsStatus:
        status === 'sold' ? 'disconnected' : rng.chance(0.96) ? 'connected' : 'error',
      mpg30d: unitNumber === '3012' ? 5.93 : round2(mpg90 * (1 - mpgDrop)),
      mpg90d: unitNumber === '3012' ? 6.9 : mpg90,
      idlePercent30d: unitNumber === '3012' ? 21 : Math.max(4, idle90 + rng.int(-2, 2)),
      idlePercent90d: unitNumber === '3012' ? 12 : idle90,
      homeTerminal: 'Naperville, IL',
    };
  });

  const truckByUnit = new Map(trucks.map((t) => [t.unitNumber, t]));
  const truckById = new Map(trucks.map((t) => [t.id, t]));

  // ----- trailers ---------------------------------------------------------------------------
  const trailerStatusPool: TrailerStatus[] = [
    ...Array<TrailerStatus>(32).fill('assigned'),
    ...Array<TrailerStatus>(7).fill('available'),
    ...Array<TrailerStatus>(3).fill('in_shop'),
    ...Array<TrailerStatus>(2).fill('out_of_service'),
    'sold',
  ];
  const trailerStatuses = rng.shuffle(trailerStatusPool);
  const trailers: Trailer[] = [];
  let trailerUnit = 5301;
  for (let i = 0; i < 45; i += 1) {
    const type: TrailerType = i < 25 ? 'dry_van' : i < 37 ? 'reefer' : 'flatbed';
    const make =
      type === 'flatbed'
        ? rng.pick(['Fontaine', 'MAC Trailer'])
        : rng.pick(['Great Dane', 'Utility', 'Wabash', 'Hyundai Translead']);
    trailers.push({
      id: `trl_${trailerUnit}`,
      unitNumber: `T-${trailerUnit}`,
      vin: `1GR${rng.chars(5, 'ABCDEFGHJKLMNPRSTUVWXYZ0123456789')}${rng.chars(1, '0123456789X')}${must(VIN_YEAR[rng.int(2019, 2025)])}${rng.chars(1, 'ABCDEFGHJKLMNPRSTUVWXYZ')}${rng.digits(6)}`,
      year: rng.int(2018, 2025),
      make,
      // No draw from the generator, so every later demo value stays where it was.
      model: null,
      type,
      lengthFt: type === 'flatbed' ? 48 : 53,
      plate: `${rng.chars(1, 'ABCDEFGHJKLMNPRSTUVWXYZ')}${rng.digits(6)}`,
      plateState: rng.pick(PLATE_STATES),
      status: must(trailerStatuses[i]),
      ownership: rng.chance(0.8) ? 'owned' : 'leased',
      currentTruckId: null,
      currentTruckUnit: null,
      location: null,
      nextInspectionDate: isoDate(NOW + rng.int(10, 330) * DAY),
    });
    trailerUnit += rng.int(1, 3);
  }
  const assignedTrailers = trailers.filter((t) => t.status === 'assigned');

  // ----- drivers ----------------------------------------------------------------------------
  const usedNames = new Set<string>();
  const drivers: Driver[] = [];
  for (let i = 0; i < 70; i += 1) {
    const number = 2031 + i;
    let first: string;
    let last: string;
    if (i === 0) {
      first = 'Darnell';
      last = 'Whitaker';
    } else if (number === 2091) {
      first = 'Travis';
      last = 'Mercer';
    } else {
      do {
        first = must(FIRST_NAMES[(i * 7 + rng.int(0, 3)) % FIRST_NAMES.length]);
        last = rng.pick(LAST_NAMES);
      } while (
        usedNames.has(`${first} ${last}`) ||
        (first === 'Darnell' && last === 'Whitaker') ||
        (first === 'Travis' && last === 'Mercer')
      );
    }
    usedNames.add(`${first} ${last}`);
    const dispatcher = must(DISPATCHERS[i % DISPATCHERS.length]);
    const home = rng.pick(CITIES);
    const medicalDays = i === 4 ? 12 : i === 9 ? 27 : i === 15 ? 21 : rng.int(45, 700);
    const cdlDays = i === 22 ? 17 : rng.int(60, 1400);
    const language = rng.chance(0.75) ? 'en' : rng.pick(['es', 'ru', 'uk'] as const);
    drivers.push({
      id: `drv_${number}`,
      driverNumber: `D-${number}`,
      firstName: first,
      lastName: last,
      name: `${first} ${last}`,
      phone: `+1${rng.pick(['312', '630', '773', '815', '219', '469', '214'])}555${rng.digits(4)}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@northwindfreight.com`,
      driverType: rng.chance(0.78)
        ? 'company'
        : rng.chance(0.6)
          ? 'owner_operator'
          : 'lease_operator',
      cdlState: rng.pick(['IL', 'IL', 'IL', 'IN', 'WI', 'TX', 'MO', 'OH']),
      cdlClass: 'A',
      cdlEndorsements: rng.chance(0.4) ? ['T'] : rng.chance(0.3) ? ['H', 'N'] : [],
      cdlExpiresOn: isoDate(NOW + cdlDays * DAY),
      cdlStatus: cdlDays <= 30 ? 'expiring' : 'verified',
      medicalCardExpiresOn: isoDate(NOW + medicalDays * DAY),
      medicalCardStatus: medicalDays <= 30 ? 'expiring' : 'verified',
      hireDate: isoDate(NOW - rng.int(90, 2600) * DAY),
      status: 'available',
      dispatcherId: dispatcher.id,
      dispatcherName: `${dispatcher.first} ${dispatcher.last}`,
      currentTruckId: null,
      currentTruckUnit: null,
      currentTrailerId: null,
      homeCity: home.city,
      homeState: home.state,
      safetyScore: i === 0 ? 91 : number === 2091 ? 64 : rng.int(62, 98),
      safetyEvents30d: 0,
      payPlan: rng.chance(0.8)
        ? { kind: 'per_mile', rate: round2(rng.float(0.58, 0.7)) }
        : { kind: 'percent_of_linehaul', rate: 0.27 },
      preferredLanguage: language,
    });
  }
  const driverById = new Map(drivers.map((d) => [d.id, d]));

  // Assign drivers to trucks: unit 2785 → Darnell; driver 2091 → first other active unit.
  const trucksNeedingDrivers = trucks.filter((t) =>
    ['active', 'idle', 'in_shop', 'maintenance', 'accident'].includes(t.status),
  );
  const driverQueue = drivers.filter((d) => d.id !== 'drv_2031' && d.id !== TRENDING_DRIVER_ID);
  let queueCursor = 0;
  const firstOtherActive = must(
    trucksNeedingDrivers.find((t) => t.status === 'active' && t.unitNumber !== HERO_UNIT),
  );
  let trailerCursor = 0;
  for (const truck of trucksNeedingDrivers) {
    const driver =
      truck.unitNumber === HERO_UNIT
        ? must(driverById.get('drv_2031'))
        : truck === firstOtherActive
          ? must(driverById.get(TRENDING_DRIVER_ID))
          : must(driverQueue[queueCursor++]);
    truck.currentDriverId = driver.id;
    truck.currentDriverName = driver.name;
    driver.currentTruckId = truck.id;
    driver.currentTruckUnit = truck.unitNumber;
    if (truck.status === 'active' && trailerCursor < assignedTrailers.length) {
      const trailer = must(assignedTrailers[trailerCursor++]);
      trailer.currentTruckId = truck.id;
      trailer.currentTruckUnit = truck.unitNumber;
      truck.currentTrailerId = trailer.id;
      driver.currentTrailerId = trailer.id;
    }
    driver.status =
      truck.status === 'active'
        ? rng.chance(0.6)
          ? 'driving'
          : rng.chance(0.6)
            ? 'dispatched'
            : rng.chance(0.5)
              ? 'sleeper'
              : 'off_duty'
        : truck.status === 'idle'
          ? 'off_duty'
          : truck.status === 'accident'
            ? 'suspended'
            : 'available';
  }
  const unassignedStatuses: DriverStatus[] = [
    ...Array<DriverStatus>(8).fill('available'),
    ...Array<DriverStatus>(5).fill('off_duty'),
    ...Array<DriverStatus>(3).fill('inactive'),
    'suspended',
    ...Array<DriverStatus>(3).fill('terminated'),
  ];
  let unassignedCursor = 0;
  for (const driver of drivers) {
    if (driver.currentTruckId === null) {
      driver.status = unassignedStatuses[unassignedCursor++] ?? 'available';
    }
  }
  must(driverById.get('drv_2031')).status = 'driving';

  // Locations.
  for (const truck of trucks) {
    if (truck.status === 'sold') continue;
    const onRoad = truck.status === 'active';
    const spot = onRoad
      ? rng.pick([
          ...CITIES,
          ...ROAD_CITIES.map((c) => ({ ...c, lat: 0, lng: 0, tz: 'America/Chicago' })),
        ])
      : null;
    const base =
      spot && spot.lat !== 0
        ? spot
        : spot
          ? { ...spot, lat: 39.5 + rng.float(-4, 4), lng: -90 + rng.float(-8, 8) }
          : HOME_TERMINAL;
    truck.location = {
      city: truck.unitNumber === HERO_UNIT ? 'Dallas' : base.city,
      state: truck.unitNumber === HERO_UNIT ? 'TX' : base.state,
      lat: truck.unitNumber === HERO_UNIT ? 32.9127 : round2(base.lat + rng.float(-0.2, 0.2)),
      lng: truck.unitNumber === HERO_UNIT ? -96.9483 : round2(base.lng + rng.float(-0.2, 0.2)),
      updatedAt: iso(NOW - rng.int(1, 45) * MINUTE),
      speedMph: onRoad ? (rng.chance(0.7) ? rng.int(52, 68) : 0) : 0,
      engineState: onRoad ? (rng.chance(0.75) ? 'on' : 'idle') : 'off',
    };
    if (truck.unitNumber === HERO_UNIT && truck.location) {
      truck.location.speedMph = 58;
      truck.location.engineState = 'on';
      truck.location.updatedAt = iso(NOW - 2 * MINUTE);
    }
  }
  for (const trailer of trailers) {
    if (trailer.status === 'sold') continue;
    const truck = trailer.currentTruckId ? truckById.get(trailer.currentTruckId) : undefined;
    trailer.location = truck?.location
      ? { city: truck.location.city, state: truck.location.state }
      : { city: HOME_TERMINAL.city, state: HOME_TERMINAL.state };
  }

  // ----- loads ------------------------------------------------------------------------------
  const activePlan: Array<{
    status: LoadStatus;
    exception?: { code: 'at_risk' | 'delayed'; reason: string };
  }> = [
    {
      status: 'in_transit',
      exception: {
        code: 'at_risk',
        reason: 'ETA is 1h 20m past the appointment window; driver has 2h 10m of drive time left',
      },
    },
    { status: 'in_transit' },
    {
      status: 'at_delivery',
      exception: {
        code: 'delayed',
        reason: 'Receiver dock backed up; unloading pushed to 6:00 PM',
      },
    },
    { status: 'unloading' },
    { status: 'loaded' },
    {
      status: 'in_transit',
      exception: {
        code: 'delayed',
        reason: 'Detained 3h 05m at pickup; shipper loading behind schedule',
      },
    },
    { status: 'loading' },
    {
      status: 'at_pickup',
      exception: {
        code: 'at_risk',
        reason: 'Arrived 45 min after appointment; shipper may reschedule to next available slot',
      },
    },
    { status: 'dispatched' },
    { status: 'dispatched' },
    { status: 'in_transit' }, // hero, L-100245
    { status: 'assigned' },
    { status: 'assigned' },
    { status: 'booked' },
    { status: 'booked' },
  ];
  const HERO_INDEX = 115;
  const eligibleTrucks = trucks.filter(
    (t) => t.status === 'active' && t.currentDriverId && t.unitNumber !== HERO_UNIT,
  );
  const shuffledEligible = rng.shuffle(eligibleTrucks);
  let activeTruckCursor = 0;
  const loads: Load[] = [];

  for (let i = 0; i < 120; i += 1) {
    const loadNumber = `L-${100130 + i}`;
    const isHero = i === HERO_INDEX;
    const plan = i >= 105 ? must(activePlan[i - 105]) : null;
    const dispatcher = isHero ? must(DISPATCHERS[0]) : rng.pick(DISPATCHERS);
    const customer = isHero ? must(customers[0]) : rng.pick(customers);
    const broker = isHero
      ? must(brokers[0])
      : rng.chance(0.72)
        ? rng.pick(brokers.filter((b) => !b.doNotUse))
        : null;
    const commodity = isHero ? must(COMMODITIES[0]) : rng.pick(COMMODITIES);

    // Stops.
    let stopFacilities: Facility[];
    if (isHero) {
      stopFacilities = [must(facilities[0]), must(facilities[1])];
    } else {
      const count = rng.chance(0.55) ? 2 : rng.chance(0.65) ? 3 : 4;
      const pool = rng.shuffle(facilities);
      stopFacilities = pool.slice(0, count);
    }
    let miles = 0;
    for (let s = 1; s < stopFacilities.length; s += 1) {
      miles += roadMiles(must(stopFacilities[s - 1]), must(stopFacilities[s]));
    }
    if (isHero) miles = 1000;
    miles = Math.max(150, miles);

    // Status.
    let status: LoadStatus;
    if (plan) status = plan.status;
    else if (i % 29 === 7) status = 'cancelled';
    else if (i % 53 === 20) status = 'tonu';
    else status = i >= 92 ? 'delivered' : 'closed';

    // Timing.
    const transitHours = Math.max(
      5,
      miles / 48 + (miles > 550 ? 10 : 0) + (stopFacilities.length - 2) * 3,
    );
    let pickupMs: number;
    if (isHero) {
      pickupMs = daysAgo(1, 8);
    } else if (plan) {
      const offsetsByStatus: Record<string, () => number> = {
        in_transit: () => NOW - rng.float(0.35, 0.8) * transitHours * HOUR - 2 * HOUR,
        at_delivery: () => NOW - transitHours * HOUR - 2.5 * HOUR,
        unloading: () => NOW - transitHours * HOUR - 3.5 * HOUR,
        loaded: () => NOW - 3 * HOUR,
        loading: () => NOW - 1 * HOUR,
        at_pickup: () => NOW - 1.25 * HOUR,
        dispatched: () => NOW + rng.float(3, 16) * HOUR,
        assigned: () => NOW + rng.float(20, 34) * HOUR,
        booked: () => NOW + rng.float(44, 70) * HOUR,
      };
      pickupMs = must(offsetsByStatus[plan.status])();
    } else {
      const days = 88 - Math.round(i * 0.8) + rng.int(-1, 1);
      pickupMs = daysAgo(Math.max(4, days), rng.int(6, 15), rng.chance(0.5) ? 0 : 30);
    }

    const stops: Stop[] = [];
    let cursorMs = pickupMs;
    stopFacilities.forEach((facility, index) => {
      const offset = must(TZ_OFFSET[facility.timezone]);
      const kind: Stop['kind'] =
        index === 0
          ? 'pickup'
          : index === stopFacilities.length - 1
            ? 'delivery'
            : rng.chance(0.5)
              ? 'pickup'
              : 'delivery';
      if (index > 0) {
        const legMiles = roadMiles(must(stopFacilities[index - 1]), facility);
        const legHours = isHero ? 30 : Math.max(3, legMiles / 48 + (legMiles > 550 ? 10 : 0));
        cursorMs += legHours * HOUR;
      }
      const start = isHero
        ? index === 0
          ? daysAgo(1, 8)
          : daysAgo(0, 16)
        : plan
          ? cursorMs
          : atLocal(
              cursorMs,
              clamp(Math.round(((cursorMs - offset) / HOUR) % 24), 6, 16),
              0,
              offset,
            );
      stops.push({
        id: `stp_${loadNumber.slice(2)}_${index + 1}`,
        sequence: index + 1,
        kind,
        facilityId: facility.id,
        facilityName: facility.name,
        city: facility.address.city,
        state: facility.address.state,
        timezone: facility.timezone,
        appointmentStartAt: iso(start),
        appointmentEndAt: iso(start + 2 * HOUR),
        status: 'pending',
        arrivedAt: null,
        departedAt: null,
        detentionMinutes: 0,
        notes: null,
      });
      cursorMs = start;
    });
    const firstStop = must(stops[0]);
    const lastStop = must(stops[stops.length - 1]);
    const pickupAt = new Date(firstStop.appointmentStartAt).getTime();
    const deliveryAt = new Date(lastStop.appointmentStartAt).getTime();

    // Money.
    const rate = isHero
      ? 2500
      : clamp(Math.round((miles * rng.float(2.0, 3.25)) / 25) * 25, 900, 6800);
    const fuelSurcharge = isHero
      ? 300
      : status === 'tonu'
        ? 0
        : Math.round(rate * rng.float(0.08, 0.14));
    const charges: Load['charges'] = [
      {
        id: `chg_${i}_1`,
        type: 'linehaul',
        description: 'Linehaul',
        amount: rate - fuelSurcharge,
        billable: true,
        payableToDriver: true,
      },
    ];
    if (fuelSurcharge > 0)
      charges.push({
        id: `chg_${i}_2`,
        type: 'fuel_surcharge',
        description: 'Fuel surcharge',
        amount: fuelSurcharge,
        billable: true,
        payableToDriver: false,
      });
    const financials = isHero
      ? {
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
        }
      : buildFinancials(
          rng,
          status === 'tonu' ? 250 : status === 'cancelled' ? 0 : rate,
          status === 'cancelled' ? 0 : miles,
        );
    const expenses: Load['expenses'] = [
      {
        id: `exp_${i}_1`,
        category: 'fuel',
        description: 'Fuel allocation',
        amount: financials.fuel,
        source: 'fuel_allocation',
      },
      {
        id: `exp_${i}_2`,
        category: 'driver_pay',
        description: 'Driver pay',
        amount: financials.driverPay,
        source: 'driver_pay',
      },
      {
        id: `exp_${i}_3`,
        category: 'tolls',
        description: 'Tolls',
        amount: financials.tolls,
        source: 'toll',
      },
      {
        id: `exp_${i}_4`,
        category: 'maintenance',
        description: 'Maintenance allocation',
        amount: financials.maintenanceAllocation,
        source: 'maintenance_allocation',
      },
      {
        id: `exp_${i}_5`,
        category: 'other',
        description: 'Permits, scale, misc',
        amount: financials.other,
        source: 'manual',
      },
    ];

    // Assignment.
    let truck: Truck | null = null;
    if (isHero) truck = must(truckByUnit.get(HERO_UNIT));
    else if (plan && plan.status !== 'booked') truck = must(shuffledEligible[activeTruckCursor++]);
    else if (!plan && status !== 'cancelled') truck = rng.pick(trucksNeedingDrivers);
    const driver = truck?.currentDriverId ? must(driverById.get(truck.currentDriverId)) : null;
    const trailer = truck?.currentTrailerId
      ? (trailers.find((t) => t.id === truck?.currentTrailerId) ?? null)
      : null;
    if (plan && truck) {
      truck.currentLoadId = `ld_${loadNumber.slice(2)}`;
      if (plan.status === 'in_transit' && !isHero) truck.status = 'driving';
      if (driver && ['in_transit', 'loaded'].includes(plan.status)) driver.status = 'driving';
      if (
        driver &&
        ['dispatched', 'assigned', 'at_pickup', 'loading', 'at_delivery', 'unloading'].includes(
          plan.status,
        )
      )
        driver.status = 'dispatched';
    }

    const dispatcherName = `${dispatcher.first} ${dispatcher.last}`;
    const load: Load = {
      id: `ld_${loadNumber.slice(2)}`,
      loadNumber,
      status,
      exception: plan?.exception
        ? { ...plan.exception, raisedAt: iso(NOW - rng.int(25, 180) * MINUTE) }
        : null,
      customerId: customer.id,
      customerName: customer.name,
      brokerId: broker?.id ?? null,
      brokerName: broker?.name ?? null,
      brokerReference: broker
        ? `${broker.name.split(' ')[0]?.slice(0, 3).toUpperCase()}-${rng.digits(6)}`
        : `PO-${rng.digits(7)}`,
      commodity: commodity.name,
      weightLbs: isHero ? 42_800 : rng.int(12, 44) * 1000 + rng.int(0, 9) * 100,
      pieces: isHero ? 12 : rng.int(6, 26),
      equipmentType: commodity.equipment,
      temperatureF: commodity.tempF,
      hazmat: false,
      dispatcherId: dispatcher.id,
      dispatcherName,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      truckId: truck?.id ?? null,
      truckUnit: truck?.unitNumber ?? null,
      trailerId: trailer?.id ?? null,
      trailerUnit: trailer?.unitNumber ?? null,
      origin: { city: firstStop.city, state: firstStop.state },
      destination: { city: lastStop.city, state: lastStop.state },
      stops,
      rate: financials.revenue,
      loadedMiles: miles,
      emptyMiles: isHero ? 35 : rng.int(10, 140),
      rpm: financials.rpm,
      charges,
      expenses,
      financials,
      timeline: [],
      notes: [],
      documents: [],
      pickupAt: iso(pickupAt),
      deliveryAt: iso(deliveryAt),
      etaAt: null,
      milesRemaining: null,
      bookedAt: iso(pickupAt - rng.int(24, 96) * HOUR),
      dispatchedAt: null,
      deliveredAt: null,
      invoiceId: null,
      createdAt: '',
      updatedAt: '',
    };
    load.createdAt = load.bookedAt;
    if (status === 'tonu') {
      load.charges = [
        {
          id: `chg_${i}_1`,
          type: 'tonu',
          description: 'Truck ordered not used',
          amount: 250,
          billable: true,
          payableToDriver: false,
        },
      ];
    }
    buildTimeline(rng, load, dispatcherName, isHero);
    loads.push(load);
  }

  // Broker / customer aggregates.
  for (const load of loads) {
    if (load.status === 'cancelled') continue;
    const customer = must(customers.find((c) => c.id === load.customerId));
    customer.loadsLast90d += 1;
    customer.revenueLast90d = round2(customer.revenueLast90d + load.rate);
    if (load.brokerId) {
      const broker = must(brokers.find((b) => b.id === load.brokerId));
      broker.loadsLast90d += 1;
      broker.revenueLast90d = round2(broker.revenueLast90d + load.rate);
    }
  }

  // ----- maintenance ------------------------------------------------------------------------
  const maintenance: MaintenanceItem[] = [];
  const quota = { overdue: 9, due_soon: 14, scheduled: 8 };
  const specialUnits = new Set(['2785', '3012', '3091', '3120']);
  const candidates: Array<{ truck: Truck; typeIndex: number }> = [];
  for (const truck of trucks) {
    if (truck.status === 'sold') continue;
    const typeCount =
      truck.unitNumber === HERO_UNIT || rng.chance(0.4) ? 6 : rng.chance(0.5) ? 5 : 4;
    for (let typeIndex = 0; typeIndex < typeCount; typeIndex += 1) {
      candidates.push({ truck, typeIndex });
    }
  }
  const forced = new Map<string, MaintenanceStatus>();
  forced.set('3091:1', 'overdue');
  forced.set('2785:2', 'due_soon');
  forced.set('3120:1', 'in_shop');
  const shuffledCandidates = rng.shuffle(
    candidates.filter((c) => !specialUnits.has(c.truck.unitNumber) && c.truck.status !== 'in_shop'),
  );
  let remaining = { ...quota };
  const forcedByRandom = new Map<string, MaintenanceStatus>();
  for (const c of shuffledCandidates) {
    const key = `${c.truck.unitNumber}:${c.typeIndex}`;
    if (remaining.overdue > 1) {
      forcedByRandom.set(key, 'overdue');
      remaining = { ...remaining, overdue: remaining.overdue - 1 };
      continue;
    }
    if (remaining.due_soon > 1) {
      forcedByRandom.set(key, 'due_soon');
      remaining = { ...remaining, due_soon: remaining.due_soon - 1 };
      continue;
    }
    if (remaining.scheduled > 0) {
      forcedByRandom.set(key, 'scheduled');
      remaining = { ...remaining, scheduled: remaining.scheduled - 1 };
      continue;
    }
    break;
  }
  const inShopDone = new Set<string>();
  for (const { truck, typeIndex } of candidates) {
    const def = must(PM_TYPES[typeIndex]);
    const key = `${truck.unitNumber}:${typeIndex}`;
    let status: MaintenanceStatus = forced.get(key) ?? forcedByRandom.get(key) ?? 'ok';
    if (
      truck.status === 'in_shop' &&
      !inShopDone.has(truck.unitNumber) &&
      !specialUnits.has(truck.unitNumber)
    ) {
      status = 'in_shop';
      inShopDone.add(truck.unitNumber);
    }
    const milesPerDay = 420;
    let milesUntilDue: number;
    let daysUntilDue: number;
    if (def.intervalMiles !== null) {
      milesUntilDue =
        key === '2785:2'
          ? 2500
          : key === '3091:1'
            ? -1800
            : status === 'overdue'
              ? -rng.int(200, 4000)
              : status === 'due_soon'
                ? rng.int(300, 3000)
                : status === 'scheduled'
                  ? rng.int(500, 5000)
                  : status === 'in_shop'
                    ? rng.int(-500, 500)
                    : rng.int(3500, def.intervalMiles);
      daysUntilDue = Math.round(milesUntilDue / milesPerDay);
    } else {
      daysUntilDue =
        status === 'overdue'
          ? -rng.int(3, 40)
          : status === 'due_soon'
            ? rng.int(2, 14)
            : status === 'scheduled'
              ? rng.int(2, 21)
              : status === 'in_shop'
                ? 0
                : rng.int(20, 340);
      milesUntilDue = daysUntilDue * milesPerDay;
    }
    const interval = def.intervalMiles ?? must(def.intervalDays) * milesPerDay;
    const nextDueOdometer = truck.odometer + milesUntilDue;
    maintenance.push({
      id: `pm_${truck.unitNumber}_${def.type}`,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      type: def.type,
      typeLabel: MAINTENANCE_LABELS[def.type],
      intervalMiles: def.intervalMiles,
      intervalDays: def.intervalDays,
      lastDoneAt: isoDate(
        NOW + (daysUntilDue - (def.intervalDays ?? Math.round(interval / milesPerDay))) * DAY,
      ),
      lastDoneOdometer: nextDueOdometer - interval,
      nextDueAt: isoDate(NOW + daysUntilDue * DAY),
      nextDueOdometer,
      milesUntilDue,
      daysUntilDue,
      status,
      scheduledFor:
        status === 'scheduled' || status === 'in_shop'
          ? isoDate(NOW + Math.max(0, Math.min(daysUntilDue, rng.int(1, 10))) * DAY)
          : null,
      vendorName: status === 'scheduled' || status === 'in_shop' ? rng.pick(VENDORS) : null,
    });
  }
  // Truck next-service fields + health.
  const maintenanceByTruck = new Map<string, MaintenanceItem[]>();
  for (const item of maintenance) {
    const list = maintenanceByTruck.get(item.truckId) ?? [];
    list.push(item);
    maintenanceByTruck.set(item.truckId, list);
  }
  for (const truck of trucks) {
    const items = maintenanceByTruck.get(truck.id) ?? [];
    const next = [...items].sort((a, b) => a.milesUntilDue - b.milesUntilDue)[0];
    if (next) {
      truck.nextServiceOdometer = next.nextDueOdometer;
      truck.nextServiceDate = next.nextDueAt;
      truck.nextServiceType = next.type;
    }
    const worst = items.some((m) => m.status === 'overdue');
    const attention = items.some(
      (m) => m.status === 'due_soon' || m.status === 'scheduled' || m.status === 'in_shop',
    );
    truck.health = truckHealth(truck.status, worst, attention);
  }

  // ----- repair orders ----------------------------------------------------------------------
  const repairOrders: RepairOrder[] = [];
  let roSeq = 1041;
  const pushRo = (
    truck: Truck,
    spec: {
      status: RepairOrderStatus;
      type: MaintenanceType;
      summary: string;
      openedDaysAgo: number;
      downtimeHours: number;
      parts: number;
      labor: number;
      priority?: RepairOrder['priority'];
      vendor?: string;
      notes?: string;
    },
  ): RepairOrder => {
    const opened = daysAgo(spec.openedDaysAgo, rng.int(7, 11));
    const completed = spec.status === 'completed' ? opened + spec.downtimeHours * HOUR : null;
    const fees = round2((spec.parts + spec.labor) * 0.04);
    const ro: RepairOrder = {
      id: `ro_${roSeq}`,
      roNumber: `RO-2026-${roSeq}`,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      status: spec.status,
      priority: spec.priority ?? (spec.status === 'in_shop' ? 'high' : 'normal'),
      type: spec.type,
      summary: spec.summary,
      vendorName: spec.vendor ?? rng.pick(VENDORS),
      technician: rng.pick(TECHNICIANS),
      openedAt: iso(opened),
      promisedAt:
        spec.status === 'in_shop' || spec.status === 'scheduled' || spec.status === 'open'
          ? iso(opened + rng.int(2, 6) * DAY)
          : completed
            ? iso(completed)
            : null,
      completedAt: completed ? iso(completed) : null,
      odometer: Math.max(1000, truck.odometer - Math.round(spec.openedDaysAgo * 400)),
      downtimeMinutes:
        spec.status === 'completed' || spec.status === 'in_shop' ? spec.downtimeHours * 60 : 0,
      partsTotal: spec.parts,
      laborTotal: spec.labor,
      feesTotal: fees,
      total: round2(spec.parts + spec.labor + fees),
      warranty: rng.chance(0.15),
      notes: spec.notes ?? null,
    };
    roSeq += 1;
    repairOrders.push(ro);
    return ro;
  };
  const hero = must(truckByUnit.get(HERO_UNIT));
  const unit3012 = must(truckByUnit.get('3012'));
  const unit3120 = must(truckByUnit.get('3120'));
  pushRo(hero, {
    status: 'completed',
    type: 'brake_repair',
    summary: 'Replace front brake chambers and shoes',
    openedDaysAgo: 168,
    downtimeHours: 9,
    parts: 842.5,
    labor: 610,
    vendor: must(VENDORS[0]),
  });
  pushRo(hero, {
    status: 'completed',
    type: 'brake_repair',
    summary: 'Rear axle brake drums and shoes; adjust slack adjusters',
    openedDaysAgo: 92,
    downtimeHours: 11,
    parts: 1264,
    labor: 780,
    vendor: must(VENDORS[0]),
  });
  pushRo(hero, {
    status: 'completed',
    type: 'brake_repair',
    summary: 'Air leak at relay valve; replace valve, reseat lines, re-adjust brakes',
    openedDaysAgo: 24,
    downtimeHours: 6,
    parts: 318.4,
    labor: 455,
    vendor: must(VENDORS[1]),
    notes: 'Third brake-related visit in 6 months. Driver reports soft pedal intermittently.',
  });
  pushRo(unit3012, {
    status: 'completed',
    type: 'engine',
    summary: 'EGR cooler replacement; coolant flush',
    openedDaysAgo: 61,
    downtimeHours: 26,
    parts: 2180,
    labor: 1340,
    vendor: must(VENDORS[6]),
  });
  pushRo(unit3012, {
    status: 'completed',
    type: 'engine',
    summary: 'Injector #4 replacement; forced DPF regeneration',
    openedDaysAgo: 15,
    downtimeHours: 14,
    parts: 1420,
    labor: 720,
    vendor: must(VENDORS[6]),
    notes: 'Fault code P0204 returned twice in 30 days.',
  });
  pushRo(unit3120, {
    status: 'in_shop',
    type: 'transmission',
    summary: 'Transmission clutch actuator failure; awaiting parts',
    openedDaysAgo: 3,
    downtimeHours: 52,
    parts: 3190,
    labor: 1180,
    priority: 'urgent',
    vendor: must(VENDORS[3]),
    notes: 'ETA on actuator from OEM: Sep 8.',
  });
  for (const truck of trucks.filter(
    (t) => t.status === 'in_shop' && !specialUnits.has(t.unitNumber),
  )) {
    pushRo(truck, {
      status: 'in_shop',
      type: rng.pick(['electrical', 'dpf', 'tire_replacement', 'coolant'] as const),
      summary: rng.pick([
        'Aftertreatment fault; DPF cleaning and sensor replacement',
        'Steer tire replacement and alignment',
        'Coolant leak at radiator; replace radiator and hoses',
        'Wiring harness chafe; intermittent ABS light',
      ]),
      openedDaysAgo: rng.int(1, 5),
      downtimeHours: rng.int(8, 40),
      parts: round2(rng.float(300, 2400)),
      labor: round2(rng.float(200, 1200)),
    });
  }
  const generalStatuses: RepairOrderStatus[] = [
    'open',
    'open',
    'open',
    'scheduled',
    'scheduled',
    'scheduled',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'completed',
    'draft',
    'cancelled',
  ];
  const generalPool = trucks.filter(
    (t) => !specialUnits.has(t.unitNumber) && t.status !== 'sold' && t.status !== 'in_shop',
  );
  while (repairOrders.length < 25) {
    const status = must(generalStatuses[repairOrders.length - 9] ?? 'completed');
    const type = rng.pick([
      'brake_repair',
      'electrical',
      'tire_replacement',
      'engine',
      'coolant',
      'battery',
      'dpf',
      'other',
    ] as const);
    pushRo(rng.pick(generalPool), {
      status,
      type,
      summary: roSummary(rng, type),
      openedDaysAgo:
        status === 'completed' || status === 'cancelled' ? rng.int(6, 170) : rng.int(0, 6),
      downtimeHours: rng.int(3, 30),
      parts: round2(rng.float(120, 2600)),
      labor: round2(rng.float(150, 1400)),
      priority: status === 'open' ? rng.pick(['normal', 'high']) : 'normal',
    });
  }

  // ----- service records --------------------------------------------------------------------
  const serviceRecords: ServiceRecord[] = [];
  let srSeq = 1;
  for (const ro of repairOrders.filter((r) => r.status === 'completed')) {
    serviceRecords.push({
      id: `sr_${String(srSeq++).padStart(4, '0')}`,
      truckId: ro.truckId,
      unitNumber: ro.unitNumber,
      type: ro.type,
      typeLabel: MAINTENANCE_LABELS[ro.type],
      description: ro.summary,
      doneAt: isoDate(new Date(must(ro.completedAt)).getTime()),
      odometer: ro.odometer,
      vendorName: ro.vendorName,
      cost: ro.total,
      repairOrderId: ro.id,
    });
  }
  serviceRecords.push({
    id: `sr_${String(srSeq++).padStart(4, '0')}`,
    truckId: unit3012.id,
    unitNumber: '3012',
    type: 'engine',
    typeLabel: 'Engine service',
    description: 'Turbo actuator recalibration; boost pressure fault',
    doneAt: isoDate(daysAgo(118)),
    odometer: 141_200,
    vendorName: must(VENDORS[6]),
    cost: 640,
    repairOrderId: null,
  });
  serviceRecords.push({
    id: `sr_${String(srSeq++).padStart(4, '0')}`,
    truckId: hero.id,
    unitNumber: HERO_UNIT,
    type: 'pm_service',
    typeLabel: 'PM service',
    description: 'PM-B service: oil, filters, chassis lube, brake stroke check',
    doneAt: isoDate(daysAgo(52)),
    odometer: 400_700,
    vendorName: must(VENDORS[0]),
    cost: 585,
    repairOrderId: null,
  });
  const serviceable = trucks.filter((t) => t.status !== 'sold');
  while (serviceRecords.length < 200) {
    const truck = rng.pick(serviceable);
    const type = rng.pick([
      'oil_change',
      'pm_service',
      'tire_rotation',
      'brake_inspection',
      'dot_inspection',
      'coolant',
      'dpf',
      'battery',
      'tire_replacement',
    ] as const);
    const days = rng.int(3, 540);
    serviceRecords.push({
      id: `sr_${String(srSeq++).padStart(4, '0')}`,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      type,
      typeLabel: MAINTENANCE_LABELS[type],
      description: serviceDescription(rng, type),
      doneAt: isoDate(daysAgo(days)),
      odometer: Math.max(5000, truck.odometer - days * rng.int(320, 460)),
      vendorName: rng.pick(VENDORS),
      cost: round2(rng.float(95, 1900)),
      repairOrderId: null,
    });
  }
  serviceRecords.sort((a, b) =>
    a.doneAt < b.doneAt ? 1 : a.doneAt > b.doneAt ? -1 : a.id.localeCompare(b.id),
  );

  // ----- fuel transactions ------------------------------------------------------------------
  const fuelTransactions: FuelTransaction[] = [];
  const fuelTrucks = trucks.filter((t) => t.currentDriverId !== null && t.status !== 'sold');
  const cardByTruck = new Map(fuelTrucks.map((t) => [t.id, rng.digits(4)]));
  const activeLoadsByTruck = new Map(
    loads
      .filter(
        (l) =>
          l.truckId &&
          l.status !== 'closed' &&
          l.status !== 'delivered' &&
          l.status !== 'cancelled',
      )
      .map((l) => [l.truckId, l.id]),
  );
  let ftSeq = 1;
  for (let i = 0; i < 399; i += 1) {
    const truck = rng.pick(fuelTrucks);
    const driver = must(driverById.get(must(truck.currentDriverId)));
    const daysBack = rng.float(0, 60);
    const at = NOW - daysBack * DAY;
    const station = rng.pick(FUEL_STATIONS);
    const gallons = round2(rng.float(60, 180));
    const price = round2(rng.float(3.4, 4.1));
    fuelTransactions.push({
      id: `ft_${String(ftSeq++).padStart(4, '0')}`,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      driverId: driver.id,
      driverName: driver.name,
      loadId: daysBack < 3 ? (activeLoadsByTruck.get(truck.id) ?? null) : null,
      at: iso(at),
      station: {
        brand: station.brand,
        name: station.name,
        city: station.city,
        state: station.state,
      },
      product: rng.chance(0.9) ? 'diesel' : 'def',
      gallons,
      pricePerGallon: price,
      amount: round2(gallons * price),
      odometer: Math.max(1000, truck.odometer - Math.round(daysBack * 400) + rng.int(-60, 60)),
      cardLast4: must(cardByTruck.get(truck.id)),
      anomalyFlags: [],
      status: 'verified',
    });
  }
  // Anomalies.
  const unit3091 = must(truckByUnit.get('3091'));
  const mismatch = must(fuelTransactions[5]);
  mismatch.truckId = unit3091.id;
  mismatch.unitNumber = '3091';
  mismatch.driverId = must(unit3091.currentDriverId);
  mismatch.driverName = must(unit3091.currentDriverName);
  mismatch.station = {
    brand: "Love's",
    name: "Love's Travel Stop #211",
    city: 'Amarillo',
    state: 'TX',
  };
  mismatch.at = iso(daysAgo(2, 22, 41));
  mismatch.anomalyFlags = ['location_mismatch'];
  mismatch.status = 'problem';
  const excess = must(fuelTransactions[11]);
  excess.gallons = 245;
  excess.amount = round2(245 * excess.pricePerGallon);
  excess.anomalyFlags = ['impossible_gallons'];
  excess.status = 'problem';
  const original = must(fuelTransactions[17]);
  original.anomalyFlags = ['duplicate'];
  original.status = 'warning';
  fuelTransactions.push({
    ...original,
    id: `ft_${String(ftSeq).padStart(4, '0')}`,
    at: iso(new Date(original.at).getTime() + 4 * MINUTE),
  });
  const offHours = must(fuelTransactions[23]);
  offHours.at = iso(atLocal(new Date(offHours.at).getTime(), 3, 12));
  offHours.anomalyFlags = ['off_hours'];
  offHours.status = 'warning';
  fuelTransactions.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));

  // ----- safety events ----------------------------------------------------------------------
  const safetyEvents: SafetyEvent[] = [];
  const safetyDrivers = drivers.filter((d) => d.currentTruckId !== null);
  const trending = must(driverById.get(TRENDING_DRIVER_ID));
  let seSeq = 1;
  const pushEvent = (driver: Driver, daysBack: number, kind: SafetyEventKind) => {
    const truck = must(truckById.get(must(driver.currentTruckId)));
    const severity: SafetySeverity =
      kind === 'seatbelt'
        ? 'high'
        : kind === 'speeding'
          ? rng.chance(0.3)
            ? 'high'
            : 'medium'
          : rng.chance(0.25)
            ? 'medium'
            : 'low';
    const city = rng.pick([...CITIES, ...ROAD_CITIES]);
    const limit = kind === 'speeding' ? rng.pick([55, 65, 70]) : null;
    const coached = daysBack > 7 && rng.chance(0.45);
    safetyEvents.push({
      id: `se_${String(seSeq++).padStart(4, '0')}`,
      driverId: driver.id,
      driverName: driver.name,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      at: iso(NOW - daysBack * DAY),
      kind,
      severity,
      location: { city: city.city, state: city.state },
      speedMph: limit !== null ? limit + rng.int(9, 18) : rng.int(35, 66),
      speedLimitMph: limit,
      coached,
      dismissed: false,
      status: coached ? 'completed' : severity === 'low' && daysBack > 14 ? 'closed' : 'open',
    });
  };
  for (let i = 0; i < 18; i += 1) {
    pushEvent(
      trending,
      i < 12 ? rng.float(0.1, 14) : rng.float(14, 30),
      rng.chance(0.6)
        ? 'speeding'
        : rng.pick(['hard_brake', 'following_distance', 'hard_acceleration'] as const),
    );
  }
  const kindsWeighted: SafetyEventKind[] = [
    'speeding',
    'speeding',
    'speeding',
    'speeding',
    'hard_brake',
    'hard_brake',
    'hard_brake',
    'hard_acceleration',
    'hard_acceleration',
    'following_distance',
    'seatbelt',
  ];
  while (safetyEvents.length < 150) {
    const driver = rng.pick(safetyDrivers.filter((d) => d.id !== TRENDING_DRIVER_ID));
    pushEvent(driver, rng.float(0.05, 30), rng.pick(kindsWeighted));
  }
  safetyEvents.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0));
  for (const driver of drivers)
    driver.safetyEvents30d = safetyEvents.filter((e) => e.driverId === driver.id).length;

  // ----- invoices ---------------------------------------------------------------------------
  const invoiceStatusSequence: InvoiceStatus[] = [
    ...Array<InvoiceStatus>(20).fill('paid'),
    ...Array<InvoiceStatus>(7).fill('overdue'),
    ...Array<InvoiceStatus>(2).fill('disputed'),
    ...Array<InvoiceStatus>(4).fill('partially_paid'),
    ...Array<InvoiceStatus>(14).fill('sent'),
    ...Array<InvoiceStatus>(7).fill('issued'),
    ...Array<InvoiceStatus>(6).fill('draft'),
  ];
  const invoiceable = loads
    .filter((l) => (l.status === 'delivered' || l.status === 'closed') && l.deliveredAt)
    .sort((a, b) => (must(a.deliveredAt) < must(b.deliveredAt) ? -1 : 1))
    .slice(-60);
  const invoices: Invoice[] = invoiceable.map((load, i) => {
    const status = must(invoiceStatusSequence[i]);
    const billToBroker = load.brokerId ? must(brokers.find((b) => b.id === load.brokerId)) : null;
    const billToCustomer = must(customers.find((c) => c.id === load.customerId));
    // Overdue invoices are always on 30-day terms so their due date is safely in the past.
    const terms =
      status === 'overdue'
        ? 30
        : (billToBroker?.paymentTermsDays ?? billToCustomer.paymentTermsDays);
    const delivered = new Date(must(load.deliveredAt)).getTime();
    const issued = status === 'draft' ? null : delivered + rng.int(1, 2) * DAY;
    const due =
      issued === null
        ? null
        : status === 'overdue'
          ? Math.min(issued + terms * DAY, NOW - rng.int(3, 20) * DAY)
          : issued + terms * DAY;
    const total = load.rate;
    const paid =
      status === 'paid'
        ? total
        : status === 'partially_paid'
          ? round2(total * rng.float(0.4, 0.7))
          : 0;
    const agingDays = due !== null && paid < total ? Math.max(0, Math.floor((NOW - due) / DAY)) : 0;
    const number = 10412 + i;
    const invoice: Invoice = {
      id: `inv_${number}`,
      invoiceNumber: `INV-2026-${number}`,
      loadId: load.id,
      loadNumber: load.loadNumber,
      billToType: billToBroker ? 'broker' : 'customer',
      billToId: billToBroker?.id ?? billToCustomer.id,
      billToName: billToBroker?.name ?? billToCustomer.name,
      issuedOn: issued === null ? null : isoDate(issued),
      dueOn: due === null ? null : isoDate(due),
      paymentTermsDays: terms,
      subtotal: total,
      total,
      paid,
      balance: round2(total - paid),
      status: status === 'sent' && agingDays > 0 ? 'overdue' : status,
      agingDays,
      agingBucket:
        agingDays === 0
          ? 'current'
          : agingDays <= 30
            ? '1-30'
            : agingDays <= 60
              ? '31-60'
              : agingDays <= 90
                ? '61-90'
                : '90+',
      paidOn:
        status === 'paid' && due !== null
          ? isoDate(Math.min(NOW - DAY, due - rng.int(0, 12) * DAY))
          : null,
      disputeReason:
        status === 'disputed'
          ? rng.pick([
              'Detention charge not approved by broker',
              'Short-paid: lumper receipt missing',
            ])
          : null,
    };
    load.invoiceId = invoice.id;
    if (invoice.balance > 0 && billToBroker)
      billToBroker.outstandingBalance = round2(billToBroker.outstandingBalance + invoice.balance);
    return invoice;
  });
  invoices.reverse();

  // ----- series & KPIs ----------------------------------------------------------------------
  const series = buildSeries(rng, trucks, maintenance, loads);
  const kpis = buildKpis(trucks, loads, series.dailyRevenueProfit);

  // ----- notifications, tasks, activity, insights -------------------------------------------
  const activeLoads = loads.filter((l) => isActiveStatus(l.status));
  const riskLoads = activeLoads.filter((l) => l.exception !== null);
  const heroLoad = must(loads[HERO_INDEX]);
  const overdueItems = maintenance.filter((m) => m.status === 'overdue');
  const expiringDrivers = drivers.filter(
    (d) => d.medicalCardStatus === 'expiring' || d.cdlStatus === 'expiring',
  );
  const notifications = buildNotifications(
    riskLoads,
    heroLoad,
    overdueItems,
    expiringDrivers,
    trending,
    unit3012,
    unit3120,
    invoices,
    fuelTransactions,
  );
  const tasks = buildTasks(
    riskLoads,
    overdueItems,
    expiringDrivers,
    trending,
    unit3012,
    hero,
    invoices,
  );
  const activity = buildActivity(rng, loads, invoices, repairOrders, drivers);
  const aiInsights = buildInsights(
    riskLoads,
    overdueItems,
    expiringDrivers,
    trending,
    safetyEvents,
    unit3012,
    hero,
    unit3120,
    unit3091,
    series,
    kpis,
    repairOrders,
    brokers,
    invoices,
  );
  kpis.criticalAlerts = {
    value: notifications.filter((n) => n.severity === 'critical').length,
    previous: 3,
    deltaPercent: 0,
  };
  kpis.criticalAlerts.deltaPercent = round2(((kpis.criticalAlerts.value - 3) / 3) * 100);

  // ----- safety & compliance ----------------------------------------------------------------
  // Six unassigned drivers are this quarter's hires, so the verification pipeline has real cases:
  // most recent first they land at consent, consent, screening, safety review, conditional and
  // approved (see RECENT_PLANS in compliance-data.ts). The four still being onboarded are not yet
  // dispatchable, so they read inactive.
  const recentHires: Array<{ daysAgo: number; status: DriverStatus }> = [
    { daysAgo: 9, status: 'inactive' },
    { daysAgo: 16, status: 'inactive' },
    { daysAgo: 24, status: 'inactive' },
    { daysAgo: 31, status: 'inactive' },
    { daysAgo: 38, status: 'available' },
    { daysAgo: 45, status: 'available' },
  ];
  const benchDrivers = drivers.filter((d) => d.currentTruckId === null && d.status === 'available');
  recentHires.forEach((hire, index) => {
    const driver = must(benchDrivers[index], 'recent hire');
    driver.hireDate = isoDate(NOW - hire.daysAgo * DAY);
    driver.status = hire.status;
  });

  const safety = buildSafety(rng, {
    trucks,
    trailers,
    drivers,
    loads,
    users: demoUsers,
    now: DEMO_NOW,
  });

  const accounting = buildAccounting(rng, {
    loads,
    invoices,
    drivers,
    trucks,
    users: demoUsers,
    repairOrders,
    fuelTransactions,
    now: DEMO_NOW,
  });

  return {
    company: demoCompany,
    users: demoUsers,
    memberships: demoMemberships,
    trucks,
    trailers,
    drivers,
    customers,
    brokers,
    facilities,
    loads,
    maintenance,
    repairOrders,
    serviceRecords,
    truckNotes: [],
    fuelTransactions,
    safetyEvents,
    invoices,
    notifications,
    tasks,
    activity,
    aiInsights,
    kpis,
    series,
    // The qualification file lives in PostgreSQL now (see the compliance module); this stream
    // only carries the demo-side fleet, safety and accounting writes that are not persisted yet.
    complianceAudit: [],
    inspections: safety.inspections,
    defects: safety.defects,
    violations: safety.violations,
    accidents: safety.accidents,
    claims: safety.claims,
    correctiveActions: safety.correctiveActions,
    vendors: accounting.vendors,
    invoiceLines: accounting.invoiceLines,
    payments: accounting.payments,
    bills: accounting.bills,
    expenses: accounting.expenses,
    settlements: accounting.settlements,
    deductionPlans: accounting.deductionPlans,
    payrollPeriods: accounting.payrollPeriods,
    payslips: accounting.payslips,
    journal: accounting.journal,
    ledgerPeriods: accounting.ledgerPeriods,
    // Escrow and terminations start empty: they are recorded by people, not generated.
    escrowEntries: [],
    terminations: [],
    unitExits: [],
    ptiRecords: buildPtiWeek({
      trucks,
      drivers,
      users: demoUsers,
      weekStart: mondayOf(DEMO_NOW.toISOString().slice(0, 10)),
    }),
    // Ratings are never generated: they are what a reviewer saw. Only the catalog has defaults.
    ptiComponents: defaultPtiComponents(),
    ptiRatings: [],
    downPeriods: [],
    ptiConditionConfig: { ...DEFAULT_PTI_CONDITION_CONFIG },
    // Seeded on first read from the catalog defaults; see work-order-types.ts.
    workOrderTypes: [],
    unitDocumentRules: {},
  };
}

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function contact(rng: Rng, company: string): { name: string; email: string; phone: string } {
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const domain = company
    .toLowerCase()
    .replace(/[^a-z]/g, '')
    .slice(0, 14);
  return {
    name: `${first} ${last}`,
    email: `${first.toLowerCase()}.${last.toLowerCase()}@${domain}.com`,
    phone: `+1${rng.pick(['312', '214', '404', '614', '816'])}555${rng.digits(4)}`,
  };
}

function odometerForYear(rng: Rng, year: number): number {
  const ranges: Record<number, [number, number]> = {
    2019: [480_000, 620_000],
    2020: [380_000, 520_000],
    2021: [300_000, 420_000],
    2022: [220_000, 320_000],
    2023: [150_000, 240_000],
    2024: [100_000, 160_000],
    2025: [80_000, 110_000],
  };
  const [min, max] = must(ranges[year]);
  return Math.round(rng.int(min, max) / 100) * 100;
}

function truckHealth(
  status: TruckStatus,
  hasOverdue: boolean,
  needsAttention: boolean,
): FleetHealth {
  if (status === 'out_of_service' || status === 'accident' || hasOverdue) return 'critical';
  if (status === 'in_shop' || status === 'maintenance' || needsAttention) return 'needs_attention';
  return 'healthy';
}

export function isActiveStatus(status: LoadStatus): boolean {
  return !['delivered', 'closed', 'cancelled', 'tonu'].includes(status);
}

function buildFinancials(rng: Rng, revenue: number, miles: number): LoadFinancials {
  if (miles === 0) {
    return {
      revenue,
      fuel: 0,
      driverPay: 0,
      tolls: 0,
      maintenanceAllocation: 0,
      other: 0,
      grossProfit: revenue,
      rpm: 0,
      costPerMile: 0,
      profitPerMile: 0,
    };
  }
  const fuel = round2(miles * rng.float(0.5, 0.62));
  const driverPay = round2(miles * rng.float(0.58, 0.68));
  const tolls = round2(miles * rng.float(0, 0.09));
  const maintenanceAllocation = round2(miles * 0.15);
  const other = round2(miles * rng.float(0.05, 0.09));
  const costs = round2(fuel + driverPay + tolls + maintenanceAllocation + other);
  const grossProfit = round2(revenue - costs);
  return {
    revenue,
    fuel,
    driverPay,
    tolls,
    maintenanceAllocation,
    other,
    grossProfit,
    rpm: round2(revenue / miles),
    costPerMile: round2(costs / miles),
    profitPerMile: round2(grossProfit / miles),
  };
}

const STATUS_ORDER: LoadStatus[] = [
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
  'delivered',
  'closed',
];

function buildTimeline(rng: Rng, load: Load, dispatcherName: string, isHero: boolean): void {
  const events: LoadEvent[] = [];
  const notes: LoadNote[] = [];
  const documents: LoadDocument[] = [];
  let seq = 1;
  const push = (
    at: number,
    kind: LoadEventKind,
    actorType: LoadEvent['actorType'],
    actorName: string,
    title: string,
    detail: string | null = null,
    stopId: string | null = null,
  ) => {
    events.push({
      id: `evt_${load.loadNumber.slice(2)}_${seq++}`,
      at: iso(at),
      kind,
      actorType,
      actorName,
      title,
      detail,
      stopId,
    });
  };
  const doc = (
    type: LoadDocument['type'],
    at: number,
    by: string,
    status: LoadDocument['status'] = 'verified',
  ) => {
    const titles: Record<LoadDocument['type'], string> = {
      rate_confirmation: 'Rate confirmation',
      bol: 'Bill of lading',
      pod: 'Proof of delivery',
      invoice: 'Invoice',
      lumper_receipt: 'Lumper receipt',
      detention: 'Detention paperwork',
      tonu: 'TONU paperwork',
      layover: 'Layover paperwork',
      other: 'Other paperwork',
    };
    documents.push({
      id: `doc_${load.loadNumber.slice(2)}_${documents.length + 1}`,
      type,
      title: titles[type],
      fileName: `${load.loadNumber}-${type}.pdf`,
      sizeBytes: rng.int(80_000, 640_000),
      uploadedAt: iso(at),
      uploadedBy: by,
      status,
    });
  };

  const rank = STATUS_ORDER.indexOf(load.status);
  const terminal = load.status === 'cancelled' || load.status === 'tonu';
  const bookedAt = new Date(load.bookedAt).getTime();
  const pickup = must(load.stops[0]);
  const delivery = must(load.stops[load.stops.length - 1]);
  const pickupStart = new Date(pickup.appointmentStartAt).getTime();
  const deliveryStart = new Date(delivery.appointmentStartAt).getTime();
  const driver = load.driverName ?? 'Unassigned';

  push(
    bookedAt,
    'booked',
    'user',
    dispatcherName,
    'Load booked',
    load.brokerName
      ? `Rate confirmation received from ${load.brokerName}`
      : `Direct customer load for ${load.customerName}`,
  );
  doc('rate_confirmation', bookedAt + 6 * MINUTE, dispatcherName);
  push(
    bookedAt + 6 * MINUTE,
    'document_uploaded',
    'user',
    dispatcherName,
    'Rate confirmation uploaded',
  );

  if (terminal) {
    push(
      bookedAt + rng.int(3, 30) * HOUR,
      'cancelled',
      'user',
      dispatcherName,
      load.status === 'tonu' ? 'Truck ordered, not used' : 'Load cancelled',
      load.status === 'tonu'
        ? 'Driver arrived; shipper had no freight ready. TONU billed.'
        : 'Broker cancelled; freight moved to a different carrier',
    );
    notes.push(
      note(
        load,
        1,
        'internal',
        dispatcherName,
        load.status === 'tonu'
          ? 'Shipper confirmed freight never staged. Billing $250 TONU per rate con.'
          : 'Broker called 9:40 AM to cancel. No detention or TONU applicable.',
        bookedAt + 4 * HOUR,
      ),
    );
    finish(load, events, notes, documents, bookedAt + 4 * HOUR);
    return;
  }

  const assignedAt = isHero ? daysAgo(3, 14, 5) : bookedAt + rng.int(1, 6) * HOUR;
  if (rank >= 1 && load.driverName) {
    push(
      assignedAt,
      'assigned',
      'user',
      dispatcherName,
      `Assigned to ${load.driverName}`,
      `Unit ${load.truckUnit ?? '—'}${load.trailerUnit ? ` / trailer ${load.trailerUnit}` : ''}`,
    );
  }
  const dispatchedAt = isHero ? daysAgo(2, 17, 30) : pickupStart - rng.int(8, 20) * HOUR;
  if (rank >= 2) {
    push(
      dispatchedAt,
      'dispatched',
      'user',
      dispatcherName,
      'Dispatched',
      `Driver notified; pickup appointment ${new Date(pickupStart).toISOString()}`,
    );
    load.dispatchedAt = iso(dispatchedAt);
  }
  const pickupArrive = isHero
    ? daysAgo(1, 7, 52)
    : pickupStart +
      rng.int(-30, 25) * MINUTE +
      (load.exception?.code === 'at_risk' && load.status === 'at_pickup' ? 45 * MINUTE : 0);
  if (rank >= 3) {
    push(
      pickupArrive,
      'arrived',
      'system',
      'Tracking',
      `Arrived at ${pickup.facilityName}`,
      'Geofence entry',
      pickup.id,
    );
    pickup.arrivedAt = iso(pickupArrive);
    pickup.status = rank === 3 ? 'in_progress' : 'completed';
  }
  if (rank >= 4) {
    push(
      pickupArrive + 18 * MINUTE,
      'loading_started',
      'driver',
      driver,
      'Loading started',
      null,
      pickup.id,
    );
    pickup.status = rank === 4 ? 'in_progress' : 'completed';
  }
  const detention = load.exception?.code === 'delayed' && load.status === 'in_transit' ? 185 : 0;
  const loadedAt = isHero
    ? daysAgo(1, 10, 20)
    : pickupArrive + rng.int(75, 170) * MINUTE + detention * MINUTE;
  if (rank >= 5) {
    push(
      loadedAt,
      'loaded',
      'driver',
      driver,
      'Loaded',
      `${load.pieces} pieces, ${load.weightLbs.toLocaleString('en-US')} lbs`,
      pickup.id,
    );
    doc('bol', loadedAt + 3 * MINUTE, driver);
    push(
      loadedAt + 3 * MINUTE,
      'document_uploaded',
      'driver',
      driver,
      'BOL uploaded',
      null,
      pickup.id,
    );
    pickup.detentionMinutes = Math.max(0, Math.round((loadedAt - pickupArrive) / MINUTE) - 120);
    pickup.status = 'completed';
  }
  const departedAt = isHero ? daysAgo(1, 10, 35) : loadedAt + rng.int(8, 20) * MINUTE;
  if (rank >= 6) {
    push(
      departedAt,
      'departed',
      'system',
      'Tracking',
      `Departed ${pickup.city}, ${pickup.state}`,
      'Geofence exit',
      pickup.id,
    );
    pickup.departedAt = iso(departedAt);
    for (const stop of load.stops.slice(1)) stop.status = 'in_transit';
  }
  if (isHero) {
    push(
      daysAgo(1, 21, 40),
      'eta_changed',
      'system',
      'Tracking',
      'ETA moved +35 min',
      'Construction on I-44 near Springfield, MO; new ETA Sep 6, 3:45 PM CT',
    );
    push(
      daysAgo(0, 13, 5),
      'eta_changed',
      'system',
      'Tracking',
      'ETA 3:45 PM CT',
      '22 miles remaining; on pace for the 4:00–6:00 PM window',
    );
    load.etaAt = iso(daysAgo(0, 15, 45));
    load.milesRemaining = 22;
  } else if (rank === 6) {
    const etaAt =
      load.exception?.code === 'at_risk'
        ? deliveryStart + 80 * MINUTE
        : deliveryStart - rng.int(5, 40) * MINUTE;
    push(
      NOW - rng.int(20, 130) * MINUTE,
      'eta_changed',
      'system',
      'Tracking',
      load.exception ? 'ETA slipped past appointment window' : 'ETA updated',
      load.exception?.reason ?? 'Traffic normal; on schedule',
    );
    load.etaAt = iso(etaAt);
    load.milesRemaining = Math.round(load.loadedMiles * rng.float(0.2, 0.6));
  }
  if (load.exception) {
    push(
      new Date(load.exception.raisedAt).getTime(),
      'exception_raised',
      'ai',
      'Late-risk detector',
      `${label(load.exception.code)}: ${load.exception.reason}`,
    );
  }
  const deliveryArrive = isHero
    ? deliveryStart
    : deliveryStart +
      rng.int(-40, 30) * MINUTE +
      (load.exception?.code === 'delayed' && load.status === 'at_delivery' ? 0 : 0);
  if (rank >= 7 && !isHero) {
    push(
      deliveryArrive,
      'arrived',
      'system',
      'Tracking',
      `Arrived at ${delivery.facilityName}`,
      'Geofence entry',
      delivery.id,
    );
    delivery.arrivedAt = iso(deliveryArrive);
    delivery.status = 'in_progress';
  }
  if (rank >= 8 && !isHero) {
    push(
      deliveryArrive + 25 * MINUTE,
      'loading_started',
      'driver',
      driver,
      'Unloading started',
      null,
      delivery.id,
    );
  }
  const deliveredAt = deliveryArrive + rng.int(60, 150) * MINUTE;
  if (rank >= 9) {
    push(
      deliveredAt,
      'delivered',
      'driver',
      driver,
      'Delivered',
      'Signed clean; no exceptions noted',
      delivery.id,
    );
    doc('pod', deliveredAt + 4 * MINUTE, driver);
    push(
      deliveredAt + 4 * MINUTE,
      'document_uploaded',
      'driver',
      driver,
      'POD uploaded',
      null,
      delivery.id,
    );
    delivery.departedAt = iso(deliveredAt + rng.int(5, 20) * MINUTE);
    delivery.status = 'completed';
    for (const stop of load.stops.slice(1, -1)) {
      stop.status = 'completed';
      stop.arrivedAt = iso(new Date(stop.appointmentStartAt).getTime());
      stop.departedAt = iso(new Date(stop.appointmentStartAt).getTime() + 90 * MINUTE);
    }
    load.deliveredAt = iso(deliveredAt);
  } else if (isHero) {
    documents.push({
      id: `doc_${load.loadNumber.slice(2)}_${documents.length + 1}`,
      type: 'pod',
      title: 'Proof of delivery',
      fileName: `${load.loadNumber}-pod.pdf`,
      sizeBytes: 0,
      uploadedAt: iso(NOW),
      uploadedBy: '—',
      status: 'missing',
    });
  }
  if (rank >= 10) {
    const closedAt = deliveredAt + rng.int(1, 3) * DAY;
    push(
      closedAt,
      'closed',
      'user',
      'Grace Kim',
      'Closed and invoiced',
      'All charges billed; load locked',
    );
    doc('invoice', closedAt, 'Grace Kim');
  }

  // Notes.
  if (isHero) {
    notes.push(
      note(
        load,
        1,
        'broker',
        dispatcherName,
        'Broker requires check calls at 8 AM and 4 PM CT; tarps required, steel coils on cradles.',
        assignedAt + 30 * MINUTE,
        true,
      ),
    );
    notes.push(
      note(
        load,
        2,
        'driver',
        driver,
        'Loaded 12 coils, tarped and chained. Pulling out 10:35.',
        loadedAt + 2 * MINUTE,
      ),
    );
    notes.push(
      note(
        load,
        3,
        'internal',
        dispatcherName,
        'Receiver confirmed dock 14 for 4–6 PM. Lumper not required.',
        daysAgo(0, 9, 15),
      ),
    );
  } else {
    const count = rng.int(1, 3);
    const bodies = [
      'Broker requests hourly check calls after 3 PM.',
      'Shipper hours 6 AM–2 PM; no FCFS after 1 PM.',
      'Driver reports lumper $150; receipt uploaded.',
      'Receiver requires appointment confirmation 24h ahead.',
      'Trailer must be pre-cooled to 36°F before arrival.',
      'Detention starts after 2 hours per rate confirmation.',
      'Driver confirmed he has 9h drive time for tomorrow.',
    ];
    for (let n = 1; n <= count; n += 1) {
      notes.push(
        note(
          load,
          n,
          rng.pick(['internal', 'broker', 'driver'] as const),
          n === 1 ? dispatcherName : rng.chance(0.5) ? driver : dispatcherName,
          rng.pick(bodies),
          bookedAt + n * rng.int(2, 20) * HOUR,
          n === 1 && rng.chance(0.2),
        ),
      );
    }
  }
  finish(
    load,
    events,
    notes,
    documents,
    must(events[events.length - 1])
      ? new Date(must(events[events.length - 1]).at).getTime()
      : bookedAt,
  );
}

function note(
  load: Load,
  n: number,
  kind: LoadNote['kind'],
  author: string,
  body: string,
  at: number,
  pinned = false,
): LoadNote {
  return {
    id: `note_${load.loadNumber.slice(2)}_${n}`,
    kind,
    body,
    authorName: author,
    at: iso(at),
    pinned,
  };
}

function finish(
  load: Load,
  events: LoadEvent[],
  notes: LoadNote[],
  documents: LoadDocument[],
  updatedAt: number,
): void {
  events.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
  load.timeline = events;
  load.notes = notes;
  load.documents = documents;
  load.updatedAt = iso(Math.min(NOW, updatedAt));
}

function roSummary(rng: Rng, type: MaintenanceType): string {
  const options: Partial<Record<MaintenanceType, string[]>> = {
    brake_repair: [
      'Rear brake shoes and drums',
      'Brake chamber leak; replace chamber',
      'Slack adjuster replacement',
    ],
    electrical: [
      'Intermittent ABS fault; wiring repair',
      'Alternator replacement',
      'Marker light circuit repair',
    ],
    tire_replacement: [
      'Replace two drive tires; alignment',
      'Steer tire replacement',
      'Trailer tire blowout; roadside replacement',
    ],
    engine: [
      'Coolant leak at water pump',
      'Turbo actuator fault',
      'Aftertreatment sensor replacement',
    ],
    coolant: ['Radiator replacement', 'Coolant flush and thermostat'],
    battery: ['Replace battery bank (4)', 'Battery cable corrosion repair'],
    dpf: ['DPF cleaning and DOC inspection', 'Forced regen; replace NOx sensor'],
    other: ['A/C compressor replacement', 'Windshield replacement', 'Fifth wheel rebuild'],
  };
  return rng.pick(options[type] ?? ['General repair']);
}

function serviceDescription(rng: Rng, type: MaintenanceType): string {
  const options: Partial<Record<MaintenanceType, string[]>> = {
    oil_change: ['Engine oil and filter change', 'Oil change, fuel filters, chassis lube'],
    pm_service: ['PM-A service', 'PM-B service: oil, filters, chassis lube, brake stroke check'],
    tire_rotation: ['Tire rotation and pressure check'],
    brake_inspection: ['Brake inspection; measured lining and drums'],
    dot_inspection: ['Annual DOT inspection – passed'],
    coolant: ['Coolant test and top-off'],
    dpf: ['DPF cleaning'],
    battery: ['Battery load test and terminal service'],
    tire_replacement: ['Replace two drive tires'],
  };
  return rng.pick(options[type] ?? ['Service']);
}

function buildSeries(
  rng: Rng,
  trucks: Truck[],
  maintenance: MaintenanceItem[],
  loads: Load[],
): DashboardSeries {
  // Daily revenue & profit, last 90 days ending today.
  const daily: RevenueProfitPoint[] = [];
  // Every month, so the generator keeps working whatever "today" is (it broke on 1 October).
  const monthlyBase: Record<number, number> = {
    1: 24_800, 2: 25_000, 3: 25_400, 4: 25_600, 5: 25_800, 6: 26_000,
    7: 26_800, 8: 28_400, 9: 29_200, 10: 29_000, 11: 28_200, 12: 26_400,
  };
  for (let d = 89; d >= 0; d -= 1) {
    const ms = NOW - d * DAY;
    const local = new Date(ms - CHICAGO_OFFSET);
    const month = local.getUTCMonth() + 1;
    const dow = local.getUTCDay();
    const weekday = dow === 0 ? 0.35 : dow === 6 ? 0.55 : 1;
    const revenue = round2(must(monthlyBase[month]) * weekday * rng.float(0.93, 1.07));
    const profit = round2(revenue * rng.float(0.24, 0.3));
    daily.push({ date: isoDate(ms), revenue, profit });
  }
  // Normalise August to be exactly +6.4% over July.
  const sum = (points: RevenueProfitPoint[], key: 'revenue' | 'profit') =>
    points.reduce((acc, p) => acc + p[key], 0);
  const july = daily.filter((p) => p.date.startsWith('2026-07'));
  const august = daily.filter((p) => p.date.startsWith('2026-08'));
  const scale = (sum(july, 'revenue') * 1.064) / sum(august, 'revenue');
  for (const p of august) {
    p.revenue = round2(p.revenue * scale);
    p.profit = round2(p.profit * scale);
  }

  // Weekly fuel cost, 13 weeks; last 4 weeks exactly +8.2% over the prior 4.
  const weekly: TimeSeriesPoint[] = [];
  for (let w = 12; w >= 0; w -= 1) {
    weekly.push({
      date: isoDate(NOW - w * 7 * DAY),
      value: round2(46_000 * rng.float(0.92, 1.08)),
    });
  }
  const prior = weekly.slice(5, 9);
  const recent = weekly.slice(9, 13);
  const fuelScale =
    (prior.reduce((a, p) => a + p.value, 0) * 1.082) / recent.reduce((a, p) => a + p.value, 0);
  for (const p of recent) p.value = round2(p.value * fuelScale);

  const fleetHealth: StatusCount[] = (['healthy', 'needs_attention', 'critical'] as const).map(
    (code) => ({
      status: code,
      label: label(code),
      count: trucks.filter((t) => t.status !== 'sold' && t.health === code).length,
    }),
  );

  const recentLoads = loads.filter(
    (l) => isActiveStatus(l.status) || new Date(l.pickupAt).getTime() > NOW - 30 * DAY,
  );
  const loadStatus: StatusCount[] = STATUS_ORDER.concat(['cancelled', 'tonu'])
    .map((code) => ({
      status: code,
      label: label(code),
      count: recentLoads.filter((l) => l.status === code).length,
    }))
    .filter((s) => s.count > 0);

  void maintenance;
  return { dailyRevenueProfit: daily, weeklyFuelCost: weekly, fleetHealth, loadStatus };
}

function kpi(value: number, previous: number): KpiValue {
  return {
    value,
    previous,
    deltaPercent: previous === 0 ? 0 : round2(((value - previous) / previous) * 100),
  };
}

function buildKpis(trucks: Truck[], loads: Load[], daily: RevenueProfitPoint[]): KpiSnapshot {
  const mtd = daily.filter((p) => p.date >= '2026-09-01');
  const previousPeriod = daily.filter((p) => p.date >= '2026-08-01' && p.date <= '2026-08-06');
  const sum = (points: RevenueProfitPoint[], key: 'revenue' | 'profit') =>
    round2(points.reduce((acc, p) => acc + p[key], 0));
  const activeTrucks = trucks.filter((t) => t.status === 'active' || t.status === 'driving').length;
  return {
    asOf: DEMO_NOW_ISO,
    totalTrucks: kpi(trucks.length, 59),
    activeTrucks: kpi(activeTrucks, activeTrucks - 2),
    activeLoads: kpi(loads.filter((l) => isActiveStatus(l.status)).length, 13),
    revenueMtd: kpi(sum(mtd, 'revenue'), sum(previousPeriod, 'revenue')),
    profitMtd: kpi(sum(mtd, 'profit'), sum(previousPeriod, 'profit')),
    criticalAlerts: kpi(0, 3),
  };
}

function buildNotifications(
  riskLoads: Load[],
  heroLoad: Load,
  overdueItems: MaintenanceItem[],
  expiringDrivers: Driver[],
  trending: Driver,
  unit3012: Truck,
  unit3120: Truck,
  invoices: Invoice[],
  fuel: FuelTransaction[],
): Notification[] {
  const overdueInvoices = invoices.filter((i) => i.status === 'overdue');
  const mismatch = fuel.find((f) => f.anomalyFlags.includes('location_mismatch'));
  const items: Array<
    Omit<Notification, 'id' | 'at' | 'readAt' | 'actionRequired'> & {
      minutesAgo: number;
      read?: boolean;
      /** Omitted means informational: most events are read, not worked. */
      action?: boolean;
    }
  > = [];
  riskLoads.forEach((load) => {
    items.push({
      kind: 'dispatch',
      severity: load.exception?.code === 'at_risk' ? 'critical' : 'warning',
      title: `${load.loadNumber} ${load.exception?.code === 'at_risk' ? 'at risk of missing appointment' : 'delayed'}`,
      body: load.exception?.reason ?? '',
      department: 'dispatch',
      entity: ref('load', load.id, load.loadNumber),
      source: 'ai',
      action: true,
      minutesAgo: 25 + riskLoads.indexOf(load) * 17,
    });
  });
  const firstOverdue = overdueItems[0];
  const secondOverdue = overdueItems[1];
  if (firstOverdue)
    items.push({
      kind: 'maintenance',
      severity: 'critical',
      title: `Unit 3091 PM service overdue`,
      body: `PM service is 1,800 mi past due. Unit is on an active load; schedule at next terminal visit.`,
      department: 'maintenance',
      entity: ref('truck', 'trk_3091', 'Unit 3091'),
      source: 'system',
      action: true,
      minutesAgo: 95,
    });
  if (secondOverdue)
    items.push({
      kind: 'maintenance',
      severity: 'critical',
      title: `Unit ${secondOverdue.unitNumber} ${secondOverdue.typeLabel.toLowerCase()} overdue`,
      body: `${Math.abs(secondOverdue.milesUntilDue).toLocaleString('en-US')} mi past due.`,
      department: 'maintenance',
      entity: ref('truck', secondOverdue.truckId, `Unit ${secondOverdue.unitNumber}`),
      source: 'system',
      action: true,
      minutesAgo: 140,
    });
  items.push({
    kind: 'maintenance',
    severity: 'warning',
    title: 'Unit 2785 brake inspection due in 2,500 mi',
    body: 'Third brake repair in 6 months. Recommend inspection at Dallas delivery.',
    department: 'maintenance',
    entity: ref('truck', 'trk_2785', 'Unit 2785'),
    source: 'ai',
    action: true,
    minutesAgo: 160,
  });
  items.push({
    kind: 'fleet',
    severity: 'warning',
    title: 'Unit 3012 fuel economy down 14%',
    body: 'MPG 5.93 vs 6.90 baseline over 30 days; idle up to 21%. Engine service history flagged.',
    department: 'maintenance',
    entity: ref('truck', unit3012.id, 'Unit 3012'),
    source: 'ai',
    action: true,
    minutesAgo: 210,
  });
  items.push({
    kind: 'maintenance',
    severity: 'info',
    title: 'Unit 3120 parts ETA Sep 8',
    body: 'Clutch actuator on order from OEM; unit remains in shop at Lone Star Fleet Service.',
    department: 'maintenance',
    entity: ref('truck', unit3120.id, 'Unit 3120'),
    source: 'user',
    minutesAgo: 380,
    read: true,
  });
  expiringDrivers.forEach((driver, i) => {
    const medical = driver.medicalCardStatus === 'expiring';
    items.push({
      kind: 'document',
      severity: 'warning',
      title: `${driver.name}: ${medical ? 'medical card' : 'CDL'} expires ${medical ? driver.medicalCardExpiresOn : driver.cdlExpiresOn}`,
      body: `${medical ? 'Medical card' : 'CDL'} expires within 30 days. Driver will be placed on hold at expiry.`,
      department: 'safety',
      entity: ref('driver', driver.id, driver.name),
      source: 'workflow',
      action: true,
      minutesAgo: 420 + i * 30,
      read: i > 1,
    });
  });
  items.push({
    kind: 'driver',
    severity: 'critical',
    title: `${trending.name}: 12 safety events in 14 days`,
    body: 'Speeding events trending up vs fleet average of 2. Coaching session recommended.',
    department: 'safety',
    entity: ref('driver', trending.id, trending.name),
    source: 'ai',
    action: true,
    minutesAgo: 75,
  });
  if (mismatch)
    items.push({
      kind: 'finance',
      severity: 'warning',
      title: 'Fuel purchase 300+ mi from Unit 3091',
      body: `Card ending ${mismatch.cardLast4} used in Amarillo, TX while the unit was in Columbus, OH.`,
      department: 'accounting',
      entity: ref('fuel_transaction', mismatch.id, `Fuel ${mismatch.id}`),
      source: 'ai',
      action: true,
      minutesAgo: 610,
    });
  overdueInvoices.slice(0, 2).forEach((inv, i) => {
    items.push({
      kind: 'finance',
      severity: 'warning',
      title: `${inv.invoiceNumber} is ${inv.agingDays} days past due`,
      body: `${inv.billToName} · balance $${inv.balance.toLocaleString('en-US', { minimumFractionDigits: 2 })}`,
      department: 'accounting',
      entity: ref('invoice', inv.id, inv.invoiceNumber),
      source: 'system',
      action: true,
      minutesAgo: 700 + i * 45,
      read: i === 1,
    });
  });
  items.push({
    kind: 'finance',
    severity: 'success',
    title: 'Payment received: Prime Logistics Group',
    body: 'ACH $18,420.00 applied to 6 invoices.',
    department: 'accounting',
    entity: ref('broker', 'brk_01', 'Prime Logistics Group'),
    source: 'system',
    minutesAgo: 820,
    read: true,
  });
  items.push({
    kind: 'load',
    severity: 'success',
    title: `${heroLoad.loadNumber} loaded and departed Chicago`,
    body: 'BOL uploaded by driver; ETA Dallas 3:45 PM CT.',
    department: 'dispatch',
    entity: ref('load', heroLoad.id, heroLoad.loadNumber),
    source: 'system',
    minutesAgo: 1675,
    read: true,
  });
  items.push({
    kind: 'comment',
    severity: 'info',
    title: 'Weekly safety meeting Monday 7:00 AM',
    body: 'Topic: following distance in construction zones. Attendance required for all drivers in the yard.',
    department: 'safety',
    entity: null,
    source: 'user',
    minutesAgo: 1400,
    read: true,
  });
  items.push({
    kind: 'comment',
    severity: 'info',
    title: 'New applicant: CDL-A, 6 yrs OTR',
    body: 'Applicant moved to screening by Monica Alvarez.',
    department: 'hr',
    entity: null,
    source: 'user',
    minutesAgo: 1560,
    read: true,
  });
  items.push({
    kind: 'report',
    severity: 'success',
    title: 'Revenue +6.4% vs July',
    body: 'August closed at +6.4% revenue with margin held at 27%.',
    department: 'management',
    entity: ref('company', 'co_northwind', 'Northwind Freight'),
    source: 'ai',
    minutesAgo: 2900,
    read: true,
  });
  items.push({
    kind: 'report',
    severity: 'warning',
    title: 'Fuel spend +8.2% over prior 4 weeks',
    body: 'Driven by price (+$0.11/gal) and idle time on 6 units.',
    department: 'management',
    entity: ref('company', 'co_northwind', 'Northwind Freight'),
    source: 'ai',
    minutesAgo: 2950,
  });
  items.push({
    kind: 'system',
    severity: 'info',
    title: 'Samsara sync completed',
    body: '58 units updated; 2 units reported no GPS in the last 6 hours.',
    department: 'fleet',
    entity: null,
    source: 'system',
    minutesAgo: 35,
    read: true,
  });
  items.push({
    kind: 'maintenance',
    severity: 'warning',
    title: 'Trailer T-5301 annual inspection due in 9 days',
    body: 'Schedule at Naperville shop before next dispatch.',
    department: 'maintenance',
    entity: ref('trailer', 'trl_5301', 'T-5301'),
    source: 'workflow',
    action: true,
    minutesAgo: 1900,
  });
  items.push({
    kind: 'finance',
    severity: 'info',
    title: 'Settlement batch ready for review',
    body: '48 driver settlements for the week ending Sep 5 await approval.',
    department: 'accounting',
    entity: null,
    source: 'workflow',
    action: true,
    minutesAgo: 240,
  });
  items.push({
    kind: 'document',
    severity: 'success',
    title: 'DOT audit documents accepted',
    body: 'FMCSA acknowledged the driver qualification file submission.',
    department: 'safety',
    entity: null,
    source: 'user',
    minutesAgo: 4100,
    read: true,
  });
  items.push({
    kind: 'comment',
    severity: 'info',
    title: 'Broker Meridian Freight Exchange updated terms to Net 45',
    body: 'Applies to loads booked after Sep 1.',
    department: 'accounting',
    entity: ref('broker', 'brk_08', 'Meridian Freight Exchange'),
    source: 'user',
    minutesAgo: 3300,
    read: true,
  });
  return items.slice(0, 25).map((item, i) => ({
    id: `ntf_${String(i + 1).padStart(2, '0')}`,
    kind: item.kind,
    severity: item.severity,
    title: item.title,
    body: item.body,
    department: item.department,
    entity: item.entity,
    source: item.source,
    actionRequired: item.action ?? false,
    at: iso(NOW - item.minutesAgo * MINUTE),
    readAt: item.read ? iso(NOW - (item.minutesAgo - 5) * MINUTE) : null,
  }));
}

function buildTasks(
  riskLoads: Load[],
  overdueItems: MaintenanceItem[],
  expiringDrivers: Driver[],
  trending: Driver,
  unit3012: Truck,
  hero: Truck,
  invoices: Invoice[],
): Task[] {
  const staff = (id: string) => must(demoUsers.find((u) => u.id === id));
  const disputed = invoices.filter((i) => i.status === 'disputed');
  const defs: Array<{
    title: string;
    description: string;
    assignee: string;
    department: Department;
    entity: EntityRef | null;
    priority: Task['priority'];
    status: Task['status'];
    dueHours: number;
    source: Task['source'];
  }> = [];
  riskLoads.slice(0, 2).forEach((load) =>
    defs.push({
      title: `Call receiver about ${load.loadNumber}`,
      description: load.exception?.reason ?? '',
      assignee: load.dispatcherId,
      department: 'dispatch',
      entity: ref('load', load.id, load.loadNumber),
      priority: 'urgent',
      status: 'open',
      dueHours: 2,
      source: 'ai',
    }),
  );
  defs.push({
    title: 'Schedule brake inspection for unit 2785',
    description:
      'Third brake repair in 6 months; inspect at Lone Star Fleet Service after Dallas delivery.',
    assignee: 'usr_007',
    department: 'maintenance',
    entity: ref('truck', hero.id, 'Unit 2785'),
    priority: 'high',
    status: 'in_progress',
    dueHours: 30,
    source: 'ai',
  });
  defs.push({
    title: 'Diagnose MPG drop on unit 3012',
    description: 'Pull fault codes and idle report; compare with injector replacement on Aug 22.',
    assignee: 'usr_007',
    department: 'maintenance',
    entity: ref('truck', unit3012.id, 'Unit 3012'),
    priority: 'high',
    status: 'open',
    dueHours: 48,
    source: 'ai',
  });
  overdueItems.slice(0, 2).forEach((item, i) =>
    defs.push({
      title: `Book overdue ${item.typeLabel.toLowerCase()} for unit ${item.unitNumber}`,
      description: `${Math.abs(item.milesUntilDue).toLocaleString('en-US')} mi past due.`,
      assignee: 'usr_011',
      department: 'fleet',
      entity: ref('truck', item.truckId, `Unit ${item.unitNumber}`),
      priority: 'high',
      status: i === 0 ? 'in_progress' : 'open',
      dueHours: 24 + i * 24,
      source: 'workflow',
    }),
  );
  defs.push({
    title: `Coaching session with ${trending.name}`,
    description: '12 safety events in 14 days; review speeding clips and sign coaching form.',
    assignee: 'usr_006',
    department: 'safety',
    entity: ref('driver', trending.id, trending.name),
    priority: 'urgent',
    status: 'open',
    dueHours: 20,
    source: 'ai',
  });
  expiringDrivers.slice(0, 3).forEach((driver, i) =>
    defs.push({
      title: `Collect renewed ${driver.medicalCardStatus === 'expiring' ? 'medical card' : 'CDL'} from ${driver.name}`,
      description: `Expires ${driver.medicalCardStatus === 'expiring' ? driver.medicalCardExpiresOn : driver.cdlExpiresOn}.`,
      assignee: 'usr_006',
      department: 'safety',
      entity: ref('driver', driver.id, driver.name),
      priority: 'normal',
      status: i === 2 ? 'completed' : 'open',
      dueHours: 72 + i * 48,
      source: 'workflow',
    }),
  );
  disputed.forEach((inv) =>
    defs.push({
      title: `Resolve dispute on ${inv.invoiceNumber}`,
      description: inv.disputeReason ?? '',
      assignee: 'usr_009',
      department: 'accounting',
      entity: ref('invoice', inv.id, inv.invoiceNumber),
      priority: 'normal',
      status: 'in_progress',
      dueHours: 96,
      source: 'user',
    }),
  );
  defs.push({
    title: 'Approve weekly settlements',
    description: '48 settlements for week ending Sep 5.',
    assignee: 'usr_008',
    department: 'accounting',
    entity: null,
    priority: 'high',
    status: 'open',
    dueHours: 26,
    source: 'workflow',
  });
  defs.push({
    title: 'Review fuel anomaly on unit 3091',
    description: 'Card used 300+ mi from unit position. Confirm with driver.',
    assignee: 'usr_009',
    department: 'accounting',
    entity: ref('truck', 'trk_3091', 'Unit 3091'),
    priority: 'normal',
    status: 'open',
    dueHours: 40,
    source: 'ai',
  });
  defs.push({
    title: 'Send onboarding packet to new hire',
    description: 'CDL-A applicant accepted offer; start date Sep 14.',
    assignee: 'usr_010',
    department: 'hr',
    entity: null,
    priority: 'normal',
    status: 'in_progress',
    dueHours: 60,
    source: 'user',
  });
  defs.push({
    title: 'Renew IL IRP registration for 6 units',
    description: 'Registrations expire Sep 30.',
    assignee: 'usr_011',
    department: 'fleet',
    entity: null,
    priority: 'normal',
    status: 'open',
    dueHours: 200,
    source: 'workflow',
  });
  defs.push({
    title: 'Update rate agreement with Blue Ridge Freight Brokers',
    description: 'Fuel surcharge table changed Sep 1.',
    assignee: 'usr_002',
    department: 'dispatch',
    entity: ref('broker', 'brk_02', 'Blue Ridge Freight Brokers'),
    priority: 'low',
    status: 'completed',
    dueHours: -20,
    source: 'user',
  });
  defs.push({
    title: 'Quarterly IFTA filing',
    description: 'Q3 miles and gallons by state; due Oct 31.',
    assignee: 'usr_008',
    department: 'accounting',
    entity: null,
    priority: 'low',
    status: 'open',
    dueHours: 900,
    source: 'workflow',
  });
  defs.push({
    title: 'Cancelled: replace trailer T-5340 mudflaps',
    description: 'Trailer sold before repair.',
    assignee: 'usr_007',
    department: 'maintenance',
    entity: null,
    priority: 'low',
    status: 'cancelled',
    dueHours: -50,
    source: 'user',
  });
  return defs.slice(0, 18).map((d, i) => ({
    id: `tsk_${String(i + 1).padStart(2, '0')}`,
    title: d.title,
    description: d.description,
    assigneeId: d.assignee,
    assigneeName: staff(d.assignee).name,
    department: d.department,
    entity: d.entity,
    priority: d.priority,
    status: d.status,
    dueAt: iso(NOW + d.dueHours * HOUR),
    completedAt: d.status === 'completed' ? iso(NOW - 3 * HOUR) : null,
    source: d.source,
    createdAt: iso(NOW - (i * 3 + 4) * HOUR),
  }));
}

function buildActivity(
  rng: Rng,
  loads: Load[],
  invoices: Invoice[],
  repairOrders: RepairOrder[],
  drivers: Driver[],
): ActivityItem[] {
  const items: ActivityItem[] = [];
  const recentLoads = loads.slice(-30);
  const templates: Array<
    () => { actor: User; action: ActivityItem['action']; summary: string; entity: EntityRef | null }
  > = [
    () => {
      const l = rng.pick(recentLoads);
      const u = must(demoUsers.find((x) => x.id === l.dispatcherId));
      return {
        actor: u,
        action: 'status_change',
        summary: `${u.name} moved ${l.loadNumber} to ${label(l.status)}`,
        entity: ref('load', l.id, l.loadNumber),
      };
    },
    () => {
      const l = rng.pick(recentLoads);
      const u = must(demoUsers.find((x) => x.id === l.dispatcherId));
      return {
        actor: u,
        action: 'assign',
        summary: `${u.name} assigned ${l.driverName ?? 'a driver'} to ${l.loadNumber}`,
        entity: ref('load', l.id, l.loadNumber),
      };
    },
    () => {
      const l = rng.pick(recentLoads);
      const u = must(demoUsers.find((x) => x.id === l.dispatcherId));
      return {
        actor: u,
        action: 'create',
        summary: `${u.name} booked ${l.loadNumber} with ${l.brokerName ?? l.customerName} at $${l.rate.toLocaleString('en-US')}`,
        entity: ref('load', l.id, l.loadNumber),
      };
    },
    () => {
      const inv = rng.pick(invoices);
      const u = must(demoUsers[7]);
      return {
        actor: u,
        action: 'update',
        summary: `${u.name} ${inv.status === 'paid' ? 'applied payment to' : 'issued'} ${inv.invoiceNumber} for ${inv.billToName}`,
        entity: ref('invoice', inv.id, inv.invoiceNumber),
      };
    },
    () => {
      const inv = rng.pick(invoices);
      const u = must(demoUsers[8]);
      return {
        actor: u,
        action: 'upload',
        summary: `${u.name} attached POD to ${inv.invoiceNumber}`,
        entity: ref('invoice', inv.id, inv.invoiceNumber),
      };
    },
    () => {
      const ro = rng.pick(repairOrders);
      const u = must(demoUsers[6]);
      return {
        actor: u,
        action: ro.status === 'completed' ? 'approve' : 'update',
        summary: `${u.name} ${ro.status === 'completed' ? 'closed' : 'updated'} ${ro.roNumber} on unit ${ro.unitNumber} ($${ro.total.toLocaleString('en-US')})`,
        entity: ref('repair_order', ro.id, ro.roNumber),
      };
    },
    () => {
      const d = rng.pick(drivers.filter((x) => x.currentTruckId));
      const u = must(demoUsers[5]);
      return {
        actor: u,
        action: 'comment',
        summary: `${u.name} logged a coaching note for ${d.name}`,
        entity: ref('driver', d.id, d.name),
      };
    },
    () => {
      const d = rng.pick(drivers);
      const u = must(demoUsers[9]);
      return {
        actor: u,
        action: 'update',
        summary: `${u.name} verified the medical card for ${d.name}`,
        entity: ref('driver', d.id, d.name),
      };
    },
    () => {
      const u = must(demoUsers[10]);
      return {
        actor: u,
        action: 'update',
        summary: `${u.name} updated the plate on unit ${rng.pick(['2712', '2730', '3007'])}`,
        entity: null,
      };
    },
    () => {
      const u = rng.pick(demoUsers);
      return { actor: u, action: 'login', summary: `${u.name} signed in`, entity: null };
    },
  ];
  for (let i = 0; i < 40; i += 1) {
    const t = must(templates[i % templates.length])();
    items.push({
      id: `act_${String(i + 1).padStart(2, '0')}`,
      at: iso(NOW - (i * 34 + rng.int(1, 20)) * MINUTE),
      actorId: t.actor.id,
      actorName: t.actor.name,
      department: t.actor.department,
      action: t.action,
      summary: t.summary,
      entity: t.entity,
    });
  }
  return items;
}

function buildInsights(
  riskLoads: Load[],
  overdueItems: MaintenanceItem[],
  expiringDrivers: Driver[],
  trending: Driver,
  safetyEvents: SafetyEvent[],
  unit3012: Truck,
  hero: Truck,
  unit3120: Truck,
  unit3091: Truck,
  series: DashboardSeries,
  kpis: KpiSnapshot,
  repairOrders: RepairOrder[],
  brokers: Broker[],
  invoices: Invoice[],
): AiInsight[] {
  const insights: AiInsight[] = [];
  const add = (
    insight: Omit<AiInsight, 'id' | 'openedAt' | 'status' | 'actionStatus'> & { hoursAgo: number },
  ) => {
    insights.push({
      ...insight,
      id: `ai_${String(insights.length + 1).padStart(2, '0')}`,
      openedAt: iso(NOW - insight.hoursAgo * HOUR),
      status: 'open',
      actionStatus: 'pending',
    });
  };
  riskLoads.slice(0, 3).forEach((load, i) => {
    add({
      kind: 'load.late_risk',
      severity: load.exception?.code === 'at_risk' ? 'critical' : 'warning',
      department: 'dispatch',
      scope: ref('load', load.id, load.loadNumber),
      title: `${load.loadNumber}: ${load.exception?.code === 'at_risk' ? `${72 - i * 9}% probability of missing appointment` : 'delivery delayed'}`,
      detail: load.exception?.reason ?? '',
      evidence: [
        {
          label: 'Appointment',
          value: `${label(load.status)} · ${load.destination.city}, ${load.destination.state}`,
          entity: ref('load', load.id, load.loadNumber),
        },
        { label: 'ETA', value: load.etaAt ?? '—', entity: null },
        {
          label: 'Driver',
          value: load.driverName ?? '—',
          entity: load.driverId ? ref('driver', load.driverId, load.driverName ?? '') : null,
        },
        {
          label: 'Miles remaining',
          value: load.milesRemaining !== null ? `${load.milesRemaining} mi` : '—',
          entity: null,
        },
      ],
      recommendation:
        load.exception?.code === 'at_risk'
          ? 'Call the receiver now to move the appointment; notify the broker before the window closes.'
          : 'Notify the broker of the new delivery time and log detention at the pickup.',
      rationale:
        'ETA is computed from live position and remaining HOS; facility history shows appointments here are rarely held past 30 minutes late.',
      detector: 'load.late_risk',
      confidence: 0.72 - i * 0.05,
      hoursAgo: 1 + i,
    });
  });
  const trendingEvents = safetyEvents.filter(
    (e) => e.driverId === trending.id && new Date(e.at).getTime() > NOW - 14 * DAY,
  );
  const brakeRos = repairOrders.filter((r) => r.truckId === hero.id && r.type === 'brake_repair');
  const extraOverdue = overdueItems.filter((m) => m.unitNumber !== '3091').slice(0, 2);
  add({
    kind: 'truck.pm_due',
    severity: 'critical',
    department: 'maintenance',
    scope: ref('company', 'co_northwind', 'Fleet'),
    title: '5 trucks need maintenance attention',
    detail: `Unit 3091 is ${Math.abs(must(overdueItems.find((m) => m.unitNumber === '3091')).milesUntilDue).toLocaleString('en-US')} mi overdue for PM; unit 2785 brake inspection due in 2,500 mi after 3 brake repairs; unit 3120 is in shop awaiting parts; ${extraOverdue.map((m) => `unit ${m.unitNumber}`).join(' and ')} overdue.`,
    evidence: [
      {
        label: 'Unit 3091',
        value: 'PM service 1,800 mi overdue',
        entity: ref('truck', unit3091.id, 'Unit 3091'),
      },
      {
        label: 'Unit 2785',
        value: `Brake inspection in 2,500 mi · ${brakeRos.length} brake repairs in 6 months`,
        entity: ref('truck', hero.id, 'Unit 2785'),
      },
      {
        label: 'Unit 3120',
        value: 'In shop · clutch actuator, parts ETA Sep 8',
        entity: ref('truck', unit3120.id, 'Unit 3120'),
      },
      ...extraOverdue.map((m) => ({
        label: `Unit ${m.unitNumber}`,
        value: `${m.typeLabel} ${Math.abs(m.milesUntilDue).toLocaleString('en-US')} mi overdue`,
        entity: ref('truck', m.truckId, `Unit ${m.unitNumber}`),
      })),
    ],
    recommendation:
      'Route 3091 through the Naperville shop this week and book 2785 at Lone Star Fleet Service after the Dallas delivery.',
    rationale:
      'Overdue PM raises breakdown risk and DOT out-of-service exposure; grouping visits with planned returns keeps downtime under 1 day per unit.',
    detector: 'truck.pm_due',
    confidence: 0.9,
    hoursAgo: 3,
  });
  add({
    kind: 'document.expiring',
    severity: 'warning',
    department: 'safety',
    scope: ref('company', 'co_northwind', 'Compliance'),
    title: `${expiringDrivers.length} compliance documents expire within 30 days`,
    detail: expiringDrivers
      .map(
        (d) =>
          `${d.name}: ${d.medicalCardStatus === 'expiring' ? `medical card ${d.medicalCardExpiresOn}` : `CDL ${d.cdlExpiresOn}`}`,
      )
      .join('; '),
    evidence: expiringDrivers.map((d) => ({
      label: d.name,
      value:
        d.medicalCardStatus === 'expiring'
          ? `Medical card expires ${d.medicalCardExpiresOn}`
          : `CDL expires ${d.cdlExpiresOn}`,
      entity: ref('driver', d.id, d.name),
    })),
    recommendation:
      'Send renewal reminders through the driver portal and schedule DOT physicals before the expiry dates.',
    rationale:
      'Drivers are automatically placed on dispatch hold at expiry; renewing now avoids losing capacity during the busiest week of the month.',
    detector: 'document.expiring',
    confidence: 1,
    hoursAgo: 7,
  });
  add({
    kind: 'company.profit_change',
    severity: 'success',
    department: 'management',
    scope: ref('company', 'co_northwind', 'Northwind Freight'),
    title: 'Revenue +6.4% vs last month',
    detail:
      'August revenue grew 6.4% over July with gross margin held near 27%. Growth came from 9 additional loads with Prime Logistics Group and Blue Ridge Freight Brokers.',
    evidence: [
      {
        label: 'August revenue',
        value: `$${series.dailyRevenueProfit
          .filter((p) => p.date.startsWith('2026-08'))
          .reduce((a, p) => a + p.revenue, 0)
          .toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        entity: null,
      },
      {
        label: 'July revenue',
        value: `$${series.dailyRevenueProfit
          .filter((p) => p.date.startsWith('2026-07'))
          .reduce((a, p) => a + p.revenue, 0)
          .toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        entity: null,
      },
      {
        label: 'Revenue MTD',
        value: `$${kpis.revenueMtd.value.toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        entity: null,
      },
    ],
    recommendation:
      'Lock in volume commitments with the two growing brokers before Q4 rates reset.',
    rationale:
      'Period-over-period comparison of billed revenue by month; both months fully closed in the ledger.',
    detector: 'company.profit_change',
    confidence: 0.95,
    hoursAgo: 48,
  });
  add({
    kind: 'company.fuel_cost',
    severity: 'warning',
    department: 'management',
    scope: ref('company', 'co_northwind', 'Northwind Freight'),
    title: 'Fuel cost +8.2% vs prior 4 weeks',
    detail:
      'Fuel spend over the last 4 weeks is up 8.2%. About 60% is price (+$0.11/gal on average); the remainder is idle time concentrated on 6 units, led by unit 3012.',
    evidence: [
      {
        label: 'Last 4 weeks',
        value: `$${series.weeklyFuelCost
          .slice(9)
          .reduce((a, p) => a + p.value, 0)
          .toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        entity: null,
      },
      {
        label: 'Prior 4 weeks',
        value: `$${series.weeklyFuelCost
          .slice(5, 9)
          .reduce((a, p) => a + p.value, 0)
          .toLocaleString('en-US', { maximumFractionDigits: 0 })}`,
        entity: null,
      },
      {
        label: 'Unit 3012 idle',
        value: '21% (fleet 11%)',
        entity: ref('truck', unit3012.id, 'Unit 3012'),
      },
    ],
    recommendation:
      'Enable idle shutdown timers on the 6 high-idle units and route fueling to the Pilot/Flying J network pricing where available.',
    rationale:
      'Weekly fuel totals from fuel-card imports, split into price and volume effects; idle gallons from telematics.',
    detector: 'company.profit_change',
    confidence: 0.86,
    hoursAgo: 49,
  });
  add({
    kind: 'truck.mpg_drop',
    severity: 'warning',
    department: 'maintenance',
    scope: ref('truck', unit3012.id, 'Unit 3012'),
    title: 'Unit 3012: MPG down 14% over 30 days',
    detail:
      'Fuel economy fell from 6.90 to 5.93 MPG while idle time rose from 12% to 21%. The unit had an EGR cooler replacement in July and an injector replacement on Aug 22, and fault code P0204 has returned twice.',
    evidence: [
      { label: '30-day MPG', value: '5.93', entity: ref('truck', unit3012.id, 'Unit 3012') },
      { label: '90-day baseline', value: '6.90', entity: null },
      { label: 'Idle share', value: '21% vs 12%', entity: null },
      {
        label: 'Engine service',
        value: 'EGR cooler (Jul), injector #4 (Aug 22)',
        entity: ref(
          'repair_order',
          must(repairOrders.find((r) => r.truckId === unit3012.id)).id,
          'RO history',
        ),
      },
    ],
    recommendation:
      'Pull the unit for an engine inspection this week: verify injector #4, check for boost leaks, and review the idle-shutdown setting.',
    rationale:
      'WHY: an MPG drop of this size with rising idle and a recent injector repair matches a mechanical pattern rather than route mix; catching it early avoids a roadside failure on a $2,500+ load.',
    detector: 'correlation',
    confidence: 0.81,
    hoursAgo: 5,
  });
  add({
    kind: 'driver.safety_trend',
    severity: 'critical',
    department: 'safety',
    scope: ref('driver', trending.id, trending.name),
    title: `${trending.name} (D-2091): ${trendingEvents.length} safety events in 14 days`,
    detail: `${trendingEvents.filter((e) => e.kind === 'speeding').length} speeding events in the last 14 days against a fleet average of 2. Events cluster on I-55 and I-70 during afternoon runs; safety score has fallen to ${trending.safetyScore}.`,
    evidence: [
      {
        label: 'Events (14d)',
        value: String(trendingEvents.length),
        entity: ref('driver', trending.id, trending.name),
      },
      { label: 'Fleet average', value: '2', entity: null },
      { label: 'Safety score', value: String(trending.safetyScore), entity: null },
      {
        label: 'Unit',
        value: trending.currentTruckUnit ?? '—',
        entity: trending.currentTruckId
          ? ref('truck', trending.currentTruckId, `Unit ${trending.currentTruckUnit ?? ''}`)
          : null,
      },
    ],
    recommendation:
      'Schedule a coaching session this week and enable in-cab speed alerts for 30 days.',
    rationale:
      'WHY: the trend is 6x fleet average and accelerating; early coaching reduces repeat events by about half in the company history, and it protects the CSA unsafe-driving score.',
    detector: 'driver.safety_trend',
    confidence: 0.88,
    hoursAgo: 1.5,
  });
  const topBroker = must(
    [...brokers].sort((a, b) => b.outstandingBalance - a.outstandingBalance)[0],
    'broker',
  );
  const brokerInvoices = invoices.filter((i) => i.billToId === topBroker.id && i.balance > 0);
  const pastDue = brokerInvoices.filter((i) => i.agingDays > 0);
  const money = (n: number) => `$${n.toLocaleString('en-US', { minimumFractionDigits: 2 })}`;
  add({
    kind: 'ar.aging',
    severity: 'warning',
    department: 'accounting',
    scope: ref('broker', topBroker.id, topBroker.name),
    title: `${topBroker.name}: ${money(topBroker.outstandingBalance)} outstanding`,
    detail: `${brokerInvoices.length} open invoices totalling ${money(topBroker.outstandingBalance)}; ${pastDue.length} past due. Payment terms are Net ${topBroker.paymentTermsDays}.`,
    evidence: [
      { label: 'Open invoices', value: String(brokerInvoices.length), entity: null },
      { label: 'Past due', value: String(pastDue.length), entity: null },
      ...pastDue.slice(0, 3).map((i) => ({
        label: i.invoiceNumber,
        value: `${money(i.balance)} · ${i.agingDays} days past due`,
        entity: ref('invoice', i.id, i.invoiceNumber),
      })),
    ],
    recommendation:
      'Send a statement with the past-due invoices today and hold new bookings above the credit limit until the balance is under 60 days.',
    rationale:
      'Broker balances above $20,000 with invoices past 30 days historically take 2x longer to collect; acting at 30 days keeps DSO under 40.',
    detector: 'ar.aging',
    confidence: 0.93,
    hoursAgo: 12,
  });
  return insights.slice(0, 10);
}

/** Monday of the week a date falls in; the PTI cycle runs Monday to Sunday. */
function mondayOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}

/**
 * Every collection at zero: the workspace a production build starts from.
 *
 * Built by hand rather than by emptying a generated dataset, so nothing generated — a KPI, a
 * chart series, an insight — survives into a workspace that is supposed to hold nothing.
 */
export function emptyDataset(): DemoData {
  return {
    company: demoCompany,
    users: demoUsers,
    memberships: demoMemberships,
    trucks: [],
    trailers: [],
    drivers: [],
    customers: [],
    brokers: [],
    facilities: [],
    loads: [],
    maintenance: [],
    repairOrders: [],
    serviceRecords: [],
    truckNotes: [],
    fuelTransactions: [],
    safetyEvents: [],
    invoices: [],
    notifications: [],
    tasks: [],
    activity: [],
    aiInsights: [],
    kpis: {
      asOf: new Date().toISOString(),
      totalTrucks: kpi(0, 0),
      activeTrucks: kpi(0, 0),
      activeLoads: kpi(0, 0),
      revenueMtd: kpi(0, 0),
      profitMtd: kpi(0, 0),
      criticalAlerts: kpi(0, 0),
    },
    series: { dailyRevenueProfit: [], weeklyFuelCost: [], fleetHealth: [], loadStatus: [] },
    complianceAudit: [],
    inspections: [],
    defects: [],
    violations: [],
    accidents: [],
    claims: [],
    correctiveActions: [],
    vendors: [],
    invoiceLines: [],
    payments: [],
    bills: [],
    expenses: [],
    settlements: [],
    deductionPlans: [],
    payrollPeriods: [],
    payslips: [],
    journal: [],
    ledgerPeriods: [],
    escrowEntries: [],
    terminations: [],
    unitExits: [],
    ptiRecords: [],
    ptiComponents: defaultPtiComponents(),
    ptiRatings: [],
    downPeriods: [],
    ptiConditionConfig: { ...DEFAULT_PTI_CONDITION_CONFIG },
    workOrderTypes: [],
    unitDocumentRules: {},
  };
}

/** The singleton dataset used by the fake API. */
export const demoData: DemoData = DATASET === 'empty' ? emptyDataset() : generateDemoData();
