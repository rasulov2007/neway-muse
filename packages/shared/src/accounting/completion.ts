import type { BillingCondition, BillingQueue } from './billing.js';
import type { EarningLine } from './settlement-rules.js';

/**
 * The completed-load pipeline (section 3): one durable record per completed load saying what
 * the completion produced - the invoice candidate's queue and the earning per entitled
 * recipient - or why it could not be processed. Re-running is a no-op when nothing changed;
 * a retry never makes a second candidate or earning, because the load is the key.
 */
export interface EarningCandidate {
  recipientId: string;
  recipientName: string;
  role: 'driver' | 'co_driver';
  cents: number | null;
  lines: EarningLine[];
  planKind: string | null;
  planRate: number | null;
  planEffectiveFrom: string | null;
  rateConfirmed: boolean;
  blockers: string[];
  settlementId: string | null;
  settlementStatus: string | null;
}

export interface CompletionRecord {
  id: string;
  loadId: string;
  loadNumber: string;
  loadStatus: string;
  completedAt: string | null;
  grossCents: number;
  linehaulCents: number;
  state: 'processed' | 'error';
  error: string | null;
  attempts: number;
  processedAt: string;
  source: 'completion' | 'backfill' | 'retry' | 'rewrite';
  invoiceCandidate: { queue: BillingQueue | null; conditions: BillingCondition[]; invoiceId: string | null; invoiceStatus: string | null };
  earnings: EarningCandidate[];
  provenance: { firstSeenAt: string; firstSource: string };
}
