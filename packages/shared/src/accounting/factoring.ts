import { z } from 'zod';
import { sumCents } from './money.js';

/**
 * Factoring (§5). RTS advances the company money against issued invoices; the broker later
 * pays RTS. Two facts follow: one funding may cover several invoices, and the broker's payment
 * to RTS is not a second receipt for the company. A funding is therefore one payment, with the
 * actual fee and any reserve and extra fees, allocated across invoices; the net bank receipt
 * is what reached the account.
 */
export const RecordFundingSchema = z.object({
  provider: z.string().trim().min(1).max(80).default('RTS'),
  reference: z.string().trim().min(1).max(120),
  fundedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Fee actually charged on this funding, cents. Required: the configured fee is not used silently. */
  feeCents: z.number().int().min(0),
  /** Reserve / holdback withheld, cents; 0 when none. */
  reserveCents: z.number().int().min(0).default(0),
  extraFees: z.array(z.object({ label: z.string().trim().min(1).max(80), amountCents: z.number().int().min(0) })).default([]),
  /** Gross applied per invoice, cents; the sum is the gross funded. */
  allocations: z.array(z.object({ invoiceId: z.string().min(1), grossCents: z.number().int().positive() })).min(1),
  /** The amount that actually reached the bank, cents; must equal gross − fee − reserve − extras. */
  netReceivedCents: z.number().int().min(0),
  notes: z.string().trim().max(1000).optional(),
});
export type RecordFundingInput = z.infer<typeof RecordFundingSchema>;

export interface FundingCheck {
  ok: boolean;
  grossCents: number;
  expectedNetCents: number;
  errors: string[];
}

/** Arithmetic and balance checks before a funding is written. */
export function checkFunding(input: RecordFundingInput, invoices: Array<{ id: string; balanceCents: number; status: string }>): FundingCheck {
  const errors: string[] = [];
  const gross = sumCents(input.allocations.map((a) => a.grossCents));
  const expectedNet = gross - input.feeCents - input.reserveCents - sumCents(input.extraFees.map((f) => f.amountCents));
  if (expectedNet !== input.netReceivedCents) errors.push(`Gross ${gross} − fee ${input.feeCents} − reserve ${input.reserveCents} − extras = ${expectedNet} cents, but the net received says ${input.netReceivedCents}.`);
  const seen = new Set<string>();
  for (const a of input.allocations) {
    if (seen.has(a.invoiceId)) errors.push(`Invoice ${a.invoiceId} is allocated twice.`);
    seen.add(a.invoiceId);
    const inv = invoices.find((i) => i.id === a.invoiceId);
    if (!inv) errors.push(`Invoice ${a.invoiceId} is not on file.`);
    else if (!['issued', 'submitted', 'accepted', 'partially_paid', 'funded'].includes(inv.status)) errors.push(`Invoice ${a.invoiceId} is ${inv.status}; only an issued or submitted invoice can be funded.`);
    else if (a.grossCents > inv.balanceCents) errors.push(`Invoice ${a.invoiceId} has ${inv.balanceCents} cents open; ${a.grossCents} would overpay it.`);
  }
  return { ok: errors.length === 0, grossCents: gross, expectedNetCents: expectedNet, errors };
}
