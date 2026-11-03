import { z } from 'zod';
import type { DocumentLike, DocumentReviewState, LoadLike, LoadStatusCode, StopLike } from './model.js';
import { timeInZone } from './format-time.js';

/**
 * Uploads suggest; people confirm (P0.5).
 *
 * A file arriving is evidence that something may have happened, not the thing itself. A BOL
 * suggests the truck was loaded; a POD suggests the freight was delivered. The suggestion names
 * the stop and the time it would use - the stop's own arrival where there is one - and nothing
 * moves until a person says yes. What a confirmation may do is narrow on purpose: it completes
 * the one stop named, it never completes every stop, it never clears a problem, and it never
 * invents a dispatch time the load does not have.
 */
export interface UploadSuggestion {
  kind: 'mark_loaded' | 'mark_delivered';
  stopId: string;
  /** The time the confirmation would record, ISO. */
  at: string;
  /** Where the time came from, so the prompt can say so. */
  timeSource: 'arrival' | 'now';
  /** `Mark loaded at 2:25 AM EDT?` */
  prompt: string;
}

/** The pickup a BOL speaks for: the last pickup not yet completed, else the last pickup. */
function pickupFor(load: Pick<LoadLike, 'stops'>): StopLike | null {
  const pickups = load.stops.filter((stop) => stop.kind === 'pickup');
  return pickups.find((stop) => stop.status !== 'completed') ?? pickups[pickups.length - 1] ?? null;
}

/**
 * The delivery a POD speaks for: the first one still open, so a load with two receivers is not
 * marked delivered at the second while the first is still ahead (owner, 2026-10-28).
 */
function deliveryFor(load: Pick<LoadLike, 'stops'>): StopLike | null {
  const deliveries = load.stops.filter((stop) => stop.kind === 'delivery');
  return deliveries.find((stop) => stop.status !== 'completed') ?? deliveries[deliveries.length - 1] ?? null;
}

const LOADED_RANK = new Set<LoadStatusCode>(['loaded', 'in_transit', 'at_delivery', 'unloading', 'delivered', 'closed']);
const DONE = new Set<LoadStatusCode>(['delivered', 'closed', 'cancelled', 'tonu']);

/**
 * What an upload of `type` suggests for this load right now, or null when there is nothing to
 * suggest - a rate confirmation says nothing about movement, and a BOL on a load already loaded
 * is filing, not news.
 */
export function suggestionForUpload(
  load: Pick<LoadLike, 'status' | 'stops'>,
  type: DocumentLike['type'],
  now: string,
): UploadSuggestion | null {
  if (type === 'bol') {
    if (LOADED_RANK.has(load.status) || DONE.has(load.status)) return null;
    const stop = pickupFor(load);
    if (!stop || stop.status === 'completed') return null;
    const at = stop.arrivedAt ?? now;
    return {
      kind: 'mark_loaded',
      stopId: stop.id,
      at,
      timeSource: stop.arrivedAt ? 'arrival' : 'now',
      prompt: `Mark loaded at ${timeInZone(at, stop.timezone)}?`,
    };
  }
  if (type === 'pod') {
    if (DONE.has(load.status)) return null;
    const stop = deliveryFor(load);
    if (!stop || stop.status === 'completed') return null;
    const at = stop.arrivedAt ?? now;
    return {
      kind: 'mark_delivered',
      stopId: stop.id,
      at,
      timeSource: stop.arrivedAt ? 'arrival' : 'now',
      prompt: `Delivered at ${timeInZone(at, stop.timezone)}?`,
    };
  }
  return null;
}

export const ConfirmUploadSchema = z.object({
  kind: z.enum(['mark_loaded', 'mark_delivered']),
  stopId: z.string().min(1),
  /** ISO. The time the person accepted or corrected. */
  at: z.string().min(1),
  /** The Daily Board word the person chose, when the confirmation came from the board. */
  boardStatus: z.string().trim().max(24).optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type ConfirmUploadInput = z.infer<typeof ConfirmUploadSchema>;

export interface ConfirmationPatch {
  status: LoadStatusCode | null;
  stopId: string;
  stopPatch: Partial<Pick<StopLike, 'status' | 'arrivedAt' | 'departedAt' | 'loadedAt'>>;
  deliveredAt?: string;
  eventKind: 'loaded' | 'delivered';
  eventTitle: string;
}

export type ConfirmRefusal = { code: 'stop' | 'status' | 'time'; message: string };

/**
 * The change a confirmed suggestion makes. Only the named stop moves; the load's status moves
 * to the matching stage only when it is behind it - a load already in transit is not dragged
 * back to "loaded" by a late BOL. `deliveredAt` is written only for a delivery, and
 * `dispatchedAt` is never touched here.
 */
export function confirmationPatch(
  load: Pick<LoadLike, 'status' | 'stops' | 'loadNumber' | 'dispatchedAt'>,
  input: Pick<ConfirmUploadInput, 'kind' | 'stopId' | 'at'>,
  now: string,
): { patch: ConfirmationPatch } | { refusal: ConfirmRefusal } {
  const stop = load.stops.find((s) => s.id === input.stopId);
  if (!stop) return { refusal: { code: 'stop', message: 'That stop is no longer on the load.' } };
  if (DONE.has(load.status)) {
    return { refusal: { code: 'status', message: `${load.loadNumber} is ${load.status}; nothing to confirm.` } };
  }
  const atMs = Date.parse(input.at);
  if (Number.isNaN(atMs)) return { refusal: { code: 'time', message: 'That time does not parse.' } };
  if (atMs > Date.parse(now) + 5 * 60_000) {
    return { refusal: { code: 'time', message: 'That time is in the future.' } };
  }
  if (input.kind === 'mark_loaded') {
    if (stop.kind !== 'pickup') return { refusal: { code: 'stop', message: 'A BOL belongs to a pickup.' } };
    const behind = !LOADED_RANK.has(load.status);
    /*
     * Loaded is not departed (rule 1.5). The BOL says the freight went on at this time; the stop
     * stays open until the truck actually leaves - Samsara's geofence or the board says when -
     * and the detention clock keeps running on the dock in between. Nothing here invents a
     * departure, and nothing here invents a dispatched time either.
     */
    // A BOL that arrives after the truck has rolled records when the freight went on and does
    // not reopen a stop the truck has already left.
    const departed = stop.status === 'completed' || Boolean(stop.departedAt) || !behind;
    return {
      patch: {
        status: behind ? 'loaded' : null,
        stopId: stop.id,
        stopPatch: {
          status: departed ? 'completed' : 'in_progress',
          arrivedAt: stop.arrivedAt ?? input.at,
          loadedAt: input.at,
          ...(departed && !stop.departedAt ? { departedAt: input.at } : {}),
        },
        eventKind: 'loaded',
        eventTitle: `Loaded at ${stop.facilityName || stop.city}`,
      },
    };
  }
  if (stop.kind !== 'delivery') return { refusal: { code: 'stop', message: 'A POD belongs to a delivery.' } };
  /*
   * A POD completes its own stop and nothing else (rule 1.5). With more deliveries still open
   * the load goes back on the road - "to stop 3 of 3" - and is Delivered only after the last
   * one's POD. The delivery time is the arrival somebody recorded, never the upload.
   */
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  const others = deliveries.filter((s) => s.id !== stop.id && s.status !== 'completed');
  const final = others.length === 0;
  const position = deliveries.findIndex((s) => s.id === stop.id) + 1;
  return {
    patch: {
      status: final ? 'delivered' : 'in_transit',
      stopId: stop.id,
      stopPatch: { status: 'completed', arrivedAt: stop.arrivedAt ?? input.at, departedAt: stop.departedAt ?? input.at },
      ...(final ? { deliveredAt: input.at } : {}),
      eventKind: 'delivered',
      eventTitle: final
        ? `Delivered at ${stop.facilityName || stop.city}`
        : `Delivered at ${stop.facilityName || stop.city} · stop ${position} of ${deliveries.length}, in transit to the next`,
    },
  };
}

// ------------------------------------------------------------------ review states

export const ReviewDocumentSchema = z
  .object({
    review: z.enum(['reviewed', 'verified', 'rejected']),
    /** Required to reject: the person who uploads the replacement needs to know what was wrong. */
    reason: z.string().trim().max(500).nullable().optional(),
    expectedUpdatedAt: z.string().min(1),
  })
  .refine((v) => v.review !== 'rejected' || (v.reason ?? '').trim().length >= 3, {
    message: 'A rejection needs a reason.',
    path: ['reason'],
  });
export type ReviewDocumentInput = z.infer<typeof ReviewDocumentSchema>;

/** The next review state, and what a person's word sets on the document. */
export function reviewPatch(
  doc: Pick<DocumentLike, 'review' | 'status'> & { supersededBy?: string | null },
  next: DocumentReviewState,
  actor: { id: string; name: string },
  now: string,
  reason?: string | null,
): Partial<DocumentLike> | { refusal: string } {
  const current = doc.review ?? (doc.status === 'verified' ? 'verified' : 'received');
  if (next === 'received') return { refusal: 'A document cannot go back to received.' };
  // A review belongs to the file that was looked at.
  if (doc.supersededBy) return { refusal: 'This file has been replaced. Review the replacement instead.' };
  if (next === 'rejected') {
    if (current === 'rejected') return { refusal: 'Already rejected.' };
    const why = (reason ?? '').trim();
    if (why.length < 3) return { refusal: 'A rejection needs a reason.' };
    return { review: 'rejected', rejectedReason: why, reviewedBy: actor.name, reviewedAt: now };
  }
  if (current === 'rejected') return { refusal: 'This file was rejected. Upload a replacement; the replacement is reviewed on its own.' };
  if (next === 'reviewed') {
    if (current !== 'received') return { refusal: 'Already reviewed.' };
    return { review: 'reviewed', reviewedBy: actor.name, reviewedAt: now };
  }
  if (current === 'verified') return { refusal: 'Already verified.' };
  return {
    review: 'verified',
    status: 'verified',
    reviewedBy: doc.review === 'reviewed' ? undefined : actor.name,
    reviewedAt: doc.review === 'reviewed' ? undefined : now,
    verifiedBy: actor.name,
    verifiedAt: now,
  };
}

/** What a document's review state reads as, with the person where there is one. */
/**
 * The files that count: filed, and not replaced by a later one.
 *
 * Billing, the queue and every "is it reviewed" question read these, so a reviewed old file can
 * never stand in for an unreviewed replacement, and a replaced file never blocks forever.
 */
export function currentDocuments<T extends Pick<DocumentLike, 'status' | 'fileName'> & { supersededBy?: string | null }>(docs: readonly T[]): T[] {
  return docs.filter((d) => d.status !== 'missing' && d.fileName.trim() !== '' && !d.supersededBy);
}

export function reviewLabel(doc: Pick<DocumentLike, 'review' | 'status' | 'verifiedBy' | 'reviewedBy'> & { supersededBy?: string | null; rejectedReason?: string | null }): string {
  if ((doc as { removedAt?: string | null }).removedAt) return 'Removed';
  if (doc.supersededBy) return 'Replaced by a newer file';
  const state = doc.review ?? (doc.status === 'verified' ? 'verified' : doc.status === 'missing' ? 'missing' : 'received');
  if (state === 'rejected') return doc.reviewedBy ? `Rejected by ${doc.reviewedBy}${doc.rejectedReason ? `: ${doc.rejectedReason}` : ''}` : 'Rejected';
  if (state === 'verified') return doc.verifiedBy ? `Verified by ${doc.verifiedBy}` : 'Verified (before names were kept)';
  if (state === 'reviewed') return doc.reviewedBy ? `Reviewed by ${doc.reviewedBy}` : 'Reviewed';
  if (state === 'missing') return 'Missing';
  return 'Received';
}

// ------------------------------------------------------------------ duplicates

export interface DuplicateWarning {
  documentId: string;
  type: DocumentLike['type'];
  match: 'hash' | 'fileName';
  message: string;
}

/**
 * The same file under two types is usually a mistake - the BOL filed again as the POD - and the
 * person is told before the upload lands. Same hash first, same file name second.
 */
export function duplicateWarning(
  existing: readonly Pick<DocumentLike, 'id' | 'type' | 'fileName' | 'fileHash' | 'title'>[],
  candidate: { type: DocumentLike['type']; fileName: string; fileHash?: string | null },
): DuplicateWarning | null {
  const label = (type: string) => type.replace(/_/g, ' ');
  for (const doc of existing) {
    if (doc.type === candidate.type) continue;
    if (candidate.fileHash && doc.fileHash && doc.fileHash === candidate.fileHash) {
      return {
        documentId: doc.id,
        type: doc.type,
        match: 'hash',
        message: `This is the same file already filed as the ${label(doc.type)} (${doc.fileName}).`,
      };
    }
  }
  for (const doc of existing) {
    if (doc.type === candidate.type) continue;
    if (doc.fileName.trim().toLowerCase() === candidate.fileName.trim().toLowerCase()) {
      return {
        documentId: doc.id,
        type: doc.type,
        match: 'fileName',
        message: `A file with this name is already filed as the ${label(doc.type)}.`,
      };
    }
  }
  return null;
}

// ------------------------------------------------------------------ attaching a document

/**
 * Filing a document from the server.
 *
 * The bytes are already in the file store; this records the paper on the load. It goes through
 * the server for the same reason the status does: a document written by a browser into the same
 * collection is lost the moment the server writes that collection from its own copy.
 */
export const AttachLoadDocumentSchema = z.object({
  type: z.enum(['rate_confirmation', 'bol', 'pod', 'invoice', 'lumper_receipt', 'detention', 'tonu', 'layover', 'other']),
  fileName: z.string().trim().min(1),
  sizeBytes: z.number().int().nonnegative(),
  mimeType: z.string().trim().min(1),
  fileUrl: z.string().trim().min(1),
  fileId: z.string().trim().min(1),
  fileHash: z.string().trim().nullable().optional(),
  title: z.string().trim().max(120).optional(),
  /**
   * The stop this paper belongs to, when it belongs to one.
   *
   * A two-delivery load is signed for twice, so "is the POD on file" is a question about the
   * stop, not about the load. Older documents carry no stop and still count for a load with a
   * single delivery.
   */
  stopId: z.string().min(1).nullable().optional(),
  /**
   * The file this one replaces, when it is a replacement. The replaced file stays on the record
   * with its review, but stops counting; this one starts unreviewed.
   */
  replacesId: z.string().min(1).nullable().optional(),
  /**
   * Where the file came from (0081). `driver_app` is the driver's own upload from the phone: it is
   * filed as received, shown as "Driver app" on the load and reviewed like any other file. Absent
   * = the office.
   */
  source: z.enum(['office', 'driver_app']).optional(),
  /** The roster driver who uploaded it from the app (resolved on the server, never sent by a phone). */
  uploadedByDriverId: z.string().min(1).nullable().optional(),
  /** Pages in the file, as the phone counted them (a multi-page scan arrives as one PDF). */
  pageCount: z.number().int().positive().max(200).nullable().optional(),
  /** The Idempotency-Key of the upload that filed it, so a retry is recognisable on the record. */
  idempotencyKey: z.string().min(1).max(200).nullable().optional(),
  /**
   * The amount on a lumper receipt, detention sheet, layover receipt or TONU confirmation (owner,
   * 2026-11-02): the paper and its charge in one write. See `DOCUMENT_CHARGE_TYPE`.
   */
  chargeAmount: z.number().positive().max(100_000).nullable().optional(),
  /** What the person wrote beside the files; kept on the timeline entry. */
  note: z.string().trim().max(2000).nullable().optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type AttachLoadDocumentInput = z.infer<typeof AttachLoadDocumentSchema>;

/** The paper that carries an accessorial's amount, and the charge it becomes (owner, 2026-11-02). */
export const DOCUMENT_CHARGE_TYPE: Partial<Record<AttachLoadDocumentInput['type'], 'lumper' | 'detention' | 'layover' | 'tonu'>> = {
  lumper_receipt: 'lumper',
  detention: 'detention',
  layover: 'layover',
  tonu: 'tonu',
};

/**
 * A file filed by mistake taken off the load (owner, 2026-11-02: a BOL filed as the POD). Never
 * erased: it stays on the record as removed, stops counting everywhere a replaced file stops
 * counting, and its charge is dropped. A BOL or POD can take the load back the step it moved.
 */
export const RemoveLoadDocumentSchema = z.object({
  reason: z.string().trim().min(3, 'Say why the file is being removed').max(500),
  /** For a BOL or POD: put the load (and the board) back where it was before the file moved it. */
  revertStatus: z.boolean().default(false),
  expectedUpdatedAt: z.string().min(1),
});
export type RemoveLoadDocumentInput = z.infer<typeof RemoveLoadDocumentSchema>;

/**
 * Accept or drop a drafted accessorial (owner, 2026-11-02: Accounting pressed Drop on a detention
 * and was refused for loads.edit). Only the charge's own decision - and, on accept, its amount -
 * so deciding it does not take the right to edit the whole load.
 */
export const DecideLoadChargeSchema = z.object({
  decision: z.enum(['accepted', 'dropped']),
  /** On accept: the amount the broker agreed, when it differs from the draft. */
  amount: z.number().positive().max(100_000).nullable().optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type DecideLoadChargeInput = z.infer<typeof DecideLoadChargeSchema>;

/** Load statuses a load passes through on the road, in order; what a reverted step goes back to. */
const ROAD_STATUSES = ['dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading', 'delivered'] as const;

/**
 * Where the load stood before the event this BOL or POD caused: the last road status on the
 * timeline before that event, else the stage the stops still prove.
 */
export function statusBeforeDocument(
  load: Pick<LoadLike, 'status' | 'stops' | 'timeline'>,
  doc: Pick<DocumentLike, 'type' | 'uploadedAt'>,
  remainingStops: LoadLike['stops'],
): LoadStatusCode | null {
  const kind = doc.type === 'pod' ? 'delivered' : doc.type === 'bol' ? 'loaded' : null;
  if (!kind) return null;
  const rank = (s: string) => ROAD_STATUSES.indexOf(s as (typeof ROAD_STATUSES)[number]);
  // Only when the load is still at the stage this paper took it to (or past it, for a BOL).
  if (rank(load.status) < rank(kind)) return null;
  const events = [...load.timeline].sort((a, b) => a.at.localeCompare(b.at));
  const cut = events.map((e) => e.kind).lastIndexOf(kind);
  const before = (cut >= 0 ? events.slice(0, cut) : events).map((e) => e.kind).filter((k) => rank(k) >= 0 && rank(k) < rank(kind));
  const fromTimeline = before.length > 0 ? (before[before.length - 1] as LoadStatusCode) : null;
  if (fromTimeline) return fromTimeline;
  const pickedUp = remainingStops.some((s) => s.kind === 'pickup' && s.status === 'completed');
  return kind === 'delivered' ? (pickedUp ? 'in_transit' : 'dispatched') : 'dispatched';
}

/**
 * The document a filing adds, and the placeholder it replaces.
 *
 * A required slot that was never filled is a placeholder, not paperwork: the filing takes its
 * place rather than sitting beside it, so a load never shows two PODs where one arrived.
 */
export function attachDocumentPatch(
  load: Pick<LoadLike, 'documents' | 'loadNumber'>,
  input: Omit<AttachLoadDocumentInput, 'expectedUpdatedAt'>,
  actor: { id: string; name: string },
  now: string,
): { documents: DocumentLike[]; document: DocumentLike } {
  const baseId = `doc_${Date.parse(now).toString(36)}_${input.type}`;
  // Two files of one type filed in the same millisecond (a driver's queue draining) must not share an id.
  const id = load.documents.some((d) => d.id === baseId) ? `${baseId}_${load.documents.length + 1}` : baseId;
  const document: DocumentLike = {
    id,
    type: input.type,
    title: input.title?.trim() || input.type.replace(/_/g, ' '),
    fileName: input.fileName,
    uploadedAt: now,
    uploadedBy: actor.name,
    status: 'pending',
    review: 'received',
    // Received is not verified: nobody has looked at it yet, and the record says so outright
    // rather than by leaving the fields off.
    verifiedBy: null,
    verifiedAt: null,
    reviewedBy: null,
    reviewedAt: null,
    fileId: input.fileId,
    fileHash: input.fileHash ?? null,
    ...(input.stopId ? ({ stopId: input.stopId } as object) : {}),
    ...(input.source ? ({ source: input.source } as object) : {}),
    ...(input.uploadedByDriverId ? ({ uploadedByDriverId: input.uploadedByDriverId } as object) : {}),
    ...(input.pageCount ? ({ pageCount: input.pageCount } as object) : {}),
    ...(input.idempotencyKey ? ({ idempotencyKey: input.idempotencyKey } as object) : {}),
    ...(input.replacesId ? ({ replacesId: input.replacesId } as object) : {}),
  };
  const rest = load.documents.filter(
    (d) => !(d.type === input.type && (d.status === 'missing' || d.fileName.trim() === '')),
  );
  // What this file replaces: the one named, or - when none is named - a rejected file of the same
  // type for the same stop, since a new upload after a rejection is the answer to it.
  const replaced = new Set<string>();
  if (input.replacesId) replaced.add(input.replacesId);
  else {
    for (const d of rest) {
      const sameStop = ((d as { stopId?: string | null }).stopId ?? null) === (input.stopId ?? null);
      if (d.type === input.type && d.review === 'rejected' && sameStop && !(d as { supersededBy?: string | null }).supersededBy) replaced.add(d.id);
    }
  }
  const kept = rest.map((d) => (replaced.has(d.id) ? { ...d, supersededBy: document.id, supersededAt: now } : d));
  return { documents: [...kept, { ...document, ...({ fileUrl: input.fileUrl, sizeBytes: input.sizeBytes, mimeType: input.mimeType } as object) }], document };
}

/**
 * How late the paperwork was, in whole days: the POD's upload against the delivery it proves.
 *
 * A POD that arrives eight days after the truck left the receiver does not move the delivery
 * date - the delivery happened when it happened - it is eight days of paperwork delay, said as
 * such. Null when there is nothing to measure.
 */
export function paperworkDelayDays(deliveredAt: string | null | undefined, uploadedAt: string | null | undefined): number | null {
  if (!deliveredAt || !uploadedAt) return null;
  const delivered = Date.parse(deliveredAt);
  const uploaded = Date.parse(uploadedAt);
  if (Number.isNaN(delivered) || Number.isNaN(uploaded)) return null;
  return Math.max(0, Math.floor((uploaded - delivered) / 86_400_000));
}

/**
 * Whether a document is owed yet (rule 1.6). A BOL is owed once the truck has reached the
 * pickup; a POD once it has reached a delivery; a rate confirmation from booking. Before that the
 * document is not missing, it is not yet due - and on a cancelled or TONU load nothing is owed.
 */
export function documentExpected(
  load: Pick<LoadLike, 'status' | 'stops'>,
  type: 'rate_confirmation' | 'bol' | 'pod' | string,
): boolean {
  if (load.status === 'cancelled' || load.status === 'tonu') return false;
  if (type === 'rate_confirmation') return true;
  const reached = (kind: 'pickup' | 'delivery') =>
    load.stops.some((s) => s.kind === kind && (s.arrivedAt !== null || s.status === 'in_progress' || s.status === 'completed'));
  if (type === 'bol') return reached('pickup') || ['loaded', 'in_transit', 'at_delivery', 'unloading', 'delivered', 'closed'].includes(load.status);
  if (type === 'pod') return reached('delivery') || ['delivered', 'closed'].includes(load.status);
  return true;
}
