import { RC_READER_TYPES, type RateConfirmationExtract, type RateConfirmationReadResult, type RcStop } from '@neway/shared';
import { apiPost } from '@/lib/api-client';
import { readAsDataUrl } from '@/lib/files';
import type { LoadFormInput } from './LoadFormSchema';

/**
 * The rate confirmation reader: upload the RC and the Add load form fills itself.
 *
 * The server reads the file (Claude) and proposes values; this file turns them into form fields.
 * The dispatcher still checks every field and books the load - nothing is saved by reading.
 */

export function canReadRc(file: File): boolean {
  return (RC_READER_TYPES as readonly string[]).includes(file.type);
}

export function readRateConfirmation(file: File): Promise<RateConfirmationReadResult> {
  return readAsDataUrl(file).then((content) =>
    apiPost<RateConfirmationReadResult>('/load-rate-confirmations/read', {
      fileName: file.name,
      contentType: file.type,
      content,
    }),
  );
}

interface BrokerLike {
  id: string;
  name: string;
  mcNumber?: string | null;
  doNotUse?: boolean;
}

export interface RcFill {
  values: Partial<LoadFormInput>;
  /** The broker the RC names, when it is not in the broker list yet. */
  unknownBroker: { name: string; mc: string | null } | null;
  /** What the dispatcher should look at before booking. */
  warnings: string[];
}

const digits = (s: string | null | undefined) => (s ?? '').replace(/\D/g, '');
const squash = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '').replace(/(llc|inc|corp|co|ltd)$/, '');

/** The broker on the list the RC means: same MC first, then the same name. */
export function matchBroker<B extends BrokerLike>(rc: RateConfirmationExtract, brokers: B[]): B | null {
  const usable = brokers.filter((b) => !b.doNotUse);
  const mc = digits(rc.brokerMc);
  if (mc) {
    const byMc = usable.find((b) => digits(b.mcNumber) === mc);
    if (byMc) return byMc;
  }
  if (rc.brokerName) {
    const name = squash(rc.brokerName);
    return usable.find((b) => squash(b.name) === name) ?? null;
  }
  return null;
}

const STATE = /^[A-Za-z]{2}$/;
const ZIP = /^\d{5}(-\d{4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/** The datetime-local text for a stop, or '' when the RC gives no usable date and time. */
function at(stop: RcStop): string {
  return stop.date && DATE.test(stop.date) && stop.time && TIME.test(stop.time) ? `${stop.date}T${stop.time}` : '';
}
function endAt(stop: RcStop): string {
  return stop.date && DATE.test(stop.date) && stop.endTime && TIME.test(stop.endTime) && stop.endTime !== stop.time
    ? `${stop.date}T${stop.endTime}`
    : '';
}
function place(stop: RcStop) {
  return {
    // Facility and street apart (owner, 2026-10-13).
    street: (stop.street ?? '').slice(0, 120),
    facility: (stop.facilityName ?? '').slice(0, 120),
    city: stop.city ?? '',
    state: stop.state && STATE.test(stop.state.trim()) ? stop.state.trim().toUpperCase() : '',
    zip: stop.zip && ZIP.test(stop.zip.trim()) ? stop.zip.trim() : '',
  };
}
const where = (stop: RcStop) => [stop.facilityName, stop.city].filter(Boolean).join(', ') || 'a stop';

export function rcToForm<B extends BrokerLike>(rc: RateConfirmationExtract, brokers: B[]): RcFill {
  const values: Partial<LoadFormInput> = {};
  const warnings = [...rc.warnings];

  const broker = matchBroker(rc, brokers);
  if (broker) values.brokerId = broker.id;
  const unknownBroker = !broker && rc.brokerName ? { name: rc.brokerName, mc: rc.brokerMc } : null;

  if (rc.brokerLoadNumber) values.brokerReference = rc.brokerLoadNumber.slice(0, 40);
  if (rc.commodity) values.commodity = rc.commodity.slice(0, 80);
  // Brokers print 0 or 1 when they do not know the weight; that is not a weight.
  if (rc.weightLbs && rc.weightLbs >= 100 && rc.weightLbs <= 80_000) values.weightLbs = Math.round(rc.weightLbs);
  else if (rc.weightLbs) warnings.push(`The RC gives the weight as ${rc.weightLbs} lb - type the real weight.`);
  const rate = rc.totalRate ?? rc.linehaulRate;
  if (rate && rate > 0) values.rate = rate;
  // The RC's own loaded miles win over the straight-line estimate (owner, 2026-10-26).
  if (rc.miles !== null && rc.miles > 0) values.loadedMiles = Math.round(rc.miles);
  if (rc.equipment && rc.equipment !== 'other') values.equipmentType = rc.equipment;
  if (rc.equipment === 'other') warnings.push('The RC asks for equipment other than a van, reefer or flatbed.');
  if (rc.hazmat !== null) values.hazmat = rc.hazmat;

  const stops = rc.stops;
  const firstPickup = stops.findIndex((s) => s.kind === 'pickup');
  let lastDelivery = -1;
  stops.forEach((s, i) => {
    if (s.kind === 'delivery') lastDelivery = i;
  });
  if (firstPickup >= 0) {
    const s = stops[firstPickup]!;
    const p = place(s);
    Object.assign(values, { originStreet: p.street, originFacility: p.facility, originCity: p.city, originState: p.state, originZip: p.zip, pickupAt: at(s), pickupEndAt: endAt(s) });
  } else warnings.push('No pickup found on the RC.');
  if (lastDelivery >= 0) {
    const s = stops[lastDelivery]!;
    const p = place(s);
    Object.assign(values, {
      destinationStreet: p.street,
      destinationFacility: p.facility,
      destinationCity: p.city,
      destinationState: p.state,
      destinationZip: p.zip,
      deliveryAt: at(s),
      deliveryEndAt: endAt(s),
    });
  } else warnings.push('No delivery found on the RC.');
  values.extraStops = stops
    .filter((_, i) => i !== firstPickup && i !== lastDelivery)
    .slice(0, 6)
    .map((s) => ({ kind: s.kind, ...place(s), at: at(s), endAt: endAt(s) }));
  for (const s of stops) {
    if (!at(s)) warnings.push(`No appointment time for ${where(s)} - type it in.`);
  }

  const refs = stops.filter((s) => s.reference).map((s) => `${s.kind === 'pickup' ? 'PU' : 'DEL'} ${s.city ?? ''}: ${s.reference}`.trim());
  const notes = [rc.temperature ? `Temp: ${rc.temperature}` : '', ...refs, rc.notes ?? ''].filter(Boolean).join('\n');
  if (notes) values.notes = notes.slice(0, 500);

  return { values, unknownBroker, warnings };
}
