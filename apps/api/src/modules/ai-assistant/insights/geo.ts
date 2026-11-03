import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { env } from '../../../config/env';
import type { LatLng, StopFacts } from './detect';

/**
 * Where a stop is on the map, server side.
 *
 * Stops carry a city, a state and usually a ZIP, not coordinates. The web places them with
 * /geo/us-places.json (every US ZIP and city, from the BSD-licensed `zipcodes` data); the server
 * reads the very same file so an ETA here and on the Operations screen are measured alike. It is
 * looked for at US_PLACES_PATH, then beside the web app in this repository. When it cannot be
 * found every stop is "not on the map" and the tools say so - nothing is guessed.
 */
interface UsPlaces {
  zip: Record<string, [number, number]>;
  city: Record<string, [number, number]>;
}

let places: UsPlaces | null | undefined;

function candidates(): string[] {
  return [
    env.US_PLACES_PATH,
    resolve(process.cwd(), 'apps/web/public/geo/us-places.json'),
    resolve(process.cwd(), '../web/public/geo/us-places.json'),
    resolve(__dirname, '../../../../../web/public/geo/us-places.json'),
    resolve(__dirname, '../../../../../../apps/web/public/geo/us-places.json'),
  ].filter((p): p is string => Boolean(p));
}

function usPlaces(): UsPlaces | null {
  if (places !== undefined) return places;
  places = null;
  for (const path of candidates()) {
    try {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, 'utf8')) as UsPlaces;
      if (data && data.zip && data.city) {
        places = data;
        break;
      }
    } catch {
      // try the next one
    }
  }
  return places;
}

/** For tests: a fixed table instead of the file. */
export function setUsPlacesForTest(data: UsPlaces | null): void {
  places = data;
}

export function geoAvailable(): boolean {
  return usPlaces() !== null;
}

/** A stop's coordinates: its own when the record has them, else its ZIP, else its city. */
export function placeOfStop(stop: StopFacts & { lat?: unknown; lng?: unknown }): LatLng | null {
  if (typeof stop.lat === 'number' && typeof stop.lng === 'number' && Number.isFinite(stop.lat) && Number.isFinite(stop.lng)) {
    return { lat: stop.lat, lng: stop.lng };
  }
  const data = usPlaces();
  if (!data) return null;
  const zip = (stop.zip ?? '').trim().slice(0, 5);
  const byZip = zip ? data.zip[zip] : undefined;
  if (byZip) return { lat: byZip[0], lng: byZip[1] };
  const byCity = data.city[`${(stop.city ?? '').trim().toUpperCase()}|${(stop.state ?? '').trim().toUpperCase()}`];
  return byCity ? { lat: byCity[0], lng: byCity[1] } : null;
}
