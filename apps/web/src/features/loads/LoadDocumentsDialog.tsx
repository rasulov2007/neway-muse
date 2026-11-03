import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  Check,
  CheckCircle2,
  CircleAlert,
  CircleDashed,
  Eye,
  FileText,
  Info,
  RefreshCw,
  TriangleAlert,
} from 'lucide-react';
import { HOME_ZONE, formatInstant, reviewLabel, type UploadSuggestion } from '@neway/shared';
import {
  confirmUploadSuggestion,
  loadWriteMessage,
  reviewLoadDocument,
  type DocumentType as LoadDocumentType,
  type Load,
} from '@/demo';
import { hasFile } from '@/lib/files';
import { DocumentViewer } from '@/features/documents';
import { useAttachFiles } from './AttachFilesDialog';
import { DocumentThumbnail } from './DocumentThumbnail';
import { Badge, Button, ConfirmDialog, IconButton, Modal, cn, useToast } from '@/design-system';
import { useOperations } from '@/features/operations/useOperations';
import { DOCUMENT_TYPE_LABEL, formatBytes } from './loadUtils';

/**
 * The paperwork on a load.
 *
 * Three documents matter to where a load is: the rate confirmation, the bill of lading and the
 * proof of delivery. Filing one here files it and nothing else (dispatch P0.5). A BOL suggests
 * the truck was loaded and a POD suggests the freight was delivered - the dialog asks, with the
 * stop's own time, and the person answers; the answer is what moves the load, through the
 * server, on the timeline under their name. The document itself arrives as *received*; a person
 * marks it reviewed, and a person verifies it, each with their name and time.
 *
 * As the owner asked (2026-09-22) the three cards are gone: the Attach files area sits at the
 * top - drop any paperwork, say what each file is, upload together - and what is on the load
 * is listed under it, the three that matter first (a missing one is said, not hidden), then
 * the rest: detention, TONU, layover, invoices, lumper receipts.
 */

const SLOTS = [
  { type: 'rate_confirmation' as const, label: 'RC', full: 'Rate confirmation' },
  { type: 'bol' as const, label: 'BOL', full: 'Bill of lading' },
  { type: 'pod' as const, label: 'POD', full: 'Proof of delivery' },
];

type SlotType = (typeof SLOTS)[number]['type'];
type LoadDocument = Load['documents'][number];

/** "BOL and POD", "RC, BOL and POD" — the missing ones, as a person would list them. */
function listLabels(labels: string[]): string {
  if (labels.length <= 1) return labels.join('');
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

/** RC / BOL / POD for the three that matter; the register's short label for the rest. */
function shortLabel(type: LoadDocumentType): string {
  return SLOTS.find((s) => s.type === type)?.label ?? DOCUMENT_TYPE_LABEL[type] ?? type;
}

export function LoadDocumentsDialog({
  load: snapshot,
  open,
  onOpenChange,
}: {
  load: Load;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  /*
   * Read the load from the live bundle, not from the row that opened this. The row is a snapshot
   * taken when the eye was clicked; holding it meant filing a document refreshed the register
   * underneath while this dialog went on showing the copy from before the upload.
   */
  const operations = useOperations();
  const live = operations.data?.loads.find((row) => row.load.id === snapshot.id)?.load;
  const load = live ?? snapshot;

  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [viewing, setViewing] = useState<LoadDocument | null>(null);
  /** What the document just filed suggests; nothing moves until the person says yes. */
  const [suggestion, setSuggestion] = useState<{
    suggestion: UploadSuggestion;
    label: string;
  } | null>(null);

  const invalidate = () =>
    Promise.all([
      queryClient.invalidateQueries({ queryKey: ['operations'] }),
      queryClient.invalidateQueries({ queryKey: ['loads'] }),
      queryClient.invalidateQueries({ queryKey: ['load'] }),
    ]);

  const attach = useAttachFiles({
    load,
    onSuggestion: (s, type) => setSuggestion({ suggestion: s, label: shortLabel(type) }),
  });

  /** The person's yes to what the paperwork suggested: the one thing here that moves the load. */
  const confirm = useMutation({
    mutationFn: (s: UploadSuggestion) =>
      confirmUploadSuggestion(load.id, { kind: s.kind, stopId: s.stopId, at: s.at }),
    onSuccess: async (updated, s) => {
      setSuggestion(null);
      await invalidate();
      toast({
        tone: 'success',
        title:
          s.kind === 'mark_loaded'
            ? `${updated.loadNumber} marked loaded`
            : `${updated.loadNumber} delivered`,
        description: 'Recorded on the timeline under your name.',
      });
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not recorded',
        description: loadWriteMessage(error, 'Try again.'),
      }),
  });

  const review = useMutation({
    mutationFn: ({ documentId, to }: { documentId: string; to: 'reviewed' | 'verified' }) =>
      reviewLoadDocument(load.id, documentId, to),
    onSuccess: async (_updated, { to }) => {
      await invalidate();
      toast({
        tone: 'success',
        title: to === 'verified' ? 'Verified under your name' : 'Marked reviewed',
      });
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not recorded',
        description: loadWriteMessage(error, 'Try again.'),
      }),
  });

  // Opened in the shared viewer, not a new tab: the bytes sit behind the session, so a tab
  // pointed at the API answers 401 and a `data:` URL is refused outright by Chrome.
  const view = (doc: LoadDocument) => {
    if (!hasFile(doc)) {
      toast({ tone: 'info', title: 'No file on record for this document' });
      return;
    }
    setViewing(doc);
  };

  const onFile = load.documents.filter((d) => d.status !== 'missing');
  const filed = (type: SlotType) => onFile.find((d) => d.type === type);
  const missing = SLOTS.filter((slot) => !filed(slot.type));
  const uploaded = SLOTS.length - missing.length;
  const readyToBill = load.status === 'delivered' && Boolean(filed('pod')) && !load.invoiceId;
  // The three that matter first, in their order; then everything else.
  const others = onFile.filter((d) => !SLOTS.some((s) => s.type === d.type));

  const pickup = load.stops[0];
  const delivery = load.stops[load.stops.length - 1];

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (!next && attach.isPending) return;
        onOpenChange(next);
      }}
      size="lg"
      title={
        <span className="flex flex-wrap items-center gap-3">
          <span
            aria-hidden
            className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text [&_svg]:size-5"
          >
            <FileText />
          </span>
          <span>
            Paperwork <span className="font-bold">{load.loadNumber}</span>
          </span>
          <Badge tone="neutral" size="md" className="tabular">
            {uploaded} of {SLOTS.length} uploaded
          </Badge>
        </span>
      }
      description={
        pickup && delivery
          ? `${pickup.city}, ${pickup.state} → ${delivery.city}, ${delivery.state}`
          : undefined
      }
      footer={
        <>
          <p className="mr-auto flex items-center gap-1.5 text-xs text-muted">
            <Info aria-hidden className="size-3.5 shrink-0" />
            Filing a document never moves the load by itself. A BOL or POD asks; you confirm.
          </p>
          <Button
            variant="secondary"
            onClick={() => onOpenChange(false)}
            disabled={attach.isPending}
          >
            Close
          </Button>
          <Button
            loading={attach.isPending}
            disabled={attach.pending === 0}
            onClick={attach.upload}
          >
            Upload {attach.pending} file{attach.pending === 1 ? '' : 's'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {missing.length > 0 ? (
          <p
            role="status"
            className="flex items-center gap-2 rounded-md border border-warning-border bg-warning-soft px-3 py-2 text-sm text-warning-text"
          >
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
            {missing.length === 1
              ? '1 document missing'
              : `${missing.length} documents missing`}: {listLabels(missing.map((s) => s.label))}
          </p>
        ) : null}

        <section aria-label="Attach files" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">Attach files</h3>
          {attach.body}
        </section>

        <section aria-label="On this load" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-ink">On this load</h3>
          <ul className="divide-y divide-nw-border overflow-hidden rounded-lg border border-nw-border">
            {SLOTS.map((slot) => {
              const doc = filed(slot.type);
              return doc ? (
                <DocumentRow
                  key={slot.type}
                  doc={doc}
                  label={slot.label}
                  title={slot.full}
                  loadNumber={load.loadNumber}
                  busy={review.isPending}
                  onView={() => view(doc)}
                  onReview={(to) => review.mutate({ documentId: doc.id, to })}
                  onReplace={() => attach.browse(slot.type)}
                />
              ) : (
                <li
                  key={slot.type}
                  className="flex flex-wrap items-center gap-3 bg-nw-panel px-4 py-3"
                  aria-label={slot.full}
                >
                  <span className="flex size-10 shrink-0 items-center justify-center rounded-md bg-nw-subtle text-nw-text-3 [&_svg]:size-5">
                    <FileText aria-hidden />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium text-ink">
                      {slot.full} ({slot.label})
                    </span>
                    <span className="block text-xs text-muted">Not on the load yet.</span>
                  </span>
                  <Badge tone="warning" size="sm" icon={<CircleAlert aria-hidden />}>
                    <span aria-hidden>Missing</span>
                    <span className="sr-only">{`${slot.label} missing`}</span>
                  </Badge>
                  <Button
                    size="sm"
                    variant="outline"
                    aria-label={`Upload ${slot.label}`}
                    onClick={() => attach.browse(slot.type)}
                  >
                    Upload {slot.label}
                  </Button>
                </li>
              );
            })}
            {others.map((doc) => (
              <DocumentRow
                key={doc.id}
                doc={doc}
                label={shortLabel(doc.type)}
                title={doc.title}
                loadNumber={load.loadNumber}
                busy={review.isPending}
                onView={() => view(doc)}
                onReview={(to) => review.mutate({ documentId: doc.id, to })}
                onReplace={() => attach.browse(doc.type)}
              />
            ))}
          </ul>
        </section>

        {readyToBill ? (
          <p className="flex items-center gap-2 rounded-md border border-success-border bg-success-soft px-3 py-2 text-sm text-success-text">
            <Check aria-hidden className="size-4 shrink-0" />
            Ready to bill — the POD is on file and this load has no invoice yet. It is waiting in
            Accounting › Receivables.
          </p>
        ) : null}
      </div>

      <ConfirmDialog
        open={suggestion !== null}
        onOpenChange={(open) => {
          if (!open && !confirm.isPending) setSuggestion(null);
        }}
        tone="default"
        title={suggestion?.suggestion.prompt ?? ''}
        description={
          suggestion
            ? `From the ${suggestion.label} you just filed. ${
                suggestion.suggestion.timeSource === 'arrival'
                  ? 'The time is the arrival recorded at the stop.'
                  : 'No arrival is recorded at the stop, so the time is now.'
              } Only that stop is completed; nothing else on the load changes.`
            : ''
        }
        confirmLabel={
          suggestion?.suggestion.kind === 'mark_loaded' ? 'Yes, mark loaded' : 'Yes, delivered'
        }
        cancelLabel="Not now"
        onConfirm={() => (suggestion ? confirm.mutateAsync(suggestion.suggestion) : undefined)}
      />

      {viewing ? (
        <DocumentViewer
          source={{ kind: 'file', file: viewing }}
          title={viewing.title}
          subtitle={`${viewing.fileName}${viewing.uploadedBy ? ` · ${viewing.uploadedBy}` : ''}${
            viewing.uploadedAt ? ` · ${formatInstant(viewing.uploadedAt, HOME_ZONE).text}` : ''
          }`}
          contentType={viewing.mimeType}
          fileName={viewing.fileName}
          onClose={() => setViewing(null)}
          onReplace={() => {
            const type = viewing.type;
            setViewing(null);
            attach.browse(type);
          }}
        />
      ) : null}
    </Modal>
  );
}

/** One filed document: thumbnail, name, where it stands with a person, and what can be done. */
function DocumentRow({
  doc,
  label,
  title,
  loadNumber,
  busy,
  onView,
  onReview,
  onReplace,
}: {
  doc: LoadDocument;
  label: string;
  title: string;
  loadNumber: string;
  busy: boolean;
  onView: () => void;
  onReview: (to: 'reviewed' | 'verified') => void;
  onReplace: () => void;
}) {
  const isImage = (doc.mimeType ?? '').startsWith('image/');
  const state = doc.review ?? (doc.status === 'verified' ? 'verified' : 'received');
  return (
    <li className="flex flex-wrap items-center gap-3 bg-nw-panel px-4 py-3" aria-label={title}>
      <button
        type="button"
        onClick={onView}
        title={`Open ${doc.fileName}`}
        className={cn(
          'flex size-10 shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-md text-nw-accent-ink [&_svg]:size-5',
          // A real image is a document preview: it stays on paper in both modes.
          isImage && hasFile(doc) ? 'nw-paper' : 'bg-nw-subtle',
        )}
      >
        {isImage && hasFile(doc) ? (
          <DocumentThumbnail
            doc={doc}
            alt={`${title} on ${loadNumber}`}
            className="size-full object-cover"
          />
        ) : (
          <FileText aria-hidden />
        )}
      </button>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-ink">
          {title} <span className="font-normal text-muted">({label})</span>
        </span>
        <span className="block truncate text-xs text-muted">
          <span>{doc.fileName}</span>
          {doc.sizeBytes > 0 ? ` · ${formatBytes(doc.sizeBytes)}` : ''}
          {doc.uploadedAt ? ` · ${formatInstant(doc.uploadedAt, HOME_ZONE).text}` : ''}
          {(doc as { source?: string }).source === 'driver_app' ? ' · Driver app' : ''}
        </span>
        <span className="block truncate text-2xs text-secondary">{reviewLabel(doc)}</span>
      </span>
      <ReviewBadge doc={doc} label={label} />
      <span className="flex items-center gap-1">
        <Button size="sm" variant="secondary" onClick={onView}>
          View
        </Button>
        {/* Icons with a tooltip, as asked (2026-09-22); the label stays for screen readers. */}
        {state === 'received' ? (
          <IconButton
            size="sm"
            variant="ghost"
            label={`Mark ${label} reviewed`}
            disabled={busy}
            onClick={() => onReview('reviewed')}
          >
            <Eye />
          </IconButton>
        ) : null}
        {state !== 'verified' ? (
          <IconButton
            size="sm"
            variant="ghost"
            label={`Verify ${label}`}
            disabled={busy}
            onClick={() => onReview('verified')}
          >
            <CheckCircle2 />
          </IconButton>
        ) : null}
        <IconButton size="sm" variant="ghost" label={`Replace ${label}`} onClick={onReplace}>
          <RefreshCw />
        </IconButton>
      </span>
    </li>
  );
}

/** Where the document stands with a person: symbol, word and colour, never colour alone. */
function ReviewBadge({ doc, label }: { doc: LoadDocument; label: string }) {
  const state = doc.review ?? (doc.status === 'verified' ? 'verified' : 'received');
  if (state === 'verified') {
    return (
      <Badge tone="success" size="sm" icon={<Check aria-hidden />}>
        <span aria-hidden>Verified</span>
        <span className="sr-only">{`${label} verified`}</span>
      </Badge>
    );
  }
  if (state === 'reviewed') {
    return (
      <Badge tone="info" size="sm" icon={<Eye aria-hidden />}>
        <span aria-hidden>Reviewed</span>
        <span className="sr-only">{`${label} reviewed`}</span>
      </Badge>
    );
  }
  return (
    <Badge tone="neutral" size="sm" icon={<CircleDashed aria-hidden />}>
      <span aria-hidden>Received</span>
      <span className="sr-only">{`${label} received`}</span>
    </Badge>
  );
}
