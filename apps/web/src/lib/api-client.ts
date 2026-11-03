import { API_PREFIX, type ProblemDetails } from '@neway/shared';
import { syncClockFromHeader } from './clock';
import { clearSession, sessionToken } from './session';

/**
 * The HTTP client.
 *
 * Everything that has to outlive a browser tab goes through here. It is deliberately small: one
 * request function, one error type, and no retry logic — a failed write must surface as a failure
 * the user can see and act on, not be quietly retried until it looks like it worked.
 */

const BASE = `/${API_PREFIX}`;

/** Fired when the server answers 403 profile_required; the auth provider re-reads /auth/me. */
export const PROFILE_REQUIRED_EVENT = 'neway:profile-required';

/** A failure the server described. `detail` is written to be shown to a person. */
export class ApiError extends Error {
  readonly status: number;
  readonly title: string;
  readonly problem: ProblemDetails | null;
  /** Field-level validation failures, when the server sent any. */
  readonly issues: { path: string; message: string }[];

  constructor(status: number, title: string, detail: string, problem: ProblemDetails | null) {
    super(detail || title);
    this.name = 'ApiError';
    this.status = status;
    this.title = title;
    this.problem = problem;
    const raw = (problem as { errors?: unknown })?.errors;
    this.issues = Array.isArray(raw)
      ? raw.flatMap((issue) =>
          typeof issue === 'object' && issue !== null && 'message' in issue
            ? [
                {
                  path: String((issue as { path?: unknown }).path ?? ''),
                  message: String((issue as { message?: unknown }).message ?? ''),
                },
              ]
            : [],
        )
      : [];
  }
}

/**
 * Options for a single call.
 *
 * `background: true` means "this is housekeeping": a 401 from it must not be read as the session
 * having expired. The dataset hydration at boot is the case that matters - it ran before anything
 * rendered, and when it failed the 401 handler below cleared the token the user had just been
 * given and sent them back to the login screen, so signing in looked like it did nothing.
 */
export interface RequestOptions {
  background?: boolean;
  /** Extra request headers, e.g. `Idempotency-Key` on a create that must not run twice. */
  headers?: Record<string, string>;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<T> {
  let response: Response;
  try {
    const token = sessionToken();
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    // The session token goes on every request; the server decides whether it still means anything.
    if (token) headers.Authorization = `Bearer ${token}`;
    if (options?.headers) Object.assign(headers, options.headers);
    response = await fetch(`${BASE}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    // A network failure is not a validation failure and must not be reported as one.
    throw new ApiError(
      0,
      'Network error',
      'The server could not be reached. Nothing was saved.',
      null,
    );
  }

  // Every response teaches us the server's clock, so "now" and "today" are the server's, not the
  // browser's. A laptop running ten minutes fast must not make a work order look late.
  syncClockFromHeader(response.headers.get('date'));

  if (response.status === 204) return undefined as T;

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = null;
    }
  }

  if (!response.ok) {
    // A session the server no longer honours is dropped here rather than left to fail every
    // subsequent request the same way. An expired session also has to take the person back to the
    // login screen: leaving them on a page whose every request 401s looks like the app is broken.
    if (response.status === 401 && sessionToken() && !options?.background) {
      clearSession();
      const onAuthRoute = path.startsWith('/auth/');
      if (!onAuthRoute && typeof window !== 'undefined') {
        // Back to this page after signing in again.
        const here = window.location.pathname + window.location.search;
        window.location.assign(
          here.startsWith('/login') ? '/login' : `/login?next=${encodeURIComponent(here)}`,
        );
      }
    }
    const problem = (parsed ?? null) as ProblemDetails | null;

    // Complete your profile (2026-10-26): the server holds this session on the profile page. Ask
    // the auth provider to re-read who is signed in, which brings the gate up.
    if (
      response.status === 403 &&
      (problem as { code?: unknown } | null)?.code === 'profile_required' &&
      typeof window !== 'undefined'
    ) {
      window.dispatchEvent(new Event(PROFILE_REQUIRED_EVENT));
    }

    // A 404 on an API path is not a missing record — every route in this client exists in the
    // server it was built against. It means the server is running an older build, and saying so
    // is far more useful than repeating its raw "Cannot POST …" back to the person.
    if (response.status === 404 && !problem?.detail) {
      throw new ApiError(
        404,
        'Server is out of date',
        `This screen asked for ${method} ${path}, which the server does not have. It is running an older build than the app. Redeploy the API.`,
        problem,
      );
    }

    throw new ApiError(
      response.status,
      problem?.title ?? response.statusText,
      problem?.detail ?? `Request failed with ${response.status}`,
      problem,
    );
  }

  return parsed as T;
}

export function apiGet<T>(
  path: string,
  params?: Record<string, unknown>,
  options?: RequestOptions,
): Promise<T> {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  const suffix = query.size > 0 ? `?${query.toString()}` : '';
  return request<T>('GET', `${path}${suffix}`, undefined, options);
}

export function apiPost<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return request<T>('POST', path, body, options);
}

export function apiPut<T>(path: string, body: unknown, options?: RequestOptions): Promise<T> {
  return request<T>('PUT', path, body, options);
}

export function apiPatch<T>(path: string, body: unknown): Promise<T> {
  return request<T>('PATCH', path, body);
}

export function apiDelete<T>(path: string, options?: RequestOptions): Promise<T> {
  return request<T>('DELETE', path, undefined, options);
}
