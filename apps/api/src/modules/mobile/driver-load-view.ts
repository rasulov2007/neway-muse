import {
  DRIVER_DOCUMENT_STATE_LABEL,
  DRIVER_LOAD_STATUS_LABEL,
  driverDocumentState,
  driverLoadScopeOf,
  stopHandlingOf,
  type DriverLoadDocument,
  type DriverLoadScope,
  type DriverLoadSummary,
  type DriverStop,
  type DriverStopPlace,
  type LoadStatusCode,
  type StopEventLogEntry,
  type StopLike,
  type StoredLoad,
} from '@neway/shared';

/**
 * What the driver app is shown of a load: the route, the stops in their own zones, the papers a
 * driver handles and their review state. Never the rate, the charges, the broker's contacts or
 * internal notes.
 */

/** Papers a driver handles (and sends: TONU, layover and detention proof too). The RC and invoices stay in the office. */
const DRIVER_VISIBLE_TYPES = new Set(['bol', 'pod', 'lumper_receipt', 'tonu', 'layover', 'detention', 'other']);

function place(stop: StopLike | undefined): DriverStopPlace | null {
  if (!stop) return null;
  return {
    stopId: stop.id,
    kind: stop.kind,
    facilityName: stop.facilityName,
    city: stop.city,
    state: stop.state,
    appointmentStartAt: stop.appointmentStartAt,
    appointmentEndAt: stop.appointmentEndAt,
    timezone: stop.timezone,
  };
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

export function toDriverDocument(doc: StoredLoad['documents'][number], driverId: string): DriverLoadDocument {
  const extra = doc as unknown as Record<string, unknown>;
  const state = driverDocumentState({ review: doc.review ?? null, status: doc.status, supersededBy: str(extra['supersededBy']) });
  return {
    id: doc.id,
    type: doc.type,
    title: doc.title,
    fileName: doc.fileName,
    fileId: doc.fileId ?? null,
    mimeType: str(extra['mimeType']),
    sizeBytes: typeof extra['sizeBytes'] === 'number' ? (extra['sizeBytes'] as number) : null,
    pageCount: typeof extra['pageCount'] === 'number' ? (extra['pageCount'] as number) : null,
    stopId: str(extra['stopId']),
    uploadedAt: doc.uploadedAt,
    uploadedBy: doc.uploadedBy,
    source: extra['source'] === 'driver_app' ? 'driver_app' : 'office',
    mine: extra['uploadedByDriverId'] === driverId,
    state,
    stateLabel: DRIVER_DOCUMENT_STATE_LABEL[state],
    correctionReason: state === 'correction_requested' ? (doc.rejectedReason ?? null) : null,
    reviewedBy: doc.reviewedBy ?? null,
    reviewedAt: doc.reviewedAt ?? null,
    replacesId: str(extra['replacesId']),
    supersededBy: str(extra['supersededBy']),
  };
}

export function driverDocuments(load: StoredLoad, driverId: string): DriverLoadDocument[] {
  return (load.documents ?? [])
    .filter((d) => DRIVER_VISIBLE_TYPES.has(d.type) && d.status !== 'missing' && d.fileName.trim() !== '')
    .map((d) => toDriverDocument(d, driverId));
}

/** A mile figure on the load, or null when none is on file. */
function miles(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

export function toDriverSummary(load: StoredLoad, driverId: string): DriverLoadSummary | null {
  const scope = driverLoadScopeOf(load.status);
  if (!scope) return null;
  const stops = [...(load.stops ?? [])].sort((a, b) => a.sequence - b.sequence);
  const pickups = stops.filter((s) => s.kind === 'pickup');
  const deliveries = stops.filter((s) => s.kind === 'delivery');
  const docs = driverDocuments(load, driverId);
  return {
    id: load.id,
    loadNumber: load.loadNumber,
    reference: str(load['brokerReference']),
    status: load.status,
    statusLabel: DRIVER_LOAD_STATUS_LABEL[load.status as LoadStatusCode] ?? load.status,
    scope,
    firstPickup: place(pickups[0]),
    lastDelivery: place(deliveries[deliveries.length - 1]),
    nextStop: place(stops.find((s) => s.status !== 'completed')),
    stopCount: stops.length,
    loadedMiles: miles(load['loadedMiles']),
    deadheadMiles: miles(load['emptyMiles']),
    truckUnit: str(load['truckUnit']),
    trailerUnit: str(load['trailerUnit']),
    acknowledgedAt: (load['driverAck'] as { driverId?: string; at?: string } | undefined)?.driverId === driverId ? ((load['driverAck'] as { at: string }).at ?? null) : null,
    correctionsRequested: docs.filter((d) => d.state === 'correction_requested').length,
    updatedAt: load.updatedAt,
  };
}

export function toDriverStop(stop: StopLike): DriverStop {
  const extra = stop as unknown as Record<string, unknown>;
  return {
    id: stop.id,
    sequence: stop.sequence,
    kind: stop.kind,
    facilityName: stop.facilityName,
    address: str(extra['address']),
    city: stop.city,
    state: stop.state,
    zip: stop.zip ?? null,
    timezone: stop.timezone,
    appointmentStartAt: stop.appointmentStartAt,
    appointmentEndAt: stop.appointmentEndAt,
    appointmentNoWindow: Boolean(stop.appointmentNoWindow),
    handling: stopHandlingOf(stop),
    status: stop.status,
    arrivedAt: stop.arrivedAt,
    departedAt: stop.departedAt,
    loadedAt: stop.loadedAt ?? null,
    eventLog: Array.isArray(extra['eventLog']) ? (extra['eventLog'] as StopEventLogEntry[]) : [],
    reference: str(extra['reference']) ?? str(extra['referenceNumber']),
    notes: str(extra['notes']),
  };
}

/**
 * BOL / POD still owed, per stop: a pickup the truck has reached with no current BOL for it, a
 * delivery reached with no current POD. A rejected file does not count (it needs a replacement).
 */
export function documentsDue(load: StoredLoad): Array<{ type: 'bol' | 'pod'; stopId: string | null; label: string }> {
  if (load.status === 'cancelled' || load.status === 'tonu') return [];
  const current = (load.documents ?? []).filter((d) => d.status !== 'missing' && d.fileName.trim() !== '' && !(d as { supersededBy?: string | null }).supersededBy && d.review !== 'rejected');
  const out: Array<{ type: 'bol' | 'pod'; stopId: string | null; label: string }> = [];
  for (const kind of ['pickup', 'delivery'] as const) {
    const type = kind === 'pickup' ? 'bol' : 'pod';
    const ofKind = load.stops.filter((s) => s.kind === kind);
    for (const stop of ofKind) {
      const reached = stop.arrivedAt !== null || stop.status === 'in_progress' || stop.status === 'completed';
      if (!reached) continue;
      const has = current.some((d) => d.type === type && (((d as { stopId?: string | null }).stopId ?? null) === stop.id || (ofKind.length === 1 && !(d as { stopId?: string | null }).stopId)));
      if (!has) out.push({ type, stopId: stop.id, label: `${type === 'bol' ? 'BOL' : 'POD'} for ${stop.facilityName || `${stop.city}, ${stop.state}`}` });
    }
  }
  return out;
}

export function scopeSort(scope: DriverLoadScope, a: DriverLoadSummary, b: DriverLoadSummary): number {
  const pick = (s: DriverLoadSummary) => s.firstPickup?.appointmentStartAt ?? '';
  if (scope === 'completed') return b.updatedAt.localeCompare(a.updatedAt);
  return pick(a).localeCompare(pick(b));
}
