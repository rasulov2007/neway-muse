/**
 * Where the TMS API lives. EXPO_PUBLIC_* values are inlined at build time (eas.json sets them per
 * profile); the default is the local staging API used in development.
 */
const fallback = 'http://localhost:3200/api/v1';

export const API_URL: string = (process.env.EXPO_PUBLIC_API_URL || fallback).replace(/\/+$/, '');

export const APP_NAME = 'NeWay TMS';

/**
 * A link the API hands out (a signed file link is "/api/v1/files/signed?t=…") made absolute for
 * the phone: the API's own origin in front. On the web build (API_URL "/api/v1") it stays relative.
 */
export function absoluteUrl(url: string): string {
  if (/^[a-z]+:/i.test(url)) return url;
  const origin = API_URL.replace(/\/api\/v1$/, '');
  return `${origin}${url.startsWith('/') ? '' : '/'}${url}`;
}
