import { t } from '../i18n/core';
import type { ProblemDetails } from '@neway/shared/problem';

import { noteServerDate } from '@/lib/clock';
import { API_URL } from '@/lib/config';

import { readToken, writeToken } from './token-store';

/**
 * The one door to the TMS API.
 *
 * Bearer token from the keychain; every error is RFC 7807 problem details turned into ApiError.
 * A 401 tells the session (which sends the person to login) but never touches drafts or the
 * upload queue: those wait for the same membership to sign in again.
 */
export type ApiErrorKind =
  | 'offline'
  | 'unauthorized'
  | 'forbidden'
  /** The route itself does not exist on this server yet (a later backend phase). */
  | 'not_connected'
  | 'not_found'
  | 'conflict'
  | 'invalid'
  | 'server';

export class ApiError extends Error {
  readonly kind: ApiErrorKind;
  readonly status: number;
  readonly title: string;
  readonly detail: string | undefined;

  constructor(kind: ApiErrorKind, status: number, title: string, detail?: string) {
    super(detail || title);
    this.kind = kind;
    this.status = status;
    this.title = title;
    this.detail = detail;
  }

  /** Worth trying again later without the person changing anything. */
  get retryable(): boolean {
    return this.kind === 'offline' || this.kind === 'server' || this.status === 429 || this.status === 408;
  }
}

let token: string | null = null;
let tokenLoaded = false;
const unauthorizedListeners = new Set<() => void>();

export async function loadToken(): Promise<string | null> {
  if (!tokenLoaded) {
    token = await readToken();
    tokenLoaded = true;
  }
  return token;
}

/** `persist: false` keeps the token in memory only ("Keep me signed in" unticked). */
export async function setToken(next: string | null, options?: { persist?: boolean }): Promise<void> {
  token = next;
  tokenLoaded = true;
  await writeToken(options?.persist === false ? null : next);
}

/** Whether the token is also kept in the keychain (so a later start can use it). */
export async function tokenIsStored(): Promise<boolean> {
  return Boolean(token) && (await readToken()) === token;
}

export function hasToken(): boolean {
  return Boolean(token);
}

/** The session listens here; the queue pauses through its own error handling. */
export function onUnauthorized(listener: () => void): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function emitUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

function kindFor(status: number, detail: string | undefined): ApiErrorKind {
  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) {
    // Nest answers an unknown route with "Cannot GET /api/v1/…"; a missing record says otherwise.
    return detail && /^Cannot (GET|POST|PATCH|PUT|DELETE) /.test(detail) ? 'not_connected' : 'not_found';
  }
  if (status === 405 || status === 501) return 'not_connected';
  if (status === 409 || status === 412) return 'conflict';
  if (status >= 400 && status < 500) return 'invalid';
  return 'server';
}

export function errorFromResponse(status: number, bodyText: string): ApiError {
  let problem: Partial<ProblemDetails> & { message?: string | string[] } = {};
  try {
    problem = JSON.parse(bodyText) as typeof problem;
  } catch {
    // not JSON — keep the status alone
  }
  const message = Array.isArray(problem.message) ? problem.message.join(' ') : problem.message;
  const detail = problem.detail ?? message;
  const title = problem.title ?? t('Request failed ({status})', { status });
  return new ApiError(kindFor(status, detail), status, title, detail);
}

export interface RequestOptions {
  body?: unknown;
  headers?: Record<string, string>;
  idempotencyKey?: string;
  signal?: AbortSignal;
  /** Leave the session alone on 401 (the login call itself). */
  quietUnauthorized?: boolean;
}

export async function request<T>(method: string, path: string, options: RequestOptions = {}): Promise<T> {
  const bearer = await loadToken();
  const headers: Record<string, string> = { Accept: 'application/json', ...options.headers };
  if (bearer) headers.Authorization = `Bearer ${bearer}`;
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  let body: string | undefined;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetch(`${API_URL}${path}`, { method, headers, body, signal: options.signal });
  } catch (error) {
    if ((error as { name?: string })?.name === 'AbortError') throw error;
    throw new ApiError('offline', 0, t('No connection'), t('The TMS could not be reached. Check the signal and try again.'));
  }
  noteServerDate(response.headers.get('date'));

  const text = await response.text();
  if (!response.ok) {
    const error = errorFromResponse(response.status, text);
    if (error.kind === 'unauthorized' && !options.quietUnauthorized) emitUnauthorized();
    throw error;
  }
  if (!text) return undefined as T;
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
}

export const api = {
  get: <T>(path: string, options?: RequestOptions) => request<T>('GET', path, options),
  post: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('POST', path, { ...options, body }),
  patch: <T>(path: string, body?: unknown, options?: RequestOptions) => request<T>('PATCH', path, { ...options, body }),
  delete: <T>(path: string, options?: RequestOptions) => request<T>('DELETE', path, options),
};

export interface UploadOptions {
  /** Local file (file://, content://, blob: or data: URI). */
  fileUri: string;
  fileName: string;
  contentType: string;
  idempotencyKey: string;
  /** Extra metadata headers, e.g. x-document-type. Values are URI-encoded by the caller if needed. */
  headers?: Record<string, string>;
  onProgress?: (fraction: number) => void;
}

/**
 * Sends one file as raw bytes (the API's /files/raw convention: name and type ride in headers),
 * with progress. XMLHttpRequest because fetch has no upload progress on React Native.
 */
export async function uploadRaw<T>(path: string, options: UploadOptions): Promise<T> {
  const bearer = await loadToken();
  let blob: Blob;
  try {
    blob = await (await fetch(options.fileUri)).blob();
  } catch {
    throw new ApiError('invalid', 0, t('File missing'), t('The photo is no longer on this phone. Take it again.'));
  }

  return new Promise<T>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${API_URL}${path}`);
    xhr.setRequestHeader('Accept', 'application/json');
    xhr.setRequestHeader('Content-Type', 'application/octet-stream');
    if (bearer) xhr.setRequestHeader('Authorization', `Bearer ${bearer}`);
    xhr.setRequestHeader('Idempotency-Key', options.idempotencyKey);
    xhr.setRequestHeader('x-file-name', encodeURIComponent(options.fileName));
    xhr.setRequestHeader('x-file-type', options.contentType);
    for (const [name, value] of Object.entries(options.headers ?? {})) xhr.setRequestHeader(name, value);

    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) options.onProgress?.(event.loaded / event.total);
    };
    xhr.onload = () => {
      noteServerDate(xhr.getResponseHeader('date'));
      const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
      if (xhr.status >= 200 && xhr.status < 300) {
        options.onProgress?.(1);
        try {
          resolve((text ? JSON.parse(text) : undefined) as T);
        } catch {
          resolve(text as unknown as T);
        }
        return;
      }
      const error = errorFromResponse(xhr.status, text);
      if (error.kind === 'unauthorized') emitUnauthorized();
      reject(error);
    };
    xhr.onerror = () =>
      reject(new ApiError('offline', 0, t('No connection'), t('The upload stopped. It will try again when the phone is online.')));
    xhr.ontimeout = xhr.onerror;
    xhr.send(blob);
  });
}
