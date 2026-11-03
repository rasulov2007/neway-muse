import type { ApplyAttribution, PublicApplicationInput, PublicApplyConfig } from '@neway/shared';

/**
 * The public application's own client. It never sends a session token or a cookie: a driver has
 * none, and a recruiter testing the link while signed in must not have their session involved (or
 * cleared) by a public page. Type imports only — no library code is bundled into this page.
 */

// A copy hosted elsewhere names the TMS on <html data-apply-api="https://…">; here it is this site.
const BASE = `${document.documentElement.dataset.applyApi ?? ''}/api/v1/public/apply`;
const TIMEOUT_MS = 20_000;

/** Why a submission was not saved. `fields` carries the server's message per answer on a 422. */
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
const isStringOrNull = (v: unknown): v is string | null => v === null || typeof v === 'string';

function asConfig(json: unknown): PublicApplyConfig | null {
  if (!json || typeof json !== 'object') return null;
  const c = json as Record<string, unknown>;
  if (
    !isString(c.companyName) ||
    !isString(c.consentText) ||
    !isString(c.privacyPolicyUrl) ||
    !isStringOrNull(c.logoUrl ?? null) ||
    !isStringOrNull(c.shortName ?? null)
  ) {
    return null;
  }
  return {
    companyName: c.companyName,
    shortName: (c.shortName as string | null | undefined) ?? null,
    logoUrl: (c.logoUrl as string | null | undefined) ?? null,
    consentText: c.consentText,
    privacyPolicyUrl: c.privacyPolicyUrl,
  };
}

/** The link's look and wording. `closed` is a 404 (unknown or switched-off link). */
export async function loadConfig(
  slug: string,
): Promise<{ ok: true; config: PublicApplyConfig } | { ok: false; closed: boolean }> {
  try {
    const res = await withTimeout(`${BASE}/${encodeURIComponent(slug)}`);
    if (res.status === 404) return { ok: false, closed: true };
    if (!res.ok) return { ok: false, closed: false };
    const config = asConfig(await res.json());
    return config ? { ok: true, config } : { ok: false, closed: false };
  } catch {
    return { ok: false, closed: false };
  }
}

/**
 * Posts the application. Resolves only when the server answers 201 `{ status: 'received' }`;
 * every other outcome throws a `SendError` whose message is shown to the driver, with the answers
 * left exactly as they were.
 */
export async function postApplication(slug: string, body: PublicApplicationInput): Promise<void> {
  let res: Response;
  try {
    res = await withTimeout(`${BASE}/${encodeURIComponent(slug)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new SendError('Your application was not sent. Check your connection and try again.');
  }

  const json: unknown = await res.json().catch(() => null);
  const record = json && typeof json === 'object' ? (json as Record<string, unknown>) : null;
  if (res.status === 201 && record?.status === 'received') return;

  if (res.status === 422) {
    const fields: Record<string, string> = {};
    const errors = Array.isArray(record?.errors)
      ? (record.errors as { path?: unknown; message?: unknown }[])
      : [];
    for (const e of errors) {
      const key = (isString(e.path) ? e.path : '').split('.')[0] ?? '';
      if (key && !fields[key]) fields[key] = isString(e.message) ? e.message : 'Check this answer.';
    }
    throw new SendError('Some answers need a second look.', fields);
  }
  if (res.status === 429) {
    throw new SendError(
      isString(record?.detail) ? record.detail : 'Too many attempts. Please wait and try again.',
    );
  }
  if (res.status === 404) {
    throw new SendError('This application link is no longer active.');
  }
  throw new SendError('Your application could not be saved just now. Please try again.');
}

/** UTM parameters, ad click ids and the referrer, read once from the link the driver opened. */
export function readAttribution(): ApplyAttribution {
  const params = new URLSearchParams(window.location.search);
  const pick = (key: string, max = 200) => {
    const value = params.get(key)?.trim();
    return value ? value.slice(0, max) : null;
  };
  return {
    utmSource: pick('utm_source'),
    utmMedium: pick('utm_medium'),
    utmCampaign: pick('utm_campaign'),
    utmTerm: pick('utm_term'),
    utmContent: pick('utm_content'),
    fbclid: pick('fbclid', 500),
    gclid: pick('gclid', 500),
    referrer: document.referrer ? document.referrer.slice(0, 500) : null,
  };
}

/** The slug from `/apply/<slug>`, or null. */
export function slugFromPath(pathname: string): string | null {
  const match = /^\/apply\/([^/?#]+)\/?$/.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]).toLowerCase() : null;
}

/** A submission id for this filled-in form. Kept in memory only. */
export function newSubmissionId(): string {
  const c: Crypto = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  // Older in-app browsers: RFC 4122 v4 from getRandomValues.
  const b = c.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

/** Up to two initials for a company with no logo: "NORTHWIND FREIGHT INC" → "US". */
export function initials(name: string): string {
  const words = name.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w));
  return words
    .slice(0, 2)
    .map((w) => w.charAt(0).toUpperCase())
    .join('');
}
