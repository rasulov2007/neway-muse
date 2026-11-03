import { t } from '../i18n/core';
import * as Location from 'expo-location';

import type { DriverLocation } from '@neway/shared/mobile/breakdowns';

import { now } from './clock';

/**
 * Where the driver is, for a breakdown, receipt or safety report: GPS from the phone with the time
 * it was captured, or typed by the driver. Never guessed. A refused permission or no fix leaves the
 * typed text as the only source, and the screen says so.
 */
export type LocationResult =
  | { ok: true; location: DriverLocation }
  | { ok: false; reason: 'denied' | 'unavailable'; message: string };

export async function captureLocation(): Promise<LocationResult> {
  try {
    const permission = await Location.requestForegroundPermissionsAsync();
    if (!permission.granted) {
      return { ok: false, reason: 'denied', message: t('Location is off for NeWay. Type where you are instead.') };
    }
    const position = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
    const lat = Number(position.coords.latitude.toFixed(6));
    const lng = Number(position.coords.longitude.toFixed(6));
    let text = `${lat}, ${lng}`;
    let city: string | null = null;
    let state: string | null = null;
    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude: lat, longitude: lng });
      if (place) {
        city = place.city ?? place.subregion ?? null;
        const region = place.region ?? '';
        state = /^[A-Za-z]{2}$/.test(region) ? region.toUpperCase() : null;
        const words = [place.street ? `${place.streetNumber ?? ''} ${place.street}`.trim() : null, city, region || null].filter(Boolean);
        if (words.length) text = words.join(', ');
      }
    } catch {
      // No geocoder (web, or offline): the coordinates are the text.
    }
    // The fix's own time when the platform gives one; else the business clock.
    const at = position.timestamp ? new Date(position.timestamp) : now();
    return {
      ok: true,
      location: { text, lat, lng, source: 'gps', captured_at: at.toISOString(), city, state },
    };
  } catch {
    return { ok: false, reason: 'unavailable', message: t('The phone could not find its location. Type where you are instead.') };
  }
}

/**
 * A location the driver typed (no coordinates). The text is kept as typed (it feeds the input while
 * the driver types, so trimming here would eat every space); the server trims it.
 */
export function manualLocation(text: string): DriverLocation {
  return { text, source: 'manual', captured_at: now().toISOString() };
}
