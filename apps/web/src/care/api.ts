import type { DriverCareConfig, DriverCareSubmissionInput } from '@neway/shared';

/**
 * The Driver Care page's own client. Never a session token or a cookie: a driver has none, and a
 * staff member testing the link while signed in must not have their session involved. Type
 * imports only from the shared package — no library code is bundled into this page.
 */

// A copy hosted elsewhere names the TMS on <html data-care-api="https://neway.example.com">.
const BASE = `${document.documentElement.dataset.careApi ?? ''}/api/v1/public/driver-care`;
const TIMEOUT_MS = 20_000;

/** Why a request was not saved. `fields` carries the server's message per field on a 422. */
export class SendError extends Error {
  constructor(
    message: string,
    readonly fields: Record<string, string> = {},
  ) {
    super(message);
    this.name = 'SendError';
  }
}

async function withTimeout(input: string, init: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    return await fetch(input, {
      ...init,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      headers: { accept: 'application/json', ...(init.headers ?? {}) },
    });
  } finally {
    window.clearTimeout(timer);
  }
}

const isString = (v: unknown): v is string => typeof v === 'string';

export async function loadConfig(
  slug: string,
): Promise<{ ok: true; config: DriverCareConfig } | { ok: false; closed: boolean }> {
  try {
    const res = await withTimeout(`${BASE}/${encodeURIComponent(slug)}`);
    if (res.status === 404) return { ok: false, closed: true };
    if (!res.ok) return { ok: false, closed: false };
    const json = (await res.json()) as Record<string, unknown>;
    if (!isString(json.companyName) || !isString(json.displayName)) return { ok: false, closed: false };
    return { ok: true, config: { companyName: json.companyName, displayName: json.displayName } };
  } catch {
    return { ok: false, closed: false };
  }
}

/**
 * Posts one request. Resolves with the reference only when the server answers 201 "received"
 * (it says so only after the request is saved); every other outcome throws a `SendError` whose
 * message is shown to the driver, with everything they typed left in place.
 */
export async function sendRequest(slug: string, body: DriverCareSubmissionInput): Promise<string | null> {
  let res: Response;
  try {
    res = await withTimeout(`${BASE}/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SendError('Your message was not sent. Check your connection and try again.');
  }
  const json: unknown = await res.json().catch(() => null);
  const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (res.status === 201 && record?.status === 'received') {
    return isString(record.reference) ? record.reference : null;
  }
  if (res.status === 422) {
    const fields: Record<string, string> = {};
    const errors = Array.isArray(record?.errors) ? (record.errors as { path?: unknown; message?: unknown }[]) : [];
    for (const e of errors) {
      const key = (isString(e.path) ? e.path : '').split('.')[0] ?? '';
      if (key && !fields[key]) fields[key] = isString(e.message) ? e.message : 'Check this answer.';
    }
    throw new SendError('Some answers need a second look.', fields);
  }
  if (res.status === 413) throw new SendError('That message is too long. Please shorten it.');
  if (res.status === 429) {
    throw new SendError(isString(record?.detail) ? record.detail : 'Too many attempts. Please wait and try again.');
  }
  if (res.status === 404) throw new SendError('This Driver Care link is no longer active. Please call the office.');
  throw new SendError('Your message could not be saved just now. Please try again.');
}

/** The slug from `/care/<slug>`, or null. */
export function slugFromPath(pathname: string): string | null {
  const match = /^\/care\/([^/?#]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
}

/** One id per filled-in form, kept in memory only: a retry reuses it, a new form gets a new one. */
export function newSubmissionId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
