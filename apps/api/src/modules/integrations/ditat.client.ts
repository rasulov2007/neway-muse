/**
 * The Ditat TMS, read over HTTP like any other provider.
 *
 * Credentials come from the environment and are never written anywhere: not into a log line, not
 * into a report, not into a commit. The token lives for an hour and is refreshed a minute before
 * it lapses, so a long import does not stop halfway.
 *
 * Only reads are implemented. This product takes data out of Ditat; it does not write back.
 */

const BASE = 'https://tmsapi01.ditat.net';

export interface DitatCredentials {
  accountId: string;
  clientId: string;
  clientSecret: string;
}

/** The credentials, or null when this deployment has no Ditat connection configured. */
export function ditatCredentials(): DitatCredentials | null {
  const accountId = process.env.DITAT_ACCOUNT_ID?.trim();
  const clientId = process.env.DITAT_CLIENT_ID?.trim();
  const clientSecret = process.env.DITAT_CLIENT_SECRET?.trim();
  if (!accountId || !clientId || !clientSecret) return null;
  return { accountId, clientId, clientSecret };
}

export class DitatClient {
  private token: string | null = null;
  private expiresAt = 0;

  constructor(private readonly credentials: DitatCredentials) {}

  private async authorization(): Promise<string> {
    if (this.token && Date.now() < this.expiresAt - 60_000) return `Bearer ${this.token}`;
    const res = await fetch(`${BASE}/identity-provider/${this.credentials.accountId}/connect/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
      }),
    });
    if (!res.ok) throw new Error(`Ditat refused the token request (${res.status}).`);
    const body = (await res.json()) as { access_token?: string; expires_in?: number };
    if (!body.access_token) throw new Error('Ditat returned no access token.');
    this.token = body.access_token;
    this.expiresAt = Date.now() + (body.expires_in ?? 3600) * 1000;
    return `Bearer ${this.token}`;
  }

  /**
   * One entity's whole export, as rows of strings keyed by the CSV header.
   *
   * A 429 backs off twice and then gives up rather than hammering a system this company still
   * runs its day on.
   */
  async export(entity: 'driver' | 'truck' | 'trailer' | 'customer' | 'carrier'): Promise<Record<string, string>[]> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${BASE}/api/tms/data/${entity}/export`, {
        headers: { Authorization: await this.authorization() },
      });
      if (res.status === 429 && attempt < 2) {
        await new Promise((r) => setTimeout(r, (attempt + 1) * 10_000));
        continue;
      }
      if (!res.ok) throw new Error(`Ditat ${entity} export failed (${res.status}).`);
      const body = (await res.json()) as { data?: string };
      return parseCsv(body.data ?? '');
    }
  }

  /** Every document filed against one driver, truck or trailer. Empty when it has none. */
  async documents(owner: DitatDocumentOwner, key: string): Promise<DitatDocument[]> {
    for (let attempt = 0; ; attempt += 1) {
      const res = await fetch(`${BASE}/api/tms/data/${owner}/${encodeURIComponent(key)}/document`, {
        headers: { Authorization: await this.authorization() },
      });
      if (res.status === 429 && attempt < 4) {
        // One list per owner means hundreds of calls in a row; this system still runs the day.
        await new Promise((r) => setTimeout(r, (attempt + 1) * 10_000));
        continue;
      }
      if (res.status === 404) return [];
      if (!res.ok) throw new Error(`Ditat ${owner} ${key} document list failed (${res.status}).`);
      const body: unknown = await res.json();
      const list = Array.isArray(body) ? body : ((body as { data?: unknown[] }).data ?? []);
      return list as DitatDocument[];
    }
  }

  /**
   * One document's bytes.
   *
   * The endpoint answers a redirect to storage, and a client that does not follow it reads zero
   * bytes and files an empty PDF — which looks like a document until somebody opens it.
   */
  async file(owner: DitatDocumentOwner, key: string, documentKey: string): Promise<Uint8Array> {
    const res = await fetch(
      `${BASE}/api/tms/data/${owner}/${encodeURIComponent(key)}/document/${encodeURIComponent(documentKey)}/file`,
      { headers: { Authorization: await this.authorization() }, redirect: 'follow' },
    );
    if (!res.ok) throw new Error(`Ditat ${owner} ${key} file ${documentKey} failed (${res.status}).`);
    return new Uint8Array(await res.arrayBuffer());
  }
}

/** One file filed against a driver, truck or trailer in Ditat. */
export interface DitatDocument {
  documentKey: string;
  fileName: string;
  documentFolderId: string;
  expireOn: string | null;
  [key: string]: unknown;
}

/** The entities that carry documents. */
export type DitatDocumentOwner = 'driver' | 'truck' | 'trailer';

/** A document list and a document's bytes, added to the client above. */
export interface DitatFiles {
  documents(owner: DitatDocumentOwner, key: string): Promise<DitatDocument[]>;
  file(owner: DitatDocumentOwner, key: string, documentKey: string): Promise<Uint8Array>;
}

/** A CSV reader that respects quotes, because addresses and descriptions contain commas. */
export function parseCsv(csv: string): Record<string, string>[] {
  const rows: string[][] = [];
  let cell = '';
  let row: string[] = [];
  let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const ch = csv[i];
    if (quoted) {
      if (ch === '"') {
        if (csv[i + 1] === '"') {
          cell += '"';
          i += 1;
        } else quoted = false;
      } else cell += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      row.push(cell);
      cell = '';
    } else if (ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (ch !== '\r') cell += ch;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  const header = rows.shift();
  if (!header) return [];
  return rows
    .filter((r) => r.some((c) => c.trim() !== ''))
    .map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}
