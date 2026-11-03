import type {
  RouteOptionsResult,
  AddLoadNoteRequest,
  CancelLoadRequest,
  ConfirmUploadInput,
  DocumentReviewState,
} from '@neway/shared';
import { ApiError, apiGet, apiPost } from '@/lib/api-client';
import { demoData } from './data';
import { flushPersistedState, pendingHydration } from './state-persist';
import { ensureLoads, patchLoadRecord, replaceLoad } from './loads-api';
import type { Load } from './types';

/**
 * The load writes that go to the server one record at a time (dispatch P0.1, P0.5).
 *
 * A cancel, a note, a document's review and a confirmed suggestion are written by
 * `POST /loads/:id/...` rather than by the whole-collection autosave: the server checks the
 * version the person was looking at, applies the rule (including who may cancel after
 * dispatch), stamps the author from the session, audits it, and hands the record back. The
 * record the server returns is what the screen shows; nothing here applies the rule itself.
 *
 * Every call flushes the autosave first, so a change made in this browser a moment ago is on
 * the server before the record's version is compared against it.
 */
interface WriteResponse {
  load: Load;
  collectionUpdatedAt: string;
}

async function ready(): Promise<void> {
  const hydration = pendingHydration();
  if (hydration) await hydration;
  await ensureLoads();
  await flushPersistedState();
}

function resolve(idOrNumber: string): Load {
  const load = demoData.loads.find((l) => l.id === idOrNumber || l.loadNumber === idOrNumber);
  if (!load) throw new Error('Load not found');
  return load;
}

async function write(loadId: string, path: string, body: Record<string, unknown>): Promise<Load> {
  await ready();
  const load = resolve(loadId);
  const response = await apiPost<WriteResponse>(`/loads/${encodeURIComponent(load.id)}/${path}`, {
    ...body,
    expectedUpdatedAt: load.updatedAt,
  });
  return replaceLoad(response.load);
}

/** What the server said, in the words the screen shows; a 409 says to reload the load. */
export function loadWriteMessage(error: unknown, fallback: string): string {
  if (error instanceof ApiError) return error.message || fallback;
  if (error instanceof Error) return error.message || fallback;
  return fallback;
}

export type CancelLoadInput = Omit<CancelLoadRequest, 'expectedUpdatedAt'>;

export function cancelLoad(loadId: string, input: CancelLoadInput): Promise<Load> {
  return write(loadId, 'cancel', input as Record<string, unknown>);
}

export type AddLoadNoteInput = Omit<AddLoadNoteRequest, 'expectedUpdatedAt'>;

/** A check call or a person's ETA (rule 1.4): heard from, nothing moves. */
export function recordCheckCall(
  loadId: string,
  input: { kind: 'check_call' | 'eta_changed'; at: string; location?: string; etaAt?: string; stopId?: string; note?: string },
): Promise<Load> {
  return write(loadId, 'check-call', input as Record<string, unknown>);
}

/** The receiver said yes to the appointment: kept on the stop, said on the timeline as a note. */
export async function confirmStopAppointment(loadId: string, stopId: string): Promise<Load> {
  await ready();
  const stored = resolve(loadId);
  const at = new Date().toISOString();
  const draft = structuredClone(stored);
  draft.stops = draft.stops.map((s) => (s.id === stopId ? { ...s, appointmentConfirmedAt: at } : s));
  const patched = await patchLoadRecord(stored, draft);
  const stop = patched.stops.find((s) => s.id === stopId);
  return write(loadId, 'notes', {
    kind: 'internal',
    body: `Appointment confirmed with ${stop?.facilityName || stop?.city || 'the receiver'}.`,
    pinned: false,
  });
}

/**
 * Route options from TollGuru for a load's stops (owner, 2026-10-27). The server holds the key
 * and the 24-hour cache; `refresh` asks TollGuru again.
 */
export async function fetchRouteOptions(loadId: string, refresh = false): Promise<RouteOptionsResult> {
  await ready();
  const load = resolve(loadId);
  return apiPost<RouteOptionsResult>(`/loads/${encodeURIComponent(load.id)}/route-options`, refresh ? { refresh: true } : {});
}

/** The road chosen from the options, by the id the server gave it. */
export function chooseLoadRoute(loadId: string, optionId: string): Promise<Load> {
  return write(loadId, 'route', { optionId });
}

export function clearLoadRoute(loadId: string): Promise<Load> {
  return write(loadId, 'route/clear', {});
}

export function addLoadNote(loadId: string, input: AddLoadNoteInput): Promise<Load> {
  return write(loadId, 'notes', input as Record<string, unknown>);
}

export function pinLoadNote(loadId: string, noteId: string, pinned: boolean): Promise<Load> {
  return write(loadId, 'notes/pin', { noteId, pinned });
}

export function reviewLoadDocument(
  loadId: string,
  documentId: string,
  review: Exclude<DocumentReviewState, 'received'>,
): Promise<Load> {
  return write(loadId, `documents/${encodeURIComponent(documentId)}/review`, { review });
}

/** A drafted accessorial accepted or dropped, on the server; Accounting may too (owner, 2026-11-02). */
export function decideLoadCharge(loadId: string, chargeId: string, input: { decision: 'accepted' | 'dropped'; amount?: number | null }): Promise<Load> {
  return write(loadId, `charges/${encodeURIComponent(chargeId)}/decide`, input);
}

/** A file filed by mistake taken off the load (owner, 2026-11-02); a BOL or POD may take the step back. */
export function removeLoadDocument(loadId: string, documentId: string, input: { reason: string; revertStatus: boolean }): Promise<Load> {
  return write(loadId, `documents/${encodeURIComponent(documentId)}/remove`, input);
}

export type ConfirmUploadRequest = Omit<ConfirmUploadInput, 'expectedUpdatedAt'>;

export function confirmUploadSuggestion(loadId: string, input: ConfirmUploadRequest): Promise<Load> {
  return write(loadId, 'confirm', input as Record<string, unknown>);
}

/** Whether the signed-in person holds the lead permission; the server decides, the screen asks. */
export async function fetchLeadStatus(): Promise<{ isLead: boolean }> {
  try {
    return await apiGet<{ isLead: boolean }>('/loads/me/lead', undefined, { background: true });
  } catch {
    // Not signed in or an older server: no lead powers are shown. The server refuses regardless.
    return { isLead: false };
  }
}
