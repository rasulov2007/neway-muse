import { asQueueFile, type PickedMedia } from '@/lib/media';
import { uuid } from '@/lib/uuid';
import type { DriverPostPayload } from '@/offline/queue';
import type { QueueItem, QueueKind } from '@/offline/queue-core';

/**
 * Every driver write (M3 / M4) goes through the offline queue: saved on the phone first with its
 * own Idempotency-Key, its files sent to POST /driver/files, then the route. A retry can never
 * file a second record; offline, it waits on the phone and the Uploads list shows where it is.
 */
export interface DriverPostInput {
  kind: QueueKind;
  title: string;
  subtitle?: string | null;
  route: string;
  body: Record<string, unknown>;
  files?: PickedMedia[];
  fileField?: string;
  fileMode?: 'array' | 'single';
  ref?: Record<string, string | null>;
  /** A key made when the draft was opened, when the screen has one. */
  idempotencyKey?: string;
}

export function driverPostItem(input: DriverPostInput) {
  const payload: DriverPostPayload = {
    route: input.route,
    body: input.body,
    fileField: input.fileField,
    fileMode: input.fileMode,
    ref: input.ref,
  };
  return {
    id: uuid(),
    idempotencyKey: input.idempotencyKey ?? uuid(),
    kind: input.kind,
    title: input.title,
    subtitle: input.subtitle ?? null,
    payload: payload as unknown as Record<string, unknown>,
    files: (input.files ?? []).map(asQueueFile),
  };
}

/** The ref a queued driver-post carries (to find it from a screen). */
export function refOf(item: QueueItem): Record<string, string | null> {
  return ((item.payload as unknown as DriverPostPayload).ref ?? {}) as Record<string, string | null>;
}
