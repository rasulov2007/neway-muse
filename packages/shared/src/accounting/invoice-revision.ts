import { z } from 'zod';
import { REVENUE_ACCOUNT } from './ledger.js';

/**
 * Revising an issued invoice: the rules, apart from where they are stored.
 *
 * A revision is a new version in the same family, never an edit of the one that was issued. It
 * starts as a draft that posts nothing; issuing it posts only what changed, account by account;
 * the family's payments carry over untouched; and a revision that lowers the total below what was
 * already paid leaves an explicit credit owed to the customer - never a quiet zero, never an
 * invented refund.
 */

/**
 * The number a version carries: INV-10004, then INV2-10004, INV3-10004.
 *
 * The revision count goes in the prefix so the family's own number - the one the broker already
 * has - stays readable on every version. A family that does not have a letters-dash prefix gets
 * the count as a suffix instead. Numbers already issued under an older scheme are never changed.
 */
export function revisionInvoiceNumber(family: string, revision: number): string {
  if (revision <= 1) return family;
  const m = family.match(/^([A-Za-z]+)-(.+)$/);
  return m ? `${m[1]}${revision}-${m[2]}` : `${family}-${revision}`;
}

export interface RevisionLine {
  chargeType: string;
  description: string;
  amount: number;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * What issuing a revision changes on the books.
 *
 * Revenue moves per account, not as one net figure: moving $150 from "other" to "detention" at the
 * same total is still a change, and the old code skipped it because the total had not moved. When
 * nothing moves - a note-only revision - there is nothing to post at all.
 */
export function revisionPosting(previous: readonly RevisionLine[], next: readonly RevisionLine[]): {
  previousTotalCents: number;
  revisedTotalCents: number;
  deltaCents: number;
  byAccount: Array<{ accountCode: string; cents: number }>;
  postsAnything: boolean;
} {
  const byAccount = new Map<string, number>();
  const add = (l: RevisionLine, sign: 1 | -1) => {
    const code = REVENUE_ACCOUNT[l.chargeType] ?? '4500';
    byAccount.set(code, (byAccount.get(code) ?? 0) + sign * cents(l.amount));
  };
  for (const l of next) add(l, 1);
  for (const l of previous) add(l, -1);
  const moved = [...byAccount].filter(([, c]) => c !== 0).map(([accountCode, c]) => ({ accountCode, cents: c }));
  const previousTotalCents = previous.reduce((t, l) => t + cents(l.amount), 0);
  const revisedTotalCents = next.reduce((t, l) => t + cents(l.amount), 0);
  return { previousTotalCents, revisedTotalCents, deltaCents: revisedTotalCents - previousTotalCents, byAccount: moved, postsAnything: moved.length > 0 };
}

/**
 * What the family owes after a revision, given what it has been paid.
 *
 * Payments belong to the family, so they carry over. If the revised total is below them, the
 * difference is a credit owed to the customer, shown as such; nothing here refunds it.
 */
export function revisionBalance(revisedTotalCents: number, paidCents: number): { balanceCents: number; creditCents: number; status: 'issued' | 'partially_paid' | 'paid' | 'credit' } {
  const owed = revisedTotalCents - paidCents;
  if (owed < 0) return { balanceCents: owed, creditCents: -owed, status: 'credit' };
  if (owed === 0) return { balanceCents: 0, creditCents: 0, status: 'paid' };
  return { balanceCents: owed, creditCents: 0, status: paidCents > 0 ? 'partially_paid' : 'issued' };
}

/**
 * What a revision of an invoice RTS already has may ask RTS to fund.
 *
 * Only the increase is new. The revised total is not new funding eligibility: RTS has already
 * seen - and may have funded - the previous version. A decrease asks RTS for nothing; it is shown
 * so the adjustment can be settled with them.
 */
export function revisionFundable(input: { previousTotalCents: number; revisedTotalCents: number; previouslySubmitted: boolean }): { fundableCents: number; adjustmentCents: number } {
  const adjustmentCents = input.revisedTotalCents - input.previousTotalCents;
  if (!input.previouslySubmitted) return { fundableCents: input.revisedTotalCents, adjustmentCents };
  return { fundableCents: Math.max(0, adjustmentCents), adjustmentCents };
}

export const CreateRevisionSchema = z.object({
  reason: z.string().trim().min(3).max(500),
  lines: z
    .array(
      z.object({
        chargeType: z.string().min(1),
        description: z.string().trim().min(1).max(200),
        amount: z.number().finite(),
        /** The load's documents that support this charge, e.g. a broker's detention approval. */
        supportingDocumentIds: z.array(z.string().min(1)).max(10).optional(),
        loadChargeId: z.string().min(1).nullable().optional(),
      }),
    )
    .min(1),
  /** The note printed on the invoice. Changing it on an issued invoice is itself a revision. */
  invoiceNote: z.string().max(2000).nullable().optional(),
  expectedUpdatedAt: z.string().min(1),
});
export type CreateRevisionInput = z.infer<typeof CreateRevisionSchema>;

export const IssueRevisionSchema = z.object({ expectedUpdatedAt: z.string().min(1) });

export const InvoiceNoteSchema = z.object({ invoiceNote: z.string().max(2000).nullable(), expectedUpdatedAt: z.string().min(1) });

export const InternalNoteSchema = z.object({ text: z.string().trim().min(1).max(2000) });
