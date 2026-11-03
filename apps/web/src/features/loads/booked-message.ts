import {
  driverMessageFromRc,
  driverRateOf,
  isCompanyDriverType,
  localParts,
  type RateConfirmationExtract,
  type RcStop,
} from '@neway/shared';
import type { Load } from '@/demo';

/**
 * The Telegram message for the load just booked (owner, 2026-10-23).
 *
 * Written from the load as it was saved - the dispatcher may have corrected what the RC reader
 * filled in - with the RC adding only what the load does not keep (the pickup number, a reefer's
 * temperature). The money line follows the driver on the load: a company driver's message has no
 * Rate at all; anybody else (or nobody yet) sees the rate they are paid on, the For driver rate
 * when the load has one - never the broker's figure above it.
 */
export function bookedDriverMessage(
  load: Load,
  rc: RateConfirmationExtract | null,
  driver: { driverType?: string | null } | null,
): string {
  const stops: RcStop[] = load.stops.map((s, i) => {
    // The stop's own clock, as the appointment reads on the RC; never the browser's zone.
    const at = localParts(s.appointmentStartAt, s.timezone);
    const end = s.appointmentNoWindow ? null : localParts(s.appointmentEndAt, s.timezone);
    const fromRc = rc?.stops[i]?.kind === s.kind ? rc.stops[i] : undefined;
    const auto = `${s.city} ${s.kind}`;
    return {
      kind: s.kind,
      facilityName: s.facilityName && s.facilityName !== auto ? s.facilityName : (fromRc?.facilityName ?? null),
      street: s.address ?? fromRc?.street ?? null,
      city: s.city || null,
      state: s.state || null,
      zip: s.zip ?? null,
      date: at?.date ?? fromRc?.date ?? null,
      time: at?.time ?? fromRc?.time ?? null,
      endTime: end && end.time !== at?.time ? end.time : null,
      reference: fromRc?.reference ?? null,
    };
  });
  const extract: RateConfirmationExtract = {
    brokerName: load.brokerName,
    brokerMc: rc?.brokerMc ?? null,
    brokerLoadNumber: load.brokerReference || rc?.brokerLoadNumber || null,
    totalRate: load.rate,
    linehaulRate: null,
    commodity: load.commodity || null,
    weightLbs: load.weightLbs || null,
    equipment: load.equipmentType || null,
    hazmat: load.hazmat,
    temperature: rc?.temperature ?? null,
    miles: load.loadedMiles || rc?.miles || null,
    stops,
    notes: null,
    warnings: [],
  };
  // Live or drop at the first pickup and the last delivery opens the message (owner, 2026-10-25).
  const firstPickup = load.stops.find((s) => s.kind === 'pickup');
  const lastDelivery = [...load.stops].reverse().find((s) => s.kind === 'delivery');
  return driverMessageFromRc(extract, {
    hideRate: isCompanyDriverType(driver?.driverType),
    rate: driverRateOf(load),
    handling: { pickup: firstPickup?.handling ?? null, delivery: lastDelivery?.handling ?? null },
    // Empty / Loaded / Total, from the load as saved.
    emptyMiles: load.emptyMiles || null,
    // The road chosen from the TollGuru options (owner, 2026-10-27): road, miles, tolls.
    route: load.route ?? null,
    // "Need Trailer" above LIVE / DROP on every booked load, trailer chosen or not (owner, 2026-10-29).
    needTrailer: true,
  });
}
