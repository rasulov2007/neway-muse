/**
 * The upload / action queue, as pure rules (no storage, no network, no clock of its own).
 *
 * Every item belongs to one signed-in membership (companyId + membershipId) and carries the
 * idempotency key made when the draft was created, so a retry can never make a second record and
 * an item is never replayed under another account. Statuses are the five the driver sees:
 * Saved on phone · Waiting to upload · Uploading · Received by TMS · Upload failed.
 */

import { t } from '@/i18n/core';

export const QUEUE_STATUSES = ['saved', 'waiting', 'uploading', 'received', 'failed'] as const;
export type QueueStatus = (typeof QUEUE_STATUSES)[number];

const STATUS_LABEL_EN: Record<QueueStatus, string> = {
  saved: 'Saved on phone',
  waiting: 'Waiting to upload',
  uploading: 'Uploading',
  received: 'Received by TMS',
  failed: 'Upload failed',
};

/** The five words, read in the live language each time (getters). */
export const STATUS_LABEL: Record<QueueStatus, string> = Object.defineProperties(
  {},
  Object.fromEntries(QUEUE_STATUSES.map((s) => [s, { enumerable: true, get: () => t(STATUS_LABEL_EN[s]) }])),
) as Record<QueueStatus, string>;

/**
 * M1 kinds have their own senders; every M3/M4 driver write is a 'driver-post': its files go to
 * POST /driver/files first (each with its own derived Idempotency-Key), their ids are put into the
 * body, then the route is called with the item's key.
 */
export type QueueKind =
  | 'load-document'
  | 'pti'
  | 'stop-event'
  | 'load-ack'
  | 'breakdown'
  | 'reimbursement'
  | 'care'
  | 'referral'
  | 'vacation'
  | 'vacation-parked'
  | 'vacation-cancel'
  | 'driver-document'
  | 'safety-report'
  | 'conversation'
  | 'message';

export interface QueueScope {
  companyId: string;
  membershipId: string;
}

export interface QueueFile {
  /** Where the file sits on the phone until the TMS acknowledges it. */
  uri: string;
  name: string;
  type: string;
  size?: number | null;
  /** Where the uploaded file's id goes (a PTI checklist item key, for example). */
  tag?: string | null;
  /** This page has reached the server (a retry resumes after it). */
  done?: boolean;
  response?: unknown;
}

export interface QueueItem extends QueueScope {
  id: string;
  idempotencyKey: string;
  kind: QueueKind;
  /** What the list shows: "POD · Load #0244482". */
  title: string;
  subtitle?: string | null;
  payload: Record<string, unknown>;
  files: QueueFile[];
  status: QueueStatus;
  attempts: number;
  /** Epoch ms; null while saved or finished. */
  nextAttemptAt: number | null;
  /** A 401 stopped it: kept, waiting for the same membership to sign in again. */
  pausedForSignIn: boolean;
  lastError: string | null;
  /** 0..1 while uploading. */
  progress: number;
  result: unknown;
  /** The server's later review of what was received (reviewed / rejected + reason), when known. */
  review?: { state: string; label: string; reason?: string | null } | null;
  createdAt: number;
  updatedAt: number;
}

/** After this many failed tries in a row the item says "Upload failed" and waits for a person. */
export const MAX_AUTOMATIC_ATTEMPTS = 6;
const BASE_DELAY_MS = 5_000;
const MAX_DELAY_MS = 15 * 60_000;

export function backoffMs(attempts: number): number {
  if (attempts <= 0) return 0;
  return Math.min(BASE_DELAY_MS * 2 ** (attempts - 1), MAX_DELAY_MS);
}

export function sameScope(a: QueueScope, b: QueueScope | null | undefined): boolean {
  return Boolean(b) && a.companyId === b!.companyId && a.membershipId === b!.membershipId;
}

export interface NewItem {
  id: string;
  idempotencyKey: string;
  kind: QueueKind;
  title: string;
  subtitle?: string | null;
  payload: Record<string, unknown>;
  files: QueueFile[];
}

export function createItem(input: NewItem, scope: QueueScope, now: number): QueueItem {
  return {
    ...input,
    companyId: scope.companyId,
    membershipId: scope.membershipId,
    files: input.files.map((f) => ({ ...f, done: false })),
    status: 'saved',
    attempts: 0,
    nextAttemptAt: null,
    pausedForSignIn: false,
    lastError: null,
    progress: 0,
    result: null,
    review: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** The person pressed Send: hand it to the queue. */
export function submit(item: QueueItem, now: number): QueueItem {
  if (item.status !== 'saved') return item;
  return { ...item, status: 'waiting', nextAttemptAt: now, updatedAt: now };
}

/** Items this membership may send right now, oldest first. */
export function dueItems(items: QueueItem[], scope: QueueScope | null, now: number, online: boolean): QueueItem[] {
  if (!scope || !online) return [];
  return items
    .filter(
      (i) =>
        i.status === 'waiting' &&
        !i.pausedForSignIn &&
        sameScope(i, scope) &&
        (i.nextAttemptAt ?? 0) <= now,
    )
    .sort((a, b) => a.createdAt - b.createdAt);
}

/** When the next waiting item of this scope becomes due (for the timer), or null. */
export function nextWake(items: QueueItem[], scope: QueueScope | null): number | null {
  if (!scope) return null;
  let soonest: number | null = null;
  for (const i of items) {
    if (i.status !== 'waiting' || i.pausedForSignIn || !sameScope(i, scope)) continue;
    const at = i.nextAttemptAt ?? 0;
    if (soonest === null || at < soonest) soonest = at;
  }
  return soonest;
}

export function markUploading(item: QueueItem, now: number): QueueItem {
  return { ...item, status: 'uploading', progress: progressOf(item, 0), updatedAt: now };
}

export function progressOf(item: QueueItem, currentFraction: number): number {
  if (item.files.length === 0) return currentFraction;
  const done = item.files.filter((f) => f.done).length;
  return Math.min(1, (done + currentFraction) / item.files.length);
}

export function markFileDone(item: QueueItem, index: number, response: unknown, now: number): QueueItem {
  const files = item.files.map((f, i) => (i === index ? { ...f, done: true, response } : f));
  const next = { ...item, files, updatedAt: now };
  return { ...next, progress: progressOf(next, 0) };
}

export type Outcome =
  | { type: 'ok'; result: unknown }
  /** Try again later by itself (offline, server error, rate limit). */
  | { type: 'retry'; message: string }
  /** The TMS does not take this kind yet; keep it on the phone, try again slowly, never "failed". */
  | { type: 'not_ready'; message: string }
  /** Signed out: keep the item, pause until the same membership signs in. */
  | { type: 'auth' }
  /** The server refused what was sent; a person has to look. */
  | { type: 'fatal'; message: string };

export function applyOutcome(item: QueueItem, outcome: Outcome, now: number): QueueItem {
  switch (outcome.type) {
    case 'ok':
      return {
        ...item,
        status: 'received',
        progress: 1,
        result: outcome.result,
        lastError: null,
        nextAttemptAt: null,
        pausedForSignIn: false,
        updatedAt: now,
      };
    case 'retry': {
      const attempts = item.attempts + 1;
      if (attempts >= MAX_AUTOMATIC_ATTEMPTS) {
        return { ...item, status: 'failed', attempts, lastError: outcome.message, nextAttemptAt: null, updatedAt: now };
      }
      return {
        ...item,
        status: 'waiting',
        attempts,
        lastError: outcome.message,
        nextAttemptAt: now + backoffMs(attempts),
        updatedAt: now,
      };
    }
    case 'not_ready':
      return { ...item, status: 'waiting', lastError: outcome.message, nextAttemptAt: now + MAX_DELAY_MS, updatedAt: now };
    case 'auth':
      return {
        ...item,
        status: 'waiting',
        pausedForSignIn: true,
        lastError: t('Sign in again to upload. It is kept on this phone.'),
        nextAttemptAt: now,
        updatedAt: now,
      };
    case 'fatal':
      return { ...item, status: 'failed', lastError: outcome.message, nextAttemptAt: null, updatedAt: now };
  }
}

/** The person pressed Retry. */
export function retryNow(item: QueueItem, now: number): QueueItem {
  if (item.status !== 'failed' && item.status !== 'waiting') return item;
  return { ...item, status: 'waiting', attempts: 0, lastError: null, pausedForSignIn: false, nextAttemptAt: now, updatedAt: now };
}

/** Back online: everything waiting in this scope may go now instead of after its backoff. */
export function wakeOnReconnect(items: QueueItem[], scope: QueueScope | null, now: number): QueueItem[] {
  return items.map((i) =>
    i.status === 'waiting' && !i.pausedForSignIn && sameScope(i, scope) && (i.nextAttemptAt ?? 0) > now
      ? { ...i, nextAttemptAt: now, updatedAt: now }
      : i,
  );
}

/** The same membership signed in again: release what a 401 paused. Other accounts' items stay put. */
export function resumeAfterSignIn(items: QueueItem[], scope: QueueScope, now: number): QueueItem[] {
  return items.map((i) =>
    i.pausedForSignIn && sameScope(i, scope)
      ? { ...i, pausedForSignIn: false, lastError: null, nextAttemptAt: now, updatedAt: now }
      : i,
  );
}

/** The app was closed mid-upload: those items wait again (their finished pages stay finished). */
export function recoverInterrupted(items: QueueItem[], now: number): QueueItem[] {
  return items.map((i) => (i.status === 'uploading' ? { ...i, status: 'waiting', nextAttemptAt: now, updatedAt: now } : i));
}

/** Received items are kept a week for the driver to see, then dropped from the phone. */
export const RECEIVED_KEEP_MS = 7 * 24 * 60 * 60_000;

export function expired(item: QueueItem, now: number): boolean {
  return item.status === 'received' && now - item.updatedAt > RECEIVED_KEEP_MS;
}

/** What a failed request means for the queue, from the API error's kind. */
export function outcomeForError(error: { kind?: string; status?: number; message?: string; detail?: string }): Outcome {
  const message = error.detail || error.message || t('The upload did not go through.');
  switch (error.kind) {
    case 'unauthorized':
      return { type: 'auth' };
    case 'offline':
    case 'server':
      return { type: 'retry', message };
    case 'not_connected':
      return { type: 'not_ready', message: t('The TMS is not taking these from the app yet. It is kept on this phone.') };
    default:
      if (error.status === 429 || error.status === 408) return { type: 'retry', message };
      return { type: 'fatal', message };
  }
}

export function statusLabel(item: QueueItem): string {
  return STATUS_LABEL[item.status];
}
