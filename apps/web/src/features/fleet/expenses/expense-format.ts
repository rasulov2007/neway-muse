import { formatMoney } from '@/lib/format';

/** Cents as the person reads them. Money is integer cents end to end; only the screen divides. */
export function money(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '—' : formatMoney(cents / 100);
}

/** `150.00` for a money field, from cents; empty for nothing. */
export function centsToField(cents: number | null | undefined): string {
  return cents === null || cents === undefined ? '' : (cents / 100).toFixed(2);
}

// ---------------------------------------------------------------------------- places

/** `Houston, TX`; null when neither is known. */
export function cityState(city: string | null | undefined, state: string | null | undefined): string | null {
  const parts = [city, state].map((p) => p?.trim()).filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : null;
}

/** The full address on one line, for the detail panel and the map link. */
export function fullAddress(parts: {
  address?: string | null;
  city?: string | null;
  state?: string | null;
  postalCode?: string | null;
}): string | null {
  const tail = [cityState(parts.city, parts.state), parts.postalCode?.trim()].filter(Boolean).join(' ');
  const line = [parts.address?.trim(), tail].filter(Boolean).join(', ');
  return line || null;
}

/** A map search for the recorded address: no maps integration, just a link the person opens. */
export function mapHref(query: string | null): string | null {
  return query ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}` : null;
}

