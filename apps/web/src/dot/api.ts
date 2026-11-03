import type {
  DotFieldProblem,
  DotLinkDocumentUploadInput,
  PublicDotApplication,
  SaveDotApplicationDraftInput,
} from '@neway/shared';

/**
 * The driver's DOT application page talks to the server through this, and only this. It never
 * sends a session token or a cookie: a driver has none, and a recruiter testing the link while
 * signed in must not have their session involved. The token in the address is the only key.
 */

const BASE = '/api/v1/public/dot-application';
const TIMEOUT_MS = 30_000;

/** Why something was not saved. `gone` is the one answer for an unknown, expired or turned-off link. */
export class DotLinkError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues: DotFieldProblem[] = [],
  ) {
    super(message);
    this.name = 'DotLinkError';
  }
  get gone(): boolean {
    return this.status === 404;
  }
}

/** The token in /dot/<token>, or '' when the address has none. */
export function tokenFromPath(path: string): string {
  const match = /^\/dot\/([^/?#]+)\/?$/.exec(path);
  return match?.[1] ?? '';
}

async function call<T>(token: string, path: string, init: RequestInit = {}): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(`${BASE}/${encodeURIComponent(token)}${path}`, {
      ...init,
      signal: controller.signal,
      credentials: 'omit',
      cache: 'no-store',
      referrerPolicy: 'no-referrer',
      headers: { accept: 'application/json', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
  } catch {
    throw new DotLinkError('Not saved — check your connection and try again.', 0);
  } finally {
    window.clearTimeout(timer);
  }
  const json: unknown = await res.json().catch(() => null);
  if (res.ok) return json as T;
  const body = (json && typeof json === 'object' ? json : {}) as { detail?: unknown; issues?: unknown };
  const detail = typeof body.detail === 'string' ? body.detail : 'Something went wrong. Please try again.';
  const issues = Array.isArray(body.issues) ? (body.issues as DotFieldProblem[]) : [];
  throw new DotLinkError(detail, res.status, issues);
}

export const dotApi = {
  load: (token: string) => call<PublicDotApplication>(token, ''),
  save: (token: string, body: SaveDotApplicationDraftInput) =>
    call<PublicDotApplication>(token, '', { method: 'PUT', body: JSON.stringify(body) }),
  submit: (token: string) => call<PublicDotApplication>(token, '/submit', { method: 'POST', body: '{}' }),
};

/**
 * Sends one file, reporting progress (0–1). XMLHttpRequest rather than fetch, because only it
 * reports upload progress — a CDL photo can take a while on a phone connection.
 */
export function uploadDocument(
  token: string,
  body: DotLinkDocumentUploadInput,
  onProgress: (fraction: number) => void,
): Promise<{ application: PublicDotApplication }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${BASE}/${encodeURIComponent(token)}/documents`);
    xhr.withCredentials = false;
    xhr.setRequestHeader('content-type', 'application/json');
    xhr.setRequestHeader('accept', 'application/json');
    xhr.timeout = 180_000;
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let json: unknown = null;
      try {
        json = JSON.parse(xhr.responseText);
      } catch {
        /* not JSON */
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve(json as { application: PublicDotApplication });
        return;
      }
      const detail = (json as { detail?: unknown } | null)?.detail;
      reject(new DotLinkError(typeof detail === 'string' ? detail : 'The file was not uploaded. Please try again.', xhr.status));
    };
    xhr.onerror = () => reject(new DotLinkError('The file was not uploaded — check your connection and try again.', 0));
    xhr.ontimeout = xhr.onerror;
    xhr.send(JSON.stringify(body));
  });
}

/** A file as base64 (without the `data:` prefix). */
export function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.onerror = () => reject(new DotLinkError('That file could not be read. Choose it again.', 0));
    reader.readAsDataURL(file);
  });
}
