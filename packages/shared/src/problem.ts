import { z } from 'zod';

/**
 * RFC 7807 "Problem Details for HTTP APIs" body, extended with `requestId`.
 * Every error response of the API uses this shape with the
 * `application/problem+json` media type.
 */
export const ProblemDetailsSchema = z.object({
  /** URI reference identifying the problem type. `about:blank` for generic HTTP errors. */
  type: z.string().min(1).default('about:blank'),
  /** Short, human-readable summary of the problem type. */
  title: z.string().min(1),
  /** HTTP status code of the response. */
  status: z.number().int().min(100).max(599),
  /** Human-readable explanation specific to this occurrence. */
  detail: z.string().optional(),
  /** URI reference of the specific occurrence (the request path). */
  instance: z.string().optional(),
  /** Correlation id of the request that produced the problem. */
  requestId: z.string().optional(),
});

export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;
