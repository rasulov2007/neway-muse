/**
 * The shapes the load rules read (docs/dispatch/00-plan.md).
 *
 * Structural, not the app's full `Load`: a rule names only the fields it judges, so the same
 * function runs in the browser over the workspace record and on the server over the JSON it
 * stores, and neither has to import the other's types. Everything a rule does not name passes
 * through it untouched.
 */

export const LOAD_STATUSES = [
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
  'delivered',
  'closed',
  'cancelled',
  'tonu',
] as const;
export type LoadStatusCode = (typeof LOAD_STATUSES)[number];

export const CANCEL_OUTCOMES = ['cancelled', 'tonu'] as const;
export type CancelOutcome = (typeof CANCEL_OUTCOMES)[number];

export const DOCUMENT_TYPES = [
  'rate_confirmation',
  'bol',
  'pod',
  'invoice',
  'lumper_receipt',
  'detention',
  'tonu',
  'layover',
  'other',
] as const;
export type LoadDocumentType = (typeof DOCUMENT_TYPES)[number];

/**
 * Where a document stands with a person (P0.5). `received` is what an upload makes; `reviewed`
 * is somebody having looked; `verified` is a person's word, with their name and time.
 */
export const DOCUMENT_REVIEW_STATES = ['received', 'reviewed', 'verified', 'rejected'] as const;
export type DocumentReviewState = (typeof DOCUMENT_REVIEW_STATES)[number];

/**
 * How the freight goes on or comes off at a stop (owner, 2026-10-25): a live load / unload, with
 * the driver waiting at the dock, or a drop - leave the trailer, hook another. The driver's
 * Telegram message opens with it ("LIVE / DROP"). A stop that never said is live.
 */
export const STOP_HANDLINGS = ['live', 'drop'] as const;
export type StopHandling = (typeof STOP_HANDLINGS)[number];

/** A stop's handling as the rules read it: absent is live, the form's own default. */
export function stopHandlingOf(stop: { handling?: StopHandling | null } | null | undefined): StopHandling {
  return stop?.handling === 'drop' ? 'drop' : 'live';
}

export interface StopLike {
  id: string;
  sequence: number;
  kind: 'pickup' | 'delivery';
  facilityId?: string;
  facilityName: string;
  city: string;
  state: string;
  zip?: string | null;
  timezone: string;
  appointmentStartAt: string;
  appointmentEndAt: string;
  /** True when the customer gave one time and no window (P0.4). */
  appointmentNoWindow?: boolean;
  /** Live or drop (owner, 2026-10-25); absent on stops booked before it was asked = live. */
  handling?: StopHandling | null;
  status: string;
  arrivedAt: string | null;
  departedAt: string | null;
  /**
   * When the freight went on, at a pickup: the BOL's moment. Separate from `departedAt`, because
   * Loaded and In transit are separate statuses - a truck sits loaded on the dock for an hour
   * before it rolls, and the detention clock is still running while it does.
   */
  loadedAt?: string | null;
  /** Free time at this stop before detention, from the rate con; the config default when null. */
  freeTimeMinutes?: number | null;
}

export interface DocumentLike {
  id: string;
  type: LoadDocumentType;
  title: string;
  fileName: string;
  uploadedAt: string;
  uploadedBy: string;
  /** The older field: pending · verified · missing. Kept; `review` is the new word. */
  status: string;
  fileId?: string;
  fileHash?: string | null;
  review?: DocumentReviewState;
  reviewedBy?: string | null;
  /** Why a person rejected this file; a rejection always says why. */
  rejectedReason?: string | null;
  /**
   * The file that replaced this one. A review belongs to the file that was looked at: once a
   * replacement is filed, this one stays on the record for history but no longer counts, and the
   * replacement is reviewed on its own.
   */
  supersededBy?: string | null;
  supersededAt?: string | null;
  reviewedAt?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
}

export interface NoteLike {
  id: string;
  kind: 'internal' | 'broker' | 'driver';
  body: string;
  authorId?: string | null;
  authorName: string;
  at: string;
  pinned: boolean;
}

export interface TimelineLike {
  id: string;
  at: string;
  kind: string;
  actorType: string;
  actorName: string;
  title: string;
  detail: string | null;
  stopId: string | null;
}

export interface LoadLike {
  id: string;
  loadNumber: string;
  status: LoadStatusCode;
  schemaVersion?: number;
  dispatcherId: string;
  dispatcherName: string;
  /** The second owner of a rolling load (rule 1.7): updates it, sees it, is told about it. */
  updaterId?: string | null;
  updaterName?: string | null;
  driverId: string | null;
  truckId: string | null;
  trailerId: string | null;
  stops: StopLike[];
  documents: DocumentLike[];
  notes: NoteLike[];
  timeline: TimelineLike[];
  dispatchedAt: string | null;
  deliveredAt: string | null;
  updatedAt: string;
  cancellation?: Cancellation | null;
  /** The last hand that moved the status, and what kind of hand it was. */
  lastChangedBy?: { byId: string; byName: string; source: string } | null;
}

/** How the broker said yes: who, by what channel, and the reference or note that proves it. */
export interface BrokerApproval {
  by: string;
  method: 'email' | 'phone' | 'other';
  reference: string | null;
  at: string;
}

export interface Cancellation {
  outcome: CancelOutcome;
  reason: string;
  requestedBy: string;
  /** Absent only on records cancelled before approval was required (2026-09-25). */
  approval?: BrokerApproval | null;
  /** Dollars; only for TONU. */
  fee: number | null;
  at: string;
  byId: string;
  byName: string;
}

/** The statuses that mean the load is still somebody's work. */
export const ACTIVE_LOAD_STATUSES: readonly LoadStatusCode[] = [
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
];

export function isActiveLoadStatus(status: string): boolean {
  return (ACTIVE_LOAD_STATUSES as readonly string[]).includes(status);
}

export const LOAD_STATUS_RANK: Record<LoadStatusCode, number> = {
  booked: 1,
  assigned: 2,
  dispatched: 3,
  at_pickup: 4,
  loading: 5,
  loaded: 6,
  in_transit: 7,
  at_delivery: 8,
  unloading: 9,
  delivered: 10,
  closed: 11,
  cancelled: 99,
  tonu: 99,
};
