#!/usr/bin/env node
/**
 * Hackathon demo data: one fictional carrier, "Silk Way Demo Lines" (company id co_silkway_demo),
 * written straight into a LOCAL database so the NeWay AI tools have something real-looking to read.
 *
 *   node scripts/hackathon/seed-demo.mjs                  (DATABASE_URL from the env, else the demo default)
 *   node scripts/hackathon/seed-demo.mjs --positions-only (only refresh "now"-relative truck positions)
 *
 * Rules it keeps:
 *   - Refuses to run unless DATABASE_URL points at localhost / 127.0.0.1 / ::1.
 *   - Needs the schema: start the API once against the database first (it migrates on boot).
 *   - Idempotent: every row of co_silkway_demo is removed and written again, in one transaction.
 *     Only this company's rows are touched (and its admin user); nothing else in the database.
 *   - Everything is invented: people, phones (555-01xx), brokers, customers, rates, VINs.
 *   - Times are relative to the real clock at seed time. Positions go "stale" after an hour (the
 *     product's tracking rule), so re-run the seed (or --positions-only) shortly before recording.
 *
 * Where each thing lands (what the AI tools read):
 *   trucks.location (ELD position), trucks/drivers/trailers, truck_driver_assignments, loads.record
 *   (stops, documents, exception, etaAt), qualification_items + compliance_documents, app_state
 *   `t.co_silkway_demo.ws2-fueltransactions` (fuel ledger), hiring_leads / hiring_cases /
 *   hiring_safety_reviews / hiring_safety_checks, work_orders (+ lines), pti_inspections / pti_defects,
 *   employees (dispatchers), dispatch_roster (+ assignments).
 */
import { createRequire } from 'node:module';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const postgres = require('postgres');
const scrypt = promisify(scryptCb);

export const COMPANY_ID = 'co_silkway_demo';
export const COMPANY_NAME = 'Silk Way Demo Lines';
export const ADMIN_EMAIL = 'demo.admin@silkway-demo.test';
export const ADMIN_PASSWORD = process.env.DEMO_ADMIN_PASSWORD ?? 'MuseDemo-2026!';
const ADMIN_USER_ID = 'usr_swd_admin';
const ADMIN_MEMBERSHIP_ID = 'mbr_swd_admin';
/** Driver-app login for the driver of the dispatched load (Ask NeWay: "When is my next pickup?"). */
const DRIVER_USER_ID = 'usr_swd_driver_app';
const DRIVER_MEMBERSHIP_ID = 'mbr_swd_driver_app';
const DRIVER_ROLE_ID = 'rol_driver'; // `rol_${DRIVER_ROLE_CODE}`, as AppAccessService grants it
const DEFAULT_URL = 'postgres://neway:neway@127.0.0.1:5432/neway_demo';

// ------------------------------------------------------------------------------------- guards

const url = process.env.DATABASE_URL ?? DEFAULT_URL;
const host = new URL(url).hostname.replace(/^\[|\]$/g, '');
if (!['localhost', '127.0.0.1', '::1'].includes(host)) {
  console.error(`Refusing to seed: DATABASE_URL host is "${host}". This script only writes to a local database.`);
  process.exit(2);
}
const keepFresh = process.argv.includes('--keep-fresh');
const positionsOnly = keepFresh || process.argv.includes('--positions-only');

// ------------------------------------------------------------------------------------- helpers

let rngState = 20261103;
/** Deterministic, so two runs produce the same fleet (only the clock moves). */
function rnd() {
  rngState = (rngState + 0x6d2b79f5) | 0;
  let t = Math.imul(rngState ^ (rngState >>> 15), 1 | rngState);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
const between = (a, b) => a + rnd() * (b - a);
const int = (a, b) => Math.floor(between(a, b + 1));
const pad = (n, w) => String(n).padStart(w, '0');

let NOW = new Date();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const at = (offsetMs) => new Date(NOW.getTime() + offsetMs);
const iso = (offsetMs) => at(offsetMs).toISOString();
/** A business date in US Eastern (every clock in the product is Eastern). */
function etDate(offsetMs = 0) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at(offsetMs));
}
const days = (n) => n * DAY;
/** Monday of the current Eastern week. */
function etMonday() {
  const today = etDate();
  const d = new Date(`${today}T12:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}
function haversineMiles(a, b) {
  const R = 3958.8;
  const toRad = (x) => (x * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
/** The product's estimate: straight line x 1.18, rounded to 5 (apps/web/src/demo/mileage.ts). */
const roadMiles = (a, b) => Math.round((haversineMiles(a, b) * 1.18) / 5) * 5;
const AVG_MPH = 47; // LOADS_CONFIG.averageSpeedMph
function headingDegrees(a, b) {
  const toRad = (x) => (x * Math.PI) / 180;
  const y = Math.sin(toRad(b.lng - a.lng)) * Math.cos(toRad(b.lat));
  const x = Math.cos(toRad(a.lat)) * Math.sin(toRad(b.lat)) - Math.sin(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.cos(toRad(b.lng - a.lng));
  return Math.round(((Math.atan2(y, x) * 180) / Math.PI + 360) % 360);
}

// ------------------------------------------------------------------------------------- the world

const C = {
  CHI: { city: 'Chicago', state: 'IL', zip: '60632', lat: 41.81, lng: -87.7, tz: 'America/Chicago' },
  IND: { city: 'Indianapolis', state: 'IN', zip: '46241', lat: 39.73, lng: -86.24, tz: 'America/Indiana/Indianapolis' },
  CMH: { city: 'Columbus', state: 'OH', zip: '43207', lat: 39.9, lng: -82.97, tz: 'America/New_York' },
  ATL: { city: 'Atlanta', state: 'GA', zip: '30336', lat: 33.74, lng: -84.55, tz: 'America/New_York' },
  DAL: { city: 'Dallas', state: 'TX', zip: '75241', lat: 32.67, lng: -96.77, tz: 'America/Chicago' },
  HOU: { city: 'Houston', state: 'TX', zip: '77029', lat: 29.76, lng: -95.26, tz: 'America/Chicago' },
  MEM: { city: 'Memphis', state: 'TN', zip: '38118', lat: 35.05, lng: -89.93, tz: 'America/Chicago' },
  BNA: { city: 'Nashville', state: 'TN', zip: '37210', lat: 36.13, lng: -86.73, tz: 'America/Chicago' },
  CLT: { city: 'Charlotte', state: 'NC', zip: '28208', lat: 35.21, lng: -80.91, tz: 'America/New_York' },
  MCI: { city: 'Kansas City', state: 'MO', zip: '64161', lat: 39.16, lng: -94.47, tz: 'America/Chicago' },
  DEN: { city: 'Denver', state: 'CO', zip: '80216', lat: 39.78, lng: -104.95, tz: 'America/Denver' },
  PHX: { city: 'Phoenix', state: 'AZ', zip: '85043', lat: 33.43, lng: -112.2, tz: 'America/Phoenix' },
  LAX: { city: 'Ontario', state: 'CA', zip: '91761', lat: 34.04, lng: -117.6, tz: 'America/Los_Angeles' },
  HAR: { city: 'Harrisburg', state: 'PA', zip: '17111', lat: 40.25, lng: -76.8, tz: 'America/New_York' },
  EWR: { city: 'Newark', state: 'NJ', zip: '07114', lat: 40.71, lng: -74.17, tz: 'America/New_York' },
  JAX: { city: 'Jacksonville', state: 'FL', zip: '32254', lat: 30.33, lng: -81.75, tz: 'America/New_York' },
  STL: { city: 'St. Louis', state: 'MO', zip: '63147', lat: 38.7, lng: -90.22, tz: 'America/Chicago' },
  SDF: { city: 'Louisville', state: 'KY', zip: '40218', lat: 38.19, lng: -85.67, tz: 'America/New_York' },
  OKC: { city: 'Oklahoma City', state: 'OK', zip: '73129', lat: 35.43, lng: -97.48, tz: 'America/Chicago' },
  LRD: { city: 'Laredo', state: 'TX', zip: '78045', lat: 27.6, lng: -99.48, tz: 'America/Chicago' },
  DTW: { city: 'Detroit', state: 'MI', zip: '48209', lat: 42.31, lng: -83.12, tz: 'America/Detroit' },
  LIT: { city: 'Little Rock', state: 'AR', zip: '72206', lat: 34.72, lng: -92.26, tz: 'America/Chicago' },
  SLC: { city: 'Salt Lake City', state: 'UT', zip: '84104', lat: 40.75, lng: -111.97, tz: 'America/Denver' },
};

{
  const placesPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../apps/web/public/geo/us-places.json');
  if (existsSync(placesPath)) {
    const places = JSON.parse(readFileSync(placesPath, 'utf8'));
    for (const c of Object.values(C)) {
      const hit = places.zip?.[c.zip];
      if (hit) [c.lat, c.lng] = hit;
    }
  }
}

const BROKERS = [
  'Bluefern Freight Partners', 'Prairie Lantern Logistics', 'Copperline Brokerage', 'Harborview Load Co.',
  'Tall Pines Transport Brokers', 'Meridian Arc Logistics', 'Oakridge Cargo Network', 'Silver Mesa Freight',
];
const SHIPPERS = [
  'Granite Valley Foods DC', 'Lakeshore Paper Mill', 'Redwood Home Goods DC', 'Northgate Beverage Plant',
  'Summit Auto Parts Hub', 'Clearwater Packaging', 'Bright Orchard Produce', 'Ironbridge Steel Supply',
  'Maple Crest Appliances', 'Bayfront Retail DC',
];
const COMMODITIES = ['Paper goods', 'Canned food', 'Auto parts', 'Household goods', 'Bottled water', 'Packaging film', 'Frozen produce', 'Appliances', 'Steel coils (tarped)'];

const DISPATCHERS = [
  { id: 'emp_swd_nadia', number: 'SWD-E01', first: 'Nadia', last: 'Reyes', position: 'Dispatcher', department: 'dispatch' },
  { id: 'emp_swd_colin', number: 'SWD-E02', first: 'Colin', last: 'Avery', position: 'Dispatcher', department: 'dispatch' },
  { id: 'emp_swd_priya', number: 'SWD-E03', first: 'Priya', last: 'Raman', position: 'Dispatch lead', department: 'dispatch' },
];
const STAFF = [
  ...DISPATCHERS,
  { id: 'emp_swd_helen', number: 'SWD-E04', first: 'Helen', last: 'Brooks', position: 'Safety manager', department: 'safety' },
  { id: 'emp_swd_tara', number: 'SWD-E05', first: 'Tara', last: 'Quinn', position: 'Recruiter', department: 'hr' },
  { id: 'emp_swd_sam', number: 'SWD-E06', first: 'Sam', last: 'Ortega', position: 'Fleet manager', department: 'fleet' },
  { id: 'emp_swd_june', number: 'SWD-E07', first: 'June', last: 'Halvorsen', position: 'Billing specialist', department: 'accounting' },
];

const DRIVER_NAMES = [
  ['Caleb', 'Whitaker'], ['Darnell', 'Pruitt'], ['Emilio', 'Varga'], ['Franklin', 'Osei'], ['Gavin', 'Lund'],
  ['Hector', 'Salinas'], ['Isaac', 'Brennan'], ['Jamal', 'Corbett'], ['Kurt', 'Lindqvist'], ['Luis', 'Arredondo'],
  ['Mason', 'Pike'], ['Nolan', 'Ashby'], ['Omar', 'Haddad'], ['Pete', 'Sorensen'], ['Quentin', 'Marsh'],
  ['Rafael', 'Duarte'], ['Shane', 'Kowalski'], ['Trevor', 'Gaines'], ['Ulric', 'Boone'], ['Victor', 'Albescu'],
  ['Wesley', 'Crane'], ['Xavier', 'Molina'], ['Yusuf', 'Demir'], ['Zane', 'Holloway'], ['Bogdan', 'Petrenko'],
];
const HOMES = [C.CHI, C.IND, C.CMH, C.ATL, C.DAL, C.MEM, C.BNA, C.MCI, C.STL, C.SDF, C.OKC, C.HAR, C.CLT];
const MAKES = [
  ['Freightliner', 'Cascadia 126'], ['Volvo', 'VNL 860'], ['Kenworth', 'T680'], ['Peterbilt', '579'], ['International', 'LT625'],
];

/**
 * The plan for each of the 25 tractor/driver pairs. `scenario` drives the load, position, truck and
 * driver status. Index = position in DRIVER_NAMES; unit = 1101 + index.
 */
const PLAN = [
  { scenario: 'transit', lane: ['CHI', 'ATL'], progress: 0.55, verdict: 'on_time' },
  { scenario: 'transit', lane: ['DAL', 'ATL'], progress: 0.45, verdict: 'off_route' },
  { scenario: 'transit', lane: ['IND', 'DAL'], progress: 0.6, verdict: 'on_time' },
  { scenario: 'transit', lane: ['MEM', 'CLT'], progress: 0.35, verdict: 'on_time' },
  { scenario: 'shop', wo: { stage: 'waiting_parts', title: 'Air brake chamber and slack adjuster, axle 2', system: 'brakes' } },
  { scenario: 'transit', lane: ['HOU', 'MCI'], progress: 0.7, verdict: 'at_risk' },
  { scenario: 'transit', lane: ['STL', 'DEN'], progress: 0.5, verdict: 'on_time' },
  { scenario: 'transit', lane: ['ATL', 'HAR'], progress: 0.65, verdict: 'late' },
  { scenario: 'transit', lane: ['CMH', 'JAX'], progress: 0.4, verdict: 'on_time' },
  { scenario: 'transit', lane: ['OKC', 'PHX'], progress: 0.3, verdict: 'on_time' },
  { scenario: 'at_pickup', lane: ['SDF', 'DTW'] },
  { scenario: 'loaded', lane: ['BNA', 'EWR'] },
  { scenario: 'home', medicalExpired: true },
  { scenario: 'transit', lane: ['LRD', 'CHI'], progress: 0.5, verdict: 'on_time' },
  { scenario: 'shop', wo: { stage: 'in_repair', title: 'Turbo actuator fault, derate', system: 'engine' } },
  { scenario: 'at_delivery', lane: ['DEN', 'SLC'] },
  { scenario: 'available' },
  { scenario: 'dispatched', lane: ['CLT', 'CMH'] },
  { scenario: 'available' },
  { scenario: 'transit', lane: ['PHX', 'LAX'], progress: 0.6, verdict: 'on_time' },
  { scenario: 'shop', wo: { stage: 'diagnosing', title: 'Coolant leak at water pump, PTI flagged', system: 'cooling' } },
  { scenario: 'vacation' },
  { scenario: 'assigned_next', lane: ['MCI', 'STL'] },
  { scenario: 'home' },
  { scenario: 'available' },
];

// ------------------------------------------------------------------------------------- build rows

function buildRows() {
  const truckRows = [];
  const driverRows = [];
  const trailerRows = [];
  const assignmentRows = [];
  const loadRecords = [];
  const rosterRows = [];
  const rosterAssignmentRows = [];
  const cellRows = [];
  let loadSeq = 4100;
  const nextLoadNumber = () => `L-${++loadSeq}`;

  const trailerUnit = (i) => `53${pad(i + 1, 2)}`;

  for (let i = 0; i < 25; i += 1) {
    const plan = PLAN[i];
    const [first, last] = DRIVER_NAMES[i];
    const unit = String(1101 + i);
    const truckId = `trk_swd_${unit}`;
    const driverId = `drv_swd_${pad(i + 1, 2)}`;
    const trailerId = `trl_swd_${trailerUnit(i)}`;
    const [make, model] = MAKES[i % MAKES.length];
    const year = 2019 + (i % 6);
    const home = HOMES[i % HOMES.length];
    const dispatcher = DISPATCHERS[i % DISPATCHERS.length];
    const odometer = 180_000 + int(0, 420_000);
    const parked = { lat: home.lat + between(-0.03, 0.03), lng: home.lng + between(-0.03, 0.03) };

    let truckStatus = 'available';
    let driverStatus = 'available';
    let location = {
      lat: +parked.lat.toFixed(5), lng: +parked.lng.toFixed(5), city: home.city, state: home.state,
      updatedAt: iso(-int(4, 40) * MIN), speedMph: 0, engineState: 'off',
    };
    let currentLoadId = null;

    if (plan.lane) {
      const [o, d] = plan.lane.map((k) => C[k]);
      const load = buildActiveLoad({ i, plan, o, d, unit, truckId, driverId, trailerId, first, last, dispatcher, nextLoadNumber });
      loadRecords.push(load.record);
      currentLoadId = plan.scenario === 'assigned_next' ? null : load.record.id;
      if (load.location) location = load.location;
      truckStatus = load.truckStatus;
      driverStatus = load.driverStatus;
    } else if (plan.scenario === 'shop') {
      truckStatus = 'in_shop';
      driverStatus = 'off_duty';
    } else if (plan.scenario === 'home') {
      truckStatus = 'idle';
      driverStatus = 'off_duty';
    } else if (plan.scenario === 'vacation') {
      truckStatus = 'idle';
      driverStatus = 'vacation';
    }

    const cdlExpires = i === 16 ? etDate(days(21)) : etDate(days(int(300, 1400)));
    const medExpires = plan.medicalExpired ? etDate(-days(3)) : i === 4 ? etDate(days(9)) : etDate(days(int(120, 700)));
    truckRows.push({
      id: truckId, company_id: COMPANY_ID, unit_number: unit,
      vin: `1SWDM${year}${unit}${pad(i * 37 + 1000, 4)}`.slice(0, 17).padEnd(17, '0'),
      year, make, model, plate: `SWD${unit}`, plate_state: 'IL', color: pick(['White', 'Silver', 'Blue', 'Red']),
      status: truckStatus, health: plan.scenario === 'shop' ? 'critical' : i === 8 ? 'needs_attention' : 'healthy',
      ownership: i % 7 === 3 ? 'owner_operator' : 'owned', group_name: null,
      odometer, odometer_at: NOW, engine_hours: String(Math.round(odometer / 38)), in_service_date: `${year}-03-01`,
      current_driver_id: driverId, current_trailer_id: trailerId, current_load_id: currentLoadId, location,
      next_service_odometer: odometer + int(-1500, 14000), next_service_date: etDate(days(int(-4, 60))), next_service_type: 'oil_change',
      telematics_provider: 'samsara', telematics_status: 'connected', telematics_account_id: null, telematics_external_id: null,
      telematics_synced_at: NOW, mpg_30d: between(6.1, 7.6).toFixed(2), mpg_90d: between(6.2, 7.4).toFixed(2),
      idle_percent_30d: between(6, 22).toFixed(1), idle_percent_90d: between(7, 20).toFixed(1), home_terminal: 'Joliet, IL',
    });
    driverRows.push({
      id: driverId, company_id: COMPANY_ID, driver_number: `D-${pad(201 + i, 3)}`, first_name: first, last_name: last,
      phone: `(312) 555-01${pad(i + 10, 2)}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@silkway-demo.test`,
      driver_type: i % 7 === 3 ? 'owner_operator' : 'company', cdl_state: home.state, cdl_class: 'A', cdl_endorsements: i % 4 === 0 ? ['N', 'T'] : [],
      cdl_expires_on: cdlExpires, cdl_status: i === 16 ? 'expiring' : 'verified',
      medical_card_expires_on: medExpires, medical_card_status: plan.medicalExpired ? 'expired' : i === 4 ? 'expiring' : 'verified',
      hire_date: etDate(-days(int(90, 1500))), status: driverStatus,
      dispatcher_id: dispatcher.id, dispatcher_name: `${dispatcher.first} ${dispatcher.last}`,
      current_truck_id: truckId, current_trailer_id: trailerId, home_city: home.city, home_state: home.state,
      safety_score: String(int(82, 99)), safety_events_30d: int(0, 3),
      pay_plan_kind: i % 7 === 3 ? 'percent_of_linehaul' : 'per_mile', pay_plan_rate: i % 7 === 3 ? '88' : '0.62', preferred_language: 'en',
    });
    trailerRows.push({
      id: trailerId, company_id: COMPANY_ID, unit_number: trailerUnit(i), vin: `1SWTR53${pad(i + 1, 2)}${year}DEMO`.slice(0, 17).padEnd(17, '0'),
      year: 2018 + (i % 7), make: pick(['Utility', 'Wabash', 'Great Dane', 'Hyundai Translead']), model: i % 5 === 0 ? 'Reefer 53' : 'Dry van 53',
      type: i % 5 === 0 ? 'reefer' : 'dry_van', length_ft: 53, plate: `T${trailerUnit(i)}`, plate_state: 'IL', status: 'assigned', ownership: 'owned',
      current_truck_id: truckId, current_load_id: currentLoadId, next_inspection_date: etDate(days(int(20, 300))), home_terminal: 'Joliet, IL',
    });
    assignmentRows.push({
      id: `tda_swd_${unit}`, company_id: COMPANY_ID, truck_id: truckId, driver_id: driverId,
      assigned_on: etDate(-days(int(30, 200))), source: 'backfill', created_by: ADMIN_USER_ID, created_by_name: 'Demo seed',
    });
    rosterRows.push({
      id: driverId, company_id: COMPANY_ID, driver_id: driverId, name: `${first} ${last}`.toUpperCase(), truck_unit: unit,
      phone: `(312) 555-01${pad(i + 10, 2)}`, dispatcher_id: dispatcher.id, dispatcher_name: `${dispatcher.first} ${dispatcher.last}`,
    });
    // Today's STATUS word on the Daily board, as a dispatcher would have typed it.
    const STATUS_WORD = { transit: 'ENROUTE', at_pickup: 'AT PU', loaded: 'ENROUTE', at_delivery: 'UNLOADING', dispatched: 'DISPATCHED', assigned_next: 'COVERED', shop: 'SHOP', home: 'HOME', vacation: 'VACATION', available: 'READY' };
    cellRows.push({
      id: `dbc_swd_${pad(i + 1, 2)}_status`, company_id: COMPANY_ID, driver_id: driverId, day: etDate(), column: 'status',
      value: STATUS_WORD[plan.scenario], set_by: ADMIN_USER_ID, set_by_name: `${dispatcher.first} ${dispatcher.last}`, set_at: at(-int(20, 240) * MIN),
    });
    rosterAssignmentRows.push({
      id: `dra_swd_${unit}`, company_id: COMPANY_ID, roster_id: driverId, effective_from: etDate(-days(28)),
      dispatcher_id: dispatcher.id, dispatcher_name: `${dispatcher.first} ${dispatcher.last}`, truck_unit: unit, by: 'Demo seed',
    });
  }

  // Two spare trailers in the yard.
  for (const n of [26, 27]) {
    trailerRows.push({
      id: `trl_swd_${trailerUnit(n - 1)}`, company_id: COMPANY_ID, unit_number: trailerUnit(n - 1), vin: `1SWTR53${n}SPAREDEMO`.slice(0, 17).padEnd(17, '0'),
      year: 2017, make: 'Wabash', model: 'Dry van 53', type: 'dry_van', length_ft: 53, plate: `T${trailerUnit(n - 1)}`, plate_state: 'IL',
      status: 'available', ownership: 'owned', next_inspection_date: n === 27 ? etDate(-days(5)) : etDate(days(80)), home_terminal: 'Joliet, IL',
    });
  }

  // History and the open book: delivered, closed, booked, cancelled, TONU.
  const history = buildHistoricLoads({ driverRows, truckRows, trailerRows, nextLoadNumber });
  loadRecords.push(...history);

  return { truckRows, driverRows, trailerRows, assignmentRows, loadRecords, rosterRows, rosterAssignmentRows, cellRows };
}

function stop({ id, sequence, kind, place, facility, start, end, status, arrivedAt = null, departedAt = null, loadedAt = null }) {
  return {
    id, sequence, kind, facilityId: `fac_swd_${place.city.toLowerCase().replace(/[^a-z]/g, '')}_${kind}`, facilityName: facility,
    address: `${int(100, 9800)} ${pick(['Industrial Pkwy', 'Commerce Dr', 'Distribution Way', 'Logistics Blvd', 'Freight Ave'])}`,
    city: place.city, state: place.state, zip: place.zip, timezone: place.tz,
    appointmentStartAt: start, appointmentEndAt: end, appointmentNoWindow: false, handling: 'live',
    status, arrivedAt, departedAt, loadedAt, freeTimeMinutes: 120, appointmentConfirmedAt: null, detentionMinutes: 0, notes: null,
  };
}

function doc(loadId, type, title, uploadedAt, by = 'Driver app') {
  const ext = 'pdf';
  return {
    id: `ldoc_${loadId}_${type}`, type, title, fileName: `${loadId}-${type}.${ext}`, sizeBytes: int(80_000, 900_000),
    uploadedAt, uploadedBy: by, status: 'verified', review: 'verified', verifiedBy: 'June Halvorsen', verifiedAt: uploadedAt, mimeType: 'application/pdf',
  };
}

function event(loadId, n, atIso, kind, title, actorName = 'Demo seed', stopId = null) {
  return { id: `lev_${loadId}_${n}`, at: atIso, kind, actorType: kind === 'arrived' || kind === 'departed' ? 'driver' : 'user', actorName, title, detail: null, stopId };
}

function baseLoad({ id, loadNumber, status, o, d, driver, truck, trailer, dispatcher, pickupStart, deliveryStart, rate, bookedAt }) {
  const miles = roadMiles(o, d);
  const broker = pick(BROKERS);
  return {
    id, loadNumber, status, exception: null,
    customerId: `cus_swd_${broker.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12)}`, customerName: broker,
    brokerId: `brk_swd_${broker.toLowerCase().replace(/[^a-z]/g, '').slice(0, 12)}`, brokerName: broker,
    brokerReference: `${pick(['BF', 'PL', 'CL', 'HV', 'TP', 'MA', 'OC', 'SM'])}${int(100000, 999999)}`,
    commodity: pick(COMMODITIES), weightLbs: int(18, 43) * 1000, pieces: int(10, 26), equipmentType: trailer?.type ?? 'dry_van',
    temperatureF: trailer?.type === 'reefer' ? 34 : null, hazmat: false,
    dispatcherId: dispatcher.id, dispatcherName: `${dispatcher.first} ${dispatcher.last}`,
    driverId: driver?.id ?? null, driverName: driver ? `${driver.first_name} ${driver.last_name}` : null,
    truckId: truck?.id ?? null, truckUnit: truck?.unit_number ?? null, trailerId: trailer?.id ?? null, trailerUnit: trailer?.unit_number ?? null,
    origin: { city: o.city, state: o.state }, destination: { city: d.city, state: d.state },
    stops: [], rate, driverRate: null, loadedMiles: miles, emptyMiles: int(15, 140), rpm: +(rate / miles).toFixed(2),
    charges: [{ id: `chg_${id}_lh`, type: 'linehaul', description: 'Linehaul', amount: rate, billable: true, payableToDriver: true, status: 'accepted' }],
    expenses: [], financials: null, timeline: [], notes: [], documents: [],
    pickupAt: pickupStart, deliveryAt: deliveryStart, etaAt: null, manualEta: null, updaterId: null, updaterName: null,
    milesRemaining: null, bookedAt, dispatchedAt: null, deliveredAt: null, invoiceId: null, createdAt: bookedAt, updatedAt: iso(0), route: null,
  };
}

const rateFor = (o, d) => Math.round((roadMiles(o, d) * between(2.15, 2.95) + 150) / 25) * 25;

function buildActiveLoad({ i, plan, o, d, truckId, driverId, trailerId, first, last, dispatcher, nextLoadNumber, unit }) {
  const loadNumber = nextLoadNumber();
  const id = `lod_swd_${loadNumber.slice(2)}`;
  const miles = roadMiles(o, d);
  const driver = { id: driverId, first_name: first, last_name: last };
  const truck = { id: truckId, unit_number: unit };
  const trailer = { id: trailerId, unit_number: `53${pad(i + 1, 2)}`, type: i % 5 === 0 ? 'reefer' : 'dry_van' };
  const rate = rateFor(o, d);
  const pickupStop = `stp_${id}_1`;
  const deliveryStop = `stp_${id}_2`;
  const shipper = pick(SHIPPERS);
  const receiver = pick(SHIPPERS.filter((s) => s !== shipper));
  let record;
  let location = null;
  let truckStatus = 'driving';
  let driverStatus = 'driving';

  if (plan.scenario === 'transit') {
    // Where the truck is now, along the lane (or off it for the off-route story).
    let pos = { lat: o.lat + (d.lat - o.lat) * plan.progress, lng: o.lng + (d.lng - o.lng) * plan.progress };
    let city = null;
    if (plan.verdict === 'off_route') {
      // Dallas -> Atlanta runs I-20 through Shreveport and Jackson; this truck is up near Little Rock.
      pos = { lat: C.LIT.lat + 0.12, lng: C.LIT.lng + 0.18 };
      city = C.LIT;
    }
    const remaining = roadMiles(pos, d);
    const etaMs = (remaining / AVG_MPH) * HOUR;
    let deadlineMs;
    if (plan.verdict === 'at_risk') deadlineMs = etaMs + 22 * MIN; // inside the 30-minute buffer
    else if (plan.verdict === 'late') deadlineMs = etaMs - 95 * MIN; // lands 95 min after the window closes
    else deadlineMs = etaMs + int(3, 9) * HOUR; // comfortable
    // Round the comfortable ones to the quarter hour; the two stories keep their exact margin.
    if (plan.verdict === 'on_time' || plan.verdict === 'off_route') deadlineMs = Math.round(deadlineMs / (15 * MIN)) * 15 * MIN;
    const deliveryEnd = iso(deadlineMs);
    const deliveryStart = iso(deadlineMs - 2 * HOUR);
    const travelledHours = (roadMiles(o, pos) / AVG_MPH) + 0.5;
    const departed = iso(-travelledHours * HOUR);
    const pickupStart = iso(-travelledHours * HOUR - 3 * HOUR);
    record = baseLoad({ id, loadNumber, status: 'in_transit', o, d, driver, truck, trailer, dispatcher, pickupStart, deliveryStart: deliveryStart, rate, bookedAt: iso(-travelledHours * HOUR - days(1)) });
    record.stops = [
      stop({ id: pickupStop, sequence: 1, kind: 'pickup', place: o, facility: shipper, start: pickupStart, end: iso(-travelledHours * HOUR - 1 * HOUR), status: 'completed', arrivedAt: iso(-travelledHours * HOUR - 2.5 * HOUR), departedAt: departed, loadedAt: iso(-travelledHours * HOUR - 0.4 * HOUR) }),
      stop({ id: deliveryStop, sequence: 2, kind: 'delivery', place: d, facility: receiver, start: deliveryStart, end: deliveryEnd, status: 'pending' }),
    ];
    record.dispatchedAt = iso(-travelledHours * HOUR - 6 * HOUR);
    record.etaAt = iso(etaMs);
    record.milesRemaining = remaining;
    record.documents = [doc(id, 'rate_confirmation', 'Rate confirmation', record.bookedAt, 'Nadia Reyes'), doc(id, 'bol', 'Bill of lading', iso(-travelledHours * HOUR - 0.3 * HOUR))];
    if (plan.verdict === 'at_risk') record.exception = { code: 'at_risk', reason: 'Heavy traffic reported ahead; ETA inside the 30-minute buffer', raisedAt: iso(-25 * MIN) };
    if (plan.verdict === 'late') record.exception = { code: 'delayed', reason: 'Lost time at the shipper and a closed ramp; ETA after the window', raisedAt: iso(-40 * MIN) };
    record.timeline = [
      event(id, 1, record.bookedAt, 'booked', 'Load booked'),
      event(id, 2, record.dispatchedAt, 'dispatched', `Dispatched to ${first} ${last}`),
      event(id, 3, record.stops[0].arrivedAt, 'arrived', `Arrived at ${shipper}`, `${first} ${last}`, pickupStop),
      event(id, 4, departed, 'departed', `Departed ${o.city}, ${o.state} loaded`, `${first} ${last}`, pickupStop),
    ];
    const near = city ?? nearestCity(pos);
    location = {
      lat: +pos.lat.toFixed(5), lng: +pos.lng.toFixed(5), city: near.city, state: near.state,
      updatedAt: iso(-int(1, 6) * MIN), speedMph: int(52, 66), engineState: 'on',
      headingDegrees: plan.verdict === 'off_route' ? 35 : headingDegrees(pos, d),
    };
  } else {
    // Not yet rolling with freight (or about to deliver).
    const statusByScenario = { at_pickup: 'at_pickup', loaded: 'loaded', at_delivery: 'at_delivery', dispatched: 'dispatched', assigned_next: 'assigned' };
    const status = statusByScenario[plan.scenario];
    const transitHours = miles / AVG_MPH + 2;
    let pickupStartMs;
    if (status === 'at_pickup') pickupStartMs = -30 * MIN;
    else if (status === 'loaded') pickupStartMs = -2 * HOUR;
    else if (status === 'at_delivery') pickupStartMs = -(transitHours + 3) * HOUR;
    else if (status === 'dispatched') pickupStartMs = 4 * HOUR;
    else pickupStartMs = days(1) + 3 * HOUR;
    pickupStartMs = Math.round(pickupStartMs / (15 * MIN)) * 15 * MIN;
    const deliveryStartMs = Math.round((pickupStartMs + (transitHours + 3) * HOUR) / (15 * MIN)) * 15 * MIN;
    record = baseLoad({ id, loadNumber, status, o, d, driver, truck, trailer, dispatcher, pickupStart: iso(pickupStartMs), deliveryStart: iso(deliveryStartMs), rate, bookedAt: iso(pickupStartMs - days(1)) });
    const atPickupDone = ['loaded', 'at_delivery'].includes(status);
    record.stops = [
      stop({ id: pickupStop, sequence: 1, kind: 'pickup', place: o, facility: shipper, start: iso(pickupStartMs), end: iso(pickupStartMs + 2 * HOUR),
        status: atPickupDone ? 'completed' : status === 'at_pickup' ? 'in_progress' : 'pending',
        arrivedAt: atPickupDone || status === 'at_pickup' ? iso(pickupStartMs - 10 * MIN) : null,
        departedAt: atPickupDone && status !== 'loaded' ? iso(pickupStartMs + 90 * MIN) : null,
        loadedAt: atPickupDone ? iso(pickupStartMs + 80 * MIN) : null }),
      stop({ id: deliveryStop, sequence: 2, kind: 'delivery', place: d, facility: receiver, start: iso(deliveryStartMs), end: iso(deliveryStartMs + 2 * HOUR),
        status: status === 'at_delivery' ? 'in_progress' : 'pending', arrivedAt: status === 'at_delivery' ? iso(-35 * MIN) : null }),
    ];
    if (status === 'at_delivery') {
      // Re-time the delivery so the arrival sits inside the window.
      record.stops[1].appointmentStartAt = iso(-60 * MIN);
      record.stops[1].appointmentEndAt = iso(60 * MIN);
      record.deliveryAt = record.stops[1].appointmentStartAt;
    }
    record.dispatchedAt = status === 'assigned' ? null : record.bookedAt;
    record.documents = [doc(id, 'rate_confirmation', 'Rate confirmation', record.bookedAt, `${dispatcher.first} ${dispatcher.last}`)];
    if (atPickupDone) record.documents.push(doc(id, 'bol', 'Bill of lading', iso(pickupStartMs + 85 * MIN)));
    record.timeline = [event(id, 1, record.bookedAt, 'booked', 'Load booked')];
    const here = status === 'at_delivery' ? d : o;
    const offset = status === 'dispatched' || status === 'assigned' ? null : { lat: here.lat + 0.01, lng: here.lng - 0.01 };
    if (offset) {
      location = {
        lat: +offset.lat.toFixed(5), lng: +offset.lng.toFixed(5), city: here.city, state: here.state,
        updatedAt: iso(-int(2, 9) * MIN), speedMph: 0, engineState: 'idle', headingDegrees: 0,
      };
    }
    truckStatus = status === 'assigned' ? 'available' : status === 'dispatched' ? 'active' : 'driving';
    driverStatus = status === 'assigned' ? 'available' : 'dispatched';
    if (status === 'dispatched') {
      // Deadheading to the shipper from home.
      location = { lat: +(o.lat - 0.4).toFixed(5), lng: +(o.lng + 0.5).toFixed(5), city: o.city, state: o.state, updatedAt: iso(-3 * MIN), speedMph: 61, engineState: 'on', headingDegrees: headingDegrees({ lat: o.lat - 0.4, lng: o.lng + 0.5 }, o) };
    }
  }
  return { record, location, truckStatus, driverStatus };
}

function nearestCity(pos) {
  let best = null;
  let bestD = Infinity;
  for (const c of Object.values(C)) {
    const dist = haversineMiles(pos, c);
    if (dist < bestD) {
      bestD = dist;
      best = c;
    }
  }
  // "near" when the truck is between cities: the product only shows city/state, keep it honest.
  return bestD < 60 ? best : { city: `${Math.round(bestD)} mi from ${best.city}`, state: best.state };
}

function buildHistoricLoads({ driverRows, truckRows, trailerRows, nextLoadNumber }) {
  const out = [];
  const lanes = [
    ['CHI', 'DAL'], ['ATL', 'CHI'], ['DAL', 'MEM'], ['IND', 'ATL'], ['MCI', 'DEN'], ['CMH', 'CLT'], ['HOU', 'ATL'], ['STL', 'IND'],
    ['DEN', 'PHX'], ['JAX', 'BNA'], ['HAR', 'CHI'], ['OKC', 'DAL'], ['SDF', 'HAR'], ['MEM', 'HOU'], ['LAX', 'PHX'], ['DTW', 'CMH'],
    ['ATL', 'JAX'], ['CHI', 'MCI'], ['DAL', 'LRD'], ['BNA', 'STL'], ['CLT', 'ATL'], ['PHX', 'DEN'], ['EWR', 'HAR'], ['IND', 'DTW'],
  ];
  // kinds: 3 delivered missing POD, 9 delivered complete, 6 closed, 2 booked (no driver), 1 cancelled, 1 tonu = 22
  const kinds = [
    'missing_pod', 'missing_pod', 'missing_pod',
    ...Array(9).fill('delivered'), ...Array(6).fill('closed'), 'booked', 'booked', 'cancelled', 'tonu',
  ];
  kinds.forEach((kind, n) => {
    const [ok, dk] = lanes[n % lanes.length];
    const o = C[ok];
    const d = C[dk];
    const loadNumber = kind === 'booked' ? null : nextLoadNumber();
    const num = loadNumber ?? nextLoadNumber();
    const id = `lod_swd_${num.slice(2)}`;
    const k = n % 25;
    const driver = kind === 'booked' ? null : driverRows[k];
    const truck = kind === 'booked' ? null : truckRows[k];
    const trailer = kind === 'booked' ? null : trailerRows[k];
    const dispatcher = DISPATCHERS[n % DISPATCHERS.length];
    const miles = roadMiles(o, d);
    const transitMs = (miles / AVG_MPH + 2) * HOUR;
    const rate = rateFor(o, d);
    let deliveredAgoMs;
    if (kind === 'missing_pod') deliveredAgoMs = days(2 + n); // 2, 3, 4 days ago
    else if (kind === 'delivered') deliveredAgoMs = days(1 + (n % 5)) + int(1, 10) * HOUR;
    else if (kind === 'closed') deliveredAgoMs = days(8 + n) ;
    else if (kind === 'booked') deliveredAgoMs = -days(2 + (n % 2)) - 6 * HOUR; // future
    else deliveredAgoMs = days(3 + n % 4);
    const deliveryStartMs = Math.round((-deliveredAgoMs - 45 * MIN) / (15 * MIN)) * 15 * MIN;
    const pickupStartMs = Math.round((deliveryStartMs - transitMs - 2 * HOUR) / (15 * MIN)) * 15 * MIN;
    const status = kind === 'missing_pod' ? 'delivered' : kind;
    const rec = baseLoad({ id, loadNumber: num, status, o, d, driver, truck, trailer, dispatcher, pickupStart: iso(pickupStartMs), deliveryStart: iso(deliveryStartMs), rate, bookedAt: iso(pickupStartMs - days(1)) });
    const done = ['delivered', 'closed'].includes(status);
    const shipper = pick(SHIPPERS);
    const receiver = pick(SHIPPERS.filter((s) => s !== shipper));
    rec.stops = [
      stop({ id: `stp_${id}_1`, sequence: 1, kind: 'pickup', place: o, facility: shipper, start: iso(pickupStartMs), end: iso(pickupStartMs + 2 * HOUR),
        status: done ? 'completed' : status === 'cancelled' || status === 'tonu' ? 'cancelled' : 'pending',
        arrivedAt: done ? iso(pickupStartMs - 15 * MIN) : null, departedAt: done ? iso(pickupStartMs + 75 * MIN) : null, loadedAt: done ? iso(pickupStartMs + 60 * MIN) : null }),
      stop({ id: `stp_${id}_2`, sequence: 2, kind: 'delivery', place: d, facility: receiver, start: iso(deliveryStartMs), end: iso(deliveryStartMs + 2 * HOUR),
        status: done ? 'completed' : status === 'cancelled' || status === 'tonu' ? 'cancelled' : 'pending',
        arrivedAt: done ? iso(deliveryStartMs + 10 * MIN) : null, departedAt: done ? iso(-deliveredAgoMs) : null }),
    ];
    if (done) {
      rec.deliveredAt = iso(-deliveredAgoMs);
      rec.dispatchedAt = rec.bookedAt;
      rec.documents = [doc(id, 'rate_confirmation', 'Rate confirmation', rec.bookedAt, `${dispatcher.first} ${dispatcher.last}`), doc(id, 'bol', 'Bill of lading', iso(pickupStartMs + 70 * MIN))];
      if (kind !== 'missing_pod') rec.documents.push(doc(id, 'pod', 'Proof of delivery (signed BOL)', iso(-deliveredAgoMs + 20 * MIN)));
      rec.financials = null;
      rec.timeline = [
        event(id, 1, rec.bookedAt, 'booked', 'Load booked'),
        event(id, 2, rec.dispatchedAt, 'dispatched', `Dispatched to ${driver.first_name} ${driver.last_name}`),
        event(id, 3, rec.deliveredAt, 'delivered', `Delivered at ${receiver}`, `${driver.first_name} ${driver.last_name}`, `stp_${id}_2`),
      ];
      if (kind === 'missing_pod') {
        rec.notes = [{ id: `lnt_${id}_1`, kind: 'internal', body: 'Driver says the receiver kept the signed copy; asked for a photo.', authorName: `${dispatcher.first} ${dispatcher.last}`, at: iso(-deliveredAgoMs + 3 * HOUR), pinned: false }];
      }
    } else if (status === 'tonu') {
      rec.charges.push({ id: `chg_${id}_tonu`, type: 'tonu', description: 'Truck ordered, not used', amount: 250, billable: true, payableToDriver: true, status: 'accepted' });
      rec.documents = [doc(id, 'rate_confirmation', 'Rate confirmation', rec.bookedAt, `${dispatcher.first} ${dispatcher.last}`), doc(id, 'tonu', 'Broker TONU confirmation', iso(pickupStartMs + 30 * MIN), 'June Halvorsen')];
    } else {
      rec.documents = [doc(id, 'rate_confirmation', 'Rate confirmation', rec.bookedAt, `${dispatcher.first} ${dispatcher.last}`)];
    }
    out.push(rec);
  });
  return out;
}

// ------------------------------------------------------------------------------------- compliance

/**
 * Requirements whose term runs from the report date (packages/shared/src/compliance/catalog.ts):
 * the engine reads the expiry as min(typed expiry, issued + months), so the issue date is set to
 * exactly one term before the expiry we want shown.
 */
const VALIDITY_MONTHS = { mvr_review: 6, psp_review: 6, annual_inspection: 12, clearinghouse_query: 12, trailer_annual_inspection: 12 };
function issuedFor(code, expiresOn) {
  if (!expiresOn) return null;
  const d = new Date(`${expiresOn}T12:00:00Z`);
  const months = VALIDITY_MONTHS[code];
  if (months) d.setUTCMonth(d.getUTCMonth() - months);
  else d.setUTCDate(d.getUTCDate() - 365);
  const issued = d.toISOString().slice(0, 10);
  return issued > etDate() ? etDate(-days(1)) : issued;
}

function buildCompliance({ driverRows, truckRows, trailerRows }) {
  const items = [];
  const docs = [];
  let n = 0;
  const add = ({ scope, entityId, label, code, expiresOn, missing = false, verified = true }) => {
    n += 1;
    const itemId = `qi_swd_${pad(n, 4)}`;
    let documentId = null;
    if (!missing) {
      documentId = `cdoc_swd_${pad(n, 4)}`;
      docs.push({
        id: documentId, company_id: COMPANY_ID, owner_type: scope, owner_id: entityId, owner_label: label, requirement_code: code,
        title: `${code.replace(/_/g, ' ')} - ${label}`, file_name: `${code}-${entityId}.pdf`, content_type: 'application/pdf', size_bytes: int(60_000, 400_000),
        storage_key: null, issued_on: issuedFor(code, expiresOn), expires_on: expiresOn, status: verified ? 'verified' : 'pending_review',
        source: 'staff', uploaded_at: at(-days(int(20, 300))), uploaded_by: 'Helen Brooks', verified_at: verified ? at(-days(int(1, 19))) : null, verified_by: verified ? 'Helen Brooks' : null,
      });
    }
    items.push({
      id: itemId, company_id: COMPANY_ID, requirement_code: code, scope, entity_id: entityId, entity_label: label, document_id: documentId,
      issued_on: !missing ? issuedFor(code, expiresOn) : null, expires_on: missing ? null : expiresOn,
      verified_at: !missing && verified ? at(-days(int(1, 19))) : null, verified_by: !missing && verified ? 'Helen Brooks' : null,
    });
  };
  for (const d of driverRows) {
    const label = `${d.first_name} ${d.last_name}`;
    add({ scope: 'driver', entityId: d.id, label, code: 'cdl', expiresOn: d.cdl_expires_on });
    add({ scope: 'driver', entityId: d.id, label, code: 'medical_card', expiresOn: d.medical_card_expires_on });
    add({ scope: 'driver', entityId: d.id, label, code: 'mvr_review', expiresOn: d.id === 'drv_swd_10' ? etDate(days(11)) : etDate(days(int(40, 170))) });
    add({ scope: 'driver', entityId: d.id, label, code: 'psp_review', expiresOn: etDate(days(int(40, 170))) });
    add({ scope: 'driver', entityId: d.id, label, code: 'clearinghouse_query', expiresOn: etDate(days(int(60, 350))) });
    add({ scope: 'driver', entityId: d.id, label, code: 'pre_employment_drug_test', expiresOn: null });
  }
  for (const t of truckRows) {
    const label = `Truck ${t.unit_number}`;
    const u = t.unit_number;
    add({ scope: 'truck', entityId: t.id, label, code: 'registration', expiresOn: u === '1112' ? etDate(days(12)) : u === '1119' ? etDate(-days(2)) : etDate(days(int(90, 340))) });
    add({ scope: 'truck', entityId: t.id, label, code: 'annual_inspection', expiresOn: u === '1107' ? etDate(days(6)) : etDate(days(int(60, 350))) });
    add({ scope: 'truck', entityId: t.id, label, code: 'insurance_cab_card', expiresOn: etDate(days(int(100, 300))), missing: u === '1118' || u === '1123' });
    add({ scope: 'truck', entityId: t.id, label, code: 'ifta_license', expiresOn: `${etDate().slice(0, 4)}-12-31` });
    add({ scope: 'truck', entityId: t.id, label, code: 'ny_hut_sticker', expiresOn: etDate(days(int(200, 600))) });
  }
  for (const tr of trailerRows) {
    const label = `Trailer ${tr.unit_number}`;
    add({ scope: 'trailer', entityId: tr.id, label, code: 'trailer_registration', expiresOn: tr.unit_number === '5309' ? etDate(-days(4)) : etDate(days(int(90, 340))) });
    add({ scope: 'trailer', entityId: tr.id, label, code: 'trailer_annual_inspection', expiresOn: etDate(days(int(45, 350))) });
  }
  add({ scope: 'company', entityId: COMPANY_ID, label: COMPANY_NAME, code: 'insurance_filing', expiresOn: etDate(days(24)) });
  add({ scope: 'company', entityId: COMPANY_ID, label: COMPANY_NAME, code: 'operating_authority', expiresOn: etDate(days(400)) });
  return { items, docs };
}

// ------------------------------------------------------------------------------------- fuel

const STATIONS = [
  { brand: "Pilot", name: 'Travel Center #4', },
  { brand: "Love's", name: 'Travel Stop #212' },
  { brand: 'TA', name: 'Petro #88' },
  { brand: 'Flying J', name: 'Travel Plaza #613' },
];
function buildFuel({ truckRows, driverRows, loadRecords }) {
  const tx = [];
  let n = 0;
  const make = (t, d, atMs, place, gallons, flags = [], status = 'verified', loadId = null, odometer = null) => {
    n += 1;
    const price = +between(3.59, 4.09).toFixed(3);
    const st = pick(STATIONS);
    tx.push({
      id: `fuel_swd_${pad(n, 4)}`, truckId: t.id, unitNumber: t.unit_number, driverId: d.id, driverName: `${d.first_name} ${d.last_name}`, loadId,
      at: iso(atMs), station: { brand: st.brand, name: `${st.brand} ${st.name}`, city: place.city, state: place.state },
      product: 'diesel', gallons: +gallons.toFixed(1), pricePerGallon: price, amount: +(gallons * price).toFixed(2),
      odometer: odometer ?? Math.round(t.odometer + atMs / HOUR * 38), cardLast4: pad(4100 + truckRows.indexOf(t), 4), anomalyFlags: flags, status,
    });
  };
  truckRows.forEach((t, i) => {
    const d = driverRows[i];
    const fills = 2 + (i % 3);
    for (let k = 0; k < fills; k += 1) {
      const place = pick(Object.values(C));
      const load = loadRecords.find((l) => l.truckId === t.id);
      make(t, d, -days(k * 3 + 1 + (i === 2 || i === 19 ? 2 : 0)) - int(1, 20) * HOUR, place, between(85, 165), [], 'verified', load?.id ?? null);
    }
  });
  // Anomaly 1: unit 1103 fueled twice within 40 minutes, 75 miles apart is impossible -> same station, two cards swipes.
  const t3 = truckRows[2];
  const d3 = driverRows[2];
  const o3 = t3.odometer - 1100;
  make(t3, d3, -days(1) - 6 * HOUR, C.MEM, 142.6, [], 'verified', null, o3);
  make(t3, d3, -days(1) - 6 * HOUR + 38 * MIN, C.MEM, 131.9, [], 'verified', null, o3 + 4);
  // Anomaly 2: unit 1120 fueled twice within 52 minutes; the second fill is more than the tanks hold after the first.
  const t20 = truckRows[19];
  const d20 = driverRows[19];
  const o20 = t20.odometer - 2300;
  make(t20, d20, -days(2) - 3 * HOUR, C.PHX, 168.4, [], 'verified', null, o20);
  make(t20, d20, -days(2) - 3 * HOUR + 52 * MIN, C.PHX, 151.7, [], 'verified', null, o20 + 11);
  // Newest first, as the ledger keeps it.
  return tx.sort((a, b) => (a.at < b.at ? 1 : -1));
}

// ------------------------------------------------------------------------------------- hiring

function buildHiring() {
  const leads = [];
  const cases = [];
  const events = [];
  const reviews = [];
  const checks = [];
  let leadN = 0;
  const recruiter = STAFF.find((s) => s.id === 'emp_swd_tara');
  const lead = ({ first, last, status, createdAgoDays, contactedAgoDays = null, source = 'facebook', state = 'IL', years = 3, caseId = null, applicantId = null, notes = null }) => {
    leadN += 1;
    const id = `lead_swd_${pad(leadN, 3)}`;
    leads.push({
      id, company_id: COMPANY_ID, lead_number: `LD-${pad(500 + leadN, 4)}`, first_name: first, last_name: last,
      phone: `(773) 555-01${pad(40 + leadN, 2)}`, email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`, cdl_class: 'A', state,
      years_experience: years, source, recruiter_employee_id: recruiter.id, notes, status,
      hiring_case_id: caseId, applicant_id: applicantId, created_at: at(-days(createdAgoDays)), contacted_at: contactedAgoDays !== null ? at(-days(contactedAgoDays)) : null,
      prequalified_at: status === 'prequalified' || status === 'converted' ? at(-days(Math.max(0, (contactedAgoDays ?? createdAgoDays) - 0.5))) : null,
      converted_at: status === 'converted' ? at(-days(Math.max(0, (contactedAgoDays ?? createdAgoDays) - 1))) : null,
      updated_at: at(-days(contactedAgoDays ?? createdAgoDays)),
    });
    return id;
  };
  const kase = ({ first, last, state, sinceDays, openedDays, path, safety = null, mvr = null, psp = null, endReason = null, applicantId = null, driverId = null }) => {
    const caseId = `hcase_swd_${pad(cases.length + 1, 3)}`;
    cases.push({
      id: caseId, company_id: COMPANY_ID, applicant_id: applicantId, driver_id: driverId, candidate_name: `${first} ${last}`, state, state_since: at(-days(sinceDays)), opened_at: at(-days(openedDays)),
      // The Recruiting board dates a step from the record's last change; keep it at the step's start.
      created_at: at(-days(openedDays)), updated_at: at(-days(sinceDays)),
      recruiter_id: recruiter.id, recruiter_name: `${recruiter.first} ${recruiter.last}`,
      closed_at: ['disqualified', 'withdrawn'].includes(state) ? at(-days(sinceDays)) : null, end_reason: endReason,
      hired_at: state === 'hired' ? at(-days(sinceDays)) : null,
      safety_requested_at: safety ? at(-days(sinceDays)) : null, safety_requested_by: safety ? 'Tara Quinn' : null,
      onboarding_started_at: ['offer', 'orientation', 'hired'].includes(state) ? at(-days(sinceDays + 1)) : null,
      onboarding_started_by: ['offer', 'orientation', 'hired'].includes(state) ? 'Tara Quinn' : null,
    });
    let prev = null;
    path.forEach((to, k) => {
      events.push({
        id: `hse_${caseId}_${k + 1}`, company_id: COMPANY_ID, case_id: caseId, from_state: prev, to_state: to,
        at: at(-days(openedDays - ((openedDays - sinceDays) * k) / Math.max(1, path.length - 1))), by_name: 'Tara Quinn', source: 'manual',
      });
      prev = to;
    });
    if (safety) {
      const reviewId = `hsr_${caseId}`;
      reviews.push({ id: reviewId, company_id: COMPANY_ID, hiring_case_id: caseId, status: safety, opened_at: at(-days(sinceDays)), opened_by_user_id: ADMIN_USER_ID, opened_by_name: 'Tara Quinn', request_note: 'MVR and PSP ordered with the consent.' });
      for (const [kind, st] of [['mvr', mvr], ['psp', psp], ['clearinghouse_limited', 'received']]) {
        if (!st) continue;
        checks.push({
          id: `hsc_${caseId}_${kind}`, company_id: COMPANY_ID, review_id: reviewId, hiring_case_id: caseId, kind, status: st, provider: 'manual',
          requested_at: at(-days(sinceDays)), requested_by_user_id: ADMIN_USER_ID, requested_by_name: 'Tara Quinn',
          pending_at: st === 'pending' || st === 'received' ? at(-days(Math.max(0, sinceDays - 0.5))) : null, pending_by_name: st === 'pending' || st === 'received' ? 'Tara Quinn' : null,
          received_at: st === 'received' ? at(-days(Math.max(0, sinceDays - 1))) : null, received_by_name: st === 'received' ? 'Helen Brooks' : null,
          note: st === 'requested' ? 'Ordered; provider has not returned it yet.' : st === 'pending' ? 'Waiting on the provider.' : null,
        });
      }
    }
    return caseId;
  };

  // Leads that never became a case.
  lead({ first: 'Andre', last: 'Fontaine', status: 'new', createdAgoDays: 0.2, source: 'website' });
  lead({ first: 'Brody', last: 'Kessler', status: 'new', createdAgoDays: 3, source: 'facebook', notes: 'Applied Saturday night; nobody has called.' }); // stuck: new > 1 day
  lead({ first: 'Cyrus', last: 'Madden', status: 'no_answer', createdAgoDays: 2, contactedAgoDays: 1.5, source: 'job_board' });
  lead({ first: 'Dmitri', last: 'Volkov', status: 'contacted', createdAgoDays: 7, contactedAgoDays: 6, source: 'referral', years: 8, notes: 'Wants home every weekend; follow-up never set.' }); // stuck: contacted > 3 days
  lead({ first: 'Elias', last: 'Grant', status: 'prequalified', createdAgoDays: 2, contactedAgoDays: 1, source: 'instagram', years: 5 });

  // Candidates.
  const c1 = kase({ first: 'Felix', last: 'Navarro', state: 'safety_review', sinceDays: 4, openedDays: 9, path: ['lead', 'prequalified', 'application', 'safety_review'], safety: 'preparing', mvr: 'requested', psp: 'pending' }); // stuck, waiting on MVR+PSP
  lead({ first: 'Felix', last: 'Navarro', status: 'converted', createdAgoDays: 10, contactedAgoDays: 9.5, source: 'job_board', years: 6, caseId: c1 });
  const c2 = kase({ first: 'Gideon', last: 'Hart', state: 'safety_review', sinceDays: 1, openedDays: 5, path: ['lead', 'prequalified', 'application', 'safety_review'], safety: 'pending', mvr: 'received', psp: 'requested' }); // waiting on PSP
  lead({ first: 'Gideon', last: 'Hart', status: 'converted', createdAgoDays: 6, contactedAgoDays: 5.5, source: 'referral', years: 11, caseId: c2 });
  const c3 = kase({ first: 'Hugo', last: 'Lambert', state: 'safety_review', sinceDays: 3, openedDays: 8, path: ['lead', 'prequalified', 'safety_review'], safety: 'preparing', mvr: 'pending', psp: 'pending' }); // stuck
  lead({ first: 'Hugo', last: 'Lambert', status: 'converted', createdAgoDays: 9, contactedAgoDays: 8, source: 'facebook', years: 2, caseId: c3 });
  const c4 = kase({ first: 'Ivan', last: 'Rusu', state: 'application', sinceDays: 5, openedDays: 6, path: ['lead', 'prequalified', 'application'] }); // stuck: application > 3 days
  lead({ first: 'Ivan', last: 'Rusu', status: 'converted', createdAgoDays: 7, contactedAgoDays: 6.5, source: 'phone_call', years: 4, caseId: c4 });
  const c5 = kase({ first: 'Jonah', last: 'Whitley', state: 'offer', sinceDays: 1, openedDays: 12, path: ['lead', 'prequalified', 'application', 'safety_review', 'offer'], safety: 'approved', mvr: 'received', psp: 'received' });
  lead({ first: 'Jonah', last: 'Whitley', status: 'converted', createdAgoDays: 13, contactedAgoDays: 12.5, source: 'referral', years: 9, caseId: c5 });
  const c6 = kase({ first: 'Kofi', last: 'Mensah', state: 'orientation', sinceDays: 2, openedDays: 15, path: ['lead', 'prequalified', 'application', 'safety_review', 'offer', 'orientation'], safety: 'approved', mvr: 'received', psp: 'received' });
  lead({ first: 'Kofi', last: 'Mensah', status: 'converted', createdAgoDays: 16, contactedAgoDays: 15.5, source: 'website', years: 7, caseId: c6 });
  const c7 = kase({ first: 'Leon', last: 'Brandt', state: 'disqualified', sinceDays: 6, openedDays: 14, path: ['lead', 'prequalified', 'application', 'safety_review', 'disqualified'], safety: 'declined', mvr: 'received', psp: 'received', endReason: 'safety_declined' });
  lead({ first: 'Leon', last: 'Brandt', status: 'converted', createdAgoDays: 15, contactedAgoDays: 14.5, source: 'facebook', years: 3, caseId: c7 });
  const c8 = kase({ first: 'Milo', last: 'Draper', state: 'hired', sinceDays: 3, openedDays: 21, path: ['lead', 'prequalified', 'application', 'safety_review', 'offer', 'orientation', 'hired'], safety: 'approved', mvr: 'received', psp: 'received' });
  lead({ first: 'Milo', last: 'Draper', status: 'converted', createdAgoDays: 22, contactedAgoDays: 21.5, source: 'referral', years: 12, caseId: c8 });

  // Jordan Sampleton (fictional): DOT application submitted, driver file reserved, CDL not uploaded
  // yet. The demo uploads docs/hackathon/samples/cdl-sample-jordan-sampleton.png on the Qualification
  // file view; the application says born 1988-03-15, the card 1988-03-14, so Muse's reading flags it.
  // An applicant record stands behind the case, so the card opens /hr/recruiting/apl_swd_jordan.
  const applicantId = 'apl_swd_jordan';
  const applicantRows = [{
    id: applicantId, company_id: COMPANY_ID, applicant_number: 'CAND-1001', job_opening_id: null,
    first_name: 'Jordan', last_name: 'Sampleton', email: 'jordan.sampleton@example.com', phone: '(815) 555-0162',
    position: 'Driver', department: 'dispatch', location: 'Joliet, IL', source: 'website', stage: 'applied',
    assigned_recruiter_employee_id: recruiter.id, driver_type: 'company', applied_on: etDate(-days(3)),
    notes: null, created_at: at(-days(3)), updated_at: at(-days(1)),
  }];
  // The id DriversService.reserveDriverIdFor gives the first candidate of this company (next number
  // above 2000, company-prefixed because plain drv_2001 may exist in another company). No drivers row.
  const c9 = kase({ first: 'Jordan', last: 'Sampleton', state: 'application', sinceDays: 1, openedDays: 3, path: ['lead', 'prequalified', 'application'], applicantId, driverId: 'drv_silkway_demo_2001' });
  lead({ first: 'Jordan', last: 'Sampleton', status: 'converted', createdAgoDays: 4, contactedAgoDays: 3.5, source: 'website', years: 9, caseId: c9, applicantId });
  leads[leads.length - 1].phone = '(815) 555-0162';
  const tenYearsBack = `${Number(etDate().slice(0, 4)) - 12}-06-01`;
  const dotApplications = [{
    id: 'hdot_swd_jordan', company_id: COMPANY_ID, hiring_case_id: c9, applicant_id: applicantId, status: 'submitted',
    form: {
      legalFirstName: 'Jordan', legalMiddleName: 'Lee', legalLastName: 'Sampleton', dateOfBirth: '1988-03-15',
      addresses: [{ street: '418 Maple Bend Dr', city: 'Joliet', state: 'IL', zip: '60435', from: `${Number(etDate().slice(0, 4)) - 11}-04-01`, to: null }],
      licenses: [{ state: 'IL', number: 'S530-4412-8890', licenseClass: 'A', endorsements: ['N', 'T'], expiresOn: '2028-06-01' }],
      employment: [{
        kind: 'employer', employer: 'Northfield Demo Carriers', address: 'Joliet, IL', phone: '(815) 555-0190', contactName: 'Safety office',
        position: 'OTR driver', from: tenYearsBack, to: null, reasonForLeaving: null, droveCmv: true, dotRegulated: true, subjectToDrugTesting: true,
      }],
      accidents: [], convictions: [], licenseDeniedOrRevoked: false, licenseDeniedOrRevokedDetail: null,
      certifiedName: 'Jordan Lee Sampleton', certifiedOn: etDate(-days(1)),
    },
    submitted_at: at(-days(1)), submitted_by: 'Tara Quinn', created_at: at(-days(3)), updated_at: at(-days(1)),
  }];

  return { leads, cases, events, reviews, checks, applicantRows, dotApplications };
}

// ------------------------------------------------------------------------------------- fleet work

function buildFleetWork({ truckRows, driverRows }) {
  const workOrders = [];
  const lines = [];
  const defects = [];
  const inspections = [];
  let wo = 1040;
  const vendors = ['Lakeside Truck & Diesel', 'Interstate Fleet Repair', 'Prairie Truck Center'];
  PLAN.forEach((plan, i) => {
    if (plan.scenario !== 'shop') return;
    const t = truckRows[i];
    wo += 1;
    const id = `wo_swd_${wo}`;
    workOrders.push({
      id, company_id: COMPANY_ID, number: `RO-2026-${wo}`, asset_type: 'truck', unit_id: t.id, unit_number: t.unit_number, status: 'in_shop',
      shop_stage: plan.wo.stage, work_type: plan.wo.system === 'engine' ? 'engine' : 'repair', title: plan.wo.title, shop_in_at: at(-days(1 + (i % 3)) - 4 * HOUR),
      odometer: t.odometer, vendor_name: pick(vendors), estimated_cost: String(int(900, 6400)), eta: at(days(1 + (i % 2))),
      responsible_name: 'Sam Ortega', entered_via: 'create_work_order', created_by: 'Sam Ortega', notes: null,
    });
    lines.push({ id: `wol_${id}_1`, company_id: COMPANY_ID, work_order_id: id, system_code: plan.wo.system, line_kind: 'repair', description: plan.wo.title });
  });
  // Completed repairs in the last month.
  [[1, 'brakes', 'Brake shoes and drums, drive axles', 2140], [6, 'tires', 'Two steer tires replaced', 1380], [9, 'electrical', 'Alternator replaced', 860], [17, 'engine', 'Oil change and PM-A service', 465]].forEach(([i, system, title, total], k) => {
    const t = truckRows[i];
    wo += 1;
    const id = `wo_swd_${wo}`;
    const inAt = at(-days(6 + k * 6));
    workOrders.push({
      id, company_id: COMPANY_ID, number: `RO-2026-${wo}`, asset_type: 'truck', unit_id: t.id, unit_number: t.unit_number, status: 'completed',
      work_type: system === 'engine' ? 'oil_change' : 'repair', title, shop_in_at: inAt, completed_at: new Date(inAt.getTime() + 9 * HOUR),
      downtime_minutes: 9 * 60, odometer: t.odometer - int(3000, 9000), vendor_name: pick(vendors), invoice_number: `INV-${int(20000, 89999)}`,
      invoice_total: String(total), total: String(total), invoice_date: etDate(-days(6 + k * 6)), entered_via: 'record_repair', created_by: 'Sam Ortega',
    });
    lines.push({ id: `wol_${id}_1`, company_id: COMPANY_ID, work_order_id: id, system_code: system, line_kind: 'repair', description: title, total_amount: String(total) });
  });

  // This week's PTI: most received, a few awaiting / late.
  const week = etMonday();
  truckRows.forEach((t, i) => {
    const d = driverRows[i];
    const plan = PLAN[i];
    const receipt = plan.scenario === 'shop' ? 'exempt_in_shop' : [7, 13].includes(i) ? 'late' : [11, 23, 24].includes(i) ? 'awaiting' : 'received';
    inspections.push({
      id: `pti_swd_${t.unit_number}_${week}`, company_id: COMPANY_ID, unit_id: t.id, unit_number: t.unit_number, week_start: week, due_at: week,
      driver_id: d.id, driver_name: `${d.first_name} ${d.last_name}`, driver_type: d.driver_type, dispatcher_id: d.dispatcher_id, dispatcher_name: d.dispatcher_name,
      receipt_status: receipt, received_at: receipt === 'received' ? at(-days(int(0, 1)) - int(1, 10) * HOUR) : null, source: receipt === 'received' ? 'driver_app' : null,
      review_state: receipt === 'received' ? (i % 3 === 0 ? 'unreviewed' : 'reviewed') : 'unreviewed',
    });
  });
  const defect = (i, component, componentName, description, severity, state = 'open', woIdx = null) => {
    const t = truckRows[i];
    const n = defects.length + 1;
    const workOrder = woIdx !== null ? workOrders.find((w) => w.unit_id === t.id && w.status === 'in_shop') : null;
    defects.push({
      id: `pdf_swd_${pad(n, 3)}`, company_id: COMPANY_ID, defect_number: `DEF-${pad(300 + n, 4)}`, unit_id: t.id, unit_number: t.unit_number,
      component, component_name: componentName, description, severity, state: workOrder ? 'in_repair' : state,
      found_on_inspection_id: `pti_swd_${t.unit_number}_${week}`, work_order_id: workOrder?.id ?? null, work_order_number: workOrder?.number ?? null,
      created_by: 'Driver app', created_at: at(-days(int(1, 4))),
    });
  };
  defect(4, 'brakes', 'Brakes', 'Air leak at axle 2 brake chamber, pushrod travel out of spec', 'oos_risk', 'open', true);
  defect(20, 'leaks_fluids', 'Leaks / fluids', 'Coolant dripping under the water pump after a 30 min idle', 'replace_now', 'open', true);
  defect(8, 'drive_tyres', 'Tires / wheels', 'Drive tire, position 3 outer, tread at 4/32', 'replace_soon');
  defect(15, 'lights_reflectors', 'Lights', 'Trailer right marker lamp out', 'monitor');
  defect(2, 'body_mudflaps', 'Body', 'Left mud flap torn', 'monitor');
  return { workOrders, lines, defects, inspections };
}

// ------------------------------------------------------------------------------------- write

async function wipeCompany(tx) {
  // Every table with a company_id column, retried until foreign keys stop blocking.
  const tables = (await tx`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'company_id' and table_name <> 'companies'
  `).map((r) => r.table_name);
  let pending = tables;
  for (let pass = 0; pass < 12 && pending.length; pass += 1) {
    const failed = [];
    for (const t of pending) {
      try {
        await tx.savepoint((sp) => sp`delete from ${sp(t)} where company_id = ${COMPANY_ID}`);
      } catch {
        failed.push(t);
      }
    }
    pending = failed;
  }
  if (pending.length) throw new Error(`could not clear: ${pending.join(', ')}`);
  await tx`delete from app_state where key like ${`t.${COMPANY_ID}.%`}`;
}

async function main() {
  const sql = postgres(url, { max: 1, onnotice: () => {} });
  try {
    const [hasSchema] = await sql`select to_regclass('public.loads') as t`;
    if (!hasSchema?.t) throw new Error('No schema here. Start the API once against this database (it migrates on boot), then seed.');
    const [role] = await sql`select id from roles where id = 'rol_administrator'`;
    if (!role) throw new Error('rol_administrator is missing. Start the API once (it syncs roles on boot), then seed.');
    const [driverRole] = await sql`select id from roles where id = ${DRIVER_ROLE_ID}`;
    if (!driverRole) throw new Error(`${DRIVER_ROLE_ID} is missing. Start the API once (it syncs roles on boot), then seed.`);

    const world = buildRows();

    if (positionsOnly) {
      const [co] = await sql`select id from companies where id = ${COMPANY_ID}`;
      if (!co) throw new Error('The demo company is not there yet; run the full seed first.');
      await sql.begin(async (tx) => {
        for (const t of world.truckRows) await tx`update trucks set location = ${tx.json(t.location)}, telematics_synced_at = now(), updated_at = now() where id = ${t.id} and company_id = ${COMPANY_ID}`;
        for (const l of world.loadRecords) await tx`update loads set record = ${tx.json(l)}, updated_at = now() where id = ${l.id} and company_id = ${COMPANY_ID}`;
      });
      console.log(`positions and load times refreshed for ${world.truckRows.length} trucks, ${world.loadRecords.length} loads`);
      return;
    }

    const compliance = buildCompliance(world);
    const fuel = buildFuel(world);
    const hiring = buildHiring();
    const fleet = buildFleetWork(world);
    const salt = randomBytes(16);
    const passwordHash = `scrypt$${salt.toString('hex')}$${(await scrypt(ADMIN_PASSWORD, salt, 64)).toString('hex')}`;
    // The driver whose load is dispatched (deadheading to an upcoming pickup) gets the app login.
    const appLoad = world.loadRecords.find((l) => l.status === 'dispatched');
    const appDriver = world.driverRows.find((d) => d.id === appLoad?.driverId);
    if (!appLoad || !appDriver) throw new Error('No dispatched load with a driver to give the driver-app login to.');
    const driverEmail = `${appDriver.first_name}.${appDriver.last_name}@silkway-demo.test`.toLowerCase();

    await sql.begin(async (tx) => {
      await wipeCompany(tx);
      await tx`delete from membership_roles where membership_id in (${ADMIN_MEMBERSHIP_ID}, ${DRIVER_MEMBERSHIP_ID})`;
      await tx`delete from memberships where user_id in (${ADMIN_USER_ID}, ${DRIVER_USER_ID})`;
      await tx`delete from auth_sessions where user_id in (${ADMIN_USER_ID}, ${DRIVER_USER_ID})`.catch(() => {});

      await tx`insert into companies (id, name, timezone, week_start) values (${COMPANY_ID}, ${COMPANY_NAME}, 'America/New_York', 'monday')
               on conflict (id) do update set name = excluded.name`;
      await tx`insert into users (id, email, first_name, last_name, password_hash, must_change_password, is_active, appearance)
               values (${ADMIN_USER_ID}, ${ADMIN_EMAIL}, 'Demo', 'Admin', ${passwordHash}, false, true, 'light')
               on conflict (id) do update set password_hash = excluded.password_hash, must_change_password = false, is_active = true`;
      await tx`insert into memberships (id, company_id, user_id, status, is_owner, accepted_at, profile_completed_at)
               values (${ADMIN_MEMBERSHIP_ID}, ${COMPANY_ID}, ${ADMIN_USER_ID}, 'active', true, now(), now())`;
      await tx`insert into membership_roles (membership_id, role_id, assigned_by_name) values (${ADMIN_MEMBERSHIP_ID}, 'rol_administrator', 'Demo seed')`;

      await tx`insert into employees ${tx(STAFF.map((s) => ({
        id: s.id, company_id: COMPANY_ID, employee_number: s.number, first_name: s.first, last_name: s.last,
        work_email: `${s.first.toLowerCase()}.${s.last.toLowerCase()}@silkway-demo.test`, phone: `(312) 555-01${pad(80 + STAFF.indexOf(s), 2)}`,
        department: s.department, position: s.position, location: 'Joliet, IL', hire_date: etDate(-days(400 + STAFF.indexOf(s) * 50)),
        status: 'active', employment_type: 'full_time', timezone: 'America/New_York',
      })))}`;
      await tx`insert into trucks ${tx(world.truckRows.map((t) => ({ ...t, current_driver_id: null, current_trailer_id: null, current_load_id: null })))}`;
      await tx`insert into drivers ${tx(world.driverRows.map((d) => ({ ...d, current_truck_id: null, current_trailer_id: null })))}`;
      await tx`insert into trailers ${tx(world.trailerRows.map((t) => ({ ...t, current_truck_id: null, current_load_id: null })))}`;
      await tx`insert into loads ${tx(world.loadRecords.map((r) => ({
        id: r.id, company_id: COMPANY_ID, load_number: r.loadNumber, status: r.status, dispatcher_id: r.dispatcherId,
        driver_id: r.driverId, truck_id: r.truckId, trailer_id: r.trailerId, is_demo: false, version: 1, record: tx.json(r),
        created_at: new Date(r.createdAt), updated_at: NOW,
      })))}`;
      // Links after every row exists (some are foreign keys).
      for (const t of world.truckRows) await tx`update trucks set current_driver_id = ${t.current_driver_id}, current_trailer_id = ${t.current_trailer_id}, current_load_id = ${t.current_load_id} where id = ${t.id}`;
      for (const d of world.driverRows) await tx`update drivers set current_truck_id = ${d.current_truck_id}, current_trailer_id = ${d.current_trailer_id} where id = ${d.id}`;
      for (const t of world.trailerRows) if (t.current_truck_id) await tx`update trailers set current_truck_id = ${t.current_truck_id}, current_load_id = ${t.current_load_id ?? null} where id = ${t.id}`;
      await tx`insert into truck_driver_assignments ${tx(world.assignmentRows)}`;
      await tx`insert into dispatch_roster ${tx(world.rosterRows)}`;
      await tx`insert into dispatch_roster_assignments ${tx(world.rosterAssignmentRows)}`;
      await tx`insert into dispatch_board_cells ${tx(world.cellRows)}`;

      // Driver-app login, as AppAccessService.give leaves it once accepted: the user (users are not
      // company rows, so upserted like the admin), an active membership linked to the roster
      // driver, and the system driver role. Same demo password; no temporary-password gate.
      await tx`insert into users (id, email, first_name, last_name, phone, password_hash, must_change_password, is_active, appearance)
               values (${DRIVER_USER_ID}, ${driverEmail}, ${appDriver.first_name}, ${appDriver.last_name}, ${appDriver.phone}, ${passwordHash}, false, true, 'light')
               on conflict (id) do update set email = excluded.email, first_name = excluded.first_name, last_name = excluded.last_name, phone = excluded.phone,
                 password_hash = excluded.password_hash, must_change_password = false, is_active = true`;
      await tx`insert into memberships (id, company_id, user_id, driver_id, status, is_owner, invited_at, accepted_at, profile_completed_at)
               values (${DRIVER_MEMBERSHIP_ID}, ${COMPANY_ID}, ${DRIVER_USER_ID}, ${appDriver.id}, 'active', false, now(), now(), now())`;
      await tx`insert into membership_roles (membership_id, role_id, assigned_by_name) values (${DRIVER_MEMBERSHIP_ID}, ${DRIVER_ROLE_ID}, 'Demo seed')`;

      await tx`insert into compliance_documents ${tx(compliance.docs)}`;
      await tx`insert into qualification_items ${tx(compliance.items)}`;

      await tx`insert into app_state (key, value, updated_at) values (${`t.${COMPANY_ID}.ws2-fueltransactions`}, ${JSON.stringify(fuel)}, now())
               on conflict (key) do update set value = excluded.value, updated_at = now()`;

      await tx`insert into applicants ${tx(hiring.applicantRows)}`;
      await tx`insert into hiring_cases ${tx(hiring.cases)}`;
      await tx`insert into hiring_leads ${tx(hiring.leads)}`;
      await tx`insert into hiring_dot_applications ${tx(hiring.dotApplications.map((a) => ({ ...a, form: tx.json(a.form) })))}`;
      await tx`insert into hiring_stage_events ${tx(hiring.events)}`;
      await tx`insert into hiring_safety_reviews ${tx(hiring.reviews)}`;
      await tx`insert into hiring_safety_checks ${tx(hiring.checks)}`;

      // One row at a time: each carries only its own columns, the rest take the table's defaults.
      for (const w of fleet.workOrders) await tx`insert into work_orders ${tx(defined(w))}`;
      for (const l of fleet.lines) await tx`insert into work_order_lines ${tx(defined(l))}`;
      await tx`insert into pti_inspections ${tx(fleet.inspections)}`;
      await tx`insert into pti_defects ${tx(fleet.defects)}`;

      await tx`insert into audit_logs (id, company_id, actor_type, actor_id, actor_name, action, entity_type, entity_id, entity_label, changes, summary)
               values (${`aud_swd_seed_${Date.now()}`}, ${COMPANY_ID}, 'system', 'system:seed-demo', 'Hackathon demo seed', 'create', 'company', ${COMPANY_ID}, ${COMPANY_NAME},
                       ${tx.json([])}, 'Fictional demo data written by scripts/hackathon/seed-demo.mjs (local only)')`;
    });

    const byStatus = {};
    for (const l of world.loadRecords) byStatus[l.status] = (byStatus[l.status] ?? 0) + 1;
    console.log(`Seeded ${COMPANY_NAME} (${COMPANY_ID}) into ${host}:`);
    console.log(`  ${world.truckRows.length} trucks, ${world.trailerRows.length} trailers, ${world.driverRows.length} drivers, ${STAFF.length} staff`);
    console.log(`  ${world.loadRecords.length} loads: ${Object.entries(byStatus).map(([k, v]) => `${k} ${v}`).join(', ')}`);
    console.log(`  ${compliance.items.length} qualification items, ${fuel.length} fuel transactions (2 double-fill anomalies)`);
    console.log(`  ${hiring.leads.length} leads, ${hiring.cases.length} hiring cases, ${fleet.workOrders.length} work orders, ${fleet.defects.length} PTI defects`);
    console.log(`  login: ${ADMIN_EMAIL}`);
    console.log(`  driver app login: ${driverEmail} (${appDriver.first_name} ${appDriver.last_name}, load ${appLoad.loadNumber}, pickup ${appLoad.stops[0]?.city ?? ''} ${appLoad.stops[0]?.appointmentStartAt ?? ''}), same password`);
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** The row without its undefined/null keys, so the table's defaults apply. */
function defined(row) {
  return Object.fromEntries(Object.entries(row).filter(([, v]) => v !== undefined && v !== null));
}

async function run() {
  if (!keepFresh) return main();
  // Recording helper: positions older than 15 minutes stop counting, so refresh every 5 minutes.
  for (;;) {
    NOW = new Date();
    rngState = 20261103;
    await main();
    await new Promise((r) => setTimeout(r, 5 * 60_000));
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
