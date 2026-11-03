import { z } from 'zod';
import type { LoadStatusCode, StopHandling } from '../loads/model.js';
import type { StopEventLogEntry } from '../loads/write-rules.js';

/**
 * The driver app's API contract (docs/mobile/API.md, PLAN.md §B/§D).
 *
 * Every `/driver/*` route resolves the driver on the server from the session's membership
 * (`memberships.driver_id`). Nothing here carries a driver id or a company id the server would
 * believe: a client that sends one is ignored.
 */

// ------------------------------------------------------------------------------------- me

export interface DriverTelematics {
  /** samsara · motive · fiveeld · none … as the truck record says. */
  provider: string | null;
  /** Last position the ELD sync wrote onto the truck, as stored. */
  location: { lat: number | null; lng: number | null; text: string | null; at: string | null } | null;
  /** When the ELD sync last touched the truck; null = never. */
  syncedAt: string | null;
  /** Minutes since `syncedAt` by the server clock; null when never synced. */
  ageMinutes: number | null;
  /** fresh (≤ 60 min) · stale · none. */
  freshness: 'fresh' | 'stale' | 'none';
  /** Hours of service are not available from the TMS: the app says so instead of inventing them. */
  hos: { available: false; reason: string };
}

export interface DriverMe {
  driver: {
    id: string;
    driverNumber: string;
    name: string;
    firstName: string;
    lastName: string;
    status: string;
    driverType: string;
    phone: string | null;
    email: string | null;
    homeCity: string | null;
    homeState: string | null;
    preferredLanguage: string;
  };
  company: { id: string; name: string; timezone: string };
  truck: { id: string; unitNumber: string; make: string | null; model: string | null; year: number | null; plate: string | null; status: string; odometer: number | null } | null;
  trailer: { id: string; unitNumber: string; type: string | null; plate: string | null; status: string } | null;
  telematics: DriverTelematics | null;
  dispatch: DriverDispatchContact | null;
  /** The server clock, ISO, and the company's (Eastern) day: what "today" means in the app. */
  serverNow: string;
  today: string;
}

export interface DriverDispatchContact {
  name: string;
  phone: string | null;
  email: string | null;
}

// ------------------------------------------------------------------------------------- loads

export const DRIVER_LOAD_SCOPES = ['active', 'upcoming', 'completed'] as const;
export type DriverLoadScope = (typeof DRIVER_LOAD_SCOPES)[number];

/** Which scope a load status belongs to for the driver. Cancelled loads are not the driver's work. */
export function driverLoadScopeOf(status: string): DriverLoadScope | null {
  if (['dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading'].includes(status)) return 'active';
  if (status === 'booked' || status === 'assigned') return 'upcoming';
  if (status === 'delivered' || status === 'closed' || status === 'tonu') return 'completed';
  return null;
}

export const DRIVER_LOAD_STATUS_LABEL: Record<LoadStatusCode, string> = {
  booked: 'Booked',
  assigned: 'Assigned',
  dispatched: 'Dispatched',
  at_pickup: 'At pickup',
  loading: 'Loading',
  loaded: 'Loaded',
  in_transit: 'In transit',
  at_delivery: 'At delivery',
  unloading: 'Unloading',
  delivered: 'Delivered',
  closed: 'Closed',
  cancelled: 'Cancelled',
  tonu: 'TONU',
};

export interface DriverStopPlace {
  stopId: string;
  kind: 'pickup' | 'delivery';
  facilityName: string;
  city: string;
  state: string;
  /** Appointment (scheduled) start, ISO; shown in the stop's own zone beside Eastern. */
  appointmentStartAt: string;
  appointmentEndAt: string;
  /** The stop's IANA zone. */
  timezone: string;
}

export interface DriverLoadSummary {
  id: string;
  loadNumber: string;
  /** The broker's reference (LOAD # on the boards). */
  reference: string | null;
  status: LoadStatusCode;
  statusLabel: string;
  scope: DriverLoadScope;
  firstPickup: DriverStopPlace | null;
  lastDelivery: DriverStopPlace | null;
  /** The next stop not completed, when there is one. */
  nextStop: DriverStopPlace | null;
  stopCount: number;
  /** Loaded miles and deadhead to the pickup (owner, 2026-10-29); null when the load has none on file. */
  loadedMiles: number | null;
  deadheadMiles: number | null;
  truckUnit: string | null;
  trailerUnit: string | null;
  acknowledgedAt: string | null;
  /** Documents with a correction requested: the app badges the load. */
  correctionsRequested: number;
  updatedAt: string;
}

export interface DriverStop {
  id: string;
  sequence: number;
  kind: 'pickup' | 'delivery';
  facilityName: string;
  address: string | null;
  city: string;
  state: string;
  zip: string | null;
  /** The stop's own IANA zone: appointments and arrivals are said in it, beside Eastern. */
  timezone: string;
  /** Scheduled: the appointment. */
  appointmentStartAt: string;
  appointmentEndAt: string;
  appointmentNoWindow: boolean;
  handling: StopHandling;
  /** pending · in_progress · completed */
  status: string;
  /** Actual times. */
  arrivedAt: string | null;
  departedAt: string | null;
  loadedAt: string | null;
  /** Every recorded event for the stop: actual time, when it was recorded, by whom, from where, delay reason. */
  eventLog: StopEventLogEntry[];
  /** Pickup/delivery numbers and notes the dispatcher put on the stop, when there are any. */
  reference: string | null;
  notes: string | null;
}

/** The status words the app shows for a paper (owner brief 2026-10-27). */
export const DRIVER_DOCUMENT_STATES = ['received', 'reviewed', 'correction_requested', 'replaced'] as const;
export type DriverDocumentState = (typeof DRIVER_DOCUMENT_STATES)[number];

export const DRIVER_DOCUMENT_STATE_LABEL: Record<DriverDocumentState, string> = {
  received: 'Received by TMS · Needs review',
  reviewed: 'Reviewed',
  correction_requested: 'Correction requested',
  replaced: 'Replaced by a newer file',
};

/**
 * TMS review → what the driver reads. received → "Received by TMS · Needs review";
 * reviewed / verified → "Reviewed"; rejected → "Correction requested" (+ the reason); a file a
 * later upload replaced → "Replaced by a newer file".
 */
export function driverDocumentState(doc: { review?: string | null; status?: string | null; supersededBy?: string | null }): DriverDocumentState {
  if (doc.supersededBy) return 'replaced';
  const review = doc.review ?? (doc.status === 'verified' ? 'verified' : 'received');
  if (review === 'rejected') return 'correction_requested';
  if (review === 'reviewed' || review === 'verified') return 'reviewed';
  return 'received';
}

/** The types a driver may upload. */
export const DRIVER_DOC_TYPES = ['bol', 'pod', 'lumper_receipt', 'tonu', 'layover', 'detention', 'other'] as const;
export type DriverDocType = (typeof DRIVER_DOC_TYPES)[number];

export const DRIVER_DOC_TYPE_LABEL: Record<DriverDocType, string> = {
  bol: 'BOL',
  pod: 'POD',
  lumper_receipt: 'Lumper receipt',
  tonu: 'TONU',
  layover: 'Layover',
  detention: 'Detention',
  other: 'Other',
};

export interface DriverLoadDocument {
  id: string;
  type: string;
  title: string;
  fileName: string;
  /** stored_files id; open with GET /driver/files/:id/link. */
  fileId: string | null;
  mimeType: string | null;
  sizeBytes: number | null;
  pageCount: number | null;
  stopId: string | null;
  uploadedAt: string;
  uploadedBy: string;
  /** `driver_app` when the driver sent it from the phone; `office` otherwise. */
  source: 'driver_app' | 'office';
  /** True when this driver uploaded it. */
  mine: boolean;
  state: DriverDocumentState;
  stateLabel: string;
  /** Why it was sent back (correction requested). */
  correctionReason: string | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  /** The file this one replaced, and the one that replaced it. */
  replacesId: string | null;
  supersededBy: string | null;
}

export interface DriverLoadDetail extends DriverLoadSummary {
  stops: DriverStop[];
  /** Only the papers a driver deals with: BOL, POD, lumper receipts, other, and their history. */
  documents: DriverLoadDocument[];
  /** BOL / POD still owed for the load right now, by stop. */
  documentsDue: Array<{ type: 'bol' | 'pod'; stopId: string | null; label: string }>;
  dispatch: DriverDispatchContact | null;
  /** Notes the dispatcher wrote for the driver (kind `driver`); internal and broker notes stay in the office. */
  driverNotes: Array<{ id: string; body: string; authorName: string; at: string }>;
  /** Send this back as `expectedUpdatedAt` on a write to have a stale view refused (optional). */
  expectedUpdatedAt: string;
}

export interface DriverLoadsResponse {
  scope: DriverLoadScope;
  loads: DriverLoadSummary[];
}

// ------------------------------------------------------------------------------- writes

export const DriverAckSchema = z.object({
  /** Optional: refuse when the load changed since the driver opened it. */
  expectedUpdatedAt: z.string().min(1).optional(),
});
export type DriverAckRequest = z.input<typeof DriverAckSchema>;

export const DRIVER_STOP_EVENT_KINDS = ['arrived', 'departed', 'completed'] as const;

export const DriverStopEventSchema = z.object({
  stopId: z.string().min(1),
  kind: z.enum(DRIVER_STOP_EVENT_KINDS),
  /**
   * The actual time, ISO, when the driver says it happened earlier than now (sent from the
   * offline queue). Absent = the server clock at receipt. Never in the future.
   */
  at: z.string().min(1).optional(),
  delayReason: z.string().trim().max(200).optional(),
  note: z.string().trim().max(500).optional(),
  expectedUpdatedAt: z.string().min(1).optional(),
});
export type DriverStopEventRequest = z.input<typeof DriverStopEventSchema>;

/**
 * POST /driver/loads/:id/documents — the body is the file itself (application/octet-stream);
 * everything else rides in these headers. A multi-page paper is ONE file: the phone builds a PDF
 * from the scanned pages and sends `x-page-count`. A single page may be a JPEG/PNG/HEIC image.
 */
export const DRIVER_UPLOAD_HEADERS = {
  fileName: 'x-file-name',
  docType: 'x-doc-type',
  stopId: 'x-stop-id',
  pageCount: 'x-page-count',
  replacesId: 'x-replaces-id',
  idempotencyKey: 'idempotency-key',
} as const;

/** What an upload answers: the document as the server filed it, and the load's new version. */
export interface DriverDocumentUploadResponse {
  document: DriverLoadDocument;
  loadUpdatedAt: string;
}

export interface DriverFileUploadResponse {
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

export interface DriverFileLink {
  url: string;
  expiresAt: string;
}

/** The largest single upload the driver app may send. */
export const DRIVER_UPLOAD_MAX_BYTES = 25 * 1024 * 1024;
