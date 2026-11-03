import type { TimelineLike } from './model.js';
import type { StoredLoad, WriteResult } from './write-rules.js';

/**
 * The fields Edit may change (rule 1.3). Status, driver, truck and trailer are not here: they
 * have their own routes, with their own rules and their own board effects.
 */
export const EDITABLE_LOAD_FIELDS: ReadonlySet<string> = new Set([
  'customerId', 'customerName', 'brokerId', 'brokerName', 'brokerReference', 'commodity',
  'equipmentType', 'weightLbs', 'pieces', 'hazmat', 'temperatureF', 'rate', 'loadedMiles',
  'emptyMiles', 'rpm', 'stops', 'origin', 'destination', 'pickupAt', 'deliveryAt', 'charges',
  'expenses', 'financials', 'dispatcherId', 'dispatcherName', 'updaterId', 'updaterName',
  // Team driving (accounting corrective brief, section 6): the second driver on the load.
  'coDriverId', 'coDriverName',
  // The For driver rate beside the real one (owner, 2026-10-23): what driver pay is figured on.
  'driverRate',
]);

/** The fields in a patch that Edit is not allowed to touch. */
export function refusedEditFields(patch: Record<string, unknown>): string[] {
  return Object.keys(patch).filter((k) => !EDITABLE_LOAD_FIELDS.has(k));
}

/**
 * An edit merged onto the record: only the fields sent change, the version is checked, and
 * nothing else on the load is touched. Changing the reference cannot rewrite the miles, the
 * RPM, the dispatcher or the times, because they were never in the patch.
 */
export function applyEdit<T extends StoredLoad>(
  record: T,
  input: { expectedUpdatedAt: string; patch: Record<string, unknown>; summary?: string | null },
  now: string,
  actor?: { name: string } | null,
): WriteResult<T> {
  if (record.updatedAt !== input.expectedUpdatedAt) {
    return { ok: false, refusal: { code: 'conflict', message: `${record.loadNumber} changed since you opened it. Reload the load and try again.` } };
  }
  const refused = refusedEditFields(input.patch);
  if (refused.length > 0) {
    return {
      ok: false,
      refusal: {
        code: 'invalid',
        message: `${refused.join(', ')} cannot be changed through Edit. Status moves on the Daily Board or Record an event; the assignment has its own route.`,
      },
    };
  }
  if (Object.keys(input.patch).length === 0) return { ok: true, record, event: null };
  const edited = { ...record, ...input.patch, updatedAt: now } as T;
  // What changed, said on the timeline by the server (owner, 2026-10-30): the screen sends the
  // words, never the timeline itself.
  const summary = input.summary?.trim();
  if (!summary || !actor) return { ok: true, record: edited, event: null };
  const event: TimelineLike = {
    id: `evt_${record.loadNumber.replace(/^L-/, '')}_${record.timeline.length + 1}_${Date.parse(now).toString(36)}`,
    at: now,
    kind: 'note_added',
    actorType: 'user',
    actorName: actor.name,
    title: 'Load edited',
    detail: summary.slice(0, 1000),
    stopId: null,
  };
  return { ok: true, record: { ...edited, timeline: [...record.timeline, event] }, event };
}
