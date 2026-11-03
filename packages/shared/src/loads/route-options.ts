import { z } from 'zod';
import type { TimelineLike } from './model.js';
import { versionConflict, type StoredLoad, type WriteResult } from './write-rules.js';

/**
 * Route options from TollGuru (owner, 2026-10-27): after Create load the dispatcher sees up to
 * three roads with their tolls and fuel, picks one (the cheapest, or any), and the chosen road
 * goes into the driver's Telegram message. The key and the call stay on the server; the browser
 * only ever sees the normalized options below.
 */

/** What a route option is called on the screen. */
export const ROUTE_OPTION_TAGS = ['cheapest', 'fastest', 'least_fuel', 'shortest'] as const;
export type RouteOptionTag = (typeof ROUTE_OPTION_TAGS)[number];

export const ROUTE_OPTION_TAG_LABELS: Record<RouteOptionTag, string> = {
  cheapest: 'Cheapest',
  fastest: 'Fastest',
  least_fuel: 'Least fuel',
  shortest: 'Shortest',
};

export interface RouteOption {
  /** Stable for the same road: a recomputed list gives the same id to the same route. */
  id: string;
  /** "Cheapest", "Fastest", "Shortest", or the road's own name when it is none of those. */
  label: string;
  /** The road, as TollGuru names it (e.g. "I-65 S"). */
  via: string;
  miles: number;
  durationMinutes: number;
  /** Tolls paid with a transponder; the cash price when no tag price is known. */
  tollCost: number;
  /** Tolls paid in cash, when TollGuru gives a cash price. */
  cashTollCost: number | null;
  fuelCost: number;
  /** Tolls + fuel. */
  totalCost: number;
  hasTolls: boolean;
  /** TollGuru's navigation link for this road, when it gave one. */
  mapUrl: string | null;
  tags: RouteOptionTag[];
}

/** What the options were priced on. */
export interface RouteSettingsUsed {
  fuelPricePerGallon: number;
  mpg: number;
  grossWeightLbs: number;
  axles: number;
}

export interface RouteOptionsResult {
  provider: 'tollguru';
  options: RouteOption[];
  settings: RouteSettingsUsed;
  computedAt: string;
  /** True when the list came from the 24-hour cache, not a fresh call. */
  cached: boolean;
}

/** The road chosen for a load, kept on the record as `route`. */
export interface ChosenRoute {
  provider: 'tollguru';
  optionId: string;
  label: string;
  via: string;
  miles: number;
  durationMinutes: number;
  tollCost: number;
  fuelCost: number;
  totalCost: number;
  mapUrl: string | null;
  chosenById: string;
  chosenByName: string;
  chosenAt: string;
  settings: RouteSettingsUsed;
}

export const RouteOptionsRequestSchema = z.object({}).passthrough();

export const ChooseRouteSchema = z.object({
  optionId: z.string().trim().min(1).max(80),
  expectedUpdatedAt: z.string().min(1),
});
export type ChooseRouteInput = z.infer<typeof ChooseRouteSchema>;

export const ClearRouteSchema = z.object({ expectedUpdatedAt: z.string().min(1) });
export type ClearRouteInput = z.infer<typeof ClearRouteSchema>;

/** The defaults when a company has not set its own (settings `routing.*`). */
export const ROUTING_DEFAULTS = {
  fuelPricePerGallon: 3.75,
  mpg: 6.5,
  grossWeightLbs: 80_000,
  axles: 5,
  heightFeet: 13.5,
} as const;

// ---------------------------------------------------------------------------------------------
// TollGuru's answer, as much of it as we read.

const num = z.number().finite().nullable().optional();
const TollGuruRouteSchema = z
  .object({
    summary: z
      .object({
        name: z.string().nullable().optional(),
        distance: z.object({ text: z.string().nullable().optional(), metric: z.string().nullable().optional(), value: num }).partial().nullable().optional(),
        duration: z.object({ text: z.string().nullable().optional(), value: num }).partial().nullable().optional(),
        hasTolls: z.boolean().nullable().optional(),
        url: z.string().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    costs: z
      .object({ tag: num, cash: num, tagAndCash: num, minimumTollCost: num, maximumTollCost: num, fuel: num, prepaidCard: num, licensePlate: num })
      .partial()
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export const TollGuruResponseSchema = z.object({ status: z.unknown().optional(), routes: z.array(TollGuruRouteSchema).default([]) }).passthrough();
export type TollGuruResponse = z.infer<typeof TollGuruResponseSchema>;

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Miles from TollGuru's distance: the metre value, else the "718 mi" / "1,155 km" text. */
function milesOf(distance: { text?: string | null; metric?: string | null; value?: number | null } | null | undefined): number {
  if (!distance) return 0;
  const text = distance.text ?? '';
  const mi = /([\d,.]+)\s*mi\b/i.exec(text);
  if (mi) return Math.round(Number(mi[1]!.replace(/,/g, '')));
  if (typeof distance.value === 'number' && distance.value > 0) return Math.round(distance.value / 1609.344);
  const km = /([\d,.]+)\s*km\b/i.exec(`${text} ${distance.metric ?? ''}`);
  return km ? Math.round(Number(km[1]!.replace(/,/g, '')) / 1.609344) : 0;
}

/** Minutes from TollGuru's duration: seconds, else "11 h 5 min". */
function minutesOf(duration: { text?: string | null; value?: number | null } | null | undefined): number {
  if (!duration) return 0;
  if (typeof duration.value === 'number' && duration.value > 0) return Math.round(duration.value / 60);
  const text = duration.text ?? '';
  const d = /(\d+)\s*d/.exec(text);
  const h = /(\d+)\s*h/.exec(text);
  const m = /(\d+)\s*min/.exec(text);
  return (d ? Number(d[1]) * 1440 : 0) + (h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0);
}

/** A short, stable id for the same road: name + miles + minutes. */
function optionId(via: string, miles: number, minutes: number): string {
  const source = `${via}|${miles}|${Math.round(minutes / 5)}`;
  let h = 2166136261;
  for (let i = 0; i < source.length; i++) {
    h ^= source.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return `rt_${(h >>> 0).toString(36)}`;
}

/**
 * TollGuru's routes, as the dispatcher reads them: at most three, sorted by tolls + fuel, the
 * cheapest, the fastest and the one burning least fuel marked. When TollGuru gives no fuel cost
 * it is worked out here from the miles, the mpg and the fuel price the company set.
 */
export function normalizeTollGuruRoutes(
  response: TollGuruResponse,
  settings: Pick<RouteSettingsUsed, 'fuelPricePerGallon' | 'mpg'>,
  limit = 3,
): RouteOption[] {
  const raw = response.routes.map((r, index) => {
    const via = (r.summary?.name ?? '').trim() || `Route ${index + 1}`;
    const miles = milesOf(r.summary?.distance);
    const durationMinutes = minutesOf(r.summary?.duration);
    const c = r.costs ?? {};
    const tag = typeof c.tag === 'number' ? c.tag : null;
    const cash = typeof c.cash === 'number' ? c.cash : null;
    const fallbackToll = [c.tagAndCash, c.minimumTollCost, c.prepaidCard, c.licensePlate].find((v): v is number => typeof v === 'number') ?? 0;
    const tollCost = round2(tag ?? cash ?? fallbackToll);
    const fuelCost = round2(
      typeof c.fuel === 'number' && c.fuel > 0 ? c.fuel : settings.mpg > 0 ? (miles / settings.mpg) * settings.fuelPricePerGallon : 0,
    );
    return {
      id: optionId(via, miles, durationMinutes),
      label: via,
      via,
      miles,
      durationMinutes,
      tollCost,
      cashTollCost: cash === null ? null : round2(cash),
      fuelCost,
      totalCost: round2(tollCost + fuelCost),
      hasTolls: r.summary?.hasTolls ?? tollCost > 0,
      mapUrl: r.summary?.url?.trim() || null,
      tags: [] as RouteOptionTag[],
    } satisfies RouteOption;
  });
  // The same road twice (TollGuru sometimes repeats one) is one option.
  const unique = raw.filter((o, i) => raw.findIndex((x) => x.id === o.id) === i);
  const options = unique.sort((a, b) => a.totalCost - b.totalCost || a.durationMinutes - b.durationMinutes).slice(0, limit);
  if (options.length === 0) return options;
  const best = (pick: (o: RouteOption) => number) => options.reduce((a, b) => (pick(b) < pick(a) ? b : a));
  best((o) => o.totalCost).tags.push('cheapest');
  best((o) => o.durationMinutes || Number.POSITIVE_INFINITY).tags.push('fastest');
  best((o) => o.fuelCost).tags.push('least_fuel');
  best((o) => o.miles || Number.POSITIVE_INFINITY).tags.push('shortest');
  for (const o of options) {
    const first = o.tags.find((t) => t !== 'least_fuel') ?? o.tags[0];
    o.label = first ? ROUTE_OPTION_TAG_LABELS[first] : o.via;
  }
  return options;
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

/** The driver message's route line: road, miles, tolls. No fuel or totals - those are the company's. */
export function routeLine(route: Pick<ChosenRoute, 'via' | 'miles' | 'tollCost'>): string {
  return `Route: ${route.via} · ${route.miles} mi · ${route.tollCost > 0 ? `tolls ${money(route.tollCost)}` : 'no tolls'}`;
}

/**
 * Puts the route line into a message the dispatcher may already have edited: replaces the
 * Route line that is there, or adds it after the stops block (the line that closes it), or at
 * the end when the message has neither. `null` takes the line out.
 */
export function withRouteLine(text: string, line: string | null): string {
  const lines = text.split('\n');
  const at = lines.findIndex((l) => l.startsWith('Route: '));
  if (at >= 0) {
    if (line === null) lines.splice(at, 1);
    else lines[at] = line;
    return lines.join('\n');
  }
  if (line === null) return text;
  const close = lines.findIndex((l) => /^—+-$/.test(l));
  if (close >= 0) lines.splice(close + 1, 0, line);
  else lines.push(line);
  return lines.join('\n');
}

function timelineEvent(record: StoredLoad, now: string, actorName: string, title: string, detail: string | null): TimelineLike {
  const stem = record.loadNumber.replace(/^L-/, '');
  return {
    id: `evt_${stem}_${record.timeline.length + 1}_${Date.parse(now).toString(36)}`,
    at: now,
    kind: 'route_chosen',
    actorType: 'user',
    actorName,
    title,
    detail,
    stopId: null,
  };
}

function hours(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h > 0 ? `${h} h${m ? ` ${m} min` : ''}` : `${m} min`;
}

/** Stores the chosen road on the load, with a timeline entry; refuses a stale copy. */
export function applyChooseRoute<T extends StoredLoad>(
  record: T,
  input: { expectedUpdatedAt: string; option: RouteOption; settings: RouteSettingsUsed },
  actor: { id: string; name: string },
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const o = input.option;
  const route: ChosenRoute = {
    provider: 'tollguru',
    optionId: o.id,
    label: o.label,
    via: o.via,
    miles: o.miles,
    durationMinutes: o.durationMinutes,
    tollCost: o.tollCost,
    fuelCost: o.fuelCost,
    totalCost: o.totalCost,
    mapUrl: o.mapUrl,
    chosenById: actor.id,
    chosenByName: actor.name,
    chosenAt: now,
    settings: input.settings,
  };
  const event = timelineEvent(
    record,
    now,
    actor.name,
    `Route chosen: ${o.via}`,
    `${o.label} · ${o.miles} mi · ${hours(o.durationMinutes)} · tolls ${money(o.tollCost)} · fuel ${money(o.fuelCost)} · total ${money(o.totalCost)}`,
  );
  return { ok: true, record: { ...record, route, timeline: [...record.timeline, event], updatedAt: now } as T, event };
}

/** Takes the chosen road off the load. */
export function applyClearRoute<T extends StoredLoad>(record: T, input: ClearRouteInput, actor: { id: string; name: string }, now: string): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const was = record['route'] as ChosenRoute | null | undefined;
  if (!was) return { ok: true, record, event: null };
  const event = timelineEvent(record, now, actor.name, `Route cleared: ${was.via}`, null);
  return { ok: true, record: { ...record, route: null, timeline: [...record.timeline, event], updatedAt: now } as T, event };
}

/** The address a stop is routed to: street, city, state and ZIP, as far as they are known. */
export function stopRouteAddress(stop: { address?: string | null; street?: string | null; city?: string | null; state?: string | null; zip?: string | null }): string {
  const street = (stop.address ?? stop.street ?? '').trim();
  const city = (stop.city ?? '').trim();
  const stateZip = [stop.state ?? '', stop.zip ?? ''].map((s) => s.trim()).filter(Boolean).join(' ');
  return [street, city, stateZip].filter(Boolean).join(', ');
}
