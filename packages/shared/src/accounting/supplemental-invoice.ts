import { z } from 'zod';
import { percentOf, splitCents } from './money.js';
import type { AccessorialAllocation } from './settlement-rules.js';

/**
 * A charge that arrives after the invoice went to RTS (owner, 2026-10-21): a layover, detention,
 * lumper or any other accessorial the broker approves once the load has been billed.
 *
 * Factoring practice: an invoice RTS has been sent - or has bought - is never changed. The extra
 * is billed on a SUPPLEMENTAL invoice for the same load, broker and load reference, numbered after
 * the original (INV-10004-S1, -S2 ...), with its own backup (the layover receipt, the detention
 * sheet) and the original's RC / BOL / POD by reference. It goes through the same Billing queue:
 * issue, an RTS batch of its own, Send to RTS, funding. The original stays exactly as it was sent.
 *
 * Before the invoice has gone anywhere (a draft, or issued and not batched or sent) nothing here
 * applies: the invoice itself is corrected, by a revision, as before.
 */

/** INV-10004 → INV-10004-S1. The original's number stays readable so RTS and the broker match it. */
export function supplementInvoiceNumber(parentFamily: string, sequence: number): string {
  return `${parentFamily}-S${Math.max(1, Math.trunc(sequence))}`;
}

export interface SupplementParentLike {
  invoiceNumber: string;
  status: string;
  isCurrent: boolean;
  submission?: { status: string; simulated?: boolean } | null;
  factoring?: { fundedGross: number } | null;
  rtsBatch?: { batchId: string; batchNumber: string } | null;
  /** A supplement is never the parent of another: the next one hangs off the original too. */
  supplementOf?: { invoiceId: string } | null;
}

/**
 * Whether an extra charge on this invoice must go on a supplemental invoice, and if not, why.
 *
 * `sent` is the factoring question: has RTS (or the broker) been handed this invoice? It has when
 * a submission is recorded, when it sits in an RTS batch, or when money came in against it.
 */
export function supplementEligibility(parent: SupplementParentLike, inLiveBatch: boolean): { ok: true; why: string } | { ok: false; reason: string; useRevision: boolean } {
  if (parent.supplementOf) return { ok: false, reason: `${parent.invoiceNumber} is itself a supplemental invoice. Add the charge from the original invoice.`, useRevision: false };
  if (!parent.isCurrent) return { ok: false, reason: `${parent.invoiceNumber} is not the current version of its invoice.`, useRevision: false };
  if (parent.status === 'void') return { ok: false, reason: `${parent.invoiceNumber} is void.`, useRevision: false };
  if (parent.status === 'draft') return { ok: false, reason: `${parent.invoiceNumber} is still a draft. Void the draft and create the invoice again from the load, so it carries the new charge.`, useRevision: false };
  const submitted = Boolean(parent.submission && parent.submission.status !== 'prepared' && parent.submission.status !== 'rejected');
  const funded = (parent.factoring?.fundedGross ?? 0) > 0 || ['funded', 'paid', 'partially_paid'].includes(parent.status);
  if (funded) return { ok: true, why: `${parent.invoiceNumber} has been funded or paid` };
  if (submitted) return { ok: true, why: `${parent.invoiceNumber} has been sent to RTS (${parent.submission!.status})` };
  if (inLiveBatch) return { ok: true, why: `${parent.invoiceNumber} is in ${parent.rtsBatch?.batchNumber ?? 'an RTS batch'}` };
  return { ok: false, reason: `${parent.invoiceNumber} has not been sent to RTS yet. Add the charge to it with Create revision instead.`, useRevision: true };
}

/** The accessorials that can come in after billing. Linehaul never does. */
export const LATE_CHARGE_TYPES = ['layover', 'detention', 'lumper', 'stop_charge', 'fuel_surcharge', 'tonu', 'other'] as const;
export type LateChargeType = (typeof LATE_CHARGE_TYPES)[number];
export const LATE_CHARGE_LABEL: Record<LateChargeType, string> = {
  layover: 'Layover',
  detention: 'Detention',
  lumper: 'Lumper',
  stop_charge: 'Extra stop',
  fuel_surcharge: 'Fuel surcharge',
  tonu: 'TONU',
  other: 'Other',
};

export const AddChargeAfterInvoicingSchema = z.object({
  /** Made once when the dialog opens: a retry or a double click returns the same supplement. */
  requestKey: z.string().trim().min(8).max(80),
  /** Why the charge came after billing, e.g. "Layover approved by the broker 10/20". Audited. */
  reason: z.string().trim().min(3).max(500),
  charges: z
    .array(
      z.object({
        chargeType: z.enum(LATE_CHARGE_TYPES),
        description: z.string().trim().min(1).max(200),
        amount: z.number().finite().positive().max(1_000_000),
        /** The load's documents behind it - the layover receipt, the detention sheet. */
        supportingDocumentIds: z.array(z.string().min(1)).max(10).default([]),
        /** Proof uploaded in the dialog (already in the file store): filed on the load, then attached to this charge. */
        newFiles: z.array(z.object({ fileId: z.string().min(1), fileName: z.string().trim().min(1).max(200) })).max(5).default([]),
        /** Does the driver get (part of) it? Becomes Accounting's "Include in driver statement?" answer. */
        payableToDriver: z.boolean().default(false),
        driverPay: z.object({ mode: z.enum(['full', 'percent', 'fixed']), value: z.number().finite().min(0) }).nullable().optional(),
      }),
    )
    .min(1)
    .max(10),
  /** Printed on the supplemental invoice. */
  invoiceNote: z.string().max(2000).nullable().optional(),
  /** Issue it straight away (the usual case) or leave it a draft to issue from the queue. */
  issueNow: z.boolean().default(true),
  /** The original invoice as the person saw it: a stale screen is refused. */
  expectedUpdatedAt: z.string().min(1),
});
export type AddChargeAfterInvoicingInput = z.infer<typeof AddChargeAfterInvoicingSchema>;

/** The load document type a charge's proof is filed as. */
export function proofDocumentType(chargeType: string): 'layover' | 'detention' | 'lumper_receipt' | 'tonu' | 'other' {
  return chargeType === 'layover' ? 'layover' : chargeType === 'detention' ? 'detention' : chargeType === 'lumper' ? 'lumper_receipt' : chargeType === 'tonu' ? 'tonu' : 'other';
}

/** The default printed note: what this invoice is, in the words RTS and the broker read. */
export function supplementNote(parentNumber: string, loadNumber: string, loadReference: string | null): string {
  return `Supplemental invoice to ${parentNumber} for load ${loadNumber}${loadReference ? ` (broker ref ${loadReference})` : ''}: additional charges approved after the original invoice. The original invoice is unchanged.`;
}

/**
 * One driver's share of an accessorial under Accounting's allocation, in cents - the same arithmetic
 * a statement uses for a charge paid as its own line. Zero when the allocation does not pay them.
 */
export function accessorialShareCents(amountCents: number, al: Pick<AccessorialAllocation, 'treatment' | 'mode' | 'value' | 'recipients'> | null | undefined, driverId: string): number {
  if (!al || al.treatment !== 'paid_separately' || !al.recipients.includes(driverId)) return 0;
  const gross = al.mode === 'full' ? amountCents : al.mode === 'percent' ? percentOf(amountCents, al.value) : Math.round(al.value * 100);
  if (al.recipients.length <= 1) return gross;
  return splitCents(gross, al.recipients.length)[al.recipients.indexOf(driverId)] ?? 0;
}

/** The driver transaction that pays an accessorial added after the load's statement was approved. */
export const LATE_ACCESSORIAL_SOURCE = 'late_accessorial';
export function lateAccessorialKey(loadId: string, chargeId: string, driverId: string): string {
  return `${LATE_ACCESSORIAL_SOURCE}:${loadId}:${chargeId}:${driverId}`;
}
/** loadId and chargeId back from the key; null for any other source key. */
export function parseLateAccessorialKey(key: string): { loadId: string; chargeId: string; driverId: string } | null {
  const m = /^late_accessorial:([^:]+):([^:]+):([^:]+)$/.exec(key);
  return m ? { loadId: m[1]!, chargeId: m[2]!, driverId: m[3]! } : null;
}
