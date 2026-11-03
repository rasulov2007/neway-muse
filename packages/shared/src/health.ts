import { z } from 'zod';

/** Response body of `GET /api/v1/health`. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  /** API package version (semver). */
  version: z.string().min(1),
  /** Seconds since the API process started. */
  uptimeSeconds: z.number().int().nonnegative(),
  /** ISO 8601 timestamp of the response. */
  timestamp: z.iso.datetime(),
});

export type HealthResponse = z.infer<typeof HealthResponseSchema>;
