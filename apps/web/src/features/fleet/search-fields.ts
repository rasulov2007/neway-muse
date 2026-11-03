import { z } from 'zod';

/**
 * A free-text search param that may arrive as a number.
 *
 * The router parses `?unit=2747` into the **number** 2747, and unit numbers, trailer numbers and
 * work-order references are all numeric-looking. A plain `z.string()` therefore rejects a perfectly
 * good link and blanks the page, which is exactly what happened the first time a fleet link was
 * followed. Coercing here — and catching, so a malformed param degrades to "no filter" rather than
 * an error screen — is the same treatment the tracking module already gives its `unit` param.
 */
export const searchText = z
  .union([z.string(), z.number()])
  .transform(String)
  .optional()
  .catch(undefined);

/** A page number, degrading to page one rather than erroring. */
export const searchPage = z.coerce.number().int().min(1).optional().catch(undefined);
