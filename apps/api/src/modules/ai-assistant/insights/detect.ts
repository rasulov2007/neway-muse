import {
  classifyDelivery,
  projectEta,
  trackingFreshness,
  type DeliveryVerdict,
  type TrackingFreshness,
} from '@neway/shared';

/**
 * The detection rules behind NeWay AI's read-only "insight" tools (hackathon A2, 2026-11-03).
 *
 * Pure: no database, no clock of its own - `now` is always passed in, so every rule is testable
 * with a fixed clock. Where the product already has the rule (the ETA words, the tracking
 * freshness), this file calls the shared function the Operations screen calls, so the AI and the
 * screen cannot disagree. What is new here is only what no screen computes yet: a truck fueling
 * twice in a row, and a truck far off the straight line between its stops.
 */

export const EASTERN = 'America/New_York';
const EARTH_MILES = 3958.8;
/** The same road factor the web's mileage estimate uses (apps/web/src/demo/mileage.ts). */
export const ROAD_FACTOR = 1.18;

export interface LatLng {
  lat: number;
  lng: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

export function haversineMiles(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return EARTH_MILES * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Road miles as the product estimates them: great circle x road factor, rounded to five. */
export function roadMiles(a: LatLng, b: LatLng): number {
  return Math.round((haversineMiles(a, b) * ROAD_FACTOR) / 5) * 5;
}

/**
 * How far `p` is from the straight segment `a`→`b`, in miles, and where along it (0 = at a,
 * 1 = at b). A flat projection around the segment is plenty for "is the truck 50+ miles off":
 * the error over a few hundred miles is a few percent, far below the threshold.
 */
export function offLineMiles(p: LatLng, a: LatLng, b: LatLng): { miles: number; along: number } {
  const lat0 = toRad((a.lat + b.lat + p.lat) / 3);
  const project = (q: LatLng) => ({ x: toRad(q.lng) * Math.cos(lat0) * EARTH_MILES, y: toRad(q.lat) * EARTH_MILES });
  const A = project(a);
  const B = project(b);
  const P = project(p);
  const dx = B.x - A.x;
  const dy = B.y - A.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : ((P.x - A.x) * dx + (P.y - A.y) * dy) / len2;
  const along = Math.max(0, Math.min(1, t));
  const cx = A.x + along * dx;
  const cy = A.y + along * dy;
  return { miles: Math.hypot(P.x - cx, P.y - cy), along };
}

// ------------------------------------------------------------------------------------ time words

/** "Nov 3, 2:15 PM ET" - every clock in the product is US Eastern. */
export function eastern(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.toLocaleString('en-US', { timeZone: EASTERN, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })} ET`;
}

/** The same instant in the stop's own zone ("2:15 PM CST"), shown beside the Eastern time. */
export function inZone(iso: string | null | undefined, zone: string | null | undefined): string | null {
  if (!iso || !zone) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  try {
    return d.toLocaleString('en-US', { timeZone: zone, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short' });
  } catch {
    return null;
  }
}

/** Today in US Eastern, YYYY-MM-DD. */
export function easternDay(now: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: EASTERN, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function minutesText(min: number): string {
  const m = Math.abs(Math.round(min));
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const r = m % 60;
  return r ? `${h} h ${r} min` : `${h} h`;
}

// ------------------------------------------------------------------------------------ fuel

/** A Fleet › Fuel ledger row (`ws2-fueltransactions`), as far as the checks need it. */
export interface FuelRow {
  id: string;
  truckId: string;
  unitNumber?: string;
  driverName?: string;
  at: string;
  product?: 'diesel' | 'def';
  gallons: number;
  amount?: number;
  odometer?: number;
  station?: { brand?: string; name?: string; city?: string; state?: string };
  anomalyFlags?: string[];
  status?: string;
}

export type FuelAnomalyKind = 'twice_in_a_row' | 'over_tank' | 'odometer_backwards' | 'ledger_flag';

export interface FuelAnomaly {
  kind: FuelAnomalyKind;
  level: 'urgent' | 'warning';
  purchaseId: string;
  /** The earlier purchase of a pair. */
  previousId: string | null;
  truckId: string;
  unitNumber: string;
  driverName: string | null;
  at: string;
  gallons: number;
  place: string;
  detail: string;
}

export interface FuelCheckOptions {
  now: Date;
  /** Look back this many days. */
  days: number;
  /** Two fills closer than this are "twice in a row". */
  windowHours: number;
  /** ...unless the odometer says the truck drove at least this far between them. */
  minMilesBetween: number;
  /**
   * The most a tractor's tanks hold. No per-truck tank capacity is stored, so this is the same
   * 300-gallon line the Relay sync and the hand-keyed fill already flag (`impossible_gallons`).
   */
  tankGallons: number;
}

export const FUEL_DEFAULTS: Omit<FuelCheckOptions, 'now'> = { days: 14, windowHours: 4, minMilesBetween: 150, tankGallons: 300 };

const LEDGER_FLAG_WORDS: Record<string, string> = {
  duplicate: 'the ledger marked it a duplicate',
  impossible_gallons: 'the ledger marked the gallons impossible',
  location_mismatch: 'the ledger marked a location / odometer mismatch',
};

const placeOf = (r: FuelRow) => [r.station?.name || r.station?.brand, [r.station?.city, r.station?.state].filter(Boolean).join(', ')].filter((s) => s && String(s).trim()).join(' · ') || 'unknown station';
const gal = (n: number) => `${(Math.round(n * 10) / 10).toLocaleString('en-US')} gal`;

/**
 * Fuel purchases worth a second look. Diesel only (DEF is a different tank). Each anomaly says
 * which rule fired and the numbers behind it, so a person can check it instead of trusting it.
 */
export function detectFuelAnomalies(rows: readonly FuelRow[], options: FuelCheckOptions): FuelAnomaly[] {
  const until = options.now.getTime();
  const from = until - options.days * 86_400_000;
  const windowMs = options.windowHours * 3_600_000;
  const usable = rows.filter((r) => {
    const at = Date.parse(r.at);
    return r && r.truckId && (r.product ?? 'diesel') === 'diesel' && Number.isFinite(at) && Number.isFinite(r.gallons) && r.gallons > 0;
  });
  const byTruck = new Map<string, FuelRow[]>();
  for (const r of usable) byTruck.set(r.truckId, [...(byTruck.get(r.truckId) ?? []), r]);

  const out: FuelAnomaly[] = [];
  const inWindow = (r: FuelRow) => {
    const at = Date.parse(r.at);
    return at >= from && at <= until;
  };
  const base = (r: FuelRow) => ({
    purchaseId: r.id,
    truckId: r.truckId,
    unitNumber: r.unitNumber ?? r.truckId,
    driverName: r.driverName || null,
    at: r.at,
    gallons: r.gallons,
    place: placeOf(r),
  });

  for (const list of byTruck.values()) {
    list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
    for (let i = 0; i < list.length; i++) {
      const cur = list[i]!;
      if (!inWindow(cur)) continue;
      if (cur.gallons > options.tankGallons) {
        out.push({ ...base(cur), kind: 'over_tank', level: 'urgent', previousId: null, detail: `${gal(cur.gallons)} in one fill - more than the ${options.tankGallons}-gallon tanks hold` });
      }
      for (const flag of cur.anomalyFlags ?? []) {
        if (flag === 'impossible_gallons' && cur.gallons > options.tankGallons) continue; // said above
        out.push({ ...base(cur), kind: 'ledger_flag', level: 'warning', previousId: null, detail: `Fleet › Fuel: ${LEDGER_FLAG_WORDS[flag] ?? flag.replace(/_/g, ' ')}` });
      }
      const prev = i > 0 ? list[i - 1]! : null;
      if (!prev) continue;
      const gapMs = Date.parse(cur.at) - Date.parse(prev.at);
      const odoKnown = (prev.odometer ?? 0) > 0 && (cur.odometer ?? 0) > 0;
      const miles = odoKnown ? cur.odometer! - prev.odometer! : null;
      if (miles !== null && miles < 0) {
        out.push({ ...base(cur), kind: 'odometer_backwards', level: 'warning', previousId: prev.id, detail: `Odometer ${cur.odometer!.toLocaleString('en-US')} is lower than the fill before it (${prev.odometer!.toLocaleString('en-US')})` });
        continue;
      }
      if (gapMs <= windowMs && (miles === null || miles < options.minMilesBetween)) {
        const both = prev.gallons + cur.gallons;
        out.push({
          ...base(cur),
          kind: 'twice_in_a_row',
          level: both > options.tankGallons ? 'urgent' : 'warning',
          previousId: prev.id,
          detail: `Fueled twice in ${minutesText(gapMs / 60_000)}${miles === null ? ' (no odometer to say how far it drove)' : `, ${miles.toLocaleString('en-US')} mi apart`}: ${gal(prev.gallons)} at ${placeOf(prev)}, then ${gal(cur.gallons)}${both > options.tankGallons ? ` - ${gal(both)} together is more than the tanks hold` : ''}`,
        });
      }
    }
  }
  const rank = { urgent: 0, warning: 1 };
  return out.sort((a, b) => rank[a.level] - rank[b.level] || Date.parse(b.at) - Date.parse(a.at));
}

// ------------------------------------------------------------------------------------ loads

export interface StopFacts {
  id: string;
  kind: string;
  city: string;
  state: string;
  zip?: string | null;
  timezone?: string;
  status: string;
  appointmentStartAt: string | null;
  appointmentEndAt: string | null;
  appointmentNoWindow?: boolean;
  arrivedAt: string | null;
  departedAt?: string | null;
}

export interface Position extends LatLng {
  updatedAt: string;
  city?: string;
  state?: string;
}

/** The statuses in which a load is on the road with freight or running to it. */
export const ROLLING_STATUSES = ['dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading'] as const;

const doneStop = (s: StopFacts) => s.status === 'completed' || s.status === 'cancelled';

/** The stop the truck is running to now: the first one not completed (as the Operations screen picks it). */
export function nextStopOf<T extends StopFacts>(stops: readonly T[]): T | null {
  return [...stops].find((s) => !doneStop(s)) ?? null;
}

/** The last stop the truck finished, if any. */
export function previousStopOf<T extends StopFacts>(stops: readonly T[]): T | null {
  const done = [...stops].filter((s) => s.status === 'completed' || Boolean(s.departedAt));
  return done.at(-1) ?? null;
}

export interface LateRiskResult {
  nextStop: StopFacts | null;
  remainingMiles: number | null;
  etaAt: string | null;
  tracking: TrackingFreshness;
  verdict: DeliveryVerdict;
  /** Minutes from now to the stop's deadline (window end, or the fixed time); negative once past. */
  minutesToDeadline: number | null;
}

/**
 * On time / at risk / late for the stop the truck is running to - the very rule the Operations
 * screen runs (`trackingFreshness` + `projectEta` + `classifyDelivery`, LOADS_CONFIG's average
 * speed and lateness buffer). A check-call ETA newer than the position stands in for the
 * projection, as it does on the screen.
 */
export function assessLateRisk(input: {
  nowIso: string;
  stops: readonly StopFacts[];
  position: Position | null;
  /** Coordinates for a stop; null when its place cannot be found. */
  placeOf: (stop: StopFacts) => LatLng | null;
  manualEta?: { at: string; recordedAt: string; stopId?: string | null } | null;
}): LateRiskResult {
  const tracking = trackingFreshness(input.position?.updatedAt ?? null, input.nowIso);
  const next = nextStopOf(input.stops);
  const to = next ? input.placeOf(next) : null;
  const remainingMiles = tracking.usable && input.position && to ? roadMiles(input.position, to) : null;
  const manual = input.manualEta ?? null;
  const positionAt = input.position?.updatedAt ?? null;
  const manualWins = manual !== null && (!positionAt || manual.recordedAt >= positionAt) && (!next || !manual.stopId || manual.stopId === next.id);
  const etaAt = manualWins ? manual!.at : projectEta({ nowIso: input.nowIso, remainingMiles });
  const verdict = classifyDelivery({
    nowIso: input.nowIso,
    etaAt,
    appointmentStartAt: next?.appointmentStartAt ?? null,
    appointmentEndAt: next?.appointmentEndAt ?? null,
    appointmentNoWindow: next?.appointmentNoWindow,
    arrivedAt: next?.arrivedAt ?? null,
    tracking: tracking.state,
  });
  const deadlineIso = next ? (next.appointmentNoWindow ? next.appointmentStartAt : (next.appointmentEndAt ?? next.appointmentStartAt)) : null;
  const deadline = deadlineIso ? Date.parse(deadlineIso) : Number.NaN;
  const minutesToDeadline = Number.isNaN(deadline) ? null : Math.round((deadline - Date.parse(input.nowIso)) / 60_000);
  return { nextStop: next, remainingMiles, etaAt, tracking, verdict, minutesToDeadline };
}

/**
 * How far off the straight line counts as off route. Not 50: interstates bend - I-65 from Chicago
 * to Nashville runs about 60 miles off the straight line at Indianapolis - so 50 would flag
 * trucks driving the obvious road.
 */
export const DEVIATION_DEFAULT_MILES = 75;

export interface DeviationResult {
  state: 'off_route' | 'on_route' | 'unknown';
  /** Miles from the straight line between the previous and the next stop. */
  offMiles: number | null;
  /** 0..1 along that line. */
  along: number | null;
  reason: string;
}

/**
 * Is the truck far off the straight line between the stop it left and the stop it is running to?
 * A straight line is not a road: mountains, interstates and fuel stops bend real routes, so this
 * only flags trucks well beyond `thresholdMiles` and says it is a hint. A truck still heading to
 * its first stop has no "previous stop" and is not judged.
 */
export function assessDeviation(input: {
  nowIso: string;
  stops: readonly StopFacts[];
  position: Position | null;
  placeOf: (stop: StopFacts) => LatLng | null;
  thresholdMiles: number;
  /** Positions older than this are not judged. */
  maxPositionAgeMinutes: number;
}): DeviationResult {
  const next = nextStopOf(input.stops);
  const prev = previousStopOf(input.stops);
  if (!input.position) return { state: 'unknown', offMiles: null, along: null, reason: 'No ELD position for the truck' };
  const age = (Date.parse(input.nowIso) - Date.parse(input.position.updatedAt)) / 60_000;
  if (!Number.isFinite(age) || age > input.maxPositionAgeMinutes) {
    return { state: 'unknown', offMiles: null, along: null, reason: `Position is ${Number.isFinite(age) ? minutesText(age) : 'of unknown age'} old` };
  }
  if (!next) return { state: 'unknown', offMiles: null, along: null, reason: 'No stop left to run to' };
  if (!prev) return { state: 'unknown', offMiles: null, along: null, reason: 'Still heading to the first stop: no previous stop to draw a line from' };
  const a = input.placeOf(prev);
  const b = input.placeOf(next);
  if (!a || !b) return { state: 'unknown', offMiles: null, along: null, reason: `${!a ? `${prev.city}, ${prev.state}` : `${next.city}, ${next.state}`} could not be placed on the map` };
  const { miles, along } = offLineMiles(input.position, a, b);
  const rounded = Math.round(miles);
  return rounded > input.thresholdMiles
    ? { state: 'off_route', offMiles: rounded, along, reason: `${rounded} mi off the straight line ${prev.city}, ${prev.state} → ${next.city}, ${next.state}` }
    : { state: 'on_route', offMiles: rounded, along, reason: `Within ${input.thresholdMiles} mi of the straight line` };
}

// ------------------------------------------------------------------------------------ the brief

export type BriefLevel = 'urgent' | 'warning' | 'info';

export interface BriefIssue {
  level: BriefLevel;
  /** Which tool found it: compliance, fuel, late_risk, route, billing, hiring, fleet. */
  area: string;
  title: string;
  detail: string;
  /** A page in the TMS that opens the record. */
  link?: string;
}

const LEVEL_RANK: Record<BriefLevel, number> = { urgent: 0, warning: 1, info: 2 };
/** Within a level: what stops a truck today first, money next, people last. */
const AREA_RANK: Record<string, number> = { late_risk: 0, compliance: 1, fleet: 2, route: 3, fuel: 4, billing: 5, hiring: 6 };

export function rankIssues(issues: readonly BriefIssue[], limit = 25): BriefIssue[] {
  return [...issues]
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level] || (AREA_RANK[a.area] ?? 9) - (AREA_RANK[b.area] ?? 9) || a.title.localeCompare(b.title))
    .slice(0, limit);
}

/** The brief without a model: the ranked issues as plain lines (used when no AI is set up). */
export function plainBrief(issues: readonly BriefIssue[], todayLabel: string): string {
  if (issues.length === 0) return `**Morning brief · ${todayLabel}**\n\nNothing needs attention right now.`;
  const word = { urgent: 'Urgent', warning: 'Warning', info: 'Info' } as const;
  const lines = issues.map((i) => `- **${word[i.level]}** · ${i.title} - ${i.detail}`);
  return [`**Morning brief · ${todayLabel}**`, '', ...lines].join('\n');
}
