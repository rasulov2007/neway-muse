import type { LoadStatusCode } from '@/api/contract';
import { t } from '../i18n/core';
import { inEastern, inStopZone, sameOffset } from '@/lib/clock';
import type { StatusTone } from '@/ui/tokens';

/**
 * Load statuses as the phone shows them: a word and a tone (the pill adds the shape). Every code
 * in LOAD_STATUSES has an entry; anything unknown keeps a neutral pill with its own words.
 */
const LOAD_STATUS: Record<LoadStatusCode, { label: string; tone: StatusTone }> = {
  booked: { label: 'Booked', tone: 'info' },
  assigned: { label: 'Assigned', tone: 'info' },
  dispatched: { label: 'Dispatched', tone: 'info' },
  at_pickup: { label: 'At Pickup', tone: 'warning' },
  loading: { label: 'Loading', tone: 'warning' },
  loaded: { label: 'Loaded', tone: 'moving' },
  in_transit: { label: 'In Transit', tone: 'moving' },
  at_delivery: { label: 'At Delivery', tone: 'warning' },
  unloading: { label: 'Unloading', tone: 'warning' },
  delivered: { label: 'Delivered', tone: 'success' },
  closed: { label: 'Closed', tone: 'success' },
  cancelled: { label: 'Cancelled', tone: 'neutral' },
  tonu: { label: 'TONU', tone: 'neutral' },
};

export function loadStatus(code: string): { label: string; tone: StatusTone } {
  const known = LOAD_STATUS[code as LoadStatusCode];
  if (known) return { label: t(known.label), tone: known.tone };
  return { label: code.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase()), tone: 'neutral' };
}

const DOCUMENT_LABEL_EN: Record<string, string> = {
  rate_confirmation: 'Rate confirmation',
  bol: 'Bill of lading (BOL)',
  pod: 'Proof of delivery (POD)',
  invoice: 'Invoice',
  lumper_receipt: 'Lumper receipt',
  detention: 'Detention',
  tonu: 'TONU',
  layover: 'Layover',
  other: 'Other',
};

/** Document type words, read in the live language each time (getters, so screens just index it). */
export const DOCUMENT_LABEL: Record<string, string> = Object.defineProperties(
  {},
  Object.fromEntries(Object.entries(DOCUMENT_LABEL_EN).map(([k, v]) => [k, { enumerable: true, get: () => t(v) }])),
) as Record<string, string>;

export function documentReview(review: string | undefined | null, status?: string): { label: string; tone: StatusTone } {
  switch (review ?? status) {
    case 'received':
    case 'pending':
      return { label: t('Received'), tone: 'info' };
    case 'reviewed':
      return { label: t('Reviewed'), tone: 'success' };
    case 'verified':
      return { label: t('Verified'), tone: 'success' };
    case 'rejected':
      return { label: t('Rejected'), tone: 'danger' };
    case 'missing':
      return { label: t('Missing'), tone: 'danger' };
    default:
      return { label: review ?? status ?? t('Unknown'), tone: 'neutral' };
  }
}

export function sortedStops<S extends { sequence: number }>(stops: S[]): S[] {
  return [...stops].sort((a, b) => a.sequence - b.sequence);
}

export function placeOf(stop: { city: string; state: string } | null | undefined): string {
  if (!stop) return '';
  return [stop.city, stop.state].filter(Boolean).join(', ');
}

/** The first stop not completed yet — what the driver is heading to. */
export function nextStop<S extends { sequence: number; status: string; departedAt: string | null }>(stops: S[]): S | undefined {
  return sortedStops(stops).find((s) => s.status !== 'completed' && !s.departedAt);
}

/**
 * A stop's appointment in the stop's own zone, plus the Eastern business time beside it when the
 * zones differ (CLAUDE.md: never instead of it).
 */
export function appointment(stop: { appointmentStartAt: string; timezone: string }): { local: string | null; eastern: string | null } {
  const local = inStopZone(stop.appointmentStartAt, stop.timezone);
  const eastern = stop.appointmentStartAt && !sameOffset(stop.appointmentStartAt, stop.timezone || 'America/New_York')
    ? inEastern(stop.appointmentStartAt)
    : null;
  return { local, eastern };
}

/** The tone for a driver document state (received · reviewed · correction_requested · replaced). */
export function driverDocumentTone(state: string): StatusTone {
  switch (state) {
    case 'reviewed':
      return 'success';
    case 'correction_requested':
      return 'danger';
    case 'replaced':
      return 'neutral';
    default:
      return 'info';
  }
}
