/**
 * "2022 Great Dane" from whatever parts are on record — never "null null".
 *
 * Most units imported from Ditat and Samsara carry no year, make or model, and the page used to
 * print the missing parts as the word "null". Missing parts are dropped with their separators.
 */
export function unitIdentity(
  parts: readonly (string | number | null | undefined)[],
): string {
  return parts
    .map((part) => (part === null || part === undefined ? '' : String(part).trim()))
    .filter((part) => part !== '' && part !== 'null' && part !== 'undefined' && part !== '0')
    .join(' ');
}

/** The line under a unit's title: "2022 Great Dane · VIN 1GR…", or only the parts that exist. */
export function unitHeaderLine(
  parts: readonly (string | number | null | undefined)[],
  vin: string | null | undefined,
): string {
  const identity = unitIdentity(parts);
  const vinPart = vin && vin.trim() ? `VIN ${vin.trim()}` : '';
  return [identity, vinPart].filter(Boolean).join(' · ');
}
