/**
 * One time rule for stops (P0.4): the IANA zone a stop's clock runs on.
 *
 * A stop's zone comes from its ZIP first (three-digit prefix), then from its city and state, and
 * is recorded on the stop so every screen reads the same one. "Unknown" is an answer: a stop
 * whose zone nobody could work out is shown that way and asked about, never defaulted to the
 * company's clock - Chicago time on an Atlanta appointment is how a driver is an hour late
 * without anyone having been wrong.
 *
 * The tables here cover the continental United States plus Alaska and Hawaii at the level
 * dispatch works at: a whole state, and the counties in the split states that the ZIP prefix or
 * the city name picks out. The handful of towns that keep a neighbouring state's clock are
 * listed where dispatch is likely to meet them; a person can still set the zone by hand.
 */
export type ZoneSource = 'zip' | 'city' | 'state' | 'unknown';

export interface ZoneResolution {
  zone: string | null;
  source: ZoneSource;
}

const NY = 'America/New_York';
const CHI = 'America/Chicago';
const DEN = 'America/Denver';
const PHX = 'America/Phoenix';
const LA = 'America/Los_Angeles';
const ANC = 'America/Anchorage';
const HNL = 'Pacific/Honolulu';

/** Every zone a stop may carry; a value outside this list is not a US stop's clock. */
export const US_ZONES = [NY, CHI, DEN, PHX, LA, ANC, HNL] as const;

export const STATE_ZONE: Readonly<Record<string, string>> = {
  AL: CHI, AK: ANC, AZ: PHX, AR: CHI, CA: LA, CO: DEN, CT: NY, DE: NY, DC: NY, FL: NY,
  GA: NY, HI: HNL, ID: DEN, IL: CHI, IN: NY, IA: CHI, KS: CHI, KY: NY, LA: CHI, ME: NY,
  MD: NY, MA: NY, MI: NY, MN: CHI, MS: CHI, MO: CHI, MT: DEN, NE: CHI, NV: LA, NH: NY,
  NJ: NY, NM: DEN, NY: NY, NC: NY, ND: CHI, OH: NY, OK: CHI, OR: LA, PA: NY, RI: NY,
  SC: NY, SD: CHI, TN: CHI, TX: CHI, UT: DEN, VT: NY, VA: NY, WA: LA, WV: NY, WI: CHI, WY: DEN,
};

/**
 * ZIP three-digit prefixes that do not follow their state's default clock. Checked before the
 * state ranges, so a Pensacola ZIP is Central even though Florida is Eastern.
 */
const ZIP_EXCEPTIONS: ReadonlyArray<readonly [from: number, to: number, zone: string]> = [
  [324, 325, CHI], // Florida panhandle: Panama City, Pensacola
  [463, 464, CHI], // Indiana: Gary, Hammond
  [476, 477, CHI], // Indiana: Evansville
  [420, 424, CHI], // Kentucky west: Paducah, Bowling Green, Hopkinsville, Owensboro, Henderson
  [373, 379, NY], // Tennessee east: Chattanooga, Knoxville, Johnson City
  [498, 499, CHI], // Michigan: Iron Mountain, Ironwood
  [798, 799, DEN], // Texas: El Paso
  [885, 885, DEN], // Texas: El Paso
  [586, 586, DEN], // North Dakota: Dickinson
  [577, 577, DEN], // South Dakota: Rapid City
  [693, 693, DEN], // Nebraska panhandle: Scottsbluff, Alliance
  [835, 835, LA], // Idaho: Lewiston
  [838, 838, LA], // Idaho: Coeur d'Alene
];

/** ZIP three-digit prefix ranges by state, the USPS allocation. */
const ZIP_RANGES: ReadonlyArray<readonly [from: number, to: number, state: string]> = [
  [5, 5, 'NY'], [10, 27, 'MA'], [28, 29, 'RI'], [30, 38, 'NH'], [39, 49, 'ME'], [50, 59, 'VT'],
  [60, 69, 'CT'], [70, 89, 'NJ'], [100, 149, 'NY'], [150, 196, 'PA'], [197, 199, 'DE'],
  [200, 200, 'DC'], [201, 201, 'VA'], [202, 205, 'DC'], [206, 212, 'MD'], [214, 219, 'MD'],
  [220, 246, 'VA'], [247, 268, 'WV'], [270, 289, 'NC'], [290, 299, 'SC'], [300, 319, 'GA'],
  [320, 349, 'FL'], [350, 369, 'AL'], [370, 385, 'TN'], [386, 397, 'MS'], [398, 399, 'GA'],
  [400, 427, 'KY'], [430, 459, 'OH'], [460, 479, 'IN'], [480, 499, 'MI'], [500, 528, 'IA'],
  [530, 549, 'WI'], [550, 567, 'MN'], [570, 577, 'SD'], [580, 588, 'ND'], [590, 599, 'MT'],
  [600, 629, 'IL'], [630, 658, 'MO'], [660, 679, 'KS'], [680, 693, 'NE'], [700, 714, 'LA'],
  [716, 729, 'AR'], [730, 749, 'OK'], [750, 799, 'TX'], [800, 816, 'CO'], [820, 831, 'WY'],
  [832, 838, 'ID'], [840, 847, 'UT'], [850, 865, 'AZ'], [870, 884, 'NM'], [885, 885, 'TX'],
  [889, 898, 'NV'], [900, 961, 'CA'], [967, 968, 'HI'], [970, 979, 'OR'], [980, 994, 'WA'],
  [995, 999, 'AK'],
];

type CityRule = readonly [state: string, cities: readonly string[], zone: string];

/** Cities in the split states whose clock is not the state's default. */
const CITY_RULES: readonly CityRule[] = [
  ['TX', ['El Paso', 'Socorro', 'Horizon City', 'Anthony', 'Fort Bliss'], DEN],
  [
    'FL',
    [
      'Pensacola', 'Panama City', 'Panama City Beach', 'Fort Walton Beach', 'Destin', 'Crestview',
      'Niceville', 'Navarre', 'Milton', 'Marianna', 'Chipley', 'Bonifay', 'Defuniak Springs',
      'Gulf Breeze', 'Lynn Haven',
    ],
    CHI,
  ],
  [
    'IN',
    [
      'Gary', 'Hammond', 'Evansville', 'Merrillville', 'Valparaiso', 'Michigan City', 'Portage',
      'Crown Point', 'Hobart', 'Schererville', 'East Chicago', 'Munster', 'Highland', 'Griffith',
      'Vincennes', 'Princeton', 'Mount Vernon', 'Newburgh', 'Boonville', 'La Porte', 'Chesterton',
      'Rensselaer', 'Lowell', 'Cedar Lake',
    ],
    CHI,
  ],
  [
    'KY',
    [
      'Paducah', 'Bowling Green', 'Owensboro', 'Hopkinsville', 'Henderson', 'Madisonville',
      'Murray', 'Mayfield', 'Glasgow', 'Franklin', 'Russellville', 'Princeton', 'Central City',
      'Cadiz', 'Fulton', 'Marion', 'Morgantown', 'Leitchfield', 'Hartford', 'Beaver Dam',
    ],
    CHI,
  ],
  [
    'TN',
    [
      'Knoxville', 'Chattanooga', 'Johnson City', 'Kingsport', 'Bristol', 'Cleveland',
      'Morristown', 'Oak Ridge', 'Maryville', 'Sevierville', 'Greeneville', 'Athens', 'Dayton',
      'Elizabethton', 'Harriman', 'Jefferson City', 'La Follette', 'Lenoir City', 'Newport',
      'Pigeon Forge', 'Alcoa', 'Farragut', 'Gatlinburg', 'Sweetwater', 'Rogersville', 'Erwin',
      'Crossville', 'Jamestown', 'Wartburg',
    ],
    NY,
  ],
  [
    'MI',
    ['Ironwood', 'Iron Mountain', 'Menominee', 'Kingsford', 'Bessemer', 'Wakefield', 'Norway', 'Iron River', 'Crystal Falls'],
    CHI,
  ],
  ['ND', ['Dickinson', 'Bowman', 'Beach', 'Hettinger', 'Medora'], DEN],
  [
    'SD',
    [
      'Rapid City', 'Spearfish', 'Sturgis', 'Belle Fourche', 'Hot Springs', 'Lead', 'Deadwood',
      'Custer', 'Box Elder', 'Wall', 'Philip', 'Kadoka', 'Martin', 'Pine Ridge', 'Ellsworth AFB',
      'Buffalo', 'Faith', 'Bison', 'Newell', 'Hill City', 'Keystone', 'Summerset', 'Edgemont',
    ],
    DEN,
  ],
  [
    'NE',
    [
      'Scottsbluff', 'Alliance', 'Chadron', 'Sidney', 'Kimball', 'Gering', 'Ogallala',
      'Bridgeport', 'Oshkosh', 'Crawford', 'Rushville', 'Gordon', 'Hemingford', 'Bayard',
      'Mitchell', 'Harrison', 'Hyannis', 'Arthur', 'Grant', 'Imperial', 'Benkelman',
    ],
    DEN,
  ],
  ['KS', ['Goodland', 'Sharon Springs', 'Tribune', 'Syracuse', 'Kanorado', 'Coolidge', 'Leoti'], DEN],
  [
    'ID',
    [
      "Coeur d'Alene", 'Lewiston', 'Moscow', 'Sandpoint', 'Post Falls', 'Hayden', 'Rathdrum',
      'Kellogg', 'Bonners Ferry', 'St. Maries', 'Orofino', 'Grangeville', 'Wallace',
      'Priest River', 'Spirit Lake', 'Plummer', 'Kamiah', 'Kootenai',
    ],
    LA,
  ],
  ['OR', ['Ontario', 'Vale', 'Nyssa', 'Jordan Valley'], DEN],
  ['NV', ['West Wendover', 'Jackpot', 'Owyhee', 'Mountain City', 'Jarbidge'], DEN],
  ['AZ', ['Tuba City', 'Kayenta', 'Chinle', 'Window Rock', 'Fort Defiance', 'Ganado', 'Many Farms'], DEN],
];

function normalizeCity(city: string): string {
  return city
    .trim()
    .toLowerCase()
    .replace(/\bst\.?\s+/g, 'saint ')
    .replace(/\bft\.?\s+/g, 'fort ')
    .replace(/\bmt\.?\s+/g, 'mount ')
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** `ST|city` → zone, built once from the rules above. */
const CITY_EXCEPTIONS: ReadonlyMap<string, string> = new Map(
  CITY_RULES.flatMap(([state, cities, zone]) =>
    cities.map((city): [string, string] => [`${state}|${normalizeCity(city)}`, zone]),
  ),
);

function normalizeState(state: string | null | undefined): string | null {
  if (!state) return null;
  const code = state.trim().toUpperCase();
  return code.length === 2 && code in STATE_ZONE ? code : null;
}

/** The three-digit ZIP prefix, or null when the value is not a US ZIP. */
export function zipPrefix(zip: string | null | undefined): number | null {
  if (!zip) return null;
  const digits = zip.trim().match(/^(\d{5})(?:-?\d{4})?$/)?.[1];
  return digits ? Number.parseInt(digits.slice(0, 3), 10) : null;
}

/** The state a ZIP belongs to, or null when the prefix is unallocated. */
export function stateOfZip(zip: string | null | undefined): string | null {
  const prefix = zipPrefix(zip);
  if (prefix === null) return null;
  return ZIP_RANGES.find(([from, to]) => prefix >= from && prefix <= to)?.[2] ?? null;
}

export function zoneOfZip(zip: string | null | undefined): string | null {
  const prefix = zipPrefix(zip);
  if (prefix === null) return null;
  const exception = ZIP_EXCEPTIONS.find(([from, to]) => prefix >= from && prefix <= to);
  if (exception) return exception[2];
  const state = stateOfZip(zip);
  return state ? (STATE_ZONE[state] ?? null) : null;
}

export function zoneOfCity(
  city: string | null | undefined,
  state: string | null | undefined,
): string | null {
  const code = normalizeState(state);
  if (!code) return null;
  if (city) {
    const exception = CITY_EXCEPTIONS.get(`${code}|${normalizeCity(city)}`);
    if (exception) return exception;
  }
  return STATE_ZONE[code] ?? null;
}

/**
 * The zone for a stop: ZIP, then city and state, then the state alone. The source says which,
 * so the backfill log can say "from ZIP" and a review can rank what it trusts.
 */
export function resolveStopZone(stop: {
  zip?: string | null;
  city?: string | null;
  state?: string | null;
}): ZoneResolution {
  const byZip = zoneOfZip(stop.zip);
  if (byZip) return { zone: byZip, source: 'zip' };
  const code = normalizeState(stop.state);
  if (!code) return { zone: null, source: 'unknown' };
  if (stop.city && CITY_EXCEPTIONS.has(`${code}|${normalizeCity(stop.city)}`)) {
    return { zone: CITY_EXCEPTIONS.get(`${code}|${normalizeCity(stop.city)}`) ?? null, source: 'city' };
  }
  return { zone: STATE_ZONE[code] ?? null, source: 'state' };
}

/** True when `zone` is a zone the runtime can format in. */
export function isKnownZone(zone: string | null | undefined): zone is string {
  if (!zone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}
