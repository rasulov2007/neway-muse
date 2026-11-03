import type { DotAppAnswers, DotAppDriverState, DotAppMissingItem, DotAppPublicGate, DotAppSignatureView, DotAppUploadSlot, DotAppUploadView } from '@neway/shared';

/**
 * Everything the driver page sends goes through here. The link's token is the key (it stays in the
 * fragment of the address; it is put in the request path only). After the 6-digit code the session
 * travels in `x-dot-app-session`. No cookies, no credentials of a TMS user.
 */

const BASE = '/api/v1/public/driver-application-v2';
const TIMEOUT_MS = 30_000;

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly ext: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiError';
  }
  get code(): string | undefined {
    return typeof this.ext.code === 'string' ? this.ext.code : undefined;
  }
  /** 0 = the request never reached the server (offline, timeout). */
  get network(): boolean {
    return this.status === 0;
  }
}

// ------------------------------------------------------------------ session (localStorage: the session value only)

async function tokenKey(token: string): Promise<string> {
  try {
    const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`dot-app:${token}`));
    return [...new Uint8Array(d)].slice(0, 12).map((b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let h = 0x811c9dc5;
    for (const c of `dot-app:${token}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
    return h.toString(16);
  }
}

export async function loadSession(token: string): Promise<string | null> {
  try {
    return localStorage.getItem(`neway-dotapp:${await tokenKey(token)}`);
  } catch {
    return null;
  }
}
export async function saveSession(token: string, session: string | null): Promise<void> {
  try {
    const k = `neway-dotapp:${await tokenKey(token)}`;
    if (session) localStorage.setItem(k, session);
    else localStorage.removeItem(k);
  } catch {
    /* private mode: the session lives in memory only */
  }
}

// ------------------------------------------------------------------ requests

async function readError(r: Response): Promise<ApiError> {
  let body: Record<string, unknown> = {};
  try {
    body = (await r.json()) as Record<string, unknown>;
  } catch {
    /* not JSON */
  }
  const detail = typeof body.detail === 'string' ? body.detail : typeof body.error === 'string' ? body.error : r.statusText || 'Something went wrong.';
  return new ApiError(detail, r.status, body);
}

export class DotAppClient {
  session: string | null = null;
  constructor(readonly token: string) {}

  setSession(session: string | null): void {
    this.session = session;
  }

  private url(path = ''): string {
    return `${BASE}/${encodeURIComponent(this.token)}${path}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { Accept: 'application/json', ...(this.session ? { 'x-dot-app-session': this.session } : {}), ...extra };
  }

  async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r: Response;
    try {
      r = await fetch(this.url(path), {
        method,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: ctl.signal,
        headers: this.headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ApiError('You appear to be offline.', 0);
    } finally {
      clearTimeout(timer);
    }
    if (!r.ok) throw await readError(r);
    return (await r.json()) as T;
  }

  gate(): Promise<DotAppPublicGate> {
    return this.request('GET', '');
  }
  sendCode(): Promise<{ sent: boolean; resendInSeconds: number; maskedEmail: string }> {
    return this.request('POST', '/code', {});
  }
  verify(code: string): Promise<{ session: string }> {
    return this.request('POST', '/verify', { code });
  }
  state(): Promise<DotAppDriverState> {
    return this.request('GET', '/application');
  }
  save(
    version: number,
    answers: DotAppAnswers,
    ssn?: string,
    bank?: { routing: string; account: string },
  ): Promise<{ version: number; lastSavedAt: string; ssnOnFile: boolean; ssnLast4: string | null; bankOnFile: boolean; bankLast4: string | null; missing: DotAppMissingItem[] }> {
    return this.request('PUT', '/application', { version, answers, ...(ssn ? { ssn } : {}), ...(bank ? { bank } : {}) });
  }

  /** The driver's own signature image on file, as a blob URL (to show it again after a reload). */
  async signatureUrl(key: string): Promise<string> {
    const r = await fetch(this.url(`/signatures/${encodeURIComponent(key)}/image`), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: this.headers() });
    if (!r.ok) throw await readError(r);
    return URL.createObjectURL(await r.blob());
  }
  sign(input: { key: string; docVersion: string; typedName: string; image: string }): Promise<DotAppSignatureView> {
    return this.request('POST', '/signatures', { ...input, esignConsent: true });
  }
  submit(version: number): Promise<DotAppDriverState> {
    return this.request('POST', '/submit', { version });
  }
  removeUpload(fileId: string): Promise<{ removed: true }> {
    return this.request('POST', `/uploads/${encodeURIComponent(fileId)}/remove`, {});
  }

  /** The driver's own file, as a blob URL (for a thumbnail). */
  async fileUrl(fileId: string): Promise<string> {
    const r = await fetch(this.url(`/uploads/${encodeURIComponent(fileId)}`), { credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store', headers: this.headers() });
    if (!r.ok) throw await readError(r);
    return URL.createObjectURL(await r.blob());
  }

  /** Raw bytes with progress (XMLHttpRequest: fetch has no upload progress). */
  upload(slot: DotAppUploadSlot, file: File, onProgress: (pct: number) => void): { done: Promise<DotAppUploadView>; abort: () => void } {
    const xhr = new XMLHttpRequest();
    const done = new Promise<DotAppUploadView>((resolve, reject) => {
      xhr.open('POST', this.url(`/uploads/${slot}`));
      xhr.setRequestHeader('Content-Type', 'application/octet-stream');
      xhr.setRequestHeader('Accept', 'application/json');
      xhr.setRequestHeader('x-file-name', encodeURIComponent(file.name));
      if (this.session) xhr.setRequestHeader('x-dot-app-session', this.session);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(xhr.responseText || '{}') as Record<string, unknown>;
        } catch {
          /* not JSON */
        }
        if (xhr.status >= 200 && xhr.status < 300) resolve(body as unknown as DotAppUploadView);
        else reject(new ApiError(typeof body.detail === 'string' ? body.detail : 'Upload failed.', xhr.status, body));
      };
      xhr.onerror = () => reject(new ApiError('Upload failed.', 0));
      xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0));
      xhr.timeout = 5 * 60_000;
      xhr.ontimeout = () => reject(new ApiError('Upload timed out.', 0));
      xhr.send(file);
    });
    return { done, abort: () => xhr.abort() };
  }
}

/** The old application page (/application-legacy/): is this token one of its links? */
export async function legacyTokenValid(token: string): Promise<boolean> {
  try {
    const r = await fetch('/api/v1/public/driver-application/context', {
      method: 'POST',
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token }),
    });
    // 403 = the old link is bound to another device: the old page explains that itself.
    return r.ok || r.status === 403;
  } catch {
    return false;
  }
}

// ------------------------------------------------------------------ client-side file checks

export const MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export function uploadProblem(file: { name: string; type: string; size: number }): string | null {
  const okType = /^image\//.test(file.type) || file.type === 'application/pdf' || /\.(heic|heif|pdf|jpe?g|png)$/i.test(file.name);
  if (!okType) return 'Please upload a photo or PDF.';
  if (file.size > MAX_UPLOAD_BYTES) return 'File is larger than 15 MB.';
  if (file.size === 0) return 'The file is empty.';
  return null;
}
