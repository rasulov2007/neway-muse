import { z } from 'zod';

/**
 * RTS export batches: the issued invoices Accounting hands to the factoring company in one go.
 *
 * Three things are deliberately kept apart, because they are easy to confuse and costly to get
 * wrong. Creating an invoice turns a delivered load into a bill. A settlement batch pays drivers.
 * An RTS export batch - this - gathers issued invoices and their paperwork into a package for
 * RTS. RTS is not connected, so the batch is exported as files and a person uploads them; the
 * export itself tells nobody anything and changes no invoice's standing. Only when Accounting
 * records the submission, with a provider reference or a note of what they saw, do the invoices
 * become submitted.
 *
 * An invoice can sit in one live batch at a time. A batch that is cancelled before it is
 * submitted gives its invoices back; its record stays, with who cancelled it and why.
 */

export const RTS_BATCH_STATUSES = ['prepared', 'exported', 'submitted', 'cancelled'] as const;
export type RtsBatchStatus = (typeof RTS_BATCH_STATUSES)[number];

/** Statuses in which a batch still holds its invoices. */
export const RTS_LIVE_STATUSES: ReadonlySet<RtsBatchStatus> = new Set(['prepared', 'exported', 'submitted']);

/** The documents RTS needs behind every invoice. BOL is sent when there is one; see below. */
export const RTS_REQUIRED_DOCUMENTS = ['rate_confirmation', 'pod'] as const;
export const RTS_OPTIONAL_DOCUMENTS = ['bol'] as const;
/**
 * A TONU invoice (owner, 2026-10-30): no freight moved, so there is no POD or BOL. It goes with
 * the rate confirmation and the broker's TONU confirmation instead.
 */
export const RTS_TONU_REQUIRED_DOCUMENTS = ['rate_confirmation', 'tonu'] as const;

export interface RtsInvoiceLike {
  id: string;
  invoiceNumber: string;
  status: string;
  isCurrent?: boolean;
  total: number;
  loadNumber?: string | null;
  submission?: { status: string; simulated?: boolean } | null;
  factoring?: { billViaFactoring: boolean } | null;
  /** A TONU invoice: RC and TONU confirmation, no POD. */
  tonu?: boolean;
}

export interface RtsPackageDocument {
  id: string;
  type: string;
  fileName: string;
  /** False when the file has since been replaced or rejected on the load. */
  stillCurrent: boolean;
  hasBytes: boolean;
}

export interface RtsEligibility {
  eligible: boolean;
  /** Why it cannot be selected, in words Accounting can act on. Empty when eligible. */
  reasons: string[];
  /** Worth knowing but not blocking. */
  warnings: string[];
}

/** The reason a draft gives; a draft with no other reason is batched by issuing it first. */
export const RTS_DRAFT_REASON = 'Still a draft: issue it first.';

const TYPE_LABEL: Record<string, string> = { rate_confirmation: 'rate confirmation', pod: 'POD', bol: 'BOL', tonu: 'TONU confirmation' };

/**
 * Whether this invoice may go into a new RTS batch, and if not, why.
 *
 * `inBatch` is the live batch already holding it, if any: that is what stops the same invoice
 * being exported - and so submitted - twice by accident.
 */
export function rtsEligibility(
  inv: RtsInvoiceLike,
  documents: readonly RtsPackageDocument[],
  inBatch: { batchNumber: string; status: RtsBatchStatus } | null,
): RtsEligibility {
  const reasons: string[] = [];
  const warnings: string[] = [];
  if (inv.status === 'draft') reasons.push(RTS_DRAFT_REASON);
  else if (inv.status === 'void') reasons.push('Voided.');
  else if (inv.status !== 'issued') reasons.push(`Already ${inv.status.replace(/_/g, ' ')}: only an issued invoice that has not gone to RTS can be batched.`);
  if (inv.isCurrent === false) reasons.push('Superseded by a revision: batch the current revision instead.');
  if (inv.factoring && inv.factoring.billViaFactoring === false) reasons.push('Billed directly to the broker, not through RTS.');
  if (inv.total <= 0) reasons.push('Nothing to fund: the total is zero.');
  if (inv.submission?.simulated) reasons.push('Marked by a simulated test event; it cannot be sent for real.');
  if (inv.submission && inv.submission.status !== 'prepared') {
    reasons.push(inv.submission.status === 'rejected' ? 'RTS rejected it: correct it with a revision, then batch the revision.' : `RTS submission already recorded (${inv.submission.status}).`);
  }
  if (inBatch) reasons.push(`Already in ${inBatch.batchNumber} (${inBatch.status}). Cancel that batch first if it has to be redone.`);
  for (const type of inv.tonu ? RTS_TONU_REQUIRED_DOCUMENTS : RTS_REQUIRED_DOCUMENTS) {
    const docs = documents.filter((d) => d.type === type);
    if (docs.length === 0) reasons.push(`No ${TYPE_LABEL[type]} in the invoice's document package.`);
    else if (!docs.some((d) => d.stillCurrent)) reasons.push(`The ${TYPE_LABEL[type]} it was issued with has since been replaced or rejected: revise the invoice.`);
    else if (!docs.some((d) => d.stillCurrent && d.hasBytes)) reasons.push(`The ${TYPE_LABEL[type]} file is not in the file store.`);
  }
  for (const type of inv.tonu ? [] : RTS_OPTIONAL_DOCUMENTS) {
    if (!documents.some((d) => d.type === type && d.stillCurrent)) warnings.push(`No ${TYPE_LABEL[type]} in the package; RTS may ask for one.`);
  }
  return { eligible: reasons.length === 0, reasons, warnings };
}

/** The figures a person reviews before exporting: count, total, and the documents per invoice. */
export function rtsBatchTotals(lines: ReadonlyArray<{ totalCents: number; documents: readonly string[] }>) {
  return {
    count: lines.length,
    totalCents: lines.reduce((t, l) => t + l.totalCents, 0),
    missingRequired: lines.filter((l) => RTS_REQUIRED_DOCUMENTS.some((t) => !l.documents.includes(t))).length,
  };
}

/**
 * The schedule of accounts, one row per invoice.
 *
 * These columns are the ones a factoring schedule carries in general - which invoice, which
 * debtor, which load, how much. RTS's own upload template has not been provided, so the layout is
 * named for what it is and the column set sits here in one place, to be matched to the template
 * when the owner supplies it.
 */
export const RTS_SCHEDULE_COLUMNS = ['Invoice Number', 'Original Invoice', 'Revision', 'Invoice Date', 'Due Date', 'Debtor (Broker)', 'Load Number', 'Broker Reference', 'Invoice Amount', 'Previous Total', 'Adjustment', 'Amount To Fund', 'Documents'] as const;

export const CreateRtsBatchSchema = z.object({ invoiceIds: z.array(z.string().min(1)).min(1).max(500) });
export const CancelRtsBatchSchema = z.object({ reason: z.string().trim().min(3).max(500), expectedVersion: z.number().int().positive() });
export const RecordRtsSubmissionSchema = z
  .object({
    /** The reference RTS gave the upload (their batch or schedule number). */
    reference: z.string().trim().max(120).nullable().optional(),
    /** Or what the person saw, when RTS gave no reference. */
    evidence: z.string().trim().max(500).nullable().optional(),
    /** A screenshot or confirmation file, already in the file store. */
    evidenceFileId: z.string().min(1).nullable().optional(),
    submittedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    expectedVersion: z.number().int().positive(),
  })
  .refine((v) => Boolean(v.reference?.trim() || v.evidence?.trim() || v.evidenceFileId), {
    message: 'Say how you know it was submitted: RTS’s reference, a note of what you saw, or a file.',
    path: ['reference'],
  });
export type RecordRtsSubmissionInput = z.infer<typeof RecordRtsSubmissionSchema>;

// ------------------------------------------------------------------------------------------
// RTS FTPS upload (RTS "FTP Integration Requirements", 2026-10-19)
//
// RTS takes invoices one way only: one PDF per invoice named exactly after the invoice number,
// then one CSV listing them, dropped last - the CSV is RTS's trigger to take the folder. There is
// no API and nothing comes back, so NeWay records what it sent and when.
// ------------------------------------------------------------------------------------------

export const RTS_FTP_HOST = 'ftps.financial.rtspro.com';
/** The seven columns, in RTS's order (their example spreadsheet). */
export const RTS_FTP_COLUMNS = ['Client', 'Invoice#', 'DebtorNo', 'Debtor Name', 'Load #', 'InvDate', 'InvAmt'] as const;
export const RTS_FTP_MAX_INVOICES = 999;
/** RTS refuses back-to-back submissions: at least this long between two CSV drops. */
export const RTS_FTP_GAP_MINUTES = 5;
/** The invoice page RTS accepts: 8 x 10 inches, portrait (in PDF points). */
export const RTS_FTP_PAGE = { width: 576, height: 720 } as const;

export interface RtsFtpRowInput {
  clientNumber: string;
  invoiceNumber: string;
  /** The broker's name repeated: RTS's advice when there is no debtor id of our own (2026-10-19). */
  debtorNumber: string;
  debtorName: string;
  /** The broker's load / PO number, or ours when the RC gave none. */
  loadNumber: string;
  /** YYYY-MM-DD. */
  invoiceDate: string;
  amountCents: number;
}

/** The PDF RTS matches to the CSV row: the invoice number itself, ".pdf". */
export function rtsFtpFileName(invoiceNumber: string): string {
  return `${invoiceNumber.trim()}.pdf`;
}

/** MM/DD/YYYY, the date format RTS reads. */
export function rtsFtpDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : '';
}

export function rtsFtpRow(r: RtsFtpRowInput): string[] {
  return [r.clientNumber.trim(), r.invoiceNumber.trim(), r.debtorNumber.trim(), r.debtorName.trim(), r.loadNumber.trim(), rtsFtpDate(r.invoiceDate), (r.amountCents / 100).toFixed(2)];
}

/**
 * Everything RTS would refuse, in words, before anything is uploaded: a blank cell, a $0 or
 * negative amount, an invoice number twice, more than 999 rows, or a number that cannot be a file
 * name. Empty when the submission is good to go.
 */
export function rtsFtpProblems(rows: readonly RtsFtpRowInput[]): string[] {
  const out: string[] = [];
  if (rows.length === 0) out.push('Nothing to send.');
  if (rows.length > RTS_FTP_MAX_INVOICES) out.push(`RTS takes at most ${RTS_FTP_MAX_INVOICES} invoices at a time; this has ${rows.length}.`);
  const seen = new Set<string>();
  for (const r of rows) {
    const cells = rtsFtpRow(r);
    const label = r.invoiceNumber.trim() || '(no invoice number)';
    RTS_FTP_COLUMNS.forEach((col, i) => {
      if (!cells[i]) out.push(`${label}: ${col} is blank.`);
    });
    if (!(r.amountCents > 0)) out.push(`${label}: the amount must be more than $0.`);
    if (/[\/:*?"<>|]/.test(r.invoiceNumber)) out.push(`${label}: the invoice number has a character a file name cannot carry.`);
    const key = r.invoiceNumber.trim().toLowerCase();
    if (seen.has(key)) out.push(`${label}: listed twice.`);
    seen.add(key);
  }
  return out;
}

/** Minutes still to wait before the next CSV may go, given when the last one went. 0 = go. */
export function rtsFtpWaitMinutes(lastSentAt: string | null, now: Date): number {
  if (!lastSentAt) return 0;
  const left = RTS_FTP_GAP_MINUTES * 60_000 - (now.getTime() - Date.parse(lastSentAt));
  return left > 0 ? Math.ceil(left / 60_000) : 0;
}

export const SendRtsBatchSchema = z.object({ expectedVersion: z.number().int().positive() });

/** The CSV RTS reads: the header, then one row per invoice; a cell is quoted only when it must be. */
export function rtsFtpCsv(rows: readonly RtsFtpRowInput[]): string {
  const cell = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  return [[...RTS_FTP_COLUMNS], ...rows.map(rtsFtpRow)].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
