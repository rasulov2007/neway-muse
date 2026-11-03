/**
 * Every page's writes survive a refresh, in PostgreSQL - and reach every other open browser.
 *
 * The operational dataset is still generated client-side per session; this module keeps it in
 * the API's `app_state` store, **one row per collection**, and lays the rows back over the
 * generated data at boot. Trucks and drivers are excluded - the roster lives in its own tables
 * and re-hydrates through `roster-api`.
 *
 * Why one row per collection: the snapshot used to be a single blob, and in production it had
 * grown to 17.5 MB (15.5 MB of it invoice PDFs riding inside work orders as base64). Every
 * broker create re-sent all of it and every boot re-read all of it; a save in flight queued every
 * other request behind it, which is what "everything is slow and my broker never shows up" was.
 * Now a write sends the collections that changed - a few KB - and file bytes never enter the
 * snapshot at all (see `lib/files.ts`).
 *
 * Other browsers: the index of rows (key + updatedAt, no values) is polled while the tab is
 * visible. A row another browser changed is re-read and merged three ways - their rows, our
 * unsaved rows, and the copy both started from - so a record created here is never lost to a
 * record created there, and neither side has to reload.
 */
import {
  LEGACY_WORKSPACE_FILES_KEY,
  LEGACY_WORKSPACE_KEY,
  WORKSPACE_COLLECTIONS,
  WORKSPACE_PREFIX,
  canWriteWorkspaceKey,
  workspaceKey,
  type AuthAccount,
} from '@neway/shared';
import { ApiError, apiGet, apiPut } from '@/lib/api-client';
import { demoData } from './data';
import type { LoadDocument } from './types';
import { migrateWorkspaceLoads } from './loads-migration';
import { ensureLoads } from './loads-api';
import { migrateWorkOrderVendors } from './vendor-migration';

/** One row per collection; the names and keys are shared with the API (`@neway/shared`). */
const PREFIX = WORKSPACE_PREFIX;
const LEGACY_KEY = LEGACY_WORKSPACE_KEY;
const LEGACY_FILES_KEY = LEGACY_WORKSPACE_FILES_KEY;
const SAVE_EVERY_MS = 20_000;
const POLL_EVERY_MS = 10_000;

/**
 * Collections the store owns, from the list the API reads them back with. Typed as keys of the
 * dataset, so a name that drifts from the client's own shape fails to compile here rather than
 * quietly saving nothing. The roster (trucks, drivers) is NOT here.
 */
export const PERSISTED: readonly (keyof typeof demoData)[] = WORKSPACE_COLLECTIONS;

export function collectionKey(name: string): string {
  return workspaceKey(name);
}

function collectionOf(key: string): keyof typeof demoData | null {
  return PERSISTED.find((name) => collectionKey(name) === key) ?? null;
}

/** The last copy of each collection this browser knows the server has, and when it was written. */
interface Synced {
  json: string;
  updatedAt: string | null;
}
const synced = new Map<string, Synced>();

/**
 * Autosave is **off** until a read succeeds. The generated dataset is not the workspace: writing
 * it over a real one is how a day's work reverted to demo data minutes after it was entered.
 */
let maySave = false;
let saving: Promise<void> | null = null;

/**
 * The signed-in worker's permission codes, read at hydration. Every workspace key has its own read
 * and write codes on the server (@neway/shared workspace/access.ts, owner 2026-10-25); a collection
 * this worker may not write is never sent, rather than refused every twenty seconds. Null when the
 * account could not be read: the server still decides, the browser just does not pre-filter.
 */
let permissions: readonly string[] | null = null;

/** Whether this browser should try to save `key` at all. */
export function maySaveKey(key: string, held: readonly string[] | null = permissions): boolean {
  return held === null || canWriteWorkspaceKey(held, key);
}
let onRemoteChange: (() => void) | null = null;

/** Drops file bytes that a pre-file-store record may still carry in memory. */
function withoutBytes(_key: string, value: unknown): unknown {
  return _key === 'dataUrl' && typeof value === 'string' && value.startsWith('data:')
    ? undefined
    : value;
}

function serialize(name: keyof typeof demoData): string {
  return JSON.stringify(demoData[name], withoutBytes);
}

/** Replaces a collection in place: every module already holds a reference to it. */
function overlay(name: keyof typeof demoData, rows: unknown): void {
  const target = demoData[name];
  if (Array.isArray(rows) && Array.isArray(target)) {
    target.length = 0;
    target.push(...(rows as never[]));
  } else if (
    rows &&
    typeof rows === 'object' &&
    !Array.isArray(rows) &&
    target &&
    typeof target === 'object' &&
    !Array.isArray(target)
  ) {
    Object.assign(target as object, rows);
  }
}

// ---------------------------------------------------------------- three-way merge

type Row = Record<string, unknown>;

function rowId(row: unknown): string | null {
  if (!row || typeof row !== 'object') return null;
  const id = (row as Row).id;
  return typeof id === 'string' || typeof id === 'number' ? String(id) : null;
}

function byId(rows: unknown[]): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const row of rows) {
    const id = rowId(row) ?? JSON.stringify(row);
    map.set(id, row);
  }
  return map;
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/**
 * Their copy, our copy, and the copy both started from.
 *
 * A row only we changed keeps our version; a row only they changed takes theirs; a row both
 * changed takes theirs (the saved one), because a reload would have shown it anyway. A row we
 * created and they never saw is kept; a row they deleted is dropped. Order follows theirs, with
 * our new rows at the end.
 */
export function mergeRows(base: unknown[], theirs: unknown[], ours: unknown[]): unknown[] {
  const baseMap = byId(base);
  const ourMap = byId(ours);
  const theirMap = byId(theirs);
  const out: unknown[] = [];
  for (const [id, theirRow] of theirMap) {
    const ourRow = ourMap.get(id);
    const baseRow = baseMap.get(id);
    if (ourRow === undefined) {
      // We never had it (they created it), or we deleted it since the base.
      if (!baseMap.has(id)) out.push(theirRow);
      continue;
    }
    const weChanged = !same(ourRow, baseRow);
    const theyChanged = !same(theirRow, baseRow);
    out.push(weChanged && !theyChanged ? ourRow : theirRow);
  }
  for (const [id, ourRow] of ourMap) {
    if (theirMap.has(id)) continue;
    // Absent from theirs: ours if we created it, gone if they deleted it.
    if (!baseMap.has(id)) out.push(ourRow);
  }
  return out;
}

/**
 * Collections whose rows carry a number people read and quote. Two browsers that both mint
 * "the next one" from their own copy mint the same one; after a merge both rows survive and the
 * number stops identifying anything. The row the server already holds keeps its number, and the
 * one created here is moved up to the next free one.
 */
const NUMBERED: Partial<Record<keyof typeof demoData, { field: string; prefix: string }>> = {
  repairOrders: { field: 'roNumber', prefix: 'RO-' },
};

function renumberLocalDuplicates(
  name: keyof typeof demoData,
  merged: unknown[],
  theirs: unknown[],
): void {
  const spec = NUMBERED[name];
  if (!spec) return;
  const numberOf = (row: unknown) => String((row as Row)[spec.field] ?? '');
  const digitsOf = (value: string) => Number.parseInt(value.replace(spec.prefix, ''), 10);
  const theirIds = new Set([...byId(theirs).keys()]);
  const taken = new Set(merged.map(numberOf));
  let highest = merged.reduce<number>((max, row) => {
    const n = digitsOf(numberOf(row));
    return Number.isNaN(n) ? max : Math.max(max, n);
  }, 0);
  const seen = new Set<string>();
  for (const row of merged) {
    const value = numberOf(row);
    if (!seen.has(value)) {
      seen.add(value);
      continue;
    }
    const id = rowId(row);
    // Only a row this browser created moves; the saved one keeps the number people have seen.
    if (id === null || theirIds.has(id)) continue;
    highest += 1;
    let next = `${spec.prefix}${highest}`;
    while (taken.has(next)) {
      highest += 1;
      next = `${spec.prefix}${highest}`;
    }
    (row as Row)[spec.field] = next;
    taken.add(next);
    seen.add(next);
  }
}

function mergeObjects(base: Row, theirs: Row, ours: Row): Row {
  const out: Row = { ...theirs };
  for (const key of new Set([...Object.keys(ours), ...Object.keys(theirs)])) {
    const weChanged = !same(ours[key], base[key]);
    const theyChanged = !same(theirs[key], base[key]);
    if (weChanged && !theyChanged) out[key] = ours[key];
  }
  return out;
}

function mergeInto(name: keyof typeof demoData, theirsJson: string): void {
  const key = collectionKey(name);
  const theirs = JSON.parse(theirsJson) as unknown;
  const baseJson = synced.get(key)?.json;
  const base = baseJson ? (JSON.parse(baseJson) as unknown) : null;
  const ours = JSON.parse(serialize(name)) as unknown;
  if (Array.isArray(theirs) && Array.isArray(ours)) {
    const merged = mergeRows(Array.isArray(base) ? base : [], theirs, ours);
    renumberLocalDuplicates(name, merged, theirs);
    overlay(name, merged);
  } else if (theirs && typeof theirs === 'object' && ours && typeof ours === 'object') {
    overlay(name, mergeObjects((base as Row) ?? {}, theirs as Row, ours as Row));
  } else {
    overlay(name, theirs);
  }
}

// ---------------------------------------------------------------- hydrate

interface StoredRow {
  key: string;
  value: string;
  updatedAt: string;
}

/**
 * The workspace is on its way. Every read waits for this.
 *
 * Render starts before the workspace has landed, so without this a page opened directly - a
 * reload, a pasted link, a Playwright `goto` - answered from the generated dataset and then kept
 * that answer: the refetch that hydration asks for is deduplicated against the one already in
 * flight. A person who created a record and reloaded saw it missing, which is most of what
 * "records surface only after a refresh, minutes later" was.
 *
 * Null until hydration starts, so tests that never hydrate are not made to wait for it.
 */
let hydrating: Promise<void> | null = null;

/**
 * The hydration still to finish, or null once it has. Null is the steady state, so a read after
 * boot costs nothing at all - not even a tick.
 */
export function pendingHydration(): Promise<void> | null {
  return hydrating;
}

/** Load the workspace over the generated dataset. Call once, before render. */
export function initPersistedState(): Promise<void> {
  // The loads come from their own table now; they ride the same boot so every read that awaits
  // hydration also has them, and a screen never answers from the generated ones in between.
  const run = hydrate()
    .then(() => ensureLoads())
    .catch(() => undefined)
    .finally(() => {
      hydrating = null;
    });
  hydrating = run;
  return run;
}

async function hydrate(): Promise<void> {
  maySave = false;
  synced.clear();
  permissions = await apiGet<AuthAccount>('/auth/me', undefined, { background: true })
    .then((account) => (Array.isArray(account?.permissions) ? account.permissions : null))
    .catch(() => null);
  let index: { key: string; updatedAt: string }[];
  try {
    index = await apiGet<{ key: string; updatedAt: string }[]>(
      '/state',
      { prefix: PREFIX },
      { background: true },
    );
  } catch {
    // Not signed in, API down, or an older server: nothing is read, so nothing is saved.
    return;
  }

  const known = index.filter((row) => collectionOf(row.key));
  if (known.length === 0) {
    await hydrateLegacy();
    return;
  }
  const rows = await apiGet<StoredRow[]>(
    '/state',
    { keys: known.map((row) => row.key).join(',') },
    { background: true },
  );
  for (const row of rows) {
    const name = collectionOf(row.key);
    if (!name) continue;
    try {
      overlay(name, JSON.parse(row.value));
      synced.set(row.key, { json: row.value, updatedAt: row.updatedAt });
    } catch {
      // One unreadable collection keeps its generated rows; saving it is refused below.
      synced.set(row.key, { json: serialize(name), updatedAt: row.updatedAt });
    }
  }
  migrateWorkOrderVendors(demoData);
  migrateWorkspaceLoads(demoData);
  maySave = true;
}

/**
 * The single-blob workspace, read only while no split rows exist. The API splits it on its own
 * boot; this path covers a server that has not run that yet, and a brand-new workspace.
 */
async function hydrateLegacy(): Promise<void> {
  const [snapshot, files] = await Promise.allSettled([
    apiGet<{ value: string }>(`/state/${LEGACY_KEY}`, undefined, { background: true }),
    apiGet<{ value: string }>(`/state/${LEGACY_FILES_KEY}`, undefined, { background: true }),
  ]);
  if (snapshot.status === 'fulfilled') {
    try {
      const saved = JSON.parse(snapshot.value.value) as Record<string, unknown>;
      for (const name of PERSISTED) if (name in saved) overlay(name, saved[name]);
      if (files.status === 'fulfilled') {
        try {
          overlayFiles(JSON.parse(files.value.value) as Record<string, LoadDocument[]>);
        } catch {
          // Files that will not parse are left behind; the loads keep their records.
        }
      }
      migrateWorkOrderVendors(demoData);
      migrateWorkspaceLoads(demoData);
      // Nothing is synced yet: the first save writes every collection as split rows.
      maySave = true;
    } catch {
      // A snapshot that will not parse is worse than none: saving stays off.
    }
  } else if (snapshot.reason instanceof ApiError && snapshot.reason.status === 404) {
    // Nothing saved yet - a new workspace; the first save creates it.
    migrateWorkspaceLoads(demoData);
    maySave = true;
  }
}

function overlayFiles(files: Record<string, LoadDocument[]>): void {
  for (const load of demoData.loads) {
    const saved = files[load.loadNumber];
    if (!saved) continue;
    for (const doc of saved) {
      const existing = load.documents.find((d) => d.type === doc.type);
      if (existing) Object.assign(existing, doc, { id: existing.id });
      else load.documents.push(doc);
    }
  }
}

// ---------------------------------------------------------------- save

/** A write that lands while a save is in flight is saved right after it, not at the next tick. */
let queued = false;

async function saveIfChanged(): Promise<void> {
  if (!maySave) return;
  if (saving) {
    // The in-flight save serialised before this write happened; run once more when it is done,
    // and let a caller waiting on us see that second run land too.
    queued = true;
    return saving.then(() => saving ?? Promise.resolve());
  }
  saving = (async () => {
    const dirty = PERSISTED.filter((name) => {
      if (!maySaveKey(collectionKey(name))) return false;
      const json = serialize(name);
      return json !== synced.get(collectionKey(name))?.json;
    });
    await Promise.all(dirty.map((name) => saveCollection(name)));
  })().finally(() => {
    saving = null;
    if (queued) {
      queued = false;
      void saveIfChanged();
    }
  });
  return saving;
}

async function saveCollection(name: keyof typeof demoData, retry = true): Promise<void> {
  const key = collectionKey(name);
  const json = serialize(name);
  const known = synced.get(key);
  try {
    const result = await apiPut<{ updatedAt?: string }>(
      `/state/${key}`,
      { value: json, ifUnchangedSince: known?.updatedAt ?? undefined },
      { background: true },
    );
    synced.set(key, { json, updatedAt: result?.updatedAt ?? known?.updatedAt ?? null });
  } catch (error) {
    // Another browser wrote this collection first: take theirs, keep our own changes, save once
    // more. Nothing entered here is thrown away.
    if (error instanceof ApiError && error.status === 409 && retry) {
      const [theirs] = await apiGet<StoredRow[]>('/state', { keys: key }, { background: true });
      if (theirs) {
        mergeInto(name, theirs.value);
        synced.set(key, { json: theirs.value, updatedAt: theirs.updatedAt });
        onRemoteChange?.();
        await saveCollection(name, false);
      }
      return;
    }
    // Anything else is best effort: the next tick retries.
  }
}

/**
 * A record the server wrote for this browser (the per-record load writes in `loads-server`).
 *
 * The record goes in place - every module holds the same array - and the synced copy of the
 * collection is told the server already has it, so the next autosave neither re-sends it nor
 * sees a conflict. Only this record moves in the synced copy: anything else this browser changed
 * since is still unsaved, still dirty, and still saved on the next tick.
 */
export function applyServerRecord(
  name: keyof typeof demoData,
  record: { id: string },
  collectionUpdatedAt: string,
): void {
  const target = demoData[name];
  if (!Array.isArray(target)) return;
  const rows = target as unknown[];
  const index = rows.findIndex((row) => rowId(row) === record.id);
  if (index >= 0) rows[index] = record;
  else rows.push(record);

  const key = collectionKey(name);
  const known = synced.get(key);
  if (!known) return;
  let base: unknown[];
  try {
    const parsed = JSON.parse(known.json) as unknown;
    base = Array.isArray(parsed) ? parsed : [];
  } catch {
    base = [];
  }
  const at = base.findIndex((row) => rowId(row) === record.id);
  if (at >= 0) base[at] = record;
  else base.push(record);
  synced.set(key, { json: JSON.stringify(base, withoutBytes), updatedAt: collectionUpdatedAt });
}

let soon: ReturnType<typeof setTimeout> | null = null;

/**
 * Saves now, and resolves when the save has landed. Callers that refetch server-computed
 * figures (the Fleet expense summary reads the saved rows) await this first.
 */
export function flushPersistedState(): Promise<void> {
  if (soon) {
    clearTimeout(soon);
    soon = null;
  }
  return saveIfChanged();
}

/**
 * Saves a moment after a write, coalescing a burst of them. A record is on the server well
 * before the person could reach another screen; the twenty-second loop stays as the backstop.
 */
export function saveSoon(delayMs = 300): void {
  if (soon) clearTimeout(soon);
  soon = setTimeout(() => {
    soon = null;
    void saveIfChanged();
  }, delayMs);
}

// ---------------------------------------------------------------- other browsers

/** Re-reads collections another browser changed since we last saw them. */
export async function pullRemoteChanges(): Promise<boolean> {
  if (!maySave || saving) return false;
  let index: { key: string; updatedAt: string }[];
  try {
    index = await apiGet('/state', { prefix: PREFIX }, { background: true });
  } catch {
    return false;
  }
  const changed = index.filter((row) => {
    const name = collectionOf(row.key);
    return name && synced.get(row.key)?.updatedAt !== row.updatedAt;
  });
  if (changed.length === 0) return false;
  let rows: StoredRow[];
  try {
    rows = await apiGet(
      '/state',
      { keys: changed.map((r) => r.key).join(',') },
      { background: true },
    );
  } catch {
    return false;
  }
  for (const row of rows) {
    const name = collectionOf(row.key);
    if (!name) continue;
    try {
      mergeInto(name, row.value);
      synced.set(row.key, { json: row.value, updatedAt: row.updatedAt });
    } catch {
      // Leave the collection as it is; the next poll tries again.
    }
  }
  onRemoteChange?.();
  return true;
}

/** Runs `work` when the main thread is next free, or soon regardless. */
function onIdle(work: () => void): void {
  const idle = (window as unknown as { requestIdleCallback?: (cb: () => void, o?: object) => void })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(work, { timeout: 2_000 });
  else window.setTimeout(work, 0);
}

/**
 * Start the autosave loop and the poll for other browsers' writes. Call once, after
 * `initPersistedState`. `onRemoteChange` is how the query cache learns that rows changed
 * underneath it.
 */
export function startStatePersistence(options?: { onRemoteChange?: () => void }): void {
  onRemoteChange = options?.onRemoteChange ?? null;
  window.setInterval(() => onIdle(() => void saveIfChanged()), SAVE_EVERY_MS);
  window.setInterval(() => {
    if (document.visibilityState === 'visible') void pullRemoteChanges();
  }, POLL_EVERY_MS);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') void saveIfChanged();
    else void pullRemoteChanges();
  });
  window.addEventListener('focus', () => void pullRemoteChanges());
  window.addEventListener('pagehide', () => void saveIfChanged());
}

/** Whether this browser is allowed to write the workspace back. Exported for the tests. */
export function isPersisting(): boolean {
  return maySave;
}

/** For tests: forget what was synced, so the next save writes everything. */
export function resetPersistenceForTests(): void {
  synced.clear();
  maySave = false;
  permissions = null;
  saving = null;
}
