/**
 * Shop addresses, normalized for deduplication (docs/pm-module/04-sheet-import.md §4).
 *
 * The customer's sheet holds the same Naperville yard in three spellings. The rule: lowercase,
 * trim, collapse whitespace, strip ", USA" and ", United States", expand RD → road, ST → street,
 * LN → lane, BLVD → boulevard, remove punctuation, then compare street number + street + ZIP.
 * Two different ZIPs are never merged, whatever the street says.
 */

const EXPAND: Record<string, string> = {
  rd: 'road',
  st: 'street',
  ln: 'lane',
  blvd: 'boulevard',
  ave: 'avenue',
  dr: 'drive',
  hwy: 'highway',
  pkwy: 'parkway',
  ct: 'court',
};

/** Words that end a street name, so the city that may follow without a comma is left out of the key. */
const STREET_SUFFIXES = new Set([
  'road',
  'street',
  'lane',
  'boulevard',
  'avenue',
  'drive',
  'highway',
  'parkway',
  'court',
  'pike',
  'way',
  'trail',
  'circle',
  'place',
  'terrace',
  'route',
]);

const STATES = new Set([
  'al', 'ak', 'az', 'ar', 'ca', 'co', 'ct', 'de', 'fl', 'ga', 'hi', 'id', 'il', 'in', 'ia', 'ks', 'ky', 'la', 'me', 'md',
  'ma', 'mi', 'mn', 'ms', 'mo', 'mt', 'ne', 'nv', 'nh', 'nj', 'nm', 'ny', 'nc', 'nd', 'oh', 'ok', 'or', 'pa', 'ri', 'sc',
  'sd', 'tn', 'tx', 'ut', 'vt', 'va', 'wa', 'wv', 'wi', 'wy', 'dc',
]);

export interface NormalizedAddress {
  /** `number|street|zip`, or null when the address has no street number or no ZIP. */
  key: string | null;
  number: string | null;
  street: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  /** The street line as written, trimmed, for the vendor's own record. */
  line: string;
}

/** Lowercased words with the punctuation gone; abbreviations are expanded only on the street. */
function words(segment: string): string[] {
  return segment
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean);
}

/** The words as written, punctuation kept, for the vendor's own record. */
function writtenWords(segment: string): string[] {
  return segment.split(/\s+/).filter(Boolean);
}

export function normalizeAddress(raw: string | null | undefined): NormalizedAddress {
  const trimmed = (raw ?? '').replace(/\s+/g, ' ').trim();
  if (!trimmed) return { key: null, number: null, street: null, city: null, state: null, zip: null, line: '' };

  let text = trimmed.replace(/,?\s*(usa|united states|u\.s\.a\.|us)\s*$/i, '').trim();
  const zipMatch = /\b(\d{5})(?:-\d{4})?\s*$/.exec(text);
  const zip = zipMatch?.[1] ?? null;
  if (zipMatch) text = text.slice(0, zipMatch.index).trim().replace(/,\s*$/, '');

  const segments = text.split(',').map((s) => s.trim()).filter(Boolean);
  const first = segments[0] ?? '';
  const firstWords = words(first);
  const number = firstWords[0] && /^\d+[a-z]?$/.test(firstWords[0]) ? firstWords[0] : null;

  // The street: after the number, up to and including the first suffix, abbreviations expanded
  // (RD → road); a segment that carries the city without a comma ("1101 Frontenac RD Naperville")
  // is cut there, and the city keeps its own spelling - "St. Charles" is not "Street Charles".
  const rest = (number ? firstWords.slice(1) : firstWords).map((w) => EXPAND[w] ?? w);
  const suffixAt = rest.findIndex((w) => STREET_SUFFIXES.has(w));
  const street = suffixAt >= 0 ? rest.slice(0, suffixAt + 1) : rest;
  const cityFromFirst = suffixAt >= 0 ? (number ? firstWords.slice(1) : firstWords).slice(suffixAt + 1) : [];
  const writtenFirst = writtenWords(first);
  const line = suffixAt >= 0 ? writtenFirst.slice(0, (number ? 1 : 0) + suffixAt + 1).join(' ') : first;

  // City and state from the remaining segments: "Naperville, IL" or "Naperville IL".
  const tail = segments.slice(1).flatMap(words);
  const cityStateWords = [...cityFromFirst, ...tail];
  let state: string | null = null;
  let cityWords = cityStateWords;
  const last = cityStateWords[cityStateWords.length - 1];
  if (last && STATES.has(last)) {
    state = last.toUpperCase();
    cityWords = cityStateWords.slice(0, -1);
  }
  const city = cityWords.length > 0 ? cityWords.map(titleCase).join(' ') : null;

  const streetKey = street.join(' ');
  const key = number && streetKey && zip ? `${number}|${streetKey}|${zip}` : null;
  return {
    key,
    number,
    street: streetKey || null,
    city,
    state,
    zip,
    line,
  };
}

function titleCase(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/** A vendor name for an address nobody has named: the street line and the town. */
export function vendorNameFor(address: NormalizedAddress): string {
  const town = [address.city, address.state].filter(Boolean).join(', ');
  return town ? `${address.line}, ${town}` : address.line;
}
