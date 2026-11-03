import { Check, ChevronDown, ChevronRight, FileText, Upload, X } from 'lucide-react';
import { useState } from 'react';
import { Link } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Alert, Badge, Button, Textarea, useToast } from '@/design-system';
import { reviewBillingDocument, type BillingQueueRow } from '@/demo';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { ReceiptPreview } from './ReceiptPreview';

/**
 * RC, BOL and POD for one load, each reviewable where Accounting is already looking.
 *
 * The review used to live only in a dialog on the Loads list, so from Billing - where "not
 * reviewed" is what blocks the invoice - there was nothing to click. Each file here shows its
 * name, type, state and a preview, and carries its own Mark reviewed and Reject. A review
 * belongs to that file: a replacement starts unreviewed, and a replaced file is listed as history
 * and cannot be reviewed. Reviewing a document never clears the RC reference or duplicate
 * checks; those stay separate conditions below.
 */
type Doc = BillingQueueRow['load']['documents'][number] & {
  title?: string;
  reviewedBy?: string | null;
  reviewedAt?: string | null;
  verifiedBy?: string | null;
  verifiedAt?: string | null;
  rejectedReason?: string | null;
  supersededBy?: string | null;
  stopId?: string | null;
  /** driver_app: the driver sent it from the phone (mobile, 2026-10-27). */
  source?: string | null;
  fileId?: string | null;
  uploadedAt?: string;
  uploadedBy?: string;
};

const TYPES: ReadonlyArray<{ type: string; label: string; short: string; also?: readonly string[]; hint?: string }> = [
  { type: 'rate_confirmation', label: 'Rate confirmation', short: 'RC' },
  { type: 'bol', label: 'Bill of lading', short: 'BOL' },
  { type: 'pod', label: 'Proof of delivery', short: 'POD' },
];
/**
 * A TONU bills on the broker's TONU confirmation, never a BOL or a POD (owner, 2026-10-15). A
 * revised rate confirmation uploaded after the cancellation counts too - it shows in the RC row.
 */
const TONU_TYPES: ReadonlyArray<{ type: string; label: string; short: string; also?: readonly string[]; hint?: string }> = [
  { type: 'rate_confirmation', label: 'Rate confirmation', short: 'RC' },
  { type: 'tonu', label: 'TONU confirmation', short: 'TONU', also: ['other'], hint: 'Not uploaded - or upload the revised RC with the TONU amount' },
];

function stateOf(d: Doc): { word: string; tone: 'success' | 'warning' | 'danger' | 'neutral'; detail: string | null } {
  if (d.review === 'rejected') return { word: 'Rejected', tone: 'danger', detail: `${d.reviewedBy ?? 'Someone'}${d.reviewedAt ? ` · ${formatDateTime(d.reviewedAt)}` : ''} · ${d.rejectedReason ?? ''}` };
  if (d.review === 'verified') return { word: 'Reviewed', tone: 'success', detail: `Verified by ${d.verifiedBy ?? d.reviewedBy ?? 'someone'}${d.verifiedAt ? ` · ${formatDateTime(d.verifiedAt)}` : ''}` };
  if (d.review === 'reviewed') return { word: 'Reviewed', tone: 'success', detail: `By ${d.reviewedBy ?? 'someone'}${d.reviewedAt ? ` · ${formatDateTime(d.reviewedAt)}` : ''}` };
  // A paper the driver sent from the phone is looked at before it is billed (mobile, 2026-10-27).
  if (d.source === 'driver_app') return { word: 'Needs review', tone: 'warning', detail: `From the driver app${d.uploadedBy ? ` · ${d.uploadedBy}` : ''}${d.uploadedAt ? ` · ${formatIsoDate(d.uploadedAt.slice(0, 10))}` : ''}` };
  // On file is enough to bill; RTS checks the documents (owner, 2026-10-16).
  return { word: 'Uploaded', tone: 'success', detail: d.uploadedBy ? `Uploaded by ${d.uploadedBy}${d.uploadedAt ? ` · ${formatIsoDate(d.uploadedAt.slice(0, 10))}` : ''}` : null };
}

function fileIdOf(d: Doc): string | null {
  if (d.fileId) return d.fileId;
  const m = d.fileUrl?.match(/\/files\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]!) : null;
}

export function BillingDocuments({ row, canReview, onChanged }: { row: BillingQueueRow; canReview: boolean; onChanged: () => Promise<void> }) {
  const docs = row.load.documents as Doc[];
  const stops = (row.load as unknown as { stops?: Array<{ id: string; facilityName?: string; city?: string; state?: string }> }).stops ?? [];
  const stopName = (id: string | null | undefined) => {
    const s = id ? stops.find((x) => x.id === id) : null;
    return s ? s.facilityName?.trim() || `${s.city}, ${s.state}` : null;
  };
  const types = row.verdict.tonu ? TONU_TYPES : TYPES;
  const replaced = docs.filter((d) => d.supersededBy && types.some((t) => t.type === d.type));

  return (
    <section className="flex flex-col gap-2" aria-label="Documents to review">
      <div className="flex items-center justify-between">
        <p className="text-sm font-semibold text-ink">Documents</p>
        <Link to="/loads/$loadNumber" params={{ loadNumber: row.load.loadNumber }} search={{ tab: 'documents' }} className="inline-flex items-center gap-1 text-xs text-primary-text underline">
          <Upload className="size-3" /> Upload or replace on the load
        </Link>
      </div>
      {!canReview ? (
        <Alert tone="info" title="You can view these documents but not review them" description="Marking a document reviewed or rejecting it needs the Accounting edit permission. Ask an administrator if you should have it." />
      ) : null}
      <ul className="flex flex-col divide-y divide-line rounded-lg border border-line">
        {types.map((t) => {
          const current = docs.filter((d) => (d.type === t.type || (t.also ?? []).includes(d.type)) && d.status !== 'missing' && (d.fileName ?? '').trim() !== '' && !d.supersededBy);
          if (current.length === 0) {
            return (
              <li key={t.type} className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm" data-testid={`doc-row-${t.type}`}>
                <span className="flex items-center gap-2"><FileText className="size-4 text-muted" /><span><span className="block font-semibold text-ink">{t.label}</span><span className="block text-xs text-muted">{t.hint ?? 'Not uploaded'}</span></span></span>
                <Badge tone="neutral" size="sm">Missing</Badge>
              </li>
            );
          }
          return current.map((d, i) => (
            <DocumentRow
              key={d.id}
              row={row}
              doc={d}
              label={`${t.label}${current.length > 1 ? ` · ${stopName(d.stopId) ?? `${i + 1} of ${current.length}`}` : ''}`}
              short={t.short}
              canReview={canReview}
              onChanged={onChanged}
            />
          ));
        })}
      </ul>
      {replaced.length > 0 ? (
        <p className="text-2xs text-muted">
          {replaced.length} earlier file{replaced.length === 1 ? ' was' : 's were'} replaced and no longer count{replaced.length === 1 ? 's' : ''}: {replaced.map((d) => `${d.fileName} (${d.review === 'rejected' ? 'rejected' : d.review ?? 'received'})`).join(', ')}.
        </p>
      ) : null}
    </section>
  );
}

function DocumentRow({ row, doc, label, short, canReview, onChanged }: { row: BillingQueueRow; doc: Doc; label: string; short: string; canReview: boolean; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const state = stateOf(doc);
  const fileId = fileIdOf(doc);
  const updatedAt = (row.load as unknown as { updatedAt?: string }).updatedAt ?? '';

  const review = useMutation({
    mutationFn: (to: 'reviewed' | 'rejected') => reviewBillingDocument(row.load.id, doc.id, { review: to, reason: to === 'rejected' ? reason.trim() : null, expectedUpdatedAt: updatedAt }),
    onSuccess: async (_r, to) => {
      setRejecting(false);
      setReason('');
      await onChanged();
      toast({ tone: 'success', title: to === 'reviewed' ? `${short} marked reviewed` : fromApp ? `Correction requested on the ${short}` : `${short} rejected`, description: to === 'reviewed' ? doc.fileName : fromApp ? 'The driver is told why in the app and sends a new file.' : 'The reason is kept on the load. Upload a replacement to continue.' });
    },
    onError: async (e: unknown) => {
      await onChanged();
      toast({ tone: 'danger', title: 'Not recorded', description: e instanceof Error ? e.message : undefined });
    },
  });

  const reviewable = doc.review !== 'reviewed' && doc.review !== 'verified' && doc.review !== 'rejected';
  const fromApp = doc.source === 'driver_app';

  return (
    <li className="flex flex-col gap-2 px-3 py-2.5" data-testid={`doc-row-${doc.type}`} data-doc-id={doc.id} data-review={doc.review ?? 'received'}>
      <div className="flex items-start justify-between gap-3">
        <button type="button" onClick={() => setOpen((o) => !o)} className="flex min-w-0 items-start gap-2 text-left" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Preview'} ${label}`}>
          {open ? <ChevronDown className="mt-0.5 size-4 shrink-0 text-muted" /> : <ChevronRight className="mt-0.5 size-4 shrink-0 text-muted" />}
          <span className="min-w-0">
            <span className="block text-sm font-semibold text-ink">{label}</span>
            <span className="block truncate text-xs text-secondary">{doc.fileName}</span>
          </span>
        </button>
        <span className="flex shrink-0 flex-col items-end gap-1">
          <Badge tone={state.tone} size="sm">{state.word}</Badge>
          {state.detail ? <span className="max-w-64 text-right text-2xs text-muted">{state.detail}</span> : null}
        </span>
      </div>

      {open ? (fileId ? <ReceiptPreview key={fileId} fileId={fileId} fileName={doc.fileName ?? `${short}.pdf`} /> : <p className="text-xs text-muted">No file bytes on record for this document.</p>) : null}

      {canReview && reviewable && !rejecting ? (
        <div className="flex flex-wrap gap-2">
          {fromApp ? (
            <Button variant="primary" size="sm" icon={<Check />} disabled={review.isPending} loading={review.isPending} onClick={() => review.mutate('reviewed')}>
              Mark reviewed
            </Button>
          ) : null}
          <Button variant="secondary" size="sm" icon={<X />} disabled={review.isPending} onClick={() => setRejecting(true)}>
            {fromApp ? 'Request correction' : 'Reject'}
          </Button>
          {!open ? <Button variant="outline" size="sm" onClick={() => setOpen(true)}>Preview</Button> : null}
        </div>
      ) : null}

      {canReview && rejecting ? (
        <div className="flex flex-col gap-2 rounded-lg bg-surface-muted p-2">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label={`Why ${short} is rejected`} placeholder="What is wrong with this file (unsigned, wrong load, unreadable…)" />
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={reason.trim().length < 3 || review.isPending} loading={review.isPending} onClick={() => review.mutate('rejected')}>{fromApp ? 'Send to the driver' : 'Confirm reject'}</Button>
            <Button variant="secondary" size="sm" onClick={() => { setRejecting(false); setReason(''); }}>Cancel</Button>
          </div>
          {reason.trim().length < 3 ? <p className="text-2xs text-muted">A rejection needs a reason; it is kept with the file.</p> : null}
        </div>
      ) : null}

      {doc.review === 'rejected' ? <p className="text-xs text-danger-text">Upload a replacement on the load; the replacement is reviewed on its own.</p> : null}
    </li>
  );
}
