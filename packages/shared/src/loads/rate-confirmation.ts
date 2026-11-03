import { z } from 'zod';

/**
 * Reading a broker's rate confirmation (RC) so the Add load form fills itself.
 *
 * The reader only proposes values: nothing is saved until the dispatcher checks the form and
 * books the load. Anything the RC does not say stays null - the reader never guesses.
 */

/** Files the reader accepts: the PDF brokers send, or a photo / scan of one. */
export const RC_READER_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;
export const RC_READER_MAX_BYTES = 20 * 1024 * 1024;

export const ReadRateConfirmationSchema = z.object({
  fileName: z.string().trim().min(1).max(200),
  contentType: z.enum(RC_READER_TYPES),
  /** The file as base64, or a data URL. */
  content: z.string().min(1),
});
export type ReadRateConfirmationInput = z.infer<typeof ReadRateConfirmationSchema>;

export const RcStopSchema = z.object({
  kind: z.enum(['pickup', 'delivery']),
  /** Shipper / receiver name as printed. */
  facilityName: z.string().nullable(),
  street: z.string().nullable(),
  city: z.string().nullable(),
  /** Two-letter US state or Canadian province code. */
  state: z.string().nullable(),
  zip: z.string().nullable(),
  /** Appointment (or window start) date, YYYY-MM-DD, in the stop's local time. */
  date: z.string().nullable(),
  /** Appointment (or window start) time, HH:mm 24-hour, local. Null when the RC gives none. */
  time: z.string().nullable(),
  /** Window end time, HH:mm 24-hour, when the RC gives a window. */
  endTime: z.string().nullable(),
  /** PU #, delivery #, PO # or appointment reference printed for this stop. */
  reference: z.string().nullable(),
});
export type RcStop = z.infer<typeof RcStopSchema>;

/** What the reader returns - also the JSON schema Claude is held to. */
export const RateConfirmationExtractSchema = z.object({
  brokerName: z.string().nullable(),
  /** MC number digits only. */
  brokerMc: z.string().nullable(),
  /** The broker's load / order / confirmation number. */
  brokerLoadNumber: z.string().nullable(),
  /** Total pay to the carrier in US dollars, all agreed accessorials included. */
  totalRate: z.number().nullable(),
  /** Linehaul alone, when the RC splits it out. */
  linehaulRate: z.number().nullable(),
  commodity: z.string().nullable(),
  weightLbs: z.number().nullable(),
  equipment: z.enum(['dry_van', 'reefer', 'flatbed', 'other']).nullable(),
  hazmat: z.boolean().nullable(),
  /** Reefer temperature as printed, e.g. "34°F continuous". */
  temperature: z.string().nullable(),
  /** Loaded miles, when printed. */
  miles: z.number().nullable(),
  /** Stops in route order: pickups and deliveries as the RC lists them. */
  stops: z.array(RcStopSchema),
  /** Short instructions worth keeping on the load (tracking, lumper, detention terms). */
  notes: z.string().nullable(),
  /** Anything unclear, missing or contradictory on the RC, in plain words. */
  warnings: z.array(z.string()),
});
export type RateConfirmationExtract = z.infer<typeof RateConfirmationExtractSchema>;

export interface RateConfirmationReadResult {
  extract: RateConfirmationExtract;
  /** Which model read it, for the record. */
  model: string;
}

const STATE_CODE = /^[A-Z]{2}$/;
const ZIP5 = /^\d{5}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * The checks every reader's answer goes through, whichever model or template produced it.
 *
 * - The carrier's own MC / DOT (printed in every RC's carrier block) is never the broker's.
 * - A placeholder weight (0, 1) is not a weight.
 * - State, ZIP, date and time are kept only in the shape the form takes; anything else is dropped
 *   with a warning rather than half-kept.
 */
export function tidyRcExtract(extract: RateConfirmationExtract, carrierNumbers: string[] = []): RateConfirmationExtract {
  const warnings = [...extract.warnings];
  const own = new Set(carrierNumbers.map((n) => n.replace(/\D/g, '')).filter(Boolean));
  // "PRO # 1112247" -> "1112247"; a number printed twice side by side is one number.
  let brokerLoadNumber =
    extract.brokerLoadNumber?.replace(/^\s*(pro|load|order|freight bill|shipment id|reference)(?=[\s#:.])\s*(#|no\.?|number|id)?\s*:?\s*/i, '').trim() || null;
  if (brokerLoadNumber) {
    const parts = brokerLoadNumber.split(/\s+/);
    if (parts.length > 1 && parts.every((p) => p === parts[0])) brokerLoadNumber = parts[0]!;
  }
  let brokerMc = extract.brokerMc ? extract.brokerMc.replace(/\D/g, '') || null : null;
  if (brokerMc && own.has(brokerMc)) brokerMc = null;

  let weightLbs = extract.weightLbs;
  if (weightLbs !== null && (weightLbs < 100 || weightLbs > 80_000)) {
    warnings.push(`The RC gives the weight as ${weightLbs} lb - type the real weight.`);
    weightLbs = null;
  }
  const money = (n: number | null) => (n !== null && n > 0 && n < 1_000_000 ? Math.round(n * 100) / 100 : null);

  const stops = extract.stops.map((s) => {
    const state = s.state ? s.state.trim().toUpperCase() : null;
    const zip = s.zip ? (s.zip.trim().match(/^(\d{5})(-\d{4})?$/)?.[1] ?? null) : null;
    const time = s.time && HH_MM.test(s.time.trim()) ? s.time.trim() : null;
    const endTime = s.endTime && HH_MM.test(s.endTime.trim()) && s.endTime.trim() !== time ? s.endTime.trim() : null;
    return {
      ...s,
      state: state && STATE_CODE.test(state) ? state : null,
      zip: zip && ZIP5.test(zip) ? zip : null,
      date: s.date && ISO_DATE.test(s.date.trim()) ? s.date.trim() : null,
      time,
      endTime,
    };
  });
  // Consistency checks (owner, 2026-10-02): a reader's slip should land in front of the dispatcher
  // as "check this", never pass quietly into the load.
  const totalRate = money(extract.totalRate);
  const linehaulRate = money(extract.linehaulRate);
  if (totalRate === null) warnings.push('No total rate was read - type the rate from the RC.');
  if (totalRate !== null && linehaulRate !== null && linehaulRate > totalRate) {
    warnings.push(`Linehaul $${linehaulRate} is more than the total $${totalRate} - check the rate.`);
  }
  if (brokerMc && (brokerMc.length < 4 || brokerMc.length > 8)) warnings.push(`Broker MC ${brokerMc} does not look like an MC number - check it.`);
  if (!brokerLoadNumber) warnings.push('No load number was read - type it from the RC.');
  if (stops.length === 0) warnings.push('No stops were read - add the pickup and delivery.');
  stops.forEach((s, i) => {
    if (s.time && s.endTime && s.endTime < s.time && s.endTime >= '06:00') {
      warnings.push(`Stop ${i + 1}: the window ends (${s.endTime}) before it starts (${s.time}) - check the times.`);
    }
    if (!s.date) warnings.push(`Stop ${i + 1} (${s.kind}) has no date - check the RC.`);
  });
  const dated = stops.filter((s) => s.date);
  for (let i = 1; i < dated.length; i++) {
    if (dated[i]!.date! < dated[i - 1]!.date!) {
      warnings.push(`Stop dates go backwards (${dated[i - 1]!.date} then ${dated[i]!.date}) - check the dates.`);
      break;
    }
  }
  return {
    ...extract,
    brokerLoadNumber,
    brokerMc,
    weightLbs,
    totalRate,
    linehaulRate,
    miles: extract.miles !== null && extract.miles > 0 ? Math.round(extract.miles) : null,
    stops,
    warnings: [...new Set(warnings)],
  };
}
