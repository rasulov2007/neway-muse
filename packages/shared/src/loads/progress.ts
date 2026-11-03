import { detentionAt } from './config.js';
import { z } from 'zod';
import { timeInZone } from './format-time.js';
import type { DocumentLike, LoadLike, LoadStatusCode, StopLike, TimelineLike } from './model.js';

/**
 * Moving a load along, as rules rather than as clicks.
 *
 * Three things happen to a load all day: its status moves, a stop is arrived at or left, and the
 * driver or the truck changes. Until now each of those was written by whichever browser tab was
 * open. These are the same operations as pure functions, so the server can run them once, with a
 * permission, a version check and an audit entry - and the Daily Board can run the same rule
 * from its own screen without a second implementation drifting from this one.
 *
 * Two rules are load-bearing and easy to get wrong:
 *
 * 1. **Only the named stop moves.** Marking a load delivered never completes stops nobody
 *    visited; the load becomes `delivered` when every delivery stop is complete and the POD is
 *    on file, and not before.
 * 2. **A time is an event time, not an entry time.** The caller says when the thing happened, in
 *    the stop's own zone, and the record keeps both that instant and who typed it when.
 */

// ------------------------------------------------------------------ what may follow what

/** Statuses a dispatcher may move a load to from its current status. */
export const NEXT_STATUSES: Record<LoadStatusCode, LoadStatusCode[]> = {
  booked: ['assigned', 'cancelled', 'tonu'],
  assigned: ['dispatched', 'booked', 'cancelled'],
  dispatched: ['at_pickup', 'assigned', 'cancelled', 'tonu'],
  at_pickup: ['loading', 'loaded', 'tonu'],
  loading: ['loaded'],
  loaded: ['in_transit'],
  in_transit: ['at_delivery', 'unloading', 'delivered'],
  // Back to in transit after a non-final delivery: "to stop 3 of 3" (rule 1.5).
  at_delivery: ['unloading', 'delivered', 'in_transit'],
  unloading: ['delivered', 'in_transit'],
  delivered: ['closed'],
  closed: [],
  cancelled: [],
  tonu: [],
};

export type RequiredDocumentType = 'rate_confirmation' | 'bol' | 'pod';

/** What has to be on file before a load may stand at each status. */
export const DOCUMENTS_REQUIRED_FOR: Record<LoadStatusCode, readonly RequiredDocumentType[]> = {
  booked: [],
  assigned: ['rate_confirmation'],
  dispatched: ['rate_confirmation'],
  at_pickup: ['rate_confirmation'],
  loading: ['rate_confirmation'],
  loaded: ['rate_confirmation', 'bol'],
  in_transit: ['rate_confirmation', 'bol'],
  at_delivery: ['rate_confirmation', 'bol'],
  unloading: ['rate_confirmation', 'bol'],
  delivered: ['rate_confirmation', 'bol', 'pod'],
  closed: ['rate_confirmation', 'bol', 'pod'],
  cancelled: [],
  tonu: [],
};

export const DOCUMENT_LABEL: Record<RequiredDocumentType, string> = {
  rate_confirmation: 'rate confirmation',
  bol: 'bill of lading',
  pod: 'POD',
};

/**
 * Whether a document record is a document rather than the shape of one: a placeholder for
 * paperwork that has not arrived is not paperwork. The bytes are not part of the test, because
 * documents filed before this build stored files inline would otherwise block their loads.
 */
export function isFiledDocument(doc: Pick<DocumentLike, 'status' | 'review' | 'fileName' | 'uploadedAt'>): boolean {
  if (doc.status === 'missing') return false;
  const filed = doc.status === 'verified' || doc.review !== undefined;
  if (!filed) return false;
  return doc.fileName.trim() !== '' && doc.uploadedAt.trim() !== '';
}

/**
 * The required paperwork a completed load is still missing.
 *
 * Empty for a load that has not been delivered: paperwork is only "missing" once the work it
 * documents has happened. This is what the status line shows beside Delivered, and what billing
 * refuses to invoice against.
 */
export function missingPaperwork(load: Pick<LoadLike, 'status' | 'documents'>): RequiredDocumentType[] {
  if (load.status !== 'delivered' && load.status !== 'closed') return [];
  return missingDocumentsFor(load, 'delivered');
}

/** "POD missing", "RC and POD missing" - the words the badge beside the status uses. */
export function paperworkLabel(missing: readonly RequiredDocumentType[]): string | null {
  if (missing.length === 0) return null;
  return `${missing.map((m) => DOCUMENT_LABEL[m]).join(' and ')} missing`;
}

/** The paperwork a move to `next` is missing, in the order a person would chase it. */
export function missingDocumentsFor(
  load: Pick<LoadLike, 'documents'>,
  next: LoadStatusCode,
): RequiredDocumentType[] {
  return DOCUMENTS_REQUIRED_FOR[next].filter(
    (type) => !load.documents.some((doc) => doc.type === type && isFiledDocument(doc)),
  );
}

// ------------------------------------------------------------------ the shapes a caller sends

export const StopEventKinds = ['arrived', 'departed', 'completed'] as const;
export type StopEventKind = (typeof StopEventKinds)[number];

export const StopEventSchema = z.object({
  stopId: z.string().min(1),
  kind: z.enum(StopEventKinds),
  /** A lead departing the last delivery without its POD; needs a reason, like a status move. */
  bypassPaperwork: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
  /** The instant the thing happened, ISO. Not the moment it was typed. */
  at: z.string().min(1),
  /**
   * The IANA zone the caller built `at` in. It has to be the stop's own zone: a check-out typed
   * against the dispatcher's computer is an hour wrong twice a year and nobody can tell later.
   */
  zone: z.string().min(1),
  note: z.string().trim().max(500).optional(),
  /**
   * Why the stop ran late, when the driver says so (the driver app, 0081): kept on the stop's
   * event log and in the timeline. Scheduled (the appointment), actual (`at`) and recorded (the
   * server clock) stay three separate times; a later correction is its own entry.
   */
  delayReason: z.string().trim().max(200).optional(),
  /**
   * The Daily Board word the person chose, when this came from the board.
   *
   * The server would otherwise derive one from the load, and its answer is not always theirs:
   * finishing the first of two deliveries leaves the load in transit, but the dispatcher who
   * typed UNLOADING is looking at a truck with its doors open. The person's word wins, and the
   * protected statuses are still never overwritten.
   */
  boardStatus: z.string().trim().max(24).optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type StopEventInput = z.infer<typeof StopEventSchema>;

export const ChangeStatusSchema = z.object({
  status: z.enum([
    'booked', 'assigned', 'dispatched', 'at_pickup', 'loading', 'loaded',
    'in_transit', 'at_delivery', 'unloading', 'delivered', 'closed', 'cancelled', 'tonu',
  ]),
  note: z.string().trim().max(500).optional(),
  /** A lead moving a load without the paperwork the status asks for; needs a reason. */
  bypassPaperwork: z.boolean().default(false),
  reason: z.string().trim().max(500).optional(),
  /** The Daily Board word the person chose, when this came from the board. */
  boardStatus: z.string().trim().max(24).optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type ChangeStatusInput = z.infer<typeof ChangeStatusSchema>;

export const AssignLoadSchema = z.object({
  driverId: z.string().min(1).nullable(),
  driverName: z.string().trim().max(120).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  truckUnit: z.string().trim().max(40).nullable().optional(),
  trailerId: z.string().min(1).nullable().optional(),
  trailerUnit: z.string().trim().max(40).nullable().optional(),
  note: z.string().trim().max(500).optional(),
  /**
   * Set when the freight is being taken off one driver and given to another mid-run. The event
   * then says so - "Recovered from" - with the split of miles and money in its detail, because a
   * recovery read back later as "Assigned to" is a settlement dispute waiting to happen.
   */
  recovery: z
    .object({
      fromDriverName: z.string().trim().max(120),
      fromUnit: z.string().trim().max(40),
      summary: z.string().trim().max(500),
    })
    .optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type AssignLoadInput = z.infer<typeof AssignLoadSchema>;

/**
 * Correcting something already recorded.
 *
 * Inside the window a person corrects their own entry with a reason. Outside it, or on somebody
 * else's entry, or when the correction takes a delivered load backwards, it takes a lead. The
 * original is never overwritten in the history - it is restated, so the first value stays
 * readable beside the second.
 */
export const CorrectionSchema = z.object({
  target: z.enum(['stop_time', 'status']),
  stopId: z.string().min(1).optional(),
  field: z.enum(['arrivedAt', 'departedAt']).optional(),
  at: z.string().min(1).optional(),
  zone: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
  reason: z.string().trim().min(3, 'Say why this is being corrected').max(500),
  expectedUpdatedAt: z.string().min(1),
});
export type CorrectionInput = z.infer<typeof CorrectionSchema>;

/** How long a person may correct their own entry before it takes a lead. Configurable. */
export const CORRECTION_WINDOW_MINUTES = 120;

export interface ProgressActor {
  id: string;
  name: string;
  isLead: boolean;
}

export type ProgressRefusal = { code: 'invalid' | 'forbidden' | 'conflict'; message: string };

// ------------------------------------------------------------------ helpers

function stopLabel(stop: StopLike): string {
  return stop.facilityName?.trim() || `${stop.city}, ${stop.state}`.trim();
}

function deliveries(load: Pick<LoadLike, 'stops'>): StopLike[] {
  return load.stops.filter((s) => s.kind === 'delivery');
}

/** Every delivery on the route has been completed: the test for "the freight is off". */
export function allDeliveriesComplete(load: Pick<LoadLike, 'stops'>): boolean {
  const rows = deliveries(load);
  return rows.length > 0 && rows.every((s) => s.status === 'completed');
}

/** The status a stop event implies, or null when the load is already past it. */
export function statusAfterStopEvent(
  load: Pick<LoadLike, 'status' | 'stops'>,
  stop: StopLike,
  kind: StopEventKind,
): LoadStatusCode | null {
  const rank: Record<LoadStatusCode, number> = {
    booked: 1, assigned: 2, dispatched: 3, at_pickup: 4, loading: 5, loaded: 6,
    in_transit: 7, at_delivery: 8, unloading: 9, delivered: 10, closed: 11, cancelled: 99, tonu: 99,
  };
  const forward = (next: LoadStatusCode) => (rank[next] > rank[load.status] ? next : null);
  if (stop.kind === 'pickup') {
    if (kind === 'arrived') return forward('at_pickup');
    // Departure is what puts a load in transit - the geofence exit or the board - never the BOL.
    if (kind === 'departed' || kind === 'completed') return forward('in_transit');
    return null;
  }
  if (kind === 'arrived') return forward('at_delivery');
  // Leaving a delivery that is not the last one: the load is running again, to the next stop.
  const remaining = load.stops.filter((s) => s.kind === 'delivery' && s.id !== stop.id && s.status !== 'completed');
  if (remaining.length > 0) return 'in_transit';
  // The last delivery completing only finishes the load once the POD is on file.
  return null;
}

function event(
  load: Pick<LoadLike, 'loadNumber' | 'timeline'>,
  input: { kind: string; title: string; detail: string | null; stopId: string | null; at: string; actor: ProgressActor },
): TimelineLike {
  const stem = load.loadNumber.replace(/^L-/, '');
  return {
    id: `evt_${stem}_${load.timeline.length + 1}_${Date.parse(input.at).toString(36)}`,
    at: input.at,
    kind: input.kind,
    actorType: 'user',
    actorName: input.actor.name,
    title: input.title,
    detail: input.detail,
    stopId: input.stopId,
  };
}

// ------------------------------------------------------------------ the rules

/** What refuses a status move, or null when it may go ahead. */
export function statusRefusal(
  load: Pick<LoadLike, 'status' | 'stops' | 'documents' | 'loadNumber' | 'driverId' | 'truckId'>,
  next: LoadStatusCode,
  input: Pick<ChangeStatusInput, 'bypassPaperwork' | 'reason'>,
  actor: ProgressActor,
): ProgressRefusal | null {
  if (next === load.status) return { code: 'invalid', message: `${load.loadNumber} is already ${next.replace(/_/g, ' ')}.` };
  if (!NEXT_STATUSES[load.status].includes(next)) {
    return {
      code: 'invalid',
      message: `${load.loadNumber} cannot go from ${load.status.replace(/_/g, ' ')} to ${next.replace(/_/g, ' ')}.`,
    };
  }
  if ((next === 'assigned' || next === 'dispatched') && (!load.driverId || !load.truckId)) {
    return { code: 'invalid', message: 'A load needs a driver and a truck before it is dispatched.' };
  }
  if (next === 'delivered' && !allDeliveriesComplete(load)) {
    const left = deliveries(load).filter((s) => s.status !== 'completed');
    return {
      code: 'invalid',
      message:
        left.length === deliveries(load).length
          ? 'No delivery has been completed yet. Finish the stop, and the load follows.'
          : `${left.length} delivery stop${left.length === 1 ? '' : 's'} still open: ${left.map(stopLabel).join(', ')}.`,
    };
  }
  // Delivery is a fact about the freight, not about the paperwork: a load that was signed for is
  // delivered even when the POD has not been filed yet. The missing document is carried on the
  // load (`missingPaperwork`), shown beside the status, and it blocks billing - which is where
  // the money actually depends on it. Earlier statuses keep their document rule.
  const missing = next === 'delivered' || next === 'closed' ? [] : missingDocumentsFor(load, next);
  if (missing.length > 0) {
    if (!input.bypassPaperwork) {
      return {
        code: 'invalid',
        message: `${next.replace(/_/g, ' ')} needs the ${missing.map((m) => DOCUMENT_LABEL[m]).join(' and the ')}.`,
      };
    }
    if (!actor.isLead) {
      return { code: 'forbidden', message: 'Moving a load without its paperwork takes a dispatch lead.' };
    }
    if (!input.reason?.trim()) {
      return { code: 'invalid', message: 'Say why the paperwork is not there.' };
    }
  }
  return null;
}

export interface StatusPatch {
  status: LoadStatusCode;
  deliveredAt?: string;
  dispatchedAt?: string;
  event: TimelineLike;
}

/**
 * A status move. It changes the status and nothing else: stops keep their own state, and an
 * exception is left alone because a load being delivered does not mean the problem it had was
 * resolved.
 */
export function statusPatch(
  load: Pick<LoadLike, 'status' | 'stops' | 'documents' | 'loadNumber' | 'timeline' | 'dispatchedAt' | 'deliveredAt'>,
  input: Pick<ChangeStatusInput, 'status' | 'note' | 'bypassPaperwork' | 'reason'>,
  actor: ProgressActor,
  now: string,
): StatusPatch {
  const next = input.status as LoadStatusCode;
  const bypassed = input.bypassPaperwork && missingDocumentsFor(load, next).length > 0;
  const detail = [input.note?.trim(), bypassed ? `Paperwork bypassed: ${input.reason?.trim()}` : null]
    .filter(Boolean)
    .join(' · ');
  return {
    status: next,
    ...(next === 'delivered' && !load.deliveredAt ? { deliveredAt: now } : {}),
    ...((next === 'dispatched' || next === 'in_transit') && !load.dispatchedAt ? { dispatchedAt: now } : {}),
    event: event(load, {
      kind: 'status_changed',
      title: `${load.status.replace(/_/g, ' ')} → ${next.replace(/_/g, ' ')}`,
      detail: detail || null,
      stopId: null,
      at: now,
      actor,
    }),
  };
}

export interface StopEventPatch {
  stopId: string;
  stopPatch: Partial<Pick<StopLike, 'status' | 'arrivedAt' | 'departedAt'>> & { detentionMinutes?: number };
  status: LoadStatusCode | null;
  deliveredAt?: string;
  /**
   * A detention charge to draft when the truck sat past its free time (rule 1.8). Drafted, not
   * billed: it is there for the person who invoices the broker to accept, change or drop.
   */
  detentionCharge?: { stopId: string; minutes: number; amount: number; freeTimeMinutes: number; description: string };
  event: TimelineLike;
  /** True when this event finished the last delivery and the load may complete. */
  completesLoad: boolean;
}

/**
 * One stop moving. The stop named is the only one that changes, which is what makes a multi-stop
 * load behave: completing stop 2 of 4 leaves the load in transit and the driver on the road.
 */
export function stopEventPatch(
  load: Pick<LoadLike, 'status' | 'stops' | 'documents' | 'loadNumber' | 'timeline'>,
  input: Pick<StopEventInput, 'stopId' | 'kind' | 'at' | 'zone' | 'note'>,
  actor: ProgressActor,
  now: string,
): { patch: StopEventPatch } | { refusal: ProgressRefusal } {
  const stop = load.stops.find((s) => s.id === input.stopId);
  if (!stop) return { refusal: { code: 'invalid', message: 'That stop is no longer on the load.' } };
  if (load.status === 'cancelled' || load.status === 'tonu' || load.status === 'closed') {
    return { refusal: { code: 'invalid', message: `${load.loadNumber} is ${load.status}; its stops do not move.` } };
  }
  if (!stop.timezone?.trim()) {
    return {
      refusal: {
        code: 'invalid',
        message: `${stopLabel(stop)} has no time zone. Add the city and state on the stop, and the zone follows.`,
      },
    };
  }
  if (stop.timezone !== input.zone) {
    return {
      refusal: {
        code: 'invalid',
        message: `That time was entered in ${input.zone}; ${stopLabel(stop)} runs on ${stop.timezone}. Confirm the zone before saving.`,
      },
    };
  }
  const at = Date.parse(input.at);
  if (Number.isNaN(at)) return { refusal: { code: 'invalid', message: 'That time does not parse.' } };
  if (at > Date.parse(now) + 5 * 60_000) {
    return { refusal: { code: 'invalid', message: 'That time is in the future.' } };
  }
  if (input.kind !== 'arrived' && stop.arrivedAt && at < Date.parse(stop.arrivedAt)) {
    return { refusal: { code: 'invalid', message: 'A departure cannot be before the arrival.' } };
  }

  const stopPatch: StopEventPatch['stopPatch'] = {};
  let title = '';
  if (input.kind === 'arrived') {
    stopPatch.arrivedAt = input.at;
    stopPatch.status = 'in_progress';
    title = `Arrived at ${stopLabel(stop)}`;
  } else {
    stopPatch.departedAt = input.at;
    stopPatch.status = 'completed';
    if (!stop.arrivedAt) stopPatch.arrivedAt = input.at;
    // The departure is its own moment (rule 1.5): Loaded was the BOL's, this one is the road's.
    title = stop.kind === 'pickup' ? `Departed ${stopLabel(stop)}` : `Delivered at ${stopLabel(stop)}`;
  }
  // Detention runs from the later of arrival and appointment, past the free time, until departure.
  const detention = input.kind === 'arrived' ? null : detentionAt({ ...stop, arrivedAt: stopPatch.arrivedAt ?? stop.arrivedAt }, input.at);
  if (detention && detention.minutes > 0) stopPatch.detentionMinutes = detention.minutes;

  const after = {
    ...load,
    stops: load.stops.map((s) => (s.id === stop.id ? { ...s, ...stopPatch } : s)),
  };
  // The last delivery's departure is the delivery. Whether the POD has been filed is a separate
  // question, answered by `missingPaperwork` and enforced in billing; holding the load at "at
  // delivery" until the paperwork arrives would misreport where the freight is.
  const completes = stop.kind === 'delivery' && input.kind !== 'arrived' && allDeliveriesComplete(after);
  const finishedLast = completes;

  return {
    patch: {
      stopId: stop.id,
      stopPatch,
      ...(detention && detention.minutes > 0
        ? {
            detentionCharge: {
              stopId: stop.id,
              minutes: detention.minutes,
              amount: detention.amount,
              freeTimeMinutes: detention.freeTimeMinutes,
              description: `Detention at ${stopLabel(stop)} · ${detention.minutes} min past ${detention.freeTimeMinutes} min free`,
            },
          }
        : {}),
      status: completes ? 'delivered' : statusAfterStopEvent(load, stop, input.kind),
      ...(completes ? { deliveredAt: input.at } : {}),
      completesLoad: finishedLast,
      event: event(load, {
        kind: input.kind === 'arrived' ? 'arrived' : 'departed',
        title,
        detail: [`${timeInZone(input.at, stop.timezone)}`, input.note?.trim()].filter(Boolean).join(' · '),
        stopId: stop.id,
        at: now,
        actor,
      }),
    },
  };
}

export interface AssignmentPatch {
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckUnit: string | null;
  trailerId: string | null;
  trailerUnit: string | null;
  status: LoadStatusCode | null;
  event: TimelineLike;
}

/**
 * Putting a driver and a truck on a load, or taking them off.
 *
 * A booked load that gains both becomes `assigned` on its own - the status is what the record
 * already says, not a second thing to click. Nothing here dispatches: that is a promise a person
 * makes.
 */
export function assignmentPatch(
  load: Pick<LoadLike, 'status' | 'loadNumber' | 'timeline' | 'driverId' | 'truckId' | 'trailerId'> & Record<string, unknown>,
  input: Omit<AssignLoadInput, 'expectedUpdatedAt'>,
  actor: ProgressActor,
  now: string,
): { patch: AssignmentPatch } | { refusal: ProgressRefusal } {
  if (load.status === 'closed' || load.status === 'cancelled' || load.status === 'tonu') {
    return { refusal: { code: 'invalid', message: `${load.loadNumber} is ${load.status}; its assignment cannot change.` } };
  }
  if (load.status === 'delivered' && input.driverId === null) {
    return { refusal: { code: 'invalid', message: 'A delivered load keeps the driver who ran it.' } };
  }
  const truckId = input.truckId === undefined ? ((load.truckId as string | null) ?? null) : input.truckId;
  const trailerId = input.trailerId === undefined ? ((load.trailerId as string | null) ?? null) : input.trailerId;
  const was = (load.driverName as string | null) ?? 'nobody';
  const now2 = input.driverName ?? null;
  const status: LoadStatusCode | null =
    load.status === 'booked' && input.driverId && truckId ? 'assigned' : null;
  return {
    patch: {
      driverId: input.driverId,
      driverName: now2,
      truckId,
      truckUnit: input.truckUnit === undefined ? ((load.truckUnit as string | null) ?? null) : input.truckUnit,
      trailerId,
      trailerUnit: input.trailerUnit === undefined ? ((load.trailerUnit as string | null) ?? null) : input.trailerUnit,
      status,
      event: event(load, {
        kind: 'assigned',
        title: input.recovery
          ? `Recovered from ${input.recovery.fromDriverName} (${input.recovery.fromUnit})`
          : input.driverId
            ? `Assigned to ${now2 ?? 'a driver'}`
            : 'Driver removed',
        detail: input.recovery
          ? [input.note?.trim(), input.recovery.summary].filter(Boolean).join(' — ')
          : [`was ${was}`, input.note?.trim()].filter(Boolean).join(' · '),
        stopId: null,
        at: now,
        actor,
      }),
    },
  };
}

/**
 * Whether a correction may be made by this person, now.
 *
 * `enteredAt` is when the value being corrected was recorded and `enteredBy` who recorded it -
 * both read from the load's own timeline, never from the caller.
 */
export function correctionRefusal(
  input: { enteredAt: string | null; enteredBy: string | null; reversesDelivery: boolean },
  actor: ProgressActor,
  now: string,
  windowMinutes = CORRECTION_WINDOW_MINUTES,
): ProgressRefusal | null {
  if (actor.isLead) return null;
  if (input.reversesDelivery) {
    return { code: 'forbidden', message: 'Taking a delivered load backwards takes a dispatch lead.' };
  }
  if (input.enteredBy && input.enteredBy !== actor.name) {
    return { code: 'forbidden', message: `That entry was made by ${input.enteredBy}; correcting it takes a dispatch lead.` };
  }
  if (!input.enteredAt) {
    return { code: 'forbidden', message: 'That entry has no record of when it was made; correcting it takes a dispatch lead.' };
  }
  const age = (Date.parse(now) - Date.parse(input.enteredAt)) / 60_000;
  if (Number.isNaN(age)) {
    return { code: 'forbidden', message: 'That entry has no usable time; correcting it takes a dispatch lead.' };
  }
  if (age > windowMinutes) {
    const hours = Math.round((windowMinutes / 60) * 10) / 10;
    return {
      code: 'forbidden',
      message: `That was recorded more than ${hours} h ago; correcting it now takes a dispatch lead.`,
    };
  }
  return null;
}

/** The timeline line a correction leaves: both values, the reason, and who made it. */
export function correctionEvent(
  load: Pick<LoadLike, 'loadNumber' | 'timeline'>,
  input: { what: string; from: string | null; to: string; reason: string; stopId: string | null },
  actor: ProgressActor,
  now: string,
): TimelineLike {
  return event(load, {
    kind: 'corrected',
    title: `Corrected ${input.what}`,
    detail: `${input.from ?? 'nothing'} → ${input.to} · ${input.reason}`,
    stopId: input.stopId,
    at: now,
    actor,
  });
}
