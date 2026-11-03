import {
  cancelEventDetail,
  cancelEventTitle,
  cancelPatch,
  cancelRefusal,
  type CancelActor,
  type CancelLoadInput,
} from './cancel.js';
import {
  attachDocumentPatch,
  confirmationPatch,
  DOCUMENT_CHARGE_TYPE,
  reviewPatch,
  statusBeforeDocument,
  type AttachLoadDocumentInput,
  type RemoveLoadDocumentInput,
  type DecideLoadChargeInput,
  type ConfirmUploadInput,
  type ReviewDocumentInput,
} from './documents.js';
import type { DocumentLike, LoadLike, LoadStatusCode, NoteLike, StopLike, TimelineLike } from './model.js';
import {
  assignmentPatch,
  statusPatch,
  statusRefusal,
  stopEventPatch,
  type StopEventPatch,
  type AssignLoadInput,
  type ChangeStatusInput,
  type ProgressActor,
  type ProgressRefusal,
  type StopEventInput,
} from './progress.js';
import { buildNote, noteSummary, type AddLoadNoteInput, type PinLoadNoteInput } from './notes.js';

/**
 * The writes a load accepts through the server (P0.1, P0.5), as pure functions over the stored
 * record. The server reads the record, runs one of these, and stores what comes back; a refusal
 * is returned, never thrown, so the caller decides the status code. The browser never applies
 * these itself - it shows what the server returned.
 *
 * Every write here takes the `updatedAt` the caller was looking at and refuses a stale one.
 */
export interface Actor {
  id: string;
  name: string;
  isLead: boolean;
}

export type WriteRefusal =
  | { code: 'conflict'; message: string }
  | { code: 'forbidden'; message: string }
  | { code: 'invalid'; message: string }
  | { code: 'not_found'; message: string };

export type WriteResult<T> = { ok: true; record: T; event: TimelineLike | null } | { ok: false; refusal: WriteRefusal };

/** The record with anything else the store keeps on it. */
export type StoredLoad = LoadLike & Record<string, unknown>;

export function versionConflict(record: Pick<LoadLike, 'updatedAt' | 'loadNumber'>, expectedUpdatedAt: string): WriteRefusal | null {
  if (record.updatedAt === expectedUpdatedAt) return null;
  return {
    code: 'conflict',
    message: `${record.loadNumber} changed since you opened it. Reload the load and try again.`,
  };
}

function eventId(record: Pick<LoadLike, 'loadNumber' | 'timeline'>, now: string): string {
  const stem = record.loadNumber.replace(/^L-/, '');
  const base = `evt_${stem}_${record.timeline.length + 1}`;
  return record.timeline.some((event) => event.id === base) ? `${base}_${Date.parse(now).toString(36)}` : base;
}

function withEvent<T extends StoredLoad>(record: T, event: TimelineLike): T {
  return { ...record, timeline: [...record.timeline, event] };
}

// ------------------------------------------------------------------ cancel

export function applyCancel<T extends StoredLoad>(
  record: T,
  input: CancelLoadInput,
  actor: CancelActor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const refusal = cancelRefusal(record, input, actor);
  if (refusal) {
    return {
      ok: false,
      refusal: { code: refusal.code === 'lead' ? 'forbidden' : 'invalid', message: refusal.message },
    };
  }
  const freed = {
    driverName: typeof record.driverName === 'string' ? record.driverName : null,
    truckUnit: typeof record.truckUnit === 'string' ? record.truckUnit : null,
    trailerUnit: typeof record.trailerUnit === 'string' ? record.trailerUnit : null,
  };
  const patch = cancelPatch(input, actor, now, `chg_${record.loadNumber.replace(/^L-/, '')}_tonu`);
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'cancelled',
    actorType: 'user',
    actorName: actor.name,
    title: cancelEventTitle(input),
    detail: cancelEventDetail(input, freed),
    stopId: null,
  };
  return { ok: true, record: withEvent({ ...record, ...patch }, event), event };
}

// ------------------------------------------------------------------ notes

export function applyAddNote<T extends StoredLoad>(
  record: T,
  input: AddLoadNoteInput,
  actor: Pick<Actor, 'id' | 'name'>,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const noteId = `note_${record.loadNumber.replace(/^L-/, '')}_${record.notes.length + 1}_${Date.parse(now).toString(36)}`;
  const note: NoteLike = buildNote(input, actor, now, noteId);
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'note_added',
    actorType: 'user',
    actorName: actor.name,
    title: input.pinned ? 'Note pinned' : 'Note added',
    detail: noteSummary(note.body),
    stopId: null,
  };
  return {
    ok: true,
    record: withEvent({ ...record, notes: [...record.notes, note], updatedAt: now }, event),
    event,
  };
}

export function applyPinNote<T extends StoredLoad>(
  record: T,
  input: PinLoadNoteInput,
  actor: Pick<Actor, 'id' | 'name'>,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const note = record.notes.find((n) => n.id === input.noteId);
  if (!note) return { ok: false, refusal: { code: 'not_found', message: 'That note is no longer on the load.' } };
  if (note.pinned === input.pinned) return { ok: true, record, event: null };
  const notes = record.notes.map((n) => (n.id === input.noteId ? { ...n, pinned: input.pinned } : n));
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'note_added',
    actorType: 'user',
    actorName: actor.name,
    title: input.pinned ? 'Note pinned' : 'Note unpinned',
    detail: noteSummary(note.body),
    stopId: null,
  };
  return { ok: true, record: withEvent({ ...record, notes, updatedAt: now }, event), event };
}

// ------------------------------------------------------------------ documents

export function applyReview<T extends StoredLoad>(
  record: T,
  documentId: string,
  input: ReviewDocumentInput,
  actor: Pick<Actor, 'id' | 'name'>,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const doc = record.documents.find((d) => d.id === documentId);
  if (!doc) return { ok: false, refusal: { code: 'not_found', message: 'That document is no longer on the load.' } };
  const patch = reviewPatch(doc, input.review, actor, now, input.reason ?? null);
  if ('refusal' in patch) return { ok: false, refusal: { code: 'invalid', message: patch.refusal } };
  const cleaned = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<DocumentLike>;
  const documents = record.documents.map((d) => (d.id === documentId ? { ...d, ...cleaned } : d));
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'document_uploaded',
    actorType: 'user',
    actorName: actor.name,
    title: input.review === 'verified' ? `${doc.title} verified` : input.review === 'rejected' ? `${doc.title} rejected` : `${doc.title} reviewed`,
    detail: input.review === 'rejected' ? `${doc.fileName} · by ${actor.name} · ${input.reason ?? ''}` : `${doc.fileName} · by ${actor.name}`,
    stopId: null,
  };
  return { ok: true, record: withEvent({ ...record, documents, updatedAt: now }, event), event };
}

export function applyConfirmUpload<T extends StoredLoad>(
  record: T,
  input: ConfirmUploadInput,
  actor: Pick<Actor, 'id' | 'name'>,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const outcome = confirmationPatch(record, input, now);
  if ('refusal' in outcome) return { ok: false, refusal: { code: 'invalid', message: outcome.refusal.message } };
  const { patch } = outcome;
  const stops = record.stops.map((stop) => (stop.id === patch.stopId ? { ...stop, ...patch.stopPatch } : stop));
  const event: TimelineLike = {
    id: eventId(record, now),
    at: input.at,
    kind: patch.eventKind,
    actorType: 'user',
    actorName: actor.name,
    title: patch.eventTitle,
    detail: 'Confirmed from the paperwork',
    stopId: patch.stopId,
  };
  const next: T = {
    ...record,
    stops,
    status: patch.status ?? record.status,
    ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
    updatedAt: now,
  };
  return { ok: true, record: withEvent(next, event), event };
}

// ------------------------------------------------------------------ progress (P1)

function progressRefusal(refusal: ProgressRefusal): WriteRefusal {
  return { code: refusal.code === 'conflict' ? 'conflict' : refusal.code, message: refusal.message };
}

function actorOf(actor: Actor): ProgressActor {
  return { id: actor.id, name: actor.name, isLead: actor.isLead };
}

/**
 * A status move, server side.
 *
 * The same rule the board and the load page both call, so the two cannot drift. It changes the
 * status and writes the event; it never touches a stop, and it never clears an exception.
 */
export function applyStatusChange<T extends StoredLoad>(
  record: T,
  input: ChangeStatusInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const refusal = statusRefusal(record, input.status as LoadStatusCode, input, actorOf(actor));
  if (refusal) return { ok: false, refusal: progressRefusal(refusal) };
  const patch = statusPatch(record, input, actorOf(actor), now);
  const next = {
    ...record,
    status: patch.status,
    ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
    ...(patch.dispatchedAt ? { dispatchedAt: patch.dispatchedAt } : {}),
    updatedAt: now,
  } as T;
  return { ok: true, record: withEvent(next, patch.event), event: patch.event };
}

/**
 * One stop arriving or leaving.
 *
 * The named stop is the only one that moves. The load follows it - to `at_pickup`, to
 * `in_transit`, or to `delivered` when this was the last delivery and the POD is already filed.
 */
export function applyStopEvent<T extends StoredLoad>(
  record: T,
  input: StopEventInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const out = stopEventPatch(record, input, actorOf(actor), now);
  if ('refusal' in out) return { ok: false, refusal: progressRefusal(out.refusal) };
  const { patch } = out;
  // Every stop event is also kept on the stop's own log (0081): what kind, the actual time, the
  // moment it was recorded, who and from where, and the driver's delay reason. The appointment is
  // the scheduled time and is never touched; a correction later is a separate entry.
  const source = (actor as Actor & { source?: string }).source ?? 'user';
  const logEntry: StopEventLogEntry = {
    kind: input.kind,
    at: input.at,
    zone: input.zone,
    recordedAt: now,
    byId: actor.id,
    byName: actor.name,
    source,
    delayReason: input.delayReason?.trim() || null,
    note: input.note?.trim() || null,
  };
  const stops = record.stops.map((stop) =>
    stop.id === patch.stopId
      ? ({ ...stop, ...patch.stopPatch, eventLog: [...(((stop as StopLike & { eventLog?: StopEventLogEntry[] }).eventLog) ?? []), logEntry] } as StopLike)
      : stop,
  );
  const event = input.delayReason?.trim()
    ? { ...patch.event, detail: [patch.event.detail, `Delay: ${input.delayReason.trim()}`].filter(Boolean).join(' · ') }
    : patch.event;
  const next = {
    ...record,
    stops,
    ...(patch.status ? { status: patch.status } : {}),
    ...(patch.deliveredAt ? { deliveredAt: patch.deliveredAt } : {}),
    ...(patch.detentionCharge ? { charges: withDraftDetention(record, patch.detentionCharge) } : {}),
    updatedAt: now,
  } as T;
  return { ok: true, record: withEvent(next, event), event };
}

/** One line of a stop's event log (0081): kept on the stop beside `arrivedAt` / `departedAt`. */
export interface StopEventLogEntry {
  kind: string;
  /** The actual time the thing happened (ISO). */
  at: string;
  zone: string;
  /** When the server recorded it - never the same field as `at`. */
  recordedAt: string;
  byId: string;
  byName: string;
  /** user · daily_board · samsara · driver_app … */
  source: string;
  delayReason: string | null;
  note: string | null;
}

/** A load's charge line, as the record carries it; a draft is one nobody has accepted yet. */
export interface ChargeLike {
  id: string;
  type: string;
  description: string;
  amount: number;
  billable: boolean;
  payableToDriver: boolean;
  status?: 'draft' | 'accepted' | 'dropped';
  stopId?: string | null;
}

/**
 * The detention draft for a stop, replacing an earlier draft for the same stop (a corrected
 * departure re-drafts) and never touching a charge somebody has already accepted or dropped.
 */
function withDraftDetention(record: StoredLoad, draft: NonNullable<StopEventPatch['detentionCharge']>): ChargeLike[] {
  const charges = (Array.isArray(record['charges']) ? (record['charges'] as ChargeLike[]) : []).filter(
    (c) => !(c.type === 'detention' && c.stopId === draft.stopId && (c.status ?? 'draft') === 'draft'),
  );
  return [
    ...charges,
    {
      id: `chg_det_${draft.stopId}`,
      type: 'detention',
      description: draft.description,
      amount: draft.amount,
      billable: false,
      payableToDriver: false,
      status: 'draft',
      stopId: draft.stopId,
    },
  ];
}

/** Driver, truck and trailer on a load. A booked load with both becomes assigned by itself. */
export function applyAssignment<T extends StoredLoad>(
  record: T,
  input: AssignLoadInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const out = assignmentPatch(record as never, input, actorOf(actor), now);
  if ('refusal' in out) return { ok: false, refusal: progressRefusal(out.refusal) };
  const { patch } = out;
  const next = {
    ...record,
    driverId: patch.driverId,
    driverName: patch.driverName,
    truckId: patch.truckId,
    truckUnit: patch.truckUnit,
    trailerId: patch.trailerId,
    trailerUnit: patch.trailerUnit,
    ...(patch.status ? { status: patch.status } : {}),
    updatedAt: now,
  } as T;
  return { ok: true, record: withEvent(next, patch.event), event: patch.event };
}

/** Filing a document on a load, server side, so it survives the next server write. */
export function applyAttachDocument<T extends StoredLoad>(
  record: T,
  input: AttachLoadDocumentInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const { documents, document } = attachDocumentPatch(record, input, actor, now);
  /*
   * The amount on the paper (owner, 2026-11-02) becomes its charge in the same write: billable to
   * the broker and accepted, pointing at the paper. A detention the stop times already drafted is
   * accepted at this amount rather than billed twice; a TONU amount is the TONU fee itself, so it
   * needs a load that is TONU.
   */
  const chargeType = DOCUMENT_CHARGE_TYPE[input.type] ?? null;
  const amount = chargeType && input.chargeAmount ? Math.round(input.chargeAmount * 100) / 100 : null;
  let charges = Array.isArray(record['charges']) ? (record['charges'] as ChargeLike[]) : [];
  let extra: Record<string, unknown> = {};
  if (amount !== null && chargeType) {
    const description = input.title?.trim() || { lumper: 'Lumper', detention: 'Detention', layover: 'Layover', tonu: 'TONU' }[chargeType];
    if (chargeType === 'tonu') {
      const cancellation = record['cancellation'] as { outcome?: string; fee?: number | null } | null | undefined;
      if (record.status !== 'tonu' && cancellation?.outcome !== 'tonu') {
        return { ok: false, refusal: { code: 'invalid', message: `${record.loadNumber} is not a TONU. Mark it TONU (Cancel → TONU) and the fee is set there.` } };
      }
      charges = charges.map((c) => (c.type === 'tonu' ? { ...c, amount, documentId: document.id } : c));
      if (!charges.some((c) => c.type === 'tonu')) {
        charges = [...charges, { id: `chg_doc_${document.id}`, type: 'tonu', description, amount, billable: true, payableToDriver: false, documentId: document.id } as ChargeLike];
      }
      extra = { cancellation: { ...(cancellation ?? {}), fee: amount } };
    } else {
      const stopId = input.stopId ?? null;
      const drafts = chargeType === 'detention' ? charges.filter((c) => c.type === 'detention' && (c.status ?? 'draft') === 'draft') : [];
      const draft = drafts.find((c) => (c.stopId ?? null) === stopId) ?? (stopId === null && drafts.length === 1 ? drafts[0] : undefined);
      const charge = {
        id: draft?.id ?? `chg_doc_${document.id}`,
        type: chargeType,
        description: draft?.description ?? description,
        amount,
        billable: true,
        payableToDriver: draft?.payableToDriver ?? false,
        status: 'accepted' as const,
        stopId: draft?.stopId ?? stopId,
        documentId: document.id,
      };
      charges = draft ? charges.map((c) => (c.id === draft.id ? charge : c)) : [...charges, charge];
    }
  }
  const detail = [
    document.fileName,
    amount !== null && chargeType
      ? `${amount.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${chargeType === 'tonu' ? 'TONU fee' : `${chargeType} charge`} added`
      : null,
    input.note?.trim() || null,
  ]
    .filter(Boolean)
    .join(' · ');
  const event: TimelineLike = {
    id: `evt_${record.loadNumber.replace(/^L-/, '')}_${record.timeline.length + 1}_doc`,
    at: now,
    kind: 'document_uploaded',
    actorType: 'user',
    actorName: actor.name,
    title: `${document.title} filed`,
    detail,
    stopId: null,
  };
  const next = { ...record, documents, ...(amount !== null ? { charges, ...extra } : {}), updatedAt: now } as T;
  return { ok: true, record: withEvent(next, event), event };
}

/** A drafted accessorial accepted (optionally at another amount) or dropped; never a linehaul. */
export function applyChargeDecision<T extends StoredLoad>(
  record: T,
  chargeId: string,
  input: DecideLoadChargeInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const charges = Array.isArray(record['charges']) ? (record['charges'] as ChargeLike[]) : [];
  const charge = charges.find((c) => c.id === chargeId);
  if (!charge) return { ok: false, refusal: { code: 'not_found', message: 'That charge is no longer on the load.' } };
  if (charge.type === 'linehaul') return { ok: false, refusal: { code: 'invalid', message: 'The linehaul is not decided here.' } };
  if ((charge.status ?? 'draft') !== 'draft') return { ok: false, refusal: { code: 'conflict', message: `${charge.description} was already ${charge.status}. Reload and try again.` } };
  const amount = input.decision === 'accepted' && input.amount ? Math.round(input.amount * 100) / 100 : charge.amount;
  const next = charges.map((c) =>
    c.id === chargeId ? { ...c, status: input.decision, amount, ...(input.decision === 'accepted' ? { billable: true } : {}) } : c,
  );
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'note_added',
    actorType: 'user',
    actorName: actor.name,
    title: `${input.decision === 'accepted' ? 'Accepted' : 'Dropped'} ${charge.description}`,
    detail: `${amount.toFixed(2)}${amount !== charge.amount ? ` (drafted ${charge.amount.toFixed(2)})` : ''}`,
    stopId: charge.stopId ?? null,
  };
  return { ok: true, record: withEvent({ ...record, charges: next, updatedAt: now } as T, event), event };
}

/**
 * Taking a file off the load (owner, 2026-11-02). The file stays on the record, marked removed
 * with who, when and why, and stops counting; a charge that came with it is dropped. With
 * `revertStatus`, a BOL or POD takes back the step it made: the stop it closed is opened again
 * and the load returns to the status before - the board follows from the status.
 */
export function applyRemoveDocument<T extends StoredLoad>(
  record: T,
  documentId: string,
  input: RemoveLoadDocumentInput,
  actor: Actor,
  now: string,
): WriteResult<T> {
  const stale = versionConflict(record, input.expectedUpdatedAt);
  if (stale) return { ok: false, refusal: stale };
  const doc = record.documents.find((d) => d.id === documentId);
  if (!doc) return { ok: false, refusal: { code: 'not_found', message: 'That file is no longer on the load.' } };
  if ((doc as { removedAt?: string | null }).removedAt) return { ok: false, refusal: { code: 'conflict', message: 'That file was already removed.' } };
  const charges = Array.isArray(record['charges']) ? (record['charges'] as Array<ChargeLike & { documentId?: string; addedAfterInvoice?: unknown }>) : [];
  const linked = charges.filter((c) => c.documentId === documentId && c.status !== 'dropped');
  if (linked.length > 0 && (record['invoiceId'] || linked.some((c) => c.addedAfterInvoice))) {
    return { ok: false, refusal: { code: 'conflict', message: `The ${linked[0]!.description} charge from this file is on an invoice. Correct the invoice in Accounting first.` } };
  }
  const documents = record.documents.map((d) =>
    d.id === documentId ? ({ ...d, supersededBy: 'removed', supersededAt: now, removedAt: now, removedBy: actor.name, removedReason: input.reason.trim() } as typeof d) : d,
  );
  const nextCharges = charges.map((c) =>
    c.documentId === documentId && c.status !== 'dropped' ? { ...c, status: 'dropped' as const, droppedReason: `${doc.title} removed: ${input.reason.trim()}` } : c,
  );
  let status = record.status;
  let stops = record.stops;
  let deliveredAt = record['deliveredAt'] as string | null | undefined;
  let reverted: LoadStatusCode | null = null;
  if (input.revertStatus && (doc.type === 'pod' || doc.type === 'bol')) {
    const stopId = (doc as { stopId?: string | null }).stopId ?? null;
    const kind = doc.type === 'pod' ? 'delivery' : 'pickup';
    const candidates = record.stops.filter((s) => s.kind === kind && (stopId ? s.id === stopId : true));
    // The stop this paper closed: the named one, else the last completed one of its kind.
    const stop = stopId ? candidates[0] : [...candidates].reverse().find((s) => s.status === 'completed' || s.departedAt);
    if (stop) {
      stops = record.stops.map((s) => {
        if (s.id !== stop.id) return s;
        // Arrived and departed stamped together are the paper's own stamp, not a recorded arrival.
        const arrivedAt = s.arrivedAt && s.arrivedAt === s.departedAt ? null : s.arrivedAt;
        const reopened = { ...s, arrivedAt, departedAt: null, status: arrivedAt ? 'in_progress' : 'pending' } as typeof s;
        return doc.type === 'bol' ? ({ ...reopened, loadedAt: null } as typeof s) : reopened;
      });
    }
    reverted = statusBeforeDocument(record, doc, stops);
    if (reverted) {
      status = reverted;
      if (doc.type === 'pod') deliveredAt = null;
    }
  }
  const event: TimelineLike = {
    id: eventId(record, now),
    at: now,
    kind: 'note_added',
    actorType: 'user',
    actorName: actor.name,
    title: `${doc.title} removed`,
    detail: [doc.fileName, input.reason.trim(), reverted ? `load back to ${reverted.replace(/_/g, ' ')}` : null, linked.length ? `${linked.map((c) => c.description).join(', ')} charge dropped` : null]
      .filter(Boolean)
      .join(' · '),
    stopId: null,
  };
  const next = {
    ...record,
    documents,
    charges: nextCharges,
    status,
    stops,
    ...(deliveredAt === null ? { deliveredAt: null } : {}),
    updatedAt: now,
  } as T;
  return { ok: true, record: withEvent(next, event), event };
}
