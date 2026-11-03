import { sessionToken } from './session';
import {
  HealthResponseSchema,
  ProblemDetailsSchema,
  type HealthResponse,
  type ProblemDetails,
} from '@neway/shared';

export const API_BASE_URL = '/api/v1';

/** Error thrown for non-2xx responses. Carries the RFC 7807 problem details body. */
export class ApiError extends Error {
  readonly status: number;
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail ?? problem.title);
    this.name = 'ApiError';
    this.status = problem.status;
    this.problem = problem;
  }
}

interface Parser<T> {
  parse(input: unknown): T;
}

/**
 * Performs a request against the API and validates the JSON body with the given schema.
 *
 * The session token goes on every call. This client predates authentication and used to send
 * none: the dashboard identified itself with the `X-Demo-Role` impersonation header instead, which
 * worked only while the API handed an identity to anybody who asked. With authentication enforced
 * that header is ignored and every dashboard request answered 401 - the page opened and drew
 * nothing. Two clients in one app is the underlying problem; both now carry the same credential.
 */
export async function apiRequest<T>(
  path: string,
  schema: Parser<T>,
  init: RequestInit = {},
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json, application/problem+json');
  const token = sessionToken();
  if (token) headers.set('authorization', `Bearer ${token}`);

  const response = await fetch(`${API_BASE_URL}${path}`, { ...init, headers });
  if (!response.ok) {
    throw await toApiError(response);
  }
  return schema.parse(await response.json());
}

async function toApiError(response: Response): Promise<ApiError> {
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('json')) {
    const body: unknown = await response.json().catch(() => null);
    const parsed = ProblemDetailsSchema.safeParse(body);
    if (parsed.success) {
      return new ApiError(parsed.data);
    }
  }
  return new ApiError({
    type: 'about:blank',
    title: response.statusText || 'Request failed',
    status: response.status,
  });
}

export function getHealth(): Promise<HealthResponse> {
  return apiRequest('/health', HealthResponseSchema);
}
