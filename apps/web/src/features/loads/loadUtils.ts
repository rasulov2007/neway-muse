import type { LoadEventKind, LoadStatus, Stop } from '@/demo';
import type { StatusTone } from '@/design-system';
import { COMPANY_TIMEZONE, LOCALE } from '@/lib/format';
import { openFile } from '@/lib/files';

/** `Sep 5, 7:52 AM` in the company timezone (or a facility timezone). */
export function formatShortDateTime(input: string | Date, timeZone = COMPANY_TIMEZONE): string {
  const date = typeof input === 'string' ? new Date(input) : input;
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(date);
}

/** `Sep 5, 8:00 – 10:00 AM CDT` in the facility timezone. */
export function formatAppointmentWindow(
  stop: Pick<Stop, 'appointmentStartAt' | 'appointmentEndAt' | 'timezone'>,
): string {
  const start = new Date(stop.appointmentStartAt);
  const end = new Date(stop.appointmentEndAt);
  const day = new Intl.DateTimeFormat(LOCALE, {
    timeZone: stop.timezone,
    month: 'short',
    day: 'numeric',
  }).format(start);
  const time = new Intl.DateTimeFormat(LOCALE, {
    timeZone: stop.timezone,
    hour: 'numeric',
    minute: '2-digit',
  });
  const zone =
    new Intl.DateTimeFormat(LOCALE, { timeZone: stop.timezone, timeZoneName: 'short' })
      .formatToParts(start)
      .find((p) => p.type === 'timeZoneName')?.value ?? '';
  return `${day}, ${time.format(start)} – ${time.format(end)} ${zone}`.trim();
}

/** Tone for a timeline event, derived from its kind (never from color alone). */
export function eventTone(kind: LoadEventKind): StatusTone {
  switch (kind) {
    case 'delivered':
    case 'closed':
    case 'loaded':
      return 'success';
    case 'exception_raised':
    case 'cancelled':
      return 'danger';
    case 'eta_changed':
      return 'warning';
    case 'note_added':
    case 'document_uploaded':
      return 'neutral';
    default:
      return 'info';
  }
}

export const TRACKING_EVENT_KINDS: ReadonlySet<LoadEventKind> = new Set([
  'arrived',
  'departed',
  'eta_changed',
]);

/** Statuses a dispatcher may move a load to from its current status. */
export const NEXT_STATUSES: Record<LoadStatus, LoadStatus[]> = {
  booked: ['assigned', 'cancelled', 'tonu'],
  assigned: ['dispatched', 'booked', 'cancelled'],
  dispatched: ['at_pickup', 'assigned', 'cancelled', 'tonu'],
  at_pickup: ['loading', 'loaded', 'tonu'],
  loading: ['loaded'],
  loaded: ['in_transit'],
  in_transit: ['at_delivery', 'unloading', 'delivered'],
  at_delivery: ['unloading', 'delivered'],
  unloading: ['delivered'],
  delivered: ['closed'],
  closed: [],
  cancelled: [],
  tonu: [],
};

export const DOCUMENT_TYPE_LABEL = {
  rate_confirmation: 'Rate con',
  bol: 'BOL',
  pod: 'POD',
  invoice: 'Invoice',
  lumper_receipt: 'Lumper',
  detention: 'Detention',
  tonu: 'TONU',
  layover: 'Layover',
  other: 'Other',
} as const;

export const EQUIPMENT_LABEL = {
  dry_van: 'Dry van',
  reefer: 'Reefer',
  flatbed: 'Flatbed',
} as const;

/**
 * Opens a filed document in a new tab.
 *
 * Returns false when there is nothing to open — paperwork filed before this build stored the
 * bytes is a real record with no file behind it, and the caller says so in its own words rather
 * than opening a blank tab.
 */
export function openDocumentFile(doc: {
  fileUrl?: string;
  dataUrl?: string;
  mimeType?: string;
  fileName: string;
}): boolean {
  return openFile(doc);
}

export function formatBytes(bytes: number): string {
  if (bytes <= 0) return '—';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const LOAD_TABS = [
  'overview',
  'tracking',
  'documents',
  'financial',
  'timeline',
  'notes',
] as const;
export type LoadTab = (typeof LOAD_TABS)[number];
