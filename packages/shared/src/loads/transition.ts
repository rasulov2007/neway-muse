import type { TimelineLike } from './model.js';
import {
  applyAssignment,
  applyCancel,
  applyConfirmUpload,
  applyStatusChange,
  applyStopEvent,
  type Actor,
  type StoredLoad,
  type WriteResult,
} from './write-rules.js';
import type { AssignLoadInput, ChangeStatusInput, StopEventInput } from './progress.js';
import type { ConfirmUploadInput } from './documents.js';
import type { CancelLoadInput } from './cancel.js';

/**
 * The one way a load's status moves.
 *
 * Rule 1.6. The Daily Board, the load page, a BOL or POD upload, a Samsara geofence - every one
 * of them is a `Transition` handed to this function, which runs the allowed-transition rules,
 * records who or what made the change and when it happened, and writes the timeline entry. No
 * other code path may change a status; a second door with no lock is how a rule gets lost.
 *
 * `source` is who is speaking. A person is `user`; the automatic sources name themselves, so a
 * timeline read later says "Samsara" or "POD upload" rather than pretending a dispatcher typed it.
 */
export type TransitionSource = 'user' | 'daily_board' | 'samsara' | 'bol_upload' | 'pod_upload' | 'driver_app';

export interface TransitionActor extends Actor {
  source: TransitionSource;
}

export type Transition =
  | { kind: 'status'; input: ChangeStatusInput }
  | { kind: 'stop_event'; input: StopEventInput }
  | { kind: 'confirm_upload'; input: ConfirmUploadInput }
  | { kind: 'assignment'; input: AssignLoadInput }
  | { kind: 'cancel'; input: CancelLoadInput };

/** What the timeline shows for an automatic source. */
export const SOURCE_LABEL: Record<TransitionSource, string> = {
  user: '',
  daily_board: 'Daily Board',
  samsara: 'Samsara',
  bol_upload: 'BOL upload',
  pod_upload: 'POD upload',
  // The driver, from the NeWay driver app (0081): their own name, said as coming from the app.
  driver_app: 'Driver app',
};

export function transition<T extends StoredLoad>(
  record: T,
  change: Transition,
  actor: TransitionActor,
  now: string,
): WriteResult<T> {
  const result = run(record, change, actor, now);
  if (!result.ok || !result.event) return result;
  // The event says who spoke. A person's name stays their name; an automatic source is named as
  // such, so "Samsara" is never mistaken for somebody's decision.
  const event: TimelineLike = {
    ...result.event,
    actorType: actor.source === 'user' || actor.source === 'daily_board' ? 'user' : actor.source === 'driver_app' ? 'driver' : 'system',
    actorName: actor.source === 'user' ? actor.name : `${actor.name} · ${SOURCE_LABEL[actor.source]}`,
  };
  const timeline = result.record.timeline.map((e) => (e.id === event.id ? event : e));
  return { ok: true, record: { ...result.record, timeline, lastChangedBy: describe(actor) } as T, event };
}

function run<T extends StoredLoad>(record: T, change: Transition, actor: Actor, now: string): WriteResult<T> {
  switch (change.kind) {
    case 'status':
      return applyStatusChange(record, change.input, actor, now);
    case 'stop_event':
      return applyStopEvent(record, change.input, actor, now);
    case 'confirm_upload':
      return applyConfirmUpload(record, change.input, actor, now);
    case 'assignment':
      return applyAssignment(record, change.input, actor, now);
    case 'cancel':
      return applyCancel(record, change.input, actor, now);
  }
}

/** Kept on the record: the last hand that moved it, for the list and the audit. */
export interface LastChange {
  byId: string;
  byName: string;
  source: TransitionSource;
}

function describe(actor: TransitionActor): LastChange {
  return { byId: actor.id, byName: actor.name, source: actor.source };
}
