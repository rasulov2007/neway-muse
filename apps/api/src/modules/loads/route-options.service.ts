import { createHash } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { and, eq, inArray } from 'drizzle-orm';
import {
  ROUTING_DEFAULTS,
  TollGuruResponseSchema,
  normalizeTollGuruRoutes,
  stopRouteAddress,
  type RouteOption,
  type RouteOptionsResult,
  type RouteSettingsUsed,
  type StoredLoad,
} from '@neway/shared';
import { env } from '../../config/env';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { settings as settingsTable } from '../../database/schema/admin';

/** What the screen is told when TollGuru cannot answer; the load itself is never held up. */
export const ROUTE_OPTION_ERRORS = {
  not_configured: 'TollGuru is not set up. Ask an administrator to add the TollGuru API key on the server.',
  no_subscription: 'TollGuru: no active subscription — activate a plan in TollGuru.',
  unavailable: 'TollGuru did not answer. Try again in a minute, or skip and book without a route.',
  bad_key: 'TollGuru refused the API key. Check TOLLGURU_API_KEY on the server.',
  no_stops: 'The load needs at least a pickup and a delivery with a city and state before a route can be priced.',
  no_routes: 'TollGuru found no truck route between these stops.',
} as const;
export type RouteOptionErrorCode = keyof typeof ROUTE_OPTION_ERRORS;

function routeError(code: RouteOptionErrorCode, status: number): AppError {
  return new AppError({ status, title: ROUTE_OPTION_ERRORS[code], detail: ROUTE_OPTION_ERRORS[code], extensions: { code } });
}

const DAY_MS = 24 * 60 * 60 * 1000;
const TIMEOUT_MS = 15_000;
const CACHE_LIMIT = 500;

interface CacheEntry {
  at: number;
  result: Omit<RouteOptionsResult, 'cached'>;
}

/**
 * Route options for a load's stops, from TollGuru (owner, 2026-10-27).
 *
 * Server side only: the key never leaves this process. The answer is cached for 24 hours by the
 * stop list and the fuel settings, in memory - the same lane asked twice in a day is one call,
 * and a restart costs one call per lane, so no table is needed. TollGuru failing never blocks
 * anything: the caller shows the message and the load stands as booked.
 */
@Injectable()
export class RouteOptionsService {
  private readonly logger = new Logger(RouteOptionsService.name);
  private readonly cache = new Map<string, CacheEntry>();
  /** The clock the cache reads; a test replaces it. */
  clock: () => Date = () => new Date();

  constructor(private readonly database: DatabaseService) {}

  /** The fuel settings the company set, or the shipped defaults. */
  async settingsFor(companyId: string): Promise<RouteSettingsUsed> {
    const rows = await this.database.db
      .select({ key: settingsTable.key, value: settingsTable.value })
      .from(settingsTable)
      .where(and(eq(settingsTable.companyId, companyId), inArray(settingsTable.key, ['routing.fuel_price_per_gallon', 'routing.truck_mpg'])));
    const read = (key: string, fallback: number) => {
      const v = rows.find((r) => r.key === key)?.value;
      return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : fallback;
    };
    return {
      fuelPricePerGallon: read('routing.fuel_price_per_gallon', ROUTING_DEFAULTS.fuelPricePerGallon),
      mpg: read('routing.truck_mpg', ROUTING_DEFAULTS.mpg),
      // No truck in the fleet records its weight yet: a loaded tractor-trailer at the legal gross.
      grossWeightLbs: ROUTING_DEFAULTS.grossWeightLbs,
      axles: ROUTING_DEFAULTS.axles,
    };
  }

  /** The places a load is routed through, in order. */
  placesOf(load: StoredLoad): string[] {
    return [...load.stops]
      .sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0))
      .map((s) => stopRouteAddress(s as unknown as Parameters<typeof stopRouteAddress>[0]))
      .filter((p) => p.length > 0);
  }

  async optionsFor(companyId: string, load: StoredLoad, options: { refresh?: boolean } = {}): Promise<RouteOptionsResult> {
    const places = this.placesOf(load);
    const cities = load.stops.filter((s) => (s.city ?? '').trim() && (s.state ?? '').trim());
    if (places.length < 2 || cities.length < 2) throw routeError('no_stops', 422);
    const used = await this.settingsFor(companyId);
    const key = createHash('sha256').update(JSON.stringify({ companyId, places, used })).digest('hex');
    const now = this.clock().getTime();
    const hit = this.cache.get(key);
    if (hit && !options.refresh && now - hit.at < DAY_MS) return { ...hit.result, cached: true };

    const apiKey = env.TOLLGURU_API_KEY;
    if (!apiKey) throw routeError('not_configured', 503);
    const response = await this.call(apiKey, places, used);
    const routes = normalizeTollGuruRoutes(response, used);
    if (routes.length === 0) throw routeError('no_routes', 422);
    const result = { provider: 'tollguru' as const, options: routes, settings: used, computedAt: new Date(now).toISOString() };
    if (this.cache.size >= CACHE_LIMIT) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { at: now, result });
    return { ...result, cached: false };
  }

  /** One option of the load's list (from the cache, or asked again with the same ids). */
  async optionFor(companyId: string, load: StoredLoad, optionId: string): Promise<{ option: RouteOption; settings: RouteSettingsUsed } | null> {
    const result = await this.optionsFor(companyId, load);
    const option = result.options.find((o) => o.id === optionId);
    return option ? { option, settings: result.settings } : null;
  }

  private async call(apiKey: string, places: string[], used: RouteSettingsUsed) {
    const [from, ...rest] = places;
    const to = rest.pop() as string;
    const body = {
      from: { address: from },
      to: { address: to },
      waypoints: rest.map((address) => ({ address })),
      serviceProvider: 'here',
      vehicle: {
        type: `${used.axles}AxlesTruck`,
        weight: { value: used.grossWeightLbs, unit: 'pound' },
        height: { value: ROUTING_DEFAULTS.heightFeet, unit: 'feet' },
        axles: used.axles,
      },
      fuelOptions: {
        fuelCost: { value: used.fuelPricePerGallon, units: 'USD/gallon', currency: 'USD', fuelUnit: 'gallon' },
        fuelEfficiency: { city: used.mpg, hwy: used.mpg, units: 'mpg' },
      },
      units: { currency: 'USD' },
    };
    const url = `${env.TOLLGURU_API_BASE.replace(/\/+$/, '')}/toll/v2/origin-destination-waypoints`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': apiKey },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      this.logger.warn({ error: String(error) }, 'TollGuru did not answer');
      throw routeError('unavailable', 502);
    }
    const text = await res.text();
    if (!res.ok) {
      // Never log the request: it carries the key in a header. The answer is safe to read.
      this.logger.warn({ status: res.status, body: text.slice(0, 300) }, 'TollGuru refused');
      if (res.status === 403 && /subscription/i.test(text)) throw routeError('no_subscription', 502);
      if (res.status === 401 || res.status === 403) throw routeError('bad_key', 502);
      throw routeError('unavailable', 502);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw routeError('unavailable', 502);
    }
    const out = TollGuruResponseSchema.safeParse(parsed);
    if (!out.success) throw routeError('unavailable', 502);
    return out.data;
  }
}
