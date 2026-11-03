import { apiGet, apiPatch, apiPost } from '@/lib/api-client';
import { markCreated } from '@/lib/recent-creates';
import { demoData } from './data';
import type { Load } from './types';

/**
 * Loads, served from the database (migration 0033).
 *
 * They were the last big collection the browser saved whole: every edit re-sent every load from
 * one tab's copy, and with eighteen dispatchers and a night shift that was two people's work
 * overwriting each other without either being told. Now the server holds one row per load, every
 * write is one load with a version check, and the browser never saves the collection again.
 *
 * `demoData.loads` is kept in step with what the server returns, replaced in place, because the
 * dashboard, notifications, accounting and the safety pages still resolve loads through that
 * array — the same arrangement trucks, drivers and trailers use in `roster-api`.
 */

interface WriteResponse {
  load: Load;
  collectionUpdatedAt: string;
}

function replaceInPlace(rows: Load[]): void {
  demoData.loads.length = 0;
  demoData.loads.push(...rows);
}

/** One load, put back where the array holds it — or added, when it is new. */
export function replaceLoad(load: Load): Load {
  const index = demoData.loads.findIndex((l) => l.id === load.id);
  if (index >= 0) demoData.loads[index] = load;
  else demoData.loads.unshift(load);
  return structuredClone(load);
}

let hydration: Promise<void> | null = null;
let fetchedAt = 0;
/**
 * How long a read of the collection stands before the next read goes back to the server. The
 * Daily Board, a colleague and the load page all write the same records; a screen must not keep
 * showing a load the way it was when the tab opened (rule 1.2). Short, so a click on a load
 * after a board write reads what the board wrote; long enough that one screen's several reads
 * share one fetch.
 */
const FRESH_MS = 5_000;

/**
 * Reads the loads, refetching once the last read is older than `FRESH_MS`. Every load read awaits
 * this, so a page that renders before the fetch lands shows a loading state rather than an
 * empty list — an empty list and a list that has not arrived yet are different answers and must
 * not look the same.
 */
/** The highest `L-<n>` the server has seen, hidden loads included - they keep their numbers. */
let highestUsedNumber = 0;
export function highestLoadNumberUsed(): number {
  return highestUsedNumber;
}

export function ensureLoads(): Promise<void> {
  if (hydration && fetchedAt !== 0 && Date.now() - fetchedAt > FRESH_MS) hydration = null;
  hydration ??= (async () => {
    const [rows, numbers] = await Promise.all([
      apiGet<Load[]>('/loads'),
      apiGet<{ highest: number }>('/loads/highest-number').catch(() => ({ highest: 0 })),
    ]);
    replaceInPlace(rows);
    highestUsedNumber = numbers.highest;
    fetchedAt = Date.now();
  })().catch((error: unknown) => {
    // A failed read must not be cached as success, or the session shows no loads and never retries.
    hydration = null;
    throw error;
  });
  return hydration;
}

/** Drops the cached read so the next one refetches. After a write from another screen. */
export function invalidateLoads(): void {
  hydration = null;
}

/**
 * Hands the browser its loads without a fetch, and counts them as read.
 *
 * For the test harness: the stubbed server and the page must hold the same rows, and a test that
 * edits a load in memory before writing must not have that edit thrown away by a lazy refetch on
 * the first read. Nothing in the app calls this.
 */
export function primeLoads(rows: Load[]): void {
  replaceInPlace(rows.map((row) => structuredClone(row)));
  hydration = Promise.resolve();
  // Primed rows are the test's truth; they never go stale on the clock.
  fetchedAt = 0;
}

/**
 * One load, read from the server now and put back in the collection. The load page reads this
 * way so a status the Daily Board moved a second ago is what the page shows, without a refresh.
 */
export async function fetchLoad(idOrNumber: string): Promise<Load | null> {
  await ensureLoads();
  const cached = demoData.loads.find((l) => l.id === idOrNumber || l.loadNumber === idOrNumber);
  if (!cached) return null;
  try {
    const fresh = await apiGet<Load>(`/loads/${encodeURIComponent(cached.id)}`);
    return replaceLoad(fresh);
  } catch {
    // A read that fails between two good ones shows the last good copy, never a blank.
    return structuredClone(cached);
  }
}

export async function refreshLoads(): Promise<void> {
  invalidateLoads();
  await ensureLoads();
}

/** Booking: the document the screen built, written by the server, id and time stamped there. */
export async function createLoadRecord(document: Load): Promise<Load> {
  const response = await apiPost<WriteResponse>('/loads', document);
  markCreated(response.load.id);
  return replaceLoad(response.load);
}

/** JSON with sorted keys, so two values compare as values rather than as key order. */
function canonical(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}
function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const source = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(source).sort().map((k) => [k, sortKeys(source[k])]));
  }
  return value;
}

/**
 * An edit: the fields that changed between what was stored and what the screen produced, and
 * nothing else. The server refuses status and assignment here; they have their own routes.
 */
export async function patchLoadRecord(stored: Load, draft: Load, summary?: string): Promise<Load> {
  const patch: Record<string, unknown> = {};
  for (const key of Object.keys(draft) as (keyof Load)[]) {
    // The timeline is the server's: it records the edit itself, and refuses one sent (owner, 2026-10-30:
    // a rate change came back "timeline cannot be changed through Edit").
    if (key === 'updatedAt' || key === 'timeline') continue;
    if (canonical(draft[key]) !== canonical(stored[key])) patch[key] = draft[key];
  }
  if (Object.keys(patch).length === 0) return structuredClone(stored);
  const response = await apiPatch<WriteResponse>(`/loads/${encodeURIComponent(stored.id)}`, {
    expectedUpdatedAt: stored.updatedAt,
    patch,
    ...(summary ? { summary } : {}),
  });
  return replaceLoad(response.load);
}

/** Putting a load on a driver and a truck, or taking it off them. The server moves the board. */
export async function assignLoadRecord(
  stored: Load,
  input: {
    driverId: string | null;
    driverName?: string | null;
    truckId?: string | null;
    truckUnit?: string | null;
    trailerId?: string | null;
    trailerUnit?: string | null;
    note?: string;
    recovery?: { fromDriverName: string; fromUnit: string; summary: string };
  },
): Promise<Load> {
  const response = await apiPost<WriteResponse>(`/loads/${encodeURIComponent(stored.id)}/assignment`, {
    ...input,
    expectedUpdatedAt: stored.updatedAt,
  });
  return replaceLoad(response.load);
}

/** Filing a document: the bytes are already stored; this records the paper on the load. */
export async function attachLoadDocumentRecord(
  stored: Load,
  input: {
    type: Load['documents'][number]['type'];
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    fileUrl: string;
    fileId: string;
    fileHash?: string | null;
    title?: string;
    stopId?: string | null;
    chargeAmount?: number | null;
    note?: string | null;
  },
): Promise<Load> {
  const response = await apiPost<WriteResponse>(`/loads/${encodeURIComponent(stored.id)}/documents`, {
    ...input,
    expectedUpdatedAt: stored.updatedAt,
  });
  return replaceLoad(response.load);
}
