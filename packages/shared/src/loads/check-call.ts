import { z } from 'zod';
import type { LoadStatusCode, TimelineLike } from './model.js';
import { type StoredLoad, type WriteResult, versionConflict } from './write-rules.js';

/**
 * A check call or a new ETA (rule 1.4): the load was heard from, and the update clock resets.
 *
 * Neither moves a status. A check call is where the truck is and what the driver said; an ETA
 * change is a person's ETA, which stands in for the projected one until the next position
 * arrives after it. Both land on the timeline, which is what "last update" is read from.
 */
export const CheckCallSchema = z.object({
  kind: z.enum(['check_call', 'eta_changed']),
  /** When it happened, ISO - the driver's call, not the moment it was typed. */
  at: z.string().min(1),
  /** Where the truck was, in the driver's words. */
  location: z.string().trim().max(200).optional(),
  /** The new ETA, ISO; required for `eta_changed`. */
  etaAt: z.string().min(1).optional(),
  /** The stop the ETA is for; the next open one when left out. */
  stopId: z.string().min(1).optional(),
  note: z.string().trim().max(1000).optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type CheckCallInput = z.infer<typeof CheckCallSchema>;

const CLOSED: ReadonlySet<string> = new Set<LoadStatusCode>(['delivered', 'closed', 'cancelled', 'tonu']);

export function applyCheckCall<T extends StoredLoad>(
  record: T,
  input: CheckCallInput,
  actor: { id: string; name: string },
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  if (CLOSED.has(record.status)) {
    return { ok: false, refusal: { code: 'invalid', message: `${record.loadNumber} is ${record.status}; there is nothing left to check on.` } };
  }
  const at = Date.parse(input.at);
  if (Number.isNaN(at)) return { ok: false, refusal: { code: 'invalid', message: 'That time does not parse.' } };
  if (at > Date.parse(now) + 5 * 60_000) return { ok: false, refusal: { code: 'invalid', message: 'That time is in the future.' } };
  if (input.kind === 'eta_changed') {
    const eta = input.etaAt ? Date.parse(input.etaAt) : Number.NaN;
    if (Number.isNaN(eta)) return { ok: false, refusal: { code: 'invalid', message: 'Say what the new ETA is.' } };
  }
  const stop = input.stopId
    ? record.stops.find((s) => s.id === input.stopId) ?? null
    : (record.stops.find((s) => s.status !== 'completed') ?? null);
  const where = input.location?.trim();
  const parts = [where ? `at ${where}` : null, input.note?.trim() || null].filter(Boolean);
  const event: TimelineLike = {
    id: `evt_${record.loadNumber.replace(/^L-/, '')}_${record.timeline.length + 1}_${Date.parse(now).toString(36)}`,
    at: input.at,
    kind: input.kind,
    actorType: 'user',
    actorName: actor.name,
    title:
      input.kind === 'check_call'
        ? `Check call${stop ? ` · to ${stop.facilityName || stop.city}` : ''}`
        : `ETA changed${stop ? ` · ${stop.facilityName || stop.city}` : ''}`,
    detail: parts.length > 0 ? parts.join(' · ') : null,
    stopId: stop?.id ?? null,
  };
  const next = {
    ...record,
    timeline: [...record.timeline, event],
    updatedAt: now,
    ...(input.kind === 'eta_changed' ? { manualEta: { at: input.etaAt, stopId: stop?.id ?? null, recordedAt: input.at, byName: actor.name } } : {}),
  } as T;
  return { ok: true, record: next, event };
}
