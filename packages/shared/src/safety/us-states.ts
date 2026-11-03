/**
 * The 50 US states and DC, as a violation paper names them (owner, 2026-10-21): the state that
 * issued the paper replaces the free-text "Issuing agency" on new records.
 */
export const US_STATE_NAMES = {
  AL: 'Alabama',
  AK: 'Alaska',
  AZ: 'Arizona',
  AR: 'Arkansas',
  CA: 'California',
  CO: 'Colorado',
  CT: 'Connecticut',
  DE: 'Delaware',
  DC: 'District of Columbia',
  FL: 'Florida',
  GA: 'Georgia',
  HI: 'Hawaii',
  ID: 'Idaho',
  IL: 'Illinois',
  IN: 'Indiana',
  IA: 'Iowa',
  KS: 'Kansas',
  KY: 'Kentucky',
  LA: 'Louisiana',
  ME: 'Maine',
  MD: 'Maryland',
  MA: 'Massachusetts',
  MI: 'Michigan',
  MN: 'Minnesota',
  MS: 'Mississippi',
  MO: 'Missouri',
  MT: 'Montana',
  NE: 'Nebraska',
  NV: 'Nevada',
  NH: 'New Hampshire',
  NJ: 'New Jersey',
  NM: 'New Mexico',
  NY: 'New York',
  NC: 'North Carolina',
  ND: 'North Dakota',
  OH: 'Ohio',
  OK: 'Oklahoma',
  OR: 'Oregon',
  PA: 'Pennsylvania',
  RI: 'Rhode Island',
  SC: 'South Carolina',
  SD: 'South Dakota',
  TN: 'Tennessee',
  TX: 'Texas',
  UT: 'Utah',
  VT: 'Vermont',
  VA: 'Virginia',
  WA: 'Washington',
  WV: 'West Virginia',
  WI: 'Wisconsin',
  WY: 'Wyoming',
} as const;

export type UsStateCode = keyof typeof US_STATE_NAMES;
export const US_STATE_CODES = Object.keys(US_STATE_NAMES) as [UsStateCode, ...UsStateCode[]];

/** "TN — Tennessee" for a known code; the stored text as it is for an old free-text value. */
export function usStateLabel(code: string | null | undefined): string {
  if (!code) return '';
  const name = (US_STATE_NAMES as Record<string, string>)[code.toUpperCase()];
  return name ? `${code.toUpperCase()} — ${name}` : code;
}
