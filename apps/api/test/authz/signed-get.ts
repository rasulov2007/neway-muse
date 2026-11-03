import type { NestFastifyApplication } from '@nestjs/platform-fastify';

/**
 * Opens a driver / candidate document the way the browser does (owner, 2026-10-25): ask
 * `GET /files/sign?path=` for a five-minute link with the caller's own headers, then fetch the link
 * (which carries no session at all). A refusal at either step is returned as that response, so a
 * test that expects 403 / 404 reads the same status it always did.
 */
export async function signedGet(app: NestFastifyApplication, url: string, headers: Record<string, string> = {}) {
  const sign = await app.inject({ method: 'GET', url: `/api/v1/files/sign?path=${encodeURIComponent(url)}`, headers });
  if (sign.statusCode !== 200) return sign;
  // A bearer that resolves to nobody: with AUTH_DEV_HEADERS on (tests only) a bare request would
  // otherwise act as the demo owner. The link must stand on its own.
  return app.inject({ method: 'GET', url: (sign.json() as { url: string }).url, headers: { authorization: 'Bearer no-session' } });
}

/** The driver / candidate document routes that open only through a signed link. */
const SIGNED_ROUTES = [
  /\/compliance\/documents\/[^/?]+\/file$/,
  /\/hiring\/cases\/[^/?]+\/documents\/[^/?]+\/file$/,
  /\/hiring\/cases\/[^/?]+\/dot-application\/link\/files\/[^/?]+$/,
  /\/hiring\/recruiting\/candidates\/[^/?]+\/driver-application\/(files\/[^/?]+|pdf|authorizations\/[^/?]+\/(pdf|signature))$/,
  /\/hiring\/recruiting\/candidates\/[^/?]+\/journey\/(consent\/(files\/[^/?]+|signature|documents\/[^/?]+\/pdf)|safety\/reports\/[^/?]+\/file)$/,
  /\/hiring\/safety-desk\/[^/?]+\/(consent\/(files\/[^/?]+|documents\/[^/?]+\/pdf)|reports\/[^/?]+\/file)$/,
];

export function isSignedDocumentUrl(url: string): boolean {
  const path = url.split('?')[0] ?? '';
  return SIGNED_ROUTES.some((re) => re.test(path));
}
