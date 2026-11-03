import { useSyncExternalStore } from 'react';

/**
 * What was just created, for three seconds.
 *
 * Creating a record usually drops the person back onto a list of a hundred rows with no sign of
 * which one is theirs. This remembers the new row's id briefly so the list can outline it, and
 * forgets it on its own — a highlight that lingers stops meaning "new".
 *
 * It is deliberately id-only and in memory: nothing here is data, it is a three-second visual
 * answer to "where did it go", and it should not survive a reload any more than a toast does.
 */

const HIGHLIGHT_MS = 3_000;

const ids = new Set<string>();
const listeners = new Set<() => void>();
let snapshot: ReadonlySet<string> = new Set();

function publish(): void {
  snapshot = new Set(ids);
  for (const listener of listeners) listener();
}

/** Marks a freshly created record. Extra ids for the same record are harmless. */
export function markCreated(...created: Array<string | null | undefined>): void {
  const fresh = created.filter((id): id is string => Boolean(id));
  if (fresh.length === 0) return;
  for (const id of fresh) ids.add(id);
  publish();
  setTimeout(() => {
    for (const id of fresh) ids.delete(id);
    publish();
  }, HIGHLIGHT_MS);
}

/** The ids still inside their highlight window. */
export function useRecentlyCreated(): ReadonlySet<string> {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => snapshot,
    () => snapshot,
  );
}

/** True while this record is still new. Safe to call with a null id. */
export function useIsRecentlyCreated(id: string | null | undefined): boolean {
  const recent = useRecentlyCreated();
  return id ? recent.has(id) : false;
}

/** For tests, which must not wait three real seconds. */
export function clearRecentlyCreated(): void {
  ids.clear();
  publish();
}
