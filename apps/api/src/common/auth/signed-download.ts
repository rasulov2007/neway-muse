import { createHmac, timingSafeEqual } from 'node:crypto';
import { SetMetadata } from '@nestjs/common';

/**
 * Documents that come from drivers and candidates - consent forms and their signed PDFs,
 * signatures, driver applications and their uploads, CDL images, medical cards, drug and alcohol
 * results, W-9s - are read ONLY through a short-lived signed link (owner, 2026-10-25).
 *
 * A route marked `@SignedDownload()` refuses a request that carries a session (bearer) and answers
 * only a request presented with a link from `GET /files/sign?path=…`. The link is an HMAC over the
 * exact path and query, the company, the user and the membership, valid five minutes. When it is
 * presented the request runs AS that user - every guard and every owner-record check in the
 * handler runs again - so a link never reaches more than its holder could. Issuing a link is
 * audited. A link cannot open any other route.
 */
export const SIGNED_DOWNLOAD_KEY = 'auth:signedDownload';
export const SignedDownload = (): MethodDecorator => SetMetadata(SIGNED_DOWNLOAD_KEY, true);

/** The query parameter a signed request carries. */
export const SIGNED_REQUEST_PARAM = 'sig';

export const SIGNED_REQUEST_TTL_MS = 5 * 60 * 1000;

export interface SignedRequestClaims {
  /** The exact request path with its query (without `sig`), e.g. `/api/v1/compliance/documents/doc_1/file`. */
  p: string;
  /** Company. */
  c: string;
  /** User. */
  u: string;
  /** Membership the principal is rebuilt from. */
  m: string;
  /** Expiry, epoch ms. */
  e: number;
}

const mac = (secret: string, payload: string) => createHmac('sha256', `neway-signed-request:${secret}`).update(payload).digest();

export function signRequest(secret: string, claims: SignedRequestClaims): string {
  const payload = Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url');
  return `${payload}.${mac(secret, payload).toString('base64url')}`;
}

export function verifyRequest(secret: string, token: string, now: number): SignedRequestClaims | null {
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = mac(secret, payload);
  const given = Buffer.from(signature, 'base64url');
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as SignedRequestClaims;
    if (typeof claims.p !== 'string' || typeof claims.c !== 'string' || typeof claims.u !== 'string' || typeof claims.m !== 'string' || typeof claims.e !== 'number') return null;
    return claims.e > now ? claims : null;
  } catch {
    return null;
  }
}

/** The request's path and query without the `sig` parameter, in their original order. */
export function unsignedTarget(url: string): { target: string; sig: string | null } {
  const q = url.indexOf('?');
  if (q < 0) return { target: url, sig: null };
  const path = url.slice(0, q);
  let sig: string | null = null;
  const kept: string[] = [];
  for (const part of url.slice(q + 1).split('&')) {
    if (!part) continue;
    const eq = part.indexOf('=');
    const name = decodeURIComponent(eq < 0 ? part : part.slice(0, eq));
    if (name === SIGNED_REQUEST_PARAM) sig = decodeURIComponent(eq < 0 ? '' : part.slice(eq + 1));
    else kept.push(part);
  }
  return { target: kept.length ? `${path}?${kept.join('&')}` : path, sig };
}

/** The link for a target: the target with `sig=<token>` appended. */
export function withSignature(target: string, token: string): string {
  return `${target}${target.includes('?') ? '&' : '?'}${SIGNED_REQUEST_PARAM}=${encodeURIComponent(token)}`;
}

/** Codes that may read documents from drivers and candidates: Safety, testing, the HR / recruiting manager. */
export const PERSONNEL_DOCUMENT_PERMISSIONS = ['compliance_sensitive.view', 'safety_testing.view', 'recruiting.manage'] as const;
